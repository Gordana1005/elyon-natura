-- The department of a sale made by the TELESHOP Lead-out team follows the AGENT (owner, 29.09.2026
-- ~09:55, answered explicitly, whole history): "every order our Lead-out agents make directly in our
-- CRM counts in Телешоп – Lead out — and it matters which agent confirms it, because soon affiliate
-- will work from our CRM too"; "LEADS-OUT documents booked by the same Lead-out agents: Телешоп – Lead
-- out"; "if an AFFILIATE agent makes an order in our CRM first, it counts in Affiliate out, and MEX
-- then confirms it — BIO NATURAL or NATURA".
--
--   orders.dept_override          'teleshop_out' when the seller (sold_by_person_id) was on the
--                                  teleshop Lead-out team (sales_team_members 'crm_prediction') on the
--                                  sale day, for a CRM-made sale (elyon_crm prediction_list / direct)
--                                  or a collabBox LEADS-OUT (elyon_crm collabbox_leads_out); NULL
--                                  otherwise — every other order keeps THE mapping, including an
--                                  affiliate agent's CRM sale (Affiliate – Lead out, or its NATURA
--                                  parcel's department: the existing exception).
--   order_dept_override(...)      that rule, in one place; set by trigger on insert and on every change
--                                  of source / detail / seller / sale time, and again when a person's
--                                  team membership changes (Settings → Teams).
--   cohort_order_source(4 args)   coalesce(override, the 3-argument mapping) — every report function
--                                  below is re-emitted from its LIVE body with the override passed
--                                  (exact edits only; drift-guarded).
-- Stored sale_source / sale_source_detail do NOT change: the Prediction-lists tab still finds list
-- sales by their detail. Payout / bonus math untouched (deferred by the owner).

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.customer_timeline(text,boolean)', '29e19c44e519dba1bc38431c6ca7deba', 'd6d9a812644f6ae2114f14d687719ca3'),
    ('public.insights_cash_rows(timestamp with time zone,timestamp with time zone)', '18d669ea04117110b57d3a4b7d38ccb5', 'db6aab1b919cf32a92b0552a54722ea8'),
    ('public.insights_leads_rows(timestamp with time zone,timestamp with time zone)', '8a2c1c8894b125c47b3f37fe6472784c', '13303d6a4d5e6bac897824c9252d67a9'),
    ('public.insights_overview(text,text,text,text)', 'f37bf6d8e50924076ef3653bb4a09b4b', 'd5c3fae55c483fa0a2986cd409994bd1'),
    ('public.insights_parcel_rows(timestamp with time zone,timestamp with time zone,text)', '14064dac42d673ec020909e61a970530', 'c276ff428d92ae6fd239daedfb489671'),
    ('public.insights_pivot(text,text,text[])', '0b432275b41dee080308ad0872d8abf4', 'd7723d11950aedac0b89521fe2cf357d'),
    ('public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean)', '10a251baa4e4c25bb934b9f27d4278f7', 'a9f02625ac64906a057e557cf63ac6c1'),
    ('public.insights_returns(timestamp with time zone,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,text[],boolean)', '03fb761dd7f1f082c64e11352c96a0b6', '62c7fda154de3bfdf4989c9801f96fba'),
    ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', '170fcf8478589351368fd96f47d8b7ef', 'aab235f6df723b447bdb8f4d8d11dc94'),
    ('public.insights_stock(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)', '0135094b39f52565250c138748abdfe9', '3cbd8b35a664276db691c734cc9c254b'),
    ('public.leaderboard_day_v2(date,text,text)', 'cb50d7db9e8e3c270b61981f7ffb15f9', '6439b749f6b8980106712fd64ed2f741'),
    ('public.order_departments(uuid[])', 'ffe49e35ddb30de6f31986fae987ecb9', 'c1b0675452f13aaf854cfdc23602c4ff'),
    ('public.order_origin(uuid)', 'bc8cf874c81397286ae07c5d5474ecd8', '9ca305840237e4f02b51191abb3a7f11'),
    ('public.insights_lists(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,boolean,integer)', '8d81ea303e38ebe61b566e76dcd1f229', 'b4c35f0ca87e53888cee9f34361658eb'),
    ('public.insights_lists_cash(timestamp with time zone,timestamp with time zone,boolean)', 'ca8dd95ab4ae208223c4c79207641b9d', '4bc60c3f94010af6145cacdd15218ec1')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'department by agent team: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
END
$drift$;

-- ── 1. the column ───────────────────────────────────────────────────────────
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS dept_override text;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_dept_override_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_dept_override_check
  CHECK (dept_override IS NULL OR dept_override IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'));
COMMENT ON COLUMN public.orders.dept_override IS
  'The department decided by the AGENT (20260942001800): teleshop_out for a CRM-made sale or a LEADS-OUT booked by the teleshop Lead-out team (crm_prediction) on the sale day; NULL = THE mapping (cohort_order_source 3-arg). Maintained by tg_orders_zz_dept_override and tg_sales_team_members_dept_override — never write it by hand.';

-- ── 2. the rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_dept_override(p_sale_source text, p_detail text, p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_sale_source = 'elyon_crm'
     AND p_detail IN ('prediction_list', 'direct', 'collabbox_leads_out')
     AND public.sales_person_in_team(p_person, 'crm_prediction', p_at)
    THEN 'teleshop_out'
  END
$fn$;
COMMENT ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz) IS
  'Owner 29.09.2026: a CRM-made sale or a LEADS-OUT booked by the teleshop Lead-out team (crm_prediction) on the sale day is Телешоп – Lead out; anything else NULL (THE mapping decides). Migration 20260942001800.';
REVOKE ALL ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.cohort_order_source(p_sale_source text, p_detail text, p_tracking text, p_dept_override text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(p_dept_override, public.cohort_order_source(p_sale_source, p_detail, p_tracking))
$fn$;
COMMENT ON FUNCTION public.cohort_order_source(text, text, text, text) IS
  'THE department of an order: the agent-team override (orders.dept_override, 20260942001800) else the folder / series mapping cohort_order_source(sale_source, detail, tracking).';
DO $g$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.cohort_order_source(text, text, text, text) TO service_role';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.cohort_order_source(text, text, text, text) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 3. kept current by triggers ─────────────────────────────────────────────
-- "zz": fires after the other BEFORE triggers on orders (alphabetical order), so it sees the seller
-- the stamping trigger set in the same statement.
CREATE OR REPLACE FUNCTION public.tg_orders_dept_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.dept_override := public.order_dept_override(NEW.sale_source, NEW.sale_source_detail, NEW.sold_by_person_id,
                                                  coalesce(NEW.sold_at, NEW.created_at));
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS tg_orders_zz_dept_override ON public.orders;
CREATE TRIGGER tg_orders_zz_dept_override
  BEFORE INSERT OR UPDATE OF sale_source, sale_source_detail, sold_by_person_id, sold_at ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_orders_dept_override();

-- A team change in Settings → Teams re-decides that person's CRM / LEADS-OUT sales (a handful).
CREATE OR REPLACE FUNCTION public.tg_sales_team_members_dept_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE _p uuid := coalesce(NEW.person_id, OLD.person_id);
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  UPDATE public.orders o
     SET dept_override = public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id, coalesce(o.sold_at, o.created_at))
   WHERE o.sold_by_person_id = _p
     AND o.sale_source = 'elyon_crm'
     AND o.sale_source_detail IN ('prediction_list', 'direct', 'collabbox_leads_out')
     AND o.dept_override IS DISTINCT FROM public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id, coalesce(o.sold_at, o.created_at));
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS tg_sales_team_members_dept_override ON public.sales_team_members;
CREATE TRIGGER tg_sales_team_members_dept_override
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_team_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_sales_team_members_dept_override();

-- ── 4. the whole history (owner: "цела историја") ───────────────────────────
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
UPDATE public.orders o
   SET dept_override = public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id, coalesce(o.sold_at, o.created_at))
 WHERE o.sale_source = 'elyon_crm'
   AND o.sale_source_detail IN ('prediction_list', 'direct', 'collabbox_leads_out')
   AND o.dept_override IS DISTINCT FROM public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id, coalesce(o.sold_at, o.created_at));

-- ── 5. every report passes the override (live bodies, exact edits) ──────────
-- public.customer_timeline(text,boolean) (1 call)
CREATE OR REPLACE FUNCTION public.customer_timeline(p_phone text, p_include_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH prm AS MATERIALIZED (
  SELECT CASE WHEN length(x.d) >= 8 THEN right(x.d, 8) END AS p8,
         coalesce(p_include_money, false)                   AS money,
         300                                                AS cap
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS d) x
),
-- ── CRM orders ──────────────────────────────────────────────────────────────
ord AS MATERIALIZED (
  SELECT o.id, o.display_id, o.created_at, o.status::text AS status,
         o.sale_source, o.sale_source_detail, o.source_type,
         o.product_name, o.quantity, o.price,
         o.customer_name, o.customer_city, o.customer_phone,
         o.sold_at, o.sold_via, sp.display_name AS sold_by,
         o.confirmed_by_name, o.confirmed_at, o.assigned_agent_name,
         o.cancellation_reason, o.cancellation_reason_notes,
         o.trash_reason, o.trash_reason_notes,
         o.return_reason, o.return_reason_notes,
         o.prediction_list_name, o.duplicated_from_display,
         o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd, o.dept_override,
         o.mex_delivered_at, o.mex_returned_at,
         o.paid_at, o.paid_basis, o.shipped_at, o.returned_at,
         -- The 0 ден cancel/trash call-outcome rows /calls writes: a call
         -- result, not a purchase (classify_sale_source, 20260935000000).
         (coalesce(o.sale_source_detail = 'disposition', false)
          OR coalesce(public.is_synthetic_product_name(o.product_name), false)) AS disposition
  FROM public.orders o
  LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
  WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = (SELECT p8 FROM prm)
),
items AS (
  SELECT oi.order_id,
         jsonb_agg(jsonb_build_object('name', oi.product_name, 'qty', oi.quantity)
                   ORDER BY oi.created_at, oi.id) AS j
  FROM public.order_items oi
  WHERE oi.order_id IN (SELECT id FROM ord)
  GROUP BY oi.order_id
),
-- ── Web shop (naturatherapy.mk) ─────────────────────────────────────────────
web AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.is_legacy, w.status, w.payment_method,
         w.payment_status,
         public.web_order_outcome(w.status, w.payment_status, w.payment_method) AS outcome,
         w.total, w.shipping_total, w.currency, w.city, w.source, w.channel,
         w.created_at, w.shipped_at, w.mex_tracking_id, w.tracking_status
  FROM public.web_orders w
  WHERE w.phone8 = (SELECT p8 FROM prm)
    AND w.deleted_in_shop_at IS NULL
),
web_items AS (
  SELECT i.shop_order_id,
         jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant_label,
                                      'qty', i.quantity, 'gift', i.kind = 'GIFT')
                   ORDER BY i.shop_item_id) AS j
  FROM public.web_order_items i
  WHERE i.shop_order_id IN (SELECT shop_order_id FROM web)
  GROUP BY i.shop_order_id
),
-- ── MEX parcels: on the phone, or carried by one of the above ───────────────
par_keys AS (
  SELECT m.tracking_id FROM public.mex_parcels m WHERE m.phone8 = (SELECT p8 FROM prm)
  UNION
  SELECT m.tracking_id FROM public.mex_parcels m WHERE m.order_id IN (SELECT id FROM ord)
  UNION
  SELECT o.mex_tracking_id FROM ord o WHERE o.mex_tracking_id IS NOT NULL
  UNION
  SELECT w.mex_tracking_id FROM web w WHERE w.mex_tracking_id IS NOT NULL
),
par AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd,
         p.receiver_name, p.receiver_city, p.order_id, p.link_method,
         coalesce(p.created_at_mex, p.first_seen_at) AS at,
         p.delivered_at, p.returned_at,
         -- coalesce: `NULL IN (…)` is NULL, and NOT NULL would drop the row
         (coalesce(p.order_id IN (SELECT id FROM ord), false)
          OR p.tracking_id IN (SELECT o.mex_tracking_id FROM ord o WHERE o.mex_tracking_id IS NOT NULL)) AS under_order,
         p.tracking_id IN (SELECT w.mex_tracking_id FROM web w WHERE w.mex_tracking_id IS NOT NULL)   AS under_web,
         lo.display_id AS linked_display_id,
         jsonb_build_object(
           'tracking_id',    p.tracking_id,
           'account',        p.account,
           'series',         p.series,
           -- The DocNumber series names the sales channel (20260935000000).
           'channel',        CASE WHEN p.sender_reference ~* '^NTMK' OR p.tracking_id ~* '^NTMK' THEN 'web'
                                  WHEN p.series IN ('9100', '9102') THEN 'teleshop'
                                  WHEN p.series = '9108' THEN 'social'
                                  WHEN p.series = '9103' THEN 'leads_out'
                                  WHEN p.series = '9110' THEN 'leads'
                                  WHEN p.tracking_id ~ '^ORD-' THEN 'crm'
                                  ELSE 'other' END,
           'status_id',      p.status_id,
           'status_name',    p.status_name,
           'created_at',     coalesce(p.created_at_mex, p.first_seen_at),
           'delivered_at',   p.delivered_at,
           'returned_at',    p.returned_at,
           'receiver_name',  p.receiver_name,
           'receiver_city',  p.receiver_city,
           'link_method',    p.link_method,
           'phone_match',    coalesce(p.phone8 = (SELECT p8 FROM prm), false)
         ) || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('cod_mkd', p.cod_mkd)
                   ELSE '{}'::jsonb END AS pj
  FROM public.mex_parcels p
  JOIN par_keys k ON k.tracking_id = p.tracking_id
  LEFT JOIN public.orders lo ON lo.id = p.order_id
),
-- ── AlterCPA ledger ─────────────────────────────────────────────────────────
acl AS MATERIALIZED (
  SELECT a.altercpa_id, a.order_id, a.geo, a.offer_name, a.webmaster, a.phase, a.status,
         a.reason, a.decision, a.decided_at, a.customer_name, a.city, a.quantity,
         a.skip_reason, a.price_eur,
         coalesce(a.created_remote, a.first_seen_at) AS at,
         coalesce(a.order_id IN (SELECT id FROM ord), false) AS under_order,
         lo.display_id AS linked_display_id,
         dsp.display_name AS decided_by
  FROM public.altercpa_leads a
  LEFT JOIN public.sales_person_identities si
         ON si.kind = 'altercpa_user' AND si.account_id = a.account_id
        AND si.value = a.decided_by_altercpa_user::text
  LEFT JOIN public.sales_people dsp ON dsp.id = si.person_id
  LEFT JOIN public.orders lo ON lo.id = a.order_id
  WHERE a.order_id IN (SELECT id FROM ord)
     OR (right(regexp_replace(coalesce(a.phone_e164, a.phone_raw, ''), '[^0-9]', '', 'g'), 8) = (SELECT p8 FROM prm)
         AND (a.geo = 'MK' OR a.order_id IS NOT NULL))
),
acl_j AS (
  SELECT a.*,
         jsonb_build_object(
           'altercpa_id',   a.altercpa_id,
           'geo',           a.geo,
           'offer',         a.offer_name,
           'webmaster',     a.webmaster,
           'phase',         a.phase,
           'lead_status',   a.status,
           'reason',        a.reason,
           'decision',      a.decision,
           'decided_by',    a.decided_by,
           'decided_at',    a.decided_at,
           'created_at',    a.at,
           'customer_name', a.customer_name,
           'city',          a.city,
           'quantity',      a.quantity,
           'skip_reason',   a.skip_reason
         ) || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('price_eur', a.price_eur)
                   ELSE '{}'::jsonb END AS lj
  FROM acl a
),
-- ── Calls, notes, lists ─────────────────────────────────────────────────────
cl AS (
  SELECT c.id, c.context_type, c.context_id, c.outcome, c.notes, c.connection_state,
         c.total_seconds, c.talk_seconds,
         coalesce(c.started_at, c.created_at) AS at,
         pr.full_name AS agent_name
  FROM public.call_logs c
  LEFT JOIN public.profiles pr ON pr.user_id = c.agent_id
  WHERE c.customer_phone IS NOT NULL
    AND right(regexp_replace(COALESCE(c.customer_phone, ''), '\D', '', 'g'), 8) = (SELECT p8 FROM prm)
),
-- ~99% of order_notes are written by importers and repair runs ("System …").
-- Those stay with their order (the newest 3, in the order event); only what a
-- person wrote becomes a timeline event of its own.
nt AS (
  SELECT n.id, n.order_id, n.text, n.author_name, n.created_at,
         coalesce(n.author_name ILIKE 'System%', false) AS is_system
  FROM public.order_notes n
  WHERE n.order_id IN (SELECT id FROM ord)
),
nt_ord AS (
  SELECT n.order_id,
         count(*) FILTER (WHERE NOT n.is_system) AS human_n,
         count(*) FILTER (WHERE n.is_system)     AS system_n,
         jsonb_path_query_array(
           coalesce(jsonb_agg(jsonb_build_object('at', n.created_at, 'who', n.author_name,
                                                 'text', left(n.text, 400))
                              ORDER BY n.created_at DESC) FILTER (WHERE n.is_system), '[]'::jsonb),
           '$[0 to 2]') AS system_notes
  FROM nt n
  GROUP BY n.order_id
),
-- Members are keyed by the exact phone string the engine copied from orders;
-- the canonical +389 form catches a member whose orders were re-keyed.
phones AS (
  SELECT o.customer_phone AS phone FROM ord o WHERE o.customer_phone IS NOT NULL
  UNION
  SELECT '+389' || (SELECT p8 FROM prm)
),
mem AS (
  SELECT l.name, l.category, m.created_at, m.assigned_agent_name, m.is_completed,
         m.last_call_at, m.last_call_outcome, m.in_call_again_until, m.product_name,
         m.trigger_event_at
  FROM public.prediction_segment_members m
  JOIN public.prediction_segment_lists l ON l.id = m.list_id
  WHERE m.customer_phone IN (SELECT phone FROM phones)
),
prof AS (
  SELECT cp.customer_name, cp.city
  FROM public.customer_profiles cp
  WHERE cp.phone IN (SELECT phone FROM phones)
),
-- ── Events ──────────────────────────────────────────────────────────────────
ev AS (
  -- CRM orders, with their parcel(s) and AlterCPA ledger row nested
  SELECT o.created_at AS at, jsonb_build_object(
           'kind',          'order',
           'key',           'o:' || o.id,
           'at',            o.created_at,
           'status',        o.status,
           'source',        o.sale_source,
           'source_detail', o.sale_source_detail,
           'department',    public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override),
           'source_type',   o.source_type,
           'disposition',   o.disposition,
           'title',         o.product_name,
           'items',         coalesce(it.j, '[]'::jsonb),
           'quantity',      o.quantity,
           'amount_eur',    o.price,
           'who',           coalesce(o.sold_by, o.confirmed_by_name, o.assigned_agent_name),
           'sold_by',       o.sold_by,
           'sold_at',       o.sold_at,
           'sold_via',      o.sold_via,
           'confirmed_by',  o.confirmed_by_name,
           'assigned_to',   o.assigned_agent_name,
           'list',          o.prediction_list_name,
           'customer_name', o.customer_name,
           'city',          o.customer_city,
           'cancellation_reason',       o.cancellation_reason,
           'cancellation_reason_notes', o.cancellation_reason_notes,
           'trash_reason',              o.trash_reason,
           'trash_reason_notes',        o.trash_reason_notes,
           'return_reason',             o.return_reason,
           'return_reason_notes',       o.return_reason_notes,
           'duplicated_from', o.duplicated_from_display,
           'paid_at',       o.paid_at,
           'paid_basis',    o.paid_basis,
           'shipped_at',    o.shipped_at,
           'returned_at',   o.returned_at,
           'notes_count',   coalesce(no.human_n, 0),
           'system_notes_count', coalesce(no.system_n, 0),
           'system_notes',  coalesce(no.system_notes, '[]'::jsonb),
           'parcels',       coalesce(
                              (SELECT jsonb_agg(p.pj ORDER BY p.at) FROM par p
                                WHERE p.order_id = o.id OR p.tracking_id = o.mex_tracking_id),
                              -- the order knows its tracking id but the register
                              -- has no row for it yet: show the order's own copy
                              CASE WHEN o.mex_tracking_id IS NOT NULL THEN jsonb_build_array(
                                jsonb_build_object(
                                  'tracking_id',  o.mex_tracking_id,
                                  'account',      o.mex_account,
                                  'status_id',    o.mex_status_id,
                                  'delivered_at', o.mex_delivered_at,
                                  'returned_at',  o.mex_returned_at,
                                  'from_order',   true)
                                || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('cod_mkd', o.mex_cod_mkd)
                                        ELSE '{}'::jsonb END)
                              END,
                              '[]'::jsonb),
           'lead',          (SELECT a.lj FROM acl_j a WHERE a.order_id = o.id
                              ORDER BY a.at DESC NULLS LAST LIMIT 1),
           'refs',          jsonb_build_object(
                              'order_id',    o.id,
                              'display_id',  o.display_id,
                              'tracking_id', o.mex_tracking_id,
                              'altercpa_id', (SELECT a.altercpa_id FROM acl a WHERE a.order_id = o.id
                                               ORDER BY a.at DESC NULLS LAST LIMIT 1))
         ) AS j
  FROM ord o
  LEFT JOIN items it ON it.order_id = o.id
  LEFT JOIN nt_ord no ON no.order_id = o.id

  UNION ALL
  -- Web-shop orders, with their MEX parcel nested
  SELECT w.created_at, jsonb_build_object(
           'kind',           'web_order',
           'key',            'w:' || w.shop_order_id,
           'at',             w.created_at,
           'status',         w.outcome,
           'shop_status',    w.status,
           'payment_method', w.payment_method,
           'payment_status', w.payment_status,
           'source',         'web',
           'legacy',         w.is_legacy,
           'title',          w.order_number,
           'items',          coalesce(wi.j, '[]'::jsonb),
           'city',           w.city,
           'channel',        w.channel,
           'shop_source',    w.source,
           'tracking_status', w.tracking_status,
           'shipped_at',     w.shipped_at,
           'parcels',        coalesce((SELECT jsonb_agg(p.pj ORDER BY p.at) FROM par p
                                        WHERE p.tracking_id = w.mex_tracking_id), '[]'::jsonb),
           'refs',           jsonb_build_object('web_number', w.order_number, 'tracking_id', w.mex_tracking_id)
         ) || CASE WHEN (SELECT money FROM prm)
                   THEN jsonb_build_object('amount_mkd', w.total, 'shipping_mkd', w.shipping_total, 'currency', w.currency)
                   ELSE '{}'::jsonb END
  FROM web w
  LEFT JOIN web_items wi ON wi.shop_order_id = w.shop_order_id

  UNION ALL
  -- AlterCPA leads that are not one of this customer's orders
  SELECT a.at, jsonb_build_object(
           'kind',        'altercpa_lead',
           'key',         'a:' || a.altercpa_id,
           'at',          a.at,
           'status',      coalesce(a.decision, 'open'),
           'source',      'altercpa',
           'title',       a.offer_name,
           'who',         a.decided_by,
           'lead',        a.lj,
           'refs',        jsonb_build_object('altercpa_id', a.altercpa_id, 'order_id', a.order_id,
                                             'display_id', a.linked_display_id)
         )
  FROM acl_j a
  WHERE NOT a.under_order

  UNION ALL
  -- MEX parcels that belong to none of the above (MEX-only sales, or a parcel
  -- linked to another phone's order)
  SELECT p.at, jsonb_build_object(
           'kind',             'parcel',
           'key',              'p:' || p.tracking_id,
           'at',               p.at,
           'status',           p.status_name,
           'source',           p.pj ->> 'channel',
           'title',            p.tracking_id,
           'parcel',           p.pj,
           'linked_elsewhere', p.order_id IS NOT NULL,
           'refs',             jsonb_build_object('tracking_id', p.tracking_id, 'order_id', p.order_id,
                                                  'display_id', p.linked_display_id)
         )
  FROM par p
  WHERE NOT p.under_order AND NOT p.under_web

  UNION ALL
  SELECT c.at, jsonb_build_object(
           'kind',             'call',
           'key',              'c:' || c.id,
           'at',               c.at,
           'status',           c.outcome,
           'who',              c.agent_name,
           'context_type',     c.context_type,
           'connection_state', c.connection_state,
           'seconds',          c.total_seconds,
           'talk_seconds',     c.talk_seconds,
           'text',             c.notes,
           'refs',             jsonb_build_object(
                                 'order_id',   CASE WHEN c.context_type = 'order' THEN c.context_id END,
                                 'display_id', (SELECT o.display_id FROM ord o WHERE o.id = c.context_id))
         )
  FROM cl c

  UNION ALL
  SELECT n.created_at, jsonb_build_object(
           'kind', 'note',
           'key',  'n:' || n.id,
           'at',   n.created_at,
           'who',  n.author_name,
           'text', n.text,
           'refs', jsonb_build_object('order_id', n.order_id,
                                      'display_id', (SELECT o.display_id FROM ord o WHERE o.id = n.order_id))
         )
  FROM nt n
  WHERE NOT n.is_system

  UNION ALL
  SELECT m.created_at, jsonb_build_object(
           'kind',              'list',
           'key',               'l:' || m.name,
           'at',                m.created_at,
           'title',             m.name,
           'category',          m.category,
           'status',            CASE WHEN m.is_completed THEN 'completed'
                                     WHEN m.in_call_again_until > now() THEN 'call_again'
                                     WHEN m.assigned_agent_name IS NOT NULL THEN 'assigned'
                                     ELSE 'waiting' END,
           'who',               m.assigned_agent_name,
           'product',           m.product_name,
           'trigger_at',        m.trigger_event_at,
           'last_call_at',      m.last_call_at,
           'last_call_outcome', m.last_call_outcome,
           'refs',              '{}'::jsonb
         )
  FROM mem m
),
-- Two caps, so a chatty customer's calls and notes can never push her
-- purchases off the page: the newest `cap` purchase-type events
-- (order / web_order / altercpa_lead / parcel / list) plus the newest
-- `cap / 2` calls and notes.
evr AS (
  SELECT e.at, e.j,
         (e.j ->> 'kind') IN ('call', 'note') AS aux,
         row_number() OVER (PARTITION BY (e.j ->> 'kind') IN ('call', 'note')
                            ORDER BY e.at DESC NULLS LAST, e.j ->> 'key') AS rn
  FROM ev e
),
evl AS (
  SELECT r.at, jsonb_strip_nulls(r.j) AS j
  FROM evr r
  WHERE r.rn <= CASE WHEN r.aux THEN (SELECT cap FROM prm) / 2 ELSE (SELECT cap FROM prm) END
),
-- ── Header ──────────────────────────────────────────────────────────────────
-- Spellings that differ only by case or spacing are one name ("Suta  Topkoska"
-- = "SUTA TOPKOSKA"); the most frequent spelling represents the group.
-- Cyrillic and Latin forms stay separate on purpose — both are real.
nm AS (
  SELECT regexp_replace(btrim(n), '\s+', ' ', 'g') AS n FROM (
    SELECT customer_name AS n FROM ord
    UNION ALL SELECT customer_name FROM acl
    UNION ALL SELECT customer_name FROM prof
    UNION ALL SELECT receiver_name FROM par
  ) s WHERE coalesce(btrim(n), '') <> ''
),
nm_top AS (
  SELECT g.n, g.k FROM (
    SELECT count(*) AS k, mode() WITHIN GROUP (ORDER BY n) AS n
    FROM nm GROUP BY lower(n)
  ) g
  ORDER BY g.k DESC, g.n
  LIMIT 6
),
ct AS (
  SELECT c FROM (
    SELECT btrim(customer_city) AS c FROM ord
    UNION ALL SELECT btrim(city) FROM web
    UNION ALL SELECT btrim(city) FROM acl
    UNION ALL SELECT btrim(city) FROM prof
    UNION ALL SELECT btrim(receiver_city) FROM par
  ) s WHERE coalesce(c, '') <> ''
),
seen AS (
  SELECT min(at) AS first_seen, max(at) AS last_seen FROM ev WHERE (j ->> 'kind') <> 'list'
)
SELECT CASE
  WHEN (SELECT p8 FROM prm) IS NULL THEN jsonb_build_object('ok', false, 'error', 'phone_too_short')
  ELSE jsonb_build_object(
    'ok',           true,
    'phone8',       (SELECT p8 FROM prm),
    'money',        (SELECT money FROM prm),
    'generated_at', now(),
    'customer', jsonb_build_object(
      'names',      coalesce((SELECT jsonb_agg(q.n ORDER BY q.k DESC, q.n) FROM nm_top q), '[]'::jsonb),
      'cities',     coalesce((SELECT jsonb_agg(q.c ORDER BY q.k DESC, q.c) FROM
                               (SELECT c, count(*) AS k FROM ct GROUP BY c ORDER BY count(*) DESC, c LIMIT 6) q), '[]'::jsonb),
      'first_seen', (SELECT first_seen FROM seen),
      'last_seen',  (SELECT last_seen FROM seen)
    ),
    'summary', jsonb_build_object(
      'orders',          (SELECT count(*) FROM ord),
      'sales',           (SELECT count(*) FROM ord WHERE NOT disposition),
      'dispositions',    (SELECT count(*) FROM ord WHERE disposition),
      'delivered',       (SELECT count(*) FROM ord WHERE status IN ('paid', 'delivered')),
      'returned',        (SELECT count(*) FROM ord WHERE status = 'returned'),
      'cancelled',       (SELECT count(*) FROM ord WHERE status = 'cancelled'),
      'trashed',         (SELECT count(*) FROM ord WHERE status = 'trashed'),
      'open',            (SELECT count(*) FROM ord WHERE status IN ('pending', 'take', 'call_again', 'duplicated')),
      'in_progress',     (SELECT count(*) FROM ord WHERE status IN ('confirmed', 'shipped')),
      -- card_unpaid = a failed card checkout; the shop counts it nowhere
      'web_orders',      (SELECT count(*) FROM web WHERE outcome <> 'card_unpaid'),
      'web_delivered',   (SELECT count(*) FROM web WHERE outcome = 'delivered'),
      'altercpa_leads',  (SELECT count(*) FROM acl),
      'parcels',         (SELECT count(*) FROM par),
      'parcels_delivered', (SELECT count(*) FROM par WHERE status_id = 2),
      'parcels_returned',  (SELECT count(*) FROM par WHERE status_id = 7),
      'parcels_mex_only',  (SELECT count(*) FROM par WHERE NOT under_order AND NOT under_web AND order_id IS NULL),
      'calls',           (SELECT count(*) FROM cl),
      'notes',           (SELECT count(*) FROM nt WHERE NOT is_system),
      'system_notes',    (SELECT count(*) FROM nt WHERE is_system),
      'lists',           coalesce((SELECT jsonb_agg(DISTINCT name) FROM mem), '[]'::jsonb)
    ) || CASE WHEN (SELECT money FROM prm)
              THEN jsonb_build_object(
                     -- MEX-proven cash: delivered parcels, each counted once
                     'lifetime_delivered_mkd',
                       coalesce((SELECT sum(cod_mkd) FROM par WHERE status_id = 2), 0),
                     -- what the CRM says was paid (price, EUR) — includes the
                     -- imported history that predates the MEX register
                     'paid_orders_eur',
                       coalesce((SELECT sum(price) FROM ord
                                  WHERE status IN ('paid', 'delivered') AND NOT disposition), 0))
              ELSE '{}'::jsonb END,
    'events',       coalesce((SELECT jsonb_agg(e.j ORDER BY e.at DESC NULLS LAST, e.j ->> 'key') FROM evl e), '[]'::jsonb),
    'total_events', (SELECT count(*) FROM ev),
    'kind_counts',  coalesce((SELECT jsonb_object_agg(k.kind, k.n) FROM
                               (SELECT e.j ->> 'kind' AS kind, count(*) AS n FROM ev e GROUP BY 1) k), '{}'::jsonb),
    'truncated',    (SELECT count(*) FROM ev) > (SELECT count(*) FROM evl)
  )
