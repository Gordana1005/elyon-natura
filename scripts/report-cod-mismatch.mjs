#!/usr/bin/env node
/**
 * Report C — MEX COD ≠ CRM price (read-only; plan Phase 2, run after B and A).
 *
 * Paid/returned orders created since 2026-08-01 (Skopje) whose linked MEX parcel's COD is
 * neither round(price € × 61,5) ±3 ден nor that +150 ден delivery ±3 — e.g. an order resized
 * at AlterCPA (1 pack in the CRM, 3 collected). Proven cash already uses the parcel's COD
 * (mex_cod_mkd); this only lists the orders whose CRM value is wrong, for Mile's decision
 * (re-pricing from AlterCPA's own record is a separate, signed-off step). Nothing is written
 * to the database; the CSV goes to exports/repairs/ (PII, gitignored).
 *
 *   node scripts/report-cod-mismatch.mjs [--since 2026-08-01]
 *
 * 🛑 Macedonia only (repair-kit guards).
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, MKD_PER_EUR, DELIVERY_MKD, COD_TOLERANCE_MKD, bold, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, q, parseArgs, expectedCodMkd, codFit, isSyntheticProductName,
  fmtMkd, fmtSkopje, fileStamp, writeCsv, printTable, tally,
} from './lib/repair-kit.mjs';

/** AlterCPA's own order total in денари (their `price` is the total in `currency`). */
export function altercpaMkd(price, currency) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const cur = String(currency || 'mkd').toLowerCase();
  if (cur === 'mkd') return Math.round(p);
  if (cur === 'eur') return Math.round(p * MKD_PER_EUR);
  return null; // other currencies: no exact conversion — shown as blank
}

const fitsMkd = (expected, cod) => expected != null && (Math.abs(cod - expected) <= COD_TOLERANCE_MKD
  || Math.abs(cod - expected - DELIVERY_MKD) <= COD_TOLERANCE_MKD);

export function buildReport(rows) {
  const out = [];
  for (const r of rows) {
    const cod = Number(r.cod_mkd);
    if (!Number.isFinite(cod)) continue;
    if (codFit(r.price, cod)) continue;
    const crm = expectedCodMkd(r.price);
    const cpa = altercpaMkd(r.cpa_price, r.cpa_currency);
    const diff = cod - crm;
    const explained = !crm && isSyntheticProductName(r.product_name) ? 'disposition row holding a parcel (repair B)'
      : !crm ? 'CRM price is 0'
      : fitsMkd(cpa, cod) ? 'AlterCPA total fits the COD (resized there, CRM missed it)'
      : diff > 0 ? 'COD above the CRM price' : 'COD below the CRM price';
    out.push({
      order: r.display_id, status: r.status, source: r.source_type, created: fmtSkopje(r.created_at),
      customer: r.customer_name, phone: r.customer_phone, city: r.customer_city,
      product: r.product_name, qty: r.quantity, crm_mkd: crm, cod_mkd: cod, diff_mkd: diff,
      altercpa_mkd: cpa ?? '', altercpa_count: r.cpa_count ?? '', explained,
      tracking: r.mex_tracking_id, account: r.account, series: r.series, parcel_status: `${r.status_id} ${r.status_name || ''}`.trim(),
      delivered_at: fmtSkopje(r.delivered_at), returned_at: fmtSkopje(r.returned_at),
      order_cod_fact: r.mex_cod_mkd ?? '', paid_basis: r.paid_basis ?? '', confirmed_by: r.confirmed_by_name ?? '',
      register_disagrees: r.reg_order_id && r.reg_order_id !== r.id ? 'yes' : '',
    });
  }
  return out.sort((a, b) => Math.abs(b.diff_mkd) - Math.abs(a.diff_mkd));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['help'], values: ['since'] });
  if (args.help) { console.log('usage: node scripts/report-cod-mismatch.mjs [--since YYYY-MM-DD]'); return; }
  const since = args.since || '2026-08-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) die('--since must be YYYY-MM-DD');
  mkGuard();
  console.log(bold(`\nReport C — MEX COD vs CRM price, orders since ${since} (Skopje)  (${MK_REF}, read-only)\n`));
  await assertRemoteIsMk();
  const [s] = await sqlRead(`select to_regclass('public.mex_parcels') is not null as ok,
    (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'orders'
      and column_name in ('mex_cod_mkd', 'paid_basis')) as cols`);
  if (!s.ok || s.cols < 2) die('mex_parcels / orders.mex_cod_mkd / paid_basis missing — the Phase-1 migrations are not applied yet.');

  // Naked dates are UTC midnight (= 02:00 Skopje): anchor the cut-off in Skopje explicitly.
  const rows = await sqlRead(`
    select o.id, o.display_id, o.status::text as status, o.source_type, o.created_at, o.price, o.quantity, o.product_name,
           o.customer_name, o.customer_phone, o.customer_city, o.confirmed_by_name, o.paid_basis, o.mex_tracking_id, o.mex_cod_mkd,
           mp.account, mp.series, mp.status_id, mp.status_name, mp.cod_mkd, mp.delivered_at, mp.returned_at, mp.order_id as reg_order_id,
           l.payload->>'price' as cpa_price, l.payload->>'currency' as cpa_currency, l.payload->>'count' as cpa_count
      from public.orders o
      join public.mex_parcels mp on mp.tracking_id = o.mex_tracking_id
      left join lateral (select ll.payload from public.altercpa_leads ll where ll.order_id = o.id
                          order by ll.last_seen_at desc nulls last limit 1) l on true
     where o.status in ('paid', 'returned')
       and o.created_at >= (date ${q(since)})::timestamp at time zone 'Europe/Skopje'
       and mp.cod_mkd is not null`);
  const report = buildReport(rows);
  ok(`${rows.length} paid/returned orders with a linked parcel · ${report.length} COD mismatches`);

  const sum = (xs, f) => xs.reduce((n, x) => n + (Number(f(x)) || 0), 0);
  for (const status of ['paid', 'returned']) {
    const xs = report.filter((r) => r.status === status);
    if (!xs.length) continue;
    console.log(bold(`\n${status} — ${xs.length} orders · CRM ${fmtMkd(sum(xs, (r) => r.crm_mkd))} ден · MEX COD ${fmtMkd(sum(xs, (r) => r.cod_mkd))} ден · difference ${fmtMkd(sum(xs, (r) => r.diff_mkd))} ден`));
    printTable(Object.entries(tally(xs, (r) => r.explained || 'unexplained', (r) => r.diff_mkd))
      .map(([why, v]) => ({ why, orders: v.orders, 'Σ COD − CRM (ден)': fmtMkd(v.mkd) })));
    printTable(Object.entries(tally(xs, (r) => r.source, (r) => r.diff_mkd))
      .map(([source, v]) => ({ source, orders: v.orders, 'Σ COD − CRM (ден)': fmtMkd(v.mkd) })));
  }
  console.log(bold('\nLargest differences'));
  printTable(report.slice(0, 15).map((r) => ({ order: r.order, status: r.status, product: String(r.product || '').slice(0, 28), crm: r.crm_mkd, cod: r.cod_mkd, altercpa: r.altercpa_mkd, why: r.explained })));
  const path = writeCsv(`cod-mismatch-${fileStamp()}.csv`, report);
  ok(`CSV (contains PII — stays in exports/, never commit): ${path}`);
  console.log('Nothing was written. Re-pricing from AlterCPA needs Mile\'s sign-off first.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
