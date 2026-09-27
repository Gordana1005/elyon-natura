-- ============================================================================
-- CONNECTED OVERVIEW — every denar by source, team and person, with MEX-proven
-- cash kept apart from claims (Phase 5 of the 2026-09-27 money plan)
--
-- Adds, read-side only (no table is written, no trigger, no backfill):
--   insights_overview(p_from, p_to_end, p_prev_from, p_prev_to_end) → jsonb
--       everything GET /api/insights/overview returns except `meta`:
--       freshness · kpis (+prev, +spark) · sources · trend · teams · attention
--   insights_pivot(p_from, p_to_end, p_by text[]) → jsonb
--       the lazy drill-down table behind GET /api/insights/pivot
--   overview_jnum(jsonb) → numeric   tolerant number reader for the web block
--   seven indexes (section 1): the SOLD and CASH clocks on orders, the
--   unlinked-delivered slice of mex_parcels, altercpa_leads.decided_at (the
--   work ledger), and the last-8-digit phone expression on orders
--
-- Bounds: p_from and p_to_end are INCLUSIVE instants (the api sends Skopje
-- 00:00 and Skopje 23:59:59.999999 of the last day — overview.ts
-- overviewWindows); GET /orders?created_from&created_to uses the very same
-- two instants, so a drill-down lists exactly the orders counted here.
--
-- Timings (EXPLAIN ANALYZE on live data 2026-09-28, before these indexes
-- existed): 1 day + compare 0,62 s · 30 days + compare 0,90 s · 12 months +
-- previous 12 months 2,09 s.
--
-- Money is INCLUDED in the jsonb. The api edge function strips every money
-- field for a non-owner admin/manager (whitelist, supabase/functions/api/
-- overview.ts) — the RPC itself is service_role only, like every insights RPC.
--
-- ── THREE CLOCKS — each figure is on exactly one, never mixed ───────────────
--   PLACED   an order belongs to the period it was CREATED in (Skopje day).
--            The shop panel's rule. Drives: placed, buckets, worked,
--            cohort_sold, conversion, money{collected,to_collect,lost},
--            at_courier, to_collect, lost, trend placed_*, pivot.
--            GET /orders?created_from&created_to&outcome&sale_source opens
--            exactly these orders (same bounds, same bucket predicates).
--   SOLD     the instant the order became a sale: sold_at (write-once, the
--            decider's time); for a sale nobody was credited with (AlterCPA
--            says cancelled but MEX delivered it — 1.900 such rows since
--            08-01) confirmed_at, else created_at. Drives: confirmed,
--            confirmed_value_eur, aov_eur, teams.confirmed / sold_value_eur.
--            GET /orders?sold_from&sold_to opens exactly these.
--   CASH     the day the money landed: the linked MEX parcel's delivered_at
--            (orders.mex_delivered_at, write-once) — PROVEN; for a paid order
--            without a delivered parcel its paid_at — UNPROVEN, labelled as
--            such; for a delivered parcel no order owns (MEX-only) the
--            parcel's delivered_at. Drives: kpis.delivered (the hero reads
--            delivered.proven_cod_mkd), unproven_paid, sources[].cash,
--            trend delivered_*, spark delivered_cash_mkd, teams cash.
--
-- ── OUTCOME BUCKETS (the shop panel's, applied to CRM orders) ───────────────
--   awaiting  pending · take · call_again · duplicated (an open duplicate is
--             workable exactly like a pending — OPEN_ORDER_STATES in the api)
--   preparing confirmed, not packed (packed_at NULL)  — "to pack"
--   packed    confirmed, packed                        — preparing + packed =
--             the shop's "preparing"
--   courier   shipped
--   delivered paid · delivered
--   returned  returned
--   cancelled cancelled          trashed   trashed
--   Every order is in exactly one bucket, so Σ buckets = placed.
--   mex_only  (teleshop_other and web only) delivered MEX parcels no order
--             owns, by the parcel's created_at_mex — shown next to the bar,
--             NOT part of placed (we never saw them as orders).
--   Money:  collected = delivered (linked COD when proven, else price × 61.5)
--           to collect = preparing + packed + courier (price)
--           lost = returned + cancelled/trashed AFTER a sale decision
--                  (sold_at set — e.g. the 345 no_parcel_7d cancels)
--
-- ── SOURCES (orders.sale_source, migration 20260935000000) ─────────────────
--   altercpa        altercpa (+ affiliate, 0 rows — a partner lead is a lead)
--                   splits new | returning customer (an EARLIER order on the
--                   same last-8 phone, any source, any outcome)
--   elyon_crm       elyon_crm — splits prediction_list | direct | disposition
--                   (disposition = the 0 ден "no" rows /calls writes; they are
--                   worked, never sold, never money)
--   web             web orders in the CRM (0 today) + the shop mirror when
--                   public.insights_web_block(text,text) exists (web-sync
--                   work, migrations 20260937…); until then the web shop's
--                   own MEX parcels (sender_reference/tracking NTMK…). On the
--                   CASH clock web = NTMK parcels + parcels a web order claims
--                   (web_orders.mex_tracking_id), always.
--   teleshop_other  collabbox (+ legacy, never monadon_legacy) + MEX-only
--                   delivered parcels that are not the web shop's (not NTMK,
--                   not claimed by a web order)
--
-- ── THE WEB SHOP OBJECTS (read when present, never required) ────────────────
-- Everything web is reached through EXECUTE, guarded by to_regprocedure /
-- to_regclass, inside its own exception block: this migration installs and
-- runs before 20260937… exists, and a broken web object degrades the web row
-- (freshness says why) instead of failing the Overview.
--   insights_web_block(p_from, p_to_end)  {buckets{…: {count, value_mkd}},
--       money{collected_mkd, to_collect_mkd, lost_mkd, unrecorded_mkd},
--       placed{count, value_mkd}, daily[{d, placed_count, placed_value_mkd}]}
--       → the web row's placed / buckets (+ no_record) / money (cohort);
--       numbers read with overview_jnum, a missing key reads as 0
--   web_sync_runs     status running|ok|partial|failed → the web feed
--   web_orders        mex_tracking_id → which parcels are web sales;
--                     awaiting/preparing (web_order_outcome) older than 24 h,
--                     last 60 days → attention web_waiting_24h
--
-- ── ATTENTION (the rail; only kinds with count > 0 are returned) ────────────
--   approved_no_parcel_7d  now: AlterCPA sale (confirmed) with no parcel 7
--                          days after the sale, not postponed — per decider
--   mex_problem            now: the order's own parcel is Problematic (3) /
--                          Delivery attempted (9) / Rejected (13)
--                          (both are GET /orders?attention=… — keep in step
--                          with overview.ts attentionFilter)
--   cod_mismatch           window: delivered/returned parcels whose COD is
--                          neither price × 61.5 (±3) nor that + 150 (±3)
--   unlinked_parcels       window: delivered parcels no order owns, not web
--   stale_feed             freshness entries stale/failed
--   web_waiting_24h        see above
--   night_approvals        window: AlterCPA approvals 23:00–05:59 Skopje
--   burst_approvals        window: ≥ 8 AlterCPA approvals by one operator
--                          inside 10 minutes (every approval in such a burst)
-- `sample` entries carry no money in `note`; amounts sit in *_mkd / *_eur
-- fields the non-owner strip removes.
--
-- Rules inherited from the other insights RPCs: SECURITY DEFINER, service_role
-- EXECUTE only (+ the read-only harness role, section 3), SET search_path +
-- TimeZone. Bare dates never reach SQL: the api
-- passes Skopje-midnight / Skopje-end-of-day instants (overview.ts
-- overviewWindows), and every day bucket here is AT TIME ZONE 'Europe/Skopje'.
-- 61.5 is the FROZEN peg (src/lib/currency.ts) — used only to express a price
-- in denari next to a COD, never to re-price anything.
--
-- plpgsql + EXECUTE … USING on purpose: each call is planned with its REAL
-- bounds (a one-day window uses the indexes, a 12-month one seq-scans), where
-- a LANGUAGE sql body would be planned once, generically, for every range.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. Indexes for the SOLD and CASH clocks ─────────────────────────────────
-- Partial: only rows that have the instant at all. orders is ~105k rows /
-- 44 MB, so each build is sub-second; the lock is held that long.
CREATE INDEX IF NOT EXISTS idx_orders_sold_at
  ON public.orders (sold_at) WHERE sold_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_mex_delivered_at
  ON public.orders (mex_delivered_at) WHERE mex_delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_mex_returned_at
  ON public.orders (mex_returned_at) WHERE mex_returned_at IS NOT NULL;
-- The SOLD clock's fallback for a sale nobody was credited with (~3.3k rows).
CREATE INDEX IF NOT EXISTS idx_orders_confirmed_at_unsold
  ON public.orders (confirmed_at) WHERE sold_at IS NULL AND confirmed_at IS NOT NULL;
-- MEX-only sales: delivered parcels no order owns (~26k of 60k parcels).
CREATE INDEX IF NOT EXISTS idx_mex_parcels_unlinked_delivered
  ON public.mex_parcels (delivered_at) WHERE order_id IS NULL AND status_id = 2;
-- The work ledger by decision time (v_sales_work's AlterCPA branch filters on
-- it; without this every Overview call seq-scans the 55 MB ledger).
CREATE INDEX IF NOT EXISTS idx_altercpa_leads_decided_at
  ON public.altercpa_leads (decided_at) WHERE decision IS NOT NULL;
-- Last-8 phone digits — the CRM's phone-matching canon — as an expression
-- index. The Overview asks "did this phone order before?" for a window's
-- AlterCPA leads; for a short window that becomes a handful of index probes
-- instead of a regexp over the whole table. The expression must stay
-- character-for-character identical to the one in insights_overview.
CREATE INDEX IF NOT EXISTS idx_orders_phone_last8
  ON public.orders ((right(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 8)));

