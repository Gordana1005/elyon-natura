#!/usr/bin/env node
/**
 * Repair — the CRM price takes the MEX COD (owner decision 28.09.2026, HANDOFF §3).
 *
 *   "COD ≠ CRM price: MEX is right. Set the CRM price to the MEX COD when it differs. Not when
 *    COD = price×61.5+150 (delivery fee), and not when COD is 0. Dry-run list first; keep
 *    order_items consistent."
 *
 * The rules (candidate, exclusions, order_items, quantity) are documented and implemented in
 * scripts/lib/cod-price.mjs — read its header. In short: an order whose own, register-agreed
 * MEX parcel carries a COD > 0 that fits neither price × 61,5 ±3 ден nor that +150 ±3 gets
 * price := COD / 61,5 €, its order_items scaled to the same total; ghost/disposition rows,
 * zero prices, wrong-channel links (e.g. an AlterCPA order on a teleshop parcel), parcels
 * two orders hold, non-sale statuses and payout rows are listed and never touched.
 *
 * PROTOCOL (scripts/lib/repair-kit.mjs):
 *   dry run (default)   classify → two CSVs in exports/repairs/ (PII, gitignored) → a
 *                       data_repair_runs row (dry_run, candidate_hash of the re-price lines)
 *                       → prints the run id. Nothing is written to orders.
 *   --apply --run <id>  re-classify; refuse unless the hash equals the dry run's; then
 *                       ≤ 200-order transactions, each: SET LOCAL elyon.bulk_repair = 'on' and
 *                       elyon.keep_updated_at = 'on' (orders.updated_at is Call Again's
 *                       last_call_at — it must not move), lock, keep only orders still exactly
 *                       as reviewed, data_repair_rows.before → price (+ quantity) → lines →
 *                       Σ lines = price checked → one order_notes row each → after.
 *                       Then applied_at + one audit_log row.
 *   undo                node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 *   node scripts/repair-cod-price.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--hold ORD-1,…] [--expect candidates=N,…]
 *   node scripts/repair-cod-price.mjs --apply --run <id> [same --since/--until/--hold] [--actor mile@elyon.com] [--chunk 200]
 *        [--outside-quiet-window]
 *
 * --since/--until narrow by order creation (Skopje days, inclusive); default: all time.
 * An apply refuses: before migration 20260939000300 (keep_updated_at guard), outside the quiet
 * window (20:55–07:00 Skopje) without --outside-quiet-window, and while
 * recompute_all_segments runs (checked again before every chunk).
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus / commission math is not touched — the
 * summary only REPORTS how many paid orders change price, because they feed those tiers.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qUuidArray, parseArgs, parseExpect, checkDrift, expectString,
  fmtMkd, fmtSkopje, fileStamp, writeCsv,
  loadPayoutOrderIds, resolveActor, recordDryRun, verifyRunForApply, applyChunked, finalizeRun, auditPartial,
  printTable, tally,
} from './lib/repair-kit.mjs';
import {
  KEY, classifyCodPrice, itemsFingerprintSql, buildPriceChunkSql, explanationKey,
} from './lib/cod-price.mjs';
import { loadAcceptedDuplicates } from './lib/accepted-duplicates.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The buckets --expect may pin (±2 %, never tighter than ±1 row). */
export const EXPECT_KEYS = ['mismatches', 'candidates', 'excluded', 'quantity_changes', 'paid_changes'];

// ─── loaders (read-only) ────────────────────────────────────────────────────
/**
 * Every order whose named parcel (orders.mex_tracking_id) is in the register with a COD > 0
 * that does NOT fit its price (exact ±3 or +150 ±3 — the kit's codFit, in SQL; the JS
 * classifier re-checks). The register's link, the double-claim holders, AlterCPA's own record
 * and the lines fingerprint come along.
 */
