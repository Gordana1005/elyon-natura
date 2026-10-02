/**
 * Targeted call scripts — the PURE rules (owner, 02.10.2026; contract docs/CALL-SCRIPTS.md).
 *
 * No imports, no network, no Deno/DOM globals: the edge function (GET /calls/scripts, the
 * coverage grid) and the browser (/call-scripts editor + tester, the /calls dock) run the SAME
 * code — src/lib/callScriptsTypes.ts re-exports this file the src/lib/shiftsApi.ts way.
 *
 *   groupOfListName      a prediction list name → its script group (never renames a list)
 *   matchScripts         which targeted script a call gets (tiers, primary before other product,
 *                        priority, newest, twins) + up to 4 alternatives, with reason codes
 *   substitute           {{customer_name}} / [Customer Name] → SEGMENTS (never HTML); a missing
 *                        value is a "missing" segment the UI shows as an amber chip
 *   resolveTargetedScript  sq falls back to mk per section id
 *   sectionsToText       the derived script_text — twin of SQL call_script_sections_text()
 *   lintScript           warnings only: BG content, terminology, unknown / legacy placeholders,
 *                        missing sq
 *   proposeProductsForTitle  products a legacy product script's title names
 *   whereItWins          the group × product cells a script wins (editor feedback)
 */

// ── Groups ──────────────────────────────────────────────────────────────────

export const LEAD_GROUPS = ['lead_new', 'lead_callback'] as const;
export const PREDICTION_GROUPS = [
  'newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus', 'cancels', 'never_converted', 'trash',
] as const;
export const ALL_GROUPS = [...LEAD_GROUPS, ...PREDICTION_GROUPS] as const;

export type LeadGroup = typeof LEAD_GROUPS[number];
export type PredictionGroup = typeof PREDICTION_GROUPS[number];
export type ScriptGroup = typeof ALL_GROUPS[number];

export const isScriptGroup = (v: unknown): v is ScriptGroup =>
  typeof v === 'string' && (ALL_GROUPS as readonly string[]).includes(v);
export const isLeadGroup = (g: string | null | undefined): g is LeadGroup =>
  !!g && (LEAD_GROUPS as readonly string[]).includes(g);

/** Lead order status → group. pending / take → a new lead; call_again → a callback. */
export function groupOfLeadStatus(status: string | null | undefined): LeadGroup | null {
  if (status === 'pending' || status === 'take') return 'lead_new';
  if (status === 'call_again') return 'lead_callback';
  return null;
}

/**
 * The holding pens, by EXACT name (the engine's names — never rename a list). `null` = the pen
 * has no group of its own: only scripts attached to every group (`groups = {}`) can reach it.
 */
export const PEN_GROUPS: Readonly<Record<string, ScriptGroup | null>> = {
  'Current Cancels': 'cancels',
  'Cancelled Pendings': 'cancels',
  'Never-Converted Recent': 'never_converted',
  'Never-Converted Old': 'never_converted',
  'Trash List': 'trash',
  'Current Returns': null,
  'Due to Reorder': null,
  'FULL MONAD LIST': null,
};