-- ── 2. A number out of jsonb, never an error ────────────────────────────────
CREATE OR REPLACE FUNCTION public.overview_jnum(p jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE jsonb_typeof(p)
           WHEN 'number' THEN (p #>> '{}')::numeric
           WHEN 'string' THEN CASE WHEN (p #>> '{}') ~ '^\s*-?[0-9]{1,15}([.][0-9]+)?\s*$'
                                   THEN btrim(p #>> '{}')::numeric END
         END;
$fn$;

COMMENT ON FUNCTION public.overview_jnum(jsonb) IS
  'A JSON number or numeric string → numeric; anything else → NULL. Never raises. Reads the optional web block in insights_overview.';

REVOKE ALL ON FUNCTION public.overview_jnum(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.overview_jnum(jsonb) TO service_role;

-- ── 3. insights_overview ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_overview(
  p_from        text,
  p_to_end      text,
  p_prev_from   text DEFAULT NULL,
  p_prev_to_end text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_from      timestamptz;
  v_to        timestamptz;
  v_pf        timestamptz;
  v_pt        timestamptz;
  v_web       jsonb;
  v_web_prev  jsonb;
  v_web_fresh jsonb;
  v_web_err   text;
  v_claimed   text[];
  v_waiting   jsonb;
  v_out       jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_from, '')), '') IS NULL OR nullif(btrim(coalesce(p_to_end, '')), '') IS NULL THEN
    RAISE EXCEPTION 'insights_overview: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  v_from := p_from::timestamptz;
  v_to   := p_to_end::timestamptz;
  IF v_to < v_from THEN
    RAISE EXCEPTION 'insights_overview: p_to_end is before p_from' USING ERRCODE = '22023';
  END IF;
  IF v_to - v_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_overview: window longer than 800 days' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(coalesce(p_prev_from, '')), '') IS NOT NULL
     AND nullif(btrim(coalesce(p_prev_to_end, '')), '') IS NOT NULL THEN
    v_pf := p_prev_from::timestamptz;
    v_pt := p_prev_to_end::timestamptz;
    IF v_pt < v_pf OR v_pt - v_pf > interval '800 days' THEN
      v_pf := NULL; v_pt := NULL;
    END IF;
  END IF;

  -- The web shop mirror, when the web-sync migrations have landed. Dynamic on
  -- purpose: this function must install and run before they exist.
  IF to_regprocedure('public.insights_web_block(text,text)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.insights_web_block($1, $2)' INTO v_web USING p_from, p_to_end;
      IF v_pf IS NOT NULL THEN
        EXECUTE 'SELECT public.insights_web_block($1, $2)' INTO v_web_prev USING p_prev_from, p_prev_to_end;
      END IF;
      IF v_web IS NOT NULL AND jsonb_typeof(v_web) <> 'object' THEN v_web := NULL; END IF;
      IF v_web_prev IS NOT NULL AND jsonb_typeof(v_web_prev) <> 'object' THEN v_web_prev := NULL; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_web := NULL; v_web_prev := NULL; v_web_err := left(SQLERRM, 200);
    END;
  END IF;

  -- web_sync_runs (20260937000000): status running | ok | partial | failed.
  IF to_regclass('public.web_sync_runs') IS NOT NULL THEN
    BEGIN
      EXECUTE $w$
        SELECT jsonb_build_object(
          'last_ok_at',  (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')),
          'last_status', (SELECT r.status FROM public.web_sync_runs r
                           WHERE r.status <> 'running' ORDER BY r.started_at DESC LIMIT 1),
          'last_error',  (SELECT left(r.error, 200) FROM public.web_sync_runs r
                           WHERE r.status = 'failed' ORDER BY r.started_at DESC LIMIT 1))
      $w$ INTO v_web_fresh;
    EXCEPTION WHEN OTHERS THEN
      v_web_fresh := jsonb_build_object('error', left(SQLERRM, 200));
    END;
  END IF;

  -- web_orders (20260937000000): the parcels web orders claim (they are web
  -- sales, never teleshop MEX-only), and web orders still not handed to the
  -- courier a day after they were placed (last 60 days; older never-closed
  -- OpenCart rows are history, not a queue).
  IF to_regclass('public.web_orders') IS NOT NULL THEN
    BEGIN
      EXECUTE $w$
        SELECT array_agg(DISTINCT w.mex_tracking_id)
        FROM public.web_orders w
        WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
      $w$ INTO v_claimed;
      EXECUTE $w$
        SELECT jsonb_build_object('count', count(*), 'value_mkd', coalesce(sum(w.total), 0),
                                  'oldest_at', min(w.created_at))
        FROM public.web_orders w
        WHERE w.deleted_in_shop_at IS NULL
          AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) IN ('awaiting', 'preparing')
          AND w.created_at <  now() - interval '24 hours'
          AND w.created_at >= now() - interval '60 days'
      $w$ INTO v_waiting;
    EXCEPTION WHEN OTHERS THEN
      v_claimed := NULL; v_waiting := NULL;
    END;
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 web block ·
  -- $6 web block (prev) · $7 web_sync_runs summary · $8 web block error ·
  -- $9 long window (> 31 days: history lookup scans once instead of probing) ·
  -- $10 MEX tracking ids web orders claim · $11 web orders waiting > 24 h
  EXECUTE $core$
WITH
prm AS (
  SELECT z.f, z.t, z.pf, z.pt,
         (z.f AT TIME ZONE 'Europe/Skopje')::date AS fd,
         (z.t AT TIME ZONE 'Europe/Skopje')::date AS td
  FROM (SELECT $1::timestamptz AS f, $2::timestamptz AS t,
               $3::timestamptz AS pf, $4::timestamptz AS pt) z
),
win1 AS (
  SELECT p.*,
         (p.td - p.fd + 1)                                               AS ndays,
         CASE WHEN p.td - p.fd + 1 <= 62 THEN 'day' ELSE 'month' END      AS gran,
         -- The spark always shows at least 14 Skopje days, so one day has context.
         CASE WHEN p.td - p.fd + 1 >= 14 THEN p.fd ELSE p.td - 13 END     AS sfd
  FROM prm p
),
win AS (
  SELECT w.*,
         least(w.f, (w.sfd::timestamp AT TIME ZONE 'Europe/Skopje'))      AS sf,
         CASE WHEN w.td - w.sfd + 1 <= 62 THEN 'day' ELSE 'month' END     AS sgran,
         least(w.f, coalesce(w.pf, w.f), (w.sfd::timestamp AT TIME ZONE 'Europe/Skopje')) AS w0,
         CASE WHEN w.td - w.fd + 1 <= 62 THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt,
         CASE WHEN w.td - w.sfd + 1 <= 62 THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt
  FROM win1 w
),
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('web', 3), ('teleshop_other', 4)) v(src, ord)
),
bks AS (
  SELECT * FROM (VALUES ('awaiting', 1), ('preparing', 2), ('packed', 3), ('courier', 4),
                        ('delivered', 5), ('returned', 6), ('cancelled', 7), ('trashed', 8)) v(bucket, ord)
),

-- ── every order any clock of any window can reach — scanned ONCE, and ────
-- materialised once with its three clocks, its bucket and its window flags.
f AS MATERIALIZED (
  SELECT d.*,
         (d.created_at BETWEEN w.f  AND w.t)  AS in_cur,
         (d.created_at BETWEEN w.pf AND w.pt) AS in_prev,
         (d.sale_at    BETWEEN w.f  AND w.t)  AS sale_cur,
         (d.sale_at    BETWEEN w.pf AND w.pt) AS sale_prev,
         (d.cash_at    BETWEEN w.f  AND w.t)  AS cash_cur,
         (d.cash_at    BETWEEN w.pf AND w.pt) AS cash_prev,
         (d.created_at BETWEEN w.sf AND w.t)  AS in_spark,
         (d.cash_at    BETWEEN w.sf AND w.t)  AS cash_spark,
         (d.created_at AT TIME ZONE 'Europe/Skopje')::date AS cday,
         (d.cash_at    AT TIME ZONE 'Europe/Skopje')::date AS kday
  FROM (
    SELECT o.*,
           CASE WHEN o.is_sale THEN coalesce(o.sold_at, o.confirmed_at, o.created_at) END AS sale_at,
           CASE WHEN o.bucket = 'delivered' THEN coalesce(o.mex_delivered_at, o.paid_at, o.created_at) END AS cash_at,
           CASE WHEN o.bucket = 'delivered' THEN
                CASE WHEN o.mex_delivered_at IS NOT NULL AND o.mex_cod_mkd IS NOT NULL
                     THEN o.mex_cod_mkd::numeric ELSE round(o.price * 61.5) END END       AS cash_mkd,
           (o.bucket = 'delivered' AND o.mex_delivered_at IS NOT NULL)                     AS proven,
           (o.bucket IN ('cancelled', 'trashed') AND o.sold_at IS NOT NULL)                AS lost_after_confirm,
           CASE WHEN o.bucket IN ('courier', 'returned')
                THEN coalesce(o.mex_cod_mkd::numeric, round(o.price * 61.5)) END         AS parcel_mkd
    FROM (
  SELECT x.id, x.display_id, x.status::text AS status,
         coalesce(x.price, 0)::numeric AS price,
         x.sale_source, x.sale_source_detail,
         CASE WHEN x.sale_source IN ('altercpa', 'affiliate') THEN 'altercpa'
              WHEN x.sale_source = 'elyon_crm'                THEN 'elyon_crm'
              WHEN x.sale_source = 'web'                      THEN 'web'
              ELSE 'teleshop_other' END                       AS src,
         x.created_at, x.sold_at, x.confirmed_at, x.sold_by_person_id, x.paid_at,
         x.mex_delivered_at, x.mex_returned_at, x.mex_cod_mkd,
         x.customer_phone,
         CASE WHEN x.status IN ('pending', 'take', 'call_again', 'duplicated') THEN 'awaiting'
              WHEN x.status = 'confirmed' AND x.packed_at IS NOT NULL      THEN 'packed'
              WHEN x.status = 'confirmed'                                  THEN 'preparing'
              WHEN x.status = 'shipped'                                    THEN 'courier'
              WHEN x.status IN ('paid', 'delivered')                       THEN 'delivered'
              WHEN x.status = 'returned'                                   THEN 'returned'
              WHEN x.status = 'cancelled'                                  THEN 'cancelled'
              WHEN x.status = 'trashed'                                    THEN 'trashed'
              ELSE 'awaiting' END                                          AS bucket,
         (coalesce(x.sale_source_detail, '') <> 'disposition'
          AND (x.sold_at IS NOT NULL
               OR x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))) AS is_sale
  FROM public.orders x, win w
  WHERE (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
    AND (   x.created_at       BETWEEN w.w0 AND w.t
         OR x.sold_at          BETWEEN w.w0 AND w.t
         OR (x.sold_at IS NULL AND x.confirmed_at BETWEEN w.w0 AND w.t)
         OR x.mex_delivered_at BETWEEN w.w0 AND w.t
         OR x.mex_returned_at  BETWEEN w.w0 AND w.t
         OR x.paid_at          BETWEEN w.w0 AND w.t)
    ) o
  ) d, win w
),

-- ── delivered MEX parcels no order owns ────────────────────────────────────
mf AS MATERIALIZED (
  SELECT m.*,
         (m.created_at_mex BETWEEN w.f  AND w.t)  AS in_cur,
         (m.created_at_mex BETWEEN w.pf AND w.pt) AS in_prev,
         (m.delivered_at   BETWEEN w.f  AND w.t)  AS cash_cur,
         (m.delivered_at   BETWEEN w.pf AND w.pt) AS cash_prev,
         (m.delivered_at   BETWEEN w.sf AND w.t)  AS cash_spark,
         (m.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS kday
  FROM (
    SELECT p.tracking_id, p.account, p.series, coalesce(p.cod_mkd, 0)::numeric AS cod_mkd,
           p.created_at_mex, p.delivered_at,
           coalesce(p.tracking_id = ANY ($10::text[]), false) AS claimed,
           CASE WHEN coalesce(p.sender_reference, '') ~ '^NTMK' OR p.tracking_id ~ '^NTMK'
                     OR coalesce(p.tracking_id = ANY ($10::text[]), false)
                THEN 'web' ELSE 'teleshop_other' END AS src
    FROM public.mex_parcels p, win w
    WHERE p.order_id IS NULL AND p.status_id = 2
      AND (p.delivered_at BETWEEN w.w0 AND w.t OR p.created_at_mex BETWEEN w.w0 AND w.t)
  ) m, win w
),

-- ── the web shop mirror (optional) ─────────────────────────────────────────
wbk AS (
  SELECT e.per, e.k AS bucket,
         coalesce(public.overview_jnum(CASE WHEN jsonb_typeof(e.v) = 'object' THEN e.v -> 'count' ELSE e.v END), 0) AS n,
         coalesce(public.overview_jnum(CASE WHEN jsonb_typeof(e.v) = 'object'
                                            THEN coalesce(e.v -> 'value_mkd', e.v -> 'mkd', e.v -> 'cod_mkd') END), 0) AS mkd
  FROM (
    SELECT 'cur' AS per, j.key AS k, j.value AS v
    FROM jsonb_each(CASE WHEN jsonb_typeof($5::jsonb -> 'buckets') = 'object' THEN $5::jsonb -> 'buckets' ELSE '{}'::jsonb END) j
    UNION ALL
    SELECT 'prev', j.key, j.value
    FROM jsonb_each(CASE WHEN jsonb_typeof($6::jsonb -> 'buckets') = 'object' THEN $6::jsonb -> 'buckets' ELSE '{}'::jsonb END) j
  ) e
),
wsum AS (
  SELECT per,
         CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END IS NOT NULL                      AS present,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{placed,count}'), 0)         AS placed_n,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{placed,value_mkd}'), 0)     AS placed_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,collected_mkd}'), 0)  AS coll_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,to_collect_mkd}'), 0) AS tc_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,lost_mkd}'), 0)       AS lost_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,unrecorded_mkd}'), 0) AS unrec_mkd
  FROM (VALUES ('cur'), ('prev')) v(per)
),
wday AS (
  SELECT e ->> 'd' AS d,
         coalesce(public.overview_jnum(e -> 'placed_count'), 0)     AS n,
         coalesce(public.overview_jnum(e -> 'placed_value_mkd'), 0) AS mkd
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof($5::jsonb -> 'daily') = 'array' THEN $5::jsonb -> 'daily' ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'object' AND (e ->> 'd') ~ '^\d{4}-\d{2}-\d{2}$'
),

