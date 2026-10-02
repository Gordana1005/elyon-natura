/**
 * /call-scripts — the page's pure model (owner 02.10.2026; contract docs/CALL-SCRIPTS.md).
 *
 * No React, no network: the library filters (URL-backed), the product picker's search and twins,
 * the duplicate preview, the coverage grid's cell states / filters / sort, the editor's state ⇄
 * patch, and the "where it wins" summary. The matching itself is the server's own pure module
 * (callScriptMatch.ts, re-exported by callScriptsTypes) — this file only feeds it.
 */
import { normalizeForSearch } from '@/lib/transliterate';
import { BRAND_LINES, type BrandLine } from '@/lib/products/brandLines';
import {
  ALL_GROUPS, FIXED_SECTION_KEYS, LEAD_GROUPS, PREDICTION_GROUPS, buildTwins, familyOf, isScriptGroup, matchScripts,
  trimWs, whereItWins,
  type CallScriptHelper, type CoverageCell, type CoverageResponse, type CoverageRow, type DuplicateSplit, type FixedSectionKey,
  type MatchedScript, type ProductIndexRow, type ScriptGroup, type ScriptPatch, type ScriptSample, type ScriptSection,
  type ScriptStatus, type ScriptTranslation, type ScriptVarsLite, type TargetedScript, type WhereItWins, type WinCell,
} from '@/lib/callScriptsTypes';

// ── Tabs ────────────────────────────────────────────────────────────────────

export const SCRIPT_TABS = ['library', 'coverage', 'tester', 'current', 'order', 'promo'] as const;
export type ScriptsTab = typeof SCRIPT_TABS[number];
/** What an agent (read-only) sees: the published library and the promo. */
export const READ_ONLY_TABS: readonly ScriptsTab[] = ['library', 'promo'];

export function visibleTabs(canWrite: boolean): ScriptsTab[] {
  return canWrite ? [...SCRIPT_TABS] : [...READ_ONLY_TABS];
}

/** The tab in the URL, or the library when it is unknown / not allowed. */
export function tabOf(sp: URLSearchParams, allowed: readonly ScriptsTab[]): ScriptsTab {
  const v = sp.get('tab') as ScriptsTab | null;
  return v && allowed.includes(v) ? v : 'library';
}

/** Switching tabs keeps nothing of the editor and the other tabs' filters. */
export function tabParams(tab: ScriptsTab): URLSearchParams {
  const sp = new URLSearchParams();
  if (tab !== 'library') sp.set('tab', tab);
  return sp;
}

/** The editor deep link: an existing script, or a new one already aimed at groups / products. */
export function editorHref(opts: { id?: string; groups?: readonly string[]; products?: readonly string[]; from?: ScriptsTab }): string {
  const sp = new URLSearchParams();
  if (opts.from && opts.from !== 'library') sp.set('tab', opts.from);
  if (opts.id) sp.set('script', opts.id);
  else {
    sp.set('new', '1');
    if (opts.groups?.length) sp.set('group', opts.groups.join(','));
    if (opts.products?.length) sp.set('product', opts.products.join(','));
  }
  return `/call-scripts?${sp.toString()}`;
}

/** ?group=d21,d57 → the known groups only (order of ALL_GROUPS). */
export function parseGroupsParam(v: string | null): ScriptGroup[] {
  const want = new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return ALL_GROUPS.filter((g) => want.has(g));
}