/** The engine's recency token → group (the same ids as RECENCY_ID in listModel.ts). */
export const RECENCY_GROUPS: Readonly<Record<string, PredictionGroup>> = {
  NEWCOMERS: 'newcomers', '21d': 'd21', '57d': 'd57', '4-6m': 'm4_6', '6-12m': 'm6_12', '1-2yr': 'y1_2', '2yr+': 'y2plus',
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A prediction list's script group. Exact pen names first, then the first token of the name
 * (NEWCOMERS | 21d | 57d | 4-6m | 6-12m | 1-2yr | 2yr+). Anything else — uploaded campaign lists,
 * unknown names — is `null`. Pure: it READS the name, never changes it.
 */
export function groupOfListName(name: string | null | undefined): ScriptGroup | null {
  if (typeof name !== 'string') return null;
  if (own(PEN_GROUPS, name)) return PEN_GROUPS[name];
  const trimmed = name.trim();
  if (own(PEN_GROUPS, trimmed)) return PEN_GROUPS[trimmed];
  const token = trimmed.split(/\s+/)[0] ?? '';
  return own(RECENCY_GROUPS, token) ? RECENCY_GROUPS[token] : null;
}

// ── Matching ────────────────────────────────────────────────────────────────

/** The fields matching needs (a TargetedScript has them all). */
export interface MatchableScript {
  id: string;
  context_type: string;
  status: string;
  groups: readonly string[] | null;
  product_ids: readonly string[] | null;
  priority: number | null;
  published_at: string | null;
  updated_at: string | null;
}

export interface MatchContext {
  group: ScriptGroup | null;
  /** The product the call is about (the lead's product / the trigger order's / the last sale's). */
  primary: string | null;
  /** Every product of the call (the primary included). */
  products: readonly string[];
  /** Catalogue duplicates (same normalised name) — id → its twins (itself excluded). */
  twins?: Readonly<Record<string, readonly string[]>>;
}

export type MatchTier = 1 | 2 | 3 | 4;
export type TieBreak = 'primary_product' | 'priority' | 'newest' | null;

export interface ScriptMatch {
  script_id: string;
  tier: MatchTier;
  /** group:<g> | all_groups · product:<id> | all_products · twin */
  reasons: string[];
  matched_product_id: string | null;
  /** What put this script ahead of the next one on the SAME tier; null = the tier decided (or nothing follows). */
  tie_break: TieBreak;
}

export interface MatchedScript<T extends MatchableScript = MatchableScript> {
  script: T;
  match: ScriptMatch;
}

export interface MatchResult<T extends MatchableScript = MatchableScript> {
  best: MatchedScript<T> | null;
  /** The next (at most) 4. */
  alternatives: MatchedScript<T>[];
  /** Every candidate that matched, in order. */
  ranked: MatchedScript<T>[];
}

export interface MatchOptions {
  /** Admin / manager preview: drafts compete too (archived never). */
  includeDrafts?: boolean;
  /** How many alternatives to keep (default 4). */
  alternatives?: number;
  /** Treat this script id as a candidate whatever its status (editor "where it wins"). */
  forceCandidateId?: string | null;
}

/** A product and its twins (the product first). */
export function familyOf(id: string | null | undefined, twins?: Readonly<Record<string, readonly string[]>>): string[] {
  if (!id) return [];
  const out = [id];
  for (const t of twins?.[id] ?? []) if (t && !out.includes(t)) out.push(t);
  return out;
}

const tsOf = (s: MatchableScript) => {
  const v = Date.parse(s.published_at || s.updated_at || '');
  return Number.isFinite(v) ? v : 0;
};

interface Scored<T extends MatchableScript> {
  script: T;
  tier: MatchTier;
  pRank: 0 | 1; // 0 = primary (or not product-specific), 1 = other product
  reasons: string[];
  matched: string | null;
}

function scoreOne<T extends MatchableScript>(s: T, ctx: MatchContext): Scored<T> | null {
  const groups = s.groups ?? [];
  const pids = s.product_ids ?? [];
  // group
  let gHit: 'all' | 'group';
  if (groups.length === 0) gHit = 'all';
  else if (ctx.group && groups.includes(ctx.group)) gHit = 'group';
  else return null;
  // product
  let pHit: 'all' | 'primary' | 'other';
  let matched: string | null = null;
  let viaTwin = false;
  if (pids.length === 0) {
    pHit = 'all';
  } else {
    const prim = familyOf(ctx.primary, ctx.twins);
    const hitPrim = prim.find((id) => pids.includes(id));
    if (hitPrim) {
      pHit = 'primary';
      matched = hitPrim;
      viaTwin = hitPrim !== ctx.primary;
    } else {
      let found: { id: string; twin: boolean } | null = null;
      for (const p of ctx.products) {
        if (!p) continue;
        const fam = familyOf(p, ctx.twins);
        const hit = fam.find((id) => pids.includes(id));
        if (hit) { found = { id: hit, twin: hit !== p }; break; }
      }
      if (!found) return null;
      pHit = 'other';
      matched = found.id;
      viaTwin = found.twin;
    }
  }
  const tier: MatchTier = gHit === 'group' ? (pHit === 'all' ? 2 : 1) : (pHit === 'all' ? 4 : 3);
  const reasons: string[] = [];
  reasons.push(gHit === 'group' ? `group:${ctx.group}` : 'all_groups');
  if (pHit === 'all') reasons.push('all_products');
  else {
    reasons.push(`product:${matched}`);
    if (viaTwin) reasons.push('twin');
  }
  return { script: s, tier, pRank: pHit === 'other' ? 1 : 0, reasons, matched };
}

function compareScored<T extends MatchableScript>(a: Scored<T>, b: Scored<T>): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.pRank !== b.pRank) return a.pRank - b.pRank;
  const pa = a.script.priority ?? 0;
  const pb = b.script.priority ?? 0;
  if (pa !== pb) return pb - pa;
  const ta = tsOf(a.script);
  const tb = tsOf(b.script);
  if (ta !== tb) return tb - ta;
  return a.script.id < b.script.id ? -1 : a.script.id > b.script.id ? 1 : 0;
}

