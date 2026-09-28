#!/usr/bin/env node
/**
 * One-off backfill — link the web shop's OpenCart-era NATURA "M…" parcels to their web orders
 * (migration 20260940000300, web_phone_link_candidates / web_link_mex_parcels_by_phone).
 *
 * The OC-… web orders (2022 → 18.08.2026) shipped under bare "M<digits>" waybills the shop
 * never recorded, so web_link_mex_parcels could not link them and every such sale counted
 * twice (the web order + a MEX-only parcel). The matcher links a parcel to a web order only
 * when ALL hold: same last-8 phone · parcel created 1 h before → 10 days after the order ·
 * COD = the shop total (±1 ден; or total + shipping) or COD 0 on an order the shop marks PAID
 * · exactly one candidate on BOTH sides (5-day pass, then a 10-day pass over the rest) · the
 * parcel held by no CRM order and claimed by no web order · the order has no link and no
 * waybill of its own. It writes web_orders only (mex_link_method 'phone_amount') — never
 * mex_parcels, never orders, never the shop.
 *
 * web-sync runs the same function after every sync (orders of the last 60 days) and after the
 * nightly sweep (every order), so this script only brings the first full pass forward.
 *
 *   node scripts/assert-mk-target.mjs                                  # the tripwire, first
 *   node scripts/backfill-web-parcel-links.mjs                         # dry run (read-only): what it would link + CSV
 *   node scripts/backfill-web-parcel-links.mjs --apply --expect 2751   # link; refuses if the candidates are not 2751 now
 *   --recent-days N   only web orders created in the last N days (default: all)
 *
 * Undo (all phone links; the next sync re-creates them unless the function is changed):
 *   update public.web_orders set mex_tracking_id = null, mex_link_method = null, mex_linked_at = null
 *    where mex_link_method = 'phone_amount';
 *
 * 🛑 Macedonia only (repair-kit guards). The shop (naturatherapy.mk) is never touched.
 */
import { pathToFileURL } from 'node:url';
import {
  bold, die, ok, warn, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, fileStamp, writeCsv, printTable,
} from './lib/repair-kit.mjs';

/** The candidates, read-only. `days` null = every web order. */
export const candidatesSql = (days) =>
  `select * from public.web_phone_link_candidates(null, ${days == null ? 'null' : Number(days)})`;

/** Σ per pass × rule — the dry-run summary (pure, for a test). */
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.pass}|${r.rule}`;
    const t = by.get(k) ?? { pass: Number(r.pass), rule: r.rule, links: 0, web_total_mkd: 0, cod_mkd: 0, delivered: 0 };
    t.links++;
    t.web_total_mkd += Math.round(Number(r.web_total) || 0);
    t.cod_mkd += Number(r.cod_mkd) || 0;
    if (Number(r.parcel_status_id) === 2) t.delivered++;
    by.set(k, t);
  }
  return [...by.values()].sort((a, b) => a.pass - b.pass || a.rule.localeCompare(b.rule));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply'], values: ['expect', 'recent-days'] });
  const days = args['recent-days'] == null ? null : Number(args['recent-days']);
  if (days != null && !(Number.isInteger(days) && days > 0)) die('--recent-days must be a positive integer');
  if (args.expect != null && !/^\d+$/.test(args.expect)) die('--expect must be a number');

  mkGuard();
  await assertRemoteIsMk();
  const [fn] = await sqlRead(`select
      to_regprocedure('public.web_phone_link_candidates(integer[],integer)') is not null as cand,
      to_regprocedure('public.web_link_mex_parcels_by_phone(integer[],integer,boolean)') is not null as writer,
      (select count(*)::int from public.web_orders where mex_link_method = 'phone_amount') as linked_now`);
  if (!fn.cand || !fn.writer) die('migration 20260940000300 is not applied — apply it first (scripts/apply-migration-mk.mjs).');

  const rows = await sqlRead(candidatesSql(days));
  const sum = summarize(rows);
  console.log(bold(`\nweb ↔ NATURA "M…" parcels by phone — ${days == null ? 'every web order' : `web orders of the last ${days} days`}`));
  console.log(`already phone-linked: ${fn.linked_now}; candidates now: ${rows.length}`);
  printTable(sum);
  printTable(rows.slice(0, 20).map((r) => ({
    order: r.order_number, parcel: r.tracking_id, pass: r.pass, rule: r.rule, hours_after: Number(r.hours_after),
    shop: `${r.web_status}/${r.payment_method}/${r.payment_status}`, total: Number(r.web_total), cod: r.cod_mkd,
  })));
  if (rows.length) {
    const file = `web-parcel-links-${fileStamp()}.csv`;
    writeCsv(file, rows, ['shop_order_id', 'order_number', 'tracking_id', 'pass', 'rule', 'hours_after', 'web_created_at',
      'parcel_created_at', 'web_status', 'payment_method', 'payment_status', 'web_total', 'cod_mkd', 'parcel_status_id', 'phone8']);
    ok(`all ${rows.length} candidates → exports/repairs/${file} (phones inside — gitignored, do not share)`);
  }

  if (!args.apply) {
    console.log(`\nDry run — nothing written. To link: node scripts/backfill-web-parcel-links.mjs --apply --expect ${rows.length}`
      + (days == null ? '' : ` --recent-days ${days}`));
    return;
  }
  if (args.expect != null && Number(args.expect) !== rows.length) {
    die(`--expect ${args.expect} but ${rows.length} candidates now — re-run the dry run and look again.`);
  }
  if (args.expect == null) warn('--apply without --expect: linking whatever the candidates are right now');
  const [res] = await sql(`select public.web_link_mex_parcels_by_phone(null, ${days == null ? 'null' : days}, false) as r`);
  const r = res?.r ?? {};
  ok(`linked ${r.linked ?? 0}, released ${r.released ?? 0} (by rule ${JSON.stringify(r.by_rule ?? {})}, by pass ${JSON.stringify(r.by_pass ?? {})})`);
  const [after] = await sqlRead(`select count(*)::int as n from public.web_orders where mex_link_method = 'phone_amount'`);
  ok(`web orders phone-linked now: ${after.n}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => die(e?.message || String(e)));
}