/** ?product=<id>,<id> → uuids (anything else dropped). */
export function parseProductsParam(v: string | null): string[] {
  const out: string[] = [];
  for (const s of (v ?? '').split(',')) {
    const id = s.trim();
    if (/^[0-9a-f-]{36}$/i.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

// ── Groups ──────────────────────────────────────────────────────────────────

export type GroupFamily = 'leads' | 'prediction';
export const GROUP_FAMILIES: { key: GroupFamily; groups: readonly ScriptGroup[] }[] = [
  { key: 'leads', groups: LEAD_GROUPS },
  { key: 'prediction', groups: PREDICTION_GROUPS },
];

/** Clients waiting in a group (any product) — the coverage's "every product" row. */
export function groupWaiting(coverage: CoverageResponse | null | undefined, g: ScriptGroup): number | null {
  const c = coverage?.all_products?.[g];
  return c ? c.waiting : null;
}

/** Toggle one group; the order always follows ALL_GROUPS. */
export function toggleGroup(groups: readonly ScriptGroup[], g: ScriptGroup): ScriptGroup[] {
  const on = new Set(groups);
  if (on.has(g)) on.delete(g); else on.add(g);
  return ALL_GROUPS.filter((x) => on.has(x));
}

/** Every group of a family on (or off, when all already are). */
export function toggleFamily(groups: readonly ScriptGroup[], fam: GroupFamily): ScriptGroup[] {
  const members = GROUP_FAMILIES.find((f) => f.key === fam)!.groups;
  const on = new Set(groups);
  const all = members.every((g) => on.has(g));
  for (const g of members) { if (all) on.delete(g); else on.add(g); }
  return ALL_GROUPS.filter((x) => on.has(x));
}

// ── Products: search, twins, brand lines ────────────────────────────────────

/** id → the other ids with the same normalised name (catalogue duplicates count as one product). */
export const twinsOf = (products: readonly ProductIndexRow[]) => buildTwins(products);

/** The ids with their twins added (order kept, no duplicates). */
export function withTwins(ids: readonly string[], twins: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const id of ids) for (const x of familyOf(id, twins)) if (!out.includes(x)) out.push(x);
  return out;
}

/** Remove a product and its twins. */
export function withoutFamily(ids: readonly string[], id: string, twins: Readonly<Record<string, readonly string[]>>): string[] {
  const fam = new Set(familyOf(id, twins));
  return ids.filter((x) => !fam.has(x));
}

export const PICKER_KINDS = ['all', 'product', 'bundle', 'gift', 'other'] as const;
export type PickerKind = typeof PICKER_KINDS[number];

/**
 * The picker's list: every word of the query in the name (Cyrillic ⇄ Latin, any case), the
 * kind filter, active products first, prefix matches first, then by name.
 */
export function searchProducts(products: readonly ProductIndexRow[], q: string, kind: PickerKind = 'all'): ProductIndexRow[] {
  const words = normalizeForSearch(q.trim()).split(/\s+/).filter(Boolean);
  const hit = products
    .filter((p) => kind === 'all' || (p.kind ?? 'other') === kind || (kind === 'other' && !p.kind))
    .map((p) => ({ p, n: normalizeForSearch(p.name) }))
    .filter((x) => words.every((w) => x.n.includes(w)));
  const first = words[0] ?? '';
  return hit
    .sort((a, b) =>
      Number(b.p.is_active) - Number(a.p.is_active)
      || Number(b.n.startsWith(first)) - Number(a.n.startsWith(first))
      || a.p.name.localeCompare(b.p.name, 'mk'))
    .map((x) => x.p);
}

/** The products grouped by brand line (the four lines, then "not decided"). */
export function byBrandLine<T extends { brand_line: string | null }>(products: readonly T[]): { line: BrandLine | null; products: T[] }[] {
  const out: { line: BrandLine | null; products: T[] }[] = [];
  for (const line of BRAND_LINES) {
    const ps = products.filter((p) => p.brand_line === line);
    if (ps.length) out.push({ line, products: ps });
  }
  const rest = products.filter((p) => !(BRAND_LINES as readonly string[]).includes(p.brand_line ?? ''));
  if (rest.length) out.push({ line: null, products: rest });
  return out;
}

// ── Library ─────────────────────────────────────────────────────────────────

export const LIBRARY_STATUSES = ['all', 'published', 'draft', 'archived', 'legacy'] as const;
export type LibraryStatus = typeof LIBRARY_STATUSES[number];

export interface LibraryFilters {
  status: LibraryStatus;
  /** A group the script is attached to; 'every' = scripts for every group (groups = {}); null = any. */
  group: ScriptGroup | 'every' | null;
  /** A product the script is attached to (its twins count); null = any. */
  product: string | null;
  q: string;
  /** Only scripts with no targeting at all (every group, every product). */
  untargeted: boolean;
  /** Only scripts with warnings (lint severity warn). */
  warnings: boolean;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  status: 'all', group: null, product: null, q: '', untargeted: false, warnings: false,
};

export const isLegacy = (s: Pick<TargetedScript, 'context_type'>) => s.context_type !== 'targeted';
export const hasWarnings = (s: Pick<TargetedScript, 'lint'>) => (s.lint ?? []).some((l) => l.severity === 'warn');
export const isUntargeted = (s: Pick<TargetedScript, 'groups' | 'product_ids'>) =>
  (s.groups ?? []).length === 0 && (s.product_ids ?? []).length === 0;

export function readLibraryParams(sp: URLSearchParams): LibraryFilters {
  const status = sp.get('status');
  const g = sp.get('g');
  return {
    status: (LIBRARY_STATUSES as readonly string[]).includes(status ?? '') ? status as LibraryStatus : 'all',
    group: g === 'every' ? 'every' : isScriptGroup(g) ? g : null,
    product: parseProductsParam(sp.get('p'))[0] ?? null,
    q: sp.get('q') ?? '',
    untargeted: sp.get('bare') === '1',
    warnings: sp.get('warn') === '1',
  };
}

export function writeLibraryParams(prev: URLSearchParams, patch: Partial<LibraryFilters>): URLSearchParams {
  const next = { ...readLibraryParams(prev), ...patch };
  const sp = new URLSearchParams(prev);
  const set = (k: string, v: string | null) => { if (v) sp.set(k, v); else sp.delete(k); };
  set('status', next.status === 'all' ? null : next.status);
  set('g', next.group);
  set('p', next.product);
  set('q', next.q.trim() ? next.q : null);
  set('bare', next.untargeted ? '1' : null);
  set('warn', next.warnings ? '1' : null);
  return sp;
}

function statusOk(s: TargetedScript, status: LibraryStatus): boolean {
  if (status === 'legacy') return isLegacy(s);
  if (isLegacy(s)) return false;
  return status === 'all' || s.status === status;
}

/** Title, description, every section (mk + sq), helpers and the legacy text — transliterated. */
export function scriptHaystack(s: TargetedScript, productName?: (id: string) => string | undefined): string {
  const parts: string[] = [s.title, s.description ?? '', s.script_text ?? ''];
  for (const sec of s.sections ?? []) parts.push(sec.title ?? '', sec.text);
  for (const h of s.helpers ?? []) parts.push(h.title, h.content);
  const sq = s.translations?.sq;
  if (sq) {
    parts.push(sq.title ?? '', sq.description ?? '', sq.script_text ?? '');
    for (const sec of sq.sections ?? []) parts.push(sec.title ?? '', sec.text);
  }
  if (productName) for (const id of s.product_ids ?? []) parts.push(productName(id) ?? '');
  return normalizeForSearch(parts.join(' \n '));
}

export interface LibraryContext {
  twins: Readonly<Record<string, readonly string[]>>;
  productName?: (id: string) => string | undefined;
}

function otherFiltersOk(s: TargetedScript, f: LibraryFilters, ctx: LibraryContext): boolean {
  if (f.group === 'every' && (s.groups ?? []).length > 0) return false;
  if (f.group && f.group !== 'every' && !(s.groups ?? []).includes(f.group)) return false;
  if (f.product) {
    const fam = familyOf(f.product, ctx.twins);
    if (!(s.product_ids ?? []).some((id) => fam.includes(id))) return false;
  }
  if (f.untargeted && (isLegacy(s) || !isUntargeted(s))) return false;
  if (f.warnings && !hasWarnings(s)) return false;
  const words = normalizeForSearch(f.q.trim()).split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = scriptHaystack(s, ctx.productName);
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

const STATUS_RANK: Record<ScriptStatus, number> = { published: 0, draft: 1, archived: 2 };

/** Newest first; within the same moment published before draft before archived; legacy rows last. */
export function sortLibrary(scripts: readonly TargetedScript[]): TargetedScript[] {
  return [...scripts].sort((a, b) =>
    Number(isLegacy(a)) - Number(isLegacy(b))
    || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0)
    || STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || a.title.localeCompare(b.title, 'mk'));
}

export function filterLibrary(scripts: readonly TargetedScript[], f: LibraryFilters, ctx: LibraryContext): TargetedScript[] {
  return sortLibrary(scripts.filter((s) => statusOk(s, f.status) && otherFiltersOk(s, f, ctx)));
}

/** What each status chip would show (the other filters applied). */
export function libraryCounts(scripts: readonly TargetedScript[], f: LibraryFilters, ctx: LibraryContext): Record<LibraryStatus, number> {
  const out = Object.fromEntries(LIBRARY_STATUSES.map((k) => [k, 0])) as Record<LibraryStatus, number>;
  for (const s of scripts) {
    if (!otherFiltersOk(s, f, ctx)) continue;
    for (const k of LIBRARY_STATUSES) if (statusOk(s, k)) out[k] += 1;
  }
  return out;
}

export const hasLibraryFilters = (f: LibraryFilters) =>
  f.status !== 'all' || f.group !== null || f.product !== null || f.q.trim() !== '' || f.untargeted || f.warnings;

// ── Duplicate ───────────────────────────────────────────────────────────────

export const MAX_DUPLICATES = 50;
export const DUPLICATE_SPLITS: readonly DuplicateSplit[] = ['none', 'product', 'group', 'cell'];

export interface DuplicateTarget { groups: ScriptGroup[]; product_ids: string[] }

/**
 * The drafts a duplicate would create (the server's split, counted before it runs):
 *   none → one copy with every chosen group and product · product → one per product ·
 *   group → one per group · cell → one per group × product. An empty side counts as one.
 */
export function duplicatePlan(groups: readonly ScriptGroup[], productIds: readonly string[], split: DuplicateSplit): {
  targets: DuplicateTarget[]; count: number; tooMany: boolean;
} {
  const gs: ScriptGroup[][] = split === 'group' || split === 'cell' ? (groups.length ? groups.map((g) => [g]) : [[]]) : [[...groups]];
  const ps: string[][] = split === 'product' || split === 'cell' ? (productIds.length ? productIds.map((p) => [p]) : [[]]) : [[...productIds]];
  const count = gs.length * ps.length;
  const targets: DuplicateTarget[] = [];
  if (count <= MAX_DUPLICATES) for (const g of gs) for (const p of ps) targets.push({ groups: g, product_ids: p });
  return { targets, count, tooMany: count > MAX_DUPLICATES };
}

// ── Coverage grid ───────────────────────────────────────────────────────────

/** ✓ product + group · ◐ group only · ○ product only · · general · — nothing. */
export type CellState = 'product_group' | 'group' | 'product' | 'general' | 'none';
export const CELL_GLYPH: Record<CellState, string> = {
  product_group: '✓', group: '◐', product: '○', general: '·', none: '—',
};
export const CELL_STATES: readonly CellState[] = ['product_group', 'group', 'product', 'general', 'none'];

const TIER_STATE: Record<number, CellState> = { 1: 'product_group', 2: 'group', 3: 'product', 4: 'general' };

export function cellState(cell: Pick<CoverageCell, 'winner'> | null | undefined): CellState {
  const tier = cell?.winner?.tier;
  return tier ? TIER_STATE[tier] ?? 'none' : 'none';
}

/** Red: nobody is covered and clients are waiting. */
export const cellAlert = (cell: CoverageCell | null | undefined) => !!cell && !cell.winner && cell.waiting > 0;

/** Dashed: a draft would win here once published (it differs from today's winner). */
export const cellDraftWins = (cell: CoverageCell | null | undefined) =>
  !!cell?.draft_winner && cell.draft_winner.script_id !== cell.winner?.script_id;

export const GRID_SORTS = ['waiting', 'name'] as const;
export type GridSort = typeof GRID_SORTS[number];

export interface GridOptions {
  q: string;
  /** Brand lines to show; empty = every line. 'none' = products with no line yet. */
  lines: readonly (BrandLine | 'none')[];
  sort: GridSort;
  /** Show products nobody is waiting for. */
  showEmpty: boolean;
}

export const DEFAULT_GRID_OPTIONS: GridOptions = { q: '', lines: [], sort: 'waiting', showEmpty: false };

/** The grid's rows: search (Cyrillic ⇄ Latin), brand lines, empty rows hidden, sorted. */
export function gridRows(rows: readonly CoverageRow[], o: GridOptions): CoverageRow[] {
  const words = normalizeForSearch(o.q.trim()).split(/\s+/).filter(Boolean);
  const lines = new Set(o.lines);
  return rows
    .filter((r) => o.showEmpty || r.waiting > 0)
    .filter((r) => lines.size === 0 || lines.has((r.brand_line && (BRAND_LINES as readonly string[]).includes(r.brand_line) ? r.brand_line : 'none') as BrandLine | 'none'))
    .filter((r) => { const n = normalizeForSearch(r.name); return words.every((w) => n.includes(w)); })
    .sort((a, b) => (o.sort === 'waiting' ? b.waiting - a.waiting : 0) || a.name.localeCompare(b.name, 'mk'));
}

/** How many rows each brand-line chip would show (search + empty filter applied). */
export function gridLineCounts(rows: readonly CoverageRow[], o: Pick<GridOptions, 'q' | 'showEmpty'>): Record<BrandLine | 'none', number> {
  const out = { natura_therapy: 0, bio_natural: 0, ad_astra: 0, dr_becker: 0, none: 0 } as Record<BrandLine | 'none', number>;
  for (const r of gridRows(rows, { ...o, lines: [], sort: 'name' })) {
    const k = r.brand_line && (BRAND_LINES as readonly string[]).includes(r.brand_line) ? r.brand_line as BrandLine : 'none';
    out[k] += 1;
  }
  return out;
}

/** The library drafts that aim at one cell (group × the row's products; "every" sides count). */
export function draftsForCell(scripts: readonly TargetedScript[], g: ScriptGroup, productIds: readonly string[] | null): TargetedScript[] {
  return scripts.filter((s) => {
    if (isLegacy(s) || s.status !== 'draft') return false;
    const gOk = (s.groups ?? []).length === 0 || s.groups.includes(g);
    const pOk = (s.product_ids ?? []).length === 0
      || (productIds != null && productIds.length > 0 && s.product_ids.some((id) => productIds.includes(id)));
    return gOk && pOk;
  });
}

// ── Editor ──────────────────────────────────────────────────────────────────

export interface SqDraft {
  title: string;
  description: string;
  /** By section id: the Albanian text (and title, for a custom section). */
  sections: Record<string, { text: string; title?: string }>;
  helpers: CallScriptHelper[];
}

export interface EditorState {
  title: string;
  description: string;
  groups: ScriptGroup[];
  product_ids: string[];
  priority: number;
  /** The Macedonian sections in order — the four fixed ones are always present in the editor. */
  sections: ScriptSection[];
  helpers: CallScriptHelper[];
  sq: SqDraft;
}

export const PRIORITY_MIN = -100;
export const PRIORITY_MAX = 100;
export const clampPriority = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, n)) : 0;
};

