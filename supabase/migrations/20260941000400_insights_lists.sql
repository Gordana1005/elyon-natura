-- ============================================================================
-- INSIGHTS → PREDICTION LISTS (Прогнозни списоци) — one RPC (2026-09-28, WP4)
--
-- The tab that answers "which prediction lists make money". Read-side only:
-- no table is written, no trigger, no backfill, no cron.
--
--   insights_lists(p_from, p_to_end, p_prev_from, p_prev_to_end, p_money,
--                  p_stale_days) → jsonb        GET /api/insights/lists
--   insights_lists_cash(p_from, p_to_end, p_money) → jsonb
--                                               its cash-flow line (parallel)
--
-- IT DOES NOT RE-DERIVE "WHAT IS A SALE". Its sales are THE cohort's rows —
-- public.insights_sale_rows() (migration 20260940000000) filtered to source
-- elyon_crm — so the tab ties to the Overview by construction:
--   Σ lists + "list not recorded"          = the Overview's ElyonCRM ·
--                                            prediction_list split
--   … + direct (+ none)                    = the Overview's ElyonCRM card
-- Same sale day (sold_at → confirmed_at → created_at, Skopje days), same
-- MEX-first buckets that add up exactly to the total, same value (parcel COD,
-- else price × 61,5), same test-phone exclusion.
--
-- What the old tab (GET /management-insights → insights_orders_rollup) got
-- wrong, and this replaces:
--   · "Нето" subtracted returns twice (returned orders were already outside
--     its revenue) — there is no "net" here; returned is a bucket of the total
--   · it counted 0-ден call-outcome rows (disposition) as orders — here they
--     are only "worked" decisions, never a sale, never money
--   · no MEX cash, no buckets, created-day clock, a bound 1 s short
--   · a duplicated order lost its list → the "list not recorded" row (and the
--     /orders duplicate endpoint now copies prediction_list_*)
--
-- ── Per list ────────────────────────────────────────────────────────────────
--   members / members_active / members_assigned   NOW (prediction_segment_
--        members; active = not completed). A snapshot, not the period.
--   worked (Обработени) = the human decisions on the list's orders in the
--        window (v_sales_work, CRM branch, decision day): a sale, a "no"
--        (cancel), a trash. A "sale" decision on a disposition row is not a
--        sale (mex-reconcile ghosts) and is not counted. customers = distinct
--        numbers decided.
--   no_answer = the "no answer" clicks in the window (call_logs, standalone,
--        outcome no_answer), filed under the list the number is in NOW (a rule
--        list before a static one, the band before the additive Current
--        Returns). APPROXIMATE — the click does not record its list.
--   count / value_mkd / cod_mkd / buckets / outside = the list's cohort sales
--   cash_mkd = MEX-proven cash of those sales (Σ COD of bucket paid)
--   units = Σ orders.quantity of the sales
--   stale_to_pack = to_pack sales older than p_stale_days Skopje days
--   last_sale = the list's latest sale ever (a 'now' figure)
--   agents = top 3 sellers on the list (sales, value, decisions)
--   spark / spark_mkd = sales per trend period (count / денари)
--   drill_name = the orders' snapshot prediction_list_name when it is ONE
--        name (GET /orders?prediction_list= matches it exactly); NULL when
--        the snapshots differ (then the list has no exact drill).
--
-- LIST NAMES ARE NEVER CHANGED HERE (nor anywhere): the segment engine
-- resolves lists by EXACT name and deletes memberships before resolving, so a
-- drifted name wipes members silently. The UI shows a display-only label
-- (src/lib/predictionListLabel.ts) and keeps the raw name in a tooltip.
--
-- Attribution exists only since the first list-attributed order (14.08.2026):
-- meta.first_attr_day says so. Presence (agent_presence_days) starts later
-- still: meta.presence_from; agents[].active_minutes / sales_on_presence_days
-- let the UI show sales per agent-hour only over the covered days.
--
-- Money: p_money = false removes every *_mkd / *_eur key (insights_strip_
-- money, the cohort's own strip) and sets meta.money = false; the api strips
-- again by whitelist (insightsLists.ts). Owners only (is_business_owner).
--
-- Cash flow (MEX COD by DELIVERY day, any sale day) is NOT computed here: the
-- api reads the foundation's insights_cash_rows (source elyon_crm, split
-- prediction_list) in PARALLEL with this call — the same rows, a year's
-- window half a second sooner.
--
-- Technique as insights_cohort: plpgsql + EXECUTE … USING (planned with the
-- real bounds), SECURITY DEFINER, pinned search_path, TimeZone UTC, jit off.
-- The previous period is dropped when it would push the scan past the
-- foundation's 800-day cap.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regprocedure('public.insights_sale_rows(timestamptz, timestamptz, boolean)') IS NULL
     OR to_regprocedure('public.insights_cash_rows(timestamptz, timestamptz)') IS NULL
     OR to_regprocedure('public.insights_strip_money(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'apply 20260940000000_insights_foundation.sql first: insights_lists reads the sale cohort (insights_sale_rows / insights_cash_rows)';
  END IF;
END
$dep$;

CREATE OR REPLACE FUNCTION public.insights_lists(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_money       boolean     DEFAULT false,
  p_stale_days  integer     DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_pf    timestamptz;
  v_pt    timestamptz;
  v_fd    date;
  v_td    date;
  v_sfd   date;
  v_gran  text;
  v_lo    timestamptz;
  v_today date;
  v_stale integer;
  v_out   jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_lists: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_lists: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  v_stale := greatest(1, least(coalesce(p_stale_days, 7), 90));
  v_fd    := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td    := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  -- the trend (as the cohort's spark): at least 14 Skopje days ending at `to`,
  -- daily up to 62 days, monthly beyond
  v_sfd   := CASE WHEN v_td - v_fd + 1 >= 14 THEN v_fd ELSE v_td - 13 END;
  v_gran  := CASE WHEN v_td - v_sfd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_today := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_lo    := least(p_from, coalesce(v_pf, p_from), (v_sfd::timestamp AT TIME ZONE 'Europe/Skopje'));
  -- insights_sale_rows refuses a scan longer than 800 days: drop the
  -- comparison rather than the answer
  IF p_to_end - v_lo > interval '800 days' THEN
    v_pf := NULL;
    v_pt := NULL;
    v_lo := least(p_from, (v_sfd::timestamp AT TIME ZONE 'Europe/Skopje'));
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 the earliest
  -- instant any part needs · $6 the test phones' last-8 digits · $7 from day ·
  -- $8 to day · $9 trend first day · $10 trend granularity · $11 today
  -- (Skopje) · $12 stale days
  EXECUTE $q$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $6::text[] AS ex, $7::date AS fd, $8::date AS td, $9::date AS sfd, $10::text AS gran,
         $11::date AS today, $12::integer AS stale,
         CASE WHEN $10::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS pfmt,
         '00000000-0000-0000-0000-000000000000'::uuid AS nil
),
-- THE cohort's ElyonCRM rows — never re-derived here
sr AS MATERIALIZED (
  SELECT r.split, r.list_id, coalesce(r.list_id, prm.nil) AS lk, r.bucket, r.in_total,
         r.value_mkd, r.cod_mkd, r.sale_at, r.sale_day, r.person_id, r.order_id, r.display_id, r.phone8,
         r.q_no_seller, r.q_cancelled_but_moving, r.q_zero_cod,
         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($5, $2, false) r
  CROSS JOIN prm
  WHERE r.source = 'elyon_crm'
),
-- this period's prediction-list slice (+ what only the orders row knows)
ls AS MATERIALIZED (
  SELECT sr.*, o.quantity, o.prediction_list_name AS snap_name, o.duplicated_from,
         (sr.bucket = 'to_pack' AND prm.today - sr.sale_day > prm.stale) AS stale
  FROM sr
  JOIN public.orders o ON o.id = sr.order_id
  CROSS JOIN prm
  WHERE sr.cur AND sr.split = 'prediction_list'
),
la AS (
  SELECT ls.lk,
         count(*) FILTER (WHERE ls.in_total)                      AS n,
         sum(ls.value_mkd) FILTER (WHERE ls.in_total)             AS v,
         sum(ls.cod_mkd) FILTER (WHERE ls.in_total)               AS c,
         sum(ls.cod_mkd) FILTER (WHERE ls.bucket = 'paid')        AS cash,
         count(*) FILTER (WHERE ls.bucket = 'paid')               AS paid_n,
         count(*) FILTER (WHERE ls.bucket = 'returned')           AS ret_n,
         sum(coalesce(ls.quantity, 0)) FILTER (WHERE ls.in_total) AS units,
         count(*) FILTER (WHERE ls.stale)                         AS stale_n,
         sum(ls.value_mkd) FILTER (WHERE ls.stale)                AS stale_v,
         count(DISTINCT ls.snap_name)                             AS names,
         count(*) FILTER (WHERE ls.snap_name IS NULL)             AS no_name,
         min(ls.snap_name)                                        AS snap_name
  FROM ls
  GROUP BY ls.lk
),
lb AS (
  SELECT ls.lk, ls.bucket, count(*) AS n, sum(ls.value_mkd) AS v, sum(ls.cod_mkd) AS c
  FROM ls
  GROUP BY ls.lk, ls.bucket
),
lbj AS (
  SELECT lb.lk,
    jsonb_agg(jsonb_build_object('key', lb.bucket, 'count', lb.n,
                                 'value_mkd', round(coalesce(lb.v, 0)), 'cod_mkd', round(coalesce(lb.c, 0)))
              ORDER BY lb.bucket) FILTER (WHERE public.cohort_in_total(lb.bucket)) AS buckets,
    jsonb_agg(jsonb_build_object('key', lb.bucket, 'count', lb.n, 'value_mkd', round(coalesce(lb.v, 0)))
              ORDER BY lb.bucket) FILTER (WHERE NOT public.cohort_in_total(lb.bucket)) AS outside
  FROM lb
  GROUP BY lb.lk
),
-- the work ledger: human decisions on list rows (sales and "no" call rows)
wk AS MATERIALIZED (
  SELECT v.person_id, v.outcome, coalesce(o.prediction_list_id, prm.nil) AS lk,
         public.insights_phone8(o.customer_phone) AS p8
  FROM public.v_sales_work v
  JOIN public.orders o ON o.id = v.order_id
  CROSS JOIN prm
  WHERE v.via = 'crm'
    AND v.at BETWEEN prm.f AND prm.t
    AND o.sale_source = 'elyon_crm'
    AND o.sale_source_detail IN ('prediction_list', 'disposition')
    AND (v.outcome IN ('cancel', 'trash')
         OR (v.outcome = 'sale' AND o.sale_source_detail = 'prediction_list'))
    AND NOT public.insights_excluded8(public.insights_phone8(o.customer_phone), prm.ex)
),
wa AS (
  SELECT wk.lk,
         count(*)                                      AS worked,
         count(*) FILTER (WHERE wk.outcome = 'sale')   AS w_sale,
         count(*) FILTER (WHERE wk.outcome = 'cancel') AS w_no,
         count(*) FILTER (WHERE wk.outcome = 'trash')  AS w_trash,
         count(DISTINCT wk.p8)                         AS customers
  FROM wk
  GROUP BY wk.lk
),
-- members NOW (a snapshot, not the period)
mm AS (
  SELECT m.list_id AS lk,
         count(*)                                                  AS members,
         count(*) FILTER (WHERE NOT coalesce(m.is_completed, false)) AS active,
         count(*) FILTER (WHERE NOT coalesce(m.is_completed, false)
                            AND m.assigned_agent_id IS NOT NULL)    AS assigned
  FROM public.prediction_segment_members m
  CROSS JOIN prm
  WHERE NOT public.insights_excluded8(public.insights_phone8(m.customer_phone), prm.ex)
  GROUP BY m.list_id
),
-- "no answer" clicks, filed under the list the number is in NOW (approximate).
-- Members are stored E.164 (+389…): each clicked number is looked up by its
-- own text and by +389 + its last 8 digits (idx_segment_members_phone) — no
-- scan of every member.
na AS MATERIALIZED (
  SELECT c.customer_phone AS raw, public.insights_phone8(c.customer_phone) AS p8
  FROM public.call_logs c
  CROSS JOIN prm
  WHERE c.created_at BETWEEN prm.f AND prm.t
    AND c.context_type = 'standalone'
    AND c.outcome = 'no_answer'
    AND NOT public.insights_excluded8(public.insights_phone8(c.customer_phone), prm.ex)
),
nap AS (
  SELECT DISTINCT na.raw, na.p8 FROM na WHERE length(na.p8) = 8
),
mp AS MATERIALIZED (       -- a rule list before a static one; the band before the additive Current Returns
  SELECT DISTINCT ON (nap.raw) nap.raw, m.list_id
  FROM nap
  JOIN public.prediction_segment_members m ON m.customer_phone = ANY (ARRAY[nap.raw, '+389' || nap.p8])
  JOIN public.prediction_segment_lists l ON l.id = m.list_id
  ORDER BY nap.raw, l.is_static, (l.category = 'return'), l.display_order NULLS LAST, l.id
),
naa AS (
  SELECT coalesce(mp.list_id, prm.nil) AS lk, count(*) AS n
  FROM na
  LEFT JOIN mp ON mp.raw = na.raw
  CROSS JOIN prm
  GROUP BY 1
),
-- the list's latest sale ever (a 'now' figure; test phones never)
lst AS (
  SELECT o.prediction_list_id AS lk, max(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS last_at
  FROM public.orders o
  CROSS JOIN prm
  WHERE o.prediction_list_id IS NOT NULL
    AND o.sale_source = 'elyon_crm'
    AND o.sale_source_detail = 'prediction_list'
    AND public.cohort_in_total(public.cohort_order_bucket(
          o.status::text, o.price, o.sold_at, o.paid_basis, o.source_type, o.sale_source_detail,
          o.mex_tracking_id, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at, false))
    AND NOT public.insights_excluded8(public.insights_phone8(o.customer_phone), prm.ex)
  GROUP BY o.prediction_list_id
),
-- sellers per list: sales (cohort) and decisions (work ledger)
ps AS (
  SELECT ls.lk, ls.person_id, count(*) AS n, sum(ls.value_mkd) AS v
  FROM ls
  WHERE ls.in_total AND ls.person_id IS NOT NULL
  GROUP BY ls.lk, ls.person_id
),
pw AS (
  SELECT wk.lk, wk.person_id, count(*) AS w
  FROM wk
  WHERE wk.person_id IS NOT NULL
  GROUP BY wk.lk, wk.person_id
),
plr AS (
  SELECT ps.lk, ps.person_id, ps.n, ps.v, coalesce(pw.w, 0) AS w,
         row_number() OVER (PARTITION BY ps.lk ORDER BY ps.n DESC, ps.v DESC, coalesce(pw.w, 0) DESC, ps.person_id) AS rk
  FROM ps
  LEFT JOIN pw ON pw.lk = ps.lk AND pw.person_id = ps.person_id
),
plj AS (
  SELECT plr.lk,
    jsonb_agg(jsonb_build_object('person_id', plr.person_id, 'name', sp.display_name,
                                 'sales', plr.n, 'value_mkd', round(coalesce(plr.v, 0)), 'worked', plr.w)
              ORDER BY plr.rk) AS j
  FROM plr
  LEFT JOIN public.sales_people sp ON sp.id = plr.person_id
  WHERE plr.rk <= 3
  GROUP BY plr.lk
),
-- the trend periods and each list's sales per period
tk AS (
  SELECT to_char(g, prm.pfmt) AS d
  FROM prm, generate_series(date_trunc(prm.gran, prm.sfd::timestamp), date_trunc(prm.gran, prm.td::timestamp),
                            ('1 ' || prm.gran)::interval) g
),
tsr AS (
  SELECT sr.lk, to_char(date_trunc(prm.gran, sr.sale_day::timestamp), prm.pfmt) AS d, sr.bucket, sr.value_mkd
  FROM sr
  CROSS JOIN prm
  WHERE sr.split = 'prediction_list' AND sr.in_total AND sr.sale_day BETWEEN prm.sfd AND prm.td
),
lsp AS (
  SELECT tsr.lk, tsr.d, count(*) AS n, sum(tsr.value_mkd) AS v FROM tsr GROUP BY tsr.lk, tsr.d
),
lspj AS (
  SELECT k.lk,
         jsonb_agg(coalesce(x.n, 0) ORDER BY tk.d)            AS spark,
         jsonb_agg(round(coalesce(x.v, 0)) ORDER BY tk.d)     AS spark_v
  FROM (SELECT DISTINCT lsp.lk FROM lsp) k
  CROSS JOIN tk
  LEFT JOIN lsp x ON x.lk = k.lk AND x.d = tk.d
  GROUP BY k.lk
),
tpb AS (
  SELECT tsr.d, tsr.bucket, count(*) AS n, sum(tsr.value_mkd) AS v FROM tsr GROUP BY tsr.d, tsr.bucket
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', tk.d, 'count', coalesce(x.n, 0), 'value_mkd', round(coalesce(x.v, 0)),
           'parts', coalesce(x.parts, '[]'::jsonb)) ORDER BY tk.d), '[]'::jsonb) AS j
  FROM tk
  LEFT JOIN (
    SELECT tpb.d, sum(tpb.n) AS n, sum(tpb.v) AS v,
           jsonb_agg(jsonb_build_object('key', tpb.bucket, 'count', tpb.n, 'value_mkd', round(coalesce(tpb.v, 0)))
                     ORDER BY tpb.bucket) AS parts
    FROM tpb GROUP BY tpb.d
  ) x ON x.d = tk.d
),
-- every list that exists, plus any id the period's rows name (a list row
-- deleted since keeps its sales on screen under its snapshot name)
keys AS (
  SELECT l.id AS lk FROM public.prediction_segment_lists l
  UNION SELECT la.lk FROM la CROSS JOIN prm WHERE la.lk <> prm.nil
  UNION SELECT wa.lk FROM wa CROSS JOIN prm WHERE wa.lk <> prm.nil
),
lj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',               k.lk,
    'name',             coalesce(l.name, la.snap_name),
    'category',         l.category,
    'is_static',        coalesce(l.is_static, false),
    'is_active',        coalesce(l.is_active, false),
    'known',            (l.id IS NOT NULL),
    'order',            l.display_order,
    'members',          coalesce(mm.members, 0),
    'members_active',   coalesce(mm.active, 0),
    'members_assigned', coalesce(mm.assigned, 0),
    'no_answer',        coalesce(naa.n, 0),
    'worked',           coalesce(wa.worked, 0),
    'worked_sale',      coalesce(wa.w_sale, 0),
    'worked_no',        coalesce(wa.w_no, 0),
    'worked_trash',     coalesce(wa.w_trash, 0),
    'customers',        coalesce(wa.customers, 0),
    'count',            coalesce(la.n, 0),
    'value_mkd',        round(coalesce(la.v, 0)),
    'cod_mkd',          round(coalesce(la.c, 0)),
    'cash_mkd',         round(coalesce(la.cash, 0)),
    'paid',             coalesce(la.paid_n, 0),
    'returned',         coalesce(la.ret_n, 0),
    'units',            coalesce(la.units, 0),
    'stale_to_pack',    coalesce(la.stale_n, 0),
    'stale_to_pack_value_mkd', round(coalesce(la.stale_v, 0)),
    'buckets',          coalesce(lbj.buckets, '[]'::jsonb),
    'outside',          coalesce(lbj.outside, '[]'::jsonb),
    'drill_name',       CASE WHEN la.lk IS NULL THEN l.name
                             WHEN la.names = 1 AND la.no_name = 0 THEN la.snap_name END,
    'last_sale',        to_char((lst.last_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'agents',           coalesce(plj.j, '[]'::jsonb),
    'spark',            lspj.spark,
    'spark_mkd',        lspj.spark_v)
    ORDER BY l.display_order NULLS LAST, coalesce(l.name, la.snap_name), k.lk), '[]'::jsonb) AS j
  FROM keys k
  LEFT JOIN public.prediction_segment_lists l ON l.id = k.lk
  LEFT JOIN la   ON la.lk = k.lk
  LEFT JOIN lbj  ON lbj.lk = k.lk
  LEFT JOIN wa   ON wa.lk = k.lk
  LEFT JOIN mm   ON mm.lk = k.lk
  LEFT JOIN naa  ON naa.lk = k.lk
  LEFT JOIN lst  ON lst.lk = k.lk
  LEFT JOIN plj  ON plj.lk = k.lk
  LEFT JOIN lspj ON lspj.lk = k.lk
  -- every active list (0 sales is news), and any list the period touched
  WHERE coalesce(l.is_active, false) OR la.lk IS NOT NULL OR wa.lk IS NOT NULL
     OR coalesce(mm.members, 0) > 0 OR coalesce(naa.n, 0) > 0
),
-- the slice's own total, buckets (Σ = total) and outside
bks AS (
  SELECT * FROM (VALUES ('paid', 1, true), ('paid_unproven', 2, true), ('paid_legacy', 3, true),
                        ('courier', 4, true), ('courier_problem', 5, true), ('label', 6, true),
                        ('to_pack', 7, true), ('returned', 8, true),
                        ('cancelled_after_sale', 9, false), ('trashed_after_sale', 10, false),
                        ('replacement', 11, false)) v(key, ord, in_total)
),
bt AS (
  SELECT b.key, b.ord, b.in_total, count(ls.bucket) AS n,
         coalesce(sum(ls.value_mkd), 0) AS v, coalesce(sum(ls.cod_mkd), 0) AS c
  FROM bks b
  LEFT JOIN ls ON ls.bucket = b.key
  GROUP BY b.key, b.ord, b.in_total
),
btj AS (
  SELECT
    jsonb_agg(jsonb_build_object('key', bt.key, 'count', bt.n, 'value_mkd', round(bt.v), 'cod_mkd', round(bt.c),
                                 'orders', bt.n, 'web', 0, 'mex_only', 0) ORDER BY bt.ord) FILTER (WHERE bt.in_total) AS buckets,
    jsonb_agg(jsonb_build_object('key', bt.key, 'count', bt.n, 'value_mkd', round(bt.v),
                                 'orders', bt.n, 'web', 0, 'mex_only', 0) ORDER BY bt.ord) FILTER (WHERE NOT bt.in_total) AS outside
  FROM bt
),
tot AS (
  SELECT count(*) FILTER (WHERE ls.in_total)                      AS n,
         coalesce(sum(ls.value_mkd) FILTER (WHERE ls.in_total), 0) AS v,
         coalesce(sum(ls.cod_mkd) FILTER (WHERE ls.in_total), 0)   AS c,
         coalesce(sum(ls.cod_mkd) FILTER (WHERE ls.bucket = 'paid'), 0) AS cash,
         count(*) FILTER (WHERE ls.bucket = 'paid')               AS paid_n,
         count(*) FILTER (WHERE ls.bucket = 'returned')           AS ret_n,
         coalesce(sum(coalesce(ls.quantity, 0)) FILTER (WHERE ls.in_total), 0) AS units,
         count(*) FILTER (WHERE ls.stale)                         AS stale_n,
         coalesce(sum(ls.value_mkd) FILTER (WHERE ls.stale), 0)   AS stale_v,
         count(DISTINCT ls.lk) FILTER (WHERE ls.in_total)         AS lists_with_sales
  FROM ls
),
wt AS (
  SELECT count(*) AS worked,
         count(*) FILTER (WHERE wk.outcome = 'sale')   AS w_sale,
         count(*) FILTER (WHERE wk.outcome = 'cancel') AS w_no,
         count(*) FILTER (WHERE wk.outcome = 'trash')  AS w_trash,
         count(DISTINCT wk.p8)                         AS customers,
         count(DISTINCT wk.person_id)                  AS people
  FROM wk
),
-- the rest of ElyonCRM (direct, no detail): the footer that makes the tab add
-- up to the Overview's ElyonCRM card
er AS (
  SELECT sr.split,
         count(*) FILTER (WHERE sr.in_total)                AS n,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.in_total), 0) AS v,
         coalesce(sum(sr.cod_mkd) FILTER (WHERE sr.bucket = 'paid'), 0) AS cash
  FROM sr
  WHERE sr.cur
  GROUP BY sr.split
),
erj AS (
  SELECT jsonb_build_object(
    'count',     coalesce(sum(er.n), 0),
    'value_mkd', round(coalesce(sum(er.v), 0)),
    'splits',    coalesce(jsonb_agg(jsonb_build_object('key', er.split, 'count', er.n, 'value_mkd', round(er.v),
                                                       'cash_mkd', round(er.cash)) ORDER BY er.split)
                          FILTER (WHERE er.n > 0), '[]'::jsonb)) AS j
  FROM er
),
pv AS (
  SELECT count(*) FILTER (WHERE sr.in_total)                       AS n,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.in_total), 0) AS v,
         coalesce(sum(sr.cod_mkd) FILTER (WHERE sr.bucket = 'paid'), 0) AS cash
  FROM sr
  WHERE sr.prev AND sr.split = 'prediction_list'
),
-- the sellers: sales, cash, decisions and (where presence covers the day)
-- active minutes
pd AS (
  SELECT sp.id AS person_id, d.day, d.active_minutes
  FROM public.agent_presence_days d
  JOIN public.sales_people sp ON sp.user_id = d.user_id
  CROSS JOIN prm
  WHERE d.day BETWEEN prm.fd AND prm.td
),
aps AS (
  SELECT ls.person_id,
         count(*) FILTER (WHERE ls.in_total)                      AS n,
         coalesce(sum(ls.value_mkd) FILTER (WHERE ls.in_total), 0) AS v,
         coalesce(sum(ls.cod_mkd) FILTER (WHERE ls.bucket = 'paid'), 0) AS cash,
         count(*) FILTER (WHERE ls.bucket = 'paid')               AS paid_n,
         count(*) FILTER (WHERE ls.bucket = 'returned')           AS ret_n,
         count(DISTINCT ls.lk) FILTER (WHERE ls.in_total)         AS lists,
         count(*) FILTER (WHERE ls.in_total AND EXISTS (
           SELECT 1 FROM pd WHERE pd.person_id = ls.person_id AND pd.day = ls.sale_day)) AS n_pres
  FROM ls
  WHERE ls.person_id IS NOT NULL
  GROUP BY ls.person_id
),
apw AS (
  SELECT wk.person_id, count(*) AS w,
         count(*) FILTER (WHERE wk.outcome = 'cancel') AS w_no,
         count(*) FILTER (WHERE wk.outcome = 'trash')  AS w_trash
  FROM wk
  WHERE wk.person_id IS NOT NULL
  GROUP BY wk.person_id
),
apr AS (
  SELECT pd.person_id, sum(pd.active_minutes) AS act, count(*) AS days FROM pd GROUP BY pd.person_id
),
agj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'person_id',     x.person_id,
    'name',          sp.display_name,
    'sales',         coalesce(aps.n, 0),
    'value_mkd',     round(coalesce(aps.v, 0)),
    'cash_mkd',      round(coalesce(aps.cash, 0)),
    'paid',          coalesce(aps.paid_n, 0),
    'returned',      coalesce(aps.ret_n, 0),
    'lists',         coalesce(aps.lists, 0),
    'worked',        coalesce(apw.w, 0),
    'worked_no',     coalesce(apw.w_no, 0),
    'worked_trash',  coalesce(apw.w_trash, 0),
    'active_minutes', apr.act,
    'presence_days', coalesce(apr.days, 0),
    'sales_on_presence_days', coalesce(aps.n_pres, 0))
    ORDER BY coalesce(aps.n, 0) DESC, coalesce(aps.v, 0) DESC, coalesce(apw.w, 0) DESC, sp.display_name), '[]'::jsonb) AS j
  FROM (SELECT aps.person_id FROM aps UNION SELECT apw.person_id FROM apw) x
  LEFT JOIN aps ON aps.person_id = x.person_id
  LEFT JOIN apw ON apw.person_id = x.person_id
  LEFT JOIN apr ON apr.person_id = x.person_id
  LEFT JOIN public.sales_people sp ON sp.id = x.person_id
),
-- quality: what the numbers above cannot vouch for yet (review queues only)
gh AS (                    -- 0-ден call-outcome rows holding a parcel or a sold status
  SELECT o.display_id, o.mex_cod_mkd, o.created_at
  FROM public.orders o
  CROSS JOIN prm
  WHERE o.sale_source = 'elyon_crm'
    AND o.sale_source_detail = 'disposition'
    AND o.created_at BETWEEN prm.f AND prm.t
    AND (o.mex_tracking_id IS NOT NULL
         OR o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
    AND NOT public.insights_excluded8(public.insights_phone8(o.customer_phone), prm.ex)
),
sw AS (                    -- stale to-pack sales with a MEX parcel on the same number since
  SELECT ls.order_id
  FROM ls
  WHERE ls.stale AND ls.phone8 IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.mex_parcels p
                 WHERE p.phone8 = ls.phone8 AND p.created_at_mex >= ls.sale_at - interval '1 day')
),
dq AS (                    -- still to pack, while a duplicate of it was sold / shipped
  SELECT ls.order_id, ls.display_id, d.display_id AS dup_display_id
  FROM ls
  JOIN public.orders d ON d.duplicated_from = ls.order_id
  WHERE ls.bucket = 'to_pack'
    AND (d.mex_tracking_id IS NOT NULL OR d.status::text IN ('shipped', 'delivered', 'paid', 'returned'))
),
nr AS (                    -- a list sale whose list was not recorded (a duplicate that lost it)
  SELECT ls.display_id, ls.value_mkd, ls.sale_at, src.display_id AS dup_of, src.prediction_list_name AS dup_of_list
  FROM ls
  CROSS JOIN prm
  LEFT JOIN public.orders src ON src.id = ls.duplicated_from
  WHERE ls.lk = prm.nil AND ls.in_total
),
qj AS (
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'unproven_paid',
      'count', (SELECT count(*) FROM ls WHERE ls.bucket = 'paid_unproven'),
      'value_mkd', (SELECT round(coalesce(sum(ls.value_mkd), 0)) FROM ls WHERE ls.bucket = 'paid_unproven'),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT ls.display_id FROM ls WHERE ls.bucket = 'paid_unproven' ORDER BY ls.sale_at LIMIT 10) s)),
    jsonb_build_object('kind', 'stale_to_pack',
      'count', (SELECT count(*) FROM ls WHERE ls.stale),
      'value_mkd', (SELECT round(coalesce(sum(ls.value_mkd), 0)) FROM ls WHERE ls.stale),
      'with_parcel', (SELECT count(*) FROM sw),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT ls.display_id FROM ls WHERE ls.stale ORDER BY ls.sale_at LIMIT 10) s)),
    jsonb_build_object('kind', 'duplicate_original_open',
      'count', (SELECT count(DISTINCT dq.order_id) FROM dq),
      'samples', (SELECT coalesce(jsonb_agg(s.x), '[]'::jsonb) FROM (
                    SELECT dq.display_id || ' → ' || dq.dup_display_id AS x FROM dq ORDER BY dq.display_id LIMIT 10) s)),
    jsonb_build_object('kind', 'list_not_recorded',
      'count', (SELECT count(*) FROM nr),
      'value_mkd', (SELECT round(coalesce(sum(nr.value_mkd), 0)) FROM nr),
      'samples', (SELECT coalesce(jsonb_agg(s.x), '[]'::jsonb) FROM (
                    SELECT nr.display_id || coalesce(' ← ' || nr.dup_of, '') AS x FROM nr ORDER BY nr.sale_at LIMIT 10) s)),
    jsonb_build_object('kind', 'ghost_dispositions',
      'count', (SELECT count(*) FROM gh),
      'cod_mkd', (SELECT round(coalesce(sum(gh.mex_cod_mkd), 0)) FROM gh),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT gh.display_id FROM gh ORDER BY gh.created_at LIMIT 10) s)),
    jsonb_build_object('kind', 'no_seller',
      'count', (SELECT count(*) FROM ls WHERE ls.q_no_seller),
      'value_mkd', (SELECT round(coalesce(sum(ls.value_mkd), 0)) FROM ls WHERE ls.q_no_seller),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT ls.display_id FROM ls WHERE ls.q_no_seller ORDER BY ls.sale_at LIMIT 10) s)),
    jsonb_build_object('kind', 'cancelled_but_moving',
      'count', (SELECT count(*) FROM ls WHERE ls.q_cancelled_but_moving),
      'value_mkd', (SELECT round(coalesce(sum(ls.value_mkd), 0)) FROM ls WHERE ls.q_cancelled_but_moving),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT ls.display_id FROM ls WHERE ls.q_cancelled_but_moving ORDER BY ls.sale_at LIMIT 10) s)),
    jsonb_build_object('kind', 'zero_cod_parcels',
      'count', (SELECT count(*) FROM ls WHERE ls.q_zero_cod),
      'cod_mkd', (SELECT round(coalesce(sum(ls.cod_mkd), 0)) FROM ls WHERE ls.q_zero_cod),
      'samples', (SELECT coalesce(jsonb_agg(s.display_id), '[]'::jsonb) FROM (
                    SELECT ls.display_id FROM ls WHERE ls.q_zero_cod ORDER BY ls.sale_at LIMIT 10) s))) AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from',           to_char(prm.fd, 'YYYY-MM-DD'),
    'to',             to_char(prm.td, 'YYYY-MM-DD'),
    'today',          to_char(prm.today, 'YYYY-MM-DD'),
    'generated_at',   now(),
    'money',          true,
    'clock',          'sale',
    'granularity',    prm.gran,
    'trend_from',     to_char(prm.sfd, 'YYYY-MM-DD'),
    'stale_days',     prm.stale,
    'has_prev',       (prm.pf IS NOT NULL),
    'first_attr_day', (SELECT to_char((min(o.created_at) AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD')
                         FROM public.orders o WHERE o.prediction_list_id IS NOT NULL),
    'presence_from',  (SELECT to_char(min(d.day), 'YYYY-MM-DD') FROM public.agent_presence_days d)),
  'total', jsonb_build_object(
    'count',            tot.n,
    'value_mkd',        round(tot.v),
    'cod_mkd',          round(tot.c),
    'cash_mkd',         round(tot.cash),
    'paid',             tot.paid_n,
    'returned',         tot.ret_n,
    'units',            tot.units,
    'stale_to_pack',    tot.stale_n,
    'stale_to_pack_value_mkd', round(tot.stale_v),
    'lists_with_sales', tot.lists_with_sales,
    'worked',           wt.worked,
    'worked_sale',      wt.w_sale,
    'worked_no',        wt.w_no,
    'worked_trash',     wt.w_trash,
    'customers',        wt.customers,
    'people',           wt.people,
    'no_answer',        (SELECT count(*) FROM na),
    'no_answer_unlisted', (SELECT coalesce(sum(naa.n), 0) FROM naa WHERE naa.lk = prm.nil),
    'orders',           tot.n,
    'web',              0,
    'mex_only',         0),
  'buckets',        btj.buckets,
  'outside',        btj.outside,
  'lists',          (SELECT lj.j FROM lj),
  'not_recorded', jsonb_build_object(
    'count',        coalesce((SELECT la.n FROM la WHERE la.lk = prm.nil), 0),
    'value_mkd',    round(coalesce((SELECT la.v FROM la WHERE la.lk = prm.nil), 0)),
    'cash_mkd',     round(coalesce((SELECT la.cash FROM la WHERE la.lk = prm.nil), 0)),
    'paid',         coalesce((SELECT la.paid_n FROM la WHERE la.lk = prm.nil), 0),
    'returned',     coalesce((SELECT la.ret_n FROM la WHERE la.lk = prm.nil), 0),
    'units',        coalesce((SELECT la.units FROM la WHERE la.lk = prm.nil), 0),
    'stale_to_pack', coalesce((SELECT la.stale_n FROM la WHERE la.lk = prm.nil), 0),
    'buckets',      coalesce((SELECT lbj.buckets FROM lbj WHERE lbj.lk = prm.nil), '[]'::jsonb),
    'outside',      coalesce((SELECT lbj.outside FROM lbj WHERE lbj.lk = prm.nil), '[]'::jsonb),
    'worked',       coalesce((SELECT wa.worked FROM wa WHERE wa.lk = prm.nil), 0),
    'samples',      (SELECT coalesce(jsonb_agg(jsonb_build_object('display_id', nr.display_id, 'dup_of', nr.dup_of,
                                                                  'dup_of_list', nr.dup_of_list) ORDER BY nr.sale_at), '[]'::jsonb)
                       FROM (SELECT * FROM nr ORDER BY nr.sale_at LIMIT 10) nr)),
  'elyon_crm',      (SELECT erj.j FROM erj),
  'prev',           CASE WHEN prm.pf IS NULL THEN NULL ELSE
                      (SELECT jsonb_build_object('count', pv.n, 'value_mkd', round(pv.v), 'cash_mkd', round(pv.cash)) FROM pv) END,
  'trend',          (SELECT tj.j FROM tj),
  'agents',         (SELECT agj.j FROM agj),
  'quality',        (SELECT qj.j FROM qj))