function tieBreakOf<T extends MatchableScript>(a: Scored<T>, b: Scored<T> | undefined): TieBreak {
  if (!b || a.tier !== b.tier) return null;
  if (a.pRank !== b.pRank) return 'primary_product';
  if ((a.script.priority ?? 0) !== (b.script.priority ?? 0)) return 'priority';
  if (tsOf(a.script) !== tsOf(b.script)) return 'newest';
  return null;
}

/** Is the script a candidate at all (targeted + published, or a draft in preview)? */
export function isCandidate(s: MatchableScript, opts: MatchOptions = {}): boolean {
  if (s.context_type !== 'targeted') return false;
  if (opts.forceCandidateId && s.id === opts.forceCandidateId) return true;
  if (s.status === 'published') return true;
  return !!opts.includeDrafts && s.status === 'draft';
}

/**
 * The script a call gets.
 *   gHit = groups=∅ → all · G∈groups → group · else skip (a null G only reaches groups=∅)
 *   pHit = product_ids=∅ → all · ∩ family(primary) → primary · ∩ family(products) → other · else skip
 *   tier = group&prod 1 · group&all 2 · all&prod 3 · all&all 4
 *   order: tier ↑ · primary before other · priority ↓ · coalesce(published_at, updated_at) ↓ · id ↑
 */
export function matchScripts<T extends MatchableScript>(scripts: readonly T[], ctx: MatchContext, opts: MatchOptions = {}): MatchResult<T> {
  const scored: Scored<T>[] = [];
  for (const s of scripts) {
    if (!isCandidate(s, opts)) continue;
    const sc = scoreOne(s, ctx);
    if (sc) scored.push(sc);
  }
  scored.sort(compareScored);
  const ranked: MatchedScript<T>[] = scored.map((s, i) => ({
    script: s.script,
    match: {
      script_id: s.script.id,
      tier: s.tier,
      reasons: s.reasons,
      matched_product_id: s.matched,
      tie_break: tieBreakOf(s, scored[i + 1]),
    },
  }));
  const nAlt = Math.max(0, opts.alternatives ?? 4);
  return { best: ranked[0] ?? null, alternatives: ranked.slice(1, 1 + nAlt), ranked };
}

// ── Products: twins, families, proposals ────────────────────────────────────

export interface ProductLite {
  id: string;
  name: string;
  kind?: string | null;
  is_active?: boolean | null;
  brand_line?: string | null;
}

/** The twin key: case-insensitive exact name (trimmed, inner whitespace collapsed). */
export const productFamilyKey = (name: string | null | undefined) =>
  String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** id → the OTHER ids with the same family key (catalogue duplicates count as one product). */
export function buildTwins(products: readonly ProductLite[]): Record<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const p of products) {
    const k = productFamilyKey(p.name);
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(p.id);
    byKey.set(k, arr);
  }
  const out: Record<string, string[]> = {};
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out[id] = ids.filter((x) => x !== id);
  }
  return out;
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'zh', з: 'z', ѕ: 'dz', и: 'i', ј: 'j', к: 'k',
  л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'kj', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', џ: 'dj', ш: 'sh', й: 'j', ъ: 'a', ь: '', ю: 'ju', я: 'ja', щ: 'sht', ы: 'i', э: 'e',
};

/**
 * Lower-case Latin tokens for fuzzy name matching: Cyrillic transliterated, diacritics dropped,
 * and a light phonetic fold so the catalogue's two scripts meet — "ПРОСТАТОЛ КОМПЛЕКС" and
 * "Prostatol Complex" both become prostatol / kompleks (x → ks, c / q → k, w → v, y → i, doubled
 * letters collapsed). Matching only — never shown, never stored.
 */
