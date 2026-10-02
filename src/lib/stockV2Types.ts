// Stock v2 — the JSON contract between supabase/functions/api (stockV2.ts) and the /warehouse UI.
// Source of truth: docs/STOCK-V2.md. Change the doc first, then this file, then both sides.
// Money keys (cost_mkd, value_mkd, cod_mkd, value_diff_mkd) are present ONLY for business owners —
// the api strips them for everyone else; the UI must treat them as optional.

export type StockWarehouseCode = string; // 'main' | 'wh08' | 'damaged' | 'writeoff' | 'lab' | …

export type StockMoveKind =
  | 'opening' | 'count_adjust' | 'parcel_out' | 'return_in' | 'unpack_in'
  | 'transfer_out' | 'transfer_in' | 'receipt' | 'production_in' | 'production_use'
  | 'b2b_out' | 'b2b_return_in' | 'export_out' | 'shop_out' | 'shop_return_in'
  | 'writeoff' | 'damaged_in' | 'adjust';

export type StockMoveSource = 'mex' | 'count' | 'sigma' | 'manual' | 'override';

export type ParcelStatusGroup = 'delivered' | 'returned' | 'with_courier' | 'problem' | 'to_pack';

export type ParcelStockState =
  | 'moved' | 'partial' | 'unmapped' | 'no_lines' | 'no_route'
  | 'test_phone' | 'excluded' | 'pre_opening' | 'waiting_lines';

export interface StockWarehouseRef { code: StockWarehouseCode; name: string; role: string; tracked: boolean; }

export interface StockFreshness {
  last_run_at: string | null;      // last ok stock_v2_apply
  last_mex_at: string | null;      // newest mex_parcels.last_seen_at
  last_sigma_at: string | null;    // newest stock_sigma_batches.received_at
}

/** One article on one day — every number is in units (numeric, may be fractional for КГ). */
export interface StockDayArticle {
  code: string;
  name: string;
  unit: string;
  opening: number;          // balance at the day start (incl. an `opening` count at exactly the start)
  out: number;              // parcel_out (positive number = units that left)
  back: number;             // return_in + unpack_in
  in: number;               // receipt + transfer_in + production_in + b2b_return_in + shop_return_in
  other_out: number;        // shop_out + export_out + b2b_out + transfer_out + writeoff + production_use
  adjust: number;           // count_adjust + adjust (signed)
  closing: number;          // balance at the end of the day (or at `at`)
  to_pack: number;          // in parcels created, not yet picked up (MEX 8)
  with_courier: number;     // in parcels picked up, not delivered/returned
  reserved: number;         // confirmed orders / collabBox bookings with no parcel yet (today only, else 0)
  available: number;        // closing − reserved (closing already excludes to_pack: a parcel is deducted at its MEX label)
  avg_out_14d: number;      // average daily units out over the 14 days before `day`
  days_cover: number | null;// closing / avg_out_14d
  negative: boolean;
  cost_mkd?: number | null; // owners only
  value_mkd?: number | null;// owners only: closing × cost
}

export interface StockDayTotals {
  articles: number;
  opening: number; out: number; back: number; in: number; other_out: number; adjust: number; closing: number;
  to_pack: number; with_courier: number; reserved: number; available: number;
  negatives: number;
  value_mkd?: number | null; // owners only
}

export interface StockDay {
  day: string;                       // YYYY-MM-DD (Skopje)
  at: string | null;                 // ISO when a time-of-day was asked
  warehouse: StockWarehouseRef;
  preview: boolean;                  // true = computed from stock_v2_desired(), nothing written
  enabled: boolean;                  // stock_v2.enabled
  opening: { count_id: string; counted_at: string; source: string; status: string } | null;
  totals: StockDayTotals;
  articles: StockDayArticle[];
  freshness: StockFreshness;
}

export interface StockArticleSeriesPoint { day: string; opening: number; out: number; back: number; in: number; other_out: number; adjust: number; closing: number; }
export interface StockArticleSeries {
  article: { code: string; name: string; unit: string; cost_mkd?: number | null };
  warehouse: StockWarehouseRef;
  preview: boolean;
  series: StockArticleSeriesPoint[];
  moves: StockMovementRow[];         // newest first, capped at 200
}

