-- ============================================================================
-- TEAMS = BUSINESS LINES (owner ruling 30.09.2026 — plan "Фаза 3")
--
-- A TEAM is a BUSINESS LINE, for the WHOLE history:
--   Телешоп   (teleshop)   ships via NATURA      — lanes: in (the client phones in,
--                                                  e.g. Александра Чима books it) ·
--                                                  out (prediction: agents call
--                                                  existing clients) · social
--                                                  (Социјални мрежи sellers)
--   Affiliate (affiliate)  ships via BIO NATURAL — lanes: in (AlterCPA pending
--                                                  leads) · out (calls to existing
--                                                  clients when there are no leads)
--   Management             not ranked on the boards (lane NULL)
-- The DEPARTMENT of each sale is untouched: still the collabBox folder + the MEX
-- profile (cohort_order_source / order_dept_override / collabbox_department),
-- NEVER the team — scripts/verify-teams.mjs proves no department function reads
-- sales_team_members.
--
-- This migration:
--   sales_teams.kind        line | management | legacy (NOT NULL)
--   sales_teams.sort_order  the order every board lists teams in
--   + teleshop "Телешоп" and affiliate "Affiliate" (kind line); management →
--     kind management; crm_prediction / altercpa_leads → kind legacy (kept as
--     ALIASES so old TV links and old rows keep working; never deleted).
--     leaderboard_mode keeps its meaning (NULL = shown, never ranked = management):
--     affiliate plays the old 'pending' board, teleshop the old 'prediction' one.
--   sales_team_members.lane in | out | social (NULL for management). `role` stays
--     member vs lead — it is NOT a lane.
--   sales_team_line_proposal(p_days)   READ-ONLY: per person, credited sales by
--     department → a proposed line + lane + confidence (Settings → Teams → Предлог).
--   sales_team_lines_apply(p_rows, p_actor)   re-keys memberships IN PLACE
--     (team_key + lane), so the history is relabelled; one audit_log row.
-- Both SECURITY DEFINER, service_role only. Nothing is applied here: the owner
-- accepts rows in Settings → Teams, or the lead runs scripts/apply-team-lines.mjs
-- (--dry-run default → review → --apply --only-sure).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 1. sales_teams: kind + sort_order + the two lines ───────────────────────
ALTER TABLE public.sales_teams
  ADD COLUMN IF NOT EXISTS kind       text,
  ADD COLUMN IF NOT EXISTS sort_order integer;

INSERT INTO public.sales_teams (key, name, leaderboard_mode, kind, sort_order) VALUES
  ('teleshop',  'Телешоп',   'prediction', 'line', 10),
  ('affiliate', 'Affiliate', 'pending',    'line', 20)
ON CONFLICT (key) DO NOTHING;

UPDATE public.sales_teams SET kind = 'management', sort_order = coalesce(sort_order, 90)
 WHERE key = 'management' AND kind IS NULL;
UPDATE public.sales_teams SET kind = 'legacy', sort_order = coalesce(sort_order, 40)
 WHERE key = 'altercpa_leads' AND kind IS NULL;
UPDATE public.sales_teams SET kind = 'legacy', sort_order = coalesce(sort_order, 41)
 WHERE key = 'crm_prediction' AND kind IS NULL;
-- any other team created by hand before this migration: a line, after the known ones
UPDATE public.sales_teams SET kind = 'line' WHERE kind IS NULL;
UPDATE public.sales_teams SET sort_order = 50 WHERE sort_order IS NULL;

ALTER TABLE public.sales_teams
  ALTER COLUMN kind SET DEFAULT 'line',
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN sort_order SET DEFAULT 50,
  ALTER COLUMN sort_order SET NOT NULL,
  DROP CONSTRAINT IF EXISTS sales_teams_kind_check,
  ADD CONSTRAINT sales_teams_kind_check CHECK (kind IN ('line', 'management', 'legacy'));