END
$function$;

-- public.insights_cash_rows(timestamp with time zone,timestamp with time zone) (1 call)
CREATE OR REPLACE FUNCTION public.insights_cash_rows(p_from timestamp with time zone, p_to_end timestamp with time zone)
 RETURNS TABLE(kind text, source text, split text, tracking_id text, delivered_at timestamp with time zone, cod_mkd numeric, card_mkd numeric, sale_at timestamp with time zone, order_id uuid, display_id text, web_id integer, account text, series text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_cash_rows: bad window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE $cr$
WITH
dp AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.sender_reference, p.cod_mkd, p.delivered_at,
         p.created_at_mex, p.order_id
  FROM public.mex_parcels p
  WHERE p.delivered_at BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(p.phone8, $3)
),
led AS MATERIALIZED (
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
wcl AS (                   -- the live web order that claims the parcel
  SELECT DISTINCT ON (w.mex_tracking_id)
         w.mex_tracking_id AS tr, w.shop_order_id, w.order_number, w.created_at, w.total,
         w.payment_method, w.payment_status,
         public.insights_excluded8(w.phone8, $3) AS test
  FROM public.web_orders w
  JOIN dp ON dp.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
  ORDER BY w.mex_tracking_id, w.created_at DESC, w.shop_order_id DESC
),
ocl AS (                   -- the real order that holds it: a non-test holder,
                           -- the first-created one (the shared-parcel rule)
  SELECT DISTINCT ON (x.mex_tracking_id)
         x.mex_tracking_id AS tr, x.id, x.display_id, x.sale_source, x.sale_source_detail,
         x.mex_tracking_id AS mtr, x.dept_override,
         coalesce(x.sold_at, led.decided_at, x.confirmed_at, x.created_at) AS sale_at,
         public.insights_excluded8(public.insights_phone8(x.customer_phone), $3) AS test
  FROM dp
  JOIN public.orders x ON x.mex_tracking_id = dp.tracking_id
  LEFT JOIN led ON led.order_id = x.id
  WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
  ORDER BY x.mex_tracking_id, public.insights_excluded8(public.insights_phone8(x.customer_phone), $3),
           x.created_at, x.id
)
SELECT CASE WHEN wcl.tr IS NOT NULL THEN 'web' WHEN ow.id IS NOT NULL THEN 'order' ELSE 'mex' END AS kind,
       CASE WHEN wcl.tr IS NOT NULL THEN 'web'
            WHEN ow.id IS NOT NULL THEN public.cohort_order_source(ow.sale_source, ow.sale_source_detail, ow.mtr, ow.dept_override)
            ELSE public.cohort_parcel_source(public.cohort_parcel_split(dp.account, dp.series, dp.tracking_id, dp.sender_reference)) END AS source,
       CASE WHEN wcl.tr IS NOT NULL THEN CASE WHEN wcl.payment_method = 'CARD' THEN 'card' ELSE 'cod' END
            WHEN ow.id IS NOT NULL THEN coalesce(ow.sale_source_detail, 'none')
            ELSE public.cohort_parcel_split(dp.account, dp.series, dp.tracking_id, dp.sender_reference) END AS split,
       dp.tracking_id                                                        AS tracking_id,
       dp.delivered_at                                                       AS delivered_at,
       dp.cod_mkd::numeric                                                   AS cod_mkd,
       CASE WHEN wcl.tr IS NOT NULL AND wcl.payment_method = 'CARD'
                 AND wcl.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
            THEN greatest(round(wcl.total) - coalesce(dp.cod_mkd, 0), 0) END AS card_mkd,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.created_at
            WHEN ow.id IS NOT NULL THEN ow.sale_at
            ELSE dp.created_at_mex END                                       AS sale_at,
       CASE WHEN wcl.tr IS NULL THEN ow.id END                               AS order_id,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.order_number
            WHEN ow.id IS NOT NULL THEN ow.display_id
            ELSE dp.tracking_id END                                          AS display_id,
       wcl.shop_order_id                                                     AS web_id,
       dp.account                                                            AS account,
       dp.series                                                             AS series
FROM dp
LEFT JOIN wcl ON wcl.tr = dp.tracking_id
LEFT JOIN ocl ON ocl.tr = dp.tracking_id
-- a parcel linked (mex_parcels.order_id) to a real order that does not carry
-- its tracking id (0 on 2026-09-28) still belongs to that order
LEFT JOIN LATERAL (
  SELECT x.id, x.display_id, x.sale_source, x.sale_source_detail, x.mex_tracking_id AS mtr, x.dept_override,
         coalesce(x.sold_at, (SELECT led.decided_at FROM led WHERE led.order_id = x.id),
                  x.confirmed_at, x.created_at) AS sale_at,
         public.insights_excluded8(public.insights_phone8(x.customer_phone), $3) AS test
  FROM public.orders x
  WHERE ocl.tr IS NULL AND wcl.tr IS NULL AND dp.order_id IS NOT NULL
    AND x.id = dp.order_id
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
) olk ON true
CROSS JOIN LATERAL (
  SELECT coalesce(ocl.id, olk.id)                 AS id,
         coalesce(ocl.display_id, olk.display_id) AS display_id,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.sale_source ELSE olk.sale_source END               AS sale_source,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.sale_source_detail ELSE olk.sale_source_detail END AS sale_source_detail,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.mtr ELSE olk.mtr END                               AS mtr,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.dept_override ELSE olk.dept_override END           AS dept_override,
         coalesce(ocl.sale_at, olk.sale_at)       AS sale_at,
         coalesce(ocl.test, olk.test, false)      AS test
) ow
-- a parcel only a test order / test web order holds is theirs: not cash
WHERE CASE WHEN wcl.tr IS NOT NULL THEN NOT wcl.test ELSE NOT ow.test END
  $cr$
  USING p_from, p_to_end, public.report_excluded_phone8s();   -- $3: the test phones, read once
END;
$function$;

-- public.insights_leads_rows(timestamp with time zone,timestamp with time zone) (1 call)
CREATE OR REPLACE FUNCTION public.insights_leads_rows(p_from timestamp with time zone, p_to_end timestamp with time zone)
 RETURNS TABLE(kind text, source text, split text, came_at timestamp with time zone, state text, disposition boolean, bucket text, order_id uuid, display_id text, web_id integer, person_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_leads_rows: bad window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE $lr$
WITH
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr
  FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels
  SELECT p.tracking_id AS tr
  FROM public.mex_parcels p
  WHERE p.phone8 = ANY ($3)
),
ol AS (
  SELECT x.id, x.display_id, x.status::text AS status, x.sale_source, x.sale_source_detail,
         x.mex_tracking_id, x.created_at, x.sold_by_person_id, x.dept_override,
         public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                    x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                    x.mex_cod_mkd, x.mex_delivered_at,
                                    coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) AS bucket
  FROM public.orders x
  WHERE x.created_at BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $3)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
),
wos AS MATERIALIZED (       -- the shop's classifier once per distinct (status, payment)
  SELECT d.status, d.payment_status, d.payment_method,
         public.web_order_outcome(d.status, d.payment_status, d.payment_method) AS oc
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method
          FROM public.web_orders w
         WHERE w.deleted_in_shop_at IS NULL
           AND w.created_at BETWEEN $1 AND $2) d
),
wl AS (
  SELECT w.shop_order_id, w.order_number, w.payment_method, w.created_at, wos.oc,
         public.cohort_web_bucket(wos.oc, w.is_legacy, w.total, p.status_id, p.tracking_id IS NOT NULL) AS bucket
  FROM public.web_orders w
  JOIN wos ON wos.status = w.status AND wos.payment_status = w.payment_status
          AND wos.payment_method = w.payment_method
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(w.phone8, $3)
    AND NOT public.insights_excluded8(p.phone8, $3)
)
SELECT 'order'::text                                                           AS kind,
       public.cohort_order_source(ol.sale_source, ol.sale_source_detail, ol.mex_tracking_id, ol.dept_override) AS source,
       coalesce(ol.sale_source_detail, 'none')                                 AS split,
       ol.created_at                                                           AS came_at,
       CASE WHEN public.cohort_in_total(ol.bucket)                             THEN 'sale'
            WHEN ol.status = 'cancelled'                                       THEN 'cancelled'
            WHEN ol.status = 'trashed'                                         THEN 'trashed'
            WHEN ol.status IN ('pending', 'take', 'call_again', 'duplicated')  THEN 'open'
            ELSE 'other' END                                                   AS state,
       (ol.sale_source_detail IS NOT DISTINCT FROM 'disposition')              AS disposition,
       ol.bucket                                                               AS bucket,
       ol.id                                                                   AS order_id,
       ol.display_id                                                           AS display_id,
       NULL::integer                                                           AS web_id,
       ol.sold_by_person_id                                                    AS person_id
FROM ol
UNION ALL
SELECT 'web'::text,
       'web'::text,
       CASE WHEN wl.payment_method = 'CARD' THEN 'card' ELSE 'cod' END,
       wl.created_at,
       CASE WHEN public.cohort_in_total(wl.bucket) THEN 'sale'
            WHEN wl.oc = 'cancelled'               THEN 'cancelled'
            WHEN wl.oc = 'awaiting'                THEN 'open'
            ELSE 'other' END,
       false,
       wl.bucket, NULL::uuid, wl.order_number, wl.shop_order_id, NULL::uuid
FROM wl
WHERE wl.oc <> 'card_unpaid'
  $lr$
  USING p_from, p_to_end, public.report_excluded_phone8s();   -- $3: the test phones, read once
END;
$function$;

-- public.insights_overview(text,text,text,text) (1 call)
CREATE OR REPLACE FUNCTION public.insights_overview(p_from text, p_to_end text, p_prev_from text DEFAULT NULL::text, p_prev_to_end text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
AS $function$
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
  v_excluded  text[];
  v_np_days   integer;
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

  -- The owner's test phones (public.report_excluded_phones, 20260939000700):
  -- read once and handed to every query below as a constant — the
  -- foundation's rule (20260940000000): their parcels, and every order / web
  -- order on such a phone or holding such a parcel, are in no number here.
  v_excluded := public.report_excluded_phone8s();
  -- The no-parcel rule's days (app_settings.no_parcel_rule.days, default 10,
  -- never below 3): the same helper apply_no_parcel_rule() and GET
  -- /orders?attention=approved_no_parcel_7d read (20260940000300).
  v_np_days := public.no_parcel_rule_days();

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
          AND NOT public.insights_excluded8(w.phone8, $1::text[])
      $w$ INTO v_waiting USING v_excluded;
    EXCEPTION WHEN OTHERS THEN
      v_claimed := NULL; v_waiting := NULL;
    END;
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 web block ·
  -- $6 web block (prev) · $7 web_sync_runs summary · $8 web block error ·
  -- $9 long window (> 31 days: history lookup scans once instead of probing) ·
  -- $10 MEX tracking ids web orders claim · $11 web orders waiting > 24 h ·
  -- $12 the test phones' last-8 digits · $13 the no-parcel rule's days
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
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                        ('social', 5), ('web', 6)) v(src, ord)
),
bks AS (
  SELECT * FROM (VALUES ('awaiting', 1), ('preparing', 2), ('packed', 3), ('courier', 4),
                        ('delivered', 5), ('returned', 6), ('cancelled', 7), ('trashed', 8)) v(bucket, ord)
),

