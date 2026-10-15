/**
 * verify-approval-hold — READ-ONLY proof of the approval hold (owner 15.10.2026, migration 20261016150000): the AlterCPA
 * approvals of the held operators (app_settings.approval_hold — Dragana #3117, Nina #3917) count in NO report until MEX or
 * collabBox shows them; the 5-day collabBox entry rule cancels the rest.
 *
 *   node scripts/verify-approval-hold.mjs [--list] [--json]
 *
 *   A1  the switch: approval_hold enabled, its operator ids, an owner key; the cron 'approval-hold-refresh' active
 *   A2  every held order (orders.count_held_since) is a candidate: AlterCPA, latest approval a held operator's, no MEX
 *       parcel, pending / confirmed / shipped, not released
 *   A3  every candidate is held or released — WARN for one approved in the last 10 minutes (the refresh runs every 5)
 *   A4  no held order is a counted row of insights_sale_rows (the last 12 Skopje days)
 *   A5  every released order names its evidence (parcel · pushed · in_collab · in_collab_amount · needs_linking)
 *   S   the state: held now per operator (count, value, oldest), released by kind, the ledger of the last 24 h, the
 *       approvals of the last 30 days and what became of them (paid / returned / at MEX / held / cancelled)
 *   --list  the held orders (display id, operator, approval time, age, value, status)
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const args = new Set(process.argv.slice(2));
const LIST = args.has('--list');
const JSON_OUT = args.has('--json');
const RELEASE_KINDS = ['parcel', 'pushed', 'in_collab', 'in_collab_amount', 'needs_linking'];

const results = [];
const out = (id, level, msg, data) => {
  results.push({ id, level, msg, data });
  if (!JSON_OUT) console.log(`${level.padEnd(4)} ${id.padEnd(3)} ${msg}`);
};
const den = (n) => Math.round(Number(n || 0)).toLocaleString('mk-MK');

async function q(sql) {
  try { return await runSql(sql); }
  catch (e) { console.error(`unreachable: ${e.message}`); process.exit(2); }
}

// A1 — the switch and the cron
const [cfg] = await q(`
  SELECT (SELECT value FROM public.app_settings WHERE key = 'approval_hold') AS value,
         public.approval_hold_users() AS users,
         pg_get_functiondef('public.tg_app_settings_guard_owner_keys()'::regprocedure) ~ '''approval_hold''' AS owner_key,
         (SELECT jsonb_build_object('schedule', schedule, 'active', active) FROM cron.job WHERE jobname = 'approval-hold-refresh') AS job`);
{
  const ok = cfg.value?.enabled === true && cfg.users?.length > 0 && cfg.job?.active === true;
  out('A1', ok && cfg.owner_key ? 'PASS' : ok ? 'WARN' : 'FAIL',
    `approval_hold enabled=${cfg.value?.enabled} operators=[${(cfg.users || []).join(', ')}] owner key=${cfg.owner_key} · cron ${cfg.job ? `${cfg.job.schedule} active=${cfg.job.active}` : 'MISSING'}`);
}

// A2 / A3 — the flag ⇔ the candidates
const [fit] = await q(`
  WITH c AS (SELECT * FROM public.approval_hold_candidates()),
  h AS (SELECT o.id, o.count_held_since FROM public.orders o WHERE o.count_held_since IS NOT NULL)
  SELECT
    (SELECT count(*) FROM h) AS held,
    (SELECT count(*) FROM h WHERE NOT EXISTS (SELECT 1 FROM c WHERE c.order_id = h.id)) AS held_not_candidate,
    (SELECT count(*) FROM h WHERE EXISTS (SELECT 1 FROM public.approval_hold_released r WHERE r.order_id = h.id)) AS held_released,
    (SELECT count(*) FROM c WHERE NOT EXISTS (SELECT 1 FROM h WHERE h.id = c.order_id)
        AND NOT EXISTS (SELECT 1 FROM public.approval_hold_released r WHERE r.order_id = c.order_id)
        AND c.decided_at < now() - interval '10 minutes') AS loose_old,
    (SELECT count(*) FROM c WHERE NOT EXISTS (SELECT 1 FROM h WHERE h.id = c.order_id)
        AND NOT EXISTS (SELECT 1 FROM public.approval_hold_released r WHERE r.order_id = c.order_id)
        AND c.decided_at >= now() - interval '10 minutes') AS loose_new`);
out('A2', Number(fit.held_not_candidate) + Number(fit.held_released) === 0 ? 'PASS' : 'FAIL',
  `${fit.held} held — ${fit.held_not_candidate} not a candidate, ${fit.held_released} already released`);
out('A3', Number(fit.loose_old) > 0 ? 'FAIL' : Number(fit.loose_new) > 0 ? 'WARN' : 'PASS',
  `candidates neither held nor released: ${fit.loose_old} older than 10 min, ${fit.loose_new} newer (the next refresh takes them)`);

// A4 — no held order is counted
const [cnt] = await q(`
  SELECT count(*) AS counted, coalesce(sum(s.value_mkd), 0) AS value
  FROM public.insights_sale_rows(((now() AT TIME ZONE 'Europe/Skopje')::date - 12)::timestamp AT TIME ZONE 'Europe/Skopje', now(), false) s
  JOIN public.orders o ON o.id = s.order_id
  WHERE s.in_total AND o.count_held_since IS NOT NULL`);
out('A4', Number(cnt.counted) === 0 ? 'PASS' : 'FAIL', `held orders counted in the cohort (12 days): ${cnt.counted} · ${den(cnt.value)} ден`);

// A5 — released orders name their evidence
const rel = await q(`SELECT kind, count(*) AS n FROM public.approval_hold_released GROUP BY 1 ORDER BY 2 DESC`);
const badRel = rel.filter((r) => !RELEASE_KINDS.includes(r.kind));
out('A5', badRel.length ? 'FAIL' : 'PASS', `released: ${rel.map((r) => `${r.kind} ${r.n}`).join(' · ') || 'none'}`);

// S — the state
const held = await q(`
  SELECT c.altercpa_user AS who, count(*) AS n, round(sum(o.price) * 61.5) AS value, min(o.count_held_since) AS oldest
  FROM public.orders o JOIN public.approval_hold_candidates() c ON c.order_id = o.id
  WHERE o.count_held_since IS NOT NULL GROUP BY 1 ORDER BY 1`);
const names = cfg.value?.people || {};
for (const h of held) out('S', 'INFO', `held now — ${names[h.who] || h.who} #${h.who}: ${h.n} orders · ${den(h.value)} ден · oldest approval ${String(h.oldest).slice(0, 16)}`);
const log = await q(`SELECT action, count(*) AS n FROM public.approval_hold_log WHERE at >= now() - interval '24 hours' GROUP BY 1 ORDER BY 1`);
out('S', 'INFO', `ledger 24 h: ${log.map((r) => `${r.action} ${r.n}`).join(' · ') || 'nothing'}`);
const fate = await q(`
  WITH l AS (
    SELECT DISTINCT ON (l.order_id) l.order_id, l.decided_by_altercpa_user::text AS who
    FROM public.altercpa_leads l
    WHERE l.decision = 'approved' AND l.order_id IS NOT NULL AND l.decided_at >= now() - interval '30 days'
      AND l.decided_by_altercpa_user::text = ANY (public.approval_hold_users())
    ORDER BY l.order_id, l.decided_at DESC)
  SELECT l.who, count(*) AS approved,
         count(*) FILTER (WHERE o.mex_status_id = 2) AS paid,
         count(*) FILTER (WHERE o.mex_status_id = 7) AS returned,
         count(*) FILTER (WHERE o.mex_tracking_id IS NOT NULL AND coalesce(o.mex_status_id, 0) NOT IN (2, 7)) AS at_mex,
         count(*) FILTER (WHERE o.count_held_since IS NOT NULL) AS held,
         count(*) FILTER (WHERE o.mex_tracking_id IS NULL AND o.status::text IN ('cancelled', 'trashed')) AS cancelled_no_parcel
  FROM l JOIN public.orders o ON o.id = l.order_id GROUP BY 1 ORDER BY 1`);
for (const f of fate) {
  out('S', 'INFO', `30 days — ${names[f.who] || f.who}: ${f.approved} approved · paid ${f.paid} · returned ${f.returned} · at MEX ${f.at_mex} · held ${f.held} · cancelled with no parcel ${f.cancelled_no_parcel}`);
}

if (LIST) {
  const rows = await q(`
    SELECT o.display_id, c.altercpa_user AS who, o.count_held_since AS at,
           ((now() AT TIME ZONE 'Europe/Skopje')::date - (o.count_held_since AT TIME ZONE 'Europe/Skopje')::date) AS age,
           round(o.price * 61.5) AS value, o.status::text AS status
    FROM public.orders o JOIN public.approval_hold_candidates() c ON c.order_id = o.id
    WHERE o.count_held_since IS NOT NULL ORDER BY o.count_held_since`);
  if (!JSON_OUT) for (const r of rows) console.log(`  ${r.display_id}  ${(names[r.who] || r.who).padEnd(8)} ${String(r.at).slice(0, 16)}  ${r.age} d  ${den(r.value).padStart(7)} ден  ${r.status}`);
}

if (JSON_OUT) console.log(JSON.stringify({ tool: 'verify-approval-hold', read_only: true, generated_at: new Date().toISOString(), results }, null, 2));
process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
