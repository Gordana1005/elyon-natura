-- /calls: the outcome IS the call log (plan "Фаза 11 — Нарачки и Повици", /calls part, 01.10.2026).
--
-- Why: VOIP is off in Macedonia (telephony is Phase 2). Agents dial from their OWN handsets, so the
-- big green "Call" button was pressed once in a week and call_logs held 767 rows that week, 766 of
-- them a "no answer" from the outcome dialog — a cancel, a trash or a confirm left no call row at all.
-- From now on every outcome recorded on /calls (POST /api/calls/outcome) writes exactly ONE call_logs
-- row, and this column says where that row came from:
--   handset — the agent called from their own phone; the row is the outcome they recorded
--             (started_at = the moment they tapped the tel: link / copied the number, when known;
--             connected_at collapses to started_at when answered — the interim-timing rule of
--             12.08, so ring_seconds = 0 and talk = total = agent-reported handling time);
--   voip    — reserved for the WebRTC softphone once the A1 trunk lands.
-- NULL = every row written before this migration, and POST /api/call-logs (old bundles, VOIP).
--
-- Nullable, no default, no backfill: ADD COLUMN is metadata-only and the CHECK validates the existing
-- rows (all NULL) in one pass over a small table. ring/talk/total_seconds stay GENERATED ALWAYS.
--
-- Deploy order: this migration → the api (POST /calls/outcome writes the column; it retries without
-- it on "column does not exist", so a reversed order degrades, it does not break) → the frontend.
-- Rollback: ALTER TABLE public.call_logs DROP COLUMN source;  (nothing else references it)

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS source text;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_source_check;
ALTER TABLE public.call_logs
  ADD CONSTRAINT call_logs_source_check CHECK (source IS NULL OR source IN ('handset', 'voip'));

COMMENT ON COLUMN public.call_logs.source IS
  'Where the row came from: handset = an outcome recorded on /calls while the agent dialled from their '
  'own phone (POST /api/calls/outcome, 20260943001700); voip = the softphone (reserved). NULL = older '
  'rows and POST /api/call-logs.';