-- ── the owner's test phones ($12, public.report_excluded_phones) ──────────
-- Their parcels, and every order on such a phone or holding such a parcel:
-- in no figure below (the foundation's rule, 20260940000000). The phone
-- expression is idx_orders_phone_last8's, so this is an index probe.
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($12::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($12::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
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
         -- the six departments (owner 28.09.2026, 20260942001000): a CRM-made sale
         -- shipped on a NATURA teleshop / social series is that department's
         public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS src,
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
    AND x.id NOT IN (SELECT xto.id FROM xto)
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
           -- a web order's parcel is the shop's; any other parcel with no order belongs to
           -- the source its series names (NTMK… / M… → web · 9110 → Affiliate – Lead in ·
           -- 9103 → Affiliate – Lead out · 9102 → Телешоп – Lead out · 9100 → Телешоп – Lead in ·
           -- 9108 / 1300 → Social media · else Lead in; owner 28.09, 20260942001000)
           CASE WHEN coalesce(p.tracking_id = ANY ($10::text[]), false) THEN 'web'
                ELSE public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference)) END AS src,
           -- the shop's own reference: with the claim, what the attention item leaves out
           (coalesce(p.sender_reference, '') ~ '^NTMK' OR p.tracking_id ~ '^NTMK') AS ntmk
    FROM public.mex_parcels p, win w
    WHERE p.order_id IS NULL AND p.status_id = 2
      AND (p.delivered_at BETWEEN w.w0 AND w.t OR p.created_at_mex BETWEEN w.w0 AND w.t)
      AND NOT public.insights_excluded8(p.phone8, $12::text[])
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
  FROM f WHERE f.in_cur AND f.src IN ('elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web')
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
    ('teleshop_out', 'teleshop_out', 1), ('teleshop_out', 'mex_only_unlinked', 9),
    ('teleshop_other', 'teleshop', 1), ('teleshop_other', 'leads', 3),
    ('teleshop_other', 'leads_out', 4), ('teleshop_other', 'mex_only_unlinked', 9),
    ('social', 'social', 1), ('social', 'mex_only_unlinked', 9),
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
      -- a split is ONE (sale_source, detail) inside ONE department, and a CRM-made
      -- sale can sit in four departments (by its parcel's series, 20260942001000):
      -- cohort_source names the department (GET /orders ANDs the three)
      'drill', CASE
                 WHEN x.k IN ('mex_only', 'mex_only_unlinked', 'new', 'returning', 'shop') THEN NULL
                 WHEN x.src = 'web' THEN
                   CASE WHEN x.sale_source IS NOT NULL
                        THEN jsonb_build_object('sale_source', jsonb_build_array(x.sale_source), 'detail', jsonb_build_array(x.k)) END
                 ELSE jsonb_build_object(
                   'sale_source',   jsonb_build_array(coalesce(x.sale_source,
                                      CASE x.src WHEN 'elyon_crm' THEN 'elyon_crm' WHEN 'altercpa' THEN 'altercpa' ELSE 'collabbox' END)),
                   'detail',        jsonb_build_array(x.k),
                   'cohort_source', jsonb_build_array(x.src))
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
      -- every source may hold parcels with no order now (by series, owner 28.09.2026)
      || jsonb_build_object('mex_only', jsonb_build_object('count', s.mo_coh_n, 'cod_mkd', round(s.mo_coh_mkd))),
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
    -- a department is not a sale_source list (20260942001000): every sale_source its
    -- orders can have, and cohort_source (GET /orders ANDs the two) says which of them
    'drill', CASE s.src
               WHEN 'web' THEN jsonb_build_object('sale_source', jsonb_build_array('web'))
               ELSE jsonb_build_object(
                 'sale_source', CASE s.src
                                  WHEN 'altercpa'     THEN jsonb_build_array('altercpa', 'affiliate')
                                  WHEN 'elyon_crm'    THEN jsonb_build_array('elyon_crm', 'altercpa', 'affiliate')
                                  WHEN 'teleshop_out' THEN jsonb_build_array('collabbox', 'elyon_crm', 'altercpa', 'affiliate')
                                  WHEN 'social'       THEN jsonb_build_array('collabbox', 'elyon_crm', 'altercpa', 'affiliate')
                                  ELSE                     jsonb_build_array('collabbox', 'legacy', 'elyon_crm', 'altercpa', 'affiliate')
                                END,
                 'cohort_source', jsonb_build_array(s.src))
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
    -- a decision on a test-phone order is no work (the order is in no report)
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
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
-- mex-reconcile runs every 15 min inside 06:00–22:59 Skopje only (20260942001300), so
-- outside that window "fresh" means "the last run of the day happened".
fr_mex_expect AS (
  SELECT CASE WHEN l::time BETWEEN time '06:30' AND time '23:00' THEN now()
              WHEN l::time < time '06:30' THEN ((l::date - 1) + time '22:52') AT TIME ZONE 'Europe/Skopje'
              ELSE (l::date + time '22:52') AT TIME ZONE 'Europe/Skopje' END AS expected
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
       'detail', 'mex-reconcile every 15 min 06:00-22:59 (both accounts, one sweep); parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', m.last_status,
       'data_through', m.data_through)
     FROM fr_mex m, fr_mex_expect e WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'feed', 'mex_natura', 'last_ok_at', m.last_ok,
       'status', CASE WHEN m.last_ok IS NULL THEN 'failed'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN m.last_ok < e.expected - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'mex-reconcile every 15 min 06:00-22:59 (both accounts, one sweep); parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
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
anp AS (   -- AlterCPA sale, still no parcel N days after the sale ($13 =
           -- app_settings.no_parcel_rule.days, default 10), not postponed
  SELECT x.id, x.display_id, coalesce(x.price, 0) AS price,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at, x.sold_by_person_id
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source IN ('altercpa', 'affiliate')
    AND coalesce(x.sale_source_detail, '') <> 'team_prediction'   -- a CRM sale of an AlterCPA-team agent (20260942000700): not the rule's
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < now() - make_interval(days => $13::int)
    AND x.mex_tracking_id IS NULL
    AND (x.ship_after_date IS NULL OR x.ship_after_date <= (now() AT TIME ZONE 'Europe/Skopje')::date)
    AND x.id NOT IN (SELECT xto.id FROM xto)
),
mp AS (    -- the order's own parcel is Problematic / Delivery attempted / Rejected
  SELECT p.tracking_id, p.status_id, p.status_name, p.cod_mkd, p.last_update_at,
         x.display_id, coalesce(x.price, 0) AS price, x.sold_by_person_id
  FROM public.mex_parcels p JOIN public.orders x ON x.mex_tracking_id = p.tracking_id
  WHERE p.status_id IN (3, 9, 13) AND x.mex_status_id IN (3, 9, 13)
    AND x.id NOT IN (SELECT xto.id FROM xto)
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
  FROM mf m WHERE m.cash_cur AND NOT m.claimed AND NOT m.ntmk
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
    'days', $13::int,
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
        (v_to - v_from > interval '31 days'), v_claimed, v_waiting, v_excluded, v_np_days;

  RETURN v_out;
END;
$function$;

-- public.insights_parcel_rows(timestamp with time zone,timestamp with time zone,text) (1 call)
CREATE OR REPLACE FUNCTION public.insights_parcel_rows(p_from timestamp with time zone, p_to_end timestamp with time zone, p_event text)
 RETURNS TABLE(kind text, source text, split text, sale_source text, tracking_id text, account text, series text, status_id integer, outcome text, created_at_mex timestamp with time zone, delivered_at timestamp with time zone, returned_at timestamp with time zone, cod_mkd numeric, sale_at timestamp with time zone, order_id uuid, display_id text, web_id integer, phone8 text, receiver_city text, receiver_name text, person_id uuid, list_id uuid, list_name text, crm_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('created', 'delivered', 'returned', 'closed', 'problem_now', 'label_now') THEN
    RAISE EXCEPTION 'insights_parcel_rows: unknown event %', p_event USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_parcel_rows: bad window' USING ERRCODE = '22023';
  END IF;

  -- $1 from · $2 to_end · $3 event · $4 the test phones' last-8 digits
  RETURN QUERY EXECUTE $pr$
WITH
dp AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.sender_reference, p.cod_mkd,
         p.created_at_mex, p.delivered_at, p.returned_at, p.order_id, p.phone8,
         p.receiver_city, p.receiver_name
  FROM public.mex_parcels p
  WHERE (($3 = 'created' AND p.created_at_mex BETWEEN $1 AND $2)
      OR ($3 IN ('closed', 'returned') AND p.status_id = 7 AND p.returned_at BETWEEN $1 AND $2)
      OR ($3 IN ('closed', 'delivered') AND p.delivered_at BETWEEN $1 AND $2)
      OR ($3 = 'problem_now' AND p.status_id IN (3, 9, 13))
      OR ($3 = 'label_now' AND p.status_id = 8))
    AND NOT public.insights_excluded8(p.phone8, $4)
),
led AS MATERIALIZED (
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
wcl AS (
  SELECT DISTINCT ON (w.mex_tracking_id)
         w.mex_tracking_id AS tr, w.shop_order_id, w.order_number, w.created_at, w.payment_method, w.status,
         public.insights_excluded8(w.phone8, $4) AS test
  FROM public.web_orders w
  JOIN dp ON dp.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
  ORDER BY w.mex_tracking_id, w.created_at DESC, w.shop_order_id DESC
),
oh AS (
  SELECT x.id, x.display_id, x.sale_source, x.sale_source_detail, x.status::text AS status,
         x.sold_by_person_id, x.prediction_list_id, x.prediction_list_name, x.created_at,
         x.mex_tracking_id, x.customer_phone, x.dept_override,
         coalesce(x.sold_at, led.decided_at, x.confirmed_at, x.created_at) AS sale_at,
         public.insights_excluded8(public.insights_phone8(x.customer_phone), $4) AS test
  FROM public.orders x
  LEFT JOIN led ON led.order_id = x.id
  WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.id IN (SELECT y.id FROM public.orders y JOIN dp ON y.mex_tracking_id = dp.tracking_id
                 UNION ALL
                 SELECT dp.order_id FROM dp WHERE dp.order_id IS NOT NULL)
),
ocl AS (
  SELECT DISTINCT ON (oh.mex_tracking_id) oh.*
  FROM oh
  WHERE oh.mex_tracking_id IN (SELECT dp.tracking_id FROM dp)
  ORDER BY oh.mex_tracking_id, oh.test, oh.created_at, oh.id
)
SELECT CASE WHEN wcl.tr IS NOT NULL THEN 'web' WHEN ow.id IS NOT NULL THEN 'order' ELSE 'mex' END AS kind,
       CASE WHEN wcl.tr IS NOT NULL THEN 'web'
            WHEN ow.id IS NOT NULL THEN public.cohort_order_source(ow.sale_source, ow.sale_source_detail, ow.mex_tracking_id, ow.dept_override)
            ELSE public.cohort_parcel_source(public.cohort_parcel_split(dp.account, dp.series, dp.tracking_id, dp.sender_reference)) END AS source,
       CASE WHEN wcl.tr IS NOT NULL THEN CASE WHEN wcl.payment_method = 'CARD' THEN 'card' ELSE 'cod' END
            WHEN ow.id IS NOT NULL THEN coalesce(ow.sale_source_detail, 'none')
            ELSE public.cohort_parcel_split(dp.account, dp.series, dp.tracking_id, dp.sender_reference) END AS split,
       CASE WHEN wcl.tr IS NULL THEN ow.sale_source END AS sale_source,
       dp.tracking_id, dp.account, dp.series, dp.status_id,
       CASE WHEN dp.status_id = 7 THEN 'returned' WHEN dp.status_id = 2 THEN 'delivered'
            WHEN dp.status_id IN (3, 9, 13) THEN 'problem' WHEN dp.status_id = 8 THEN 'label'
            ELSE 'moving' END AS outcome,
       dp.created_at_mex, dp.delivered_at, dp.returned_at,
       dp.cod_mkd::numeric AS cod_mkd,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.created_at
            WHEN ow.id IS NOT NULL THEN ow.sale_at
            ELSE dp.created_at_mex END AS sale_at,
       CASE WHEN wcl.tr IS NULL THEN ow.id END AS order_id,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.order_number
            WHEN ow.id IS NOT NULL THEN ow.display_id
            ELSE dp.tracking_id END AS display_id,
       wcl.shop_order_id AS web_id,
       dp.phone8, dp.receiver_city, dp.receiver_name,
       CASE WHEN wcl.tr IS NULL THEN ow.sold_by_person_id END AS person_id,
       CASE WHEN wcl.tr IS NULL THEN ow.prediction_list_id END AS list_id,
       CASE WHEN wcl.tr IS NULL THEN ow.prediction_list_name END AS list_name,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.status ELSE ow.status END AS crm_status
FROM dp
LEFT JOIN wcl ON wcl.tr = dp.tracking_id
LEFT JOIN ocl ON ocl.mex_tracking_id = dp.tracking_id
LEFT JOIN LATERAL (
  SELECT oh.* FROM oh
  WHERE ocl.id IS NULL AND wcl.tr IS NULL AND dp.order_id IS NOT NULL AND oh.id = dp.order_id
  LIMIT 1
) olk ON true
CROSS JOIN LATERAL (
  SELECT CASE WHEN ocl.id IS NOT NULL THEN ocl.id ELSE olk.id END AS id,
         coalesce(ocl.display_id, olk.display_id) AS display_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sale_source ELSE olk.sale_source END AS sale_source,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sale_source_detail ELSE olk.sale_source_detail END AS sale_source_detail,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.mex_tracking_id ELSE olk.mex_tracking_id END AS mex_tracking_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.dept_override ELSE olk.dept_override END AS dept_override,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.status ELSE olk.status END AS status,
         coalesce(ocl.sale_at, olk.sale_at) AS sale_at,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sold_by_person_id ELSE olk.sold_by_person_id END AS sold_by_person_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.prediction_list_id ELSE olk.prediction_list_id END AS prediction_list_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.prediction_list_name ELSE olk.prediction_list_name END AS prediction_list_name,
         coalesce(ocl.test, olk.test, false) AS test
) ow
WHERE CASE WHEN wcl.tr IS NOT NULL THEN NOT wcl.test ELSE NOT ow.test END
  $pr$
  USING p_from, p_to_end, p_event, public.report_excluded_phone8s();
END;
$function$;

-- public.insights_pivot(text,text,text[]) (1 call)
CREATE OR REPLACE FUNCTION public.insights_pivot(p_from text, p_to_end text, p_by text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_by   text[];
  v_all  text[] := ARRAY['source', 'detail', 'team', 'person', 'list', 'webmaster', 'stream', 'product', 'city'];
  v_bad  text;
  v_out  jsonb;
  -- the owner's test phones (public.report_excluded_phones), read once ($4)
  v_x    text[] := public.report_excluded_phone8s();
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
         public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS source,
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
    -- a test-phone order, or one holding a test-phone parcel, is in no report
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4::text[])
    AND NOT coalesce(x.mex_tracking_id IN (SELECT p.tracking_id FROM public.mex_parcels p
                                            WHERE p.phone8 = ANY ($4::text[])), false)
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
  USING v_from, v_to, v_by, v_x;

  RETURN v_out;
END;
$function$;

-- public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean) (2 calls)
CREATE OR REPLACE FUNCTION public.insights_profit(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'cohort'::text, p_granularity text DEFAULT NULL::text, p_detail boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- $1 from · $2 to_end · $3 granularity ('day' | 'month') · $4 detail
  v_head_cohort text := $hc$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE sale cohort (insights_sale_rows), each sale's group:
--   collected = paid (MEX delivered) + paid_legacy · returned · open (courier,
--   problem, label, to pack) · unproven (CRM paid, no parcel — never profit)
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.card_mkd, r.sale_day,
         r.order_id, r.web_id, r.tracking_id, r.q_shared_parcel,
         CASE WHEN r.bucket IN ('paid', 'paid_legacy') THEN 'collected'
              WHEN r.bucket = 'returned'               THEN 'returned'
              WHEN r.bucket = 'paid_unproven'          THEN 'unproven'
              WHEN r.in_total                          THEN 'open' END AS g
  FROM public.insights_sale_rows($1, $2, false) r
),
-- a parcel two orders share (owner-ruled accurate) is ONE parcel to MEX: each
-- holder carries 1/holders of it — counted over ALL its holders (the
-- foundation's rule: real, non-test orders), not only those in the window,
-- so any split of a window into pieces adds up to the same parcels
shp AS (
  SELECT x.mex_tracking_id AS tracking_id, count(*) AS c
  FROM public.orders x
  WHERE x.mex_tracking_id IN (SELECT sr.tracking_id FROM sr WHERE sr.q_shared_parcel AND sr.tracking_id IS NOT NULL)
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), (SELECT public.report_excluded_phone8s()))
  GROUP BY 1
),
s0 AS (
  SELECT sr.g, sr.source, sr.kind,
         coalesce(sr.value_mkd, 0)::float8 AS rev, coalesce(sr.card_mkd, 0)::float8 AS card,
         sr.sale_day AS day, sr.order_id, sr.web_id, sr.tracking_id,
         CASE WHEN shp.c > 1 THEN 1.0::float8 / shp.c ELSE 1.0::float8 END AS pw
  FROM sr LEFT JOIN shp ON shp.tracking_id = sr.tracking_id AND sr.q_shared_parcel
  WHERE sr.g IS NOT NULL
),
$hc$;
  v_head_cash text := $hh$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE cash flow (insights_cash_rows): every MEX parcel delivered in the
-- window, once, with its owner; revenue = COD + the card money of a
-- card-paid web order
s0 AS (
  SELECT 'collected'::text AS g, c.source, c.kind,
         (coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))::float8 AS rev,
         coalesce(c.card_mkd, 0)::float8 AS card,
         (c.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS day,
         c.order_id, c.web_id, c.tracking_id, 1.0::float8 AS pw
  FROM public.insights_cash_rows($1, $2) c
),
$hh$;
  v_common text := $cm$
s1 AS MATERIALIZED (
  SELECT row_number() OVER () AS sid, s0.*,
         to_char(date_trunc(prm.gran, s0.day::timestamp), prm.fmt) AS d
  FROM s0 CROSS JOIN prm
),
oid AS MATERIALIZED (SELECT DISTINCT s1.order_id AS id FROM s1 WHERE s1.order_id IS NOT NULL),
oi AS MATERIALIZED (
  SELECT i.order_id, i.product_id, i.product_name,
         coalesce(i.quantity, 0) AS qty,
         coalesce(i.price_per_unit, 0)::float8 AS ppu,
         coalesce(i.total_price, 0)::float8 AS tp
  FROM public.order_items i JOIN oid ON oid.id = i.order_id
),
oia AS (
  SELECT oi.order_id,
         sum((CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty) AS bonus_items
  FROM oi GROUP BY 1
),
-- index.ts orderPackageBonus(), unchanged: EUR per package by the line's
-- unit price (<25 → 1 · 25–35 → 2 · ≥35 → 3), only when status = 'paid';
-- an order with no lines prices its own quantity. The owner (ownerOf()
-- before normAgent) goes out raw: the api applies the agents-only gate.
ob AS MATERIALIZED (
  SELECT x.id, x.status::text AS status, x.sale_source, x.product_id, x.product_name,
         coalesce(x.confirmed_by_name, x.assigned_agent_name) AS owner_raw,
         nullif(btrim(x.cpa_webmaster_id), '') AS wm,
         (a.order_id IS NOT NULL) AS has_items,
         CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END AS oq,
         CASE WHEN x.status::text <> 'paid' THEN 0
              WHEN a.order_id IS NOT NULL THEN coalesce(a.bonus_items, 0)
              ELSE (CASE WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 > 25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)
         END::float8 AS bonus_eur
  FROM public.orders x
  JOIN oid ON oid.id = x.id
  LEFT JOIN oia a ON a.order_id = x.id
),
s AS MATERIALIZED (
  SELECT s1.*, ob.owner_raw, ob.status AS crm_status,
         CASE WHEN s1.source = 'altercpa' THEN coalesce(ob.wm, '__none__') END AS wm,
         coalesce(ob.bonus_eur, 0) AS bonus_eur
  FROM s1 LEFT JOIN ob ON ob.id = s1.order_id
),
-- every P&L sale's lines (collected + returned); a sale with none gets one
-- pseudo line so its revenue is never dropped
ln0 AS MATERIALIZED (
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_name AS name, oi.product_id AS pid, oi.qty,
         CASE WHEN oi.ppu > 0 THEN oi.ppu * greatest(oi.qty, 0) WHEN oi.tp > 0 THEN oi.tp ELSE 0 END::float8 AS w0,
         CASE WHEN ob.status = 'paid'
              THEN (CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty ELSE 0 END::float8 AS lb,
         NULL::text AS wkind
  FROM s JOIN ob ON ob.id = s.order_id JOIN oi ON oi.order_id = s.order_id
  WHERE s.g IN ('collected', 'returned')
  UNION ALL
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
         ob.product_name, ob.product_id, ob.oq, 1::float8, ob.bonus_eur, NULL
  FROM s JOIN ob ON ob.id = s.order_id
  WHERE s.g IN ('collected', 'returned') AND NOT ob.has_items
  UNION ALL
  -- web_order_items joined straight (its index), never through a CTE: the
  -- planner cannot size a CTE and loops over it once per web sale
  SELECT s.sid, 'web', wi.name, NULL::uuid, coalesce(wi.quantity, 0),
         CASE WHEN wi.kind = 'GIFT' THEN 0
              ELSE greatest(coalesce(wi.price, 0) * coalesce(wi.quantity, 0) - coalesce(wi.discount_allocated, 0), 0) END::float8,
         0::float8, wi.kind
  FROM s JOIN public.web_order_items wi ON wi.shop_order_id = s.web_id
  WHERE s.g IN ('collected', 'returned') AND s.kind = 'web'
  UNION ALL
  SELECT s.sid, CASE WHEN s.kind = 'mex' THEN 'mex' ELSE 'none' END, NULL, NULL, 0, 1::float8, 0::float8, NULL
  FROM s
  WHERE s.g IN ('collected', 'returned')
    AND (s.kind = 'mex'
         OR (s.kind = 'web' AND NOT EXISTS (SELECT 1 FROM public.web_order_items wi WHERE wi.shop_order_id = s.web_id)))
),
-- the catalogue by its folded name (product_alias_norm): an exact name match
-- (case / spaces ignored) IS that catalogue product; spelling variants still
-- wait for reviewed product_aliases rows
cat AS (
  SELECT DISTINCT ON (public.product_alias_norm(p.name))
         public.product_alias_norm(p.name) AS nn, p.id
  FROM public.products p
  WHERE public.product_alias_norm(p.name) IS NOT NULL
  ORDER BY public.product_alias_norm(p.name), (coalesce(p.cost_price, 0) > 0) DESC, p.is_active DESC, p.created_at, p.id
),
-- keys and kinds once per distinct line (product_key() is not inlinable)
lk AS MATERIALIZED (
  SELECT d.src, d.pk_name, d.pk_pid, k.key0, k.nn, k.rk
  FROM (SELECT DISTINCT ln0.src, ln0.name, ln0.pid,
               coalesce(ln0.name, '') AS pk_name, coalesce(ln0.pid::text, '') AS pk_pid
          FROM ln0 WHERE ln0.src IN ('crm', 'collabbox', 'web')) d
  CROSS JOIN LATERAL (
    SELECT public.product_key(d.src, d.name, d.pid) AS key0,
           public.product_alias_norm(d.name) AS nn,
           (SELECT a.kind FROM public.product_aliases a
             WHERE a.source IN (d.src, 'any') AND a.alias_norm = public.product_alias_norm(d.name)
             ORDER BY (a.source = d.src) DESC LIMIT 1) AS rk
  ) k
),
lk2 AS MATERIALIZED (
  SELECT lk.src, lk.pk_name, lk.pk_pid,
         CASE WHEN lk.key0 LIKE 'p:%' THEN lk.key0
              WHEN cat.id IS NOT NULL THEN 'p:' || cat.id::text
              ELSE coalesce(lk.key0, '__unknown__') END AS k,
         -- a reviewed alias decides; until then the obvious non-product lines
         -- of the collabBox / CRM imports are recognised by their name
         coalesce(lk.rk,
           CASE WHEN lk.nn ~ '^(поен|poen)'          THEN 'loyalty_point'
                WHEN lk.nn ~ '^(достав|dostav)'      THEN 'delivery'
                WHEN lk.nn ~ '^(забелешк|zabeles)'   THEN 'note'
                WHEN lk.nn ~ '^(флаер|flaer|flyer)'  THEN 'flyer' END) AS kind0,
         (lk.rk IS NOT NULL) AS reviewed
  FROM lk LEFT JOIN cat ON cat.nn = lk.nn AND lk.key0 NOT LIKE 'p:%'
),
-- a known cost is a catalogue cost_price > 0 (EUR) — never invented
kc AS (
  SELECT DISTINCT ON (k2.k) k2.k, CASE WHEN p.cost_price > 0 THEN p.cost_price::numeric END AS cost_eur, p.name AS pname
  FROM lk2 k2 JOIN public.products p ON k2.k = 'p:' || p.id::text
  ORDER BY k2.k
),
ln1 AS (
  SELECT ln0.sid, ln0.name, ln0.qty, ln0.w0, ln0.lb,
         CASE WHEN ln0.src = 'mex' THEN '__mex_only__' WHEN ln0.src = 'none' THEN '__unknown__'
              ELSE coalesce(k2.k, '__unknown__') END AS k,
         CASE WHEN ln0.src IN ('mex', 'none') THEN 'unknown'
              ELSE coalesce(k2.kind0, CASE WHEN ln0.wkind = 'GIFT' THEN 'gift' END, 'product') END AS kind,
         coalesce(k2.reviewed, false) AS reviewed,
         kc.cost_eur::float8 AS cost_eur, kc.pname
  FROM ln0
  LEFT JOIN lk2 k2 ON k2.src = ln0.src AND k2.pk_name = coalesce(ln0.name, '') AND k2.pk_pid = coalesce(ln0.pid::text, '')
  LEFT JOIN kc ON kc.k = k2.k
),
-- per sale: the weights its value is split by
ls AS (
  SELECT ln1.sid, sum(ln1.w0) AS sw,
         sum(CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty ELSE 0 END) AS sq,
         count(*) AS nl,
         count(*) FILTER (WHERE ln1.kind IN ('product', 'gift')) AS np
  FROM ln1 GROUP BY 1
),
ln AS (
  SELECT ln1.sid, ln1.k, ln1.kind, ln1.reviewed, (ln1.kind IN ('product', 'gift')) AS pkg,
         ln1.qty, ln1.lb, ln1.cost_eur,
         coalesce(ln1.pname, ln1.name) AS name,
         s.g, s.source, s.d, s.wm,
         -- the sale's value by price weight; all-zero prices → by packages
         s.rev * (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
                       WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
                       ELSE 1.0::float8 / ls.nl END) AS rv,
         -- the sale's parcel by packages (courier share)
         s.pw * (CASE WHEN ls.np = 0 THEN 1.0::float8 / ls.nl
                      WHEN ln1.kind NOT IN ('product', 'gift') THEN 0
                      WHEN ls.sq > 0 THEN ln1.qty::float8 / ls.sq
                      ELSE 1.0::float8 / ls.np END) AS sh,
         (ln1.kind IN ('product', 'gift') AND ls.sw > 0 AND ln1.w0 = 0) AS free
  FROM ln1 JOIN ls ON ls.sid = ln1.sid JOIN s ON s.sid = ln1.sid
),
lm AS MATERIALIZED (     -- line measures (денари; cost EUR × 61,5)
  SELECT ln.*,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.rv ELSE 0 END AS rc,
         CASE WHEN (ln.pkg AND ln.cost_eur IS NULL) OR ln.kind = 'unknown' THEN ln.rv ELSE 0 END AS ru,
         CASE WHEN NOT ln.pkg AND ln.kind <> 'unknown' THEN ln.rv ELSE 0 END AS rn,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.cost_eur * ln.qty * 61.5 ELSE 0 END AS cm,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.qty ELSE 0 END AS pc,
         CASE WHEN ln.pkg AND ln.cost_eur IS NULL THEN ln.qty ELSE 0 END AS pu,
         CASE WHEN ln.free THEN ln.qty ELSE 0 END AS fr
  FROM ln
),
agg_s AS (    -- sale-level measures
  SELECT s.g, s.source, s.d, s.wm, count(*) AS n, sum(s.rev) AS rev, sum(s.card) AS card, sum(s.pw) AS pw
  FROM s GROUP BY GROUPING SETS ((s.g, s.source), (s.g, s.d), (s.g, s.wm))
),
agg_l AS (    -- line measures on the same grains
  SELECT lm.g, lm.source, lm.d, lm.wm,
         sum(lm.rc) AS rc, sum(lm.ru) AS ru, sum(lm.rn) AS rn, sum(lm.cm) AS cm,
         sum(lm.pc) AS pc, sum(lm.pu) AS pu, sum(lm.fr) AS fr, sum(lm.lb) AS lb
  FROM lm GROUP BY GROUPING SETS ((lm.g, lm.source), (lm.g, lm.d), (lm.g, lm.wm))
),
agg AS (
  SELECT a.g,
         CASE WHEN a.source IS NOT NULL THEN 's' WHEN a.d IS NOT NULL THEN 'd' ELSE 'w' END AS dim,
         coalesce(a.source, a.d, a.wm) AS key,
         -- 9 decimals: a month-by-month cache adds up to the whole window exactly once rounded to denars
         a.n, round(a.rev::numeric, 9) AS rev, round(a.card::numeric, 9) AS card, round(a.pw::numeric, 9) AS pw,
         round(coalesce(l.rc, 0)::numeric, 9) AS rc, round(coalesce(l.ru, 0)::numeric, 9) AS ru, round(coalesce(l.rn, 0)::numeric, 9) AS rn,
         round(coalesce(l.cm, 0)::numeric, 9) AS cm, coalesce(l.pc, 0) AS pc, coalesce(l.pu, 0) AS pu,
         coalesce(l.fr, 0) AS fr, coalesce(l.lb, 0)::numeric AS lb
  FROM agg_s a
  LEFT JOIN agg_l l ON l.g = a.g
       AND coalesce(l.source, '') = coalesce(a.source, '') AND coalesce(l.d, '') = coalesce(a.d, '')
       AND coalesce(l.wm, '') = coalesce(a.wm, '')
  WHERE a.source IS NOT NULL OR a.d IS NOT NULL OR a.wm IS NOT NULL
),
comm AS (     -- today's per-package bonus of every paid order, at owner grain
  SELECT s.source, s.d, s.wm, s.owner_raw, sum(s.bonus_eur)::numeric AS b, count(*) AS n
  FROM s WHERE s.g = 'collected' AND s.bonus_eur > 0
  GROUP BY GROUPING SETS ((s.source, s.owner_raw), (s.d, s.owner_raw), (s.wm, s.owner_raw))
),
wmn AS (
  SELECT DISTINCT ON (w.wm_id) w.wm_id, w.name
  FROM public.altercpa_webmasters w
  WHERE nullif(btrim(w.name), '') IS NOT NULL
  ORDER BY w.wm_id, w.named_at DESC NULLS LAST, w.updated_at DESC
),
$cm$;
  v_tail_cohort text := $tc$
cb AS (       -- the cohort strip: Σ = insights_cohort, bucket by bucket
  SELECT sr.source AS s, sr.bucket AS b, count(*) AS n,
         round(coalesce(sum(sr.value_mkd), 0)) AS v,
         round(coalesce(sum(sr.cod_mkd), 0))   AS c,
         count(*) FILTER (WHERE sr.kind = 'order') AS no,
         count(*) FILTER (WHERE sr.kind = 'web')   AS nw,
         count(*) FILTER (WHERE sr.kind = 'mex')   AS nm
  FROM sr GROUP BY 1, 2
),
pn AS (       -- how many sales carry the product (a narrow hash, no DISTINCT sort)
  SELECT x.source, x.g, x.k, count(*) AS n
  FROM (SELECT lm.source, lm.g, lm.k, lm.sid FROM lm GROUP BY 1, 2, 3, 4) x
  GROUP BY 1, 2, 3
),
prod AS (     -- the product P&L (collected and returned), by source
  SELECT lm.source AS s, lm.g, lm.k,
         -- byte order (COLLATE "C"): the api folds pieces with the same rule
         min(lm.name COLLATE "C") AS name, min(lm.kind COLLATE "C") AS kind, bool_or(lm.reviewed) AS reviewed,
         bool_or(lm.pkg) AS pkg, max(lm.cost_eur) AS cost_eur, max(pn.n) AS n,
         sum(lm.qty) AS qty, sum(CASE WHEN lm.pkg THEN lm.qty ELSE 0 END) AS pkgs, sum(lm.fr) AS fr,
         round(sum(lm.rv)::numeric, 9) AS rev, round(sum(lm.cm)::numeric, 9) AS cm,
         round(sum(lm.sh)::numeric, 9) AS sh, sum(lm.lb)::numeric AS lb
  FROM lm JOIN pn ON pn.source = lm.source AND pn.g = lm.g AND pn.k = lm.k
  GROUP BY 1, 2, 3
),
pd AS (       -- realized денари per paid package (collected, real products), binned to the denar
  SELECT lm.source AS s, round(lm.rv / lm.qty)::int AS u, sum(lm.qty) AS q, sum(lm.rv) AS v
  FROM lm
  WHERE lm.g = 'collected' AND lm.pkg AND NOT lm.free AND lm.qty > 0 AND lm.rv > 0
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'clock', 'cohort',
  'granularity', (SELECT gran FROM prm),
  'strip', coalesce((SELECT jsonb_agg(to_jsonb(cb) ORDER BY cb.s, cb.b) FROM cb), '[]'::jsonb),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'products', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(to_jsonb(prod) ORDER BY prod.rev DESC, prod.k) FROM prod), '[]'::jsonb) END,
  'hist', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(jsonb_build_object('s', pd.s, 'u', pd.u, 'q', pd.q, 'v', round(pd.v::numeric, 9))) FROM pd), '[]'::jsonb) END,
  'no_items', (SELECT jsonb_build_object('n', count(*), 'v', round(coalesce(sum(s.rev), 0)))
                 FROM s JOIN ob ON ob.id = s.order_id
                WHERE s.g = 'collected' AND NOT ob.has_items)
)
$tc$;
  v_tail_cash text := $th$