export function nameTokens(name: string | null | undefined): string[] {
  const lower = String(name ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let lat = '';
  for (const ch of lower) lat += CYR_TO_LAT[ch] ?? ch;
  lat = lat.replace(/x/g, 'ks').replace(/[cq]/g, 'k').replace(/w/g, 'v').replace(/y/g, 'i').replace(/([a-z])\1+/g, '$1');
  return lat.split(/[^a-z0-9]+/).filter(Boolean);
}

/** Units and filler words, in their folded form (caps → kaps, cps → kps, ml, gr, tbl …). */
const NAME_STOPWORDS = new Set([
  'kaps', 'kps', 'kapsuli', 'kapsula', 'ml', 'l', 'g', 'gr', 'mg', 'tbl', 'tableti', 'kom', 'ks', 'so', 'za', 'i', 'od',
  'na', 'and', 'vith', 'the', 'po', 'izbor', 'podarok', 'gratis',
]);
const significant = (tokens: string[]) => tokens.filter((t) => t.length >= 3 && !/^\d/.test(t) && !NAME_STOPWORDS.has(t));

export interface ProductProposal {
  product_id: string;
  name: string;
  kind: string | null;
  is_active: boolean | null;
  /** Every significant title token is in the product's name and nothing else significant. */
  exact: boolean;
  /** Share of the product's significant tokens the title covers (1 = the same words). */
  score: number;
}

/**
 * The products a (legacy product-script) title names: the title's core (before " – " / " - ")
 * reduced to its significant tokens; a product is proposed when its name holds EVERY one of them.
 * Ordered: exact first, kind 'product' before bundles, active first, score ↓, name.
 */
export function proposeProductsForTitle(title: string | null | undefined, products: readonly ProductLite[]): ProductProposal[] {
  const core = String(title ?? '').split(/\s[–—-]\s/)[0];
  const want = [...new Set(significant(nameTokens(core)))];
  if (want.length === 0) return [];
  const out: ProductProposal[] = [];
  for (const p of products) {
    const have = new Set(significant(nameTokens(p.name)));
    if (!want.every((t) => have.has(t))) continue;
    out.push({
      product_id: p.id,
      name: p.name,
      kind: p.kind ?? null,
      is_active: p.is_active ?? null,
      exact: have.size === want.length,
      score: have.size === 0 ? 0 : Math.round((want.length / have.size) * 100) / 100,
    });
  }
  const kindRank = (k: string | null) => (k === 'product' ? 0 : k === 'bundle' ? 1 : 2);
  return out.sort((a, b) =>
    Number(b.exact) - Number(a.exact)
    || kindRank(a.kind) - kindRank(b.kind)
    || Number(b.is_active === true) - Number(a.is_active === true)
    || b.score - a.score
    || a.name.localeCompare(b.name));
}

// ── Sections ────────────────────────────────────────────────────────────────

export const SECTION_KEYS = ['opening', 'pitch', 'objections', 'closing', 'custom'] as const;
export type SectionKey = typeof SECTION_KEYS[number];
export const FIXED_SECTION_KEYS = ['opening', 'pitch', 'objections', 'closing'] as const;
export type FixedSectionKey = typeof FIXED_SECTION_KEYS[number];

export interface ScriptSectionLite {
  id: string;
  key: SectionKey;
  title?: string | null;
  text: string;
}

export const SCRIPT_LANGS = ['mk', 'sq'] as const;
export type ScriptLanguage = typeof SCRIPT_LANGS[number];

/** The headings in the derived script_text (and the SQL twin call_script_sections_text). */
export const SECTION_HEADINGS: Readonly<Record<ScriptLanguage, Readonly<Record<FixedSectionKey, string>>>> = {
  mk: { opening: 'Отворање', pitch: 'Презентација', objections: 'Приговори', closing: 'Затворање' },
  sq: { opening: 'Hapja', pitch: 'Prezantimi', objections: 'Kundërshtimet', closing: 'Mbyllja' },
};

export const MAX_SECTIONS = 12;
export const MAX_SECTION_TEXT = 8000;
export const MAX_SECTION_TITLE = 80;
export const CUSTOM_SECTION_ID = /^custom-[a-z0-9]{6,12}$/;

/** Trim spaces, tabs, CR and LF only — exactly what the SQL twin trims. */
export const trimWs = (s: string | null | undefined) => String(s ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

const isFixedKey = (k: string): k is FixedSectionKey => (FIXED_SECTION_KEYS as readonly string[]).includes(k);

/** A section's heading in a language: the fixed heading, or the custom section's own title. */
export function sectionHeading(sec: Pick<ScriptSectionLite, 'key' | 'title'>, lang: ScriptLanguage = 'mk'): string {
  if (isFixedKey(sec.key)) return SECTION_HEADINGS[lang]?.[sec.key] ?? SECTION_HEADINGS.mk[sec.key];
  return trimWs(sec.title);
}

/**
 * The derived plain text of a sectioned script — "Heading\ntext" blocks joined by a blank line,
 * empty sections skipped. MUST stay identical to SQL public.call_script_sections_text(jsonb, text).
 */
export function sectionsToText(sections: readonly ScriptSectionLite[] | null | undefined, lang: ScriptLanguage = 'mk'): string {
  const blocks: string[] = [];
  for (const s of sections ?? []) {
    const text = trimWs(s?.text);
    if (!text) continue;
    const h = sectionHeading(s, lang);
    blocks.push(h ? `${h}\n${text}` : text);
  }
  return blocks.join('\n\n');
}

export interface SectionsValidation {
  ok: boolean;
  /** too_many | bad_key | duplicate_key | bad_id | duplicate_id | title_required | title_too_long | text_too_long | not_object */
  errors: { index: number; code: string }[];
}

/** The same rules the SQL writer enforces (the api refuses before the database does). */
export function validateSections(sections: unknown): SectionsValidation {
  const errors: { index: number; code: string }[] = [];
  if (!Array.isArray(sections)) return { ok: false, errors: [{ index: -1, code: 'not_array' }] };
  if (sections.length > MAX_SECTIONS) errors.push({ index: -1, code: 'too_many' });
  const keys = new Set<string>();
  const ids = new Set<string>();
  sections.forEach((s: any, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push({ index: i, code: 'not_object' }); return; }
    const key = String(s.key ?? '');
    if (!(SECTION_KEYS as readonly string[]).includes(key)) { errors.push({ index: i, code: 'bad_key' }); return; }
    if (key !== 'custom') {
      if (keys.has(key)) errors.push({ index: i, code: 'duplicate_key' });
      keys.add(key);
      if (s.id !== key) errors.push({ index: i, code: 'bad_id' });
    } else {
      if (typeof s.id !== 'string' || !CUSTOM_SECTION_ID.test(s.id)) errors.push({ index: i, code: 'bad_id' });
      const t = trimWs(typeof s.title === 'string' ? s.title : '');
      if (!t) errors.push({ index: i, code: 'title_required' });
      else if (t.length > MAX_SECTION_TITLE) errors.push({ index: i, code: 'title_too_long' });
    }
    if (typeof s.id === 'string') {
      if (ids.has(s.id)) errors.push({ index: i, code: 'duplicate_id' });
      ids.add(s.id);
    }
    if (typeof s.text !== 'string') errors.push({ index: i, code: 'text_not_string' });
    else if (s.text.length > MAX_SECTION_TEXT) errors.push({ index: i, code: 'text_too_long' });
  });
  return { ok: errors.length === 0, errors };
}

// ── Language resolution ─────────────────────────────────────────────────────

export interface HelperLite { title: string; content: string; category?: string | null }

export interface TranslatableScript {
  title: string;
  description: string | null;
  sections: readonly ScriptSectionLite[] | null;
  helpers?: readonly HelperLite[] | null;
  translations?: {
    sq?: {
      title?: string | null;
      description?: string | null;
      sections?: readonly ScriptSectionLite[] | null;
      helpers?: readonly HelperLite[] | null;
    } | null;
  } | null;
}

export interface ResolvedTargetedScript {
  lang: ScriptLanguage;
  title: string;
  description: string | null;
  sections: ScriptSectionLite[];
  helpers: HelperLite[];
  /** Section ids shown in Macedonian because the sq text is empty / missing (sq only). */
  fallback_section_ids: string[];
  /** Title / description / helpers that fell back to Macedonian (sq only). */
  fallback_fields: ('title' | 'description' | 'helpers')[];
}

const hasText = (v: unknown): v is string => typeof v === 'string' && trimWs(v).length > 0;

/**
 * The script in a language. mk = the base columns. sq = translations.sq, falling back to the
 * Macedonian text PER SECTION ID (base order kept; sq-only sections follow), per field for title /
 * description, and as a whole for helpers (a non-empty sq list replaces the base list).
 */
export function resolveTargetedScript(script: TranslatableScript, lang: string | null | undefined): ResolvedTargetedScript {
  const base = (script.sections ?? []).map((s) => ({ ...s }));
  const baseHelpers = [...(script.helpers ?? [])];
  const code = String(lang || 'mk').split('-')[0];
  if (code !== 'sq') {
    return { lang: 'mk', title: script.title, description: script.description ?? null, sections: base, helpers: baseHelpers, fallback_section_ids: [], fallback_fields: [] };
  }
  const tr = script.translations?.sq ?? null;
  const trSections = new Map<string, ScriptSectionLite>();
  for (const s of tr?.sections ?? []) if (s && typeof s.id === 'string') trSections.set(s.id, s);
  const fallback: string[] = [];
  const sections: ScriptSectionLite[] = base.map((b) => {
    const t = trSections.get(b.id);
    if (t && hasText(t.text)) {
      return { ...b, text: t.text, title: b.key === 'custom' ? (hasText(t.title) ? t.title : b.title ?? null) : b.title ?? null };
    }
    if (hasText(b.text)) fallback.push(b.id);
    return b;
  });
  const baseIds = new Set(base.map((b) => b.id));
  for (const t of tr?.sections ?? []) if (t && !baseIds.has(t.id) && hasText(t.text)) sections.push({ ...t });
  const fields: ('title' | 'description' | 'helpers')[] = [];
  const title = hasText(tr?.title) ? tr!.title! : (fields.push('title'), script.title);
  let description = script.description ?? null;
  if (hasText(tr?.description)) description = tr!.description!;
  else if (hasText(script.description)) fields.push('description');
  let helpers = baseHelpers;
  if (Array.isArray(tr?.helpers) && tr!.helpers!.length > 0) helpers = [...tr!.helpers!];
  else if (baseHelpers.length > 0) fields.push('helpers');
  return { lang: 'sq', title, description, sections, helpers, fallback_section_ids: fallback, fallback_fields: fields };
}

// ── Variables ───────────────────────────────────────────────────────────────

export const SCRIPT_VAR_NAMES = [
  'customer_name', 'first_name', 'agent_name', 'product', 'price', 'last_product', 'last_purchase_date',
  'days_since_purchase', 'since_purchase', 'city', 'order_id',
] as const;
export type ScriptVarName = typeof SCRIPT_VAR_NAMES[number];
export const isScriptVarName = (v: string): v is ScriptVarName => (SCRIPT_VAR_NAMES as readonly string[]).includes(v);

/** The legacy [Placeholder] form the old scripts use → the variable it means. */
export const LEGACY_PLACEHOLDERS: Readonly<Record<string, ScriptVarName>> = {
  'Customer Name': 'customer_name',
  Product: 'product',
  'Order ID': 'order_id',
  'Agent Name': 'agent_name',
  'Your Name': 'agent_name',
  Price: 'price',
  City: 'city',
};

/** What the server sends for a call (privacy already applied — a hidden value is null). */
export interface ScriptVarsLite {
  customer_name: string | null;
  first_name: string | null;
  agent_name: string | null;
  product: string | null;
  price_eur: number | null;
  last_product: string | null;
  last_purchase_at: string | null;
  days_since_purchase: number | null;
  city: string | null;
  order_id: string | null;
}

export type ScriptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: ScriptVarName; text: string; raw: string }
  | { kind: 'missing'; name: ScriptVarName; raw: string };