FROM prm, tot, wt, btj
  $q$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_lo, public.report_excluded_phone8s(),
        v_fd, v_td, v_sfd, v_gran, v_today, v_stale;

  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.insights_lists(timestamptz, timestamptz, timestamptz, timestamptz, boolean, integer) IS
  'GET /api/insights/lists (Insights → Prediction lists, 2026-09-28): the ElyonCRM prediction-list slice of THE sale cohort (insights_sale_rows) per list — members now, worked decisions (v_sales_work), no-answer clicks (by the list the number is in now, approximate), sales, MEX-first buckets (Σ = total), MEX cash, units, stale to-pack, last sale, top sellers, trend — with the "list not recorded" row and the rest of ElyonCRM so it ties to the Overview. p_money = false strips every *_mkd / *_eur key. Migration 20260941000400.';

-- ── The cash-flow line (called by the api IN PARALLEL with insights_lists) ─
-- MEX COD of prediction-list sales' parcels DELIVERED in the window (any sale
-- day), read from the foundation's insights_cash_rows (one owner per parcel,
-- test phones never), split into "from this period's sales" / "from earlier
-- sales" by the owner's sale day. p_money = false → parcels only.
CREATE OR REPLACE FUNCTION public.insights_lists_cash(
  p_from   timestamptz,
  p_to_end timestamptz,
  p_money  boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET jit = off
AS $fn$
  SELECT CASE WHEN coalesce(p_money, false) THEN x.j ELSE public.insights_strip_money(x.j) END
  FROM (
    SELECT jsonb_build_object(
      'parcels',              count(c.tracking_id),
      'cod_mkd',              round(coalesce(sum(c.cod_mkd), 0)),
      'from_this_period_mkd', round(coalesce(sum(c.cod_mkd) FILTER (WHERE c.sale_at BETWEEN p_from AND p_to_end), 0)),
      'from_earlier_mkd',     round(coalesce(sum(c.cod_mkd) FILTER (WHERE c.sale_at IS NULL
                                                                      OR NOT (c.sale_at BETWEEN p_from AND p_to_end)), 0)),
      'from_earlier',         count(c.tracking_id) FILTER (WHERE c.sale_at IS NULL
                                                             OR NOT (c.sale_at BETWEEN p_from AND p_to_end))) AS j
    FROM public.insights_cash_rows(p_from, p_to_end) c
    WHERE c.source = 'elyon_crm' AND c.split = 'prediction_list'
  ) x
$fn$;

COMMENT ON FUNCTION public.insights_lists_cash(timestamptz, timestamptz, boolean) IS
  'Insights → Prediction lists, the cash-flow line: MEX COD of prediction-list parcels delivered in the window (insights_cash_rows, source elyon_crm / split prediction_list), from this period''s sales vs earlier ones. p_money = false keeps the parcel counts only. Migration 20260941000400.';

REVOKE ALL ON FUNCTION public.insights_lists(timestamptz, timestamptz, timestamptz, timestamptz, boolean, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_lists_cash(timestamptz, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_lists(timestamptz, timestamptz, timestamptz, timestamptz, boolean, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_lists_cash(timestamptz, timestamptz, boolean)
  TO service_role;

-- The read-only verification harness (scripts/verify-tab-lists.mjs, and C3 of
-- scripts/verify-attribution.mjs) calls it through the Management API with
-- read_only: true = supabase_read_only_user (pg_read_all_data already reads
-- every table it reads). Conditional so a fresh local database migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_lists(timestamptz, timestamptz, timestamptz, timestamptz, boolean, integer)
      TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_lists_cash(timestamptz, timestamptz, boolean)
      TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