/** The sections with every fixed section present (missing ones added, empty, in their usual place). */
export function ensureFixedSections(sections: readonly ScriptSection[]): ScriptSection[] {
  const out = sections.map((s) => ({ ...s }));
  FIXED_SECTION_KEYS.forEach((key, i) => {
    if (out.some((s) => s.key === key)) return;
    // insert after the previous fixed key that exists, else at the start of the fixed run
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const idx = out.findIndex((s) => s.key === FIXED_SECTION_KEYS[k]);
      if (idx >= 0) { at = idx + 1; break; }
    }
    out.splice(at, 0, { id: key, key, text: '' });
  });
  return out;
}

/** custom-<8 [a-z0-9]> (the contract's id rule). */
export function newCustomSectionId(rand: () => number = Math.random): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[Math.floor(rand() * abc.length) % abc.length];
  return `custom-${s}`;
}

export function moveItem<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

const cleanHelpers = (hs: readonly CallScriptHelper[]) =>
  hs.map((h) => ({ title: trimWs(h.title), content: trimWs(h.content), category: trimWs(h.category ?? '') || null }))
    .filter((h) => h.title || h.content);

export function editorStateFrom(
  script: Pick<TargetedScript, 'title' | 'description' | 'groups' | 'product_ids' | 'priority' | 'sections' | 'helpers' | 'translations'> | null,
  prefill: { groups?: readonly ScriptGroup[]; product_ids?: readonly string[] } = {},
): EditorState {
  const sq = script?.translations?.sq;
  const sqSections: SqDraft['sections'] = {};
  for (const s of sq?.sections ?? []) sqSections[s.id] = { text: s.text ?? '', ...(s.title ? { title: s.title } : {}) };
  return {
    title: script?.title ?? '',
    description: script?.description ?? '',
    groups: script ? ALL_GROUPS.filter((g) => (script.groups ?? []).includes(g)) : ALL_GROUPS.filter((g) => (prefill.groups ?? []).includes(g)),
    product_ids: script ? [...(script.product_ids ?? [])] : [...(prefill.product_ids ?? [])],
    priority: clampPriority(script?.priority ?? 0),
    sections: ensureFixedSections(script?.sections ?? []),
    helpers: (script?.helpers ?? []).map((h) => ({ title: h.title, content: h.content, category: h.category ?? null })),
    sq: { title: sq?.title ?? '', description: sq?.description ?? '', sections: sqSections, helpers: (sq?.helpers ?? []).map((h) => ({ ...h })) },
  };
}

