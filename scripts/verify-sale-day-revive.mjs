/**
 * verify-sale-day-revive — READ-ONLY proof of the owner's 03.10.2026 sale-day rule (migrations
 * 20260947001800 / 1801 / 1810): a DEAD order (cancelled / trashed — or an undecided lead, or an AlterCPA
 * approval older than the no-parcel rule with no parcel of its own) revived or credited by a collabBox sales
 * document or its MEX parcel counts on the BOOKING day — sold_at = collabbox_sale_at(doc_at, booked_at), with no
 * document the parcel's created_at_mex. Only sold_at moves; the seller never does.
 *
 *   node scripts/verify-sale-day-revive.mjs [--list] [--json]
 *
 *   R1  the switch app_settings.sale_day_revive (apply | report | off) and the cron 'sale-day-revive'
 *       ('7-59/15 * * * *'; WARN while it is not scheduled — 1810 is applied after the backfill)
 *   R2  the plan now (sale_day_revive_plan): 0 after the backfill; a few between two cron ticks = WARN
 *   R3  the ledger: every applied, not-undone move still holds its new sold_at (WARN: changed since)
 *   R4  the seller never moved: sold_via / sold_by_* of every moved order are what they were at the move
 *   R5  orders.updated_at was not bumped by an applied run (elyon.keep_updated_at)
 *   R6  collabbox_credit_order() stamps a dead / undecided order with the document time (the forward rule)
 *   R7  September + the last 30 days: LEADS (10111) / LEADS-OUT (10114) documents whose order counts 8+ days
 *       before the booking day — what is left is a living approval (≤ the no-parcel days) or unstamped
 *
 *   --list  prints the planned moves (order, basis, old → new day, document).
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only.
 */
import { runSql } from './verify-insights-ties.mjs';

const args = new Set(process.argv.slice(2));
const LIST = args.has('--list');
const JSON_OUT = args.has('--json');

const results = [];
const out = (id, level, msg, data) => {
  results.push({ id, level, msg, data });
  if (!JSON_OUT) console.log(`${level.padEnd(4)} ${id.padEnd(3)} ${msg}`);
};

async function q(sql) {
  try { return await runSql(sql); }
  catch (e) { console.error(`unreachable: ${e.message}`); process.exit(2); }
}

// R1 — the switch and the cron
{
  const [s] = await q(`SELECT (SELECT value FROM public.app_settings WHERE key = 'sale_day_revive') AS cfg,
      (SELECT schedule FROM cron.job WHERE jobname = 'sale-day-revive') AS sched,
      (SELECT active FROM cron.job WHERE jobname = 'sale-day-revive') AS active`);
  const mode = s?.cfg?.mode;
  const okMode = ['apply', 'report', 'off'].includes(mode);
  const lvl = !okMode ? 'FAIL' : (s?.sched === '7-59/15 * * * *' && s?.active ? 'PASS' : 'WARN');
  out('R1', lvl, `switch mode ${mode ?? 'MISSING'} · cron ${s?.sched ?? 'NOT SCHEDULED'}${s?.sched && !s?.active ? ' (inactive)' : ''}`);
}

// R2 — the plan now
const plan = await q(`SELECT p.display_id, p.basis, p.status_at_arrival, p.old_sold_at, p.new_sold_at, p.doc_number,
    p.value_mkd, p.sale_source_detail, p.sold_via
  FROM public.sale_day_revive_plan() p ORDER BY p.new_sold_at`);
{
  const by = {};
  for (const r of plan) by[r.basis] = (by[r.basis] ?? 0) + 1;
  const [last] = await q(`SELECT max(started_at) AS at FROM public.sale_day_revive_runs WHERE mode = 'apply'`);
  const lvl = plan.length === 0 ? 'PASS' : 'WARN';
  out('R2', lvl, `planned moves now: ${plan.length} ${JSON.stringify(by)} · last applied run ${last?.at ?? 'never'}`);
  if (LIST && !JSON_OUT) {
    for (const r of plan.slice(0, 200)) {
      console.log(`     ${r.display_id} ${r.basis}/${r.status_at_arrival} ${String(r.old_sold_at).slice(0, 10)} → ${String(r.new_sold_at).slice(0, 10)} ${r.doc_number ?? '(parcel)'} ${r.value_mkd} ден ${r.sale_source_detail}/${r.sold_via}`);
    }
  }
}

