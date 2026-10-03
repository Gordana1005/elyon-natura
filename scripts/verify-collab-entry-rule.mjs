/**
 * verify-collab-entry-rule — READ-ONLY proof of the owner's collabBox rules: the collabBox entry rule (02.10.2026
 * 20260947000200 — since 03.10.2026 5 days for EVERY sale, 20260947001900 / 1905 / 1910) and a CRM sale's department
 * from its own booking (20260947000300).
 *
 *   node scripts/verify-collab-entry-rule.mjs [--list] [--json] [--backtest [YYYY-MM-DD YYYY-MM-DD]]
 *
 *   E1  the owner switch app_settings.collab_entry_rule (mode report | apply, days, hour, from_date, warn,
 *       silent_after_days, postpone_days) is an owner key (tg_app_settings_guard_owner_keys) and the cron
 *       'collab-entry-rule' runs '20 * * * *' (hourly at :20 UTC; the function acts only in the Skopje `hour`, so the
 *       CEST → CET switch needs no change) — prints the next run in Skopje time
 *   E2  the plan now (collab_entry_rule_plan): candidates · in_collab · needs_linking · pushed · postponed · warn ·
 *       cancel (silent apart) + value — every planned cancel is, re-checked by an INDEPENDENT query, a sale of the rule's
 *       population (confirmed / shipped, no parcel, priced, not collabBox-made, not web, not a disposition, not a test
 *       phone), >= days Skopje days old, no collabBox document names it, no unlinked MEX parcel on its phone since the
 *       sale − 2 days, no MEX push success
 *   E3  the ledger: the last runs (mode, counts, cancelled, silent, warned, undone); in report mode nothing was
 *       cancelled and no bell was written
 *   E4  every order the rule cancelled is still cancelled with the rule's note, or was undone / revived by a parcel
 *   E5  the bells of the last apply run: one not_in_collab per non-silent cancel with an owner, none for a silent one,
 *       one not_in_collab_warning per warned order
 *   E6  sale_delivery_postponed_note carries the no-parcel rule's postponement regex character for character
 *   D1  the cron 'crm-sale-booking-dept' runs '7,22,37,52 * * * *'
 *   D2  every confirmed CRM sale without a parcel (≤ 60 days) holds dept_override = order_dept_decide (20260947000400:
 *       the seller's team → MEX profile → own booking; WARN while a booking arrived after the last 15-minute pass)
 *   D3  the departments of the open CRM sales: by the seller's team · by the booking · provisional (neither yet)
 *
 *   --list      prints the planned cancels / warnings (order, department, seller, sale day, age, value, silent) — the
 *               list the owner sees before a run
 *   --backtest  B1: the rule replayed AS OF sale day + days at 21:20 for the sale days FROM..TO (default 2026-09-01 ..
 *               2026-09-27): how many it would have cancelled, and how many of those were WRONG (the order's own parcel's
 *               collabBox document was already entered by then) · late (entered after) · never shipped. Heavy (~1–2 min).
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const argv = process.argv.slice(2);
const args = new Set(argv);
const LIST = args.has('--list');
const JSON_OUT = args.has('--json');
const BACKTEST = args.has('--backtest');
const btDates = argv.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const BT_FROM = btDates[0] ?? '2026-09-01';
const BT_TO = btDates[1] ?? '2026-09-27';
const RULE_NOTE = 'Нема внесено порачка во Collab';

const results = [];
const out = (id, level, msg, data) => {
  results.push({ id, level, msg, data });
  if (!JSON_OUT) console.log(`${level.padEnd(4)} ${id.padEnd(3)} ${msg}`);
};
const mkd = (eur) => Math.round(Number(eur || 0) * 61.5).toLocaleString('mk-MK');

async function q(sql) {
  try { return await runSql(sql); }
  catch (e) { console.error(`unreachable: ${e.message}`); process.exit(2); }
}

// E1 — the switch and the cron
let cfg = null;
{
  const [s] = await q(`SELECT (SELECT value FROM public.app_settings WHERE key = 'collab_entry_rule') AS cfg,
      (SELECT prosrc LIKE '%''collab_entry_rule''%' FROM pg_proc WHERE proname = 'tg_app_settings_guard_owner_keys') AS guarded,
      (SELECT schedule FROM cron.job WHERE jobname = 'collab-entry-rule') AS sched,
      (SELECT command FROM cron.job WHERE jobname = 'collab-entry-rule') AS cmd,
      (SELECT active FROM cron.job WHERE jobname = 'collab-entry-rule') AS active,
      to_char(now() AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') AS now_sk`);
  cfg = s?.cfg ?? null;
  const hour = Number(cfg?.hour ?? 21);
  const ok = cfg && ['report', 'apply'].includes(cfg.mode) && s.guarded && s.sched === '20 * * * *' && s.active
    && s.cmd === 'SELECT public.apply_collab_entry_rule();';
  const [n] = await q(`SELECT to_char(CASE WHEN (now() AT TIME ZONE 'Europe/Skopje') < (current_date + make_time(${hour}, 20, 0))
                                          AND (now() AT TIME ZONE 'Europe/Skopje')::date = current_date
                                     THEN (now() AT TIME ZONE 'Europe/Skopje')::date + make_time(${hour}, 20, 0)
                                     ELSE (now() AT TIME ZONE 'Europe/Skopje')::date
                                          + CASE WHEN extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') * 60
                                                      + extract(minute FROM now() AT TIME ZONE 'Europe/Skopje') < ${hour} * 60 + 20
                                                 THEN 0 ELSE 1 END + make_time(${hour}, 20, 0) END, 'DD.MM HH24:MI') AS next_sk`);
  out('E1', ok ? 'PASS' : 'FAIL',
      `switch ${JSON.stringify(cfg)} · owner key ${s?.guarded ? 'yes' : 'NO'} · cron ${s?.sched ?? 'MISSING'}${s?.active ? '' : ' (inactive)'} · now ${s?.now_sk} Skopje · next act ${n?.next_sk} Skopje (${cfg?.mode ?? '?'})`);
}

// E2 — the plan, re-checked independently
const plan = await q(`SELECT p.*, sp.display_name AS seller_person, pr.full_name AS owner_name
  FROM public.collab_entry_rule_plan() p
  LEFT JOIN public.sales_people sp ON sp.id = p.sold_by_person_id
  LEFT JOIN public.profiles pr ON pr.user_id = p.owner_user_id
  ORDER BY p.sold_at`);
{
  const by = (a) => plan.filter((r) => r.plan_action === a);
  const cancels = by('cancel');
  const silent = cancels.filter((r) => r.silent);
  const value = cancels.reduce((s, r) => s + Number(r.price_eur || 0), 0);
  out('E2', 'INFO', `plan now (days ${cfg?.days}): ${plan.length} candidates · in_collab ${by('in_collab').length} · needs_linking ${by('needs_linking').length} · pushed ${by('pushed').length} · postponed ${by('postponed').length} · warn ${by('warn').length} · cancel ${cancels.length} (silent ${silent.length}; ${mkd(value)} ден)`);
  const tally = {};
  for (const r of cancels) tally[r.department ?? '?'] = (tally[r.department ?? '?'] || 0) + 1;
  out('E2', 'INFO', `planned cancels by department: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  if (cancels.length) {
    const ids = cancels.map((r) => `'${r.order_id}'`).join(',');
    const bad = await q(`SELECT o.display_id FROM public.orders o
      WHERE o.id IN (${ids})
        AND NOT (o.status IN ('confirmed', 'shipped') AND o.mex_tracking_id IS NULL AND coalesce(o.price, 0) > 0
                 AND coalesce(o.external_source, '') <> 'collabbox' AND coalesce(o.sale_source, '') <> 'web'
                 AND coalesce(o.sale_source_detail, '') <> 'disposition'
                 AND NOT (right(regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g'), 8) = ANY (public.report_excluded_phone8s()))
                 AND ((now() AT TIME ZONE 'Europe/Skopje')::date
                      - (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date)
                     >= coalesce(((SELECT value FROM public.app_settings WHERE key = 'collab_entry_rule')->>'days')::int, 5)
                 AND NOT EXISTS (SELECT 1 FROM public.collabbox_documents d
                                  WHERE (d.order_id = o.id OR d.related_order_id = o.id) AND NOT coalesce(d.is_storno, false))
                 AND NOT EXISTS (SELECT 1 FROM public.mex_parcels m
                                  WHERE m.order_id IS NULL
                                    AND m.phone8 = right(regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g'), 8)
                                    AND m.created_at_mex >= coalesce(o.sold_at, o.confirmed_at, o.created_at) - interval '2 days')
                 AND NOT EXISTS (SELECT 1 FROM public.mex_push_attempts a
                                  WHERE a.order_id = o.id AND a.status IN ('ok', 'exists_linked')))`);
    out('E2', bad.length ? 'FAIL' : 'PASS',
        bad.length ? `planned cancels that fail the independent check: ${bad.map((r) => r.display_id).join(', ')}`
                   : `every planned cancel re-checked independently (${cancels.length})`);
  }
  if (LIST && !JSON_OUT) {
    for (const a of ['cancel', 'warn']) {
      const rows = by(a);
      if (!rows.length) continue;
      console.log(`\n  ${a === 'cancel' ? 'СЕ ОТКАЖУВА — „Нема внесено порачка во Collab“' : 'ПРЕДУПРЕДУВАЊЕ (утре се откажува)'} — ${rows.length}`);
      for (const r of rows) {
        console.log(`    ${String(r.display_id).padEnd(11)} ${String(r.department ?? '?').padEnd(15)} ${String(r.sale_day).slice(0, 10)}  ${String(r.age_days).padStart(3)} д  ${mkd(r.price_eur).padStart(7)} ден  ${(r.seller_person || '?').padEnd(24)} ${r.silent ? '(без известување)' : `→ ${r.owner_name || 'никој'}`}`);
      }
    }
    console.log('');
  }
}

// E3 — the ledger
let lastApply = null;
{
  const runs = await q(`SELECT id, run_day, mode, trigger_kind, days, candidates, to_cancel, to_warn, in_collab, needs_linking,
                               pushed, postponed, cancelled, cancelled_silent, warned, undone, ran_at
                          FROM public.collab_entry_rule_runs ORDER BY ran_at DESC LIMIT 5`);
  if (!runs.length) out('E3', 'INFO', 'no run yet (the cron acts at 21:20 Skopje)');
  for (const r of runs) {
    const bad = r.mode === 'report' && (r.cancelled > 0 || r.warned > 0);
    if (!lastApply && r.mode === 'apply') lastApply = r;
    out('E3', bad ? 'FAIL' : 'INFO',
        `${r.run_day} ${r.mode}/${r.trigger_kind} ${r.days ?? '?'}d: candidates ${r.candidates} · cancel ${r.to_cancel} · warn ${r.to_warn} · in_collab ${r.in_collab} · needs_linking ${r.needs_linking} · pushed ${r.pushed ?? 0} · postponed ${r.postponed ?? 0} → cancelled ${r.cancelled} (silent ${r.cancelled_silent ?? 0}) · warned ${r.warned}${r.undone ? ` · undone ${r.undone}` : ''}`);
  }
}

// E4 — every cancel the rule made is still the rule's, undone, or revived by a parcel
{
  const [r] = await q(`SELECT count(*) AS n,
      count(*) FILTER (WHERE o.status = 'cancelled' AND (o.cancellation_reason_notes = '${RULE_NOTE}' OR o.cancellation_reason_notes LIKE 'not_in_collab_%')) AS still,
      count(*) FILTER (WHERE o.mex_tracking_id IS NOT NULL) AS with_parcel,
      count(*) FILTER (WHERE o.mex_tracking_id IS NOT NULL AND o.status = 'cancelled') AS parcel_still_cancelled,
      count(*) FILTER (WHERE NOT (o.status = 'cancelled' AND (o.cancellation_reason_notes = '${RULE_NOTE}' OR o.cancellation_reason_notes LIKE 'not_in_collab_%'))
                         AND o.mex_tracking_id IS NULL) AS moved
    FROM public.collab_entry_rule_items i JOIN public.orders o ON o.id = i.order_id
    WHERE i.action = 'cancelled'`);
  out('E4', Number(r.moved) ? 'WARN' : 'PASS',
      `rule cancels: ${r.n} · still the rule's ${r.still} · got a parcel ${r.with_parcel} (of them still cancelled in the CRM ${r.parcel_still_cancelled} — the cohort counts them by MEX) · changed by hand ${r.moved}`);
}

// E5 — the bells of the last apply run
if (lastApply) {
  const [b] = await q(`WITH i AS (SELECT * FROM public.collab_entry_rule_items WHERE run_id = '${lastApply.id}'),
    n AS (SELECT * FROM public.notifications
           WHERE type IN ('not_in_collab', 'not_in_collab_warning')
             AND created_at BETWEEN '${lastApply.ran_at}'::timestamptz - interval '1 minute' AND '${lastApply.ran_at}'::timestamptz + interval '10 minutes')
    SELECT (SELECT count(*) FROM i WHERE action = 'cancelled' AND NOT silent AND owner_user_id IS NOT NULL) AS want_cancel,
           (SELECT count(*) FROM n WHERE type = 'not_in_collab') AS got_cancel,
           (SELECT count(*) FROM n JOIN i ON i.display_id = n.meta->>'order' AND i.silent WHERE n.type = 'not_in_collab') AS silent_belled,
           (SELECT count(*) FROM i WHERE action = 'warned') AS want_warn,
           (SELECT count(*) FROM n WHERE type = 'not_in_collab_warning') AS got_warn`);
  const ok = Number(b.want_cancel) === Number(b.got_cancel) && Number(b.silent_belled) === 0 && Number(b.want_warn) === Number(b.got_warn);
  out('E5', ok ? 'PASS' : 'FAIL',
      `last apply run ${lastApply.run_day}: cancel bells ${b.got_cancel}/${b.want_cancel} · silent with a bell ${b.silent_belled} · warnings ${b.got_warn}/${b.want_warn}`);
} else {
  out('E5', 'INFO', 'no apply run yet — the bells are checked after the first one');
}

// E6 — the postponement regex is the no-parcel rule's
{
  const [r] = await q(`SELECT (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.apply_no_parcel_rule(boolean,boolean)')) AS np,
                              (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.sale_delivery_postponed_note(uuid)')) AS mine`);
  const grab = (src) => {
    const m = String(src ?? '').replace(/\r/g, '').match(/c_rx_d constant text[\s\S]*?cuem\)\)';/);
    return m ? m[0] : null;
  };
  const a = grab(r?.np), b = grab(r?.mine);
  out('E6', a && b && a === b ? 'PASS' : 'FAIL',
      a && b && a === b ? `the postponement regex is the no-parcel rule's (${a.length} chars)` : 'sale_delivery_postponed_note and apply_no_parcel_rule disagree on the regex — re-copy it');
}

// D1 / D2 / D3 — the booking department
{
  const [c] = await q(`SELECT schedule, active FROM cron.job WHERE jobname = 'crm-sale-booking-dept'`);
  out('D1', c?.schedule === '7,22,37,52 * * * *' && c?.active ? 'PASS' : 'FAIL', `cron crm-sale-booking-dept ${c?.schedule ?? 'MISSING'}`);
  const rows = await q(`SELECT o.display_id, o.dept_override AS cur,
      public.order_dept_decide(o.sale_source, o.sale_source_detail, o.sold_by_person_id, coalesce(o.sold_at, o.created_at),
                               o.mex_account, o.mex_tracking_id, o.id) AS want,
      public.order_dept_by_team(o.sale_source, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)) AS team,
      public.crm_sale_booking_dept(o.id) AS booking,
      public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept
    FROM public.orders o
    WHERE o.status = 'confirmed' AND o.sale_source = 'elyon_crm' AND o.sale_source_detail IN ('prediction_list', 'direct')
      AND o.mex_tracking_id IS NULL
      AND coalesce(o.sold_at, o.confirmed_at, o.created_at) >= now() - interval '60 days'`);
  const drift = rows.filter((r) => (r.cur ?? null) !== (r.want ?? null));
  out('D2', drift.length ? 'WARN' : 'PASS',
      drift.length ? `${drift.length} open CRM sale(s) whose booking changed since the last 15-minute pass: ${drift.slice(0, 10).map((r) => r.display_id).join(', ')}`
                   : `every open CRM sale holds its decided department (${rows.length})`);
  const tally = {};
  for (const r of rows) {
    const k = `${r.team ? 'по тим' : r.booking ? 'по внес' : 'привремено'} → ${r.dept}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  out('D3', 'INFO', `open CRM sales: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
}

// B1 — the backtest (opt-in, heavy)
if (BACKTEST) {
  const days = Number(cfg?.days ?? 5);
  const rows = await q(`WITH pop AS (
      SELECT o.id, o.status::text AS st, o.price, o.mex_tracking_id, o.sold_by_person_id, o.customer_name,
             coalesce(o.sold_at, o.confirmed_at, o.created_at) AS s,
             right(regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g'), 8) AS p8,
             public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept,
             ((((coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date + ${days}) + time '21:20')
               AT TIME ZONE 'Europe/Skopje') AS t
      FROM public.orders o
      WHERE coalesce(o.external_source, '') <> 'collabbox' AND coalesce(o.sale_source, '') <> 'web'
        AND coalesce(o.sale_source_detail, '') <> 'disposition' AND coalesce(o.price, 0) > 0
        AND coalesce(o.sold_at, o.confirmed_at, o.created_at) >= ('${BT_FROM}'::date::timestamp AT TIME ZONE 'Europe/Skopje')
        AND coalesce(o.sold_at, o.confirmed_at, o.created_at) <  (('${BT_TO}'::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
        AND (o.status IN ('confirmed', 'shipped', 'returned', 'delivered')
             OR (o.status = 'paid' AND o.mex_tracking_id IS NOT NULL)
             OR o.mex_tracking_id IS NOT NULL
             OR (o.status = 'cancelled' AND o.cancellation_reason = 'no_parcel_7d'))
        AND NOT (right(regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g'), 8) = ANY (public.report_excluded_phone8s()))
    ),
    kp AS (
      SELECT komitent_id, phone8 FROM public.collabbox_customers WHERE komitent_id IS NOT NULL AND length(phone8) = 8
      UNION
      SELECT komitent_id, phone8 FROM public.teleshop_import_customers WHERE komitent_id IS NOT NULL AND length(phone8) = 8
    ),
    docs AS MATERIALIZED (
      SELECT d.doc_number, d.goods_mkd, d.amount_mkd, d.phone8, d.komitent_id, d.komitent_name, d.author_person_id,
             d.order_id, d.related_order_id, d.doc_at, least(d.booked_at, d.doc_at) AS entered,
             public.collabbox_sale_at(d.doc_at, d.booked_at) AS booked
      FROM public.collabbox_documents d
      WHERE d.doc_at >= ('${BT_FROM}'::date - 7)::timestamp AT TIME ZONE 'Europe/Skopje'
        AND d.role IN ('credit', 'order', 'order_unless_held')
        AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
        AND coalesce(d.outcome, '') NOT IN ('storno', 'replacement', 'error') AND coalesce(d.reason, '') <> 'reversed_by_storno'
    ),
    dphone AS MATERIALIZED (
      SELECT x.doc_number, x.phone8 FROM docs x WHERE length(x.phone8) = 8
      UNION
      SELECT x.doc_number, kp.phone8 FROM docs x JOIN kp ON kp.komitent_id = x.komitent_id
    ),
    ev AS (
      SELECT p.*,
        (EXISTS (SELECT 1 FROM public.mex_parcels m WHERE (m.order_id = p.id OR m.tracking_id = p.mex_tracking_id) AND m.created_at_mex <= p.t)
         OR EXISTS (SELECT 1 FROM public.mex_parcels m WHERE length(p.p8) = 8 AND m.phone8 = p.p8
                     AND m.created_at_mex BETWEEN p.s - interval '2 days' AND p.t
                     AND (m.order_id IS NULL OR m.order_id = p.id OR m.linked_at > p.t))
         OR EXISTS (SELECT 1 FROM dphone dp JOIN docs x ON x.doc_number = dp.doc_number
                     WHERE length(p.p8) = 8 AND dp.phone8 = p.p8 AND x.doc_at >= p.s - interval '2 days'
                       AND x.booked >= p.s - interval '2 days' AND x.entered <= p.t
                       AND (x.order_id IS NULL OR x.order_id = p.id) AND (x.related_order_id IS NULL OR x.related_order_id = p.id))
         OR EXISTS (SELECT 1 FROM docs x
                     WHERE x.doc_at >= p.s - interval '2 days' AND x.entered <= p.t
                       AND x.booked BETWEEN p.s - interval '1 day' AND p.s + interval '2 days'
                       AND (x.order_id IS NULL OR x.order_id = p.id) AND (x.related_order_id IS NULL OR x.related_order_id = p.id)
                       AND ((x.author_person_id = p.sold_by_person_id AND x.booked BETWEEN p.s - interval '10 minutes' AND p.s + interval '10 minutes')
                            OR public.collabbox_name_key(x.komitent_name) = public.collabbox_name_key(p.customer_name)))
         OR EXISTS (SELECT 1 FROM docs x
                     WHERE x.doc_at >= p.s - interval '2 days' AND x.entered BETWEEN p.s - interval '2 days' AND least(p.t, p.s + interval '${days + 1} days')
                       AND (x.order_id IS NULL OR x.order_id = p.id) AND (x.related_order_id IS NULL OR x.related_order_id = p.id)
                       AND NOT EXISTS (SELECT 1 FROM dphone dp WHERE dp.doc_number = x.doc_number)
                       AND (abs(coalesce(x.goods_mkd, x.amount_mkd) - round(p.price * 61.5)) <= 3 OR abs(x.amount_mkd - round(p.price * 61.5)) <= 3
                            OR abs(x.amount_mkd - round(p.price * 61.5) - 150) <= 3)
                       AND public.collab_names_share_word(x.komitent_name, p.customer_name))) AS spared,
        (SELECT least(x.booked_at, x.doc_at) FROM public.collabbox_documents x WHERE x.doc_number = p.mex_tracking_id) AS own_entered
      FROM pop p
    )
    SELECT CASE WHEN spared THEN 'spared'
                WHEN own_entered IS NOT NULL AND own_entered <= t THEN 'WRONG'
                WHEN own_entered IS NOT NULL THEN 'late'
                WHEN mex_tracking_id IS NOT NULL THEN 'parcel_without_doc'
                ELSE 'never_shipped' END AS outcome,
           count(*) AS n, round(sum(price) * 61.5) AS mkd
    FROM ev GROUP BY 1 ORDER BY 1`);
  const get = (k) => rows.find((r) => r.outcome === k) ?? { n: 0, mkd: 0 };
  const cancelled = rows.filter((r) => r.outcome !== 'spared').reduce((s, r) => s + Number(r.n), 0);
  const wrong = get('WRONG');
  out('B1', Number(wrong.n) ? 'WARN' : 'PASS',
      `backtest ${BT_FROM}..${BT_TO} as of sale day + ${days} at 21:20: ${rows.reduce((s, r) => s + Number(r.n), 0)} sales · would cancel ${cancelled} — WRONG ${wrong.n} (${Number(wrong.mkd).toLocaleString('mk-MK')} ден) · late ${get('late').n} · never shipped ${get('never_shipped').n} · parcel without a document ${get('parcel_without_doc').n}`);
}

if (JSON_OUT) console.log(JSON.stringify({ results, plan }, null, 1));
process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
