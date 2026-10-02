-- ============================================================================
-- The seller's team decides from 01.01.2026 (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "од 1 Јануари треба да го направиш до сега колку е возможно за сега, за порано само активните агенти кои се
--   нека одлучуваат а за тие што не се веќе дел од тимот можаш кај сакаш да ги вметнеш или каде мислиш дека е потребно."
-- The team memberships (sales_team_members) began on the day each person entered the CRM (≈ 05.08 for Affiliate,
-- 01–09.09 for Телешоп), so 20260947000400's team rule reached only that far back; 2026 sales before it kept their
-- folder department. This migration dates the memberships back to 01.01.2026:
--   (1) every ACTIVE person with a 2026 sale on a day no line / management membership covers: the person's EARLIEST
--       membership starts 01.01.2026 instead (their current team decides — the owner's rule; 32 people);
--   (2) Slobodanka Petrova is the one exception the data forces: her own collabBox bookings are "Нарачка out" in
--       March–May 2026 (104 / 148 / 79), LEADS-OUT from June, LEADS from July — so Тим Центар Out 01.01–31.05 (a new
--       membership) and her Affiliate membership from 01.06 (was 05.08);
--   (3) former staff with 2026 sales, by their own folders: Marija Markovska and Teodora Kostovska (Affiliate, their own
--       memberships from 01.01), Марија Бошковска (21 LEADS-OUT sales → affiliate:out 26.01–05.03, not primary — her
--       legacy membership stays primary), Симона Саздовска (2 "Нарачка out" on 02.01 → teleshop:out 01.01–02.01, not
--       primary).
-- Management memberships move to 01.01 too (Teodora Krstevska, Dzenet Ramadani, Nina …): no effect on any department
-- until Менаџмент becomes its own category (the next migration) — their 2026 sales keep their folder until then.
-- The team-change trigger is paused for the batch; the persons' orders are re-decided ONCE, set-based (the same
-- decision as order_dept_decide — 20260947000400's backfill shape), each move kept in dept_history_backfill.
-- Every membership change → one audit_log row (actor = the owner's account, by = claude-code).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF to_regprocedure('public.order_dept_decide(text,text,uuid,timestamptz,text,text,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sales_team_members'::regclass AND tgname = 'tg_sales_team_members_dept')
     OR NOT EXISTS (SELECT 1 FROM public.sales_team_members m JOIN public.sales_people p ON p.id = m.person_id
                     WHERE p.display_name = 'Slobodanka Petrova' AND m.team_key = 'affiliate' AND m.valid_from = date '2026-08-05') THEN
    RAISE EXCEPTION 'team history 2026: 20260947000400 / the members trigger / Slobodanka''s membership changed since this migration was written';
  END IF;
END
$drift$;

CREATE TABLE IF NOT EXISTS public.dept_history_backfill (
  run_tag           text NOT NULL,
  order_id          uuid NOT NULL,
  old_dept          text,
  new_dept          text,
  old_dept_override text,
  moved_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_tag, order_id)
);
COMMENT ON TABLE public.dept_history_backfill IS
  'Owner 02.10.2026: orders whose department moved in a dated team-history backfill (run_tag), old → new + the old dept_override for an undo. Owner-only.';
ALTER TABLE public.dept_history_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dept_history_backfill FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dept_history_backfill TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.dept_history_backfill TO supabase_read_only_user;
  END IF;
END
$g$;

ALTER TABLE public.sales_team_members DISABLE TRIGGER tg_sales_team_members_dept;

CREATE TEMP TABLE _chg (person_id uuid, member_id uuid, what text, before jsonb, after jsonb) ON COMMIT DROP;

-- (1) active people with an uncovered 2026 sale: their earliest membership from 01.01.2026 (not Slobodanka)
WITH sales AS (
  SELECT o.sold_by_person_id AS pid, (coalesce(o.sold_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS d
  FROM public.orders o
  WHERE o.status::text IN ('confirmed', 'shipped', 'paid', 'returned') AND o.sale_source <> 'altercpa'
    AND coalesce(o.sold_at, o.created_at) >= timestamptz '2025-12-31 23:00+00' AND o.sold_by_person_id IS NOT NULL
), unc AS (
  SELECT DISTINCT s.pid FROM sales s
  WHERE NOT EXISTS (SELECT 1 FROM public.sales_team_members m JOIN public.sales_teams t ON t.key = m.team_key AND t.kind IN ('line', 'management')
                     WHERE m.person_id = s.pid AND (m.valid_from IS NULL OR m.valid_from <= s.d) AND (m.valid_to IS NULL OR m.valid_to >= s.d))
), earliest AS (
  SELECT DISTINCT ON (m.person_id) m.id, m.person_id, m.team_key, m.lane, m.valid_from, m.valid_to
  FROM public.sales_team_members m
  JOIN public.sales_teams t ON t.key = m.team_key AND t.kind IN ('line', 'management')
  JOIN public.sales_people p ON p.id = m.person_id
  WHERE m.person_id IN (SELECT pid FROM unc)
    AND (p.is_active OR p.display_name IN ('Marija Markovska', 'Teodora Kostovska'))
    AND p.display_name <> 'Slobodanka Petrova'
  ORDER BY m.person_id, m.valid_from NULLS FIRST
), upd AS (
  UPDATE public.sales_team_members m SET valid_from = date '2026-01-01'
    FROM earliest e
   WHERE m.id = e.id AND e.valid_from > date '2026-01-01'
  RETURNING m.id, m.person_id, e.team_key, e.lane, e.valid_from AS old_from
)
INSERT INTO _chg SELECT u.person_id, u.id, 'extend',
       jsonb_build_object('team', u.team_key, 'lane', u.lane, 'valid_from', u.old_from),
       jsonb_build_object('team', u.team_key, 'lane', u.lane, 'valid_from', date '2026-01-01')
FROM upd u;

-- (2) Slobodanka Petrova: Тим Центар Out 01.01–31.05, Affiliate from 01.06
WITH p AS (SELECT id FROM public.sales_people WHERE display_name = 'Slobodanka Petrova'),
upd AS (
  UPDATE public.sales_team_members m SET valid_from = date '2026-06-01'
    FROM p WHERE m.person_id = p.id AND m.team_key = 'affiliate' AND m.valid_from = date '2026-08-05'
  RETURNING m.id, m.person_id
), ins AS (
  INSERT INTO public.sales_team_members (person_id, team_key, lane, valid_from, valid_to, role, is_primary, note)
  SELECT p.id, 'teleshop', 'out', date '2026-01-01', date '2026-05-31', 'member', true,
         'Inferred from her own collabBox bookings (Нарачка out Mar–May 2026) — owner 02.10.2026'
  FROM p
  RETURNING id, person_id
)
INSERT INTO _chg
SELECT u.person_id, u.id, 'move_start', jsonb_build_object('team', 'affiliate', 'valid_from', date '2026-08-05'),
       jsonb_build_object('team', 'affiliate', 'valid_from', date '2026-06-01') FROM upd u
UNION ALL
SELECT i.person_id, i.id, 'insert', NULL,
       jsonb_build_object('team', 'teleshop', 'lane', 'out', 'valid_from', date '2026-01-01', 'valid_to', date '2026-05-31') FROM ins i;

-- (3) former staff without a line membership on their 2026 sale days (not primary: a legacy primary stays)
WITH src(name, team, lane, vf, vt, why) AS (VALUES
  ('Марија Бошковска', 'affiliate', 'out', date '2026-01-26', date '2026-03-05', '21 LEADS-OUT sales 29.01–05.03.2026'),
  ('Симона Саздовска', 'teleshop',  'out', date '2026-01-01', date '2026-01-02', '2 Нарачка out sales on 02.01.2026')
), ins AS (
  INSERT INTO public.sales_team_members (person_id, team_key, lane, valid_from, valid_to, role, is_primary, note)
  SELECT p.id, s.team, s.lane, s.vf, s.vt, 'member', false, 'Former staff, inferred from own folders: ' || s.why || ' — owner 02.10.2026'
  FROM src s JOIN public.sales_people p ON p.display_name = s.name
  RETURNING id, person_id, team_key, lane, valid_from, valid_to
)
INSERT INTO _chg SELECT i.person_id, i.id, 'insert', NULL,
       jsonb_build_object('team', i.team_key, 'lane', i.lane, 'valid_from', i.valid_from, 'valid_to', i.valid_to)
FROM ins i;

ALTER TABLE public.sales_team_members ENABLE TRIGGER tg_sales_team_members_dept;

INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
SELECT '27f13f6e-fd19-44bb-a3c8-a6855a887cc7', 'mile@elyon.com', 'sales_team_member.history_2026', 'sales_team_member',
       c.member_id::text, p.display_name,
       jsonb_build_object('what', c.what, 'before', c.before, 'after', c.after, 'by', 'claude-code',
                          'reason', 'owner 02.10.2026: the seller''s team decides from 01.01.2026 (migration 20260947000900)')
FROM _chg c JOIN public.sales_people p ON p.id = c.person_id;

-- the persons' orders, re-decided once (set-based; the same decision as order_dept_decide)
SET LOCAL elyon.keep_updated_at = 'on';

CREATE TEMP TABLE _o ON COMMIT DROP AS
SELECT o.id, o.sale_source, o.sale_source_detail, o.sold_by_person_id, o.mex_account, o.mex_tracking_id,
       o.dept_override AS cur_ovr, coalesce(o.sold_at, o.created_at) AS at,
       (coalesce(o.sold_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sday
FROM public.orders o
WHERE o.sold_by_person_id IN (SELECT DISTINCT person_id FROM _chg);

CREATE TEMP TABLE _t ON COMMIT DROP AS
SELECT DISTINCT ON (o.id) o.id, m.team_key || ':' || coalesce(m.lane, '') AS line
FROM _o o
JOIN public.sales_team_members m ON m.person_id = o.sold_by_person_id
 AND (m.valid_from IS NULL OR m.valid_from <= o.sday)
 AND (m.valid_to   IS NULL OR m.valid_to   >= o.sday)
JOIN public.sales_teams t ON t.key = m.team_key AND t.kind = 'line'
WHERE o.sale_source IS DISTINCT FROM 'altercpa' AND o.at IS NOT NULL
ORDER BY o.id, m.is_primary DESC, m.valid_from DESC NULLS LAST;

CREATE TEMP TABLE _dbt ON COMMIT DROP AS
SELECT x.*, nullif(x.decided, public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id)) AS want
FROM (
  SELECT o.*,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.cur_ovr) AS cur_dept,
         coalesce(
           CASE t.line WHEN 'teleshop:out' THEN 'teleshop_out' WHEN 'teleshop:in' THEN 'teleshop_other'
                       WHEN 'teleshop:social' THEN 'social' WHEN 'affiliate:in' THEN 'elyon_crm'
                       WHEN 'affiliate:out' THEN 'elyon_crm' END,
           public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id, o.at,
                                      o.mex_account, o.mex_tracking_id),
           CASE WHEN o.mex_tracking_id IS NULL AND o.sale_source = 'elyon_crm'
                     AND o.sale_source_detail IN ('prediction_list', 'direct')
                THEN public.crm_sale_booking_dept(o.id) END) AS decided
  FROM _o o
  LEFT JOIN _t t ON t.id = o.id
) x;

INSERT INTO public.dept_history_backfill (run_tag, order_id, old_dept, new_dept, old_dept_override)
SELECT 'team_history_2026', d.id, d.cur_dept,
       public.cohort_order_source(d.sale_source, d.sale_source_detail, d.mex_tracking_id, d.want), d.cur_ovr
FROM _dbt d
WHERE d.cur_ovr IS DISTINCT FROM d.want
  AND d.cur_dept IS DISTINCT FROM public.cohort_order_source(d.sale_source, d.sale_source_detail, d.mex_tracking_id, d.want)
ON CONFLICT DO NOTHING;

UPDATE public.orders o SET dept_override = d.want
  FROM _dbt d
 WHERE o.id = d.id AND d.cur_ovr IS DISTINCT FROM d.want
   AND o.dept_override IS NOT DISTINCT FROM d.cur_ovr;

COMMIT;