export const loadRows = (opts = {}) => sqlRead(rowsSql(opts));
/** The loader's SQL (exported so the sandbox harness runs exactly this). */
export function rowsSql({ since = null, until = null } = {}) {
  const win = [
    since ? `and o.created_at >= (date ${q(since)})::timestamp at time zone 'Europe/Skopje'` : '',
    until ? `and o.created_at < ((date ${q(until)}) + 1)::timestamp at time zone 'Europe/Skopje'` : '',
  ].join('\n       ');
  return `
    with dbl as (
      select o.mex_tracking_id as tracking_id, jsonb_agg(o.display_id order by o.display_id) as holder_ids
        from public.orders o
       where o.mex_tracking_id is not null and o.status::text <> 'duplicated'
       group by 1 having count(*) > 1
    )
    select o.id, o.display_id, o.status::text as status, o.price::text as price, o.quantity, o.product_name,
           o.source_type, o.external_source, o.external_order_id, o.sale_source, o.sale_source_detail, o.prediction_list_id,
           o.customer_name, o.customer_phone, o.customer_city, o.created_at, o.paid_basis, o.mex_cod_mkd,
           mp.tracking_id, mp.account, mp.series, mp.status_id, mp.status_name, mp.cod_mkd, mp.order_id as reg_order_id,
           mp.link_method, mp.created_at_mex, mp.delivered_at, mp.returned_at, mp.sender_reference,
           d.holder_ids,
           l.altercpa_id, l.payload->>'price' as cpa_price, l.payload->>'currency' as cpa_currency,
           coalesce(l.payload->'goods'->0->>'count', l.payload->>'count') as cpa_count,
           ${itemsFingerprintSql('o.id')} as items_fp
      from public.orders o
      join public.mex_parcels mp on mp.tracking_id = o.mex_tracking_id
      left join dbl d on d.tracking_id = o.mex_tracking_id
      left join lateral (select ll.altercpa_id, ll.payload from public.altercpa_leads ll where ll.order_id = o.id
                          order by ll.last_seen_at desc nulls last limit 1) l on true
     where mp.cod_mkd > 0
       and not (coalesce(o.price, 0) > 0
                and (abs(mp.cod_mkd - round(o.price * 61.5)) <= 3 or abs(mp.cod_mkd - round(o.price * 61.5) - 150) <= 3))
       ${win}`;
}

export const itemsSql = (ids) => `select i.order_id, i.id, i.product_name, i.quantity, i.price_per_unit::text as price_per_unit,
        i.total_price::text as total_price
      from public.order_items i where i.order_id = any(${qUuidArray(ids)}) order by i.order_id, i.id`;
/** Map order_id → its order_items lines (numerics as exact text). */
export async function loadItems(orderIds, read = sqlRead) {
  const ids = [...new Set(orderIds)];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await read(itemsSql(ids.slice(i, i + 1000)));
    for (const r of rows) (out.get(r.order_id) ?? out.set(r.order_id, []).get(r.order_id)).push(r);
  }
  return out;
}

/** Context for the header: how many orders carry an agreed parcel link with a COD at all. */
export const CONTEXT_SQL = `select count(*)::int as named,
      count(*) filter (where mp.order_id = o.id)::int as agreed
    from public.orders o join public.mex_parcels mp on mp.tracking_id = o.mex_tracking_id
   where mp.cod_mkd > 0`;
async function loadContext() {
  const [r] = await sqlRead(CONTEXT_SQL);
  return r || { named: 0, agreed: 0 };
}

// ─── summary helpers (pure) ─────────────────────────────────────────────────
const sum = (xs, f) => xs.reduce((n, x) => n + (Number(f(x)) || 0), 0);
/** { key → { orders, crm_mkd, cod_mkd, diff_mkd } } */
export function moneyTally(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] ??= { orders: 0, crm_mkd: 0, cod_mkd: 0, diff_mkd: 0 };
    out[k].orders++;
    out[k].crm_mkd += Number(r.crm_mkd) || 0;
    out[k].cod_mkd += Number(r.cod_mkd) || 0;
    out[k].diff_mkd += Number(r.diff_mkd) || 0;
  }
  return out;
}
const moneyTable = (t, label) => Object.entries(t).sort((a, b) => b[1].orders - a[1].orders).map(([k, v]) => ({
  [label]: k, orders: v.orders, 'CRM ден': fmtMkd(v.crm_mkd), 'MEX COD ден': fmtMkd(v.cod_mkd), 'Δ ден': fmtMkd(v.diff_mkd),
}));

/** The owner's separate line: paid orders that change price (they feed the deferred tiers). */
export function paidLine(candidates) {
  const paid = candidates.filter((c) => c.paid === 'yes');
  const bonusDelta = sum(paid, (c) => Number(c.bonus_after) - Number(c.bonus_now));
  const tierMoves = paid.filter((c) => Number(c.bonus_after) !== Number(c.bonus_now)).length;
  return {
    orders: paid.length, diff_mkd: sum(paid, (c) => c.diff_mkd), cod_mkd: sum(paid, (c) => c.cod_mkd),
    quantity_changes: paid.filter((c) => c.new_qty !== '').length, bonus_delta_eur: bonusDelta, bonus_changes: tierMoves,
  };
}

