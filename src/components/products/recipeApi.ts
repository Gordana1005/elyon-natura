/**
 * The recipe routes of the Stock v2 contract (docs/STOCK-V2.md "HTTP API"; implemented by the api
 * workstream in supabase/functions/api/stockV2.ts). Owners only — they carry purchase costs.
 * The /warehouse client (src/lib/stockV2Api.ts) has twins of these; this file keeps /products
 * independent of it.
 */
import { apiFetch } from '@/lib/api';
import type { ProductRecipe, StockArticleRow } from '@/lib/stockV2Types';
import type { RecipeRole } from './recipe';

/** GET products/:id/articles → the product's recipe (every line with its status and unit cost). */
export const apiProductRecipe = (productId: string, signal?: AbortSignal): Promise<ProductRecipe> =>
  apiFetch<ProductRecipe>(`products/${encodeURIComponent(productId)}/articles`, { signal });

/** POST products/articles — save the lines as a proposal, or (approve) as the approved recipe. Answers with
 *  the writer's result (product_articles_set), not the recipe — read it back with apiProductRecipe. */
export const apiProductRecipeSet = (body: {
  product_id: string;
  lines: { code: string; qty: number; role: RecipeRole }[];
  approve: boolean;
}): Promise<Record<string, unknown>> => apiFetch<Record<string, unknown>>('products/articles', { method: 'POST', body: JSON.stringify(body) });

/** POST products/articles/approve — approve the products' proposals as they are. */
export const apiProductRecipeApprove = (productIds: string[]): Promise<{ ok: boolean }> =>
  apiFetch<{ ok: boolean }>('products/articles/approve', { method: 'POST', body: JSON.stringify({ product_ids: productIds }) });

/** GET stock/v2/articles?q — the Sigma articles (code, name, unit; cost for owners). */
export const apiStockArticlesSearch = (q: string, signal?: AbortSignal): Promise<StockArticleRow[]> =>
  apiFetch<StockArticleRow[]>(`stock/v2/articles?q=${encodeURIComponent(q.trim())}`, { signal });