/**
 * What the writer receives: every field (the targeted branch accepts them all). Fixed sections
 * with no text in either language are dropped; a custom section always stays (its title is
 * required). The Albanian side keeps only what was written.
 */
export function editorStateToPatch(s: EditorState): ScriptPatch {
  const sections: ScriptSection[] = [];
  for (const sec of s.sections) {
    const sqText = trimWs(s.sq.sections[sec.id]?.text);
    if (sec.key !== 'custom' && !trimWs(sec.text) && !sqText) continue;
    sections.push(sec.key === 'custom'
      ? { id: sec.id, key: 'custom', title: trimWs(sec.title ?? ''), text: sec.text }
      : { id: sec.id, key: sec.key, text: sec.text });
  }
  const sqSections: ScriptSection[] = [];
  for (const sec of sections) {
    const tr = s.sq.sections[sec.id];
    if (!tr || !trimWs(tr.text)) continue;
    sqSections.push(sec.key === 'custom'
      ? { id: sec.id, key: 'custom', title: trimWs(tr.title ?? '') || trimWs(sec.title ?? ''), text: tr.text }
      : { id: sec.id, key: sec.key, text: tr.text });
  }
  const sq: ScriptTranslation = {};
  if (trimWs(s.sq.title)) sq.title = trimWs(s.sq.title);
  if (trimWs(s.sq.description)) sq.description = trimWs(s.sq.description);
  if (sqSections.length) sq.sections = sqSections;
  const sqHelpers = cleanHelpers(s.sq.helpers);
  if (sqHelpers.length) sq.helpers = sqHelpers;
  return {
    title: trimWs(s.title),
    description: trimWs(s.description) || null,
    groups: ALL_GROUPS.filter((g) => s.groups.includes(g)),
    product_ids: [...s.product_ids],
    priority: clampPriority(s.priority),
    sections,
    helpers: cleanHelpers(s.helpers),
    translations: Object.keys(sq).length ? { sq } : {},
  };
}