-- ── per-source aggregates over the order rows ─────────────────────────────
-- Pre-aggregated to (source × bucket × every flag) first — a few hundred
-- rows — so the forty FILTERed sums below never touch 100k order rows.
g AS (
  SELECT f.src, f.bucket, f.is_sale, f.proven, f.lost_after_confirm,
         coalesce(f.in_cur, false)    AS in_cur,   coalesce(f.in_prev, false)   AS in_prev,
         coalesce(f.sale_cur, false)  AS sale_cur, coalesce(f.sale_prev, false) AS sale_prev,
         coalesce(f.cash_cur, false)  AS cash_cur, coalesce(f.cash_prev, false) AS cash_prev,
         count(*) AS n, coalesce(sum(f.price), 0) AS eur,
         coalesce(sum(f.cash_mkd), 0) AS cash_mkd, coalesce(sum(f.parcel_mkd), 0) AS parcel_mkd
  FROM f GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
),
so AS (
  SELECT g.src,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur), 0)                                        AS placed_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur), 0)                                        AS placed_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev), 0)                                       AS p_placed_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev), 0)                                       AS p_placed_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur AND g.bucket <> 'awaiting'), 0)             AS worked,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur AND g.is_sale), 0)                          AS cohort_sold,
    coalesce(sum(g.n)   FILTER (WHERE g.sale_cur), 0)                                      AS conf_n,
    coalesce(sum(g.eur) FILTER (WHERE g.sale_cur), 0)                                      AS conf_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.sale_prev), 0)                                     AS p_conf_n,
    coalesce(sum(g.eur) FILTER (WHERE g.sale_prev), 0)                                     AS p_conf_eur,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.in_cur AND g.bucket = 'delivered'), 0)        AS coll_mkd,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.in_cur AND g.proven), 0)                      AS coll_proven_mkd,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur  AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS tc_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur  AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS tc_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS p_tc_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS p_tc_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur  AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS lost_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur  AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS lost_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS p_lost_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS p_lost_eur,
    coalesce(sum(g.n)          FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_n,
    coalesce(sum(g.eur)        FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_eur,
    coalesce(sum(g.parcel_mkd) FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_mkd,
    coalesce(sum(g.n)          FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_n,
    coalesce(sum(g.eur)        FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_eur,
    coalesce(sum(g.parcel_mkd) FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_cur), 0)                                 AS cash_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_cur), 0)                                 AS cash_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_cur AND g.proven), 0)                    AS cash_proven_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_cur AND g.proven), 0)                    AS cash_proven_mkd,
    coalesce(sum(g.eur)      FILTER (WHERE g.cash_cur AND NOT g.proven), 0)                AS unproven_eur,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_prev), 0)                                AS p_cash_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_prev), 0)                                AS p_cash_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_prev AND g.proven), 0)                   AS p_cash_proven_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_prev AND g.proven), 0)                   AS p_cash_proven_mkd,
    coalesce(sum(g.eur)      FILTER (WHERE g.cash_prev AND NOT g.proven), 0)               AS p_unproven_eur
  FROM g GROUP BY g.src
),
ms AS (
  SELECT m.src,
    count(*) FILTER (WHERE m.in_cur AND NOT m.claimed)                    AS coh_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.in_cur AND NOT m.claimed), 0) AS coh_mkd,
    count(*) FILTER (WHERE m.cash_cur)                      AS cash_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.cash_cur), 0)   AS cash_mkd,
    count(*) FILTER (WHERE m.cash_prev)                     AS p_cash_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.cash_prev), 0)  AS p_cash_mkd
  FROM mf m GROUP BY m.src
),
s AS (
  SELECT sr.src, sr.ord,
    coalesce(so.placed_n, 0) AS placed_n, coalesce(so.placed_eur, 0) AS placed_eur,
    coalesce(so.p_placed_n, 0) AS p_placed_n, coalesce(so.p_placed_eur, 0) AS p_placed_eur,
    coalesce(so.worked, 0) AS worked, coalesce(so.cohort_sold, 0) AS cohort_sold,
    coalesce(so.conf_n, 0) AS conf_n, coalesce(so.conf_eur, 0) AS conf_eur,
    coalesce(so.p_conf_n, 0) AS p_conf_n, coalesce(so.p_conf_eur, 0) AS p_conf_eur,
    coalesce(so.coll_mkd, 0) + coalesce(ms.coh_mkd, 0) AS coll_mkd,
    coalesce(so.coll_proven_mkd, 0) + coalesce(ms.coh_mkd, 0) AS coll_proven_mkd,
    coalesce(so.tc_n, 0) AS tc_n, coalesce(so.tc_eur, 0) AS tc_eur,
    coalesce(so.p_tc_n, 0) AS p_tc_n, coalesce(so.p_tc_eur, 0) AS p_tc_eur,
    coalesce(so.lost_n, 0) AS lost_n, coalesce(so.lost_eur, 0) AS lost_eur,
    coalesce(so.p_lost_n, 0) AS p_lost_n, coalesce(so.p_lost_eur, 0) AS p_lost_eur,
    coalesce(so.cour_n, 0) AS cour_n, coalesce(so.cour_eur, 0) AS cour_eur, coalesce(so.cour_mkd, 0) AS cour_mkd,
    coalesce(so.p_cour_n, 0) AS p_cour_n, coalesce(so.p_cour_eur, 0) AS p_cour_eur, coalesce(so.p_cour_mkd, 0) AS p_cour_mkd,
    coalesce(so.cash_n, 0) AS o_cash_n, coalesce(so.cash_mkd, 0) AS o_cash_mkd,
    coalesce(so.cash_proven_n, 0) AS cash_proven_n, coalesce(so.cash_proven_mkd, 0) AS cash_proven_mkd,
    coalesce(so.unproven_eur, 0) AS unproven_eur,
    coalesce(so.p_cash_n, 0) AS p_o_cash_n, coalesce(so.p_cash_mkd, 0) AS p_o_cash_mkd,
    coalesce(so.p_cash_proven_n, 0) AS p_cash_proven_n, coalesce(so.p_cash_proven_mkd, 0) AS p_cash_proven_mkd,
    coalesce(so.p_unproven_eur, 0) AS p_unproven_eur,
    coalesce(ms.coh_n, 0) AS mo_coh_n, coalesce(ms.coh_mkd, 0) AS mo_coh_mkd,
    coalesce(ms.cash_n, 0) AS mo_cash_n, coalesce(ms.cash_mkd, 0) AS mo_cash_mkd,
    coalesce(ms.p_cash_n, 0) AS p_mo_cash_n, coalesce(ms.p_cash_mkd, 0) AS p_mo_cash_mkd
  FROM srcs sr
  LEFT JOIN so ON so.src = sr.src
  LEFT JOIN ms ON ms.src = sr.src
),

-- ── outcome buckets per source (PLACED clock) ──────────────────────────────
sb AS (
  SELECT u.src, u.bucket, sum(u.n) AS n, sum(u.eur) AS eur, sum(u.mkd) AS mkd, sum(u.proven_n) AS proven_n
  FROM (
    SELECT g.src, g.bucket, sum(g.n) AS n, sum(g.eur) AS eur,
           sum(CASE WHEN g.bucket = 'delivered' THEN g.cash_mkd ELSE g.parcel_mkd END) AS mkd,
           coalesce(sum(g.n) FILTER (WHERE g.proven), 0) AS proven_n
    FROM g WHERE g.in_cur GROUP BY 1, 2
    UNION ALL
    -- the web shop mirror's buckets (shop rules; its money is in denari)
    SELECT 'web', b.bucket, b.n, b.mkd / 61.5, b.mkd, 0
    FROM wbk b WHERE b.per = 'cur'
  ) u
  GROUP BY 1, 2
),
sbj AS MATERIALIZED (   -- read per source by a correlated sub-select: evaluate once
  SELECT k.src,
    jsonb_object_agg(k.bucket,
      jsonb_strip_nulls(jsonb_build_object(
        'count',       coalesce(sb.n, 0),
        'value_eur',   round(coalesce(sb.eur, 0), 2),
        'cod_mkd',     CASE WHEN k.bucket IN ('courier', 'delivered', 'returned') THEN round(coalesce(sb.mkd, 0)) END,
        'proven_count', CASE WHEN k.bucket = 'delivered' THEN coalesce(sb.proven_n, 0) END))) AS j
  FROM (SELECT sr.src, bk.bucket FROM srcs sr CROSS JOIN bks bk
        UNION SELECT sb.src, sb.bucket FROM sb) k          -- + the shop's no_record
  LEFT JOIN sb ON sb.src = k.src AND sb.bucket = k.bucket
  GROUP BY k.src
),