// R3 / R4 — the ledger against the orders
{
  const [l] = await q(`SELECT
      count(*) FILTER (WHERE m.applied AND m.undone_at IS NULL)                                    AS live,
      count(*) FILTER (WHERE m.applied AND m.undone_at IS NULL AND o.sold_at = m.new_sold_at)      AS holds,
      count(*) FILTER (WHERE m.applied AND m.undone_at IS NULL AND o.sold_at IS DISTINCT FROM m.new_sold_at) AS changed,
      count(*) FILTER (WHERE m.undone_at IS NOT NULL)                                              AS undone,
      count(*) FILTER (WHERE m.applied AND o.sold_via IS DISTINCT FROM m.sold_via)                 AS via_moved,
      count(DISTINCT m.run_id) FILTER (WHERE m.applied)                                            AS runs
    FROM public.sale_day_revive_moves m JOIN public.orders o ON o.id = m.order_id`);
  out('R3', Number(l.changed) === 0 ? 'PASS' : 'WARN',
      `moves applied ${l.live} (in ${l.runs} runs) · still on the booking day ${l.holds} · changed since ${l.changed} · undone ${l.undone}`);
  out('R4', Number(l.via_moved) === 0 ? 'PASS' : 'FAIL', `moved orders whose sold_via differs from the move's: ${l.via_moved}`);
}

// R5 — updated_at kept
{
  const [u] = await q(`SELECT count(*) AS bumped
    FROM public.sale_day_revive_runs r
    JOIN public.sale_day_revive_moves m ON m.run_id = r.run_id AND m.applied
    JOIN public.orders o ON o.id = m.order_id
    WHERE r.mode = 'apply' AND o.updated_at BETWEEN r.started_at AND coalesce(r.finished_at, r.started_at + interval '10 minutes')`);
  out('R5', Number(u.bumped) === 0 ? 'PASS' : 'FAIL', `moved orders whose updated_at falls inside their run: ${u.bumped}`);
}

// R6 — the forward rule in the writer's credit
{
  const [f] = await q(`SELECT prosrc LIKE '%order_status_at%' AND prosrc LIKE '%dead / undecided%' AS ok
    FROM pg_proc WHERE oid = to_regprocedure('public.collabbox_credit_order(uuid,text,timestamptz,text,boolean)')`);
  out('R6', f?.ok ? 'PASS' : 'FAIL', `collabbox_credit_order stamps a dead / undecided order with the document time: ${f?.ok ? 'yes' : 'NO'}`);
}

// R7 — the measure: LEADS documents counted 8+ days before their booking day
for (const [label, from, to] of [
  ['September', `'2026-09-01 00:00+02'`, `'2026-10-01 00:00+02'`],
  ['last 30 days', `now() - interval '30 days'`, `now()`],
]) {
  const rows = await q(`WITH d AS (
      SELECT d.doc_number, d.doc_type_id, d.amount_mkd,
             (public.collabbox_sale_at(d.doc_at, d.booked_at) AT TIME ZONE 'Europe/Skopje')::date AS bday
      FROM public.collabbox_documents d
      WHERE d.doc_type_id IN ('10111', '10114') AND NOT coalesce(d.is_storno, false) AND d.vanished_at IS NULL
        AND public.collabbox_sale_at(d.doc_at, d.booked_at) >= ${from} AND public.collabbox_sale_at(d.doc_at, d.booked_at) < ${to}
    ), j AS (
      SELECT d.*, o.id,
        (coalesce(o.sold_at, (SELECT max(l.decided_at) FROM public.altercpa_leads l
                               WHERE l.order_id = o.id AND l.decision IN ('approved', 'cancel_other')),
                  o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sday
      FROM d LEFT JOIN public.orders o ON o.mex_tracking_id = d.doc_number
                                     AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
    )
    SELECT doc_type_id,
           count(*) AS docs,
           count(*) FILTER (WHERE id IS NOT NULL AND sday = bday)                      AS same_day,
           count(*) FILTER (WHERE id IS NOT NULL AND sday < bday AND sday >= bday - 7) AS older_1_7,
           count(*) FILTER (WHERE id IS NOT NULL AND sday < bday - 7)                  AS older_8,
           coalesce(sum(amount_mkd) FILTER (WHERE id IS NOT NULL AND sday < bday - 7), 0) AS older_8_mkd,
           count(*) FILTER (WHERE id IS NOT NULL AND sday > bday)                      AS newer,
           count(*) FILTER (WHERE id IS NULL)                                          AS no_order
    FROM j GROUP BY 1 ORDER BY 1`);
  for (const r of rows) {
    out('R7', 'INFO', `${label} ${r.doc_type_id}: ${r.docs} docs · same day ${r.same_day} · 1–7 d older ${r.older_1_7} · 8+ d older ${r.older_8} (${r.older_8_mkd} ден) · newer ${r.newer} · no order holds the parcel ${r.no_order}`);
  }
}

if (JSON_OUT) console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