export const editorDirty = (a: EditorState, b: EditorState) =>
  JSON.stringify(editorStateToPatch(a)) !== JSON.stringify(editorStateToPatch(b));

/** Publishing a targeted script needs a title and one section with text (the writer refuses otherwise). */
export function publishBlockers(s: EditorState): ('title' | 'text')[] {
  const p = editorStateToPatch(s);
  const out: ('title' | 'text')[] = [];
  if (!p.title) out.push('title');
  if (!(p.sections ?? []).some((x) => trimWs(x.text))) out.push('text');
  return out;
}

/** The editor's state as a script (for the preview, lint and "where it wins"). */
export function draftScript(s: EditorState, base: Partial<TargetedScript> & { id?: string } = {}): TargetedScript {
  const p = editorStateToPatch(s);
  const now = new Date().toISOString();
  return {
    id: base.id ?? '__draft__',
    context_type: 'targeted',
    status: base.status ?? 'draft',
    title: p.title ?? '',
    description: p.description ?? null,
    sections: p.sections ?? [],
    helpers: p.helpers ?? [],
    translations: p.translations ?? {},
    groups: p.groups ?? [],
    product_ids: p.product_ids ?? [],
    priority: p.priority ?? 0,
    version: base.version ?? 0,
    created_at: base.created_at ?? now,
    created_by: base.created_by ?? null,
    updated_at: base.updated_at ?? now,
    updated_by: base.updated_by ?? null,
    published_at: base.published_at ?? null,
    published_by: base.published_by ?? null,
    copied_from: base.copied_from ?? null,
  };
}