// ─── main ───────────────────────────────────────────────────────────────────
const USAGE = `usage: node scripts/repair-cod-price.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--hold ORD-1,…] [--expect candidates=N,…]
       node scripts/repair-cod-price.mjs --apply --run <id> [--since …] [--until …] [--hold …] [--actor <email>] [--chunk 200] [--outside-quiet-window]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'help'],
    values: ['run', 'expect', 'actor', 'chunk', 'hold', 'since', 'until'],
  });
  if (args.help) { console.log(USAGE); return; }
  for (const k of ['since', 'until']) if (args[k] && !DATE_RE.test(args[k])) die(`--${k} must be YYYY-MM-DD (a Skopje day)`);
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair ${KEY} — CRM price := MEX COD — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const options = { since: args.since || null, until: args.until || null, hold: [...hold].sort() };

  // 1. load
  const acc = loadAcceptedDuplicates();
  if (acc.errors.length) warn(`scripts/data/c8a-accepted-duplicates.json is invalid (${acc.errors.join('; ')}) — no pair is treated as owner-accepted`);
  const accepted = acc.errors.length ? [] : acc.entries;
  const ctx = await loadContext();
  const rows = await loadRows(options);
  const [items, payout] = await Promise.all([loadItems(rows.map((r) => r.id)), loadPayoutOrderIds(rows.map((r) => r.id))]);
  ok(`${fmtMkd(ctx.named)} orders name a registered parcel with a COD (${fmtMkd(ctx.agreed)} of them linked both ways) · ${rows.length} whose COD fits neither the price nor price + 150 ден` +
    `${options.since || options.until ? ` (created ${options.since || '…'} – ${options.until || '…'})` : ''}`);

  // 2. classify
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const today = fmtSkopje(Date.now()).slice(0, 10);
  const plan = classifyCodPrice({ rows, items, payout, hold, accepted, runTag, today });
  const { candidates, excluded } = plan;
  const paid = paidLine(candidates);

  // 3. report
  console.log(bold(`\nMismatches: ${plan.counts.mismatches} — re-price ${candidates.length} · excluded ${excluded.length}`));
  if (candidates.length) {
    console.log(bold('\nTo re-price — by source'));
    printTable(moneyTable(moneyTally(candidates, (r) => `${r.source}${r.detail ? ` / ${r.detail}` : ''}`), 'source'));
    console.log(bold('To re-price — by status'));
    printTable(moneyTable(moneyTally(candidates, (r) => r.status), 'status'));
    console.log(bold('To re-price — by explanation'));
    printTable(moneyTable(moneyTally(candidates, (r) => explanationKey(r.explained)), 'explanation'));
    console.log(bold('To re-price — source × status × explanation'));
    printTable(moneyTable(moneyTally(candidates, (r) => `${r.source} · ${r.status} · ${explanationKey(r.explained)}`), 'source · status · explanation').slice(0, 60));
    console.log(`  Σ CRM ${fmtMkd(sum(candidates, (r) => r.crm_mkd))} ден → Σ MEX COD ${fmtMkd(sum(candidates, (r) => r.cod_mkd))} ден (Δ ${fmtMkd(sum(candidates, (r) => r.diff_mkd))} ден)`);
  }
  console.log(bold(`\nPAID orders that change price: ${paid.orders}`) +
    ` — Δ ${fmtMkd(paid.diff_mkd)} ден (COD ${fmtMkd(paid.cod_mkd)} ден), ${paid.quantity_changes} with a quantity change.` +
    `\n  They feed the per-package commission tiers (DEFERRED by the owner — nothing here changes that math). Under today's rule their` +
    ` bonus would move by ${paid.bonus_delta_eur >= 0 ? '+' : ''}${paid.bonus_delta_eur} € on ${paid.bonus_changes} order(s).`);
  const qtyRows = candidates.filter((r) => r.new_qty !== '');
  if (qtyRows.length) {
    console.log(bold(`\nQuantity changes proven by AlterCPA's own record (${qtyRows.length})`));
    for (const r of qtyRows.slice(0, 40)) console.log(`  ${r.order.padEnd(11)} ${r.status.padEnd(9)} qty ${r.qty} → ${r.new_qty}  ${r.crm_eur} € → ${r.new_price_eur} €  (COD ${fmtMkd(r.cod_mkd)} ден)`);
    if (qtyRows.length > 40) console.log(`  … ${qtyRows.length - 40} more in the CSV`);
  }
  if (excluded.length) {
    console.log(bold(`\nExcluded — listed, never re-priced (${excluded.length})`));
    printTable(moneyTable(moneyTally(excluded, (r) => r.rule), 'reason'));
    const sus = excluded.filter((r) => r.rule === 'suspect_link');
    if (sus.length) {
      console.log(bold('Suspect links (the parcel belongs to another channel) — by source and parcel series'));
      printTable(moneyTable(moneyTally(sus, (r) => `${r.source} on ${r.series || r.account || '?'}`), 'order source on parcel'));
    }
    const dbl = [...new Map(excluded.filter((r) => r.why.includes('double_held')).map((r) => [r.tracking, r])).values()];
    if (dbl.length) {
      console.log(bold(`Parcels held by two orders (${dbl.length}) — the owner keeps both orders; neither is re-priced`));
      for (const r of dbl) console.log(`  ${r.tracking.padEnd(24)} ${r.holders}${r.owner_accepted ? '  (owner-accepted, C8a)' : '  (NOT in c8a-accepted-duplicates.json)'}`);
    }
  }
  const stamp = fileStamp();
  const candPath = writeCsv(`${KEY}-candidates-${APPLY ? 'apply-' : ''}${stamp}.csv`, candidates);
  const exclPath = writeCsv(`${KEY}-excluded-${APPLY ? 'apply-' : ''}${stamp}.csv`, excluded);
  ok(`CSV (contains PII — stays in exports/, never commit): ${candPath}`);
  ok(`CSV (excluded, with every reason): ${exclPath}`);

  const counts = {
    mismatches: plan.counts.mismatches, candidates: candidates.length, excluded: excluded.length,
    quantity_changes: plan.counts.quantity_changes, paid_changes: paid.orders,
  };

  // 4. dry run → optional drift check → ledger row
  if (!APPLY) {
    if (args.expect) {
      const given = new Set(String(args.expect).split(',').map((p) => p.split('=')[0].trim()));
      const exp = Object.fromEntries(Object.entries(parseExpect(args.expect, Object.fromEntries(EXPECT_KEYS.map((k) => [k, 0])))).filter(([k]) => given.has(k)));
      const drift = checkDrift(counts, exp);
      console.log(bold('\nExpected vs actual'));
      printTable(drift.rows);
      if (!drift.pass) die(`Counts drifted more than ±2 % — NO run recorded. If understood: --expect ${expectString(counts, [...given])}`);
    }
    const bySource = moneyTally(candidates, (r) => r.source);
    const summary = {
      script: 'repair-cod-price.mjs', options, counts,
      by_source: bySource, by_status: moneyTally(candidates, (r) => r.status), by_explanation: moneyTally(candidates, (r) => explanationKey(r.explained)),
      excluded_by_reason: moneyTally(excluded, (r) => r.rule), paid,
      double_held: excluded.filter((r) => r.why.includes('double_held')).map((r) => ({ order: r.order, tracking: r.tracking, owner_accepted: !!r.owner_accepted })),
      csv: [candPath, exclPath].map((p) => p.split(/[\\/]/).pop()),
    };
    if (!plan.lines.length) { console.log(bold('\nNothing to re-price — no run recorded.\n')); return; }
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…, ${plan.lines.length} orders)`);
    console.log('Nothing was written to orders. After the owner has seen the CSVs, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    const same = `${options.since ? ` --since ${options.since}` : ''}${options.until ? ` --until ${options.until}` : ''}${options.hold.length ? ` --hold ${options.hold.join(',')}` : ''}`;
    console.log(`  node scripts/repair-cod-price.mjs --apply --run ${id}${same}\n`);
    return;
  }

  // 5. apply
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines, options });
  const units = plan.units.filter((u) => !done.has(u.order_id));
  console.log(bold(`\nApplying ${units.length} orders`));
  const stats = await applyChunked({ items: units, build: (chunk) => buildPriceChunkSql({ runId: args.run, units: chunk }), chunkSize: args.chunk });
  const payload = {
    script: 'repair-cod-price.mjs', options, counts, applied_orders: stats.applied, skipped_moved: stats.skipped,
    chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size, paid,
    outside_quiet_window: !!args['outside-quiet-window'],
  };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger.\n` +
      '  Fix the cause, then re-run the same --apply command: it resumes after the committed chunks.');
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders re-priced${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);

  // 6. verify
  const ids = plan.units.map((u) => u.order_id);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.orders o join public.mex_parcels mp on mp.tracking_id = o.mex_tracking_id and mp.order_id = o.id
        where o.id = any(${qUuidArray(ids)}) and abs(mp.cod_mkd - round(o.price * 61.5)) > 3)::int as still_off,
      (select count(*) from public.orders o where o.id = any(${qUuidArray(ids)})
          and exists (select 1 from public.order_items i where i.order_id = o.id)
          and (select sum(i.total_price) from public.order_items i where i.order_id = o.id) <> o.price)::int as items_not_summing`);
  console.log(bold('\nVerification'));
  printTable([v]);
  if (v.items_not_summing) warn('some re-priced orders have order_items that do not sum to the price — investigate now.');
  console.log(`  still off (COD ≠ price × 61,5): ${v.still_off} (expected ≈ the ${stats.skipped.length} left alone)`);
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs, node scripts/verify-attribution.mjs (C6), node scripts/report-cod-mismatch.mjs\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