/** The FROZEN peg (src/lib/currency.ts MKD_PER_EUR) — prices are stored in EUR, spoken in денари. */
export const SCRIPT_MKD_PER_EUR = 61.5;

const groupThousands = (n: number) => {
  const s = Math.abs(Math.round(n)).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
};

/** EUR → "1.599 ден" (the same output as formatMoney in src/lib/currency.ts). */
export const formatScriptPrice = (eur: number) => `${groupThousands(Math.round(eur * SCRIPT_MKD_PER_EUR))} ден`;

/** An ISO instant → "dd.mm.yyyy" on the Skopje calendar. */
export function formatScriptDate(iso: string): string | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')}.${get('month')}.${get('year')}`;
  } catch {
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  }
}

/** "пред 3 месеци" / "para 3 muajsh" — how long ago, in the script's language. */
export function sinceText(days: number, lang: ScriptLanguage = 'mk'): string {
  const d = Math.max(0, Math.floor(days));
  const mk = lang !== 'sq';
  if (d < 1) return mk ? 'денес' : 'sot';
  if (d < 14) return mk ? `пред ${d} ${d === 1 ? 'ден' : 'дена'}` : `para ${d} ${d === 1 ? 'dite' : 'ditësh'}`;
  if (d < 60) { const w = Math.round(d / 7); return mk ? `пред ${w} недели` : `para ${w} javësh`; }
  if (d < 730) {
    const m = Math.max(2, Math.round(d / 30.44));
    return mk ? `пред ${m} месеци` : `para ${m} muajsh`;
  }
  const y = Math.floor(d / 365.25);
  return mk ? `пред ${y} ${y === 1 ? 'година' : 'години'}` : `para ${y} ${y === 1 ? 'viti' : 'vitesh'}`;
}

