// Fixtures typed with the shared contract (src/lib/stockV2Types.ts) — the same JSON the api sends.
// `owner*` variants carry the money keys; the plain ones do not (the api strips them).
import type {
  StockArticleSeries, StockCountResult, StockDay, StockDayArticle, StockHealth, StockMovementRow, StockMovementsPage,
  StockParcelRow, StockParcelsDay,
} from '@/lib/stockV2Types';

const MAIN = { code: 'main', name: 'Главен магацин Скопје', role: 'main', tracked: true };

function article(over: Partial<StockDayArticle> & Pick<StockDayArticle, 'code' | 'name'>): StockDayArticle {
  return {
    unit: 'КОМ', opening: 100, out: 10, back: 1, in: 0, other_out: 0, adjust: 0, closing: 91,
    to_pack: 3, with_courier: 5, reserved: 0, available: 88, avg_out_14d: 9, days_cover: 10.1, negative: false,
    ...over,
  };
}

export const ARTICLES: StockDayArticle[] = [
  article({ code: '100123', name: 'Adenofrin капсули', opening: 1200, out: 40, back: 2, closing: 1162, to_pack: 6, with_courier: 20, available: 1156, days_cover: 29 }),
  article({ code: '100456', name: 'Neurofix гел', opening: 5, out: 9, back: 0, closing: -4, to_pack: 1, with_courier: 3, available: -5, negative: true, days_cover: 0 }),
  article({ code: 'L00007', name: 'Чаен микс', unit: 'КГ', opening: 12.5, out: 0.25, back: 0, closing: 12.25, to_pack: 0, with_courier: 0, available: 12.25, days_cover: null }),
];

export function stockDay(over: Partial<StockDay> = {}): StockDay {
  return {
    day: '2026-09-30', at: null, warehouse: MAIN, preview: true, enabled: false,
    opening: { count_id: 'c-1', counted_at: '2026-09-21T22:00:00Z', source: 'sigma_variant', status: 'approved' },
    totals: {
      articles: 3, opening: 1217.5, out: 49.25, back: 2, in: 0, other_out: 0, adjust: 0, closing: 1170.25,
      to_pack: 7, with_courier: 23, reserved: 0, available: 1163.25, negatives: 1,
    },
    articles: ARTICLES,
    freshness: { last_run_at: null, last_mex_at: new Date(Date.now() - 4 * 60_000).toISOString(), last_sigma_at: null },
    ...over,
  };
}

export function ownerStockDay(over: Partial<StockDay> = {}): StockDay {
  const d = stockDay(over);
  return {
    ...d,
    totals: { ...d.totals, value_mkd: 123456 },
    articles: d.articles.map((a, i) => ({ ...a, cost_mkd: 100 + i, value_mkd: (100 + i) * a.closing })),
  };
}

export const SERIES: StockArticleSeries = {
  article: { code: '100123', name: 'Adenofrin капсули', unit: 'КОМ' },
  warehouse: MAIN, preview: true,
  series: [
    { day: '2026-09-29', opening: 1240, out: 40, back: 2, in: 0, other_out: 0, adjust: 0, closing: 1202 },
    { day: '2026-09-30', opening: 1202, out: 40, back: 0, in: 0, other_out: 0, adjust: 0, closing: 1162 },
  ],
  moves: [],
};

export function move(over: Partial<StockMovementRow> & Pick<StockMovementRow, 'id'>): StockMovementRow {
  return {
    event_at: '2026-09-30T08:15:00Z', recorded_at: '2026-09-30T08:20:00Z', late_days: 0, warehouse_code: 'main',
    article_code: '100123', article_name: 'Adenofrin капсули', qty: -2, kind: 'parcel_out', source: 'mex',
    source_key: 'mex:9110123456:out', tracking_id: '9110123456', sigma_doc: null, sigma_versions: null,
    count_id: null, manual_id: null, correction: false, provisional: false,
    ...over,
  };
}

export const MOVES: StockMovementsPage = {
  total: 3,
  rows: [
    move({ id: 1 }),
    move({
      id: 2, kind: 'receipt', source: 'sigma', qty: 240, tracking_id: null, sigma_doc: '2026|ПРИ|77', sigma_versions: 2,
      late_days: 3, source_key: 'sigma:2026|ПРИ|77', recorded_at: '2026-10-03T09:00:00Z',
    }),
    move({ id: 3, kind: 'return_in', qty: 1, correction: true, provisional: true, source_key: 'mex:9110999:ret', tracking_id: '9110999' }),
  ],
};