xp AS MATERIALIZED (SELECT public.report_excluded_phone8s() AS l),
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
rp AS (       -- parcels MEX returned in the window, owned as a sale is (web claim → order → MEX-only)
  SELECT p.tracking_id,
         to_char(date_trunc(prm.gran, (p.returned_at AT TIME ZONE 'Europe/Skopje')::date::timestamp), prm.fmt) AS d,
         CASE WHEN EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id) THEN 'web'
              ELSE coalesce(
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE x.mex_tracking_id = p.tracking_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                  ORDER BY x.created_at, x.id LIMIT 1),
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE p.order_id IS NOT NULL AND x.id = p.order_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'),
                public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference))) END AS source
  FROM public.mex_parcels p CROSS JOIN prm CROSS JOIN xp
  WHERE p.returned_at BETWEEN prm.f AND prm.t
    AND NOT public.insights_excluded8(p.phone8, xp.l)
)
SELECT jsonb_build_object(
  'clock', 'cash',
  'granularity', (SELECT gran FROM prm),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'returned_parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('s', r.source, 'd', r.d, 'n', r.n))
           FROM (SELECT rp.source, rp.d, count(*) AS n FROM rp GROUP BY 1, 2) r), '[]'::jsonb)
)
$th$;
  v_gran text;
  v_days integer;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_profit: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'cohort') NOT IN ('cohort', 'cash') THEN
    RAISE EXCEPTION 'insights_profit: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- daily up to 62 Skopje days, monthly beyond (as insights_cohort's spark);
  -- a caller that splits a window passes the whole window's granularity
  v_days := (p_to_end AT TIME ZONE 'Europe/Skopje')::date - (p_from AT TIME ZONE 'Europe/Skopje')::date + 1;
  v_gran := CASE WHEN p_granularity IN ('day', 'month') THEN p_granularity
                 WHEN v_days <= 62 THEN 'day' ELSE 'month' END;

  IF coalesce(p_clock, 'cohort') = 'cohort' THEN
    EXECUTE v_head_cohort || v_common || v_tail_cohort INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  ELSE
    EXECUTE v_head_cash || v_common || v_tail_cash INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  END IF;
  RETURN v_out;
END;
$function$;

-- public.insights_returns(timestamp with time zone,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,text[],boolean) (1 call)
CREATE OR REPLACE FUNCTION public.insights_returns(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'sale'::text, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_gran text;
  v_lo   timestamptz;
  v_rc   numeric;
  v_dc   numeric;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_returns: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'sale') NOT IN ('sale', 'returned') THEN
    RAISE EXCEPTION 'insights_returns: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- the comparison only for windows up to 93 days (a year's would double the scan)
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_returns: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));
  -- the MEX rate card (courier_rates, EUR; MEX is the only Macedonian carrier)
  SELECT max(r.return_cost), max(r.deliver_cost) INTO v_rc, v_dc
    FROM public.courier_rates r WHERE r.courier = 'mex';

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 clock · $11 MEX return cost (EUR) · $12 MEX delivery
  -- cost (EUR) · $13 the test phones' last-8 digits
  EXECUTE $rs$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $10::text AS clock,
         round(coalesce($11::numeric, 0) * 61.5) AS rc_mkd, round(coalesce($12::numeric, 0) * 61.5) AS dc_mkd
),
-- ── the rows: ONE shape for both clocks, materialised ONCE ─────────────────
-- Sale clock: the cohort itself (insights_sale_rows) — base = the period's
-- sales, returned = the cohort's "returned" bucket, so the tab ties to the
-- cohort by construction. MEX clock: every parcel that FINISHED in the window,
-- each once — delivered (by its delivery day) or returned (status 7, by its
-- return day); the base is what finished, the returned part ties to the
-- register. The register is joined by a HASH join on purpose: nearly every
-- sale has a parcel, one scan of mex_parcels beats one index probe per sale,
-- and the planner cannot see the function's real row count (the wrapped key
-- rules the probe out). Per-row facts of the current window (city, return
-- day, weekday, trend bucket) are computed here, once.
cx AS MATERIALIZED (
  SELECT u.*,
         CASE WHEN u.cur THEN
           coalesce(nullif(btrim(u.p_city), ''),
                    CASE WHEN u.kind = 'order' THEN (SELECT nullif(btrim(o.customer_city), '') FROM public.orders o WHERE o.id = u.order_id)
                         WHEN u.kind = 'web' THEN (SELECT nullif(btrim(w.city), '') FROM public.web_orders w WHERE w.shop_order_id = u.web_id) END)
         END AS city_raw,
         coalesce(u.p_ret_at,
                  CASE WHEN u.cur AND u.ret AND u.kind = 'order' THEN
                    (SELECT coalesce(o.mex_returned_at, o.returned_at) FROM public.orders o WHERE o.id = u.order_id) END) AS ret_at,
         extract(isodow FROM (u.sale_at AT TIME ZONE 'Europe/Skopje'))::int AS dow,
         to_char(date_trunc($9, (u.ev_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM (
    SELECT v.*,
           (v.ev_at BETWEEN $1 AND $2) AS cur,
           coalesce(v.ev_at BETWEEN $3 AND $4, false) AS prev,
           (v.bucket = 'returned') AS ret
    FROM (
      SELECT r.kind, r.source, r.split, r.sale_source, r.bucket, r.in_total,
             r.value_mkd, r.cod_mkd, r.sale_at, r.sale_at AS ev_at,
             r.person_id, r.list_id, r.list_name, r.order_id, r.web_id, r.tracking_id, r.phone8,
             r.mex_status_id, r.mex_account,
             p.receiver_city AS p_city, p.returned_at AS p_ret_at, p.created_at_mex AS parcel_at
      FROM public.insights_sale_rows($6, $2, false) r
      LEFT JOIN (SELECT m.tracking_id || '' AS tr, m.receiver_city, m.returned_at, m.created_at_mex
                   FROM public.mex_parcels m) p ON p.tr = r.tracking_id
      WHERE $10 = 'sale'
        AND r.source = ANY ($5)
        AND (r.in_total OR r.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
      UNION ALL
      SELECT q.kind, q.source, q.split, q.sale_source,
             CASE WHEN q.outcome = 'returned' THEN 'returned' ELSE 'paid' END,
             true,
             greatest(coalesce(q.cod_mkd, 0), 0), q.cod_mkd, q.sale_at,
             CASE WHEN q.outcome = 'returned' THEN q.returned_at ELSE q.delivered_at END,
             q.person_id, q.list_id, q.list_name, q.order_id, q.web_id, q.tracking_id, q.phone8,
             q.status_id, q.account,
             q.receiver_city, q.returned_at, q.created_at_mex
      FROM public.insights_parcel_rows($6, $2, 'closed') q
      WHERE $10 = 'returned'
        AND q.source = ANY ($5)
    ) v
  ) u
),
-- sold, then cancelled / trashed with no parcel — OUTSIDE the total. Sale
-- clock: the cohort's own rows. MEX clock: by the day of that decision.
ox AS MATERIALIZED (
  SELECT cx.source, cx.bucket, cx.value_mkd,
         (SELECT CASE WHEN cx.bucket = 'cancelled_after_sale' THEN o.cancellation_reason ELSE o.trash_reason END
            FROM public.orders o WHERE o.id = cx.order_id) AS reason
  FROM cx
  WHERE cx.cur AND cx.bucket IN ('cancelled_after_sale', 'trashed_after_sale')
  UNION ALL
  SELECT d.source, d.bucket, d.value_mkd, d.reason
  FROM (
    SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS source,
           public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                      x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                      x.mex_cod_mkd, x.mex_delivered_at,
                                      coalesce(x.mex_tracking_id IN (SELECT w.mex_tracking_id FROM public.web_orders w
                                                                     WHERE w.mex_tracking_id IS NOT NULL
                                                                       AND w.deleted_in_shop_at IS NULL), false)) AS bucket,
           round(coalesce(x.price, 0) * 61.5) AS value_mkd,
           CASE WHEN x.status = 'cancelled' THEN x.cancellation_reason ELSE x.trash_reason END AS reason
    FROM public.orders x
    WHERE $10 = 'returned'
      AND x.status IN ('cancelled', 'trashed')
      AND x.sold_at IS NOT NULL
      AND ((x.status = 'cancelled' AND x.cancelled_at BETWEEN $1 AND $2)
           OR (x.status = 'trashed' AND x.trashed_at BETWEEN $1 AND $2))
      AND x.sale_source_detail IS DISTINCT FROM 'disposition'
      AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $13)
  ) d
  WHERE d.bucket IN ('cancelled_after_sale', 'trashed_after_sale')
    AND d.source = ANY ($5)
),
-- ── KPIs (current + previous window, one pass) ─────────────────────────────
kp AS (
  SELECT
    count(*) FILTER (WHERE r.cur AND r.in_total)                                 AS base_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.in_total), 0)            AS base_v,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'order')            AS base_o,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'web')              AS base_w,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'mex')              AS base_m,
    count(*) FILTER (WHERE r.cur AND r.ret)                                      AS ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.ret), 0)                 AS ret_v,
    coalesce(sum(r.cod_mkd) FILTER (WHERE r.cur AND r.ret), 0)                   AS ret_c,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NOT NULL)        AS ret_parcels,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'order')                 AS ret_o,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'web')                   AS ret_w,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'mex')                   AS ret_m,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NULL)            AS crm_ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NULL), 0) AS crm_ret_v,
    count(*) FILTER (WHERE r.cur AND r.bucket IN ('paid', 'paid_legacy', 'paid_unproven'))  AS paid_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket IN ('paid', 'paid_legacy', 'paid_unproven')), 0) AS paid_v,
    count(*) FILTER (WHERE r.cur AND r.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')) AS open_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')), 0) AS open_v,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem')               AS prob_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket = 'courier_problem'), 0) AS prob_v,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 13) AS prob_13,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 9)  AS prob_9,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 3)  AS prob_3,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'order')     AS prob_o,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'web')       AS prob_w,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'mex')       AS prob_m,
    count(*) FILTER (WHERE r.prev AND r.in_total)                                AS p_base_n,
    count(*) FILTER (WHERE r.prev AND r.ret)                                     AS p_ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.prev AND r.ret), 0)                AS p_ret_v
  FROM cx r
),
oa AS (
  SELECT count(*) FILTER (WHERE ox.bucket = 'cancelled_after_sale')                    AS can_n,
         coalesce(sum(ox.value_mkd) FILTER (WHERE ox.bucket = 'cancelled_after_sale'), 0) AS can_v,
         count(*) FILTER (WHERE ox.bucket = 'trashed_after_sale')                      AS tr_n,
         coalesce(sum(ox.value_mkd) FILTER (WHERE ox.bucket = 'trashed_after_sale'), 0) AS tr_v
  FROM ox
),
-- at the courier with a problem NOW (any sale day): 13 Rejected stays at the
-- courier until MEX says 7 · 9 delivery attempted · 3 problematic
nw AS (
  SELECT count(*) FILTER (WHERE q.status_id = 13)                      AS n13,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 13), 0)   AS c13,
         count(*) FILTER (WHERE q.status_id = 9)                       AS n9,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 9), 0)    AS c9,
         count(*) FILTER (WHERE q.status_id = 3)                       AS n3,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 3), 0)    AS c3,
         min(q.created_at_mex)                                         AS oldest
  FROM public.insights_parcel_rows($1, $2, 'problem_now') q
  WHERE q.source = ANY ($5)
),
-- ── every breakdown in ONE pass (grouping sets) ────────────────────────────
-- cities: one key per place (mk_city_key — the MEX receiver city when a parcel)
ck AS MATERIALIZED (
  SELECT d.raw, public.mk_city_key(d.raw) AS k
  FROM (SELECT DISTINCT cx.city_raw AS raw FROM cx WHERE cx.cur AND cx.in_total AND cx.city_raw IS NOT NULL) d
),
ckn AS (                   -- a spelling to show for a place mk_settlements does not know
  SELECT ck.k, min(ck.raw) AS sample FROM ck WHERE ck.k IS NOT NULL GROUP BY ck.k
),
ga AS MATERIALIZED (
  SELECT CASE WHEN GROUPING(cx.split) = 0       THEN 'split'
              WHEN GROUPING(cx.source) = 0      THEN 'source'
              WHEN GROUPING(cx.mex_account) = 0 THEN 'account'
              WHEN GROUPING(ck.k) = 0           THEN 'city'
              WHEN GROUPING(cx.person_id) = 0   THEN 'person'
              WHEN GROUPING(cx.list_id) = 0     THEN 'list'
              WHEN GROUPING(cx.dow) = 0         THEN 'dow'
              ELSE 'day' END                                             AS dim,
         cx.source, cx.split, cx.kind, cx.mex_account, ck.k AS city, cx.person_id, cx.list_id, cx.dow, cx.d,
         count(*)                                                        AS base,
         coalesce(sum(cx.value_mkd), 0)                                  AS base_v,
         count(*) FILTER (WHERE cx.ret)                                  AS ret,
         coalesce(sum(cx.value_mkd) FILTER (WHERE cx.ret), 0)            AS ret_v,
         count(*) FILTER (WHERE cx.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')) AS open,
         count(*) FILTER (WHERE cx.kind = 'order')                       AS bo,
         count(*) FILTER (WHERE cx.kind = 'web')                         AS bw,
         count(*) FILTER (WHERE cx.kind = 'mex')                         AS bm,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'order')            AS ro,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'web')              AS rw,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'mex')              AS rm
  FROM cx
  LEFT JOIN ck ON ck.raw = cx.city_raw
  WHERE cx.cur AND cx.in_total
  GROUP BY GROUPING SETS ((cx.source), (cx.source, cx.split, cx.kind), (cx.mex_account), (ck.k),
                          (cx.person_id, cx.kind), (cx.list_id), (cx.dow), (cx.d))
),
bsrcj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', s.source,
           'base', s.base, 'base_value_mkd', round(s.base_v),
           'returned', s.ret, 'value_mkd', round(s.ret_v),
           'rate', CASE WHEN s.base > 0 THEN round(s.ret::numeric / s.base, 4) END,
           'open', s.open,
           'base_orders', s.bo, 'base_web', s.bw, 'base_mex_only', s.bm,
           'orders', s.ro, 'web', s.rw, 'mex_only', s.rm,
           'splits', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', x.split, 'kind', x.kind, 'base', x.base, 'returned', x.ret,
                      'value_mkd', round(x.ret_v),
                      'rate', CASE WHEN x.base > 0 THEN round(x.ret::numeric / x.base, 4) END)
                    ORDER BY x.base DESC, x.split)
             FROM ga x WHERE x.dim = 'split' AND x.source = s.source), '[]'::jsonb))
         ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'], s.source)), '[]'::jsonb) AS j
  FROM ga s
  WHERE s.dim = 'source'
),
bacc AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', coalesce(a.mex_account, '__none__'), 'base', a.base, 'returned', a.ret, 'value_mkd', round(a.ret_v),
           'rate', CASE WHEN a.base > 0 THEN round(a.ret::numeric / a.base, 4) END)
         ORDER BY a.base DESC), '[]'::jsonb) AS j
  FROM ga a WHERE a.dim = 'account'
),
crank AS (
  SELECT c.*, row_number() OVER (ORDER BY c.ret DESC, c.base DESC, c.city) AS rn
  FROM ga c WHERE c.dim = 'city' AND c.city IS NOT NULL
),
cname AS (
  SELECT DISTINCT ON (s.name_norm) s.name_norm, s.name, s.name_lat, s.name_sq
  FROM public.mk_settlements s
  WHERE s.name_norm IN (SELECT crank.city FROM crank WHERE crank.rn <= 15)
  ORDER BY s.name_norm, CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
),
bcity AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.city, 'name', coalesce(n.name, cs.sample), 'name_lat', coalesce(n.name_lat, cs.sample),
               'name_sq', coalesce(n.name_sq, n.name_lat, cs.sample),
               'base', c.base, 'returned', c.ret, 'value_mkd', round(c.ret_v),
               'rate', CASE WHEN c.base > 0 THEN round(c.ret::numeric / c.base, 4) END)
             ORDER BY c.rn)
      FROM crank c LEFT JOIN cname n ON n.name_norm = c.city LEFT JOIN ckn cs ON cs.k = c.city
      WHERE c.rn <= 15), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('places', count(*), 'base', coalesce(sum(c.base), 0), 'returned', coalesce(sum(c.ret), 0),
                                         'value_mkd', round(coalesce(sum(c.ret_v), 0)))
               FROM crank c WHERE c.rn > 15),
    'unknown', (SELECT jsonb_build_object('base', coalesce(sum(c.base), 0), 'returned', coalesce(sum(c.ret), 0),
                                          'value_mkd', round(coalesce(sum(c.ret_v), 0)))
                FROM ga c WHERE c.dim = 'city' AND c.city IS NULL),
    'places', (SELECT count(*) FROM crank)) AS j
),
-- sellers: orders only — web-shop orders and MEX-only parcels have none
prk AS (
  SELECT p.*, row_number() OVER (ORDER BY p.ret DESC, p.base DESC, p.person_id) AS rn
  FROM ga p WHERE p.dim = 'person' AND p.kind = 'order' AND p.person_id IS NOT NULL
),
bperson AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'person_id', x.person_id, 'name', sp.display_name, 'base', x.base, 'returned', x.ret,
               'value_mkd', round(x.ret_v), 'rate', CASE WHEN x.base > 0 THEN round(x.ret::numeric / x.base, 4) END)
             ORDER BY x.rn)
      FROM prk x LEFT JOIN public.sales_people sp ON sp.id = x.person_id
      WHERE x.rn <= 20), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('people', count(*), 'base', coalesce(sum(x.base), 0), 'returned', coalesce(sum(x.ret), 0),
                                         'value_mkd', round(coalesce(sum(x.ret_v), 0)))
               FROM prk x WHERE x.rn > 20),
    'none', (SELECT jsonb_build_object('base', coalesce(sum(p.base), 0), 'returned', coalesce(sum(p.ret), 0),
                                       'value_mkd', round(coalesce(sum(p.ret_v), 0)))
             FROM ga p WHERE p.dim = 'person' AND p.kind = 'order' AND p.person_id IS NULL)) AS j
),
blist AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.list_id, 'name', nm.list_name,
           'base', l.base, 'returned', l.ret, 'value_mkd', round(l.ret_v),
           'rate', CASE WHEN l.base > 0 THEN round(l.ret::numeric / l.base, 4) END)
         ORDER BY l.rn), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.ret DESC, g.base DESC, g.list_id) AS rn
        FROM ga g WHERE g.dim = 'list' AND g.list_id IS NOT NULL) l
  LEFT JOIN (SELECT cx.list_id, max(cx.list_name) AS list_name FROM cx
              WHERE cx.cur AND cx.list_id IS NOT NULL GROUP BY cx.list_id) nm ON nm.list_id = l.list_id
  WHERE l.rn <= 20
),
bdow AS (
  SELECT jsonb_agg(jsonb_build_object('dow', w.d, 'base', coalesce(a.base, 0), 'returned', coalesce(a.ret, 0),
                                      'rate', CASE WHEN coalesce(a.base, 0) > 0 THEN round(a.ret::numeric / a.base, 4) END)
                   ORDER BY w.d) AS j
  FROM generate_series(1, 7) w(d)
  LEFT JOIN ga a ON a.dim = 'dow' AND a.dow = w.d
),
-- the trend: per day (per month beyond 62 days) on the clock of the view
btrend AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d, 'base', coalesce(a.base, 0), 'returned', coalesce(a.ret, 0),
                                               'open', coalesce(a.open, 0), 'value_mkd', round(coalesce(a.ret_v, 0)))
                            ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN ga a ON a.dim = 'day' AND a.d = k.d
),
-- days from the sale to the return (MEX return day; CRM return day when no parcel)
dtr AS (
  SELECT extract(epoch FROM (cx.ret_at - cx.sale_at)) / 86400.0 AS ds,
         CASE WHEN cx.parcel_at IS NOT NULL THEN extract(epoch FROM (cx.ret_at - cx.parcel_at)) / 86400.0 END AS dc
  FROM cx WHERE cx.cur AND cx.ret AND cx.ret_at IS NOT NULL AND cx.sale_at IS NOT NULL
),
bdays AS (
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM dtr),
    'median_from_sale', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(dtr.ds, 0))::numeric, 1) FROM dtr),
    'median_at_courier', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(dtr.dc, 0))::numeric, 1) FROM dtr WHERE dtr.dc IS NOT NULL),
    'bins', (SELECT jsonb_agg(jsonb_build_object('key', b.key, 'count', coalesce(a.n, 0)) ORDER BY b.ord)
             FROM (VALUES ('0_3', 1), ('4_7', 2), ('8_14', 3), ('15_21', 4), ('22_30', 5), ('31_plus', 6)) b(key, ord)
             LEFT JOIN (
               SELECT CASE WHEN dtr.ds < 4 THEN '0_3' WHEN dtr.ds < 8 THEN '4_7' WHEN dtr.ds < 15 THEN '8_14'
                           WHEN dtr.ds < 22 THEN '15_21' WHEN dtr.ds < 31 THEN '22_30' ELSE '31_plus' END AS key,
                      count(*) AS n
               FROM dtr GROUP BY 1) a ON a.key = b.key)) AS j
),
-- products: the item lines (units) of the returned sales against the sold
-- units — orders' and web orders' lines; a MEX-only parcel carries no product
-- data (its own row). order_items is hash-joined for the reason given at `sr`.
ln AS MATERIALIZED (
  SELECT cx.ret, CASE WHEN cx.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM cx JOIN public.order_items i ON (i.order_id::text) = cx.order_id::text
  WHERE cx.cur AND cx.in_total AND cx.kind = 'order'
  UNION ALL
  SELECT cx.ret, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM cx JOIN public.web_order_items i ON i.shop_order_id = cx.web_id
  WHERE cx.cur AND cx.in_total AND cx.kind = 'web'
),
la AS MATERIALIZED (       -- folded per distinct line text first (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         sum(ln.q) AS q_all, coalesce(sum(ln.q) FILTER (WHERE ln.ret), 0) AS q_ret
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names (an unaliased line equal to ONE of them folds into it)
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (
  SELECT x.nm, x.q_all, x.q_ret,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
pagg AS (
  SELECT lk.key,
         coalesce(sum(lk.q_all) FILTER (WHERE lk.lkind = 'product'), 0) AS sold_u,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind = 'product'), 0) AS ret_u,
         coalesce(sum(lk.q_all) FILTER (WHERE lk.lkind = 'gift'), 0)    AS free_u,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind = 'gift'), 0)    AS free_ret_u,
         (array_agg(lk.nm ORDER BY lk.q_all DESC NULLS LAST))[1]        AS sample
  FROM lk WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