/** The text a variable becomes, or null when the value is unknown / hidden. */
export function varValue(name: ScriptVarName, vars: ScriptVarsLite | null | undefined, lang: ScriptLanguage = 'mk'): string | null {
  if (!vars) return null;
  const s = (v: string | null | undefined) => (hasText(v) ? trimWs(v) : null);
  switch (name) {
    case 'customer_name': return s(vars.customer_name);
    case 'first_name': return s(vars.first_name) ?? (s(vars.customer_name)?.split(/\s+/)[0] ?? null);
    case 'agent_name': return s(vars.agent_name);
    case 'product': return s(vars.product);
    case 'price': return typeof vars.price_eur === 'number' && Number.isFinite(vars.price_eur) && vars.price_eur > 0 ? formatScriptPrice(vars.price_eur) : null;
    case 'last_product': return s(vars.last_product);
    case 'last_purchase_date': return vars.last_purchase_at ? formatScriptDate(vars.last_purchase_at) : null;
    case 'days_since_purchase': return typeof vars.days_since_purchase === 'number' && Number.isFinite(vars.days_since_purchase) ? String(Math.max(0, Math.floor(vars.days_since_purchase))) : null;
    case 'since_purchase': return typeof vars.days_since_purchase === 'number' && Number.isFinite(vars.days_since_purchase) ? sinceText(vars.days_since_purchase, lang) : null;
    case 'city': return s(vars.city);
    case 'order_id': return s(vars.order_id);
  }
}