COMMENT ON COLUMN public.sales_teams.kind IS
  'line = a business line (teleshop, affiliate; members carry a lane) · management = shown, never ranked (lane NULL) · legacy = the pre-30.09.2026 keys crm_prediction / altercpa_leads, kept as aliases (old TV links, old rows) — never a target of sales_team_lines_apply. Owner ruling 30.09.2026, migration 20260943000900.';
COMMENT ON COLUMN public.sales_teams.sort_order IS
  'The order every board lists teams in (ascending). teleshop 10 · affiliate 20 · legacy 40/41 · management 90.';
COMMENT ON TABLE public.sales_teams IS
  'Sales teams = BUSINESS LINES (owner, 30.09.2026): teleshop (ships via NATURA; lanes in/out/social), affiliate (ships via BIO NATURAL; lanes in/out), management (shown, never ranked). crm_prediction / altercpa_leads are legacy aliases. A team NEVER decides a sale''s department (collabBox folder + MEX profile do).';

-- ── 2. sales_team_members.lane ──────────────────────────────────────────────
ALTER TABLE public.sales_team_members
  ADD COLUMN IF NOT EXISTS lane text,
  DROP CONSTRAINT IF EXISTS sales_team_members_lane_check,
  ADD CONSTRAINT sales_team_members_lane_check CHECK (lane IS NULL OR lane IN ('in', 'out', 'social'));

COMMENT ON COLUMN public.sales_team_members.lane IS
  'The lane inside a business line: in (the client comes to us — teleshop phone-ins, AlterCPA pending leads) · out (we call existing clients — prediction lists) · social (Социјални мрежи sellers, teleshop only). NULL for management and legacy rows. role (member | lead) is a different thing.';

CREATE INDEX IF NOT EXISTS idx_sales_team_members_person
  ON public.sales_team_members (person_id, valid_from);

