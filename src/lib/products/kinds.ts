import { normalizeForSearch } from '@/lib/transliterate';
import { lineOf, type BrandLine, type LineFilter, LINE_FILTERS } from './brandLines';
import { matchesVat, vatFilterOf, VAT_FILTERS, type VatFilter, type VatRate } from './vat';

/**
 * Производи 2.0 (owner 01.10.2026): every product has a KIND, and /products
 * opens on the ordinary products.
 *
 *   product  Производи          — single supplements / cosmetics (the default chip)
 *   bundle   Пакети и промоции  — 1+1, 2x, сет, PACK, Combo, подарок …
 *   gift     Подароци           — items used as free gifts
 *   other    Друго              — physical objects (вага, блендер, тостер, шејкер …)
 *   null     Неодредено
 *
 * The kind lives on products.kind (migration 20260943001400) and is set only
 * through POST /api/products/kind (audited). The server twin is
 * supabase/functions/api/productsCatalog.ts; the SQL decides the proposal.
 *
 * Pure: the filters, the faceted counts and the "accept all sure" plan are
 * unit-tested in kinds.test.ts.
 */

export const PRODUCT_KINDS = ['product', 'bundle', 'gift', 'other'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** The kind chips, in the owner's order; `product` is the default view. */
export const KIND_FILTERS = ['product', 'bundle', 'gift', 'other', 'none', 'all'] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];
export const DEFAULT_KIND_FILTER: KindFilter = 'product';

export const STATUS_FILTERS = ['all', 'active', 'inactive'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** One page of the list; "Прикажи повеќе" adds another. */
export const PAGE_SIZE = 50;

export const isProductKind = (v: unknown): v is ProductKind =>
  typeof v === 'string' && (PRODUCT_KINDS as readonly string[]).includes(v);
export const isKindFilter = (v: unknown): v is KindFilter =>
  typeof v === 'string' && (KIND_FILTERS as readonly string[]).includes(v);
export const isStatusFilter = (v: unknown): v is StatusFilter =>
  typeof v === 'string' && (STATUS_FILTERS as readonly string[]).includes(v);

/** A product's kind, or null (missing / unknown = Неодредено). */
export const kindOf = (p: { kind?: unknown }): ProductKind | null => (isProductKind(p.kind) ? p.kind : null);

/**
 * A kind's chip tone — literal classes so Tailwind generates them, with a dark
 * twin. Always shown with its word, never colour alone.
 */
export const KIND_TONES: Record<ProductKind, string> = {
  product: 'border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200',
  bundle: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  gift: 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300',
  other: 'border-cyan-300 bg-cyan-50 text-cyan-900 dark:border-cyan-800 dark:bg-cyan-950/50 dark:text-cyan-300',
};
export const UNDECIDED_KIND_TONE = 'border-dashed bg-muted/40 text-muted-foreground border-border';

// ── the catalogue row (GET /api/products/catalogue) ──────────────────────────
export interface CatalogueRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  /** EUR (stored); shown in денари. */
  price: number;
  /** EUR mirror of the Sigma cost (cost_mkd / 61,5); present only for an owner. Not shown — cost_mkd is. */
  cost_price?: number;
  /**
   * Stock v2, owners only (stock_v2_product_overview, 20260945000510): the current complete Sigma
   * purchase cost in денари without VAT (null = none; an exempt product 0) — "Набавна (Сигма)" —
   * and the recipe status behind the "Рецепт" chips. Absent until that reader is applied.
   */
  cost_mkd?: number | null;
  recipe_status?: 'approved' | 'proposed' | 'none' | 'exempt';
  suggested_price: number;
  stock_quantity: number;
  low_stock_threshold: number;
  days_of_supply_per_unit: number;
  is_active: boolean;
  /** Machine categories are blanked by the api. */
  category: string;
  /** Machine descriptions are blanked by the api. */
  description: string;
  supplier_id: string | null;
  supplier_name: string | null;
  brand_line: BrandLine | null;
  kind: ProductKind | null;
  created_at: string | null;
  /** VAT per product from Sigma (20260944000900) — present only for an owner. */
  vat_rate?: VatRate | null;
  vat_source?: string | null;
  vat_sigma_code?: string | null;
  vat_sigma_name?: string | null;
  vat_evidence?: string | null;
  vat_set_at?: string | null;
}