// ── Where it wins ───────────────────────────────────────────────────────────

export interface WinsSummary extends WhereItWins {
  /** Cells it loses, the ones with the most waiting clients first (≤ limit). */
  lost: (WinCell & { waiting: number })[];
}

/**
 * Where the edited script would win, against the library (published, + drafts when asked). A
 * script with no products is tried on "no product" + the products clients are waiting for.
 */
export function editorWins(
  target: TargetedScript,
  library: readonly TargetedScript[],
  opts: { coverage?: CoverageResponse | null; products?: readonly ProductIndexRow[]; includeDrafts?: boolean; limit?: number } = {},
): WinsSummary {
  const twins = buildTwins(opts.products ?? []);
  const waitingProducts = (opts.coverage?.rows ?? []).filter((r) => r.waiting > 0).flatMap((r) => r.product_ids.slice(0, 1));
  const others = library.filter((s) => s.context_type === 'targeted' && s.id !== target.id);
  const res = whereItWins(target, others, { productIds: waitingProducts, twins, includeDrafts: opts.includeDrafts });
  const waitingOf = (c: WinCell): number => {
    if (!opts.coverage) return 0;
    if (!c.product_id) return opts.coverage.all_products?.[c.group]?.waiting ?? 0;
    const row = opts.coverage.rows.find((r) => r.product_ids.includes(c.product_id!));
    return row?.cells?.[c.group]?.waiting ?? 0;
  };
  const lost = res.cells.filter((c) => !c.wins).map((c) => ({ ...c, waiting: waitingOf(c) }))
    .sort((a, b) => b.waiting - a.waiting)
    .slice(0, opts.limit ?? 8);
  return { ...res, lost };
}