-- ── 3. the proposal (read-only) ─────────────────────────────────────────────
-- Per person (every ACTIVE person, plus every inactive one who still holds a
-- legacy membership — the whole history is relabelled): their credited sales
-- (orders.sold_by_person_id, a real sale: confirmed / shipped / delivered /
-- paid / returned, the owner's test phones excluded) by department
-- (cohort_order_source, 4 arguments — THE mapping), over the last p_days days;
-- fewer than 5 there → the whole history.
--   line   affiliate = altercpa + elyon_crm · teleshop = teleshop_other + teleshop_out + social
--   lane   in = altercpa + teleshop_other · out = elyon_crm + teleshop_out · social = social
--          (affiliate has no social lane: the bigger of in / out)
--   share  min(line share, lane share) of the person's sales in the six departments
--   confidence  sure ≥ 80 % · likely 60–80 % · decide < 60 % or fewer than 5 sales
-- Fallbacks: a management member (or is_manager) → management (sure, whatever
-- they sold) · no sale ever + an altercpa_leads membership → affiliate / in
-- (likely) · no sale ever + a collabBox author handle → teleshop / in (decide) ·
-- nothing → no proposal (decide).
CREATE OR REPLACE FUNCTION public.sales_team_line_proposal(p_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH
prm AS (
  SELECT d AS days, now() - make_interval(days => d) AS since
  FROM (SELECT greatest(1, least(coalesce(p_days, 60), 3650)) AS d) x
),
xp AS (SELECT public.report_excluded_phone8s() AS p8),
mst AS (
  SELECT m.person_id,
         count(*)                                                        AS n_rows,
         count(DISTINCT m.team_key) FILTER (WHERE st.kind <> 'legacy')   AS n_final_teams,
         bool_or(st.kind = 'legacy')                                     AS has_legacy,
         bool_or(m.team_key = 'altercpa_leads')                          AS has_altercpa_team,
         bool_or(m.team_key = 'management' AND m.valid_to IS NULL)       AS in_management
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  GROUP BY m.person_id
),
cur AS (   -- the membership shown today: the open primary one, else the latest
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.lane, st.kind
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  ORDER BY m.person_id, m.is_primary DESC, (m.valid_to IS NULL) DESC, m.valid_from DESC, m.created_at DESC
),
ppl AS (
  SELECT sp.id, sp.display_name, sp.user_id, sp.is_active, sp.is_manager
  FROM public.sales_people sp
  LEFT JOIN mst ON mst.person_id = sp.id
  WHERE sp.is_active OR coalesce(mst.has_legacy, false)
),
-- one pass over the credited sales (~300k orders), folded BEFORE the mapping:
-- cohort_order_source reads the tracking id only through its series patterns
-- (LIKE '___-SSSS-%' — the first 9 characters), so each (person, source,
-- detail, override, left(tracking, 9), in-window) group maps exactly like each
-- of its orders, and the 4-argument mapping (SET search_path: never inlined,
-- one call per row = 9 s) runs a few hundred times. scripts/verify-teams.mjs
-- re-counts the window per person with the per-order mapping (T5).
g AS MATERIALIZED (
  SELECT o.sold_by_person_id AS pid, o.sale_source, o.sale_source_detail, o.dept_override,
         left(o.mex_tracking_id, 9) AS tr9,
         (coalesce(o.sold_at, o.created_at) >= prm.since) AS w,
         count(*) AS n,
         min(coalesce(o.sold_at, o.created_at)) AS first_at,
         max(coalesce(o.sold_at, o.created_at)) AS last_at
  FROM public.orders o, xp, prm
  WHERE o.sold_by_person_id IS NOT NULL
    AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
    AND right(regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g'), 8) <> ALL (coalesce(xp.p8, ARRAY[]::text[]))
  GROUP BY 1, 2, 3, 4, 5, 6
),
s AS (
  SELECT g.pid, public.cohort_order_source(g.sale_source, g.sale_source_detail, g.tr9, g.dept_override) AS dept,
         g.w, g.n, g.first_at, g.last_at
  FROM g
  WHERE g.pid IN (SELECT ppl.id FROM ppl)
),
cnt AS (
  SELECT s.pid,
         coalesce(sum(s.n) FILTER (WHERE s.w AND s.dept = 'altercpa'), 0)       AS w_altercpa,
         coalesce(sum(s.n) FILTER (WHERE s.w AND s.dept = 'elyon_crm'), 0)      AS w_elyon_crm,
         coalesce(sum(s.n) FILTER (WHERE s.w AND s.dept = 'teleshop_other'), 0) AS w_teleshop_other,
         coalesce(sum(s.n) FILTER (WHERE s.w AND s.dept = 'teleshop_out'), 0)   AS w_teleshop_out,
         coalesce(sum(s.n) FILTER (WHERE s.w AND s.dept = 'social'), 0)         AS w_social,
         coalesce(sum(s.n) FILTER (WHERE s.w AND (s.dept IS NULL OR s.dept NOT IN
                    ('altercpa', 'elyon_crm', 'teleshop_other', 'teleshop_out', 'social'))), 0) AS w_other,
         coalesce(sum(s.n) FILTER (WHERE s.dept = 'altercpa'), 0)       AS h_altercpa,
         coalesce(sum(s.n) FILTER (WHERE s.dept = 'elyon_crm'), 0)      AS h_elyon_crm,
         coalesce(sum(s.n) FILTER (WHERE s.dept = 'teleshop_other'), 0) AS h_teleshop_other,
         coalesce(sum(s.n) FILTER (WHERE s.dept = 'teleshop_out'), 0)   AS h_teleshop_out,
         coalesce(sum(s.n) FILTER (WHERE s.dept = 'social'), 0)         AS h_social,
         coalesce(sum(s.n) FILTER (WHERE s.dept IS NULL OR s.dept NOT IN
                    ('altercpa', 'elyon_crm', 'teleshop_other', 'teleshop_out', 'social')), 0) AS h_other,
         min(s.first_at) AS first_at,
         max(s.last_at) AS last_at
  FROM s
  GROUP BY s.pid
),
b0 AS (
  SELECT p.*, c.first_at, c.last_at,
         coalesce(c.w_altercpa, 0) + coalesce(c.w_elyon_crm, 0) + coalesce(c.w_teleshop_other, 0)
           + coalesce(c.w_teleshop_out, 0) + coalesce(c.w_social, 0) AS w_n,
         coalesce(c.h_altercpa, 0) + coalesce(c.h_elyon_crm, 0) + coalesce(c.h_teleshop_other, 0)
           + coalesce(c.h_teleshop_out, 0) + coalesce(c.h_social, 0) AS h_n,
         c.w_altercpa, c.w_elyon_crm, c.w_teleshop_other, c.w_teleshop_out, c.w_social, c.w_other,
         c.h_altercpa, c.h_elyon_crm, c.h_teleshop_other, c.h_teleshop_out, c.h_social, c.h_other
  FROM ppl p
  LEFT JOIN cnt c ON c.pid = p.id
),
-- the counts the proposal reads: the window, or the whole history when the
-- window has fewer than 5 sales and the history has more
b1 AS (
  SELECT b0.*,
         CASE WHEN b0.w_n >= 5 OR b0.h_n <= b0.w_n THEN 'window' ELSE 'history' END AS span
  FROM b0
),
b2 AS (
  SELECT b1.id, b1.display_name, b1.user_id, b1.is_active, b1.is_manager, b1.span, b1.first_at, b1.last_at,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_altercpa, 0)       ELSE coalesce(b1.h_altercpa, 0)       END AS altercpa,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_elyon_crm, 0)      ELSE coalesce(b1.h_elyon_crm, 0)      END AS elyon_crm,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_teleshop_other, 0) ELSE coalesce(b1.h_teleshop_other, 0) END AS teleshop_other,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_teleshop_out, 0)   ELSE coalesce(b1.h_teleshop_out, 0)   END AS teleshop_out,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_social, 0)         ELSE coalesce(b1.h_social, 0)         END AS social,
         CASE WHEN b1.span = 'window' THEN coalesce(b1.w_other, 0)          ELSE coalesce(b1.h_other, 0)          END AS other,
         b1.w_n, b1.h_n
  FROM b1
),
b3 AS (
  SELECT b2.*,
         (b2.altercpa + b2.elyon_crm + b2.teleshop_other + b2.teleshop_out + b2.social) AS n,
         (b2.altercpa + b2.elyon_crm)                          AS aff,
         (b2.teleshop_other + b2.teleshop_out + b2.social)     AS tel,
         (b2.altercpa + b2.teleshop_other)                     AS l_in,
         (b2.elyon_crm + b2.teleshop_out)                      AS l_out,
         b2.social                                             AS l_social
  FROM b2
),
b4 AS (
  SELECT b3.*,
         CASE WHEN b3.n = 0 THEN NULL WHEN b3.aff > b3.tel THEN 'affiliate' ELSE 'teleshop' END AS d_line
  FROM b3
),
b5 AS (
  SELECT b4.*,
         CASE WHEN b4.d_line = 'affiliate' THEN CASE WHEN b4.l_in >= b4.l_out THEN 'in' ELSE 'out' END
              WHEN b4.d_line = 'teleshop'  THEN CASE WHEN b4.l_in >= b4.l_out AND b4.l_in >= b4.l_social THEN 'in'
                                                     WHEN b4.l_out >= b4.l_social THEN 'out' ELSE 'social' END
         END AS d_lane
  FROM b4
),
b6 AS (
  SELECT b5.*,
         CASE WHEN b5.n > 0 THEN round((CASE b5.d_line WHEN 'affiliate' THEN b5.aff ELSE b5.tel END)::numeric / b5.n, 4) END AS line_share,
         CASE WHEN b5.n > 0 THEN round((CASE b5.d_lane WHEN 'in' THEN b5.l_in WHEN 'out' THEN b5.l_out ELSE b5.l_social END)::numeric / b5.n, 4) END AS lane_share
  FROM b5
),
pr AS (
  SELECT b6.*, c.team_key AS cur_team, c.lane AS cur_lane, c.kind AS cur_kind,
         coalesce(m.n_rows, 0) AS n_rows, coalesce(m.n_final_teams, 0) AS n_final_teams,
         coalesce(m.has_legacy, false) AS has_legacy,
         (SELECT coalesce(jsonb_agg(DISTINCT i.kind), '[]'::jsonb) FROM public.sales_person_identities i WHERE i.person_id = b6.id) AS kinds,
         EXISTS (SELECT 1 FROM public.sales_person_identities i WHERE i.person_id = b6.id AND i.kind = 'collabbox_author') AS is_cb_author,
         CASE
           WHEN coalesce(m.in_management, false) OR b6.is_manager THEN 'management'
           WHEN b6.n > 0 THEN b6.span
           WHEN coalesce(m.has_altercpa_team, false) THEN 'altercpa_team'
           WHEN EXISTS (SELECT 1 FROM public.sales_person_identities i WHERE i.person_id = b6.id AND i.kind = 'collabbox_author') THEN 'collabbox_author'
           ELSE 'none'
         END AS basis
  FROM b6
  LEFT JOIN cur c ON c.person_id = b6.id
  LEFT JOIN mst m ON m.person_id = b6.id
),
fin AS (
  SELECT pr.*,
         CASE pr.basis WHEN 'management' THEN 'management' WHEN 'altercpa_team' THEN 'affiliate'
                       WHEN 'collabbox_author' THEN 'teleshop' WHEN 'none' THEN NULL ELSE pr.d_line END AS p_team,
         CASE pr.basis WHEN 'management' THEN NULL WHEN 'altercpa_team' THEN 'in'
                       WHEN 'collabbox_author' THEN 'in' WHEN 'none' THEN NULL ELSE pr.d_lane END AS p_lane,
         CASE WHEN pr.basis IN ('window', 'history') THEN least(pr.line_share, pr.lane_share) END AS share,
         CASE pr.basis
           WHEN 'management'       THEN 'sure'
           WHEN 'altercpa_team'    THEN 'likely'
           WHEN 'collabbox_author' THEN 'decide'
           WHEN 'none'             THEN 'decide'
           ELSE CASE WHEN pr.n < 5 THEN 'decide'
                     WHEN least(pr.line_share, pr.lane_share) >= 0.8 THEN 'sure'
                     WHEN least(pr.line_share, pr.lane_share) >= 0.6 THEN 'likely'
                     ELSE 'decide' END
         END AS confidence
  FROM pr
),
rr AS (
  SELECT fin.*,
         (fin.p_team IS NOT NULL AND fin.n_rows > 0 AND NOT fin.has_legacy AND fin.n_final_teams = 1
          AND fin.cur_team = fin.p_team AND fin.cur_lane IS NOT DISTINCT FROM fin.p_lane) AS unchanged
  FROM fin
)
SELECT jsonb_build_object(
  'generated_at', now(),
  'days',         (SELECT prm.days FROM prm),
  'since',        (SELECT prm.since FROM prm),
  'thresholds',   jsonb_build_object('sure', 0.8, 'likely', 0.6, 'min_sales', 5),
  'summary', (SELECT jsonb_build_object(
      'people',    count(*),
      'sure',      count(*) FILTER (WHERE r.confidence = 'sure'),
      'likely',    count(*) FILTER (WHERE r.confidence = 'likely'),
      'decide',    count(*) FILTER (WHERE r.confidence = 'decide'),
      'unchanged', count(*) FILTER (WHERE r.unchanged),
      'legacy',    count(*) FILTER (WHERE r.has_legacy),
      'no_team',   count(*) FILTER (WHERE r.n_rows = 0))
    FROM rr r),
  'rows', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'person_id',      r.id,
      'display_name',   r.display_name,
      'has_login',      r.user_id IS NOT NULL,
      'is_active',      r.is_active,
      'is_manager',     r.is_manager,
      'identity_kinds', r.kinds,
      'current', jsonb_build_object('team_key', r.cur_team, 'lane', r.cur_lane, 'kind', r.cur_kind,
                                    'memberships', r.n_rows, 'lines', r.n_final_teams, 'legacy', r.has_legacy),
      'basis',          r.basis,
      'span',           r.span,
      'counts', jsonb_build_object('altercpa', r.altercpa, 'elyon_crm', r.elyon_crm,
                                   'teleshop_other', r.teleshop_other, 'teleshop_out', r.teleshop_out,
                                   'social', r.social, 'other', r.other, 'total', r.n),
      'window_sales',   r.w_n,
      'history_sales',  r.h_n,
      'first_sale_at',  r.first_at,
      'last_sale_at',   r.last_at,
      'line_share',     r.line_share,
      'lane_share',     r.lane_share,
      'share',          r.share,
      'confidence',     r.confidence,
      'proposed', jsonb_build_object('team_key', r.p_team, 'lane', r.p_lane),
      'unchanged',      r.unchanged)
    ORDER BY CASE r.confidence WHEN 'sure' THEN 1 WHEN 'likely' THEN 2 ELSE 3 END,
             r.p_team NULLS LAST, r.p_lane NULLS LAST, r.n DESC, lower(r.display_name))
    FROM rr r), '[]'::jsonb)
);
$fn$;