prank AS (
  SELECT p.*, row_number() OVER (ORDER BY p.ret_u DESC, p.sold_u DESC, p.key) AS rn
  FROM pagg p WHERE p.sold_u > 0 OR p.ret_u > 0
),
bprod AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', r.key, 'name', coalesce(pp.name, r.sample), 'catalogue', pp.id IS NOT NULL,
               'sold_units', r.sold_u, 'returned_units', r.ret_u, 'free_units', r.free_u, 'free_returned_units', r.free_ret_u,
               'rate', CASE WHEN r.sold_u > 0 THEN round(r.ret_u::numeric / r.sold_u, 4) END)
             ORDER BY r.rn)
      FROM prank r
      LEFT JOIN public.products pp ON r.key LIKE 'p:%' AND pp.id::text = substr(r.key, 3)
      WHERE r.rn <= 15), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('products', count(*), 'sold_units', coalesce(sum(r.sold_u), 0),
                                         'returned_units', coalesce(sum(r.ret_u), 0))
               FROM prank r WHERE r.rn > 15),
    'total', (SELECT jsonb_build_object('sold_units', coalesce(sum(p.sold_u), 0), 'returned_units', coalesce(sum(p.ret_u), 0),
                                        'free_units', coalesce(sum(p.free_u), 0), 'free_returned_units', coalesce(sum(p.free_ret_u), 0))
              FROM pagg p),
    'mex_only', (SELECT jsonb_build_object('base', count(*), 'returned', count(*) FILTER (WHERE cx.ret))
                 FROM cx WHERE cx.cur AND cx.in_total AND cx.kind = 'mex'),
    'not_products', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u) ORDER BY x.u DESC, x.lkind), '[]'::jsonb)
                     FROM (SELECT lk.lkind, sum(lk.q_all) AS u FROM lk WHERE lk.lkind NOT IN ('product', 'gift') GROUP BY 1) x)) AS j
),
-- why the sales cancelled / trashed after the sale were
breason AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'reason', x.reason, 'count', x.n, 'value_mkd', round(x.v))
                            ORDER BY x.n DESC, x.reason), '[]'::jsonb) AS j
  FROM (SELECT ox.bucket, coalesce(nullif(btrim(ox.reason), ''), '__unknown__') AS reason, count(*) AS n, sum(ox.value_mkd) AS v
        FROM ox GROUP BY 1, 2) x
),
-- the same phone returning again: phones with a return in this window and at
-- least two returned MEX parcels all time (the test phones are in no row)
rph AS (
  SELECT cx.phone8, count(*) AS in_window
  FROM cx WHERE cx.cur AND cx.ret AND cx.phone8 IS NOT NULL AND length(cx.phone8) = 8
  GROUP BY cx.phone8
),
rall AS MATERIALIZED (
  SELECT p.phone8, max(rph.in_window) AS in_window,
         count(*) FILTER (WHERE p.status_id = 7) AS ret_all,
         count(*) FILTER (WHERE p.status_id = 2) AS del_all,
         max(p.returned_at) AS last_ret,
         (array_agg(p.receiver_name ORDER BY p.created_at_mex DESC NULLS LAST))[1] AS name
  FROM rph
  JOIN public.mex_parcels p ON p.phone8 = rph.phone8
  GROUP BY p.phone8
  HAVING count(*) FILTER (WHERE p.status_id = 7) >= 2
),
brep AS (
  SELECT jsonb_build_object(
    'phones', (SELECT count(*) FROM rall),
    'returns_in_window', (SELECT coalesce(sum(rall.in_window), 0) FROM rall),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'phone8', x.phone8, 'name', x.name, 'returned_all', x.ret_all, 'delivered_all', x.del_all,
               'in_window', x.in_window, 'last_returned', to_char((x.last_ret AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
             ORDER BY x.rn)
      FROM (SELECT rall.*,
                   row_number() OVER (ORDER BY rall.ret_all DESC, rall.in_window DESC, rall.last_ret DESC, rall.phone8) AS rn
            FROM rall) x
      WHERE x.rn <= 20), '[]'::jsonb)) AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', prm.clock, 'granularity', prm.gran, 'money', true,
                             'sources', to_jsonb(prm.srcs)),
  'kpis', jsonb_build_object(
    'base', jsonb_build_object('count', kp.base_n, 'value_mkd', round(kp.base_v),
                               'orders', kp.base_o, 'web', kp.base_w, 'mex_only', kp.base_m),
    'returned', jsonb_build_object('count', kp.ret_n, 'value_mkd', round(kp.ret_v), 'cod_mkd', round(kp.ret_c),
                                   'parcels', kp.ret_parcels, 'orders', kp.ret_o, 'web', kp.ret_w, 'mex_only', kp.ret_m),
    'rate', CASE WHEN kp.base_n > 0 THEN round(kp.ret_n::numeric / kp.base_n, 4) END,
    'paid', jsonb_build_object('count', kp.paid_n, 'value_mkd', round(kp.paid_v)),
    'open', CASE WHEN prm.clock = 'sale' THEN jsonb_build_object('count', kp.open_n, 'value_mkd', round(kp.open_v),
                   'share', CASE WHEN kp.base_n > 0 THEN round(kp.open_n::numeric / kp.base_n, 4) END) END,
    'problem', CASE WHEN prm.clock = 'sale' THEN jsonb_build_object('count', kp.prob_n, 'value_mkd', round(kp.prob_v),
                   'rejected', kp.prob_13, 'attempted', kp.prob_9, 'problematic', kp.prob_3,
                   'orders', kp.prob_o, 'web', kp.prob_w, 'mex_only', kp.prob_m) END,
    'crm_only_returned', jsonb_build_object('count', kp.crm_ret_n, 'value_mkd', round(kp.crm_ret_v)),
    'cancelled_after_sale', jsonb_build_object('count', oa.can_n, 'value_mkd', round(oa.can_v)),
    'trashed_after_sale', jsonb_build_object('count', oa.tr_n, 'value_mkd', round(oa.tr_v)),
    'round_trip', jsonb_build_object('parcels', kp.ret_parcels,
                                     'return_cost_mkd', prm.rc_mkd, 'deliver_cost_mkd', prm.dc_mkd,
                                     'loss_mkd', kp.ret_parcels * prm.rc_mkd,
                                     'outbound_if_billed_mkd', kp.ret_parcels * prm.dc_mkd),
    'prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE jsonb_build_object(
              'base', kp.p_base_n, 'returned', kp.p_ret_n, 'value_mkd', round(kp.p_ret_v),
              'rate', CASE WHEN kp.p_base_n > 0 THEN round(kp.p_ret_n::numeric / kp.p_base_n, 4) END) END),
  'now', jsonb_build_object(
    'rejected', jsonb_build_object('count', nw.n13, 'value_mkd', round(nw.c13)),
    'attempted', jsonb_build_object('count', nw.n9, 'value_mkd', round(nw.c9)),
    'problematic', jsonb_build_object('count', nw.n3, 'value_mkd', round(nw.c3)),
    'oldest', to_char((nw.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD')),
  'by_source', (SELECT j FROM bsrcj),
  'by_account', (SELECT j FROM bacc),
  'by_product', (SELECT j FROM bprod),
  'by_city', (SELECT j FROM bcity),
  'by_person', (SELECT j FROM bperson),
  'by_list', (SELECT j FROM blist),
  'by_weekday', (SELECT j FROM bdow),
  'days_to_return', (SELECT j FROM bdays),
  'reasons', (SELECT j FROM breason),
  'repeat', (SELECT j FROM brep),
  'trend', (SELECT j FROM btrend))
FROM prm, kp, oa, nw
  $rs$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran, coalesce(p_clock, 'sale'),
        v_rc, v_dc, public.report_excluded_phone8s();

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

-- public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean) (1 call)
CREATE OR REPLACE FUNCTION public.insights_sale_rows(p_from timestamp with time zone, p_to_end timestamp with time zone, p_keys boolean DEFAULT true)
 RETURNS TABLE(kind text, source text, split text, sale_source text, sale_at timestamp with time zone, sale_day date, bucket text, in_total boolean, proven boolean, value_eur numeric, value_mkd numeric, cod_mkd numeric, cash_at timestamp with time zone, card_mkd numeric, person_id uuid, list_id uuid, list_name text, city_key text, product_key text, crm_status text, mex_status_id integer, mex_account text, mex_series text, q_cancelled_but_moving boolean, q_no_seller boolean, q_zero_cod boolean, q_no_price boolean, q_shared_parcel boolean, q_double_count boolean, order_id uuid, display_id text, web_id integer, tracking_id text, phone8 text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- ONE definition of the rows ($1 from · $2 to_end · $3 compute the keys ·
  -- $4 the excluded phones' last-8 digits); only the last step differs: with the keys it joins the city / product
  -- keys (computed once per distinct value), without them it streams `u`
  -- straight out (no second pass, no materialisation of 100k wide rows).
  v_rows text := $sr$
WITH
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win)
  SELECT DISTINCT w.mex_tracking_id AS tr
  FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels: counted nowhere, nor is
  SELECT p.tracking_id AS tr -- any order / web order that holds one
  FROM public.mex_parcels p
  WHERE p.phone8 = ANY ($4)
),
led AS MATERIALIZED (      -- AlterCPA approvals on orders that carry no sold_at
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
ob AS (
  SELECT x.id, x.display_id, x.status::text AS status, x.price, x.sale_source, x.sale_source_detail,
         x.sold_by_person_id, x.prediction_list_id, x.prediction_list_name,
         x.customer_city, x.product_id, x.product_name,
         public.insights_phone8(x.customer_phone) AS p8,
         x.mex_tracking_id, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at, x.mex_account, x.dept_override,
         z.sale_at, z.web_claimed,
         (x.mex_tracking_id IS NOT NULL
          AND (x.mex_status_id IS NOT NULL OR x.mex_delivered_at IS NOT NULL)
          AND NOT z.web_claimed) AS hp,
         public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                    x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                    x.mex_cod_mkd, x.mex_delivered_at, z.web_claimed) AS bucket
  FROM public.orders x
  LEFT JOIN led ON led.order_id = x.id
  CROSS JOIN LATERAL (
    -- the ledger date counts only for an order that has no sold_at (`led`
    -- holds only those); the web claim is a hashed probe into `wc`
    SELECT coalesce(x.sold_at, led.decided_at, x.confirmed_at, x.created_at) AS sale_at,
           coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false) AS web_claimed
  ) z
  -- A superset the indexes can answer (sold_at · confirmed_at of an unsold
  -- order · created_at · a ledger date in the window); the exact sale day
  -- is checked right after.
  WHERE (x.sold_at BETWEEN $1 AND $2
         OR (x.sold_at IS NULL AND x.confirmed_at BETWEEN $1 AND $2)
         OR x.created_at BETWEEN $1 AND $2
         OR x.id = ANY (ARRAY(SELECT led.order_id FROM led WHERE led.decided_at BETWEEN $1 AND $2)))
    AND z.sale_at BETWEEN $1 AND $2
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
),
-- SHARED PARCELS (owner 2026-09-28: both orders accurate). A tracking id two
-- or more real, non-test orders hold (a web-claimed one is no order's): each
-- holder's share of the ONE COD — by price, equal shares when no holder has a
-- price — and the first-created holder takes the rounding remainder, so the
-- shares add up to the COD to the denar and the parcel is counted once.
sh0 AS MATERIALIZED (
  SELECT x.mex_tracking_id AS tr
  FROM public.orders x
  WHERE x.mex_tracking_id IS NOT NULL
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
    AND x.mex_tracking_id NOT IN (SELECT wc.tr FROM wc)
    AND x.mex_tracking_id NOT IN (SELECT tp.tr FROM tp)
  GROUP BY x.mex_tracking_id
  HAVING count(*) > 1
),
shr AS MATERIALIZED (
  SELECT s.id,
         CASE WHEN s.rn = 1 THEN s.cod - (sum(s.part) OVER (PARTITION BY s.tr) - s.part)
              ELSE s.part END AS cod_share
  FROM (
    SELECT t.*, round(t.cod * t.frac) AS part
    FROM (
      SELECT x.id, x.mex_tracking_id AS tr,
             (max(x.mex_cod_mkd) OVER w)::numeric AS cod,
             row_number() OVER (PARTITION BY x.mex_tracking_id ORDER BY x.created_at, x.id) AS rn,
             CASE WHEN sum(greatest(x.price, 0)) OVER w > 0
                  THEN greatest(x.price, 0) / sum(greatest(x.price, 0)) OVER w
                  ELSE 1.0 / count(*) OVER w END AS frac
      FROM public.orders x
      JOIN sh0 ON sh0.tr = x.mex_tracking_id
      WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
        AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
      WINDOW w AS (PARTITION BY x.mex_tracking_id)
    ) t
  ) s
),
o AS (
  SELECT 'order'::text AS kind,
         -- the department (20260942001000): a CRM-made sale shipped on a NATURA
         -- teleshop / social series is that department's
         public.cohort_order_source(ob.sale_source, ob.sale_source_detail, ob.mex_tracking_id, ob.dept_override) AS source,
         coalesce(ob.sale_source_detail, 'none') AS split,
         ob.sale_source,
         ob.sale_at,
         ob.bucket,
         (ob.bucket = 'paid') AS proven,
         ob.price AS value_eur,
         CASE WHEN ob.bucket = 'replacement' THEN 0::numeric
              WHEN ob.hp AND sh.cod_share IS NOT NULL THEN sh.cod_share
              WHEN ob.hp AND ob.mex_cod_mkd IS NOT NULL THEN ob.mex_cod_mkd::numeric
              ELSE round(coalesce(ob.price, 0) * 61.5) END AS value_mkd,
         CASE WHEN ob.hp THEN coalesce(sh.cod_share, ob.mex_cod_mkd::numeric) END AS cod_mkd,
         -- orders.mex_delivered_at is the parcel's copy; read the register only
         -- when the copy is missing (a handful of drifted links)
         CASE WHEN ob.bucket = 'paid' THEN
           coalesce(ob.mex_delivered_at,
                    (SELECT p.delivered_at FROM public.mex_parcels p WHERE p.tracking_id = ob.mex_tracking_id)) END AS cash_at,
         NULL::numeric AS card_mkd,
         ob.sold_by_person_id AS person_id,
         ob.prediction_list_id AS list_id,
         ob.prediction_list_name AS list_name,
         -- the courier's address when there is a parcel (only read when the
         -- keys are asked for)
         coalesce(CASE WHEN $3 AND ob.hp THEN
                    (SELECT nullif(btrim(p.receiver_city), '') FROM public.mex_parcels p
                      WHERE p.tracking_id = ob.mex_tracking_id) END,
                  nullif(btrim(ob.customer_city), '')) AS city_raw,
         CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS product_src,
         ob.product_name AS product_raw,
         ob.product_id AS product_uuid,
         ob.status AS crm_status,
         CASE WHEN ob.hp THEN ob.mex_status_id END AS mex_status_id,
         CASE WHEN ob.hp THEN ob.mex_account END AS mex_account,
         -- mex_parcels.series, the same generated expression
         CASE WHEN ob.hp AND ob.mex_tracking_id ~ '^[0-9]{3}-[0-9]{4}-'
              THEN split_part(ob.mex_tracking_id, '-', 2) END AS mex_series,
         (ob.status IN ('cancelled', 'trashed') AND ob.bucket IN ('courier', 'courier_problem', 'label')) AS q_cancelled_but_moving,
         (ob.sold_by_person_id IS NULL AND public.cohort_in_total(ob.bucket)) AS q_no_seller,
         (ob.bucket = 'replacement' AND ob.hp) AS q_zero_cod,
         (coalesce(ob.price, 0) <= 0 AND public.cohort_in_total(ob.bucket)) AS q_no_price,
         (ob.hp AND sh.id IS NOT NULL) AS q_shared_parcel,
         false AS q_double_count,
         ob.id AS order_id,
         ob.display_id,
         NULL::integer AS web_id,
         CASE WHEN ob.hp THEN ob.mex_tracking_id END AS tracking_id,
         CASE WHEN length(ob.p8) = 8 THEN ob.p8 END AS phone8
  FROM ob
  LEFT JOIN shr sh ON sh.id = ob.id
  WHERE ob.bucket IS NOT NULL
),
-- The shop's classifier once per distinct (status, payment) — it carries a
-- SET clause, so it is never inlined and a per-row call costs ~10 µs.
wos AS MATERIALIZED (
  SELECT d.status, d.payment_status, d.payment_method,
         public.web_order_outcome(d.status, d.payment_status, d.payment_method) AS outcome
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method
          FROM public.web_orders w
         WHERE w.deleted_in_shop_at IS NULL
           AND w.created_at BETWEEN $1 AND $2) d
),
wo AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.status, w.payment_method, w.payment_status, w.total,
         w.city, w.phone8, w.is_legacy, w.created_at,
         wos.outcome,
         p.tracking_id AS p_tr, p.status_id AS p_st, p.cod_mkd AS p_cod, p.delivered_at AS p_deliv,
         p.receiver_city AS p_city, p.account AS p_account, p.series AS p_series
  FROM public.web_orders w
  JOIN wos ON wos.status = w.status AND wos.payment_status = w.payment_status
          AND wos.payment_method = w.payment_method
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(w.phone8, $4)
    AND NOT public.insights_excluded8(p.phone8, $4)
),
wb AS (
  SELECT wo.*, public.cohort_web_bucket(wo.outcome, wo.is_legacy, wo.total, wo.p_st, wo.p_tr IS NOT NULL) AS bucket
  FROM wo
),
wr AS (
  SELECT 'web'::text AS kind,
         'web'::text AS source,
         -- card money never passes through MEX (its COD is 0): its own split
         CASE WHEN wb.payment_method = 'CARD' THEN 'card' ELSE 'cod' END AS split,
         NULL::text AS sale_source,
         wb.created_at AS sale_at,
         wb.bucket,
         (wb.bucket = 'paid') AS proven,
         NULL::numeric AS value_eur,
         -- whole denari, as every other value: the parts add up to the denar
         CASE WHEN wb.bucket = 'replacement' THEN 0::numeric ELSE round(wb.total) END AS value_mkd,
         CASE WHEN wb.p_tr IS NOT NULL THEN wb.p_cod::numeric END AS cod_mkd,
         CASE WHEN wb.bucket = 'paid' THEN wb.p_deliv END AS cash_at,
         CASE WHEN wb.bucket = 'paid' AND wb.payment_method = 'CARD'
                   AND wb.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
              THEN greatest(round(wb.total) - coalesce(wb.p_cod, 0), 0) END AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         coalesce(nullif(btrim(wb.p_city), ''), nullif(btrim(wb.city), '')) AS city_raw,
         'web'::text AS product_src,
         CASE WHEN $3 THEN
           (SELECT i.name FROM public.web_order_items i
             WHERE i.shop_order_id = wb.shop_order_id AND i.kind = 'SALE'
             ORDER BY i.price * i.quantity DESC, i.shop_item_id
             LIMIT 1) END AS product_raw,
         NULL::uuid AS product_uuid,
         wb.status AS crm_status,
         wb.p_st AS mex_status_id,
         wb.p_account AS mex_account,
         wb.p_series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (wb.bucket = 'replacement' AND wb.p_tr IS NOT NULL) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         false AS q_double_count,
         NULL::uuid AS order_id,
         wb.order_number AS display_id,
         wb.shop_order_id AS web_id,
         wb.p_tr AS tracking_id,
         wb.phone8
  FROM wb
  WHERE wb.bucket IS NOT NULL
),
mo AS MATERIALIZED (       -- MEX-only: no live web order, no real order holds it
  -- (a parcel a TEST order holds is that order's: counted nowhere either)
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.receiver_city, p.phone8,
         public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference) AS split
  FROM public.mex_parcels p
  WHERE p.created_at_mex BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(p.phone8, $4)
    AND NOT EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id)
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.mex_tracking_id = p.tracking_id
                       AND x.sale_source_detail IS DISTINCT FROM 'disposition')
    AND (p.order_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.orders x
                         WHERE x.id = p.order_id
                           AND x.sale_source_detail IS DISTINCT FROM 'disposition'))
),
-- CRM sales with no parcel, by phone: a MEX-only parcel on one of these phones
-- within ±21 days may be the same sale (quality item; never auto-merged).
-- The phone expression is character-for-character idx_orders_phone_last8's.
cs AS MATERIALIZED (
  SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at
  FROM public.orders x
  WHERE x.mex_tracking_id IS NULL
    AND x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
    AND coalesce(x.price, 0) > 0
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.customer_phone IS NOT NULL
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at)
        BETWEEN $1 - interval '21 days' AND $2 + interval '21 days'
),
dbl AS MATERIALIZED (
  SELECT DISTINCT mo.tracking_id
  FROM mo
  JOIN cs ON cs.p8 = mo.phone8
         AND cs.at BETWEEN mo.created_at_mex - interval '21 days' AND mo.created_at_mex + interval '21 days'
  WHERE coalesce(mo.cod_mkd, 0) > 0
),
mr AS (
  SELECT 'mex'::text AS kind,
         public.cohort_parcel_source(mo.split) AS source, -- a parcel with no order: the source its series names
         mo.split,
         NULL::text AS sale_source,
         mo.created_at_mex AS sale_at,
         public.cohort_parcel_bucket(mo.status_id, mo.cod_mkd) AS bucket,
         (mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0) AS proven,
         NULL::numeric AS value_eur,
         CASE WHEN coalesce(mo.cod_mkd, 0) > 0 THEN mo.cod_mkd::numeric ELSE 0::numeric END AS value_mkd,
         mo.cod_mkd::numeric AS cod_mkd,
         CASE WHEN mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0 THEN mo.delivered_at END AS cash_at,
         NULL::numeric AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         nullif(btrim(mo.receiver_city), '') AS city_raw,
         'mex'::text AS product_src,
         NULL::text AS product_raw,
         NULL::uuid AS product_uuid,
         NULL::text AS crm_status,
         mo.status_id AS mex_status_id,
         mo.account AS mex_account,
         mo.series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (coalesce(mo.cod_mkd, 0) <= 0) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         (mo.tracking_id IN (SELECT dbl.tracking_id FROM dbl)) AS q_double_count,
         NULL::uuid AS order_id,
         mo.tracking_id AS display_id,
         NULL::integer AS web_id,
         mo.tracking_id,
         mo.phone8
  FROM mo
),
u AS (
  SELECT * FROM o
  UNION ALL SELECT * FROM wr
  UNION ALL SELECT * FROM mr
)
$sr$;
  v_keys text := $srk$,
