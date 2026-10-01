/**
 * Recipes and Sigma purchase costs on /products (owner 01.10.2026, docs/STOCK-V2.md) — the pure half,
 * unit-tested in recipe.test.ts.
 *
 *   A product's RECIPE (product_articles) = the Sigma articles it is made of: a single product = its own
 *   article × 1, a bundle = its components, a packed gift line = role gift. Only an APPROVED recipe moves
 *   stock or cost. The product's purchase cost = Σ qty × the article's Sigma CalcBuyPrice (денари, without
 *   VAT) — "Набавна (Сигма)", shown to owners only.
 *
 *   The catalogue row (GET /products/catalogue) carries, for owners, `cost_mkd` (the current complete
 *   cost, stock_v2_product_overview — migration 20260945000510) and `recipe_status`. The column shows
 *   cost_mkd only — never the EUR mirror products.cost_price × 61,5 (before the costs were rebuilt it
 *   held the archived CRM prices, which are not Sigma's). When the api does not send them yet the
 *   column says "—" and the "Рецепт" filter stays hidden.
 */
import type { ProductRecipe, ProductRecipeLine } from '@/lib/stockV2Types';

export const RECIPE_FILTERS = ['all', 'approved', 'proposed', 'none'] as const;
export type RecipeFilter = (typeof RECIPE_FILTERS)[number];
export const isRecipeFilter = (v: unknown): v is RecipeFilter =>
  typeof v === 'string' && (RECIPE_FILTERS as readonly string[]).includes(v);

/** approved = moves stock and cost · proposed = waits for an owner · none · exempt = no goods (delivery, points …). */
export type RecipeStatus = 'approved' | 'proposed' | 'none' | 'exempt';
const STATUSES: readonly RecipeStatus[] = ['approved', 'proposed', 'none', 'exempt'];

export interface RecipeFields {
  /** Owners only (Stock v2): the current complete Sigma cost in денари; null = none. */
  cost_mkd?: number | null;
  recipe_status?: RecipeStatus | string | null;
  /** EUR mirror of the Sigma cost (owners / admins). */
  cost_price?: number;
}

/** The row's recipe status, or undefined when the api does not send one. */
export function recipeStatusOf(r: RecipeFields): RecipeStatus | undefined {
  const s = r.recipe_status;
  if (s === undefined) return undefined;
  return (STATUSES as readonly (string | null)[]).includes(s) ? (s as RecipeStatus) : 'none';
}

/** The "Рецепт" filter shows only when the catalogue carries a status. */
export const recipeKnown = (rows: readonly RecipeFields[]): boolean => rows.some((r) => r.recipe_status !== undefined);

export function matchesRecipe(r: RecipeFields, f: RecipeFilter | undefined): boolean {
  if (!f || f === 'all') return true;
  const s = recipeStatusOf(r);
  if (s === undefined) return true;
  // a product with no goods (delivery, ПОЕН, flyers) needs no recipe: never in "без рецепт"
  if (f === 'approved') return s === 'approved' || s === 'exempt';
  return s === f;
}

export function recipeCounts(rows: readonly RecipeFields[]): Record<RecipeFilter, number> {
  const out = { all: 0, approved: 0, proposed: 0, none: 0 } as Record<RecipeFilter, number>;
  for (const r of rows) {
    out.all++;
    for (const f of RECIPE_FILTERS) if (f !== 'all' && matchesRecipe(r, f)) out[f]++;
  }
  return out;
}

/**
 * "Набавна (Сигма)" of a catalogue row in денари: the api's cost_mkd (the current complete Sigma cost;
 * an exempt product 0); null = no cost — also when the api sends none (never the EUR mirror).
 */
export function sigmaCostMkd(r: RecipeFields): number | null {
  if (r.cost_mkd === undefined || r.cost_mkd === null) return null;
  const n = Number(r.cost_mkd);
  return Number.isFinite(n) ? n : null;
}

// ── the drawer's draft ────────────────────────────────────────────────────────────────────────────

export type RecipeRole = ProductRecipeLine['role'];
export const RECIPE_ROLES: readonly RecipeRole[] = ['main', 'component', 'gift'];

export interface DraftLine { code: string; name: string; qty: number; role: RecipeRole; cost_mkd: number | null }

/** The lines an owner edits: the approved recipe when there is one, else the proposal (never rejected lines). */
export function draftFrom(recipe: Pick<ProductRecipe, 'lines'> | null | undefined): DraftLine[] {
  const lines = recipe?.lines ?? [];
  const approved = lines.filter((l) => l.status === 'approved');
  const pick = approved.length ? approved : lines.filter((l) => l.status === 'proposed');
  return pick.map((l) => ({ code: l.code, name: l.name, qty: Number(l.qty), role: l.role, cost_mkd: l.cost_mkd ?? null }));
}

/** Does the recipe hold a proposal an owner can approve as it is? */
export const hasProposal = (recipe: Pick<ProductRecipe, 'lines'> | null | undefined): boolean =>
  (recipe?.lines ?? []).some((l) => l.status === 'proposed');

/** Σ qty × unit cost; complete = every line costed (an empty draft is not complete). */
export function draftCost(lines: readonly DraftLine[]): { total: number | null; complete: boolean } {
  if (!lines.length) return { total: null, complete: false };
  let total = 0;
  let complete = true;
  for (const l of lines) {
    if (l.cost_mkd == null) complete = false;
    else total += l.cost_mkd * l.qty;
  }
  return { total: Math.round(total * 100) / 100, complete };
}

/** An i18n key under productsRecipe.drawer.err, or null when the draft can be saved. */
export function validateDraft(lines: readonly DraftLine[]): 'empty' | 'qty' | 'duplicate' | null {
  if (!lines.length) return 'empty';
  if (lines.some((l) => !(l.qty > 0 && l.qty <= 100))) return 'qty';
  if (new Set(lines.map((l) => l.code)).size !== lines.length) return 'duplicate';
  return null;
}

/** POST /products/articles. */
export const draftBody = (productId: string, lines: readonly DraftLine[], approve: boolean) => ({
  product_id: productId,
  lines: lines.map((l) => ({ code: l.code, qty: l.qty, role: l.role })),
  approve,
});

const sig = (lines: readonly DraftLine[]) =>
  [...lines].map((l) => `${l.code}|${l.qty}|${l.role}`).sort().join(';');
export const draftChanged = (a: readonly DraftLine[], b: readonly DraftLine[]): boolean => sig(a) !== sig(b);

/** A quantity typed in the drawer ("1", "0,5") → a number, or NaN. */
export const parseQty = (s: string): number => (/^\d+([.,]\d{1,3})?$/.test(s.trim()) ? Number(s.trim().replace(',', '.')) : NaN);
