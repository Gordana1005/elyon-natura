/**
 * crm_snapshot — the READ-ONLY CRM inputs of docs/stock/build_sigma_stock.py (Stock v2, owner 01.10.2026).
 *
 *   node docs/stock/crm_snapshot.mjs [--out exports/stock/crm-inputs.json]
 *
 * Writes one JSON file (gitignored folder, never committed) with:
 *   products        every CRM product: id, name, sku, kind, brand_line, active, the Sigma VAT link
 *                   (vat_sigma_code / vat_source), the legacy cost_price (EUR) and its order lines
 *   cooc            collabBox goods lines that carry BOTH a product_id and a code: per (product, code)
 *                   lines / units / documents / last date — the strongest product → article evidence
 *   single_orders   orders with ONE order line whose parcel has a collabBox document (and no other
 *                   order on it): per (product, qty, goods-line pattern) the number of orders — the
 *                   evidence for bundles (what the warehouse really packed for "2+1 X")
 *   cb_codes        every collabBox line code by role since 2026-03-01 (names, newest first, only for goods
 *                   and marker lines — note / delivery lines are free text and may hold a phone number)
 *   web_items       naturatherapy.mk order lines by (shop product, variant, sku, kind)
 *   web_aliases     product_aliases source 'web' (web name → CRM product)
 *   parcels         MEX parcels created since 22.09 by account and lines source
 * No customer data: no name, phone, address or note text leaves the database.
 *
 * Safety: Macedonia only — scripts/lib/repair-kit.mjs mkGuard() (config.toml = oufoazmnbwugtfldkwsn,
 * nothing points at Bulgaria) + assertRemoteIsMk(); every statement is sent with read_only: true, so
 * Postgres itself refuses a write. The access token comes from .env (or the environment) and is never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mkGuard, assertRemoteIsMk, sqlRead, ROOT, die, ok } from '../../scripts/lib/repair-kit.mjs';

const OPENING = '2026-09-22T00:00:00+02:00';

const Q = {
  products: `
    SELECT p.id, p.name, p.sku, p.kind, p.brand_line, p.is_active, p.vat_sigma_code, p.vat_sigma_name, p.vat_source,
           p.cost_price, p.price,
           coalesce(s.lines_all, 0) AS lines_all, coalesce(s.lines_2026, 0) AS lines_2026,
           coalesce(s.units_2026, 0) AS units_2026, coalesce(s.units_since_2209, 0) AS units_since_2209,
           s.last_order_at
      FROM public.products p
      LEFT JOIN (
        SELECT oi.product_id,
               count(*)::int AS lines_all,
               count(*) FILTER (WHERE o.created_at >= '2026-01-01')::int AS lines_2026,
               coalesce(sum(oi.quantity) FILTER (WHERE o.created_at >= '2026-01-01'), 0)::int AS units_2026,
               coalesce(sum(oi.quantity) FILTER (WHERE o.created_at >= '${OPENING}'
                                                   AND o.status NOT IN ('cancelled', 'trashed', 'duplicated')), 0)::int AS units_since_2209,
               max(o.created_at) AS last_order_at
          FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
         GROUP BY oi.product_id) s ON s.product_id = p.id
     ORDER BY p.name`,

  cooc: `
    SELECT l->>'product_id' AS product_id, l->>'code' AS code,
           count(*)::int AS lines, sum((l->>'qty')::numeric) AS units, count(DISTINCT d.doc_number)::int AS docs,
           count(*) FILTER (WHERE coalesce((l->>'value_mkd')::numeric, 0) = 0)::int AS zero_value_lines,
           max(d.doc_at) AS last_at,
           (array_agg(l->>'name' ORDER BY d.doc_at DESC))[1:40] AS names
      FROM public.collabbox_documents d
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.payload->'lines', '[]'::jsonb)) l
     WHERE l->>'role' = 'goods' AND l->>'product_id' IS NOT NULL AND l->>'code' IS NOT NULL
     GROUP BY 1, 2`,

  single_orders: `
    WITH o1 AS (
      SELECT o.id, o.mex_tracking_id AS trk, min(oi.product_id::text) AS product_id, sum(oi.quantity)::int AS q
        FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id
       WHERE o.mex_tracking_id IS NOT NULL AND o.created_at >= '2025-10-01'
         AND o.status NOT IN ('cancelled', 'trashed', 'duplicated')
         AND NOT EXISTS (SELECT 1 FROM public.orders o2 WHERE o2.mex_tracking_id = o.mex_tracking_id AND o2.id <> o.id)
       GROUP BY o.id, o.mex_tracking_id
      HAVING count(*) = 1 AND min(oi.product_id::text) IS NOT NULL
    ), pat AS (
      SELECT o1.product_id, o1.q, o1.id,
             string_agg((l->>'code') || 'x' || ((l->>'qty')::numeric)::text
                        || CASE WHEN coalesce((l->>'value_mkd')::numeric, 0) = 0 THEN 'g' ELSE '' END,
                        ',' ORDER BY l->>'code', (l->>'qty')::numeric) AS pattern
        FROM o1
        JOIN public.collabbox_documents d ON d.doc_number = o1.trk AND NOT coalesce(d.is_storno, false)
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.payload->'lines', '[]'::jsonb)) l
       WHERE l->>'role' = 'goods' AND coalesce((l->>'qty')::numeric, 0) > 0
       GROUP BY 1, 2, 3
    )
    SELECT product_id, q, pattern, count(*)::int AS orders FROM pat GROUP BY 1, 2, 3`,

  cb_codes: `
    SELECT l->>'role' AS role, l->>'code' AS code,
           CASE WHEN l->>'role' IN ('goods', 'marker') THEN (array_agg(l->>'name' ORDER BY d.doc_at DESC))[1:60] END AS names,
           count(*)::int AS lines, coalesce(sum((l->>'qty')::numeric), 0) AS units,
           count(DISTINCT d.doc_number)::int AS docs,
           count(*) FILTER (WHERE d.doc_at >= '${OPENING}')::int AS lines_since_2209,
           coalesce(sum((l->>'qty')::numeric) FILTER (WHERE d.doc_at >= '${OPENING}'), 0) AS units_since_2209,
           count(DISTINCT d.doc_number) FILTER (WHERE d.doc_at >= '${OPENING}')::int AS docs_since_2209,
           count(*) FILTER (WHERE l->>'product_id' IS NOT NULL)::int AS with_product,
           count(*) FILTER (WHERE coalesce((l->>'value_mkd')::numeric, 0) = 0)::int AS zero_value_lines,
           min(d.doc_at) AS first_at, max(d.doc_at) AS last_at
      FROM public.collabbox_documents d
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.payload->'lines', '[]'::jsonb)) l
     WHERE d.doc_at >= '2026-03-01'
     GROUP BY 1, 2`,

  web_items: `
    SELECT i.product_id, i.variant_id, (array_agg(i.name ORDER BY o.created_at DESC))[1] AS name,
           (array_agg(i.variant_label ORDER BY o.created_at DESC))[1] AS variant_label, i.sku, i.kind,
           count(*)::int AS lines, coalesce(sum(i.quantity), 0)::int AS units,
           count(*) FILTER (WHERE o.created_at >= '${OPENING}')::int AS lines_since_2209,
           coalesce(sum(i.quantity) FILTER (WHERE o.created_at >= '${OPENING}'), 0)::int AS units_since_2209,
           max(o.created_at) AS last_at
      FROM public.web_order_items i JOIN public.web_orders o USING (shop_order_id)
     GROUP BY i.product_id, i.variant_id, i.sku, i.kind`,

  web_aliases: `
    SELECT a.alias_norm, a.product_id, a.kind, p.name AS product_name
      FROM public.product_aliases a LEFT JOIN public.products p ON p.id = a.product_id
     WHERE a.source = 'web'`,

  parcels: `
    SELECT p.account,
           count(*)::int AS parcels,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.collabbox_documents c WHERE c.doc_number = p.tracking_id))::int AS with_collabbox,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.web_orders w WHERE w.mex_tracking_id = p.tracking_id))::int AS with_web,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = p.tracking_id))::int AS with_order
      FROM public.mex_parcels p
     WHERE p.created_at_mex >= '${OPENING}'
     GROUP BY 1`,
};

async function main() {
  const i = process.argv.indexOf('--out');
  const out = resolve(i > 0 ? process.argv[i + 1] : join(ROOT, 'exports', 'stock', 'crm-inputs.json'));
  mkGuard();
  await assertRemoteIsMk();
  const data = { generated_at: new Date().toISOString(), opening: OPENING };
  for (const [key, query] of Object.entries(Q)) {
    data[key] = await sqlRead(query);
    ok(`${key}: ${data[key].length} rows`);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data));
  ok(`→ ${out}`);
}

main().catch((e) => die(e?.stack || String(e)));
