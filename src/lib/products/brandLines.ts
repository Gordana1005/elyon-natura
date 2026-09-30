import { normalizeForSearch } from '@/lib/transliterate';

/**
 * Product brand lines on /products (plan 30.09.2026, "Фаза 4 — Мапа на
 * производите по линија"; migration 20260943001300).
 *
 * Owner ruling 30.09: when the CRM ships an order via MEX the product line
 * decides the MEX profile — Bio Natural and Dr.Becker ship with BIO NATURAL,
 * Natura Therapy and Ad Astra with NATURA. The line lives on
 * products.brand_line (NULL = not yet decided) and is set only through
 * POST /api/products/brand-line (audited). The server twin of this file is
 * supabase/functions/api/brandLine.ts; the SQL decides the proposal.
 *
 * Pure: the filter, the counts and the "accept all" plan are unit-tested in
 * brandLines.test.ts.
 */

export const BRAND_LINES = ['natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker'] as const;
export type BrandLine = (typeof BRAND_LINES)[number];
export type MexProfile = 'bio_natural' | 'natura';

/** The chip filter: every product, one line, or the undecided ones. */
export const LINE_FILTERS = ['all', ...BRAND_LINES, 'none'] as const;
export type LineFilter = (typeof LINE_FILTERS)[number];

/** Brand names are proper names — the same in every language. */
export const LINE_NAMES: Record<BrandLine, string> = {
  natura_therapy: 'Natura Therapy',
  bio_natural: 'Bio Natural',
  ad_astra: 'Ad Astra',
  dr_becker: 'Dr.Becker',
};

/** The two MEX accounts as MEX names them. */
export const PROFILE_NAMES: Record<MexProfile, string> = { bio_natural: 'BIO NATURAL', natura: 'NATURA' };

/**
 * A line's chip tone — literal classes so Tailwind generates them, with a dark
 * twin. The hue follows the MEX account: the BIO NATURAL lines are blues (Bio
 * Natural sky, Dr.Becker indigo), the NATURA lines green / violet (Natura
 * Therapy emerald, Ad Astra violet). Always shown with its name, never colour alone.
 */
export const LINE_TONES: Record<BrandLine, string> = {
  natura_therapy: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  bio_natural: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  ad_astra: 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300',
  dr_becker: 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300',
};
export const UNDECIDED_TONE = 'border-dashed bg-muted/40 text-muted-foreground border-border';

/** The parcels bar: one fill per MEX account (the hue of its default line). */
export const PROFILE_FILLS: Record<MexProfile, string> = {
  bio_natural: 'bg-sky-600 dark:bg-sky-400',
  natura: 'bg-emerald-600 dark:bg-emerald-400',
};

export const isBrandLine = (v: unknown): v is BrandLine =>
  typeof v === 'string' && (BRAND_LINES as readonly string[]).includes(v);

/** A product's line, or null (missing, NULL or an unknown value = not yet decided). */
export const lineOf = (p: { brand_line?: unknown }): BrandLine | null => (isBrandLine(p.brand_line) ? p.brand_line : null);

/** The MEX account a line ships with (the twin of SQL mex_profile_for_line()). */
export function mexProfileForLine(line: unknown): MexProfile | null {
  if (line === 'bio_natural' || line === 'dr_becker') return 'bio_natural';
  if (line === 'natura_therapy' || line === 'ad_astra') return 'natura';
  return null;
}

export const isLineFilter = (v: unknown): v is LineFilter =>
  typeof v === 'string' && (LINE_FILTERS as readonly string[]).includes(v);

export function matchesLine(p: { brand_line?: unknown }, filter: LineFilter): boolean {
  if (filter === 'all') return true;
  const line = lineOf(p);
  return filter === 'none' ? line === null : line === filter;
}

/** How many products each chip would show (over ALL products, so a chip's number does not move as you type). */
export function lineCounts(rows: readonly { brand_line?: unknown }[]): Record<LineFilter, number> {
  const out = Object.fromEntries(LINE_FILTERS.map((k) => [k, 0])) as Record<LineFilter, number>;
  for (const r of rows) {
    out.all++;
    out[lineOf(r) ?? 'none']++;
  }
  return out;
}

export interface SearchableProduct {
  name?: string | null;
  sku?: string | null;
  category?: string | null;
  brand_line?: unknown;
}

