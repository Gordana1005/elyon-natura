-- ============================================================================
-- The SELLER'S TEAM decides the department — except a LEAD, which is always Affiliate – Lead in
-- (owner, Mile, 02.10.2026 — for the Табла, Insights and every calculation, whole history)
-- ============================================================================
-- Owner, 02.10.2026, after seeing that 18 of the 22 Телешоп Out agents also book in LEADS-OUT (their CRM
-- prediction-list sales, shipped on BIO NATURAL): "Значи од сега сметиме по агенти, за дашбордот и за Insights, и за
-- пресметките, значи ако агентот е од телешоп Out, порачката се смета кај телешоп Out. ако е пратена преку bio
-- natural, тоа значи дека се само bio natural Продукти … но одиме со приоритет на агентот од каде е. Тие што се
-- телешоп out, имаат право да праќаат и leads-out, и телешоп Out … Одиме по групата во која агентот припаѓа таму се
-- бројат, е сега различно е само за affiliate, затоа што тука е приоритет лидот, ако е lead(pending) тогаш е
-- дефинитивно affiliate lead in тимот, Affiliete out Е тимот од affiliate IN, Истите луѓе но порачките не се од
-- leads."
--
-- THE RULE — order_dept_by_team(sale_source, seller, sale time):
--   a LEAD (sale_source altercpa: an AlterCPA lead, or a collabBox 10111 "Нарачка LEADS") → NULL = the mapping =
--     Affiliate – Lead in, whoever decided it                                        (the lead first)
--   else the seller's LINE team on the Skopje sale day (sales_team_members, kind 'line', the primary first):
--     teleshop:out → Телешоп – Lead out · teleshop:in → Телешоп – Lead in · teleshop:social → Социјални мрежи ·
--     affiliate:* → Affiliate – Lead out (the same people as Affiliate In, the sales that are not leads)
--   a seller in Менаџмент / a legacy team / no seller → NULL: the old rule stands (a CRM sale: its MEX profile, then
--     its own booking — 20260942001860 / 20260947000300; anything else: its collabBox folder).
-- ONE decision for an order — order_dept_decide(…) = coalesce(team, MEX profile, own booking) — stored in
--   orders.dept_override (the 4-argument cohort_order_source every report reads, and the /orders filter), kept by
--   tg_orders_zz_dept_override, the 15-minute crm-sale-booking-dept pass, and a new trigger on sales_team_members (a
--   person's team change in Settings → Teams re-decides that person's orders).
-- A BOOKING (a collabBox document with no order yet) follows its author's team the same way: insights_sale_rows (the
--   cohort: Табла, Insights, Операции) and leaderboard_day_v2 (its uncounted CRM twins) are re-emitted from their LIVE
--   bodies with exactly one edit each (drift-guarded).
-- Unchanged: sale_source / sale_source_detail (the raw record: folder, list, intake), MEX-only parcels (no seller —
--   by profile then series), payouts / bonus (deferred by the owner).
-- Supersedes the 29.09 withdrawal of the team rule (20260942001850) and the 02.10 morning wording "a team is not a
--   department" (20260947000300's header).
-- Blast radius measured 02.10 (real orders, whole history): ~3.200 move — September 760 Affiliate – Lead out →
--   Телешоп – Lead out (2,11 М ден) + 132 Телешоп – Lead in → Lead out; every month since 2025 the social agents'
--   "Нарачка out" → Социјални and the Lead-out agents' "Нарачка in" → Lead out. Each moved order is kept in
--   dept_by_team_backfill (old → new).
-- Undo: re-emit 20260947000300's tg_orders_dept_override + crm_sale_booking_dept_sync and the two report bodies from git,
--   then UPDATE orders SET dept_override = b.old_dept FROM dept_by_team_backfill b WHERE … (keep_updated_at).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.tg_orders_dept_override()', 'adca5770bf8f4ef208fa5516fe221343'),
    ('public.crm_sale_booking_dept_sync()', '52a7a868e702a90c0d8f9bff128bbcc2'),
    ('public.order_dept_override(text,text,uuid,timestamp with time zone,text,text)', '0c493454717aafcddfa6f6c736c1769a'),
    ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', 'db50e2421b6e2e9a4e3ddf7224da53e4'),
    ('public.leaderboard_day_v2(date,text,text)', '7a3846e0292701365e6fb2d74f52b6e8')
  ) e(sig, md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) <> e.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'department by seller team: % changed since this migration was written — re-emit from the live body', v_bad;
  END IF;