ck AS (                    -- city keys, once per distinct raw city
  SELECT d.raw, public.mk_city_key(d.raw) AS k
  FROM (SELECT DISTINCT u.city_raw AS raw FROM u WHERE $3 AND u.city_raw IS NOT NULL) d
),
pk AS (                    -- product keys, once per distinct line
  SELECT d.src, d.raw_k, d.pid_k, public.product_key(d.src, d.raw, d.pid) AS k
  FROM (SELECT DISTINCT u.product_src AS src, u.product_raw AS raw, u.product_uuid AS pid,
               coalesce(u.product_raw, '') AS raw_k, coalesce(u.product_uuid::text, '') AS pid_k
        FROM u WHERE $3 AND (u.product_raw IS NOT NULL OR u.product_uuid IS NOT NULL)) d
)
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, ck.k AS city_key, pk.k AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
LEFT JOIN ck ON ck.raw = u.city_raw
LEFT JOIN pk ON pk.src = u.product_src
            AND pk.raw_k = coalesce(u.product_raw, '')
            AND pk.pid_k = coalesce(u.product_uuid::text, '')
$srk$;
  v_plain text := $srn$
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, NULL::text AS city_key, NULL::text AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
$srn$;
  v_excluded text[];
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sale_rows: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sale_rows: bad window' USING ERRCODE = '22023';
  END IF;

  -- the test phones: read once, a constant for the planner
  v_excluded := public.report_excluded_phone8s();
  IF coalesce(p_keys, true) THEN
    RETURN QUERY EXECUTE v_rows || v_keys USING p_from, p_to_end, true, v_excluded;
  ELSE
    RETURN QUERY EXECUTE v_rows || v_plain USING p_from, p_to_end, false, v_excluded;
  END IF;
END;
$function$;

