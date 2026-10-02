-- ============================================================================
-- Менаџмент — its own department category, the 7th (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "кај менаџментот треба да пишува одделно ако има нешто + во пресметките" · "Се разбира одделно од некои од
--   тимовите ин или оут" · on the board: "Нека се брои само кога е изберено СИТЕ, и овде е вкупното, но во центар/маџари
--   ин/оут не треба да ги има."
-- A sale whose seller is on the Менаџмент team on the Skopje sale day (sales_teams.kind 'management') is department
--   'management' — not Тим Центар In/Out, not Тим Маџари In/Out — and counts in every total. A LEAD (sale_source
--   altercpa) stays Тим Маџари In whoever decided it (the lead-first rule of 20260947000400 — Nina 3.011 / Dragana 638
--   AlterCPA decisions in 2026). 2026 numbers: Teodora Krstevska ≈1.390 and Dzenet Ramadani ≈1.030 collabBox sales,
--   Nina 118 + the others' few CRM sales move to Менаџмент.
--   · sales_person_team_at(person, at): the primary line OR management membership on the day ('management:' for the
--     latter); order_dept_by_team maps it → 'management' (sales_person_line_at stays line-only for its readers).
--   · orders.dept_override may hold 'management' (CHECK widened); cohort_order_source(…, dept_override) passes it on.
--   · Every report that lists the six departments by name lists 'management' 7th — re-emitted from the LIVE body with
--     exact, counted edits (md5-guarded): insights_cohort, insights_overview, insights_sales, insights_returns,
--     insights_stock, insights_people (by_source + a src_management column), leaderboard_day_v2 (the department
--     filter + the day-by-department tie-out), assigner_dept_key.
--   · The management sellers' orders are re-decided once (set-based), each move in dept_history_backfill
--     ('management_dept').
-- The api / UI learn the 7th key in the same release (INSIGHTS_SOURCES …); an api still passing only the six to
-- p_sources leaves Менаџмент out of that answer until it is deployed — deploy the api right after this migration.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. the re-emit helper (this transaction only) ───────────────────────────
CREATE FUNCTION pg_temp.reemit(p_sig text, p_md5 text, p_old text[], p_new text[], p_cnt int[])
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_def text;
  v_k   int;
  i     int;
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(p_sig)) IS DISTINCT FROM p_md5 THEN
    RAISE EXCEPTION 'management department: % changed since this migration was written — re-emit from the live body', p_sig;
  END IF;
  v_def := replace(pg_get_functiondef(to_regprocedure(p_sig)), chr(13), '');
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_k := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_k <> p_cnt[i] THEN
      RAISE EXCEPTION 'management department: % edit % found % times, expected %', p_sig, i, v_k, p_cnt[i];
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
END
$f$;

-- ── 2. the rule ─────────────────────────────────────────────────────────────
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_dept_override_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_dept_override_check
  CHECK (dept_override IS NULL OR dept_override IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'))
  NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_dept_override_check;

CREATE OR REPLACE FUNCTION public.sales_person_team_at(p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT m.team_key || ':' || coalesce(m.lane, '')
  FROM public.sales_team_members m
  JOIN public.sales_teams t ON t.key = m.team_key AND t.kind IN ('line', 'management')
  WHERE p_person IS NOT NULL AND m.person_id = p_person
    AND (m.valid_from IS NULL OR m.valid_from <= (p_at AT TIME ZONE 'Europe/Skopje')::date)
    AND (m.valid_to   IS NULL OR m.valid_to   >= (p_at AT TIME ZONE 'Europe/Skopje')::date)
  ORDER BY m.is_primary DESC, m.valid_from DESC NULLS LAST
  LIMIT 1
$fn$;
COMMENT ON FUNCTION public.sales_person_team_at(uuid, timestamptz) IS
  'Owner 02.10.2026: the team (line OR Менаџмент) and lane a sales person was on, on the Skopje day of p_at — ''teleshop:out'' … ''affiliate:in'' … ''management:'' — or NULL. order_dept_by_team reads it. Migration 20260947001000.';

CREATE OR REPLACE FUNCTION public.order_dept_by_team(p_sale_source text, p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_sale_source = 'altercpa' OR p_person IS NULL OR p_at IS NULL THEN NULL   -- a lead: Тим Маџари In
           ELSE CASE public.sales_person_team_at(p_person, p_at)
                  WHEN 'teleshop:out'    THEN 'teleshop_out'
                  WHEN 'teleshop:in'     THEN 'teleshop_other'
                  WHEN 'teleshop:social' THEN 'social'
                  WHEN 'affiliate:in'    THEN 'elyon_crm'
                  WHEN 'affiliate:out'   THEN 'elyon_crm'
                  WHEN 'management:'     THEN 'management'                                     -- 20260947001000
                END
         END
$fn$;
COMMENT ON FUNCTION public.order_dept_by_team(text, uuid, timestamptz) IS
  'Owner 02.10.2026: the department by the SELLER''S TEAM — a lead (sale_source altercpa) → NULL (Тим Маџари In by the mapping); teleshop:out → teleshop_out, teleshop:in → teleshop_other, teleshop:social → social, affiliate → elyon_crm (Тим Маџари Out), Менаџмент → management (its own category, 20260947001000); legacy / no seller → NULL (the old rule). Migrations 20260947000400 / 1000.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.sales_person_team_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sales_person_team_at(uuid, timestamptz) TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.sales_person_team_at(uuid, timestamptz) TO supabase_read_only_user;
  END IF;
END
$g$;

-- ── 3. the reports list the 7th ─────────────────────────────────────────────
SELECT pg_temp.reemit('public.insights_cohort(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)',
  'e8e877e764019d0cd87720115754d17b',
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web']$a$,
        $a$('social', 5, 'social'), ('web', 6, 'web')) s(key, ord, ss)$a$],
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management']$a$,
        $a$('social', 5, 'social'), ('web', 6, 'web'), ('management', 7, 'management')) s(key, ord, ss)$a$],
  ARRAY[1, 1]);

