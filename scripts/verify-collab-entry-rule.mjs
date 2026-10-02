/**
 * verify-collab-entry-rule — READ-ONLY proof of the owner's 02.10.2026 collabBox rules (migrations
 * 20260947000200 the 2-day collabBox entry rule, 20260947000300 a CRM sale's department from its own booking).
 *
 *   node scripts/verify-collab-entry-rule.mjs [--list] [--json]
 *
 *   E1  the owner switch app_settings.collab_entry_rule (mode report | apply, days, hour, from_date, warn) is an owner
 *       key (tg_app_settings_guard_owner_keys) and the cron 'collab-entry-rule' runs '20 * * * *'
 *   E2  the plan now: candidates · in_collab · needs_linking · warn · cancel (+ value) — every planned cancel is,
 *       re-checked by an INDEPENDENT query, a confirmed elyon_crm prediction_list / direct sale with no parcel, ≥ days
 *       Skopje days old and with no collabBox document that names it
 *   E3  the ledger: the last runs (mode, counts, cancelled, warned, undone); in report mode nothing was cancelled and no
 *       bell was written
 *   E4  every order the rule cancelled is still cancelled with the rule's note, or was undone / revived by a parcel
 *   D1  the cron 'crm-sale-booking-dept' runs '7,22,37,52 * * * *'
 *   D2  every confirmed CRM sale without a parcel (≤ 60 days) holds dept_override = crm_sale_booking_dept (WARN while a
 *       booking arrived after the last 15-minute pass)
 *   D3  the departments of the open CRM sales: booked (by folder) vs provisional (no booking yet)
 *
 *   --list  prints the planned cancels / warnings (order, seller, sale day, age, price) — the list the owner sees before
 *           switching to apply.
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
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

// E1 — the switch and the cron
{
  const [s] = await q(`SELECT (SELECT value FROM public.app_settings WHERE key = 'collab_entry_rule') AS cfg,
      (SELECT prosrc LIKE '%''collab_entry_rule''%' FROM pg_proc WHERE proname = 'tg_app_settings_guard_owner_keys') AS guarded,
      (SELECT schedule FROM cron.job WHERE jobname = 'collab-entry-rule') AS sched,
      (SELECT active FROM cron.job WHERE jobname = 'collab-entry-rule') AS active`);
  const cfg = s?.cfg ?? null;
  const ok = cfg && ['report', 'apply'].includes(cfg.mode) && s.guarded && s.sched === '20 * * * *' && s.active;
  out('E1', ok ? 'PASS' : 'FAIL',
      `switch ${JSON.stringify(cfg)} · owner key ${s?.guarded ? 'yes' : 'NO'} · cron ${s?.sched ?? 'MISSING'}${s?.active ? '' : ' (inactive)'}`);
}

// E2 — the plan, re-checked independently
const plan = await q(`SELECT p.*, o.confirmed_by_name AS seller, sp.display_name AS seller_person
  FROM public.collab_entry_rule_plan() p
  JOIN public.orders o ON o.id = p.order_id
  LEFT JOIN public.sales_people sp ON sp.id = p.sold_by_person_id
  ORDER BY p.sold_at`);
{
  const by = (a) => plan.filter((r) => r.plan_action === a);
  const cancels = by('cancel');
  const value = cancels.reduce((s, r) => s + Number(r.price_eur || 0), 0);
  out('E2', 'INFO', `plan now: ${plan.length} candidates · in_collab ${by('in_collab').length} · needs_linking ${by('needs_linking').length} · warn ${by('warn').length} · cancel ${cancels.length} (€${value.toFixed(2)} ≈ ${Math.round(value * 61.5).toLocaleString('mk-MK')} ден)`);
  if (cancels.length) {
    const ids = cancels.map((r) => `'${r.order_id}'`).join(',');
    const bad = await q(`SELECT o.display_id FROM public.orders o
      WHERE o.id IN (${ids})
        AND NOT (o.status = 'confirmed' AND o.sale_source = 'elyon_crm'
                 AND o.sale_source_detail IN ('prediction_list', 'direct') AND o.mex_tracking_id IS NULL
                 AND ((now() AT TIME ZONE 'Europe/Skopje')::date
                      - (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date)
                     >= coalesce(((SELECT value FROM public.app_settings WHERE key = 'collab_entry_rule')->>'days')::int, 2)
                 AND NOT EXISTS (SELECT 1 FROM public.collabbox_documents d
                                  WHERE (d.order_id = o.id OR d.related_order_id = o.id) AND NOT coalesce(d.is_storno, false)))`);
    out('E2', bad.length ? 'FAIL' : 'PASS',
        bad.length ? `planned cancels that fail the independent check: ${bad.map((r) => r.display_id).join(', ')}`
                   : `every planned cancel re-checked independently (${cancels.length})`);
  }
  if (LIST && !JSON_OUT) {
    for (const a of ['cancel', 'warn']) {
      const rows = by(a);
      if (!rows.length) continue;
      console.log(`\n  ${a === 'cancel' ? 'СЕ ОТКАЖУВА' : 'ПРЕДУПРЕДУВАЊЕ (утре се откажува)'} — ${rows.length}`);
      for (const r of rows) {
        console.log(`    ${String(r.display_id).padEnd(11)} ${String(r.sale_day).slice(0, 10)}  ${String(r.age_days).padStart(3)} д  €${Number(r.price_eur).toFixed(2).padStart(7)}  ${r.seller_person || r.seller || '?'}`);
      }
    }
    console.log('');
  }
}

// E3 — the ledger
{
  const runs = await q(`SELECT run_day, mode, trigger_kind, candidates, to_cancel, to_warn, in_collab, needs_linking,
                               cancelled, warned, undone
                          FROM public.collab_entry_rule_runs ORDER BY ran_at DESC LIMIT 5`);
  if (!runs.length) out('E3', 'INFO', 'no run yet (the cron acts at 21:20 Skopje)');
  for (const r of runs) {
    const bad = r.mode === 'report' && (r.cancelled > 0 || r.warned > 0);
    out('E3', bad ? 'FAIL' : 'INFO',
        `${r.run_day} ${r.mode}/${r.trigger_kind}: candidates ${r.candidates} · cancel ${r.to_cancel} · warn ${r.to_warn} · in_collab ${r.in_collab} · needs_linking ${r.needs_linking} → cancelled ${r.cancelled} · warned ${r.warned}${r.undone ? ` · undone ${r.undone}` : ''}`);
  }
}

// E4 — every cancel the rule made is still the rule's, undone, or revived by a parcel
{
  const [r] = await q(`SELECT count(*) AS n,
      count(*) FILTER (WHERE o.status = 'cancelled' AND o.cancellation_reason_notes LIKE 'not_in_collab_2d:%') AS still,
      count(*) FILTER (WHERE o.mex_tracking_id IS NOT NULL) AS with_parcel,
      count(*) FILTER (WHERE NOT (o.status = 'cancelled' AND o.cancellation_reason_notes LIKE 'not_in_collab_2d:%')
                         AND o.mex_tracking_id IS NULL) AS moved
    FROM public.collab_entry_rule_items i JOIN public.orders o ON o.id = i.order_id
    WHERE i.action = 'cancelled'`);
  out('E4', Number(r.moved) ? 'WARN' : 'PASS',
      `rule cancels: ${r.n} · still the rule's ${r.still} · revived by a parcel ${r.with_parcel} · changed by hand ${r.moved}`);
}

// D1 / D2 / D3 — the booking department
{
  const [c] = await q(`SELECT schedule, active FROM cron.job WHERE jobname = 'crm-sale-booking-dept'`);
  out('D1', c?.schedule === '7,22,37,52 * * * *' && c?.active ? 'PASS' : 'FAIL', `cron crm-sale-booking-dept ${c?.schedule ?? 'MISSING'}`);
  const rows = await q(`SELECT o.display_id, o.dept_override AS cur, public.crm_sale_booking_dept(o.id) AS want,
      public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept
    FROM public.orders o
    WHERE o.status = 'confirmed' AND o.sale_source = 'elyon_crm' AND o.sale_source_detail IN ('prediction_list', 'direct')
      AND o.mex_tracking_id IS NULL
      AND coalesce(o.sold_at, o.confirmed_at, o.created_at) >= now() - interval '60 days'`);
  const drift = rows.filter((r) => (r.cur ?? null) !== (r.want ?? null));
  out('D2', drift.length ? 'WARN' : 'PASS',
      drift.length ? `${drift.length} open CRM sale(s) whose booking changed since the last 15-minute pass: ${drift.slice(0, 10).map((r) => r.display_id).join(', ')}`
                   : `every open CRM sale holds its booking's department (${rows.length})`);
  const tally = {};
  for (const r of rows) {
    const k = `${r.want ? 'внесена' : 'привремено'} → ${r.dept}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  out('D3', 'INFO', `open CRM sales: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
}

if (JSON_OUT) console.log(JSON.stringify({ results, plan }, null, 1));
process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