-- ── customer history for the AlterCPA cohort ──────────────────────────────
-- "Returning" = an EARLIER order on the same last-8 phone, any source, any
-- outcome, all time (never windowed: history does not start at the range
-- edge). The phone expression below is character-for-character the one
-- idx_orders_phone_last8 indexes, so a short window probes the index for its
-- few phones and a long one hash-joins a single pass over the table.
ap8 AS MATERIALIZED (
  SELECT f.id, f.created_at, f.price, f.bucket,
         right(regexp_replace(coalesce(f.customer_phone, ''), '[^0-9]', '', 'g'), 8) AS p8
  FROM f
  WHERE f.in_cur AND f.src = 'altercpa'
),
fo AS MATERIALIZED (
  -- long window ($9): one pass over the whole table, then a hash join
  SELECT y.p8, min(y.created_at) AS first_at, min(y.created_at) FILTER (WHERE y.paid) AS first_paid_at
  FROM (
    SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8, x.created_at,
           (x.status IN ('paid', 'delivered')) AS paid
    FROM public.orders x
    WHERE $9::boolean
      AND x.customer_phone IS NOT NULL
      AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
  ) y
  GROUP BY y.p8
  UNION ALL
  -- short window: probe idx_orders_phone_last8 for the cohort's phones only
  SELECT y.p8, min(y.created_at), min(y.created_at) FILTER (WHERE y.paid)
  FROM (
    SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8, x.created_at,
           (x.status IN ('paid', 'delivered')) AS paid
    FROM public.orders x
    WHERE NOT $9::boolean
      AND right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) IN
            (SELECT a.p8 FROM ap8 a WHERE length(a.p8) = 8)
      AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
  ) y
  GROUP BY y.p8
),
spl AS (
  SELECT 'altercpa'::text AS src,
         CASE WHEN fo.first_at < a.created_at THEN 'returning' ELSE 'new' END AS k,
         'placed'::text AS basis, NULL::text AS sale_source, NULL::text AS detail,
         count(*) AS n, sum(a.price) AS eur, NULL::numeric AS mkd,
         count(*) FILTER (WHERE fo.first_paid_at < a.created_at) AS bought_before,
         count(*) FILTER (WHERE a.bucket IN ('preparing', 'packed', 'courier', 'delivered')) AS sold_n,
         sum(a.price) FILTER (WHERE a.bucket IN ('preparing', 'packed', 'courier', 'delivered')) AS sold_eur
  FROM ap8 a
  LEFT JOIN fo ON fo.p8 = a.p8 AND length(a.p8) = 8
  GROUP BY 2
  UNION ALL
  SELECT f.src, coalesce(f.sale_source_detail, 'unknown'), 'placed', f.sale_source, f.sale_source_detail,
         count(*), sum(f.price), NULL, NULL,
         count(*) FILTER (WHERE f.bucket IN ('preparing', 'packed', 'courier', 'delivered')),
         sum(f.price) FILTER (WHERE f.bucket IN ('preparing', 'packed', 'courier', 'delivered'))
  FROM f WHERE f.in_cur AND f.src IN ('elyon_crm', 'teleshop_other', 'web')
  GROUP BY f.src, f.sale_source, f.sale_source_detail
  UNION ALL
  SELECT m.src, CASE WHEN m.src = 'web' THEN 'mex_only' ELSE 'mex_only_unlinked' END, 'placed', NULL, NULL,
         count(*), NULL, sum(m.cod_mkd), NULL, NULL, NULL
  FROM mf m WHERE m.in_cur AND NOT m.claimed GROUP BY m.src
  UNION ALL
  SELECT 'web', 'shop', 'placed', NULL, NULL, w.placed_n, round(w.placed_mkd / 61.5, 2), w.placed_mkd, NULL, NULL, NULL
  FROM wsum w WHERE w.per = 'cur' AND w.present
),
spl_fixed AS (
  SELECT * FROM (VALUES
    ('altercpa', 'new', 1), ('altercpa', 'returning', 2),
    ('elyon_crm', 'prediction_list', 1), ('elyon_crm', 'direct', 2), ('elyon_crm', 'disposition', 3),
    ('teleshop_other', 'teleshop', 1), ('teleshop_other', 'social', 2), ('teleshop_other', 'leads', 3),
    ('teleshop_other', 'leads_out', 4), ('teleshop_other', 'mex_only_unlinked', 9),
    ('web', 'shop', 1), ('web', 'mex_only', 2)) v(src, k, ord)
),
splj AS MATERIALIZED (  -- read per source by a correlated sub-select: evaluate once
  SELECT x.src,
    jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'key', x.k, 'basis', 'placed',
      'count', x.n,
      'value_eur', CASE WHEN x.eur IS NOT NULL THEN round(x.eur, 2) END,
      'cod_mkd', CASE WHEN x.mkd IS NOT NULL THEN round(x.mkd) END,
      'bought_before', x.bought_before,
      'sold_count', x.sold_n,
      'sold_value_eur', CASE WHEN x.sold_n IS NOT NULL THEN round(coalesce(x.sold_eur, 0), 2) END,
      'drill', CASE
                 WHEN x.k IN ('mex_only', 'mex_only_unlinked', 'new', 'returning', 'shop') THEN NULL
                 WHEN x.src = 'elyon_crm' THEN jsonb_build_object('sale_source', jsonb_build_array('elyon_crm'), 'detail', jsonb_build_array(x.k))
                 WHEN x.sale_source IS NOT NULL THEN jsonb_build_object('sale_source', jsonb_build_array(x.sale_source), 'detail', jsonb_build_array(x.k))
                 WHEN x.src = 'teleshop_other' THEN jsonb_build_object('sale_source', jsonb_build_array('collabbox'), 'detail', jsonb_build_array(x.k))
               END))
      ORDER BY x.ord, x.n DESC, x.k) AS j
  FROM (
    SELECT coalesce(a.src, fx.src) AS src, coalesce(a.k, fx.k) AS k,
           coalesce(fx.ord, 5) AS ord,
           coalesce(a.n, 0) AS n,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked') THEN NULL ELSE coalesce(a.eur, 0) END AS eur,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked', 'shop') THEN coalesce(a.mkd, 0) END AS mkd,
           a.sale_source,
           CASE WHEN coalesce(a.k, fx.k) = 'returning' THEN coalesce(a.bought_before, 0) END AS bought_before,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked', 'shop') THEN NULL
                ELSE coalesce(a.sold_n, 0) END AS sold_n,
           a.sold_eur
    FROM (SELECT src, k, max(sale_source) AS sale_source, sum(n) AS n, sum(eur) AS eur, sum(mkd) AS mkd,
                 sum(bought_before) AS bought_before, sum(sold_n) AS sold_n, sum(sold_eur) AS sold_eur
          FROM spl GROUP BY src, k) a
    FULL JOIN spl_fixed fx ON fx.src = a.src AND fx.k = a.k
  ) x
  GROUP BY x.src
),