export interface CatalogueFilters {
  kind: KindFilter;
  line: LineFilter;
  status: StatusFilter;
  query: string;
  /** Owners only (the VAT columns reach only them); absent = all. */
  vat?: VatFilter;
}

/** The search key of a row: name, SKU, barcode, category — Cyrillic ⇄ Latin, any case. Built once per row. */
export const searchKey = (p: Pick<CatalogueRow, 'name' | 'sku' | 'barcode' | 'category'>): string =>
  normalizeForSearch([p.name, p.sku, p.barcode, p.category].filter(Boolean).join(' '));

export const queryWords = (query: string): string[] => normalizeForSearch(query.trim()).split(/\s+/).filter(Boolean);

export function matchesKind(p: { kind?: unknown }, f: KindFilter): boolean {
  if (f === 'all') return true;
  const k = kindOf(p);
  return f === 'none' ? k === null : k === f;
}
export function matchesLineFilter(p: { brand_line?: unknown }, f: LineFilter): boolean {
  if (f === 'all') return true;
  const l = lineOf(p);
  return f === 'none' ? l === null : l === f;
}
export const matchesStatus = (p: { is_active: boolean }, f: StatusFilter): boolean =>
  f === 'all' || (f === 'active' ? p.is_active : !p.is_active);

/** A row as the list sees it: the row and its prepared search key. */
export interface Indexed<T> { row: T; key: string }

export function indexRows<T extends Pick<CatalogueRow, 'name' | 'sku' | 'barcode' | 'category'>>(rows: readonly T[]): Indexed<T>[] {
  return rows.map((row) => ({ row, key: searchKey(row) }));
}

const matchesWords = (key: string, words: readonly string[]) => words.every((w) => key.includes(w));

/** The rows every filter lets through, in the given order. */
export function filterCatalogue<T extends CatalogueRow>(items: readonly Indexed<T>[], f: CatalogueFilters): T[] {
  const words = queryWords(f.query);
  const out: T[] = [];
  for (const { row, key } of items) {
    if (matchesKind(row, f.kind) && matchesLineFilter(row, f.line) && matchesStatus(row, f.status)
      && matchesVat(row, f.vat) && matchesWords(key, words)) out.push(row);
  }
  return out;
}

export interface Facets {
  kind: Record<KindFilter, number>;
  line: Record<LineFilter, number>;
  status: Record<StatusFilter, number>;
  vat: Record<VatFilter, number>;
}

/**
 * Faceted counts: each chip group counts the rows the OTHER filters let
 * through, so a chip's number is what a click on it would show (while typing
 * "whey", the kind chips say where the matches are).
 */
export function facetCounts(items: readonly Indexed<CatalogueRow>[], f: CatalogueFilters): Facets {
  const kind = Object.fromEntries(KIND_FILTERS.map((k) => [k, 0])) as Record<KindFilter, number>;
  const line = Object.fromEntries(LINE_FILTERS.map((k) => [k, 0])) as Record<LineFilter, number>;
  const status = Object.fromEntries(STATUS_FILTERS.map((k) => [k, 0])) as Record<StatusFilter, number>;
  const vat = Object.fromEntries(VAT_FILTERS.map((k) => [k, 0])) as Record<VatFilter, number>;
  const words = queryWords(f.query);
  for (const { row, key } of items) {
    if (!matchesWords(key, words)) continue;
    const okKind = matchesKind(row, f.kind);
    const okLine = matchesLineFilter(row, f.line);
    const okStatus = matchesStatus(row, f.status);
    const okVat = matchesVat(row, f.vat);
    if (okLine && okStatus && okVat) { kind.all++; kind[kindOf(row) ?? 'none']++; }
    if (okKind && okStatus && okVat) { line.all++; line[lineOf(row) ?? 'none']++; }
    if (okKind && okLine && okVat) { status.all++; status[row.is_active ? 'active' : 'inactive']++; }
    if (okKind && okLine && okStatus) { vat.all++; vat[vatFilterOf(row)]++; }
  }
  return { kind, line, status, vat };
}

