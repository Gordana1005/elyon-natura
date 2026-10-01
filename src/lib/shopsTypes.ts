// Shops (Продавници) — the JSON contract between supabase/functions/api (shops routes) and the /shops page.
// Source of truth: docs/SHOPS.md. The 22 shops belong to НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ and run on collabBox;
// Natura DOO (Sigma Ф00001-04) sells them goods. Every amount is in денари (MKD).
// Money keys (*_mkd) are present ONLY for business owners — managers get the same payload without them.

export interface ShopRef {
  code: string;                 // collabBox warehouse code, e.g. '003'
  name: string;                 // 'Карпош'
  city: string;                 // 'Скопје'
  sigma_object: string | null;  // Sigma delivery object of client 000001, e.g. '17'
  active: boolean;
}

export interface ShopsFreshness {
  last_sales_at: string | null;          // newest receipt line read (10022)
  last_docs_at: string | null;           // newest goods/transfer/count doc read
  last_stock_snapshot_at: string | null; // newest nightly infollc snapshot
  reader_last_run_at: string | null;
}

export interface ShopMoney {
  sales_mkd?: number;           // receipts incl. VAT, net of retail returns
  sales_ex_vat_mkd?: number;
  cash_mkd?: number;
  card_mkd?: number;
  avg_receipt_mkd?: number;
  cost_mkd?: number;            // the shop's purchase cost (= Natura's invoice price, ex VAT)
  shop_margin_mkd?: number;     // sales_ex_vat − cost
  group_cost_mkd?: number;      // Natura's own cost (Sigma CalcBuyPrice) of the units sold
  group_margin_mkd?: number;    // sales_ex_vat − group_cost
  returns_mkd?: number;
}

export interface ShopDayRow extends ShopMoney {
  shop: ShopRef;
  receipts: number;
  units: number;
  returns_units: number;
  first_receipt_at: string | null;
  last_receipt_at: string | null;
  vs_avg_pct: number | null;    // vs the same weekday's 4-week average (money for owners, units otherwise)
  control_ok: boolean | null;   // receipt lines total == daily report (10018 / tkreport); null = not checked yet
}

export interface ShopsTotals extends ShopMoney { shops_open: number; receipts: number; units: number; returns_units: number; }

export interface ShopsDay {
  day: string;                  // YYYY-MM-DD Skopje
  live: boolean;                // day == today
  shops: ShopDayRow[];
  totals: ShopsTotals;
  hourly: { hour: number; receipts: number; units: number; sales_mkd?: number }[];
  freshness: ShopsFreshness;
}

export interface ShopsPeriod {
  from: string; to: string;
  shops: ShopDayRow[];          // aggregated over the period (vs_avg_pct = vs the previous equal period)
  totals: ShopsTotals;
  daily: ({ day: string; receipts: number; units: number } & ShopMoney)[];
  natura: {                     // what Natura DOO invoiced the shops (Sigma) in the same period
    units_delivered: number; units_returned: number;
    invoiced_ex_vat_mkd?: number; natura_cost_mkd?: number; natura_margin_mkd?: number;
    ads_reinvoiced_ex_vat_mkd?: number;   // TV re-invoicing to Stores, shown apart
  };
  freshness: ShopsFreshness;
}

export interface ShopStockRow {
  code: string; name: string; brand: string | null;
  qty: number; reserved: number; available: number;
  sold_30d: number; days_cover: number | null; last_sold_at: string | null;
  zero_top_seller: boolean;     // 0 in this shop but among the chain's top sellers
  avg_cost_mkd?: number | null; retail_price_mkd?: number | null;
  value_cost_mkd?: number | null; value_retail_mkd?: number | null;
}

export interface ShopDocRow {
  at: string;                   // document time
  type: string;                 // collabBox type id, e.g. '10014'
  type_name: string;
  doc: string;                  // collabBox document number
  natura_doc: string | null;    // Natura's (Sigma) invoice number when known
  units: number;                // signed: + into the shop, − out of it
  value_mkd?: number | null;
}

export interface ShopDetail {
  shop: ShopRef;
  from: string; to: string;
  summary: ShopDayRow;          // the period aggregate
  sales_by_article: ({ code: string; name: string; units: number } & Pick<ShopMoney, 'sales_mkd' | 'shop_margin_mkd' | 'group_margin_mkd'>)[];
  stock_at: string;             // ISO moment the stock is computed for
  stock_basis: string;          // e.g. 'snapshot 01.10 23:30 + 14 movements'
  stock: ShopStockRow[];
  stock_totals: { articles: number; units: number; value_cost_mkd?: number; value_retail_mkd?: number };
  goods_in: ShopDocRow[];       // 10014 + (central) / deliveries
  goods_out: ShopDocRow[];      // 10014 −, transfers out, returns
  counts: ShopDocRow[];         // 10011 / 10005
  freshness: ShopsFreshness;
}

export interface ShopsStockMatrix {
  at: string;
  shops: ShopRef[];
  articles: { code: string; name: string; brand: string | null; total: number; sold_30d_total: number; by_shop: Record<string, number> }[];
}

export interface ShopsDeliveryRow {
  day: string;                  // Sigma invoice date
  shop: ShopRef;
  sigma_doc: string;            // e.g. '04-01101'
  units: number;
  value_ex_vat_mkd?: number;
  received_doc: string | null;  // collabBox 10042 number in 001 Централен
  received_at: string | null;
  in_transit: boolean;          // invoiced, not yet received in collabBox
  lag_days: number | null;
}
export interface ShopsDeliveries { from: string; to: string; rows: ShopsDeliveryRow[]; totals: { invoices: number; units: number; in_transit: number; value_ex_vat_mkd?: number }; }

export interface ShopsAnomaly {
  kind: 'no_receipts_by_11' | 'cost_above_sales' | 'big_transfer' | 'big_return' | 'zero_top_seller' | 'delivery_not_received' | 'control_mismatch';
  shop: ShopRef | null;
  day: string;
  detail: string;
  value_mkd?: number | null;
}

export interface ShopsHealth {
  reader: { enabled: boolean; last_run_at: string | null; last_status: string | null; runs_24h: number; errors_24h: number };
  backfill: { sales_from: string | null; sales_done_until: string | null; stock_history_months: number };
  controls: { days_checked: number; mismatches: number };
  anomalies: ShopsAnomaly[];
  freshness: ShopsFreshness;
}