-- ── sources ────────────────────────────────────────────────────────────────
src_json AS (
  SELECT s.ord, jsonb_build_object(
    'key', s.src,
    'placed', jsonb_build_object(
      'count', s.placed_n + CASE WHEN s.src = 'web' THEN (SELECT w.placed_n FROM wsum w WHERE w.per = 'cur') ELSE 0 END,
      'value_eur', round(s.placed_eur + CASE WHEN s.src = 'web' THEN (SELECT w.placed_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2)),
    'buckets',
      (SELECT j FROM sbj WHERE sbj.src = s.src)
      || CASE WHEN s.src IN ('teleshop_other', 'web')
              THEN jsonb_build_object('mex_only', jsonb_build_object('count', s.mo_coh_n, 'cod_mkd', round(s.mo_coh_mkd)))
              ELSE '{}'::jsonb END,
    'money', jsonb_build_object(
      'collected_mkd',          round(s.coll_mkd + CASE WHEN s.src = 'web' THEN (SELECT w.coll_mkd FROM wsum w WHERE w.per = 'cur') ELSE 0 END),
      'collected_proven_mkd',   round(s.coll_proven_mkd),
      'collected_unproven_mkd', round(s.coll_mkd - s.coll_proven_mkd),
      -- the web shop mirror's own "collected" (its panel's rule, not MEX):
      -- collected = proven + unproven + shop
      'collected_shop_mkd',     CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                                     THEN round((SELECT w.coll_mkd FROM wsum w WHERE w.per = 'cur')) END,
      'to_collect_eur',         round(s.tc_eur + CASE WHEN s.src = 'web' THEN (SELECT w.tc_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2),
      'lost_eur',               round(s.lost_eur + CASE WHEN s.src = 'web' THEN (SELECT w.lost_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2),
      'unrecorded_mkd',         CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                                     THEN round((SELECT w.unrec_mkd FROM wsum w WHERE w.per = 'cur')) END),
    'cash', jsonb_build_object(
      'count',            s.o_cash_n + s.mo_cash_n,
      'cod_mkd',          round(s.o_cash_mkd + s.mo_cash_mkd),
      'proven_count',     s.cash_proven_n + s.mo_cash_n,
      'proven_cod_mkd',   round(s.cash_proven_mkd + s.mo_cash_mkd),
      'unproven_count',   s.o_cash_n - s.cash_proven_n,
      'unproven_cod_mkd', round(s.o_cash_mkd - s.cash_proven_mkd),
      'mex_only_count',   s.mo_cash_n,
      'mex_only_cod_mkd', round(s.mo_cash_mkd)),
    'worked',      s.worked,
    'cohort_sold', s.cohort_sold,
    'conversion',  CASE WHEN s.worked > 0 THEN round(s.cohort_sold::numeric / s.worked, 4) END,
    'confirmed',   s.conf_n,
    'confirmed_value_eur', round(s.conf_eur, 2),
    'aov_eur',     CASE WHEN s.conf_n > 0 THEN round(s.conf_eur / s.conf_n, 2) END,
    'splits',      coalesce((SELECT j FROM splj WHERE splj.src = s.src), '[]'::jsonb),
    'drill', CASE s.src
               WHEN 'altercpa'       THEN jsonb_build_object('sale_source', jsonb_build_array('altercpa', 'affiliate'))
               WHEN 'elyon_crm'      THEN jsonb_build_object('sale_source', jsonb_build_array('elyon_crm'))
               WHEN 'web'            THEN jsonb_build_object('sale_source', jsonb_build_array('web'))
               ELSE                       jsonb_build_object('sale_source', jsonb_build_array('collabbox', 'legacy'))
             END,
    'web_block', CASE WHEN s.src = 'web' THEN (SELECT present FROM wsum WHERE per = 'cur') END,
    -- the shop mirror's part of placed (verify-attribution C1 ties the rest
    -- to SQL over public.orders; C14 checks this part against web_orders)
    'placed_shop', CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                        THEN (SELECT jsonb_build_object('count', w.placed_n, 'value_eur', round(w.placed_mkd / 61.5, 2),
                                                        'value_mkd', round(w.placed_mkd))
                              FROM wsum w WHERE w.per = 'cur') END
  ) AS j
  FROM s
),

-- ── KPI tiles = Σ sources, on each tile's own clock ────────────────────────
kp AS (
  SELECT
    sum(s.placed_n) AS placed_n, sum(s.placed_eur) AS placed_eur,
    sum(s.p_placed_n) AS p_placed_n, sum(s.p_placed_eur) AS p_placed_eur,
    sum(s.conf_n) AS conf_n, sum(s.conf_eur) AS conf_eur, sum(s.p_conf_n) AS p_conf_n, sum(s.p_conf_eur) AS p_conf_eur,
    sum(s.cour_n) AS cour_n, sum(s.cour_eur) AS cour_eur, sum(s.cour_mkd) AS cour_mkd,
    sum(s.p_cour_n) AS p_cour_n, sum(s.p_cour_eur) AS p_cour_eur, sum(s.p_cour_mkd) AS p_cour_mkd,
    sum(s.tc_n) AS tc_n, sum(s.tc_eur) AS tc_eur, sum(s.p_tc_n) AS p_tc_n, sum(s.p_tc_eur) AS p_tc_eur,
    sum(s.lost_n) AS lost_n, sum(s.lost_eur) AS lost_eur, sum(s.p_lost_n) AS p_lost_n, sum(s.p_lost_eur) AS p_lost_eur,
    sum(s.o_cash_n) AS o_cash_n, sum(s.o_cash_mkd) AS o_cash_mkd,
    sum(s.cash_proven_n) AS cash_proven_n, sum(s.cash_proven_mkd) AS cash_proven_mkd, sum(s.unproven_eur) AS unproven_eur,
    sum(s.mo_cash_n) AS mo_cash_n, sum(s.mo_cash_mkd) AS mo_cash_mkd,
    sum(s.p_o_cash_n) AS p_o_cash_n, sum(s.p_o_cash_mkd) AS p_o_cash_mkd,
    sum(s.p_cash_proven_n) AS p_cash_proven_n, sum(s.p_cash_proven_mkd) AS p_cash_proven_mkd, sum(s.p_unproven_eur) AS p_unproven_eur,
    sum(s.p_mo_cash_n) AS p_mo_cash_n, sum(s.p_mo_cash_mkd) AS p_mo_cash_mkd
  FROM s
),
wk_b AS (   -- the web block's own contribution to the cohort tiles
  SELECT w.per, w.present, w.placed_n, w.placed_mkd, w.tc_mkd, w.lost_mkd,
         coalesce((SELECT b.n   FROM wbk b WHERE b.per = w.per AND b.bucket = 'courier'), 0) AS cour_n,
         coalesce((SELECT b.mkd FROM wbk b WHERE b.per = w.per AND b.bucket = 'courier'), 0) AS cour_mkd,
         coalesce((SELECT sum(b.n) FROM wbk b WHERE b.per = w.per AND b.bucket IN ('preparing', 'courier')), 0) AS tc_n,
         coalesce((SELECT sum(b.n) FROM wbk b WHERE b.per = w.per AND b.bucket IN ('returned', 'cancelled')), 0) AS lost_n
  FROM wsum w
),
kpj AS (
  SELECT jsonb_build_object(
    'placed',     jsonb_build_object('count', k.placed_n + c.placed_n,
                                     'value_eur', round(k.placed_eur + c.placed_mkd / 61.5, 2)),
    'confirmed',  jsonb_build_object('count', k.conf_n, 'value_eur', round(k.conf_eur, 2)),
    'at_courier', jsonb_build_object('count', k.cour_n + c.cour_n,
                                     'value_eur', round(k.cour_eur + c.cour_mkd / 61.5, 2),
                                     'cod_mkd', round(k.cour_mkd + c.cour_mkd)),
    'delivered',  jsonb_build_object('count', k.o_cash_n + k.mo_cash_n,
                                     'cod_mkd', round(k.o_cash_mkd + k.mo_cash_mkd),
                                     'proven_count', k.cash_proven_n + k.mo_cash_n,
                                     'proven_cod_mkd', round(k.cash_proven_mkd + k.mo_cash_mkd),
                                     'unproven_count', k.o_cash_n - k.cash_proven_n,
                                     'unproven_cod_mkd', round(k.o_cash_mkd - k.cash_proven_mkd),
                                     'mex_only_count', k.mo_cash_n,
                                     'mex_only_cod_mkd', round(k.mo_cash_mkd)),
    'to_collect', jsonb_build_object('count', k.tc_n + c.tc_n,
                                     'value_eur', round(k.tc_eur + c.tc_mkd / 61.5, 2)),
    'lost',       jsonb_build_object('count', k.lost_n + c.lost_n,
                                     'value_eur', round(k.lost_eur + c.lost_mkd / 61.5, 2)),
    'unproven_paid', jsonb_build_object('count', k.o_cash_n - k.cash_proven_n,
                                        'value_eur', round(k.unproven_eur, 2),
                                        'cod_mkd', round(k.o_cash_mkd - k.cash_proven_mkd)),
    'prev', CASE WHEN (SELECT pf FROM win) IS NULL THEN NULL ELSE jsonb_build_object(
      'placed',     jsonb_build_object('count', k.p_placed_n + p.placed_n,
                                       'value_eur', round(k.p_placed_eur + p.placed_mkd / 61.5, 2)),
      'confirmed',  jsonb_build_object('count', k.p_conf_n, 'value_eur', round(k.p_conf_eur, 2)),
      'at_courier', jsonb_build_object('count', k.p_cour_n + p.cour_n,
                                       'value_eur', round(k.p_cour_eur + p.cour_mkd / 61.5, 2),
                                       'cod_mkd', round(k.p_cour_mkd + p.cour_mkd)),
      'delivered',  jsonb_build_object('count', k.p_o_cash_n + k.p_mo_cash_n,
                                       'cod_mkd', round(k.p_o_cash_mkd + k.p_mo_cash_mkd),
                                       'proven_count', k.p_cash_proven_n + k.p_mo_cash_n,
                                       'proven_cod_mkd', round(k.p_cash_proven_mkd + k.p_mo_cash_mkd),
                                       'unproven_count', k.p_o_cash_n - k.p_cash_proven_n,
                                       'unproven_cod_mkd', round(k.p_o_cash_mkd - k.p_cash_proven_mkd),
                                       'mex_only_count', k.p_mo_cash_n,
                                       'mex_only_cod_mkd', round(k.p_mo_cash_mkd)),
      'to_collect', jsonb_build_object('count', k.p_tc_n + p.tc_n,
                                       'value_eur', round(k.p_tc_eur + p.tc_mkd / 61.5, 2)),
      'lost',       jsonb_build_object('count', k.p_lost_n + p.lost_n,
                                       'value_eur', round(k.p_lost_eur + p.lost_mkd / 61.5, 2)),
      'unproven_paid', jsonb_build_object('count', k.p_o_cash_n - k.p_cash_proven_n,
                                          'value_eur', round(k.p_unproven_eur, 2),
                                          'cod_mkd', round(k.p_o_cash_mkd - k.p_cash_proven_mkd))) END
  ) AS j
  FROM kp k
  CROSS JOIN (SELECT * FROM wk_b WHERE per = 'cur') c
  CROSS JOIN (SELECT * FROM wk_b WHERE per = 'prev') p
),

-- ── per Skopje day × source over the spark window (which contains the
-- current one): trend and spark both roll up from these few hundred rows.
dpl AS (   -- PLACED clock
  SELECT f.cday AS day, f.src, count(*) AS n, sum(f.price) AS eur
  FROM f WHERE f.in_spark GROUP BY 1, 2
  UNION ALL
  SELECT wd.d::date, 'web', sum(wd.n), sum(wd.mkd) / 61.5
  FROM wday wd, win w WHERE wd.d::date BETWEEN w.sfd AND w.td GROUP BY 1
),
dca AS (   -- CASH clock
  SELECT f.kday AS day, f.src, count(*) AS n, sum(f.cash_mkd) AS mkd
  FROM f WHERE f.cash_spark GROUP BY 1, 2
  UNION ALL
  SELECT m.kday, m.src, count(*), sum(m.cod_mkd)
  FROM mf m WHERE m.cash_spark GROUP BY 1, 2
),

-- ── spark: ≥ 14 days, daily (monthly past 62 days) ─────────────────────────
spk_keys AS (
  SELECT to_char(g, w.sfmt) AS b
  FROM win w, generate_series(date_trunc(w.sgran, w.sfd::timestamp), date_trunc(w.sgran, w.td::timestamp),
                              ('1 ' || w.sgran)::interval) g
),
spk_p AS (
  SELECT to_char(date_trunc(w.sgran, x.day::timestamp), w.sfmt) AS b, sum(x.eur) AS eur
  FROM dpl x, win w WHERE x.day BETWEEN w.sfd AND w.td GROUP BY 1
),
spk_d AS (
  SELECT to_char(date_trunc(w.sgran, x.day::timestamp), w.sfmt) AS b, sum(x.mkd) AS mkd
  FROM dca x, win w WHERE x.day BETWEEN w.sfd AND w.td GROUP BY 1
),
spkj AS (
  SELECT jsonb_build_object(
    'from', (SELECT to_char(sfd, 'YYYY-MM-DD') FROM win),
    'granularity', (SELECT sgran FROM win),
    'placed_value', (SELECT jsonb_agg(jsonb_build_object('d', k.b, 'v', round(coalesce(p.eur, 0), 2)) ORDER BY k.b)
                     FROM spk_keys k LEFT JOIN (SELECT b, sum(eur) AS eur FROM spk_p GROUP BY b) p ON p.b = k.b),
    'delivered_cash_mkd', (SELECT jsonb_agg(jsonb_build_object('d', k.b, 'v', round(coalesce(x.mkd, 0))) ORDER BY k.b)
                           FROM spk_keys k LEFT JOIN (SELECT b, sum(mkd) AS mkd FROM spk_d GROUP BY b) x ON x.b = k.b)
  ) AS j
),

-- ── trend: one point per day (per month past 62 days), every source ────────
tr_keys AS (
  SELECT to_char(g, w.fmt) AS b
  FROM win w, generate_series(date_trunc(w.gran, w.fd::timestamp), date_trunc(w.gran, w.td::timestamp),
                              ('1 ' || w.gran)::interval) g
),
tr_p AS (
  SELECT to_char(date_trunc(w.gran, x.day::timestamp), w.fmt) AS b, x.src, sum(x.n) AS n, sum(x.eur) AS eur
  FROM dpl x, win w WHERE x.day BETWEEN w.fd AND w.td GROUP BY 1, 2
),
tr_d AS (
  SELECT to_char(date_trunc(w.gran, x.day::timestamp), w.fmt) AS b, x.src, sum(x.n) AS n, sum(x.mkd) AS mkd
  FROM dca x, win w WHERE x.day BETWEEN w.fd AND w.td GROUP BY 1, 2
),
trj AS (
  SELECT jsonb_build_object(
    'granularity', (SELECT gran FROM win),
    'points', coalesce(jsonb_agg(pt.j ORDER BY pt.b), '[]'::jsonb)) AS j
  FROM (
    SELECT k.b, jsonb_build_object('bucket', k.b, 'by_source', jsonb_object_agg(sr.src, jsonb_build_object(
             'placed_count',       coalesce(p.n, 0),
             'placed_value_eur',   round(coalesce(p.eur, 0), 2),
             'delivered_count',    coalesce(x.n, 0),
             'delivered_cash_mkd', round(coalesce(x.mkd, 0))) ORDER BY sr.ord)) AS j
    FROM tr_keys k CROSS JOIN srcs sr
    LEFT JOIN tr_p p ON p.b = k.b AND p.src = sr.src
    LEFT JOIN tr_d x ON x.b = k.b AND x.src = sr.src
    GROUP BY k.b
  ) pt
),

-- ── teams: roster × work ledger × sales × presence ─────────────────────────
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.via, v.order_id, v.decision, v.outcome, v.actor_ext
  FROM public.v_sales_work v, win w
  WHERE v.at BETWEEN w.f AND w.t
),
mem AS (
  SELECT DISTINCT ON (m.team_key, m.person_id)
         m.team_key, m.person_id, sp.display_name, sp.user_id, sp.is_manager, m.role AS team_role
  FROM public.sales_team_members m
  JOIN public.sales_people sp ON sp.id = m.person_id
  CROSS JOIN win w
  WHERE m.valid_from <= w.td AND coalesce(m.valid_to, 'infinity'::date) >= w.fd
  ORDER BY m.team_key, m.person_id, m.is_primary DESC, m.valid_from DESC
),
wk AS (
  SELECT vw.person_id, count(*) AS worked, count(*) FILTER (WHERE vw.outcome = 'sale') AS sales, max(vw.at) AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),