COMMENT ON FUNCTION public.sales_team_line_proposal(integer) IS
  'READ-ONLY proposal (owner ruling 30.09.2026): per active person (+ inactive holders of a legacy membership) their credited sales by department over p_days days (whole history when < 5) → proposed business line (teleshop | affiliate | management) + lane (in | out | social) + confidence (sure ≥ 80 % · likely 60–80 % · decide). Settings → Teams → Предлог; scripts/apply-team-lines.mjs. Never decides a department. Migration 20260943000900.';

-- ── 4. apply: re-key memberships IN PLACE (the whole history) ───────────────
-- p_rows: [{ person_id, team_key, lane, membership_id? }]
--   membership_id given → only that membership row is re-keyed (the per-row lane
--                         selector in Settings → Teams);
--   otherwise           → EVERY membership row of the person (history relabelled;
--                         dates, role and is_primary untouched, so the one-primary
--                         EXCLUDE constraint cannot fire). A person with no
--                         membership gets one primary row from their first sale
--                         (else crm_since / created_at) with no end. A person whose
--                         rows already name two different final teams (a real move
--                         between lines) is refused — re-key those row by row.
-- Rules: team_key must be a line or management team (never a legacy alias);
-- teleshop lanes in / out / social, affiliate lanes in / out, management lane NULL.
-- All-or-nothing: any invalid row → {ok:false, error:'invalid_rows', errors:[…]}
-- and nothing is written. One audit_log row per successful call.
CREATE OR REPLACE FUNCTION public.sales_team_lines_apply(p_rows jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _email    text;
  _n        integer;
  _errors   jsonb := '[]'::jsonb;
  _r        record;
  _before   jsonb;
  _after    jsonb;
  _out      jsonb := '[]'::jsonb;
  _changed  integer := 0;
  _inserted integer := 0;
  _same     integer := 0;
  _cnt      integer;
  _from     date;
  _audit    uuid;
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor_required');
  END IF;
  SELECT u.email INTO _email FROM auth.users u WHERE u.id = p_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor_not_found');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_rows');
  END IF;
  _n := jsonb_array_length(p_rows);
  IF _n = 0 OR _n > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_rows');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _stl_in (
    idx integer, person_id uuid, team_key text, lane text, membership_id uuid, err text
  ) ON COMMIT DROP;
  TRUNCATE _stl_in;

  -- 1. parse (a malformed uuid is an error on that row, not an exception)
  INSERT INTO _stl_in (idx, person_id, team_key, lane, membership_id, err)
  SELECT e.ord - 1,
         CASE WHEN (e.v ->> 'person_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (e.v ->> 'person_id')::uuid END,
         nullif(btrim(coalesce(e.v ->> 'team_key', '')), ''),
         nullif(btrim(coalesce(e.v ->> 'lane', '')), ''),
         CASE WHEN (e.v ->> 'membership_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (e.v ->> 'membership_id')::uuid END,
         CASE WHEN jsonb_typeof(e.v) <> 'object' THEN 'bad_row'
              WHEN NOT coalesce((e.v ->> 'person_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) THEN 'person_not_found'
              WHEN e.v ? 'membership_id' AND e.v ->> 'membership_id' IS NOT NULL
                   AND NOT coalesce((e.v ->> 'membership_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) THEN 'membership_not_found'
         END
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(v, ord);

  -- 2. validate every row (first error wins per row)
  UPDATE _stl_in i SET err = x.err
  FROM (
    SELECT i2.idx,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = i2.person_id) THEN 'person_not_found'
             WHEN i2.team_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = i2.team_key) THEN 'team_not_found'
             WHEN (SELECT t.kind FROM public.sales_teams t WHERE t.key = i2.team_key) = 'legacy' THEN 'legacy_team'
             WHEN (SELECT t.kind FROM public.sales_teams t WHERE t.key = i2.team_key) = 'management' AND i2.lane IS NOT NULL THEN 'lane_not_allowed'
             WHEN (SELECT t.kind FROM public.sales_teams t WHERE t.key = i2.team_key) = 'line' AND i2.lane IS NULL THEN 'lane_required'
             WHEN i2.lane IS NOT NULL AND i2.lane NOT IN ('in', 'out', 'social') THEN 'bad_lane'
             WHEN i2.lane = 'social' AND i2.team_key <> 'teleshop' THEN 'lane_not_allowed'
             WHEN i2.membership_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM public.sales_team_members m WHERE m.id = i2.membership_id AND m.person_id = i2.person_id) THEN 'membership_not_found'
             WHEN i2.membership_id IS NULL AND (
                    SELECT count(DISTINCT m.team_key) FROM public.sales_team_members m
                      JOIN public.sales_teams t ON t.key = m.team_key
                     WHERE m.person_id = i2.person_id AND t.kind <> 'legacy') > 1 THEN 'multiple_lines'
             WHEN (SELECT count(*) FROM _stl_in d
                    WHERE d.person_id = i2.person_id
                      AND coalesce(d.membership_id::text, '*') = coalesce(i2.membership_id::text, '*')) > 1 THEN 'duplicate_row'
             WHEN i2.membership_id IS NULL AND EXISTS (
                    SELECT 1 FROM _stl_in d WHERE d.person_id = i2.person_id AND d.membership_id IS NOT NULL) THEN 'duplicate_row'
           END AS err
    FROM _stl_in i2
    WHERE i2.err IS NULL
  ) x
  WHERE x.idx = i.idx AND x.err IS NOT NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object('index', i.idx, 'person_id', i.person_id, 'error', i.err) ORDER BY i.idx), '[]'::jsonb)
    INTO _errors
    FROM _stl_in i WHERE i.err IS NOT NULL;
  IF jsonb_array_length(_errors) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rows', 'errors', _errors);
  END IF;

  -- 3. lock the people (in id order: two concurrent applies never deadlock)
  PERFORM 1 FROM public.sales_people sp
   WHERE sp.id IN (SELECT i.person_id FROM _stl_in i)
   ORDER BY sp.id
   FOR UPDATE;

  -- 4. re-key
  FOR _r IN SELECT i.* FROM _stl_in i ORDER BY i.idx LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'team_key', m.team_key, 'lane', m.lane,
                                                 'valid_from', m.valid_from, 'valid_to', m.valid_to)
                              ORDER BY m.valid_from), '[]'::jsonb)
      INTO _before
      FROM public.sales_team_members m
     WHERE m.person_id = _r.person_id
       AND (_r.membership_id IS NULL OR m.id = _r.membership_id);

    IF _r.membership_id IS NULL AND jsonb_array_length(_before) = 0 THEN
      -- no membership at all: one primary row covering the person's whole history
      SELECT least(
               (SELECT min((coalesce(o.sold_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date)
                  FROM public.orders o WHERE o.sold_by_person_id = _r.person_id),
               sp.crm_since,
               (sp.created_at AT TIME ZONE 'Europe/Skopje')::date)
        INTO _from
        FROM public.sales_people sp WHERE sp.id = _r.person_id;
      INSERT INTO public.sales_team_members (person_id, team_key, lane, valid_from, valid_to, role, is_primary, note)
      VALUES (_r.person_id, _r.team_key, _r.lane, coalesce(_from, (now() AT TIME ZONE 'Europe/Skopje')::date), NULL,
              'member', true, 'business line (20260943000900)');
      _inserted := _inserted + 1;
    ELSE
      UPDATE public.sales_team_members m
         SET team_key = _r.team_key, lane = _r.lane
       WHERE m.person_id = _r.person_id
         AND (_r.membership_id IS NULL OR m.id = _r.membership_id)
         AND (m.team_key, m.lane) IS DISTINCT FROM (_r.team_key, _r.lane);
      GET DIAGNOSTICS _cnt = ROW_COUNT;
      IF _cnt = 0 THEN _same := _same + 1; ELSE _changed := _changed + _cnt; END IF;
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'team_key', m.team_key, 'lane', m.lane,
                                                 'valid_from', m.valid_from, 'valid_to', m.valid_to)
                              ORDER BY m.valid_from), '[]'::jsonb)
      INTO _after
      FROM public.sales_team_members m
     WHERE m.person_id = _r.person_id
       AND (_r.membership_id IS NULL OR m.id = _r.membership_id);

    _out := _out || jsonb_build_array(jsonb_build_object(
      'person_id', _r.person_id, 'membership_id', _r.membership_id,
      'team_key', _r.team_key, 'lane', _r.lane, 'before', _before, 'after', _after));
  END LOOP;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, _email, 'sales_team.lines_apply', 'sales_team_members',
          CASE WHEN _n = 1 THEN (SELECT i.person_id::text FROM _stl_in i LIMIT 1) END,
          CASE WHEN _n = 1 THEN (SELECT sp.display_name FROM public.sales_people sp
                                  WHERE sp.id = (SELECT i.person_id FROM _stl_in i LIMIT 1))
               ELSE _n || ' people' END,
          jsonb_build_object('rows', _out, 'changed', _changed, 'inserted', _inserted, 'unchanged', _same,
                             'rule', 'teams = business lines, owner 30.09.2026 (20260943000900)'))
  RETURNING id INTO _audit;

  RETURN jsonb_build_object('ok', true, 'changed', _changed, 'inserted', _inserted, 'unchanged', _same,
                            'people', _n, 'audit_id', _audit, 'rows', _out);
END;
$fn$;

COMMENT ON FUNCTION public.sales_team_lines_apply(jsonb, uuid) IS
  'Re-keys sales_team_members IN PLACE (team_key + lane) — the whole history of a person, or one membership when membership_id is given; a person with no membership gets one primary row from their first sale. Line / management targets only (never a legacy alias); lanes: teleshop in|out|social, affiliate in|out, management NULL. All-or-nothing; one audit_log row. Owner ruling 30.09.2026, migration 20260943000900.';

-- ── 5. security: service role only (+ the read-only checker for the proposal) ─
REVOKE ALL ON FUNCTION public.sales_team_line_proposal(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_team_lines_apply(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_team_line_proposal(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_team_lines_apply(jsonb, uuid) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.sales_team_line_proposal(integer) TO supabase_read_only_user';
  END IF;
END
$g$;

NOTIFY pgrst, 'reload schema';

COMMIT;