END
$drift$;

-- ── 1. the seller's line on a day ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_person_line_at(p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT m.team_key || ':' || coalesce(m.lane, '')
  FROM public.sales_team_members m
  JOIN public.sales_teams t ON t.key = m.team_key AND t.kind = 'line'
  WHERE p_person IS NOT NULL AND m.person_id = p_person
    AND (m.valid_from IS NULL OR m.valid_from <= (p_at AT TIME ZONE 'Europe/Skopje')::date)
    AND (m.valid_to   IS NULL OR m.valid_to   >= (p_at AT TIME ZONE 'Europe/Skopje')::date)
  ORDER BY m.is_primary DESC, m.valid_from DESC NULLS LAST
  LIMIT 1
$fn$;
COMMENT ON FUNCTION public.sales_person_line_at(uuid, timestamptz) IS
  'Owner 02.10.2026: the LINE team (teleshop / affiliate, kind line) and lane a sales person was on, on the Skopje day of p_at — ''teleshop:out'' / ''teleshop:in'' / ''teleshop:social'' / ''affiliate:in'' … — or NULL (Менаџмент, a legacy team, no membership). Migration 20260947000400.';

-- ── 2. the rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_dept_by_team(p_sale_source text, p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_sale_source = 'altercpa' OR p_person IS NULL OR p_at IS NULL THEN NULL   -- a lead: Affiliate – Lead in
           ELSE CASE public.sales_person_line_at(p_person, p_at)
                  WHEN 'teleshop:out'    THEN 'teleshop_out'
                  WHEN 'teleshop:in'     THEN 'teleshop_other'
                  WHEN 'teleshop:social' THEN 'social'
                  WHEN 'affiliate:in'    THEN 'elyon_crm'
                  WHEN 'affiliate:out'   THEN 'elyon_crm'
                END
         END
$fn$;
COMMENT ON FUNCTION public.order_dept_by_team(text, uuid, timestamptz) IS
  'Owner 02.10.2026: the department by the SELLER''S TEAM — a lead (sale_source altercpa) → NULL (Affiliate – Lead in by the mapping); teleshop:out → teleshop_out, teleshop:in → teleshop_other, teleshop:social → social, affiliate → elyon_crm (Affiliate – Lead out); Менаџмент / legacy / no seller → NULL (the old rule). Migration 20260947000400.';

CREATE OR REPLACE FUNCTION public.order_dept_decide(p_sale_source text, p_detail text, p_person uuid, p_at timestamptz,
                                                   p_account text, p_tracking text, p_order uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- stored only where it CHANGES the department (NULL = the mapping gives the same answer): a sparse column, a small
  -- backfill, and the /orders filter (dept_override.in.(…) or null → the mapping) reads it unchanged
  SELECT nullif(
    coalesce(
      public.order_dept_by_team(p_sale_source, p_person, p_at),                                  -- the seller's team
      public.order_dept_override(p_sale_source, p_detail, p_person, p_at, p_account, p_tracking),  -- a CRM sale: MEX profile
      CASE WHEN p_order IS NOT NULL AND p_tracking IS NULL
                AND p_sale_source = 'elyon_crm' AND p_detail IN ('prediction_list', 'direct')
           THEN public.crm_sale_booking_dept(p_order) END),                                     -- a CRM sale: own booking
    public.cohort_order_source(p_sale_source, p_detail, p_tracking))
$fn$;
COMMENT ON FUNCTION public.order_dept_decide(text, text, uuid, timestamptz, text, text, uuid) IS
  'THE stored department decision of an order (orders.dept_override): the seller''s team (order_dept_by_team) → a CRM sale''s MEX profile (order_dept_override) → a CRM sale''s own collabBox booking (crm_sale_booking_dept, needs the order id) → else the folder / series mapping; stored only where it differs from the mapping (NULL = the mapping). Migration 20260947000400.';

-- ── 3. kept current ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_orders_dept_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- one decision (20260947000400); on INSERT the row does not exist yet, so no booking lookup
  NEW.dept_override := public.order_dept_decide(NEW.sale_source, NEW.sale_source_detail, NEW.sold_by_person_id,
                                                coalesce(NEW.sold_at, NEW.created_at), NEW.mex_account, NEW.mex_tracking_id,
                                                CASE WHEN TG_OP = 'UPDATE' THEN NEW.id END);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.crm_sale_booking_dept_sync()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer;
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- GET /call-agains reads updated_at
  WITH c AS (
    SELECT o.id, o.dept_override AS cur,
           public.order_dept_decide(o.sale_source, o.sale_source_detail, o.sold_by_person_id,
                                    coalesce(o.sold_at, o.created_at), o.mex_account, o.mex_tracking_id, o.id) AS want
    FROM public.orders o
    WHERE o.status = 'confirmed'
      AND o.sale_source = 'elyon_crm'
      AND o.sale_source_detail IN ('prediction_list', 'direct')
      AND o.mex_tracking_id IS NULL
      AND coalesce(o.sold_at, o.confirmed_at, o.created_at) >= now() - interval '60 days'
  ), upd AS (
    UPDATE public.orders o SET dept_override = c.want
      FROM c
     WHERE o.id = c.id AND c.cur IS DISTINCT FROM c.want
       AND o.mex_tracking_id IS NULL AND o.status = 'confirmed'
    RETURNING o.id
  )
  SELECT count(*) INTO _n FROM upd;
  RETURN jsonb_build_object('ok', true, 'changed', _n);
END
$fn$;

-- a person's orders, re-decided (a team change; the backfill)
CREATE OR REPLACE FUNCTION public.orders_dept_recompute(p_person uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer;
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  WITH c AS (
    SELECT o.id, o.dept_override AS cur,
           public.order_dept_decide(o.sale_source, o.sale_source_detail, o.sold_by_person_id,
                                    coalesce(o.sold_at, o.created_at), o.mex_account, o.mex_tracking_id, o.id) AS want
    FROM public.orders o
    WHERE o.sold_by_person_id = p_person
  ), upd AS (
    UPDATE public.orders o SET dept_override = c.want
      FROM c
     WHERE o.id = c.id AND c.cur IS DISTINCT FROM c.want
    RETURNING o.id
  )
  SELECT count(*) INTO _n FROM upd;
  RETURN _n;
END
$fn$;
COMMENT ON FUNCTION public.orders_dept_recompute(uuid) IS
  'Owner 02.10.2026: re-decides orders.dept_override (order_dept_decide) for one seller''s orders (row by row — a whole-table pass is set-based, see the backfill below); updated_at kept. Called by tg_sales_team_members_dept. Migration 20260947000400.';

CREATE OR REPLACE FUNCTION public.tg_sales_team_members_dept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.person_id IS NOT NULL THEN
    PERFORM public.orders_dept_recompute(OLD.person_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.person_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.person_id IS DISTINCT FROM OLD.person_id) THEN
    PERFORM public.orders_dept_recompute(NEW.person_id);
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS tg_sales_team_members_dept ON public.sales_team_members;
CREATE TRIGGER tg_sales_team_members_dept
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_team_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_sales_team_members_dept();

COMMENT ON COLUMN public.orders.dept_override IS
  'THE stored department decision (20260947000400, owner 02.10.2026): order_dept_decide = the seller''s team (a lead excepted) → a CRM sale''s MEX profile → a CRM sale''s own collabBox booking → NULL (the folder / series mapping, cohort_order_source 3-arg). Maintained by tg_orders_zz_dept_override, tg_sales_team_members_dept and the cron crm-sale-booking-dept — never write it by hand.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.sales_person_line_at(uuid, timestamptz)                              FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.order_dept_by_team(text, uuid, timestamptz)                          FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.order_dept_decide(text, text, uuid, timestamptz, text, text, uuid)   FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.orders_dept_recompute(uuid)                                         FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sales_person_line_at(uuid, timestamptz)                            TO service_role;
  GRANT EXECUTE ON FUNCTION public.order_dept_by_team(text, uuid, timestamptz)                        TO service_role;
  GRANT EXECUTE ON FUNCTION public.order_dept_decide(text, text, uuid, timestamptz, text, text, uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION public.orders_dept_recompute(uuid)                                       TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.sales_person_line_at(uuid, timestamptz)                            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.order_dept_by_team(text, uuid, timestamptz)                        TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.order_dept_decide(text, text, uuid, timestamptz, text, text, uuid) TO supabase_read_only_user;
  END IF;
END
$g$;

-- ── 4. a booking follows its author's team: the cohort + the leaderboard's twins ──
DO $reemit$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- insights_sale_rows: the booking rows' department
  v_def := pg_get_functiondef('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure);
  v_old := 'public.cohort_order_source(bk.dep[1], bk.dep[2], bk.doc_number) AS source,';
  v_new := 'coalesce(public.order_dept_by_team(bk.dep[1], bk.author_person_id, bk.sale_at), '
        || 'public.cohort_order_source(bk.dep[1], bk.dep[2], bk.doc_number)) AS source,   -- the author''s team first (20260947000400)';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'insights_sale_rows: the booking department expression is not there exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- leaderboard_day_v2: the uncounted CRM twins' department
  v_def := pg_get_functiondef('public.leaderboard_day_v2(date,text,text)'::regprocedure);
  v_old := 'SELECT d.author_person_id, public.cohort_order_source(dp.d[1], dp.d[2], d.doc_number), (dp.d IS NULL),';
  v_new := 'SELECT d.author_person_id, coalesce(public.order_dept_by_team(dp.d[1], d.author_person_id, d.doc_at), '
        || 'public.cohort_order_source(dp.d[1], dp.d[2], d.doc_number)), (dp.d IS NULL),';
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'leaderboard_day_v2: the twin department expression is not there exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$reemit$;

-- ── 5. the backfill (whole history), every move kept ────────────────────────
CREATE TABLE IF NOT EXISTS public.dept_by_team_backfill (
  order_id  uuid PRIMARY KEY,
  old_dept  text,
  new_dept  text,
  old_dept_override text,
  moved_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.dept_by_team_backfill IS
  'Owner 02.10.2026: every order whose department moved when the seller''s team began to decide (20260947000400) — the department before (cohort_order_source 4-arg) and after, and the old dept_override (for an undo). Owner-only.';
ALTER TABLE public.dept_by_team_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dept_by_team_backfill FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dept_by_team_backfill TO service_role;
DO $g2$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.dept_by_team_backfill TO supabase_read_only_user;
  END IF;
END
$g2$;

SET LOCAL elyon.keep_updated_at = 'on';

-- Set-based (a per-row order_dept_decide over 360k orders is too slow for one statement); the SAME decision:
-- the seller's line on the sale day (sales_person_line_at's order: primary first, latest valid_from) → the team's
-- department (order_dept_by_team, a lead excepted) → order_dept_override (pure) → the own booking (only an open CRM
-- sale without a parcel) → nullif the mapping. verify-collab-entry-rule.mjs T2 re-checks it row by row.
CREATE TEMP TABLE _o ON COMMIT DROP AS
SELECT o.id, o.sale_source, o.sale_source_detail, o.sold_by_person_id, o.mex_account, o.mex_tracking_id,
       o.dept_override AS cur_ovr, coalesce(o.sold_at, o.created_at) AS at,
       (coalesce(o.sold_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sday
FROM public.orders o;

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

INSERT INTO public.dept_by_team_backfill (order_id, old_dept, new_dept, old_dept_override)
SELECT d.id, d.cur_dept,
       public.cohort_order_source(d.sale_source, d.sale_source_detail, d.mex_tracking_id, d.want),
       d.cur_ovr
FROM _dbt d
WHERE d.cur_ovr IS DISTINCT FROM d.want
  AND d.cur_dept IS DISTINCT FROM public.cohort_order_source(d.sale_source, d.sale_source_detail, d.mex_tracking_id, d.want)
ON CONFLICT (order_id) DO NOTHING;

UPDATE public.orders o SET dept_override = d.want
  FROM _dbt d
 WHERE o.id = d.id AND d.cur_ovr IS DISTINCT FROM d.want
   AND o.dept_override IS NOT DISTINCT FROM d.cur_ovr;   -- not changed since the scan

COMMIT;