ps AS (
  SELECT f.sold_by_person_id AS person_id,
         count(*) FILTER (WHERE f.sale_cur)                       AS confirmed,
         coalesce(sum(f.price) FILTER (WHERE f.sale_cur), 0)      AS sold_eur,
         count(*) FILTER (WHERE f.cash_cur)                       AS cash_n,
         coalesce(sum(f.cash_mkd) FILTER (WHERE f.cash_cur), 0)   AS cash_mkd
  FROM f WHERE f.sold_by_person_id IS NOT NULL GROUP BY 1
),
pr AS (
  SELECT a.user_id,
         sum(a.online_minutes) AS online_min, sum(a.active_minutes) AS active_min,
         sum(a.idle_minutes) AS idle_min, sum(a.break_minutes) AS break_min,
         min(a.first_active_at) AS first_active, max(a.last_active_at) AS last_active,
         sum(a.idle_alerts) AS idle_alerts
  FROM public.agent_presence_days a, win w
  WHERE a.day BETWEEN w.fd AND w.td
  GROUP BY 1
),
pn AS (
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
una AS (
  SELECT 'unassigned'::text AS team_key, sp.id AS person_id, sp.display_name, sp.user_id, sp.is_manager, 'member'::text AS team_role
  FROM public.sales_people sp
  WHERE (EXISTS (SELECT 1 FROM wk WHERE wk.person_id = sp.id)
         OR EXISTS (SELECT 1 FROM ps WHERE ps.person_id = sp.id AND (ps.confirmed > 0 OR ps.cash_n > 0)))
    AND NOT EXISTS (SELECT 1 FROM mem WHERE mem.person_id = sp.id)
),
tm AS (
  SELECT r.team_key, r.person_id, r.display_name, r.user_id, r.is_manager, r.team_role,
         CASE WHEN r.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END AS online_state,
         pr.online_min, pr.active_min, pr.idle_min, pr.break_min, pr.first_active, pr.last_active, pr.idle_alerts,
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sales, 0) AS sales, wk.last_at,
         coalesce(ps.confirmed, 0) AS confirmed, coalesce(ps.sold_eur, 0) AS sold_eur,
         coalesce(ps.cash_mkd, 0) AS cash_mkd
  FROM (SELECT * FROM mem UNION ALL SELECT * FROM una) r
  LEFT JOIN pn ON pn.user_id = r.user_id
  LEFT JOIN pr ON pr.user_id = r.user_id
  LEFT JOIN wk ON wk.person_id = r.person_id
  LEFT JOIN ps ON ps.person_id = r.person_id
),
teamj AS (
  SELECT coalesce(jsonb_agg(t.j ORDER BY t.ord, t.name), '[]'::jsonb) AS j
  FROM (
    SELECT tk.team_key,
           coalesce(st.name, 'Unassigned') AS name,
           CASE tk.team_key WHEN 'altercpa_leads' THEN 1 WHEN 'crm_prediction' THEN 2
                            WHEN 'management' THEN 3 WHEN 'unassigned' THEN 9 ELSE 5 END AS ord,
           jsonb_build_object(
             'team_key',  tk.team_key,
             'name',      coalesce(st.name, 'Unassigned'),
             'mode',      st.leaderboard_mode,
             'online_now', count(*) FILTER (WHERE tm.online_state IN ('online', 'idle')),
             'break_now',  count(*) FILTER (WHERE tm.online_state = 'break'),
             'worked',     coalesce(sum(tm.worked), 0),
             'confirmed',  coalesce(sum(tm.confirmed), 0),
             'sold_value_eur', round(coalesce(sum(tm.sold_eur), 0), 2),
             'delivered_cash_mkd', round(coalesce(sum(tm.cash_mkd), 0)),
             'unmapped_decisions', CASE WHEN tk.team_key = 'unassigned'
                                        THEN (SELECT count(*) FROM vw WHERE vw.person_id IS NULL) END
           ) || jsonb_build_object('members', coalesce(jsonb_agg(jsonb_build_object(
             'person_id',   tm.person_id,
             'name',        tm.display_name,
             'user_id',     tm.user_id,
             'is_manager',  tm.is_manager,
             'role',        tm.team_role,
             'online_state', tm.online_state,
             'online_min',  tm.online_min,
             'active_min',  tm.active_min,
             'idle_min',    tm.idle_min,
             'break_min',   tm.break_min,
             'first_active', tm.first_active,
             'last_active', tm.last_active,
             'idle_alerts', tm.idle_alerts,
             'worked',      tm.worked,
             'sales_decisions', tm.sales,
             'confirmed',   tm.confirmed,
             'conversion',  CASE WHEN tm.worked > 0 THEN round(tm.sales::numeric / tm.worked, 4) END,
             'sold_value_eur', round(tm.sold_eur, 2),
             'delivered_cash_mkd', round(tm.cash_mkd),
             'last_decision_at', tm.last_at)
             ORDER BY tm.sold_eur DESC, tm.worked DESC, tm.display_name) FILTER (WHERE tm.person_id IS NOT NULL), '[]'::jsonb)) AS j
    FROM (SELECT DISTINCT team_key FROM tm
          UNION SELECT key FROM public.sales_teams
          UNION SELECT 'unassigned' WHERE EXISTS (SELECT 1 FROM vw WHERE vw.person_id IS NULL)) tk
    LEFT JOIN public.sales_teams st ON st.key = tk.team_key
    LEFT JOIN tm ON tm.team_key = tk.team_key
    GROUP BY tk.team_key, st.name, st.leaderboard_mode
  ) t
),

-- ── freshness ──────────────────────────────────────────────────────────────
fr_acpa AS (
  SELECT (SELECT max(r.finished_at) FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.finished_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'rolling' AND r2.status = 'ok'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active)                                                        AS last_ok,
         (SELECT r.status FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.status, r2.started_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'rolling'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active ORDER BY r.started_at DESC LIMIT 1)                     AS last_status,
         (SELECT max(r.finished_at) FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.finished_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'status' AND r2.status = 'ok'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active)                                                        AS status_ok
),
fr_mex_runs AS (
  SELECT r.started_at, r.finished_at, r.status, r.skipped
  FROM public.mex_sync_runs r
  WHERE r.started_at > now() - interval '10 days'
),
fr_mex AS (
  SELECT a.acct,
         coalesce((SELECT max(r.finished_at) FROM fr_mex_runs r
                    WHERE r.status = 'ok' AND r.skipped ? ('fetched_' || a.acct)),
                  (SELECT max(p.last_seen_at) FROM public.mex_parcels p WHERE p.account = a.acct)) AS last_ok,
         (SELECT r.status FROM fr_mex_runs r ORDER BY r.started_at DESC LIMIT 1)                   AS last_status,
         (SELECT max(p.last_update_at) FROM public.mex_parcels p WHERE p.account = a.acct)         AS data_through
  FROM (VALUES ('bio_natural'), ('natura')) a(acct)
),
-- mex-reconcile runs every 30 min inside 07:00–20:55 Skopje only, so outside
-- that window "fresh" means "the last run of the working day happened".
fr_mex_expect AS (
  SELECT CASE WHEN l::time BETWEEN time '07:45' AND time '21:00' THEN now()
              WHEN l::time < time '07:45' THEN ((l::date - 1) + time '20:40') AT TIME ZONE 'Europe/Skopje'
              ELSE (l::date + time '20:40') AT TIME ZONE 'Europe/Skopje' END AS expected
  FROM (SELECT now() AT TIME ZONE 'Europe/Skopje' AS l) z
),
fr_cb AS (
  SELECT max(x.created_at) AS last_doc
  FROM public.orders x WHERE x.sale_source = 'collabbox'
),
frj AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_build_object(
       'feed', 'altercpa', 'last_ok_at', a.last_ok,
       'status', CASE WHEN a.last_ok IS NULL THEN 'failed'
                      WHEN a.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN a.last_ok < now() - interval '15 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'rolling every 2 min; status sync last ok ' || coalesce(to_char(a.status_ok AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', a.last_status,
       'status_sync_ok_at', a.status_ok)
     FROM fr_acpa a),
    (SELECT jsonb_build_object(
       'feed', 'mex_bio_natural', 'last_ok_at', m.last_ok,
       'status', CASE WHEN m.last_ok IS NULL THEN 'failed'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN m.last_ok < e.expected - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'mex-reconcile every 30 min 07:00-20:55; parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', m.last_status,
       'data_through', m.data_through)
     FROM fr_mex m, fr_mex_expect e WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'feed', 'mex_natura', 'last_ok_at', m.last_ok,
       'status', CASE WHEN m.last_ok IS NULL THEN 'failed'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN m.last_ok < e.expected - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'mex-reconcile every 30 min 07:00-20:55; parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', m.last_status,
       'data_through', m.data_through)
     FROM fr_mex m, fr_mex_expect e WHERE m.acct = 'natura'),
    CASE
      WHEN $7::jsonb IS NULL THEN jsonb_build_object(
        'feed', 'web', 'last_ok_at', NULL, 'status', 'n/a',
        'detail', coalesce('web block error: ' || $8::text, 'web-sync not deployed yet'))
      WHEN $7::jsonb ? 'error' THEN jsonb_build_object(
        'feed', 'web', 'last_ok_at', NULL, 'status', 'failed',
        'detail', 'web_sync_runs unreadable: ' || ($7::jsonb ->> 'error'))
      ELSE jsonb_build_object(
        'feed', 'web', 'last_ok_at', $7::jsonb -> 'last_ok_at',
        'status', CASE WHEN $7::jsonb ->> 'last_ok_at' IS NULL THEN 'failed'
                       WHEN ($7::jsonb ->> 'last_status') = 'failed' THEN 'failed'
                       WHEN ($7::jsonb ->> 'last_ok_at')::timestamptz < now() - interval '45 minutes' THEN 'stale'
                       ELSE 'ok' END,
        'detail', coalesce('last error: ' || ($7::jsonb ->> 'last_error'), 'web-sync every 15 min')
                  || CASE WHEN $8::text IS NOT NULL THEN '; web block error: ' || $8::text ELSE '' END,
        'last_run_status', $7::jsonb -> 'last_status')
    END,
    (SELECT jsonb_build_object(
       'feed', 'collabbox', 'last_ok_at', c.last_doc,
       'status', CASE WHEN c.last_doc IS NULL THEN 'n/a'
                      WHEN c.last_doc < now() - interval '7 days' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'manual import; newest document ' || coalesce(to_char(c.last_doc AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'), '-'),
       'data_through', c.last_doc)
     FROM fr_cb c)
  ) AS j
),