/** Name order the way a Macedonian reads it (Cyrillic and Latin, numbers by value). */
const collator = new Intl.Collator('mk', { sensitivity: 'base', numeric: true });
export const byName = <T extends { name: string }>(a: T, b: T) => collator.compare(a.name, b.name);

// ── the kind proposal (GET /api/products/kind-proposal) ──────────────────────
export type KindConfidence = 'high' | 'low';
export type KindReason =
  | 'promo' | 'bundle_word' | 'multi_pack' | 'plus_joiner' | 'object_set' | 'object_word' | 'free_in_orders' | 'single' | 'empty_name';

export interface KindProposalRow {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  kind: ProductKind | null;
  kind_set_at: string | null;
  kind_set_by_name: string | null;
  suggested: ProductKind | null;
  confidence: KindConfidence;
  reason: KindReason;
  hit: string | null;
  lines: number;
  free_lines: number;
  free_share: number | null;
  auto: boolean;
}

export interface KindProposal {
  generated_at: string | null;
  summary: {
    products: number;
    suggested: Record<ProductKind | 'none', number>;
    decided: number;
    auto: number;
    low: number;
    differs: number;
  };
  rows: KindProposalRow[];
}

export interface SetKindResult {
  kind: ProductKind | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: { id: string; name: string; from: ProductKind | null; to: ProductKind | null }[];
}

export const KIND_PROPOSAL_FILTERS = ['todo', 'auto', 'low', 'differs', 'decided', 'all'] as const;
export type KindProposalFilter = (typeof KIND_PROPOSAL_FILTERS)[number];

export function matchesKindProposalFilter(r: KindProposalRow, f: KindProposalFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'todo': return r.kind === null;
    case 'auto': return r.kind === null && r.auto;
    case 'low': return r.kind === null && r.confidence === 'low';
    case 'differs': return r.kind !== null && r.suggested !== null && r.kind !== r.suggested;
    case 'decided': return r.kind !== null;
  }
}

export function kindProposalCounts(rows: readonly KindProposalRow[]): Record<KindProposalFilter, number> {
  const out = Object.fromEntries(KIND_PROPOSAL_FILTERS.map((k) => [k, 0])) as Record<KindProposalFilter, number>;
  for (const r of rows) for (const f of KIND_PROPOSAL_FILTERS) if (matchesKindProposalFilter(r, f)) out[f]++;
  return out;
}

/** The suggestion can be taken as it is: there is one and the product is not already of it. */
export const canAcceptKind = (r: KindProposalRow): r is KindProposalRow & { suggested: ProductKind } =>
  r.suggested !== null && r.kind !== r.suggested;

/** "Accept all sure": the server's `auto` rows (undecided + high confidence), grouped per kind, ≤ chunk ids per call. */
export function autoKindPlan(rows: readonly KindProposalRow[], chunk = 1000): { kind: ProductKind; ids: string[] }[] {
  const by = new Map<ProductKind, string[]>();
  for (const r of rows) {
    if (!r.auto || r.kind !== null || !r.suggested) continue;
    const list = by.get(r.suggested) ?? [];
    list.push(r.id);
    by.set(r.suggested, list);
  }
  const out: { kind: ProductKind; ids: string[] }[] = [];
  for (const kind of PRODUCT_KINDS) {
    const ids = by.get(kind) ?? [];
    for (let i = 0; i < ids.length; i += chunk) out.push({ kind, ids: ids.slice(i, i + chunk) });
  }
  return out;
}

/** Apply a writer's answer to local rows; a proposal row's `auto` follows the server rule (undecided + high). */
export function applyKindChanges<T extends { id: string; kind?: unknown; auto?: boolean; confidence?: string; suggested?: unknown }>(
  rows: readonly T[], result: Pick<SetKindResult, 'changes'>,
): T[] {
  if (!result.changes.length) return rows as T[];
  const to = new Map(result.changes.map((c) => [c.id, c.to]));
  return rows.map((r) => {
    if (!to.has(r.id)) return r;
    const kind = to.get(r.id) ?? null;
    const next = { ...r, kind } as T;
    if ('auto' in r) next.auto = kind === null && r.confidence === 'high' && r.suggested != null;
    return next;
  });
}