SELECT pg_temp.reemit('public.insights_overview(text,text,text,text)',
  'a8570850d49d5d6c88c703a5bafbedf5',
  ARRAY[$a$('social', 5), ('web', 6)) v(src, ord)$a$,
        $a$f.src IN ('elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web')$a$],
  ARRAY[$a$('social', 5), ('web', 6), ('management', 7)) v(src, ord)$a$,
        $a$f.src IN ('elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management')$a$],
  ARRAY[1, 1]);

SELECT pg_temp.reemit('public.insights_sales(timestamp with time zone,timestamp with time zone,text,boolean,integer)',
  '86bccf5c2030db13cd1a4b07552432db',
  ARRAY[$a$('social', 5, 'social'), ('web', 6, 'web')) v(key, ord, ss)$a$,
        $a$('social', 5), ('web', 6)) v(key, ord)$a$],
  ARRAY[$a$('social', 5, 'social'), ('web', 6, 'web'), ('management', 7, 'management')) v(key, ord, ss)$a$,
        $a$('social', 5), ('web', 6), ('management', 7)) v(key, ord)$a$],
  ARRAY[1, 2]);

SELECT pg_temp.reemit('public.insights_returns(timestamp with time zone,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,text[],boolean)',
  'e6bbd3a0f44009480b828fbe6c6eaf16',
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web']$a$],
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management']$a$],
  ARRAY[2]);

SELECT pg_temp.reemit('public.insights_stock(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)',
  'fd482003616e0836b13e7fc2686f2a33',
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web']$a$],
  ARRAY[$a$ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management']$a$],
  ARRAY[2]);

SELECT pg_temp.reemit('public.leaderboard_day_v2(date,text,text)',
  '65776140e1686cc795ce42392f471b80',
  ARRAY[$a$v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web')$a$,
        $a$('teleshop_other', 4), ('social', 5), ('web', 6)) d(key, ord)$a$],
  ARRAY[$a$v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management')$a$,
        $a$('teleshop_other', 4), ('social', 5), ('web', 6), ('management', 7)) d(key, ord)$a$],
  ARRAY[1, 1]);

SELECT pg_temp.reemit('public.assigner_dept_key(text)',
  '4646762feb4aab2930ceb51b5d673db1',
  ARRAY[$a$'teleshop_other', 'social', 'web')$a$],
  ARRAY[$a$'teleshop_other', 'social', 'web', 'management')$a$],
  ARRAY[1]);

SELECT pg_temp.reemit('public.insights_people(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)',
  'b93da926bbc40581eda00e64fc04d471',
  ARRAY[$a$AND e.source = 'web')                        AS src_web,$a$,
        $a$a.src_social, a.src_web, a.value_mkd,$a$,
        $a$sum(a.src_web)::bigint AS src_web,$a$,
        $a$'social', a.src_social, 'web', a.src_web),$a$,
        $a$WHEN 'web' THEN 6 ELSE 7 END$a$,
        $a$('social', 5), ('web', 6)) s0(key, ord)$a$],
  ARRAY[$a$AND e.source = 'web')                        AS src_web,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'management')                 AS src_management,$a$,
        $a$a.src_social, a.src_web, a.src_management, a.value_mkd,$a$,
        $a$sum(a.src_web)::bigint AS src_web,
         sum(a.src_management)::bigint AS src_management,$a$,
        $a$'social', a.src_social, 'web', a.src_web, 'management', a.src_management),$a$,
        $a$WHEN 'web' THEN 6 WHEN 'management' THEN 7 ELSE 8 END$a$,
        $a$('social', 5), ('web', 6), ('management', 7)) s0(key, ord)$a$],
  ARRAY[1, 1, 2, 1, 1, 1]);

-- ── 4. the management sellers' orders, re-decided once (set-based = order_dept_decide) ──
SET LOCAL elyon.keep_updated_at = 'on';

CREATE TEMP TABLE _o ON COMMIT DROP AS
SELECT o.id, o.sale_source, o.sale_source_detail, o.sold_by_person_id, o.mex_account, o.mex_tracking_id,
       o.dept_override AS cur_ovr, coalesce(o.sold_at, o.created_at) AS at
FROM public.orders o
WHERE o.sold_by_person_id IN (SELECT m.person_id FROM public.sales_team_members m
                               JOIN public.sales_teams t ON t.key = m.team_key AND t.kind = 'management');

CREATE TEMP TABLE _dbt ON COMMIT DROP AS
SELECT x.*, public.order_dept_decide(x.sale_source, x.sale_source_detail, x.sold_by_person_id, x.at,
                                     x.mex_account, x.mex_tracking_id, x.id) AS want,
       public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.cur_ovr) AS cur_dept
FROM _o x;

INSERT INTO public.dept_history_backfill (run_tag, order_id, old_dept, new_dept, old_dept_override)
SELECT 'management_dept', d.id, d.cur_dept,
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