/** {{ name }} (new) or [Legacy Name] (old) — one regex, two capture groups. */
const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}|\[(Customer Name|Product|Order ID|Agent Name|Your Name|Price|City)\]/g;

/**
 * The text with its variables filled — as SEGMENTS, never HTML (the UI renders text nodes, so a
 * "<b>" in a script stays literal). A known variable with no value → a `missing` segment (amber
 * chip). An unknown {{name}} stays as written (lintScript flags it). Adjacent text is merged.
 */
export function substitute(text: string | null | undefined, vars: ScriptVarsLite | null | undefined, lang: ScriptLanguage = 'mk'): ScriptSegment[] {
  const src = String(text ?? '');
  const out: ScriptSegment[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  let at = 0;
  VAR_RE.lastIndex = 0;
  for (let m = VAR_RE.exec(src); m; m = VAR_RE.exec(src)) {
    const raw = m[0];
    const name = m[1] !== undefined ? m[1] : LEGACY_PLACEHOLDERS[m[2]];
    pushText(src.slice(at, m.index));
    at = m.index + raw.length;
    if (!name || !isScriptVarName(name)) { pushText(raw); continue; }
    const v = varValue(name, vars, lang);
    if (v == null) out.push({ kind: 'missing', name, raw });
    else out.push({ kind: 'var', name, text: v, raw });
  }
  pushText(src.slice(at));
  return out;
}

/** The segments as plain text (missing values keep their raw token). */
export const segmentsToText = (segs: readonly ScriptSegment[]) =>
  segs.map((s) => (s.kind === 'missing' ? s.raw : s.text)).join('');

// ── Lint (warnings only) ────────────────────────────────────────────────────

export type LintCode = 'bg_content' | 'terminology' | 'unknown_var' | 'legacy_placeholder' | 'missing_sq';
export interface LintIssue {
  code: LintCode;
  severity: 'warn' | 'info';
  lang: ScriptLanguage;
  /** title | description | section:<id> | helper:<index> */
  field: string;
  /** The text that triggered it (for missing_sq: the section id). */
  match: string;
}

/**
 * Bulgarian leftovers. Contract: /евро|€|\bлв\b|лева|Еконт|Спиди|Econt|Speedy|Бугарија|България/i —
 * JavaScript's \b is ASCII-only, so "лв" is bounded by "not a letter" (Unicode) instead.
 */
export const BG_CONTENT_RE = /евро|€|(?<!\p{L})лв(?!\p{L})|лева|Еконт|Спиди|Econt|Speedy|Бугарија|България/giu;
/** The owner's terminology (30.09 / 01.10): предикција, лидови; "на чекање" only for the order status. */
export const TERMINOLOGY_RE = /прогноз|пендинг|на чекање/giu;
const UNKNOWN_VAR_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const LEGACY_RE = /\[(Customer Name|Product|Order ID|Agent Name|Your Name|Price|City|Company|Address)\]|_{3,}/g;

export interface LintableScript extends TranslatableScript {
  context_type?: string;
  script_text?: string | null;
}

function textsOf(script: LintableScript, lang: ScriptLanguage): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const add = (field: string, text: unknown) => { if (hasText(text)) out.push({ field, text }); };
  if (lang === 'mk') {
    add('title', script.title);
    add('description', script.description);
    const secs = script.sections ?? [];
    if (secs.length > 0 || script.context_type === 'targeted') secs.forEach((s) => add(`section:${s.id}`, s.text));
    else add('script_text', script.script_text);
    (script.helpers ?? []).forEach((h, i) => add(`helper:${i}`, `${h.title}\n${h.content}`));
  } else {
    const tr = script.translations?.sq as (NonNullable<TranslatableScript['translations']>['sq'] & { script_text?: string | null }) | null | undefined;
    if (!tr) return out;
    add('title', tr.title);
    add('description', tr.description);
    const secs = tr.sections ?? [];
    if (secs.length > 0) secs.forEach((s) => add(`section:${s.id}`, s.text));
    else add('script_text', tr.script_text);
    (tr.helpers ?? []).forEach((h, i) => add(`helper:${i}`, `${h.title}\n${h.content}`));
  }
  return out;
}