-- public.insights_stock(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean) (2 calls)
CREATE OR REPLACE FUNCTION public.insights_stock(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_stock: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_stock: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 the test phones' last-8 digits · $11 today (Skopje)
  EXECUTE $st$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $11::date AS today,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- ── what moved: the cohort's sales (sale day), what came back (MEX return
-- day) and what waits in the warehouse NOW ─────────────────────────────────
sr AS MATERIALIZED (       -- the period's sales (+ the previous period's, for the movers)
  SELECT r.kind, r.source, r.sale_source, r.order_id, r.web_id,
         (r.sale_at BETWEEN $1 AND $2) AS cur,
         coalesce(r.sale_at BETWEEN $3 AND $4, false) AS prev,
         to_char(date_trunc($9, (r.sale_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM public.insights_sale_rows($6, $2, false) r
  WHERE r.in_total AND r.source = ANY ($5)
),
rt AS MATERIALIZED (       -- parcels MEX returned in the period (goods back on the shelf)
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id
  FROM public.insights_parcel_rows($1, $2, 'returned') q
  WHERE q.source = ANY ($5)
),
lb AS MATERIALIZED (       -- label printed, waiting for the courier NOW (MEX 8) — each parcel once
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id, q.sale_at, q.cod_mkd AS value_mkd
  FROM public.insights_parcel_rows($1, $2, 'label_now') q
  WHERE q.source = ANY ($5) AND coalesce(q.cod_mkd, 0) > 0
),
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win — the cohort's rule)
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($10)
),
tk AS MATERIALIZED (       -- to pack NOW: sold, no parcel yet (the cohort's to_pack bucket)
  SELECT 'order'::text AS kind, public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS source, x.sale_source,
         x.id AS order_id, NULL::integer AS web_id,
         coalesce(x.sold_at,
                  (SELECT max(l.decided_at) FROM public.altercpa_leads l
                    WHERE x.sold_at IS NULL AND l.order_id = x.id
                      AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL),
                  x.confirmed_at, x.created_at) AS sale_at,
         round(coalesce(x.price, 0) * 61.5) AS value_mkd
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                   x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                   x.mex_cod_mkd, x.mex_delivered_at,
                                   coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) = 'to_pack'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $10)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
    AND public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) = ANY ($5)
  UNION ALL
  SELECT 'web', 'web', NULL, NULL, w.shop_order_id, w.created_at, round(w.total)
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL
    AND w.mex_tracking_id IS NULL
    AND coalesce(w.total, 0) > 0
    AND w.created_at > $11::timestamp - interval '400 days'
    AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) = 'preparing'
    AND NOT public.insights_excluded8(w.phone8, $10)
    AND 'web' = ANY ($5)
),
qu AS (                    -- the queue: to pack + label printed, with the age of the sale
  SELECT x.*, ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) AS age,
         CASE WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 2 THEN '0_2'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 7 THEN '3_7'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 14 THEN '8_14'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 30 THEN '15_30'
              ELSE '31_plus' END AS age_key
  FROM (SELECT tk.*, 'to_pack'::text AS stage FROM tk
        UNION ALL
        SELECT lb.kind, lb.source, lb.sale_source, lb.order_id, lb.web_id, lb.sale_at, lb.value_mkd, 'label' FROM lb) x
),
-- ── every item line, once per (lset, flags) ─────────────────────────────────
-- lset: sold (cur / prev, day, source) · returned · to_pack · label. A line is
-- keyed by its text (src, product id, name, web kind, free, impossible qty).
ln AS MATERIALIZED (
  SELECT u.lset, u.cur, u.prev, u.d, u.source,
         CASE WHEN u.kind = 'web' THEN 'web' WHEN u.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.kind, sr.sale_source, sr.order_id FROM sr WHERE sr.kind = 'order'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.kind, rt.sale_source, rt.order_id FROM rt WHERE rt.kind = 'order'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.kind, qu.sale_source, qu.order_id FROM qu WHERE qu.kind = 'order') u
  -- a HASH join on purpose (all of a year's lines; see insights_returns)
  JOIN public.order_items i ON (i.order_id::text) = u.order_id::text
  UNION ALL
  SELECT u.lset, u.cur, u.prev, u.d, u.source, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.web_id FROM sr WHERE sr.kind = 'web'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.web_id FROM rt WHERE rt.kind = 'web'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.web_id FROM qu WHERE qu.kind = 'web') u
  JOIN public.web_order_items i ON i.shop_order_id = u.web_id
),
la AS MATERIALIZED (       -- folded per distinct line text (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur), 0)                              AS q_cur,
         count(*) FILTER (WHERE ln.lset = 'sold' AND ln.cur)                                            AS n_cur,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.prev), 0)                             AS q_prev,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'altercpa'), 0)   AS q_alt,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'elyon_crm'), 0)  AS q_ely,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_out'), 0) AS q_tout,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'web'), 0)        AS q_web,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_other'), 0) AS q_tel,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'social'), 0)     AS q_soc,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'returned'), 0)                                     AS q_ret,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'to_pack'), 0)                                      AS q_pack,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'label'), 0)                                        AS q_label
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names: an unaliased line equal to ONE of them folds into it
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (       -- each line text: its product key and kind, computed ONCE
  SELECT x.*,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
-- a line's kind by its text key, as ONE jsonb object (a lookup, not a join)
lmap AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(lk.lkey, lk.lkind), '{}'::jsonb) AS m FROM lk
),
pg AS MATERIALIZED (       -- per product key: products and gifts (the rest is not a product)
  SELECT lk.key,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'product'), 0)   AS units,
         coalesce(sum(lk.q_prev) FILTER (WHERE lk.lkind = 'product'), 0)  AS units_prev,
         coalesce(sum(lk.q_alt) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_alt,
         coalesce(sum(lk.q_ely) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_ely,
         coalesce(sum(lk.q_tout) FILTER (WHERE lk.lkind = 'product'), 0)  AS u_tout,
         coalesce(sum(lk.q_web) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_web,
         coalesce(sum(lk.q_tel) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_tel,
         coalesce(sum(lk.q_soc) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_soc,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'gift'), 0)      AS free_units,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)   AS returned_units,
         coalesce(sum(lk.q_pack) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)  AS pack_units,
         coalesce(sum(lk.q_label) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0) AS label_units,
         (array_agg(lk.nm ORDER BY lk.q_cur DESC NULLS LAST, lk.nm))[1]   AS sample
  FROM lk
  WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
-- ── the catalogue and its ledger ───────────────────────────────────────────
lgp AS (
  SELECT l.product_id, count(*) AS n_logs,
         count(*) FILTER (WHERE l.movement_type = 'manual_adjust' OR l.reason = 'manual') AS n_adjust,
         max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS counted_at,
         max(l.created_at) AS moved_at
  FROM public.inventory_logs l
  GROUP BY l.product_id
),
scl AS (                  -- products a stock count (попис) covered (20260942000100)
  SELECT l.product_id, max(c.counted_at) AS counted_at
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.count_id
  GROUP BY l.product_id
),
pc AS MATERIALIZED (
  SELECT p.id, p.name, p.sku, p.is_active, p.stock_quantity, p.low_stock_threshold, p.cost_price, p.price,
         (coalesce(g.n_logs, 0) > 0 OR coalesce(p.stock_quantity, 0) <> 0 OR s.product_id IS NOT NULL) AS tracked,
         (p.stock_quantity = 1000 AND g.n_logs = g.n_adjust AND g.n_adjust > 0 AND s.product_id IS NULL) AS placeholder,
         (coalesce(p.cost_price, 0) > 0) AS cost_known,
         greatest(g.counted_at, s.counted_at) AS counted_at, g.moved_at,
         -- a duplicate candidate key: the first word, transliterated (Adenofrin · ADENOFRIN 20/1 cps)
         CASE WHEN length(public.mk_geo_norm(split_part(btrim(p.name), ' ', 1))) >= 4
              THEN public.mk_geo_norm(split_part(btrim(p.name), ' ', 1)) END AS dup_key
  FROM public.products p
  LEFT JOIN lgp g ON g.product_id = p.id
  LEFT JOIN scl s ON s.product_id = p.id
),
lg AS (
  SELECT max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS last_count_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'restock' OR l.reason = 'restock')                                               AS last_restock_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'order_deduction' OR l.reason = 'order_deduction')                               AS last_deduction_at,
         max(l.created_at)                                                                                                                  AS last_move_at,
         coalesce(-sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount < 0), 0) AS out_window,
         coalesce(sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount > 0), 0)  AS in_window,
         count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2)                                                  AS moves_window
  FROM public.inventory_logs l
),
ps AS (                    -- MEX parcels created: in the period, and since the ledger's last deduction
  SELECT count(*) FILTER (WHERE p.created_at_mex BETWEEN $1 AND $2)                      AS in_window,
         count(*) FILTER (WHERE p.created_at_mex > coalesce(lg.last_deduction_at, '-infinity')) AS since_deduction,
         max(p.created_at_mex)                                                           AS last_parcel_at
  FROM lg
  JOIN public.mex_parcels p ON p.created_at_mex >= least($1, coalesce(lg.last_deduction_at, $1))
  WHERE NOT public.insights_excluded8(p.phone8, $10)
),
st AS (                    -- the stock regime (20260942000100): a count, and the MEX ledger on and running
  SELECT public.stock_ts((SELECT a.value #>> '{}' FROM public.app_settings a WHERE a.key = 'stock_counted_at')) AS counted_at,
         coalesce((SELECT a.value ->> 'enabled' FROM public.app_settings a WHERE a.key = 'stock_mex_movements'), 'false') = 'true' AS mex_enabled,
         public.stock_ts((SELECT a.value ->> 'from' FROM public.app_settings a WHERE a.key = 'stock_mex_movements')) AS mex_from,
         (SELECT max(r.finished_at) FROM public.stock_mex_runs r WHERE r.status = 'ok') AS mex_last_run
),
tr AS (                    -- is the stock count worth reading? counted, and the MEX ledger follows every parcel since
  SELECT (st.counted_at IS NOT NULL AND st.mex_enabled
          AND coalesce(st.mex_last_run >= now() - interval '3 hours', false)) AS trusted,
         lg.*, ps.in_window AS parcels_window, ps.since_deduction, ps.last_parcel_at,
         st.counted_at, st.mex_enabled, st.mex_from, st.mex_last_run
  FROM lg, ps, st
),
-- ── the product table ──────────────────────────────────────────────────────
pr0 AS (
  SELECT coalesce(g.key, 'p:' || c.id::text) AS key, c.id AS product_id,
         coalesce(c.name, g.sample) AS name, c.sku, c.is_active, (c.id IS NOT NULL) AS catalogue,
         coalesce(c.tracked, false) AS tracked, coalesce(c.placeholder, false) AS placeholder,
         CASE WHEN c.tracked THEN c.stock_quantity END AS on_hand,
         c.low_stock_threshold, c.cost_known, c.cost_price, c.price, c.counted_at,
         coalesce(g.units, 0) AS units, coalesce(g.units_prev, 0) AS units_prev,
         coalesce(g.u_alt, 0) AS u_alt, coalesce(g.u_ely, 0) AS u_ely, coalesce(g.u_tout, 0) AS u_tout,
         coalesce(g.u_web, 0) AS u_web, coalesce(g.u_tel, 0) AS u_tel, coalesce(g.u_soc, 0) AS u_soc,
         coalesce(g.free_units, 0) AS free_units, coalesce(g.returned_units, 0) AS returned_units,
         coalesce(g.pack_units, 0) AS pack_units, coalesce(g.label_units, 0) AS label_units
  FROM pg g
  -- every active catalogue product, plus any inactive one that still sold
  FULL JOIN (SELECT * FROM pc
              WHERE pc.is_active OR 'p:' || pc.id::text IN (SELECT pg.key FROM pg WHERE pg.key LIKE 'p:%')) c
         ON g.key = 'p:' || c.id::text
),
pr1 AS (
  SELECT pr0.*,
         CASE WHEN NOT pr0.catalogue THEN NULL
              WHEN NOT pr0.tracked THEN 'not_tracked'
              WHEN pr0.on_hand <= 0 THEN 'out'
              WHEN pr0.on_hand < coalesce(pr0.low_stock_threshold, 0) THEN 'low'
              ELSE 'ok' END AS state,
         row_number() OVER (ORDER BY pr0.units DESC, pr0.pack_units + pr0.label_units DESC, pr0.name) AS rn
  FROM pr0
),
prj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', p.key, 'product_id', p.product_id, 'name', p.name, 'sku', p.sku,
           'catalogue', p.catalogue, 'tracked', p.tracked, 'placeholder', p.placeholder, 'state', p.state,
           'on_hand', p.on_hand, 'low_threshold', p.low_stock_threshold, 'cost_known', p.cost_known,
           'units', p.units, 'units_prev', CASE WHEN tr0.pf IS NULL THEN NULL ELSE p.units_prev END,
           'by_source', jsonb_build_object('altercpa', p.u_alt, 'elyon_crm', p.u_ely, 'teleshop_out', p.u_tout,
                                           'web', p.u_web, 'teleshop_other', p.u_tel, 'social', p.u_soc),
           'free_units', p.free_units, 'returned_units', p.returned_units,
           'queue_units', p.pack_units + p.label_units, 'pack_units', p.pack_units, 'label_units', p.label_units,
           'days_cover', CASE WHEN tr0.trusted AND p.tracked AND p.units > 0 AND p.on_hand IS NOT NULL
                              THEN round(p.on_hand / (p.units::numeric / tr0.days), 1) END,
           'cost_mkd', CASE WHEN p.cost_known THEN round(p.cost_price * 61.5) END,
           'price_mkd', CASE WHEN p.price > 0 THEN round(p.price * 61.5) END,
           'stock_value_mkd', CASE WHEN tr0.trusted AND p.tracked AND p.cost_known AND p.on_hand > 0
                                   THEN round(p.on_hand * p.cost_price * 61.5) END)
         ORDER BY p.rn), '[]'::jsonb) AS j
  FROM pr1 p
  CROSS JOIN (SELECT tr.trusted, prm.pf, (prm.td - prm.fd + 1) AS days FROM tr, prm) tr0
  -- every catalogue product, and the rest (names not in the catalogue) up to 120 rows
  WHERE p.catalogue OR p.rn <= 120
),
prx AS (                   -- what the 120-row cut left out
  SELECT count(*) AS products, coalesce(sum(p.units), 0) AS units
  FROM pr1 p WHERE NOT p.catalogue AND p.rn > 120
),
-- ── KPIs ───────────────────────────────────────────────────────────────────
kp AS (
  SELECT (SELECT count(*) FROM sr WHERE sr.cur)                          AS sales,
         (SELECT count(*) FROM sr WHERE sr.cur AND sr.kind = 'mex')      AS sales_mex_only,
         (SELECT count(*) FROM sr WHERE sr.prev)                         AS sales_prev,
         (SELECT coalesce(sum(g.units), 0) FROM pg g)                    AS units,
         (SELECT coalesce(sum(g.units_prev), 0) FROM pg g)               AS units_prev,
         (SELECT coalesce(sum(g.free_units), 0) FROM pg g)               AS free_units,
         (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'p:%') AS units_catalogue,
         (SELECT count(*) FROM pg g WHERE g.units > 0)                   AS products_sold,
         (SELECT coalesce(sum(g.returned_units), 0) FROM pg g)           AS returned_units,
         (SELECT count(*) FROM rt)                                       AS returned_parcels,
         (SELECT count(*) FROM rt WHERE rt.kind = 'mex')                 AS returned_mex_only
),
-- ── the queue ──────────────────────────────────────────────────────────────
qa AS (
  SELECT qu.stage, qu.age_key, qu.source,
         count(*) AS n, coalesce(sum(qu.value_mkd), 0) AS v,
         count(*) FILTER (WHERE qu.kind = 'order') AS n_o, count(*) FILTER (WHERE qu.kind = 'web') AS n_w,
         count(*) FILTER (WHERE qu.kind = 'mex') AS n_m,
         min(qu.sale_at) AS oldest, max(qu.age) AS max_age, min(qu.age) AS min_age
  FROM qu
  GROUP BY GROUPING SETS ((qu.stage, qu.age_key), (qu.stage, qu.source), (qu.stage))
),
qj AS (
  SELECT jsonb_agg(jsonb_build_object(
           'stage', s.stage,
           'count', coalesce(t.n, 0), 'value_mkd', round(coalesce(t.v, 0)),
           'orders', coalesce(t.n_o, 0), 'web', coalesce(t.n_w, 0), 'mex_only', coalesce(t.n_m, 0),
           'oldest', to_char((t.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
           'units', (SELECT coalesce(sum(CASE WHEN s.stage = 'to_pack' THEN g.pack_units ELSE g.label_units END), 0) FROM pg g),
           'ages', (SELECT jsonb_agg(jsonb_build_object(
                             'key', a.key, 'count', coalesce(x.n, 0), 'value_mkd', round(coalesce(x.v, 0)),
                             'orders', coalesce(x.n_o, 0), 'web', coalesce(x.n_w, 0), 'mex_only', coalesce(x.n_m, 0),
                             -- the sale days this age covers (for the /orders drill)
                             'from', to_char(CASE WHEN a.hi IS NULL THEN ($11::date - coalesce(x.max_age, a.lo)) ELSE $11::date - a.hi END, 'YYYY-MM-DD'),
                             'to', to_char($11::date - a.lo, 'YYYY-MM-DD'))
                           ORDER BY a.ord)
                    FROM (VALUES ('0_2', 0, 2, 1), ('3_7', 3, 7, 2), ('8_14', 8, 14, 3), ('15_30', 15, 30, 4), ('31_plus', 31, NULL, 5)) a(key, lo, hi, ord)
                    LEFT JOIN qa x ON x.stage = s.stage AND x.age_key = a.key AND x.source IS NULL),
           'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n, 'value_mkd', round(x.v),
                                                                    'orders', x.n_o, 'web', x.n_w, 'mex_only', x.n_m,
                                                                    'oldest', to_char((x.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
                                                   ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'], x.source)), '[]'::jsonb)
                         FROM qa x WHERE x.stage = s.stage AND x.source IS NOT NULL AND x.age_key IS NULL))
         ORDER BY s.ord) AS j
  FROM (VALUES ('to_pack', 1), ('label', 2)) s(stage, ord)
  LEFT JOIN qa t ON t.stage = s.stage AND t.age_key IS NULL AND t.source IS NULL
),
-- the products waiting in the queue (units)
qp AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'name', coalesce(c.name, x.sample), 'catalogue', c.id IS NOT NULL,
                                               'pack_units', x.pack_units, 'label_units', x.label_units,
                                               'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END)
                            ORDER BY x.pack_units + x.label_units DESC, x.key), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.pack_units + g.label_units DESC, g.key) AS rn
          FROM pg g WHERE g.pack_units + g.label_units > 0) x
  LEFT JOIN pc c ON x.key = 'p:' || c.id::text
  WHERE x.rn <= 20
),
-- ── the trend: product units per day (per month beyond 62 days), by source ──
lt AS (
  SELECT ln.d, ln.source,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         sum(ln.q) AS q
  FROM ln WHERE ln.lset = 'sold' AND ln.cur
  GROUP BY 1, 2, 3
),
tv AS (
  SELECT lt.d,
         sum(lt.q) FILTER (WHERE lt.source = 'altercpa')       AS alt,
         sum(lt.q) FILTER (WHERE lt.source = 'elyon_crm')      AS ely,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_out')   AS tout,
         sum(lt.q) FILTER (WHERE lt.source = 'web')            AS web,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_other') AS tel,
         sum(lt.q) FILTER (WHERE lt.source = 'social')         AS soc
  FROM lt
  WHERE (SELECT lmap.m FROM lmap) ->> lt.lkey = 'product'
  GROUP BY lt.d
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d,
           'units', coalesce(tv.alt, 0) + coalesce(tv.ely, 0) + coalesce(tv.tout, 0) + coalesce(tv.web, 0)
                    + coalesce(tv.tel, 0) + coalesce(tv.soc, 0),
           'by_source', jsonb_build_object('altercpa', coalesce(tv.alt, 0), 'elyon_crm', coalesce(tv.ely, 0),
                                           'teleshop_out', coalesce(tv.tout, 0),
                                           'web', coalesce(tv.web, 0), 'teleshop_other', coalesce(tv.tel, 0), 'social', coalesce(tv.soc, 0)))
         ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN tv ON tv.d = k.d
),
-- ── catalogue hygiene ──────────────────────────────────────────────────────
hy AS (
  SELECT jsonb_build_object(
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('key', d.dup_key, 'products', d.products) ORDER BY d.units DESC, d.dup_key)
      FROM (SELECT c.dup_key, sum(coalesce(g.units, 0)) AS units,
                   jsonb_agg(jsonb_build_object('product_id', c.id, 'name', c.name, 'tracked', c.tracked,
                                                'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END,
                                                'units', coalesce(g.units, 0))
                             ORDER BY coalesce(g.units, 0) DESC, c.name) AS products
            FROM pc c LEFT JOIN pg g ON g.key = 'p:' || c.id::text
            WHERE c.is_active AND c.dup_key IS NOT NULL
            GROUP BY c.dup_key HAVING count(*) > 1) d), '[]'::jsonb),
    'unmapped', jsonb_build_object(
      'names', (SELECT count(*) FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'n:%'),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.sample, 'units', x.units) ORDER BY x.units DESC, x.sample)
                          FROM (SELECT g.sample, g.units FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0
                                 ORDER BY g.units DESC, g.sample LIMIT 25) x), '[]'::jsonb)),
    'no_cost', jsonb_build_object(
      'active', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.cost_known),
      'selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'units', x.units) ORDER BY x.units DESC, x.name)
                          FROM (SELECT c.id, c.name, g.units FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text
                                 WHERE NOT c.cost_known AND g.units > 0 ORDER BY g.units DESC, c.name LIMIT 15) x), '[]'::jsonb)),
    'not_products', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u, 'lines', x.n) ORDER BY x.u DESC)
                                FROM (SELECT lk.lkind, sum(lk.q_cur) AS u, sum(lk.n_cur) AS n FROM lk
                                       WHERE lk.lkind NOT IN ('product', 'gift') AND lk.n_cur > 0 GROUP BY 1) x), '[]'::jsonb),
    'not_tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.tracked),
    'placeholder', (SELECT count(*) FROM pc c WHERE c.is_active AND c.placeholder),
    'inactive_selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.is_active AND g.units > 0)) AS j
),
-- ── valuation (owners; only when the count can be trusted) ─────────────────
va AS (
  SELECT round(coalesce(sum(c.stock_quantity * c.cost_price) FILTER (WHERE c.cost_known AND c.stock_quantity > 0), 0) * 61.5) AS cost_v,
         round(coalesce(sum(c.stock_quantity * c.price) FILTER (WHERE c.price > 0 AND c.stock_quantity > 0), 0) * 61.5) AS price_v,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0), 0) AS units_on_hand,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0 AND c.cost_known), 0) AS units_costed
  FROM pc c WHERE c.is_active AND c.tracked
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', 'sale', 'granularity', prm.gran, 'money', true, 'sources', to_jsonb(prm.srcs),
                             'today', to_char(prm.today, 'YYYY-MM-DD')),
  'trust', jsonb_build_object(
    'trusted', tr.trusted,
    'last_count', to_char((greatest(tr.last_count_at, tr.counted_at) AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_restock', to_char((tr.last_restock_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_deduction', to_char((tr.last_deduction_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_movement', to_char((tr.last_move_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_parcel', to_char((tr.last_parcel_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'parcels_since_deduction', tr.since_deduction,
    'ledger_out_window', tr.out_window, 'ledger_in_window', tr.in_window, 'ledger_moves_window', tr.moves_window,
    'parcels_window', tr.parcels_window,
    'counted', tr.counted_at IS NOT NULL,
    'mex_enabled', tr.mex_enabled,
    'mex_from', to_char((tr.mex_from AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'mex_last_run', to_char(tr.mex_last_run AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD"T"HH24:MI')),
  'kpis', jsonb_build_object(
    'sales', kp.sales, 'sales_mex_only', kp.sales_mex_only,
    'units', kp.units, 'units_prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE kp.units_prev END,
    'free_units', kp.free_units, 'units_catalogue', kp.units_catalogue, 'products_sold', kp.products_sold,
    'returned_units', kp.returned_units, 'returned_parcels', kp.returned_parcels, 'returned_mex_only', kp.returned_mex_only,
    'tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked),
    'active', (SELECT count(*) FROM pc c WHERE c.is_active),
    'out', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity <= 0) END,
    'low', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity > 0
                                                                   AND c.stock_quantity < coalesce(c.low_stock_threshold, 0)) END),
  'queue', (SELECT j FROM qj),
  'queue_products', (SELECT j FROM qp),
  'products', (SELECT j FROM prj),
  'products_more', (SELECT jsonb_build_object('products', prx.products, 'units', prx.units) FROM prx),
  'trend', (SELECT j FROM tj),
  'hygiene', (SELECT j FROM hy),
  'valuation', CASE WHEN tr.trusted THEN (
    SELECT jsonb_build_object('cost_mkd', va.cost_v, 'price_mkd', va.price_v,
                              'coverage', CASE WHEN va.units_on_hand > 0 THEN round(va.units_costed::numeric / va.units_on_hand, 4) END)
    FROM va) END)
FROM prm, tr, kp
  $st$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran,
        public.report_excluded_phone8s(), (now() AT TIME ZONE 'Europe/Skopje')::date;

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(jsonb_set(v_out, '{valuation}', 'null'::jsonb));
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

-- public.leaderboard_day_v2(date,text,text) (1 call)
CREATE OR REPLACE FUNCTION public.leaderboard_day_v2(p_day date, p_department text DEFAULT NULL::text, p_team text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET jit TO 'off'
AS $function$
DECLARE
  v_day   date := coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_dept  text := nullif(btrim(coalesce(p_department, '')), '');
  v_team  text := nullif(btrim(coalesce(p_team, '')), '');
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF v_dept IS NOT NULL
     AND v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web') THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown department %', v_dept USING ERRCODE = '22023';
  END IF;
  IF v_team IS NOT NULL AND v_team <> 'none'
     AND NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = v_team) THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown team %', v_team USING ERRCODE = '22023';
  END IF;
  -- Skopje 00:00 of the day and the last microsecond before the next one
  -- (DST-exact: the timestamp is read as Europe/Skopje wall-clock time).
  v_from := v_day::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to   := ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';

  -- $1 from · $2 to_end · $3 day · $4 department · $5 team · $6 is today ·
  -- $7 the test phones' last-8 digits. Every use carries its cast, so
  -- scripts/verify-leaderboard-v2.mjs can run this body inline, read-only.
  EXECUTE $lb2$
WITH
-- ── the owner's test phones: in no report (orders holding one, or its parcel) ─
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($7::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($7::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),

-- ── 1. the work ledger of the day: every human decision, CRM + AlterCPA ────
-- dept = the decided order's department (THE mapping); an AlterCPA decision on
-- a lead with no order is Affiliate – Lead in.
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.order_id, v.outcome,
         CASE WHEN o.id IS NOT NULL
              THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
              WHEN v.via = 'altercpa' THEN 'altercpa' END AS dept,
         (o.id IS NOT NULL AND o.sale_source IS NULL) AS unclassified
  FROM public.v_sales_work v
  LEFT JOIN public.orders o ON o.id = v.order_id
  WHERE v.at BETWEEN $1::timestamptz AND $2::timestamptz
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
wk AS (
  SELECT vw.person_id,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.outcome = 'cancel')    AS cancel_d,
         count(*) FILTER (WHERE vw.outcome = 'trash')     AS trash_d,
         count(*) FILTER (WHERE vw.outcome = 'callback')  AS callback_d,
         max(vw.at)                                       AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),

-- ── 2. THE sale cohort of the day (insights_sale_rows — read, never copied) ─
sr AS MATERIALIZED (
  SELECT r.kind, r.source AS dept, r.sale_source, r.bucket, r.in_total, r.value_mkd, r.order_id
  FROM public.insights_sale_rows($1::timestamptz, $2::timestamptz, false) r
),
-- the ORDER sales of the day (+ the ones cancelled / trashed since) and who is
-- credited: the stamp; unstamped → the order's first 'sale' decision of the day
-- that names a person (leaderboard_day's live rule). Stamp or ledger, never both.
so AS MATERIALIZED (
  SELECT s.dept, s.sale_source, s.bucket, s.in_total, s.value_mkd, s.order_id,
         o.sold_at, o.sold_by_ext,
         CASE WHEN o.sold_at IS NOT NULL THEN o.sold_by_person_id
              ELSE (SELECT w.person_id FROM vw w
                     WHERE w.order_id = s.order_id AND w.outcome = 'sale' AND w.person_id IS NOT NULL
                     ORDER BY w.at LIMIT 1) END AS pid,
         (o.sold_at IS NULL) AS unstamped
  FROM sr s
  JOIN public.orders o ON o.id = s.order_id
  WHERE s.kind = 'order'
    AND (s.in_total OR s.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
),
-- why a sale has no seller (insights_people's reasons, 20260941000200)
nsr AS (
  SELECT so.dept, so.value_mkd,
         CASE WHEN so.sold_by_ext IS NOT NULL THEN 'unmapped'
              WHEN so.sold_at IS NULL AND ld.decision IN ('approved', 'cancel_other') THEN 'awaiting_stamp'
              WHEN so.sold_at IS NULL AND ld.decision IN ('cancelled', 'trashed') THEN 'altercpa_cancelled'
              ELSE 'no_decider' END AS reason
  FROM so
  LEFT JOIN LATERAL (
    SELECT l.decision FROM public.altercpa_leads l
     WHERE so.sold_by_ext IS NULL AND l.order_id = so.order_id
     ORDER BY l.decided_at DESC NULLS LAST, l.id
     LIMIT 1) ld ON true
  WHERE so.in_total AND so.pid IS NULL
),

-- ── 3. collabBox bookings no order holds yet (collabbox_booked_today) ──────
-- per person × type (two spellings of one author are one person)
bka AS (
  SELECT b.person_id, b.doc_type, sum(b.docs)::bigint AS docs, coalesce(sum(b.value_mkd), 0) AS value_mkd
  FROM public.collabbox_booked_today($3::date) b
  GROUP BY 1, 2
),
-- the same bookings one document at a time (collabbox_booked_today's own
-- filter), only to find the TWINS of an order-type booking: its customer's
-- CRM / AlterCPA SALE with no parcel of its own (the writer's
-- 'possible_twin_crm_sale' rule). day_totals.checks.bookings_filter_drift = 0
-- proves the two filters agree.
bkd AS MATERIALIZED (
  SELECT b.doc_number, b.doc_type_id, b.author_person_id, b.amount_mkd, b.doc_at, b.komitent_id
  FROM public.collabbox_documents b
  WHERE b.doc_at BETWEEN $1::timestamptz AND $2::timestamptz
    AND b.outcome IN ('booked', 'awaiting_parcel')
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.amount_mkd > 0
    AND b.doc_type_id IN ('10036', '10050', '10111', '10114', '10106')
    AND NOT EXISTS (SELECT 1 FROM public.orders o
                     WHERE o.external_source = 'collabbox' AND o.external_order_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p
                     WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL)
),
bkt AS (
  SELECT d.author_person_id AS person_id, d.doc_type_id AS doc_type,
         count(*)::bigint AS docs, coalesce(sum(d.amount_mkd), 0) AS value_mkd
  FROM bkd d
  CROSS JOIN LATERAL (
    -- the customer's phone: the komitent card, the teleshop registry, the
    -- document's own parcel, any stored card (collabbox_apply_one's order)
    SELECT coalesce(
             (SELECT c.phone8 FROM public.collabbox_customers c
               WHERE c.komitent_id = d.komitent_id AND c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'),
             (SELECT t.phone8 FROM public.teleshop_import_customers t
               WHERE t.komitent_id = d.komitent_id AND t.phone8 ~ '^[0-9]{8}$'),
             (SELECT p.phone8 FROM public.mex_parcels p
               WHERE p.tracking_id = d.doc_number AND p.phone8 ~ '^[0-9]{8}$'),
             (SELECT c.phone8 FROM public.collabbox_customers c
               WHERE c.komitent_id = d.komitent_id AND c.phone8 ~ '^[0-9]{8}$')) AS p8
  ) ph
  WHERE public.collabbox_doc_role(d.doc_type_id) = 'order'
    AND ph.p8 IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.orders o
       WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = ph.p8
         AND o.external_source IS DISTINCT FROM 'collabbox'
         AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         AND o.mex_tracking_id IS NULL
         AND o.price > 0
         AND NOT public.is_synthetic_product_name(o.product_name)
         AND o.sale_source_detail IS DISTINCT FROM 'disposition'
         AND o.created_at >= d.doc_at - interval '1 day'
         AND o.created_at <= d.doc_at + interval '2 days'
         AND (abs(round(o.price * 61.5) - d.amount_mkd) <= 3
              OR abs(round(o.price * 61.5) + 150 - d.amount_mkd) <= 3))
  GROUP BY 1, 2
),
-- counted (booked) vs not counted (booked_twin), per person × department
bkc AS (
  SELECT a.person_id, a.doc_type,
         public.cohort_order_source(dp.d[1], dp.d[2], NULL::text) AS dept,
         (dp.d IS NULL) AS no_dept,
         CASE WHEN rl.role = 'order' THEN a.docs - least(a.docs, coalesce(t.docs, 0)) ELSE 0 END AS booked,
         CASE WHEN rl.role = 'order' THEN greatest(a.value_mkd - coalesce(t.value_mkd, 0), 0) ELSE 0 END AS booked_mkd,
         CASE WHEN rl.role = 'order' THEN least(a.docs, coalesce(t.docs, 0)) ELSE a.docs END AS twin,
         CASE WHEN rl.role = 'order' THEN least(a.value_mkd, coalesce(t.value_mkd, 0)) ELSE a.value_mkd END AS twin_mkd,
         CASE WHEN rl.role = 'order' THEN 0 ELSE a.docs END AS twin_by_role
  FROM bka a
  CROSS JOIN LATERAL (SELECT public.collabbox_doc_role(a.doc_type) AS role) rl
  CROSS JOIN LATERAL (SELECT public.collabbox_department(a.doc_type, NULL::text, a.person_id, NULL::timestamptz) AS d) dp
  LEFT JOIN bkt t ON t.person_id IS NOT DISTINCT FROM a.person_id AND t.doc_type = a.doc_type
),

-- ── 4. person × department ─────────────────────────────────────────────────
pd AS MATERIALIZED (
  SELECT x.person_id, x.dept,
         sum(x.sales) AS sales, sum(x.value_mkd) AS value_mkd, sum(x.returned) AS returned,
         sum(x.cas) AS cas, sum(x.cas_mkd) AS cas_mkd, sum(x.live) AS live,
         sum(x.booked) AS booked, sum(x.booked_mkd) AS booked_mkd,
         sum(x.twin) AS twin, sum(x.twin_mkd) AS twin_mkd,
         sum(x.worked) AS worked, sum(x.sale_d) AS sale_d
  FROM (
    SELECT so.pid AS person_id, so.dept,
           CASE WHEN so.in_total THEN 1 ELSE 0 END AS sales,
           CASE WHEN so.in_total THEN so.value_mkd ELSE 0 END AS value_mkd,
           CASE WHEN so.in_total AND so.bucket = 'returned' THEN 1 ELSE 0 END AS returned,
           CASE WHEN so.in_total THEN 0 ELSE 1 END AS cas,
           CASE WHEN so.in_total THEN 0 ELSE so.value_mkd END AS cas_mkd,
           CASE WHEN so.in_total AND so.unstamped THEN 1 ELSE 0 END AS live,
           0 AS booked, 0 AS booked_mkd, 0 AS twin, 0 AS twin_mkd, 0 AS worked, 0 AS sale_d
      FROM so WHERE so.pid IS NOT NULL
    UNION ALL
    SELECT bkc.person_id, bkc.dept, 0, 0, 0, 0, 0, 0,
           bkc.booked, bkc.booked_mkd, bkc.twin, bkc.twin_mkd, 0, 0
      FROM bkc WHERE bkc.person_id IS NOT NULL
    UNION ALL
    SELECT vw.person_id, vw.dept, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
           1, CASE WHEN vw.outcome = 'sale' THEN 1 ELSE 0 END
      FROM vw WHERE vw.person_id IS NOT NULL AND vw.dept IS NOT NULL
  ) x
  GROUP BY 1, 2
),
-- a person's numbers: all departments (a) and the filter's department (f)
pa AS (
  SELECT pd.person_id,
         sum(pd.sales) AS sales, sum(pd.value_mkd) AS value_mkd, sum(pd.returned) AS returned,
         sum(pd.cas) AS cas, sum(pd.cas_mkd) AS cas_mkd, sum(pd.live) AS live,
         sum(pd.booked) AS booked, sum(pd.booked_mkd) AS booked_mkd,
         sum(pd.twin) AS twin, sum(pd.twin_mkd) AS twin_mkd,
         sum(pd.worked) AS worked,
         jsonb_object_agg(pd.dept, jsonb_build_object(
           'sales', pd.sales, 'value_mkd', round(pd.value_mkd),
           'booked', pd.booked, 'booked_value_mkd', round(pd.booked_mkd),
           'booked_twin', pd.twin, 'booked_twin_value_mkd', round(pd.twin_mkd),
           'cancelled_after_sale', pd.cas, 'cancelled_value_mkd', round(pd.cas_mkd),
           'returned', pd.returned, 'live_credited', pd.live,
           'worked', pd.worked, 'sale_decisions', pd.sale_d)) AS depts
  FROM pd
  WHERE pd.dept IS NOT NULL                       -- jsonb_object_agg refuses a NULL key
    AND ($4::text IS NULL OR pd.dept = $4::text)
  GROUP BY 1
),

-- ── 5. who is on the board ─────────────────────────────────────────────────
mem AS (
  SELECT DISTINCT m.person_id
  FROM public.sales_team_members m
  JOIN public.sales_people sp ON sp.id = m.person_id
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
    AND (sp.is_active OR m.valid_to IS NOT NULL)
),
pteam AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
pr AS MATERIALIZED (
  SELECT a.user_id, a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes,
         a.first_seen_at, a.last_seen_at, a.first_active_at, a.last_active_at, a.idle_alerts,
         a.last_state, a.idle_streak_started_at
  FROM public.agent_presence_days a
  WHERE a.day = $3::date
),
lg AS (
  SELECT u.user_id, min(u.at) AS first_login
  FROM (SELECT s.user_id, s.login_time AS at FROM public.shift_login_logs s WHERE s.shift_date = $3::date
        UNION ALL
        SELECT a.user_id, a.login_time FROM public.admin_login_logs a
         WHERE a.login_time BETWEEN $1::timestamptz AND $2::timestamptz) u
  WHERE u.user_id IS NOT NULL
  GROUP BY 1
),
ppl AS (
  SELECT mem.person_id FROM mem
  UNION SELECT pd.person_id FROM pd
  UNION SELECT sp.id FROM public.sales_people sp JOIN pr ON pr.user_id = sp.user_id
         WHERE coalesce(pr.online_minutes, 0) > 0
  UNION SELECT sp.id FROM public.sales_people sp JOIN lg ON lg.user_id = sp.user_id
),
r0 AS MATERIALIZED (
  SELECT p.person_id, sp.user_id,
         coalesce(sp.display_name, pf.full_name, 'Agent') AS name,
         pt.team_key, pt.team_name,
         EXISTS (SELECT 1 FROM mem WHERE mem.person_id = p.person_id) AS is_member,
         (coalesce(sp.is_manager, false)
          OR EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         CASE WHEN sp.user_id IS NULL THEN 'n/a'
              WHEN $6::boolean AND pr.last_state IN ('active', 'idle', 'break')
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN CASE pr.last_state WHEN 'active' THEN 'online' ELSE pr.last_state END
              ELSE 'offline' END AS state,
         pr.online_minutes, pr.active_minutes, pr.idle_minutes, pr.break_minutes,
         pr.first_seen_at, pr.last_seen_at, pr.first_active_at, pr.last_active_at, pr.idle_alerts,
         CASE WHEN $6::boolean AND pr.last_state = 'idle' AND pr.idle_streak_started_at IS NOT NULL
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN greatest(0, floor(extract(epoch FROM now() - pr.idle_streak_started_at) / 60))::int END AS idle_streak_min,
         lg.first_login,
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sale_d, 0) AS sale_d,
         coalesce(wk.cancel_d, 0) AS cancel_d, coalesce(wk.trash_d, 0) AS trash_d,
         coalesce(wk.callback_d, 0) AS callback_d, wk.last_at,
         coalesce(pa.sales, 0) AS f_sales, coalesce(pa.value_mkd, 0) AS f_value,
         coalesce(pa.returned, 0) AS f_ret, coalesce(pa.cas, 0) AS f_cas, coalesce(pa.cas_mkd, 0) AS f_cas_mkd,
         coalesce(pa.live, 0) AS f_live,
         coalesce(pa.booked, 0) AS f_booked, coalesce(pa.booked_mkd, 0) AS f_booked_mkd,
         coalesce(pa.twin, 0) AS f_twin, coalesce(pa.twin_mkd, 0) AS f_twin_mkd,
         coalesce(pa.sales, 0) + coalesce(pa.booked, 0) AS f_total,
         coalesce(pa.value_mkd, 0) + coalesce(pa.booked_mkd, 0) AS f_total_mkd,
         (coalesce(pa.sales, 0) + coalesce(pa.cas, 0) + coalesce(pa.booked, 0)
          + coalesce(pa.twin, 0) + coalesce(pa.worked, 0)) > 0 AS f_any,
         coalesce(pa.depts, '{}'::jsonb) AS depts
  FROM ppl p
  JOIN public.sales_people sp ON sp.id = p.person_id
  LEFT JOIN public.profiles pf ON pf.user_id = sp.user_id
  LEFT JOIN pteam pt ON pt.person_id = p.person_id
  LEFT JOIN pr ON pr.user_id = sp.user_id
  LEFT JOIN lg ON lg.user_id = sp.user_id
  LEFT JOIN wk ON wk.person_id = p.person_id
  LEFT JOIN pa ON pa.person_id = p.person_id
),
-- the filter: a department keeps the people with anything in it; a team keeps its badge holders
rf AS (
  SELECT r0.* FROM r0
  WHERE ($4::text IS NULL OR r0.f_any)
    AND ($5::text IS NULL OR coalesce(r0.team_key, 'none') = $5::text)
),
rk AS (
  SELECT rf.*,
         CASE WHEN NOT rf.is_manager AND rf.f_total > 0
              THEN rank() OVER (PARTITION BY (NOT rf.is_manager AND rf.f_total > 0)
                                ORDER BY rf.f_total_mkd DESC, rf.f_total DESC) END AS rnk,
         CASE rf.state WHEN 'online' THEN 0 WHEN 'idle' THEN 1 WHEN 'break' THEN 2 WHEN 'offline' THEN 3 ELSE 4 END AS st_ord
  FROM rf
),

-- ── 6. the whole day by department (never filtered) — the tie-out ──────────
dk AS (
  SELECT d.key, d.ord
  FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3),
               ('teleshop_other', 4), ('social', 5), ('web', 6)) d(key, ord)
),
sagg AS (
  SELECT so.dept,
         count(*) FILTER (WHERE so.in_total)                                        AS sales,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total), 0)                  AS value_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NOT NULL)                 AS credited,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NOT NULL), 0) AS credited_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NULL)                     AS no_seller,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NULL), 0) AS no_seller_mkd,
         count(*) FILTER (WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL) AS live,
         count(*) FILTER (WHERE NOT so.in_total)                                    AS cas,
         coalesce(sum(so.value_mkd) FILTER (WHERE NOT so.in_total), 0)              AS cas_mkd,
         count(*) FILTER (WHERE so.in_total AND so.sale_source IS NULL)             AS unclassified,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.sale_source IS NULL), 0) AS unclassified_mkd
  FROM so GROUP BY 1
),
oagg AS (   -- the cohort's sales no person can hold: the web shop and MEX parcels with no order
  SELECT sr.dept,
         count(*) FILTER (WHERE sr.kind = 'web')                           AS web,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'web'), 0)     AS web_mkd,
         count(*) FILTER (WHERE sr.kind = 'mex')                           AS mex_only,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'mex'), 0)     AS mex_only_mkd
  FROM sr WHERE sr.in_total AND sr.kind <> 'order' GROUP BY 1
),
bagg AS (
  SELECT bkc.dept,
         sum(bkc.booked)                                                   AS booked,
         sum(bkc.booked_mkd)                                               AS booked_mkd,
         coalesce(sum(bkc.booked) FILTER (WHERE bkc.person_id IS NULL), 0)     AS booked_no_person,
         coalesce(sum(bkc.booked_mkd) FILTER (WHERE bkc.person_id IS NULL), 0) AS booked_no_person_mkd,
         sum(bkc.twin)                                                     AS twin,
         sum(bkc.twin_mkd)                                                 AS twin_mkd,
         sum(bkc.twin_by_role)                                             AS twin_by_role
  FROM bkc GROUP BY 1
),
wagg AS (
  SELECT vw.dept,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.person_id IS NULL)     AS unmapped
  FROM vw GROUP BY 1
)
SELECT jsonb_build_object(
  'version', 2,
  'day', $3::date,
  'is_today', $6::boolean,
  'generated_at', now(),
  'window', jsonb_build_object('from', $1::timestamptz, 'to_end', $2::timestamptz),
  'filter', jsonb_build_object('department', $4::text, 'team', $5::text),
  'departments', (SELECT jsonb_agg(dk.key ORDER BY dk.ord) FROM dk),
  -- the teams on the (department-filtered) board, for the filter bar
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', t.k, 'name', t.nm, 'people', t.n)
                                      ORDER BY t.ord, t.k), '[]'::jsonb)
              FROM (SELECT coalesce(r0.team_key, 'none') AS k, max(r0.team_name) AS nm, count(*) AS n,
                           min(CASE coalesce(r0.team_key, 'none') WHEN 'altercpa_leads' THEN 1
                                    WHEN 'crm_prediction' THEN 2 WHEN 'management' THEN 8
                                    WHEN 'none' THEN 9 ELSE 5 END) AS ord
                      FROM r0 WHERE $4::text IS NULL OR r0.f_any
                     GROUP BY 1) t),
  -- the people shown (after the filters)
  'summary', (SELECT jsonb_build_object(
      'people',           count(*),
      'members',          count(*) FILTER (WHERE rk.is_member),
      'managers',         count(*) FILTER (WHERE rk.is_manager),
      'ranked',           count(*) FILTER (WHERE rk.rnk IS NOT NULL),
      'online_now',       count(*) FILTER (WHERE rk.state IN ('online', 'idle')),
      'idle',             count(*) FILTER (WHERE rk.state = 'idle'),
      'on_break',         count(*) FILTER (WHERE rk.state = 'break'),
      'offline',          count(*) FILTER (WHERE rk.state = 'offline'),
      'no_login',         count(*) FILTER (WHERE rk.state = 'n/a'),
      'was_online',       count(*) FILTER (WHERE coalesce(rk.online_minutes, 0) > 0),
      'zero_sale_people', count(*) FILTER (WHERE NOT rk.is_manager AND rk.f_total = 0),
      'worked',           coalesce(sum(rk.worked), 0),
      'sale_decisions',   coalesce(sum(rk.sale_d), 0),
      'sales',            coalesce(sum(rk.f_sales), 0),
      'value_mkd',        round(coalesce(sum(rk.f_value), 0)),
      'booked',           coalesce(sum(rk.f_booked), 0),
      'booked_value_mkd', round(coalesce(sum(rk.f_booked_mkd), 0)),
      'total_count',      coalesce(sum(rk.f_total), 0),
      'total_value_mkd',  round(coalesce(sum(rk.f_total_mkd), 0)),
      'cancelled_after_sale', coalesce(sum(rk.f_cas), 0),
      'returned',         coalesce(sum(rk.f_ret), 0),
      'live_credited',    coalesce(sum(rk.f_live), 0),
      'booked_twin',      coalesce(sum(rk.f_twin), 0),
      'booked_twin_value_mkd', round(coalesce(sum(rk.f_twin_mkd), 0)),
      -- the department's (or the day's) sales no person is credited with
      'no_seller',        (SELECT coalesce(sum(sagg.no_seller), 0) FROM sagg
                            WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'no_seller_value_mkd', (SELECT round(coalesce(sum(sagg.no_seller_mkd), 0)) FROM sagg
                               WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'booked_no_person', (SELECT coalesce(sum(bagg.booked_no_person), 0) FROM bagg
                            WHERE $4::text IS NULL OR bagg.dept = $4::text))
    FROM rk),
  'day_totals', jsonb_build_object(
    'by_department', (SELECT jsonb_object_agg(dk.key, jsonb_build_object(
        'sales',            coalesce(s.sales, 0),
        'value_mkd',        round(coalesce(s.value_mkd, 0)),
        'credited',         coalesce(s.credited, 0),
        'credited_value_mkd', round(coalesce(s.credited_mkd, 0)),
        'no_seller',        coalesce(s.no_seller, 0),
        'no_seller_value_mkd', round(coalesce(s.no_seller_mkd, 0)),
        'live_credited',    coalesce(s.live, 0),
        'cancelled_after_sale', coalesce(s.cas, 0),
        'cancelled_value_mkd', round(coalesce(s.cas_mkd, 0)),
        'booked',           coalesce(b.booked, 0),
        'booked_value_mkd', round(coalesce(b.booked_mkd, 0)),
        'booked_no_person', coalesce(b.booked_no_person, 0),
        'booked_no_person_value_mkd', round(coalesce(b.booked_no_person_mkd, 0)),
        'booked_twin',      coalesce(b.twin, 0),
        'booked_twin_value_mkd', round(coalesce(b.twin_mkd, 0)),
        'booked_twin_by_role', coalesce(b.twin_by_role, 0),
        'web',              coalesce(o.web, 0),
        'web_value_mkd',    round(coalesce(o.web_mkd, 0)),
        'mex_only',         coalesce(o.mex_only, 0),
        'mex_only_value_mkd', round(coalesce(o.mex_only_mkd, 0)),
        'worked',           coalesce(w.worked, 0),
        'sale_decisions',   coalesce(w.sale_d, 0),
        'unmapped_decisions', coalesce(w.unmapped, 0)))
      FROM dk
      LEFT JOIN sagg s ON s.dept = dk.key
      LEFT JOIN bagg b ON b.dept = dk.key
      LEFT JOIN oagg o ON o.dept = dk.key
      LEFT JOIN wagg w ON w.dept = dk.key),
    'sales',            (SELECT count(*) FROM so WHERE so.in_total),
    'value_mkd',        (SELECT round(coalesce(sum(so.value_mkd), 0)) FROM so WHERE so.in_total),
    'credited',         (SELECT count(*) FROM so WHERE so.in_total AND so.pid IS NOT NULL),
    'live_credited',    (SELECT count(*) FROM so WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL),
    'worked',           (SELECT count(*) FROM vw),
    'unmapped_decisions', (SELECT count(*) FROM vw WHERE vw.person_id IS NULL),
    'no_seller', jsonb_build_object(
      'sales',     (SELECT count(*) FROM nsr),
      'value_mkd', (SELECT round(coalesce(sum(nsr.value_mkd), 0)) FROM nsr),
      'reasons',   (SELECT coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'department', x.dept,
                                                                 'count', x.n, 'value_mkd', round(x.v))
                                              ORDER BY x.n DESC, x.reason, x.dept), '[]'::jsonb)
                      FROM (SELECT nsr.reason, nsr.dept, count(*) AS n, coalesce(sum(nsr.value_mkd), 0) AS v
                              FROM nsr GROUP BY 1, 2) x),
      'booked',    (SELECT coalesce(sum(bkc.booked), 0) FROM bkc WHERE bkc.person_id IS NULL),
      'booked_value_mkd', (SELECT round(coalesce(sum(bkc.booked_mkd), 0)) FROM bkc WHERE bkc.person_id IS NULL)),
    -- safety: 0 everywhere, or a mapping has a gap
    'no_department', jsonb_build_object(
      'orders',           (SELECT coalesce(sum(sagg.unclassified), 0) FROM sagg),
      'orders_value_mkd', (SELECT round(coalesce(sum(sagg.unclassified_mkd), 0)) FROM sagg),
      'bookings',         (SELECT coalesce(sum(bkc.booked + bkc.twin), 0) FROM bkc WHERE bkc.no_dept),
      'work',             (SELECT count(*) FROM vw WHERE vw.dept IS NULL OR vw.unclassified)),
    'checks', jsonb_build_object(
      'bookings_filter_drift', (SELECT coalesce(sum(bka.docs), 0) FROM bka) - (SELECT count(*) FROM bkd))),
  'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'person_id',        rk.person_id,
      'user_id',          rk.user_id,
      'name',             rk.name,
      'team_key',         rk.team_key,
      'team_name',        rk.team_name,
      'is_member',        rk.is_member,
      'is_manager',       rk.is_manager,
      'rank',             rk.rnk,
      'sales',            rk.f_sales,
      'value_mkd',        round(rk.f_value),
      'booked',           rk.f_booked,
      'booked_value_mkd', round(rk.f_booked_mkd),
      'total_count',      rk.f_total,
      'total_value_mkd',  round(rk.f_total_mkd),
      'cancelled_after_sale', rk.f_cas,
      'cancelled_value_mkd', round(rk.f_cas_mkd),
      'returned',         rk.f_ret,
      'live_credited',    rk.f_live,
      'booked_twin',      rk.f_twin,
      'booked_twin_value_mkd', round(rk.f_twin_mkd),
      'worked',           rk.worked,
      'sale_decisions',   rk.sale_d,
      'cancelled',        rk.cancel_d,
      'trashed',          rk.trash_d,
      'callbacks',        rk.callback_d,
      'conversion',       CASE WHEN rk.worked > 0 THEN round(rk.sale_d::numeric / rk.worked, 4) END,
      'last_decision_at', rk.last_at,
      'departments',      rk.depts,
      'presence', jsonb_build_object(
        'state',           rk.state,
        'online_min',      coalesce(rk.online_minutes, 0),
        'active_min',      coalesce(rk.active_minutes, 0),
        'idle_min',        coalesce(rk.idle_minutes, 0),
        'break_min',       coalesce(rk.break_minutes, 0),
        'first_seen',      rk.first_seen_at,
        'last_seen',       rk.last_seen_at,
        'first_active',    rk.first_active_at,
        'last_active',     rk.last_active_at,
        'idle_alerts',     coalesce(rk.idle_alerts, 0),
        'idle_streak_min', rk.idle_streak_min,
        'first_login',     rk.first_login))
      ORDER BY CASE WHEN rk.rnk IS NOT NULL THEN 0 WHEN NOT rk.is_manager THEN 1 ELSE 2 END,
               rk.rnk, rk.f_total_mkd DESC, rk.f_total DESC, rk.worked DESC, rk.st_ord,
               coalesce(rk.active_minutes, 0) DESC, rk.name, rk.person_id)
    FROM rk), '[]'::jsonb)
)
  $lb2$
  INTO v_out
  USING v_from, v_to, v_day, v_dept, v_team, (v_day = v_today), public.report_excluded_phone8s();

  RETURN v_out;