/** Every word of the query must be in the name, SKU or category (Cyrillic ⇄ Latin, any case). */
export function matchesQuery(p: SearchableProduct, query: string): boolean {
  const words = normalizeForSearch(query.trim()).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeForSearch([p.name, p.sku, p.category].filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

export function filterProducts<T extends SearchableProduct>(rows: readonly T[], opts: { line: LineFilter; query: string }): T[] {
  return rows.filter((r) => matchesLine(r, opts.line) && matchesQuery(r, opts.query));
}

// ── the proposal (GET /api/products/brand-line-proposal) ──────────────────────

export type ProposalBucket = 'sure' | 'mixed' | 'none';
export type ProposalConfidence = 'hint' | 'conflict' | 'anchor' | 'high' | 'low' | 'none';
export type ProposalReason =
  | 'hint_name' | 'anchor_conflict' | 'anchor_name' | 'parcels_sure' | 'parcels_mixed' | 'parcels_tie' | 'no_parcels';

export interface ProposalRow {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  brand_line: BrandLine | null;
  brand_line_set_at: string | null;
  brand_line_set_by_name: string | null;
  bio_natural: number;
  natura: number;
  parcels: number;
  majority: MexProfile | null;
  share: number | null;
  bucket: ProposalBucket;
  anchor: string | null;
  hint: 'ad_astra' | 'dr_becker' | null;
  suggested: BrandLine | null;
  suggested_profile: MexProfile | null;
  confidence: ProposalConfidence;
  conflict: boolean;
  reason: ProposalReason;
  auto: boolean;
}

export interface ProposalSummary {
  products: number;
  sure: number;
  mixed: number;
  none: number;
  anchors: number;
  conflicts: number;
  hints: { ad_astra: number; dr_becker: number };
  decided: number;
  auto: number;
  few_parcels_auto: number;
}

export interface BrandLineProposal {
  days: number;
  generated_at: string | null;
  summary: ProposalSummary;
  rows: ProposalRow[];
}

export interface SetBrandLineResult {
  line: BrandLine | null;
  mex_profile: MexProfile | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: { id: string; name: string; from: BrandLine | null; to: BrandLine | null }[];
}

/** Fewer parcels than this and a "sure" share is flagged "few parcels" (the owner checks it). */
export const FEW_PARCELS = 10;
export const isFewParcels = (r: Pick<ProposalRow, 'parcels'>) => r.parcels > 0 && r.parcels < FEW_PARCELS;

/** The proposal view's chips. */
export const PROPOSAL_FILTERS = ['todo', 'auto', 'mixed', 'conflict', 'none', 'decided', 'all'] as const;
export type ProposalFilter = (typeof PROPOSAL_FILTERS)[number];

export function matchesProposalFilter(r: ProposalRow, f: ProposalFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'todo': return r.brand_line === null;
    case 'auto': return r.brand_line === null && r.auto;
    case 'mixed': return r.bucket === 'mixed';
    case 'conflict': return r.conflict;
    case 'none': return r.bucket === 'none';
    case 'decided': return r.brand_line !== null;
  }
}

export function proposalCounts(rows: readonly ProposalRow[]): Record<ProposalFilter, number> {
  const out = Object.fromEntries(PROPOSAL_FILTERS.map((k) => [k, 0])) as Record<ProposalFilter, number>;
  for (const r of rows) for (const f of PROPOSAL_FILTERS) if (matchesProposalFilter(r, f)) out[f]++;
  return out;
}

/** The suggestion can be taken as it is: there is one and the product is not already on it. */
export const canAccept = (r: ProposalRow): r is ProposalRow & { suggested: BrandLine } =>
  r.suggested !== null && r.brand_line !== r.suggested;

/**
 * "Accept all ≥ 90 %": the server's `auto` rows (undecided, an anchor name or
 * ≥ 90 % of the parcels on one account — never a conflict, a hint or a mixed
 * row), grouped by the line they get, in the owner's line order. One POST per
 * line, at most `chunk` ids each.
 */
export function autoAcceptPlan(rows: readonly ProposalRow[], chunk = 1000): { line: BrandLine; ids: string[] }[] {
  const by = new Map<BrandLine, string[]>();
  for (const r of rows) {
    if (!r.auto || r.brand_line !== null || !r.suggested) continue;
    const list = by.get(r.suggested) ?? [];
    list.push(r.id);
    by.set(r.suggested, list);
  }
  const out: { line: BrandLine; ids: string[] }[] = [];
  for (const line of BRAND_LINES) {
    const ids = by.get(line) ?? [];
    for (let i = 0; i < ids.length; i += chunk) out.push({ line, ids: ids.slice(i, i + chunk) });
  }
  return out;
}

/**
 * Apply a writer's answer to local rows: the changed ids get their new line. A
 * proposal row's `auto` follows the server rule (undecided AND an anchor / high
 * confidence), so a line cleared back to undecided is offered again.
 */
export function applyLineChanges<T extends { id: string; brand_line?: unknown; auto?: boolean; confidence?: string }>(
  rows: readonly T[], result: Pick<SetBrandLineResult, 'changes'>,
): T[] {
  if (!result.changes.length) return rows as T[];
  const to = new Map(result.changes.map((c) => [c.id, c.to]));
  return rows.map((r) => {
    if (!to.has(r.id)) return r;
    const line = to.get(r.id) ?? null;
    const next = { ...r, brand_line: line } as T;
    if ('auto' in r) next.auto = line === null && (r.confidence === 'anchor' || r.confidence === 'high');
    return next;
  });
}