/** Warnings for the editor and the library (never blocks a save or a publish). */
export function lintScript(script: LintableScript): LintIssue[] {
  const issues: LintIssue[] = [];
  const seen = new Set<string>();
  const push = (i: LintIssue) => {
    const k = `${i.code}|${i.lang}|${i.field}|${i.match.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    issues.push(i);
  };
  for (const lang of SCRIPT_LANGS) {
    for (const { field, text } of textsOf(script, lang)) {
      for (const m of text.matchAll(BG_CONTENT_RE)) push({ code: 'bg_content', severity: 'warn', lang, field, match: m[0] });
      for (const m of text.matchAll(TERMINOLOGY_RE)) push({ code: 'terminology', severity: 'warn', lang, field, match: m[0] });
      for (const m of text.matchAll(UNKNOWN_VAR_RE)) {
        if (!isScriptVarName(m[1])) push({ code: 'unknown_var', severity: 'warn', lang, field, match: m[0] });
      }
      for (const m of text.matchAll(LEGACY_RE)) push({ code: 'legacy_placeholder', severity: 'warn', lang, field, match: m[0] });
    }
  }
  // missing_sq (information): a Macedonian section with text and no Albanian text for its id.
  const sq = new Map<string, string>();
  for (const s of script.translations?.sq?.sections ?? []) if (s) sq.set(s.id, s.text);
  for (const s of script.sections ?? []) {
    if (hasText(s.text) && !hasText(sq.get(s.id))) push({ code: 'missing_sq', severity: 'info', lang: 'sq', field: `section:${s.id}`, match: s.id });
  }
  return issues;
}

// ── Where a script wins (editor feedback) ───────────────────────────────────

export interface WinCell {
  group: ScriptGroup;
  product_id: string | null;
  winner_id: string | null;
  tier: MatchTier | null;
  wins: boolean;
}
export interface WhereItWins {
  cells: WinCell[];
  wins: number;
  loses: number;
}

/**
 * For one script: every cell it targets — its groups (all groups when none) × its products (the
 * given catalogue + "no product" when it targets every product) — and who wins each cell when this
 * script competes (whatever its status) against the published scripts (+ drafts when asked).
 */
export function whereItWins<T extends MatchableScript>(
  target: T,
  others: readonly T[],
  opts: { productIds?: readonly string[]; twins?: Readonly<Record<string, readonly string[]>>; includeDrafts?: boolean } = {},
): WhereItWins {
  const pool = [target, ...others.filter((s) => s.id !== target.id)];
  const groups: ScriptGroup[] = (target.groups ?? []).length > 0
    ? (ALL_GROUPS.filter((g) => (target.groups ?? []).includes(g)) as ScriptGroup[])
    : [...ALL_GROUPS];
  const products: (string | null)[] = (target.product_ids ?? []).length > 0
    ? [...(target.product_ids ?? [])]
    : [null, ...(opts.productIds ?? [])];
  const cells: WinCell[] = [];
  for (const g of groups) {
    for (const p of products) {
      const r = matchScripts(pool, { group: g, primary: p, products: p ? [p] : [], twins: opts.twins }, {
        includeDrafts: opts.includeDrafts, forceCandidateId: target.id, alternatives: 0,
      });
      const winner = r.best?.script.id ?? null;
      cells.push({ group: g, product_id: p, winner_id: winner, tier: r.best?.match.tier ?? null, wins: winner === target.id });
    }
  }
  const wins = cells.filter((c) => c.wins).length;
  return { cells, wins, loses: cells.length - wins };
}