END;
$function$;

-- public.order_departments(uuid[]) (1 call)
CREATE OR REPLACE FUNCTION public.order_departments(p_ids uuid[])
 RETURNS TABLE(id uuid, department text, seller_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.id,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override),
         coalesce(sp.display_name,
                  CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END)
    FROM public.orders o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
   WHERE o.id = ANY (p_ids)
$function$;

-- public.order_origin(uuid) (1 call)
CREATE OR REPLACE FUNCTION public.order_origin(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'department', public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override),
    'sale_source', o.sale_source,
    'sale_source_detail', o.sale_source_detail,
    'doc_type', o.collabbox_doc_type,
    'intake', o.source_type,
    'seller', coalesce(sp.display_name,
                       CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END),
    'sold_at', o.sold_at,
    'sold_via', o.sold_via,
    'paid_basis', o.paid_basis,
    'price_mkd', CASE WHEN o.price IS NULL THEN NULL ELSE round(o.price * 61.5) END,
    'parcel', (SELECT jsonb_build_object(
                 'tracking', p.tracking_id, 'account', p.account, 'series', p.series,
                 'status_id', p.status_id, 'status_name', p.status_name, 'cod_mkd', p.cod_mkd,
                 'receiver_name', p.receiver_name, 'receiver_city', p.receiver_city,
                 'created_at', p.created_at_mex, 'delivered_at', p.delivered_at,
                 'returned_at', p.returned_at, 'last_update_at', p.last_update_at,
                 'linked_here', p.order_id = o.id)
                 FROM public.mex_parcels p WHERE p.tracking_id = o.mex_tracking_id),
    'collabbox', (SELECT jsonb_build_object(
                    'doc', d.doc_number, 'type', d.doc_type_id, 'type_name', d.doc_type_name,
                    'author', d.author, 'doc_at', d.doc_at, 'amount_mkd', d.amount_mkd)
                    FROM public.collabbox_documents d
                   WHERE d.doc_number = o.mex_tracking_id AND d.vanished_at IS NULL),
    'altercpa', (SELECT jsonb_build_object(
                   'lead', l.altercpa_id, 'decision', l.decision, 'decided_at', l.decided_at,
                   'operator', coalesce(
                     (SELECT sp2.display_name FROM public.sales_person_identities i
                        JOIN public.sales_people sp2 ON sp2.id = i.person_id
                       WHERE i.kind = 'altercpa_user' AND i.value = l.decided_by_altercpa_user::text
                       LIMIT 1),
                     CASE WHEN l.decided_by_altercpa_user IS NOT NULL THEN '#' || l.decided_by_altercpa_user END))
                   FROM public.altercpa_leads l WHERE l.order_id = o.id
                   ORDER BY l.last_seen_at DESC NULLS LAST LIMIT 1))
    FROM public.orders o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
   WHERE o.id = p_id
$function$;

-- public.insights_lists(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,boolean,integer) (0 call)
CREATE OR REPLACE FUNCTION public.insights_lists(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_money boolean DEFAULT false, p_stale_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
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
  SELECT r.source, r.split, r.list_id, coalesce(r.list_id, prm.nil) AS lk, r.bucket, r.in_total,
         r.value_mkd, r.cod_mkd, r.sale_at, r.sale_day, r.person_id, r.order_id, r.display_id, r.phone8,
         r.q_no_seller, r.q_cancelled_but_moving, r.q_zero_cod,
         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($5, $2, false) r
  CROSS JOIN prm
  -- the list sales of EVERY department (a teleshop Lead-out agent's list sale is Телешоп – Lead out
  -- since 20260942001800) + the rest of Affiliate – Lead out for the footer
  WHERE r.source = 'elyon_crm' OR r.split = 'prediction_list'
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
  WHERE sr.cur AND sr.source = 'elyon_crm'
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
$function$;

-- public.insights_lists_cash(timestamp with time zone,timestamp with time zone,boolean) (0 call)
CREATE OR REPLACE FUNCTION public.insights_lists_cash(p_from timestamp with time zone, p_to_end timestamp with time zone, p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET jit TO 'off'
AS $function$
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
    WHERE c.split = 'prediction_list'   -- list sales of every department (20260942001800)
  ) x
$function$;

COMMIT;