-- ── attention ──────────────────────────────────────────────────────────────
pname AS (SELECT sp.id, sp.display_name FROM public.sales_people sp),
-- anp and mp are "state as of now" and are written so that GET /orders
-- ?attention=approved_no_parcel_7d|mex_problem (overview.ts attentionFilter)
-- lists exactly these orders — change the two together.
anp AS (   -- AlterCPA sale, still no parcel 7 days after the sale, not postponed
  SELECT x.id, x.display_id, coalesce(x.price, 0) AS price,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at, x.sold_by_person_id
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source IN ('altercpa', 'affiliate')
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < now() - interval '7 days'
    AND x.mex_tracking_id IS NULL
    AND (x.ship_after_date IS NULL OR x.ship_after_date <= (now() AT TIME ZONE 'Europe/Skopje')::date)
),
mp AS (    -- the order's own parcel is Problematic / Delivery attempted / Rejected
  SELECT p.tracking_id, p.status_id, p.status_name, p.cod_mkd, p.last_update_at,
         x.display_id, coalesce(x.price, 0) AS price, x.sold_by_person_id
  FROM public.mex_parcels p JOIN public.orders x ON x.mex_tracking_id = p.tracking_id
  WHERE p.status_id IN (3, 9, 13) AND x.mex_status_id IN (3, 9, 13)
),
cm AS (    -- COD ≠ price: delivered or returned in the window, not exact, not +150
  SELECT o.display_id, o.price, o.mex_cod_mkd, o.sold_by_person_id,
         o.mex_cod_mkd - round(o.price * 61.5) AS diff,
         coalesce(o.mex_delivered_at, o.mex_returned_at) AS at
  FROM f o, win w
  WHERE o.mex_cod_mkd IS NOT NULL
    AND ((o.bucket = 'delivered' AND o.mex_delivered_at BETWEEN w.f AND w.t)
         OR (o.bucket = 'returned' AND o.mex_returned_at BETWEEN w.f AND w.t))
    AND abs(o.mex_cod_mkd - round(o.price * 61.5)) > 3
    AND abs(o.mex_cod_mkd - round(o.price * 61.5) - 150) > 3
),
ul AS (    -- delivered in the window, no order, not the web shop's
  SELECT m.tracking_id, m.account, m.series, m.cod_mkd, m.delivered_at
  FROM mf m WHERE m.cash_cur AND m.src = 'teleshop_other'
),
na AS (    -- AlterCPA approvals 23:00–05:59 Skopje
  SELECT vw.person_id, vw.actor_ext, vw.order_id, vw.at
  FROM vw
  WHERE vw.via = 'altercpa' AND vw.decision = 'approved'
    AND extract(hour FROM vw.at AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 6 AND 22
),
ap AS (    -- AlterCPA approvals in the window, per operator
  SELECT coalesce(vw.person_id::text, 'ext:' || coalesce(vw.actor_ext, '?')) AS op,
         vw.person_id, vw.actor_ext, vw.order_id, vw.at
  FROM vw WHERE vw.via = 'altercpa' AND vw.decision = 'approved'
),
apw AS (
  SELECT ap.*, count(*) OVER (PARTITION BY ap.op ORDER BY ap.at
                              RANGE BETWEEN CURRENT ROW AND interval '10 minutes' FOLLOWING) AS fwd
  FROM ap
),
-- An approval is in a burst when some burst START (≥ 8 approvals in the 10
-- minutes from it) lies in the 10 minutes before it — two window passes, no
-- self-join.
apm AS (
  SELECT apw.*,
         max(CASE WHEN apw.fwd >= 8 THEN apw.at END)
           OVER (PARTITION BY apw.op ORDER BY apw.at
                 RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW) AS burst_start
  FROM apw
),
bmem AS (
  SELECT apm.op, apm.person_id, apm.actor_ext, apm.order_id, apm.at
  FROM apm WHERE apm.burst_start IS NOT NULL
),
bclu AS (  -- burst windows merged per operator, for the sample
  SELECT op, min(at) AS s, max(at) AS e, count(*) AS n, max(person_id::text) AS person_id, max(actor_ext) AS actor_ext
  FROM (SELECT bm.*, sum(CASE WHEN bm.at > lag_at + interval '10 minutes' OR lag_at IS NULL THEN 1 ELSE 0 END)
                       OVER (PARTITION BY bm.op ORDER BY bm.at) AS grp
        FROM (SELECT bmem.*, lag(bmem.at) OVER (PARTITION BY bmem.op ORDER BY bmem.at) AS lag_at FROM bmem) bm) z
  GROUP BY op, grp
),
att AS (
  SELECT 1 AS ord, jsonb_build_object(
    'kind', 'approved_no_parcel_7d',
    'severity', CASE WHEN count(*) >= 10 THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'value_eur', round(sum(a.price), 2),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT a2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM anp a2 LEFT JOIN pname pn2 ON pn2.id = a2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id,
                        'at', q.sold_at,
                        'days', q.days,
                        'person', q.nm,
                        'note', coalesce(q.nm, 'Unknown') || ' · ' || to_char(q.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM') || ' · ' || q.days || 'd') ORDER BY q.sold_at)
               FROM (SELECT a3.display_id, a3.sold_at, pn3.display_name AS nm,
                            (now()::date - a3.sold_at::date) AS days
                     FROM anp a3 LEFT JOIN pname pn3 ON pn3.id = a3.sold_by_person_id
                     ORDER BY a3.sold_at LIMIT 10) q)) AS j
  FROM anp a HAVING count(*) > 0
  UNION ALL
  SELECT 2, jsonb_build_object(
    'kind', 'mex_problem',
    'severity', CASE WHEN count(*) >= 20 THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'value_eur', round(sum(m.price), 2),
    'cod_mkd', sum(m.cod_mkd),
    'by_status', (SELECT jsonb_agg(jsonb_build_object('status_id', q.status_id, 'status_name', q.status_name, 'count', q.n) ORDER BY q.n DESC)
                  FROM (SELECT status_id, max(status_name) AS status_name, count(*) AS n FROM mp GROUP BY 1) q),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT m2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM mp m2 LEFT JOIN pname pn2 ON pn2.id = m2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'tracking_id', q.tracking_id, 'at', q.last_update_at,
                        'note', q.status_name || ' · ' || to_char(q.last_update_at AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI')) ORDER BY q.last_update_at DESC)
               FROM (SELECT * FROM mp ORDER BY last_update_at DESC NULLS LAST LIMIT 10) q)) AS j
  FROM mp m HAVING count(*) > 0
  UNION ALL
  SELECT 3, jsonb_build_object(
    'kind', 'cod_mismatch',
    'severity', 'warning',
    'count', count(*),
    'value_eur', round(sum(c.price), 2),
    'cod_mkd', sum(c.mex_cod_mkd),
    'diff_mkd', sum(c.diff),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT c2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM cm c2 LEFT JOIN pname pn2 ON pn2.id = c2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'at', q.at,
                        'cod_mkd', q.mex_cod_mkd, 'price_mkd', round(q.price * 61.5), 'diff_mkd', q.diff,
                        'note', CASE WHEN q.price = 0 THEN 'price 0' ELSE 'COD <> price' END) ORDER BY abs(q.diff) DESC)
               FROM (SELECT * FROM cm ORDER BY abs(diff) DESC LIMIT 10) q)) AS j
  FROM cm c HAVING count(*) > 0
  UNION ALL
  SELECT 4, jsonb_build_object(
    'kind', 'unlinked_parcels',
    'severity', 'warning',
    'count', count(*),
    'cod_mkd', sum(u.cod_mkd),
    'value_eur', round(sum(u.cod_mkd) / 61.5, 2),
    'by_account', (SELECT jsonb_agg(jsonb_build_object('account', q.account, 'series', q.series, 'count', q.n, 'cod_mkd', q.mkd) ORDER BY q.n DESC)
                   FROM (SELECT account, coalesce(series, '-') AS series, count(*) AS n, sum(cod_mkd) AS mkd FROM ul GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.tracking_id, 'at', q.delivered_at, 'cod_mkd', q.cod_mkd,
                        'note', q.account || ' · ' || coalesce(q.series, '-') || ' · ' || to_char(q.delivered_at AT TIME ZONE 'Europe/Skopje', 'DD.MM')) ORDER BY q.delivered_at DESC)
               FROM (SELECT * FROM ul ORDER BY delivered_at DESC LIMIT 10) q)) AS j
  FROM ul u HAVING count(*) > 0
  UNION ALL
  SELECT 5, jsonb_build_object(
    'kind', 'stale_feed',
    'severity', CASE WHEN bool_or(e ->> 'status' = 'failed') THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'sample', jsonb_agg(jsonb_build_object('display_id', e ->> 'feed', 'at', e -> 'last_ok_at',
                                           'note', (e ->> 'status') || ' · ' || coalesce(e ->> 'detail', '')))) AS j
  FROM frj, jsonb_array_elements(frj.j) e
  WHERE e ->> 'status' IN ('stale', 'failed')
  HAVING count(*) > 0
  UNION ALL
  SELECT 6, jsonb_build_object(
    'kind', 'web_waiting_24h',
    'severity', CASE WHEN public.overview_jnum($11::jsonb -> 'count') >= 10 THEN 'critical' ELSE 'warning' END,
    'count', public.overview_jnum($11::jsonb -> 'count'),
    'value_eur', round(coalesce(public.overview_jnum($11::jsonb -> 'value_mkd'), 0) / 61.5, 2),
    'cod_mkd', round(coalesce(public.overview_jnum($11::jsonb -> 'value_mkd'), 0)),
    'sample', jsonb_build_array(jsonb_build_object('display_id', NULL, 'at', $11::jsonb -> 'oldest_at',
                                                   'note', 'oldest waiting web order'))) AS j
  WHERE coalesce(public.overview_jnum($11::jsonb -> 'count'), 0) > 0
  UNION ALL
  SELECT 7, jsonb_build_object(
    'kind', 'night_approvals',
    'severity', 'warning',
    'count', count(*),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT n2.person_id AS pid, coalesce(pn2.display_name, 'AlterCPA #' || coalesce(n2.actor_ext, '?')) AS nm, count(*) AS n
                        FROM na n2 LEFT JOIN pname pn2 ON pn2.id = n2.person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'at', q.at, 'person', q.nm,
                        'note', coalesce(q.nm, '?') || ' · ' || to_char(q.at AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI')) ORDER BY q.at DESC)
               FROM (SELECT x.display_id, n3.at, coalesce(pn3.display_name, 'AlterCPA #' || coalesce(n3.actor_ext, '?')) AS nm
                     FROM na n3 LEFT JOIN public.orders x ON x.id = n3.order_id
                     LEFT JOIN pname pn3 ON pn3.id = n3.person_id
                     ORDER BY n3.at DESC LIMIT 10) q)) AS j
  FROM na HAVING count(*) > 0
  UNION ALL
  SELECT 8, jsonb_build_object(
    'kind', 'burst_approvals',
    'severity', 'warning',
    'count', count(*),
    'windows', (SELECT count(*) FROM bclu),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT b2.person_id AS pid, coalesce(pn2.display_name, 'AlterCPA #' || coalesce(b2.actor_ext, '?')) AS nm, count(*) AS n
                        FROM bmem b2 LEFT JOIN pname pn2 ON pn2.id = b2.person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', NULL, 'at', q.s, 'person', q.nm, 'count', q.n,
                        'note', q.nm || ' · ' || to_char(q.s AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI') || '-'
                                || to_char(q.e AT TIME ZONE 'Europe/Skopje', 'HH24:MI') || ' · ' || q.n) ORDER BY q.s DESC)
               FROM (SELECT c.s, c.e, c.n, coalesce(pn3.display_name, 'AlterCPA #' || coalesce(c.actor_ext, '?')) AS nm
                     FROM bclu c LEFT JOIN pname pn3 ON pn3.id::text = c.person_id
                     ORDER BY c.s DESC LIMIT 10) q)) AS j
  FROM bmem HAVING count(*) > 0
),
attj AS (
  SELECT coalesce(jsonb_agg(a.j ORDER BY (a.j ->> 'severity') = 'critical' DESC, a.ord), '[]'::jsonb) AS j
  FROM att a
)
SELECT jsonb_build_object(
  'window', (SELECT jsonb_build_object('from', w.f, 'to_end', w.t, 'prev_from', w.pf, 'prev_to_end', w.pt,
                                       'days', w.ndays, 'granularity', w.gran) FROM win w),
  'freshness', (SELECT j FROM frj),
  'kpis',      (SELECT j FROM kpj) || jsonb_build_object('spark', (SELECT j FROM spkj)),
  'sources',   (SELECT jsonb_agg(sj.j ORDER BY sj.ord) FROM src_json sj),
  'trend',     (SELECT j FROM trj),
  'teams',     (SELECT j FROM teamj),
  'attention', (SELECT j FROM attj)
)
  $core$
  INTO v_out
  USING v_from, v_to, v_pf, v_pt, v_web, v_web_prev, v_web_fresh, v_web_err,
        (v_to - v_from > interval '31 days'), v_claimed, v_waiting;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.insights_overview(text, text, text, text) IS
  'Connected Overview (GET /api/insights/overview): freshness, KPI tiles (+prev, +spark), sources, trend, teams, attention — on three clocks (placed = created, sold = sale decision, cash = MEX delivery). Money included; the api strips it for non-owners. Contract + definitions: migration 20260936000000.';

