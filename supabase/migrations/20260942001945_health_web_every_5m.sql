-- Settings → Integrations: the web shop feed runs every 5 minutes (20260942001940 moved web-sync from
-- 3,18,33,48 to 1-59/5). Its job now reads "every 5 min" and goes stale after 20 minutes without a good
-- run (was: "every 15 min", stale after 45). integrations_health re-emitted from its live body with two
-- counted edits; md5 drift guard.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.integrations_health()')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('872db0e0b8a4791df773a355ec836398', 'a5bdca596ab90cd3489f9ec577597891')) THEN
    RAISE EXCEPTION 'integrations_health changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.integrations_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH v AS (
  SELECT now() AS now_ts,
         now() AT TIME ZONE 'Europe/Skopje' AS l,
         (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
         ((((now() AT TIME ZONE 'Europe/Skopje')::date) - 6)::timestamp AT TIME ZONE 'Europe/Skopje') AS since7
),
days AS (
  SELECT (v.today - g)::date AS d FROM v, generate_series(0, 6) g
),
-- The daytime crons: outside their hours "fresh" means "the last run of the day
-- happened". mex = fr_mex_expect of insights_overview (every 15 min 06:00–22:59,
-- 20260942001300); cbx = the collabBox frequent pass (every 15 min 07:00–22:59);
-- acpa_status = the AlterCPA status sync (every 5 min 07:00–20:55).
expect AS (
  SELECT CASE WHEN v.l::time BETWEEN time '06:30' AND time '23:00' THEN v.now_ts
              WHEN v.l::time < time '06:30' THEN ((v.l::date - 1) + time '22:52') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '22:52') AT TIME ZONE 'Europe/Skopje' END AS mex,
         CASE WHEN v.l::time BETWEEN time '07:30' AND time '23:00' THEN v.now_ts
              WHEN v.l::time < time '07:30' THEN ((v.l::date - 1) + time '22:45') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '22:45') AT TIME ZONE 'Europe/Skopje' END AS cbx,
         CASE WHEN v.l::time BETWEEN time '07:30' AND time '21:00' THEN v.now_ts
              WHEN v.l::time < time '07:30' THEN ((v.l::date - 1) + time '20:55') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '20:55') AT TIME ZONE 'Europe/Skopje' END AS acpa_status
    FROM v
),
-- Every sync run of the last 7 Skopje days in one shape, keyed by the card it
-- belongs to (24 h counts and the strip). st: ok (web 'partial' counts, as in
-- the Overview) · failed · running; a run still running after 15 minutes is
-- hung = failed. MEX runs are shared by both accounts: an ok run counts for
-- the account it fetched (skipped ? fetched_<acct>, the Overview's test) with
-- that account's row count; a failed run fails BOTH (it stops before
-- matching, so no order moved).
feed_runs AS (
  SELECT x.fkey, x.job, x.started_at, x.rows_in,
         CASE WHEN x.st = 'running' AND x.started_at < v.now_ts - interval '15 minutes' THEN 'failed'
              ELSE x.st END AS st
    FROM v, (
      SELECT 'altercpa'::text AS fkey, r.kind AS job, r.started_at,
             coalesce(r.ledger_new, 0) AS rows_in,
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END AS st
        FROM public.altercpa_sync_runs r
        JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'mex_' || a.acct, r.kind, r.started_at,
             coalesce((r.skipped ->> ('fetched_' || a.acct))::integer, 0),
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.mex_sync_runs r
        JOIN (VALUES ('bio_natural'), ('natura')) a(acct)
          ON r.status <> 'ok' OR r.skipped ? ('fetched_' || a.acct)
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'web', r.kind, r.started_at,
             coalesce(r.new_orders, 0) + coalesce(r.changed_orders, 0),
             CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.web_sync_runs r
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      -- collabBox (20260942001400): the cron's frequent pass (kind manual, trigger cron) is its
      -- 'rolling' job; the 00:00 nightly; hand-started windows stay 'manual'
      SELECT 'collabbox', CASE WHEN r.kind = 'manual' AND r.trigger_kind = 'cron' THEN 'rolling' ELSE r.kind END,
             r.started_at,
             coalesce(r.created, 0) + coalesce(r.updated, 0) + coalesce(r.credited, 0),
             CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.collabbox_sync_runs r
       WHERE r.started_at >= (SELECT since7 FROM v)
    ) x
),
-- The jobs each card is expected to run (the cron.job schedules), plus any
-- other kind seen this week (a manual backfill …). An expected job that has
-- stopped running entirely still shows — as stale — instead of vanishing.
expected AS (
  SELECT * FROM (VALUES
    ('altercpa',        'rolling',     'rolling_2m'),
    ('altercpa',        'status',      'daytime_5m'),
    ('altercpa',        'nightly',     'nightly'),
    ('altercpa',        'weekly',      'weekly'),
    ('mex_bio_natural', 'rolling',     'daytime_15m'),
    ('mex_bio_natural', 'backfill',    'weekly'),
    ('mex_natura',      'rolling',     'daytime_15m'),
    ('mex_natura',      'backfill',    'weekly'),
    ('web',             'incremental', 'every_5m'),
    ('web',             'backfill',    'nightly'),
    ('collabbox',       'rolling',     'cbx_15m'),
    ('collabbox',       'nightly',     'nightly')
  ) e(fkey, job, expect)
),
job_set AS (
  SELECT e.fkey, e.job, e.expect FROM expected e
  UNION
  SELECT DISTINCT f.fkey, f.job, 'manual' FROM feed_runs f
   WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.fkey = f.fkey AND e.job = f.job)
),
-- Last ok / last settled / last failure per job, over ALL history, each an
-- index-backed "newest matching row" probe (altercpa_sync_runs:
-- (account_id, started_at DESC)); a chronically failing job costs a scan
-- back to its last success, nothing else does.
job_last AS (
  SELECT js.fkey, js.job, js.expect, lo.finished_at AS last_ok, ls.started_at AS last_settled_at, ls.st AS last_status,
         lf.started_at AS last_failed_at, left(lf.error, 1000) AS last_error
    FROM job_set js
    CROSS JOIN v
    LEFT JOIN LATERAL (
      (SELECT r.finished_at FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job AND r.status = 'ok'
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job AND r.status = 'ok'
          AND r.skipped ? ('fetched_' || substr(js.fkey, 5))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job AND r.status IN ('ok', 'partial')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.collabbox_sync_runs r
        WHERE js.fkey = 'collabbox' AND r.status = 'ok'
          AND (CASE WHEN r.kind = 'manual' AND r.trigger_kind = 'cron' THEN 'rolling' ELSE r.kind END) = js.job
        ORDER BY r.started_at DESC LIMIT 1)
    ) lo ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
         FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END
         FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status <> 'ok' OR r.skipped ? ('fetched_' || substr(js.fkey, 5)))
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
         FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
         FROM public.collabbox_sync_runs r
        WHERE js.fkey = 'collabbox'
          AND (CASE WHEN r.kind = 'manual' AND r.trigger_kind = 'cron' THEN 'rolling' ELSE r.kind END) = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
    ) ls ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, r.error FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, r.error FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, coalesce(r.error, r.warning) FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'partial', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, coalesce(r.error, r.warning) FROM public.collabbox_sync_runs r
        WHERE js.fkey = 'collabbox'
          AND (CASE WHEN r.kind = 'manual' AND r.trigger_kind = 'cron' THEN 'rolling' ELSE r.kind END) = js.job
          AND (r.status NOT IN ('ok', 'partial', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
    ) lf ON true
),
job_counts AS (
  SELECT f.fkey, f.job,
         max(f.started_at)                                                                          AS last_run_7d,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st <> 'running') AS runs_24h,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'failed')   AS failed_24h,
         coalesce(sum(f.rows_in) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'ok'), 0) AS rows_24h
    FROM feed_runs f, v
   GROUP BY f.fkey, f.job
),
jobs_status AS (
  SELECT jl.*,
         coalesce(jc.last_run_7d, jl.last_settled_at) AS last_run,
         coalesce(jc.runs_24h, 0) AS runs_24h, coalesce(jc.failed_24h, 0) AS failed_24h, coalesce(jc.rows_24h, 0) AS rows_24h,
         CASE
           WHEN jl.last_status = 'failed' THEN 'failing'
           WHEN jl.last_ok IS NULL THEN CASE WHEN jl.expect = 'manual' THEN 'n/a' ELSE 'failing' END
           WHEN jl.expect = 'rolling_2m'  AND jl.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_5m'  AND jl.last_ok < e.acpa_status - interval '30 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_30m' AND jl.last_ok < e.mex - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_15m' AND jl.last_ok < e.mex - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'cbx_15m'     AND jl.last_ok < e.cbx - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'every_15m'   AND jl.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'every_5m'    AND jl.last_ok < v.now_ts - interval '20 minutes' THEN 'stale'
           WHEN jl.expect = 'nightly'     AND jl.last_ok < v.now_ts - interval '26 hours' THEN 'stale'
           WHEN jl.expect = 'weekly'      AND jl.last_ok < v.now_ts - interval '8 days' THEN 'stale'
           ELSE 'ok'
         END AS status
    FROM job_last jl
    LEFT JOIN job_counts jc ON jc.fkey = jl.fkey AND jc.job = jl.job
    CROSS JOIN v
    CROSS JOIN expect e
),
feed_agg AS (
  SELECT js.fkey,
         jsonb_agg(jsonb_build_object(
           'job', js.job, 'expect', js.expect, 'status', js.status,
           'last_ok_at', js.last_ok, 'last_run_at', js.last_run, 'last_run_status', js.last_status,
           'last_error', js.last_error, 'last_error_at', js.last_failed_at,
           'runs_24h', js.runs_24h, 'failed_24h', js.failed_24h, 'rows_24h', js.rows_24h)
           ORDER BY CASE js.job WHEN 'rolling' THEN 0 WHEN 'incremental' THEN 0 WHEN 'status' THEN 1
                                WHEN 'nightly' THEN 2 WHEN 'weekly' THEN 3 WHEN 'backfill' THEN 4 ELSE 5 END,
                    js.job) AS jobs,
         sum(js.runs_24h)       AS runs_24h,
         sum(js.failed_24h)     AS failed_24h,
         max(js.last_run)       AS last_run_at,
         max(js.last_failed_at) AS last_failed_at,
         (array_agg(js.last_error ORDER BY js.last_failed_at DESC NULLS LAST))[1] AS last_error
    FROM jobs_status js
   GROUP BY js.fkey
),
-- 7-day strip: settled runs per Skopje day.
strip AS (
  SELECT f.fkey, (f.started_at AT TIME ZONE 'Europe/Skopje')::date AS d,
         count(*) FILTER (WHERE f.st = 'ok')     AS ok,
         count(*) FILTER (WHERE f.st = 'failed') AS failed
    FROM feed_runs f
   GROUP BY 1, 2
),
strips AS (
  SELECT fk.k AS fkey,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM (VALUES ('altercpa'), ('mex_bio_natural'), ('mex_natura'), ('web'), ('collabbox')) fk(k)
    CROSS JOIN days d
    LEFT JOIN strip s ON s.fkey = fk.k AND s.d = d.d
   GROUP BY fk.k
),
-- ── headline statuses: the Overview's frj formulas ─────────────────────────
-- AlterCPA: the rolling job alone. MEX: last ok for the account in 10 days
-- (else the register's last sighting); last status = the newest settled MEX
-- run of any kind in 10 days (both cards share it, as in the Overview). Web:
-- any kind.
h_acpa AS (
  SELECT js.last_ok, js.last_status FROM jobs_status js WHERE js.fkey = 'altercpa' AND js.job = 'rolling'
),
mex_last AS (
  SELECT CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
    FROM public.mex_sync_runs r, v
   WHERE r.started_at > v.now_ts - interval '10 days'
     AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
   ORDER BY r.started_at DESC
   LIMIT 1
),
parcels AS (
  SELECT p.account,
         max(p.last_seen_at)   AS last_seen,
         max(p.last_update_at) AS data_through,
         count(*) FILTER (WHERE p.created_at_mex > v.now_ts - interval '24 hours') AS parcels_new,
         count(*) FILTER (WHERE p.last_update_at > v.now_ts - interval '24 hours') AS parcels_moved,
         count(*) FILTER (WHERE p.delivered_at   > v.now_ts - interval '24 hours') AS delivered,
         count(*) FILTER (WHERE p.returned_at    > v.now_ts - interval '24 hours') AS returned
    FROM public.mex_parcels p, v
   GROUP BY p.account
),
h_mex AS (
  SELECT a.acct,
         coalesce((SELECT max(r.finished_at) FROM public.mex_sync_runs r, v
                    WHERE r.status = 'ok' AND r.started_at > v.now_ts - interval '10 days'
                      AND r.skipped ? ('fetched_' || a.acct)),
                  pc.last_seen) AS last_ok,
         (SELECT st FROM mex_last) AS last_status,
         pc.data_through,
         jsonb_build_object('parcels_new', coalesce(pc.parcels_new, 0), 'parcels_moved', coalesce(pc.parcels_moved, 0),
                            'delivered', coalesce(pc.delivered, 0), 'returned', coalesce(pc.returned, 0)) AS rows
    FROM (VALUES ('bio_natural'), ('natura')) a(acct)
    LEFT JOIN parcels pc ON pc.account = a.acct
),
h_web AS (
  SELECT (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')) AS last_ok,
         (SELECT CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
            FROM public.web_sync_runs r, v
           WHERE NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
           ORDER BY r.started_at DESC LIMIT 1) AS last_status
),
-- ── rows that came in ──────────────────────────────────────────────────────
r_acpa AS (
  SELECT count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours')                                  AS leads_new,
         count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours' AND upper(coalesce(l.geo, '')) = 'MK') AS leads_mk,
         count(*) FILTER (WHERE l.first_seen_at >= (v.today::timestamp AT TIME ZONE 'Europe/Skopje'))             AS leads_today
    FROM public.altercpa_leads l, v
   WHERE l.first_seen_at > v.now_ts - interval '2 days'
),
r_acpa_runs AS (
  SELECT coalesce(sum(r.orders_created) FILTER (WHERE r.status = 'ok'), 0) AS orders_created,
         coalesce(sum(r.orders_updated) FILTER (WHERE r.status = 'ok'), 0) AS orders_updated
    FROM public.altercpa_sync_runs r
    JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
    CROSS JOIN v
   WHERE r.started_at > v.now_ts - interval '24 hours'
),
r_web AS (
  SELECT (SELECT count(*) FROM public.web_orders w, v WHERE w.created_at > v.now_ts - interval '24 hours') AS orders_new,
         (SELECT coalesce(sum(r.changed_orders), 0) FROM public.web_sync_runs r, v
           WHERE r.started_at > v.now_ts - interval '24 hours' AND r.status IN ('ok', 'partial')) AS orders_changed
),
-- collabBox: the headline status is whatever THE helper says (collabbox_feed_state —
-- the Overview reads the same); runs, jobs and the strip come from collabbox_sync_runs
-- (20260942001400).
cb AS (
  SELECT public.collabbox_feed_state() AS j
),
-- ── pg_cron ────────────────────────────────────────────────────────────────
-- job_run_details (never purged; 213k rows on 2026-09-28) has only its runid
-- primary key. runid is monotonic, so the newest 50.000 runs are a PK range
-- scan instead of a full-table seq scan — ~12 days at today's ~4.100 runs/day,
-- the 8 days read here with room for the schedule to grow by half. Past that
-- the strip's oldest days read short; they never read wrong.
cron_runs AS (
  SELECT d.jobid, d.status, d.start_time, d.end_time, d.return_message
    FROM cron.job_run_details d, v
   WHERE d.runid > (SELECT coalesce(max(x.runid), 0) - 50000 FROM cron.job_run_details x)
     AND d.start_time >= v.now_ts - interval '8 days'
),
cron_agg AS (
  SELECT c.jobid,
         max(c.start_time)                                                   AS last_start,
         max(c.start_time) FILTER (WHERE c.status = 'failed')               AS last_failed,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours') AS runs_24h,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours' AND c.status = 'failed') AS failed_24h
    FROM cron_runs c, v
   GROUP BY c.jobid
),
cron_last AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.status, c.start_time, c.end_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_start
   ORDER BY a.jobid
),
cron_fail AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.start_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_failed AND c.status = 'failed'
   ORDER BY a.jobid
),
cron_strip AS (
  SELECT j.jobid,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM cron.job j
    CROSS JOIN days d
    LEFT JOIN (SELECT c.jobid, (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d,
                      count(*) FILTER (WHERE c.status = 'succeeded') AS ok,
                      count(*) FILTER (WHERE c.status = 'failed')    AS failed
                 FROM cron_runs c, v
                WHERE c.start_time >= v.since7
                GROUP BY 1, 2) s ON s.jobid = j.jobid AND s.d = d.d
   GROUP BY j.jobid
),
cron_json AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
           -- pg_cron "succeeded" on an invoke_* job only means the HTTP call was
           -- queued; the feed cards above say whether the sync itself worked.
           'status', CASE WHEN NOT j.active THEN 'n/a'
                          WHEN cl.jobid IS NULL THEN 'n/a'
                          WHEN cl.status = 'failed' THEN 'failing'
                          ELSE 'ok' END,
           'last_status', cl.status, 'last_start', cl.start_time, 'last_end', cl.end_time,
           'last_message', cl.msg,
           'last_error', cf.msg, 'last_error_at', cf.start_time,
           'runs_24h', coalesce(ca.runs_24h, 0), 'failed_24h', coalesce(ca.failed_24h, 0),
           'days', cs.days)
         ORDER BY j.jobname), '[]'::jsonb) AS j
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
    LEFT JOIN cron_fail cf ON cf.jobid = j.jobid
    LEFT JOIN cron_agg ca ON ca.jobid = j.jobid
    LEFT JOIN cron_strip cs ON cs.jobid = j.jobid
),
-- ── the no-parcel rule (days: app_settings, no_parcel_rule_days()) ─────────
np AS (
  SELECT c.cfg,
         coalesce(c.cfg ->> 'mode', 'report') AS mode,
         public.no_parcel_rule_days() AS days_n,
         coalesce((c.cfg ->> 'hour')::int, 21) AS hour_n
    FROM (SELECT coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'no_parcel_rule'), '{}'::jsonb) AS cfg) c
),
np_runs AS (
  SELECT max(r.ran_at) AS last_any,
         max(r.ran_at) FILTER (WHERE r.trigger_kind = 'cron') AS last_cron,
         bool_or(r.run_day = v.today AND r.trigger_kind = 'cron') AS cron_today,
         count(*) FILTER (WHERE r.ran_at > v.now_ts - interval '24 hours') AS runs_24h
    FROM public.no_parcel_rule_runs r, v
),
np_slot AS (
  -- The scheduled slot (hour:10 Skopje — apply_no_parcel_rule's own gate)
  -- that should already have run, and the next one.
  SELECT np.*, nr.*,
         CASE WHEN v.l >= (v.today + make_time(np.hour_n, 10, 0))
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today - 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS last_slot,
         CASE WHEN v.l < (v.today + make_time(np.hour_n, 10, 0)) AND NOT coalesce(nr.cron_today, false)
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today + 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS next_run
    FROM np CROSS JOIN np_runs nr CROSS JOIN v
),
np_job AS (
  SELECT j.jobid, j.active, cl.status AS last_status, cl.start_time, cl.msg
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
   WHERE j.jobname = 'no-parcel-rule'
   LIMIT 1
),
np_strip AS (
  SELECT jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.n, 0), 'failed', coalesce(f.n, 0),
                                      'to_cancel', s.to_cancel, 'cancelled', s.cancelled)
                   ORDER BY d.d) AS days
    FROM days d
    LEFT JOIN (SELECT r.run_day AS d, count(*) AS n,
                      (array_agg(r.to_cancel ORDER BY r.ran_at DESC))[1] AS to_cancel,
                      sum(r.cancelled) AS cancelled
                 FROM public.no_parcel_rule_runs r, v
                WHERE r.run_day >= v.today - 6
                GROUP BY r.run_day) s ON s.d = d.d
    LEFT JOIN (SELECT (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d, count(*) AS n
                 FROM cron_runs c JOIN np_job nj ON nj.jobid = c.jobid
                WHERE c.status = 'failed'
                GROUP BY 1) f ON f.d = d.d
),
np_json AS (
  SELECT jsonb_build_object(
    'key', 'no_parcel_rule',
    'settings', s.cfg,
    'mode', s.mode,
    'days_n', s.days_n,
    'hour', s.hour_n,
    'status', CASE WHEN nj.jobid IS NULL OR NOT nj.active THEN 'n/a'
                   WHEN nj.last_status = 'failed' THEN 'failing'
                   -- nothing ran since the slot that should have (20 min grace)
                   WHEN v.now_ts > s.last_slot + interval '20 minutes'
                        AND coalesce(s.last_any, '-infinity'::timestamptz) < s.last_slot - interval '10 minutes' THEN 'stale'
                   ELSE 'ok' END,
    'last_ok_at', s.last_any,
    'last_cron_run_at', s.last_cron,
    'next_run_at', s.next_run,
    'last_run', (SELECT to_jsonb(r) - 'settings' FROM public.no_parcel_rule_runs r ORDER BY r.ran_at DESC LIMIT 1),
    'cron_last_status', nj.last_status,
    'cron_last_at', nj.start_time,
    'last_error', CASE WHEN nj.last_status = 'failed' THEN nj.msg END,
    'runs_24h', s.runs_24h,
    'days', (SELECT days FROM np_strip)) AS j
    FROM np_slot s
    CROSS JOIN v
    LEFT JOIN np_job nj ON true
),
feed_json AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_build_object(
       'key', 'altercpa',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('leads_new', ra.leads_new, 'leads_mk', ra.leads_mk,
                                  'orders_created', rr.orders_created, 'orders_updated', rr.orders_updated),
       'leads_today', ra.leads_today,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_acpa ra CROSS JOIN r_acpa_runs rr
       LEFT JOIN h_acpa h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'altercpa'
       LEFT JOIN strips st ON st.fkey = 'altercpa'),
    (SELECT jsonb_build_object(
       'key', 'mex_bio_natural',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_bio_natural'
       LEFT JOIN strips st ON st.fkey = 'mex_bio_natural'
      WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'key', 'mex_natura',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_natura'
       LEFT JOIN strips st ON st.fkey = 'mex_natura'
      WHERE m.acct = 'natura'),
    (SELECT jsonb_build_object(
       'key', 'web',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status = 'failed' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('orders_new', rw.orders_new, 'orders_changed', rw.orders_changed),
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_web rw
       LEFT JOIN h_web h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'web'
       LEFT JOIN strips st ON st.fkey = 'web'),
    (SELECT jsonb_build_object(
       'key', 'collabbox',
       -- the helper speaks the Overview's words (failed); this page says failing
       'status', CASE WHEN c.j ->> 'status' = 'failed' THEN 'failing'
                      WHEN c.j ->> 'status' IN ('ok', 'stale', 'failing') THEN c.j ->> 'status'
                      ELSE 'n/a' END,
       'last_ok_at', c.j -> 'last_ok_at', 'data_through', c.j -> 'data_through',
       'detail', c.j -> 'detail',
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('lag_parcels', coalesce((c.j ->> 'lag_parcels')::bigint, 0)),
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM cb c
       LEFT JOIN feed_agg fa ON fa.fkey = 'collabbox'
       LEFT JOIN strips st ON st.fkey = 'collabbox')
  ) AS j
)
SELECT jsonb_build_object(
  'generated_at', (SELECT now_ts FROM v),
  'today', (SELECT today FROM v),
  'feeds', (SELECT j FROM feed_json),
  'no_parcel', (SELECT j FROM np_json),
  'cron', (SELECT j FROM cron_json)
);
$function$;

COMMIT;