export interface StockParcelRow {
  tracking_id: string;
  account: 'natura' | 'bio_natural' | string;
  series: string | null;
  department: string | null;         // cohort key (altercpa, elyon_crm, teleshop_out, teleshop_other, social, web, management)
  status_id: number | null;
  status_group: ParcelStatusGroup | null;
  created_at_mex: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  returned_at: string | null;
  city: string | null;               // receiver city (no name, no phone)
  zone: string | null;               // MEX zone
  units: number;
  gift_units: number;
  lines_source: 'override' | 'collabbox' | 'web' | 'crm' | null;
  state: ParcelStockState;
  cod_mkd?: number | null;           // owners only
}

export interface StockCount { key: string; parcels: number; units: number; }

export interface StockParcelsDay {
  day: string;
  warehouse: StockWarehouseRef | null;
  totals: { parcels: number; units: number; gift_units: number; returned_units: number };
  hourly: { hour: number; created: number; picked_up: number }[];
  by_account: StockCount[];
  by_department: StockCount[];
  by_status: StockCount[];          // key = ParcelStatusGroup
  by_city: (StockCount & { zone: string | null })[];
  rows: StockParcelRow[];
  total_rows: number;
}

export interface StockMovementRow {
  id: number;
  event_at: string;
  recorded_at: string;
  late_days: number;                 // recorded_at − event_at in whole days (0 = same day)
  warehouse_code: StockWarehouseCode;
  article_code: string;
  article_name: string;
  qty: number;                       // signed
  kind: StockMoveKind;
  source: StockMoveSource;
  source_key: string;
  tracking_id: string | null;
  sigma_doc: string | null;
  sigma_versions: number | null;     // >1 = the Sigma document was re-dated / edited
  count_id: string | null;
  manual_id: string | null;
  correction: boolean;
  provisional: boolean;
  balance_after?: number | null;     // only when one article AND one warehouse are filtered
}

export interface StockMovementsPage { rows: StockMovementRow[]; total: number; }

export interface StockUnmappedRow { source: string; code: string | null; name: string; units: number; parcels: number; }

export interface StockHealth {
  enabled: boolean;
  preview_available: boolean;
  /** The ACTIVE warehouses (sort order) — every stock role gets them; the pickers offer the tracked ones.
   *  Added by the api (not stock_v2_health); an api older than 02.10.2026 sends none. */
  warehouses: StockWarehouseRef[];
  openings: { warehouse: StockWarehouseCode; count_id: string; counted_at: string; status: string; source: string }[];
  last_run: { at: string; status: string; trigger: string; stats: Record<string, unknown> } | null;
  pending: { groups: number; units: number };
  queues: {
    unmapped: StockUnmappedRow[];
    no_lines: number; no_route: number; test_phone: number;
    stale_labels: number; possible_relabels: number; waiting_lines: number;
  };
  negatives: { warehouse: StockWarehouseCode; code: string; name: string; qty: number }[];
  uncosted_articles: number;
  recipes: { products_active: number; with_approved_recipe: number; proposed: number };
  sigma: { last_batch_at: string | null; connector_last_seen: string | null; docs_staged: number; docs_excluded: number; docs_versions_gt1: number };
}

export interface StockCountLineInput { code: string; qty: number; }
export interface StockCountRequest {
  warehouse: StockWarehouseCode;
  counted_at: string;                // ISO with offset; may be in the past (owners for before the last count)
  kind: 'opening' | 'full' | 'partial';
  lines: StockCountLineInput[];
  packed_counted?: boolean;
  source?: 'manual' | 'sigma_variant' | 'xlsx';
  source_ref?: string;
  note?: string;
  dry: boolean;
}
export interface StockCountPreviewLine { code: string; name: string; system_qty: number; counted_qty: number; diff: number; value_diff_mkd?: number | null; }
export interface StockCountResult {
  dry: boolean;
  count_id?: string;
  status?: 'pending' | 'approved';
  /**
   * CODES, translated by the UI as stock2.count.warn.<code> ("<code>:<n>" fills {{n}}):
   * parcels_near_count:N (parcels created within ±2 h of the count time) · no_opening · old_count
   * (> 30 days back) · pending_owner_approval · not_counted:N (a full count left N articles out).
   * Anything else is free text, shown as sent. A REFUSED count answers HTTP 4xx with
   * `error` = before_last_count · opening_exists · opening_not_first · unknown_article:<codes> ·
   * kom_fraction:<codes> (a piece article with a fractional quantity) — the same vocabulary.
   */
  warnings: string[];
  lines: StockCountPreviewLine[];
  totals: { lines: number; system_qty: number; counted_qty: number; diff: number; value_diff_mkd?: number | null };
}