REVOKE ALL ON FUNCTION public.insights_overview(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_overview(text, text, text, text) TO service_role;

-- The read-only verification harness (scripts/verify-attribution.mjs C1/C2/C3/
-- C6) calls this function through the Management API with read_only: true,
-- which runs as supabase_read_only_user. That role already reads every table
-- (pg_read_all_data), so EXECUTE on a function that only reads widens nothing;
-- and inside a read-only transaction nothing it runs can write. Conditional so
-- a fresh local database without the platform role still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_overview(text, text, text, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.overview_jnum(jsonb) TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 4. insights_pivot — the drill-down table ────────────────────────────────
-- Orders PLACED in the window (the overview's cohort), grouped by 1–4 of:
--   source   the overview source key (altercpa | elyon_crm | web | teleshop_other)
--   detail   orders.sale_source_detail
--   team     the decider's primary team on the day of the sale ('(none)' for
--            an order nobody sold)
--   person   the decider (sold_by_person_id) — rows also carry person_id
--   list     prediction_list_name        webmaster  AlterCPA webmaster name
--   stream   cpa_stream_id               product    product_name
--   city     customer_city
-- Measures: count (placed) · sold (became a sale) · placed_value_eur ·
-- value_eur (sold value) · delivered · delivered_cash_mkd (linked COD, else
-- price × 61.5) · returned · lost (returned + cancelled after a sale).
-- MEX-only parcels are not orders and are not in the pivot. Owners only (the
-- api gate); service_role only here.
CREATE OR REPLACE FUNCTION public.insights_pivot(p_from text, p_to_end text, p_by text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_by   text[];
  v_all  text[] := ARRAY['source', 'detail', 'team', 'person', 'list', 'webmaster', 'stream', 'product', 'city'];
  v_bad  text;
  v_out  jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_from, '')), '') IS NULL OR nullif(btrim(coalesce(p_to_end, '')), '') IS NULL THEN
    RAISE EXCEPTION 'insights_pivot: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  v_from := p_from::timestamptz;
  v_to   := p_to_end::timestamptz;
  IF v_to < v_from OR v_to - v_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_pivot: bad window' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT lower(btrim(b))) INTO v_by
    FROM unnest(coalesce(p_by, ARRAY[]::text[])) b WHERE nullif(btrim(b), '') IS NOT NULL;
  IF v_by IS NULL OR cardinality(v_by) = 0 OR cardinality(v_by) > 4 THEN
    RAISE EXCEPTION 'insights_pivot: choose 1 to 4 dimensions' USING ERRCODE = '22023';
  END IF;
  SELECT b INTO v_bad FROM unnest(v_by) b WHERE NOT (b = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_pivot: unknown dimension %', v_bad USING ERRCODE = '22023';
  END IF;
  -- keep the caller's order for the response
  SELECT array_agg(b ORDER BY i) INTO v_by
    FROM (SELECT DISTINCT ON (lower(btrim(b))) lower(btrim(b)) AS b, i
            FROM unnest(p_by) WITH ORDINALITY u(b, i)
           WHERE nullif(btrim(b), '') IS NOT NULL
           ORDER BY lower(btrim(b)), i) z;

  EXECUTE $pv$
WITH
c AS (
  SELECT x.id, x.status::text AS status, coalesce(x.price, 0)::numeric AS price,
         CASE WHEN x.sale_source IN ('altercpa', 'affiliate') THEN 'altercpa'
              WHEN x.sale_source = 'elyon_crm' THEN 'elyon_crm'
              WHEN x.sale_source = 'web' THEN 'web'
              ELSE 'teleshop_other' END AS source,
         coalesce(x.sale_source_detail, '(none)') AS detail,
         x.sold_by_person_id, x.sold_at,
         coalesce(nullif(btrim(x.prediction_list_name), ''), '(none)') AS list,
         x.cpa_webmaster_id,
         coalesce(nullif(btrim(x.cpa_stream_id), ''), '(none)') AS stream,
         coalesce(nullif(btrim(x.product_name), ''), '(none)') AS product,
         coalesce(nullif(btrim(x.customer_city), ''), '(none)') AS city,
         (coalesce(x.sale_source_detail, '') <> 'disposition'
          AND (x.sold_at IS NOT NULL OR x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))) AS is_sale,
         (x.status IN ('paid', 'delivered')) AS is_delivered,
         CASE WHEN x.status IN ('paid', 'delivered') THEN
              CASE WHEN x.mex_delivered_at IS NOT NULL AND x.mex_cod_mkd IS NOT NULL
                   THEN x.mex_cod_mkd::numeric ELSE round(coalesce(x.price, 0) * 61.5) END END AS cash_mkd,
         (x.status = 'returned') AS is_returned,
         (x.status = 'returned' OR (x.status IN ('cancelled', 'trashed') AND x.sold_at IS NOT NULL)) AS is_lost
  FROM public.orders x
  WHERE x.created_at BETWEEN $1 AND $2
    AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
),
e AS (
  SELECT c.*,
         coalesce(sp.display_name, CASE WHEN c.sold_by_person_id IS NULL THEN '(none)' ELSE '(unknown)' END) AS person,
         coalesce(st.name, '(none)') AS team,
         CASE WHEN c.cpa_webmaster_id IS NULL THEN '(none)'
              ELSE coalesce(wm.name, 'WM ' || c.cpa_webmaster_id) END AS webmaster
  FROM c
  LEFT JOIN public.sales_people sp ON sp.id = c.sold_by_person_id
  LEFT JOIN LATERAL (
    SELECT m.team_key FROM public.sales_team_members m
     WHERE m.person_id = c.sold_by_person_id AND m.is_primary
       AND m.valid_from <= (c.sold_at AT TIME ZONE 'Europe/Skopje')::date
       AND coalesce(m.valid_to, 'infinity'::date) >= (c.sold_at AT TIME ZONE 'Europe/Skopje')::date
     ORDER BY m.valid_from DESC LIMIT 1) tmm ON c.sold_by_person_id IS NOT NULL AND c.sold_at IS NOT NULL
  LEFT JOIN public.sales_teams st ON st.key = tmm.team_key
  LEFT JOIN public.altercpa_webmasters wm ON wm.wm_id = c.cpa_webmaster_id
),
g AS (
  SELECT
    CASE WHEN 'source'    = ANY ($3) THEN e.source    END AS source,
    CASE WHEN 'detail'    = ANY ($3) THEN e.detail    END AS detail,
    CASE WHEN 'team'      = ANY ($3) THEN e.team      END AS team,
    CASE WHEN 'person'    = ANY ($3) THEN e.person    END AS person,
    CASE WHEN 'person'    = ANY ($3) THEN e.sold_by_person_id END AS person_id,
    CASE WHEN 'list'      = ANY ($3) THEN e.list      END AS list,
    CASE WHEN 'webmaster' = ANY ($3) THEN e.webmaster END AS webmaster,
    CASE WHEN 'stream'    = ANY ($3) THEN e.stream    END AS stream,
    CASE WHEN 'product'   = ANY ($3) THEN e.product   END AS product,
    CASE WHEN 'city'      = ANY ($3) THEN e.city      END AS city,
    count(*)                                              AS n,
    count(*) FILTER (WHERE e.is_sale)                     AS sold,
    sum(e.price)                                          AS placed_eur,
    coalesce(sum(e.price) FILTER (WHERE e.is_sale), 0)    AS sold_eur,
    count(*) FILTER (WHERE e.is_delivered)                AS delivered,
    coalesce(sum(e.cash_mkd), 0)                          AS cash_mkd,
    count(*) FILTER (WHERE e.is_returned)                 AS returned,
    count(*) FILTER (WHERE e.is_lost)                     AS lost
  FROM e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
),
r AS (
  SELECT g.*, row_number() OVER (ORDER BY g.sold_eur DESC, g.n DESC, g.source, g.detail, g.team, g.person,
                                          g.list, g.webmaster, g.stream, g.product, g.city) AS rn,
         count(*) OVER () AS total_rows
  FROM g
)
SELECT jsonb_build_object(
  'by', to_jsonb($3),
  'total_rows', coalesce(max(r.total_rows), 0),
  'truncated', coalesce(max(r.total_rows), 0) > 2000,
  'rows', coalesce(jsonb_agg(
     (jsonb_build_object('source', r.source, 'detail', r.detail, 'team', r.team, 'person', r.person,
                         'person_id', r.person_id, 'list', r.list, 'webmaster', r.webmaster,
                         'stream', r.stream, 'product', r.product, 'city', r.city)
      - ARRAY(SELECT k FROM unnest(ARRAY['source', 'detail', 'team', 'person', 'list', 'webmaster', 'stream', 'product', 'city']) k
              WHERE NOT (k = ANY ($3)))
      - CASE WHEN 'person' = ANY ($3) THEN ARRAY[]::text[] ELSE ARRAY['person_id'] END)
     || jsonb_build_object(
          'count', r.n, 'sold', r.sold,
          'placed_value_eur', round(r.placed_eur, 2), 'value_eur', round(r.sold_eur, 2),
          'delivered', r.delivered, 'delivered_cash_mkd', round(r.cash_mkd),
          'returned', r.returned, 'lost', r.lost)
     ORDER BY r.rn) FILTER (WHERE r.rn <= 2000), '[]'::jsonb)
)
FROM r
  $pv$
  INTO v_out
  USING v_from, v_to, v_by;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.insights_pivot(text, text, text[]) IS
  'Drill-down pivot for GET /api/insights/pivot: orders placed in the window grouped by 1-4 of source/detail/team/person/list/webmaster/stream/product/city; counts, sold value, delivered cash. Owners only (api gate); service_role only.';

REVOKE ALL ON FUNCTION public.insights_pivot(text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_pivot(text, text, text[]) TO service_role;

NOTIFY pgrst, 'reload schema';