export function parcel(over: Partial<StockParcelRow> & Pick<StockParcelRow, 'tracking_id'>): StockParcelRow {
  return {
    account: 'bio_natural', series: '9110', department: 'altercpa', status_id: 2, status_group: 'delivered',
    created_at_mex: '2026-09-30T07:05:00Z', picked_up_at: '2026-09-30T13:40:00Z', delivered_at: '2026-10-01T09:00:00Z',
    returned_at: null, city: 'Скопје', zone: 'Skopje - Aerodrom', units: 3, gift_units: 1, lines_source: 'collabbox', state: 'moved',
    ...over,
  };
}

export function parcelsDay(over: Partial<StockParcelsDay> = {}): StockParcelsDay {
  return {
    day: '2026-09-30', warehouse: null,
    totals: { parcels: 2, units: 5, gift_units: 1, returned_units: 2 },
    hourly: [{ hour: 7, created: 2, picked_up: 0 }, { hour: 13, created: 0, picked_up: 2 }],
    by_account: [{ key: 'bio_natural', parcels: 1, units: 3 }, { key: 'natura', parcels: 1, units: 2 }],
    by_department: [{ key: 'altercpa', parcels: 1, units: 3 }, { key: 'teleshop_out', parcels: 1, units: 2 }],
    by_status: [{ key: 'delivered', parcels: 1, units: 3 }, { key: 'returned', parcels: 1, units: 2 }],
    by_city: [{ key: 'Скопје', zone: 'Skopje - Aerodrom', parcels: 1, units: 3 }, { key: 'Битола', zone: 'Bitola', parcels: 1, units: 2 }],
    rows: [
      parcel({ tracking_id: '9110123456' }),
      parcel({
        tracking_id: '9102654321', account: 'natura', series: '9102', department: 'teleshop_out', status_id: 7, status_group: 'returned',
        delivered_at: null, returned_at: '2026-10-01T10:00:00Z', city: 'Битола', zone: 'Bitola', units: 2, gift_units: 0, state: 'unmapped',
      }),
    ],
    total_rows: 2,
    ...over,
  };
}

export function ownerParcelsDay(): StockParcelsDay {
  const d = parcelsDay();
  return { ...d, rows: d.rows.map((r, i) => ({ ...r, cod_mkd: i === 0 ? 2490 : 1990 })) };
}

export function health(over: Partial<StockHealth> = {}): StockHealth {
  return {
    enabled: false, preview_available: true,
    openings: [{ warehouse: 'main', count_id: 'c-1', counted_at: '2026-09-21T22:00:00Z', status: 'approved', source: 'sigma_variant' }],
    last_run: { at: new Date(Date.now() - 6 * 60_000).toISOString(), status: 'ok', trigger: 'cron', stats: {} },
    pending: { groups: 1520, units: 8400 },
    queues: {
      unmapped: [{ source: 'collabbox_name', code: null, name: 'Подарок кеса', units: 40, parcels: 38 }],
      no_lines: 12, no_route: 0, test_phone: 3, stale_labels: 5, possible_relabels: 1, waiting_lines: 7,
    },
    negatives: [{ warehouse: 'main', code: '100456', name: 'Neurofix гел', qty: -4 }],
    uncosted_articles: 9,
    recipes: { products_active: 88, with_approved_recipe: 60, proposed: 20 },
    sigma: { last_batch_at: null, connector_last_seen: null, docs_staged: 140, docs_excluded: 30, docs_versions_gt1: 2 },
    ...over,
  };
}

export function countResult(over: Partial<StockCountResult> = {}): StockCountResult {
  return {
    dry: true, warnings: ['parcels_near_count:3'],
    lines: [
      { code: '100123', name: 'Adenofrin капсули', system_qty: 1162, counted_qty: 1150, diff: -12 },
      { code: '100456', name: 'Neurofix гел', system_qty: -4, counted_qty: 0, diff: 4 },
    ],
    totals: { lines: 2, system_qty: 1158, counted_qty: 1150, diff: -8 },
    ...over,
  };
}