/** GET stock/v2/counts?warehouse&limit → StockCountHistoryRow[] (newest first; stock_v2_counts, …0510). */
export interface StockCountHistoryRow {
  id: string;
  warehouse: StockWarehouseCode;
  counted_at: string;
  kind: 'opening' | 'full' | 'partial';
  source: string;
  status: 'pending' | 'approved' | 'void';
  packed_counted: boolean;
  lines: number;
  diff_units: number | null;         // Σ(counted − what the system showed when the count was saved)
  value_diff_mkd?: number | null;    // owners only: that difference × each article's cost at the count time
  note: string | null;
  created_by_name: string | null;
  created_at: string;
  approved_by_name: string | null;
  approved_at: string | null;
  void_reason: string | null;
}

export interface StockManualMoveRequest {
  kind: 'receipt' | 'transfer' | 'adjust' | 'writeoff' | 'damaged' | 'unpack';
  from?: StockWarehouseCode | null;
  to?: StockWarehouseCode | null;
  event_at: string;
  doc_ref?: string;
  note?: string;
  lines: StockCountLineInput[];
  dry: boolean;
}

export interface StockArticleRow { code: string; name: string; unit: string; brand: string | null; active: boolean; on_hand: number | null; cost_mkd?: number | null; }

export interface ProductRecipeLine { code: string; name: string; qty: number; role: 'main' | 'component' | 'gift'; status: 'proposed' | 'approved' | 'rejected'; confidence: string | null; cost_mkd?: number | null; }
export interface ProductRecipe { product_id: string; product_name: string; exempt: boolean; lines: ProductRecipeLine[]; cost_mkd?: number | null; complete: boolean; }

export interface StockConfig {
  settings: Record<string, unknown>;
  warehouses: (StockWarehouseRef & { id: number; sellable: boolean; active: boolean; sigma_moves_from: string | null; keys: { system: string; key: string }[] })[];
  routes: { id: number; priority: number; match_account: string | null; match_series: string | null; match_shape: string | null; warehouse: StockWarehouseCode; return_warehouse: StockWarehouseCode | null; valid_from: string; valid_to: string | null; active: boolean }[];
  sigma_rules: { id: number; match: Record<string, unknown>; action: 'exclude' | 'include'; reason: string; active: boolean }[];
}

// ── Sigma ingest batch (CSV export and the office connector send the same shape) ──
export interface SigmaDocLine { item_code: string; qty: number; side: 'in' | 'out'; }
export interface SigmaDoc {
  doc_key: string;                   // '<WYear>|<DocType>|<DocNo>'
  wyear: string; doc_type: string; doc_no: string;
  doc_date: string;                  // YYYY-MM-DD
  posted_at: string | null; created_at_sigma: string | null;
  created_by: string | null; last_change_by: string | null;   // Sigma login names
  status: string | null;
  company_from: string | null; object_from: string | null;
  company_to: string | null; object_to: string | null;
  client_code: string | null; client_name: string | null;     // companies only, never a person
  lines: SigmaDocLine[];
}
export interface SigmaItem { code: string; name: string; unit: string; sigma_class: string | null; brand: string | null; active: boolean; }
export interface SigmaBalance { company: string; object: string; item_code: string; wyear: string; qty: number; calc_buy_price: number | null; }
export interface SigmaBatch {
  batch_id: string;
  source: 'csv' | 'connector';
  mode: 'delta' | 'snapshot' | 'items' | 'balances';
  exported_at: string;
  window?: { from: string; to: string };
  docs?: SigmaDoc[];
  drafts?: SigmaDoc[];
  items?: SigmaItem[];
  balances?: SigmaBalance[];
  balances_taken_at?: string;
}
