-- Skopje time everywhere (owner 01.10.2026: "we need to match everywhere that it's the same time").
--
-- Two date columns defaulted to the DATABASE's day, which is UTC (the server runs in UTC):
-- between 00:00 and 01:00/02:00 Skopje that is still yesterday.
--   leaderboard_roster.roster_date   DEFAULT CURRENT_DATE
--   agent_payouts.paid_on            DEFAULT (timezone('utc', now()))::date
-- Both now default to the Skopje day, like collabbox_sync_runs.run_day already does.
--
-- Defaults only: no row changes, no figure moves. Today the api always sends both values (the
-- roster with the Skopje day, a settlement with the operator's paid_on), so the defaults only
-- matter to a script or a future writer that leaves them out.

BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.leaderboard_roster
  ALTER COLUMN roster_date SET DEFAULT ((now() AT TIME ZONE 'Europe/Skopje'))::date;

ALTER TABLE public.agent_payouts
  ALTER COLUMN paid_on SET DEFAULT ((now() AT TIME ZONE 'Europe/Skopje'))::date;

COMMIT;
