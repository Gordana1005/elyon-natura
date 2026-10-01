/**
 * Stock v2 — the /warehouse client for every route of docs/STOCK-V2.md ("HTTP API"), typed with
 * the shared contract src/lib/stockV2Types.ts. Same base URL and auth as every other call
 * (apiFetch). Money keys (cost_mkd, value_mkd, cod_mkd, value_diff_mkd) arrive only for business
 * owners — the api strips them for everyone else, so the UI renders a money column only when the
 * key is present.
 *
 * Access (the api decides; the UI only hides what would be refused):
 *   quantities  owners · admin · manager · warehouse
 *   money       owners
 *   counts      owners · admin · warehouse (a non-owner's count is saved `pending`)
 *   config / switch / run / overrides / costs   owners
 */
import { apiFetch } from '@/lib/api';
import type {
  ProductRecipe, StockArticleRow, StockArticleSeries, StockConfig, StockCountHistoryRow, StockCountRequest, StockCountResult,
  StockDay, StockHealth, StockManualMoveRequest, StockMovementsPage, StockParcelsDay, StockWarehouseCode,
} from '@/lib/stockV2Types';

/** Builds `path?k=v…`, leaving out empty values (so the api's defaults apply). */
export function withQuery(path: string, q: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

// ── reads ────────────────────────────────────────────────────────────────────

export const apiStockV2Health = (detail = true): Promise<StockHealth> =>
  apiFetch(withQuery('stock/v2/health', { detail: detail ? undefined : 0 }));

export interface StockDayQuery { day: string; warehouse?: StockWarehouseCode; at?: string | null; preview?: boolean }
export const apiStockV2Day = (q: StockDayQuery): Promise<StockDay> =>
  apiFetch(withQuery('stock/v2/day', { day: q.day, warehouse: q.warehouse, at: q.at, preview: q.preview }));

export interface StockArticleQuery { code: string; warehouse?: StockWarehouseCode; from?: string; to?: string; preview?: boolean }
export const apiStockV2Article = (q: StockArticleQuery): Promise<StockArticleSeries> =>
  apiFetch(withQuery('stock/v2/article', { code: q.code, warehouse: q.warehouse, from: q.from, to: q.to, preview: q.preview }));

export interface StockParcelsQuery {
  day: string; warehouse?: StockWarehouseCode | null; account?: string | null; department?: string | null;
  status?: string | null; city?: string | null; state?: string | null; limit?: number; offset?: number;
}
export const apiStockV2Parcels = (q: StockParcelsQuery): Promise<StockParcelsDay> =>
  apiFetch(withQuery('stock/v2/parcels', {
    day: q.day, warehouse: q.warehouse, account: q.account, department: q.department, status: q.status,
    city: q.city, state: q.state, limit: q.limit, offset: q.offset,
  }));

export interface StockMovementsQuery {
  from?: string; to?: string; warehouse?: StockWarehouseCode | null; article?: string | null; kind?: string | null;
  source?: string | null; q?: string | null; corrections?: boolean; limit?: number; offset?: number;
}
export const apiStockV2Movements = (q: StockMovementsQuery): Promise<StockMovementsPage> =>
  apiFetch(withQuery('stock/v2/movements', {
    from: q.from, to: q.to, warehouse: q.warehouse, article: q.article, kind: q.kind, source: q.source, q: q.q,
    corrections: q.corrections ? 1 : undefined, limit: q.limit, offset: q.offset,
  }));

export const apiStockV2Articles = (q?: string): Promise<StockArticleRow[]> =>
  apiFetch(withQuery('stock/v2/articles', { q: q?.trim() || undefined }));

export const apiStockV2Config = (): Promise<StockConfig> => apiFetch('stock/v2/config');

export const apiStockV2SigmaStatus = (): Promise<Record<string, unknown>> => apiFetch('stock/v2/sigma/status');
export const apiStockV2SigmaMonthCheck = (month: string): Promise<Record<string, unknown>> =>
  apiFetch(withQuery('stock/v2/sigma/month-check', { month }));

export const apiProductRecipe = (productId: string): Promise<ProductRecipe> =>
  apiFetch(`products/${encodeURIComponent(productId)}/articles`);

/**
 * The count history of a warehouse: `GET stock/v2/counts?warehouse&limit` → StockCountHistoryRow[]
 * (newest first; stock_v2_counts, migration 20260945000510). While that reader is not applied the
 * api answers 503 and the Попис tab falls back to `StockHealth.openings`.
 */
export type { StockCountHistoryRow };
export const apiStockV2Counts = (warehouse?: StockWarehouseCode, limit = 50): Promise<StockCountHistoryRow[]> =>
  apiFetch(withQuery('stock/v2/counts', { warehouse, limit }));

// ── writes ───────────────────────────────────────────────────────────────────

export const apiStockV2Count = (body: StockCountRequest): Promise<StockCountResult> => post('stock/v2/count', body);
export const apiStockV2CountVoid = (id: string, reason: string): Promise<{ ok: boolean }> =>
  post(`stock/v2/count/${encodeURIComponent(id)}/void`, { reason });
export const apiStockV2CountApprove = (id: string): Promise<{ ok: boolean }> =>
  post(`stock/v2/count/${encodeURIComponent(id)}/approve`, {});

export const apiStockV2Move = (body: StockManualMoveRequest): Promise<{ ok: boolean; move_id?: string; preview?: unknown }> =>
  post('stock/v2/move', body);

export const apiStockV2ParcelOverride = (body: { tracking_id: string; action: string; payload?: unknown; note?: string }): Promise<{ ok: boolean }> =>
  post('stock/v2/parcel-override', body);

export const apiStockV2ConfigSet = (patch: Partial<StockConfig> | Record<string, unknown>): Promise<StockConfig> =>
  apiFetch('stock/v2/config', { method: 'PUT', body: JSON.stringify(patch) });

export const apiStockV2Switch = (enabled: boolean): Promise<{ ok?: boolean; enabled?: boolean }> =>
  post('stock/v2/switch', { enabled });

/** Run stats as the engine returns them (stock_v2_apply's jsonb). */
export type StockRunStats = Record<string, unknown>;
export const apiStockV2Run = (dry: boolean): Promise<StockRunStats> => post('stock/v2/run', { dry });

export const apiStockV2ArticleCost = (body: { code: string; cost_mkd: number; valid_from: string; note?: string }): Promise<{ ok: boolean }> =>
  post('stock/v2/article-cost', body);

export const apiProductArticlesSet = (body: { product_id: string; lines: { code: string; qty: number; role: string }[]; approve?: boolean }): Promise<ProductRecipe> =>
  post('products/articles', body);
export const apiProductArticlesApprove = (productIds: string[]): Promise<{ ok: boolean }> =>
  post('products/articles/approve', { product_ids: productIds });