// ── Tester ──────────────────────────────────────────────────────────────────

/** The local twin of GET /calls/scripts for a group + product (no phone): the same matcher. */
export function localMatch(
  library: readonly TargetedScript[],
  group: ScriptGroup | null,
  productId: string | null,
  products: readonly ProductIndexRow[],
  includeDrafts: boolean,
): { best: MatchedScript<TargetedScript> | null; alternatives: MatchedScript<TargetedScript>[] } {
  const twins = buildTwins(products);
  const r = matchScripts(library, { group, primary: productId, products: productId ? [productId] : [], twins }, { includeDrafts });
  return { best: r.best, alternatives: r.alternatives };
}

/** A waiting client from GET /call-scripts/samples as the variables the preview fills. */
export function sampleVars(
  sample: ScriptSample | null,
  opts: { agentName?: string | null; priceEur?: number | null; now?: number } = {},
): ScriptVarsLite | null {
  if (!sample) return null;
  const now = opts.now ?? Date.now();
  const at = sample.last_purchase_at ? Date.parse(sample.last_purchase_at) : NaN;
  const days = Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 86_400_000)) : null;
  return {
    customer_name: sample.customer_name,
    first_name: null,
    agent_name: opts.agentName ?? null,
    product: sample.product_name,
    price_eur: opts.priceEur ?? null,
    last_product: sample.kind === 'member' ? sample.product_name : null,
    last_purchase_at: sample.last_purchase_at,
    days_since_purchase: days,
    city: null,
    order_id: null,
  };
}

/** The first section key a lint field points at ("section:pitch" → pitch) — for the editor's jump links. */
export function lintSectionId(field: string): string | null {
  return field.startsWith('section:') ? field.slice('section:'.length) : null;
}

export const isFixedKey = (k: string): k is FixedSectionKey => (FIXED_SECTION_KEYS as readonly string[]).includes(k);
