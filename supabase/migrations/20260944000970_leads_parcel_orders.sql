-- ============================================================================
-- A CRM order from a collabBox "Нарачка LEADS" document when MEX really delivered or returned its parcel
-- (owner, Mile, 01.10.2026)
-- ============================================================================
-- OWNER (verbatim, 01.10.2026): "If there is delivery from MEX too or return, then of course we will import them,
-- that way we know that MEX really tried to deliver that order."
-- OWNER LAW (01.10.2026): the truth is MEX (+ collabBox), never AlterCPA (a commercial artifact — the ~30 %
-- confirmation guarantee). NOTHING here is pushed to AlterCPA: no /orders/:id/altercpa-push, no postback
-- (the orders made here are source_type 'import' with no affiliate_leads row).
--
-- WHY: a 10111 LEADS document (role 'credit') never becomes an order in the live writer — it credits the order
-- holding its parcel (collabbox_apply_one, branch D). When no order holds the parcel (the AlterCPA lead was decided
-- in AlterCPA before the bridge imported it, or never reached the CRM), the document sits at 'credit_pending' and
-- the parcel counts as a MEX-only Affiliate – Lead in sale with no seller. Once MEX delivered (2) or returned (7)
-- the parcel, the sale is proven to have happened: it becomes ONE CRM order made from the document.
--
-- THE RULES (one definition: leads_parcel_orders_plan(days) — the backfill script runs this very body inline before
-- the migration exists, and the nightly cron runs the function):
--   1. parcel    series 9110 (Affiliate – Lead in), MEX status 2 delivered or 7 returned, cod_mkd > 0, created at MEX
--                in the last `days` (75), mex_parcels.order_id IS NULL, no order names it, a valid phone8 that is not a
--                test phone (report_excluded_phone8s()). A web order claiming it → manual.
--   2. document  collabBox doc_number = the tracking id, type 10111 "Нарачка LEADS", role 'credit', outcome
--                'credit_pending', not a storno / reversed / vanished, payload stored, lines read, a value > 0, not
--                older than its parcel (the writer's parcel_predates_document), and not already an order.
--   3. no twin   (a) the nightly phone + date linker (link_lead_parcels_plan, 20260944000950) has NO row for the
--                parcel — neither a link nor a manual/ambiguous candidate; (b) no Affiliate sale (cohort Affiliate –
--                Lead in / out) on the customer's last-8 phone created from parcel − 30 days to parcel + 1 day that is
--                alive (not cancelled / trashed / duplicated — or holds a parcel): a re-ship or the same lead, listed
--                for a human (scripts/repair-link-elyon-parcels.mjs owns re-ships); (c) the writer's own
--                possible_twin_crm_sale rule (collabbox_apply_one: a CRM sale on the phone with no parcel whose price
--                fits the document, created booking − 1 d … + 2 d).
--   4. customer  exactly as the writer reads it (collabbox_apply_one branch E): the komitent card → the teleshop
--                registry → the parcel's phone; a komitent the writer skips (deceased, employee, …) → manual.
--   Parcels still with the courier / at the label are NOT imported: they qualify by themselves once MEX delivers or
--   returns them. Series 9103 (LEADS-OUT, 10114, role 'order_unless_held') is the live writer's own job — it already
--   makes those orders; this rule never touches it.
--
-- THE ORDER is made the way the writer makes an order from a collabBox document (collabbox_apply_one branch E,
-- md5 d673d2e259d1ffd877f81d06f5a5de78 — read, NOT changed): source_type 'import', external_source 'collabbox',
-- external_order_id = the DocNumber (the writer's idempotency key — the document now IS this order),
-- collabbox_doc_type '10111' → the insert classifier puts it in Affiliate – Lead in (altercpa / collabbox_leads,
-- like the 2.503 historic 10111 orders); products / quantity from the goods lines (collabbox_items), price = goods
-- ден / 61,5 (MKD_PER_EUR, frozen) unless the COD disagrees (COD ≠ price → MEX is right); created / confirmed =
-- THE sale time collabbox_sale_at(doc_at, booked_at); status from MEX (2 → paid, paid_at = the delivery, paid_basis
-- 'mex' · 7 → returned); the parcel linked by mex_link_parcel(…, 'collabbox_import'); order_history + one order note.
-- THE SELLER is credited by the LIVE writer, not here: the document is re-applied through
-- collabbox_apply_documents(run, [payload], false) in the same transaction — collabbox_apply_one now finds the order
-- by its DocNumber (branch C) and collabbox_credit_order stamps sold_* = the document's author at the booking time;
-- the ledger row shows the order (outcome 'updated' / credit 'stamped', or 'exists' when the author is unknown).
-- One collabbox_sync_runs row (kind 'manual', trigger 'cron' at night) carries those re-applies.
--
-- WHAT THIS MIGRATION CREATES
--   leads_parcel_orders_plan(days)          THE rules — one read-only SELECT returning {hash, counts, create[], manual[]}
--   leads_parcel_orders_doc_snapshot(doc)   the ledger fields the writer changes (the rollback restores them)
--   leads_parcel_orders(apply, days, run, expect_hash)
--                                           apply = false → the plan; apply = true → one order per create row, each in its
--                                           own sub-transaction (a refused row never blocks the rest), under ONE repair run
--                                           (data_repair_runs key 'leads-parcel-orders'). A dry-run id applies only while
--                                           the plan still hashes to what was reviewed. Undo: scripts/repair-leads-parcel-
--                                           orders.mjs --rollback <run> (deletes the orders it made, restores the ledger
--                                           rows) — NOT rollback-repair.mjs (it refuses this key).
--   leads_parcel_orders_nightly(force)      the cron's wrapper: app_settings.leads_parcel_orders {mode report|apply|off,
--                                           days 75, hour = the no-parcel rule's hour}, once per Skopje day.
--   cron 'leads-parcel-orders' '6 * * * *'  self-gated → 21:06 Skopje: AFTER the 21:02 link-lead-parcels run (it waits
--                                           for that run's lock and needs tonight's run in the ledger) and BEFORE the
--                                           21:10 no-parcel rule.
--   app_settings.leads_parcel_orders        seeded {mode: 'report', days: 75} (report = the plan recorded as a dry run the
--                                           backfill script can apply). Guarded like link_lead_parcels.
--
-- Reference (read-only, 01.10.2026 ~22:40 Skopje, after the 21:17 link backfill; dry run aa562ee1): 213 parcels, 189
-- with a document → 121 orders (410.929 ден: 88 paid, 33 returned) + 92 manual (33 link-plan candidates, 34 a living
-- Affiliate sale on the phone, 24 no document, 1 no phone). Proven in a local sandbox (the live function bodies +
-- sample rows): apply → the writer answered 'updated' / 'stamped' for every order; rollback restored every row.
-- Revert: SELECT cron.unschedule('leads-parcel-orders'); DROP the four functions; DELETE the app_settings row;
-- re-apply 20260944000950's guard body. Orders already made are undone per run with the backfill script's --rollback.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.tg_app_settings_guard_owner_keys()', 'e8bab1d453fb9bab1640c7d84c86e7c7', '6f463680dc3a60f264e7e702bb1e748c')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'leads parcel orders: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF to_regprocedure('public.link_lead_parcels_plan(integer)') IS NULL THEN
    RAISE EXCEPTION 'leads parcel orders: link_lead_parcels_plan(integer) is required (20260944000950)';
  END IF;
  IF to_regprocedure('public.collabbox_apply_documents(uuid,jsonb,boolean)') IS NULL
     OR to_regprocedure('public.collabbox_items(jsonb,numeric)') IS NULL
     OR to_regprocedure('public.collabbox_sale_at(timestamp with time zone,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.is_synthetic_product_name(text)') IS NULL
     OR to_regprocedure('public.cohort_order_source(text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'leads parcel orders: a collabBox / MEX / cohort helper is missing';
  END IF;
  -- the writer must still treat a document that IS an order as its idempotency key (branch C) — the re-apply
  -- below relies on it; and it must still never make an order from a LEADS document by itself (branch D)
  IF position('o.external_source = ''collabbox'' AND o.external_order_id = _doc' IN
              (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.collabbox_apply_one(uuid,jsonb,boolean)'))) = 0
     OR position('IF _role = ''credit'' THEN' IN
              (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.collabbox_apply_one(uuid,jsonb,boolean)'))) = 0 THEN
    RAISE EXCEPTION 'leads parcel orders: collabbox_apply_one no longer finds an order by its DocNumber / no longer has the credit branch — re-read it';
  END IF;
  IF to_regclass('public.data_repair_runs') IS NULL OR to_regclass('public.data_repair_rows') IS NULL
     OR to_regclass('public.collabbox_documents') IS NULL OR to_regclass('public.collabbox_sync_runs') IS NULL THEN
    RAISE EXCEPTION 'leads parcel orders: the repair ledger / collabBox ledger are required';
  END IF;
END
$drift$;

-- ── 1. the owner switch ─────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('leads_parcel_orders', jsonb_build_object('mode', 'report', 'days', 75))
ON CONFLICT (key) DO NOTHING;

-- the LIVE body (md5 e8bab1d453fb9bab1640c7d84c86e7c7, 20260944000950) with ONE edit: 'leads_parcel_orders' joins
-- the guarded keys
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

-- ── 2. THE rules: the plan (one read-only SELECT; $1 = days) ────────────────
-- The body between the $plan$ tags is run verbatim by scripts/repair-leads-parcel-orders.mjs and
-- scripts/verify-folder-orders.mjs in "inline" mode (with $1::integer replaced) — keep it ONE statement with exactly
-- one $1::integer. It may only call functions the read-only role can execute: collabbox_num and collabbox_mk_phone8
-- are therefore spelled out below (their bodies, 20260942000900 — the verify script checks they still agree).
CREATE OR REPLACE FUNCTION public.leads_parcel_orders_plan(p_days integer DEFAULT 75)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $plan$
WITH prm AS MATERIALIZED (
  SELECT greatest(1, least(coalesce($1::integer, 75), 400)) AS days,
         now() AS at,
         30 AS twin_days,                               -- rule 3b: an Affiliate sale on the phone this long before the parcel
         61.5::numeric AS rate,                         -- MKD_PER_EUR — FROZEN (CLAUDE.md): never "update" it
         150::numeric AS delivery,                      -- the MEX delivery fee a COD may include (the writer's c_delivery)
         3::numeric AS tol,                             -- ден (the writer's c_tol)
         public.report_excluded_phone8s() AS ex8
),
-- rule 3a: the nightly phone + date linker's OWN plan — a parcel it links or lists has a candidate order
ll AS MATERIALIZED (SELECT public.link_lead_parcels_plan((SELECT days FROM prm)) AS j),
llp AS MATERIALIZED (
  SELECT DISTINCT ON (x.tr) x.tr, x.kind
    FROM (SELECT e ->> 'tracking_id' AS tr, 'link_plan_link' AS kind FROM ll, jsonb_array_elements(ll.j -> 'link') e
          UNION ALL
          SELECT e ->> 'tracking_id', 'link_plan_manual' FROM ll, jsonb_array_elements(ll.j -> 'manual') e) x
   ORDER BY x.tr, x.kind
),
-- rule 1: a 9110 parcel MEX delivered or returned, COD > 0, in the window, held and named by no order, a valid
-- non-test phone8
pr AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd, p.phone8, p.receiver_name,
         p.receiver_city, p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at
    FROM public.mex_parcels p, prm
   WHERE p.order_id IS NULL
     AND p.series = '9110'
     AND p.status_id IN (2, 7)
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.phone8 ~ '^[0-9]{8}$'
     AND NOT (p.phone8 = ANY (prm.ex8))
     AND p.created_at_mex >= prm.at - make_interval(days => prm.days)
     AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)
),
-- rule 2: its collabBox document, as the writer reads it
dc AS MATERIALIZED (
  SELECT pr.*, d.doc_number, d.doc_type_id, d.role, d.doc_at, d.booked_at, d.amount_mkd, d.author, d.author_person_id,
         d.komitent_id, d.komitent_name, d.outcome, d.reason AS doc_reason, d.is_storno, d.reversed_by, d.vanished_at,
         d.payload,
         CASE WHEN jsonb_typeof(d.payload -> 'lines') = 'array' THEN d.payload -> 'lines' ELSE '[]'::jsonb END AS lines,
         CASE WHEN d.payload ->> 'lines_complete' IN ('true', 'false') THEN (d.payload ->> 'lines_complete')::boolean
              ELSE false END AS lines_complete,
         CASE WHEN jsonb_typeof(d.payload -> 'komitent') = 'object' THEN d.payload -> 'komitent' END AS card,
         -- THE sale time (owner 01.10.2026, 20260944000500): the booking, decided once per document
         public.collabbox_sale_at(d.doc_at, least(coalesce(d.booked_at, d.doc_at), d.doc_at)) AS sale_at,
         EXISTS (SELECT 1 FROM public.web_orders w
                  WHERE w.mex_tracking_id = pr.tracking_id AND w.deleted_in_shop_at IS NULL) AS web_claimed,
         EXISTS (SELECT 1 FROM public.orders x
                  WHERE x.external_source = 'collabbox' AND x.external_order_id = pr.tracking_id) AS doc_is_order
    FROM pr
    LEFT JOIN public.collabbox_documents d ON d.doc_number = pr.tracking_id
),
-- the lines, classified exactly as collabbox_apply_one classifies them (collabbox_num spelled out)
ln AS (
  SELECT dc.tracking_id, x.ord,
         CASE WHEN x.l ->> 'role' IN ('goods', 'delivery', 'note', 'marker') THEN x.l ->> 'role' ELSE 'note' END AS r,
         pp.id AS pid,
         left(coalesce(nullif(btrim(x.l ->> 'product_name'), ''), nullif(btrim(x.l ->> 'name'), ''), '—'), 300) AS nm,
         left(btrim(coalesce(x.l ->> 'name', '')), 500) AS raw,
         coalesce(CASE WHEN btrim(coalesce(x.l ->> 'qty', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                       THEN btrim(x.l ->> 'qty')::numeric END, 0) AS q,
         coalesce(CASE WHEN btrim(coalesce(x.l ->> 'value_mkd', '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
                       THEN btrim(x.l ->> 'value_mkd')::numeric END, 0) AS v
    FROM dc
    CROSS JOIN LATERAL jsonb_array_elements(dc.lines) WITH ORDINALITY AS x(l, ord)
    LEFT JOIN public.products pp
      ON pp.id = CASE WHEN (x.l ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN (x.l ->> 'product_id')::uuid END
),
lg AS (
  SELECT ln.tracking_id,
         count(*)::integer AS nlines,
         coalesce(sum(ln.v) FILTER (WHERE ln.r = 'goods'), 0) AS goods,
         coalesce(to_jsonb(array_agg(ln.raw ORDER BY ln.ord) FILTER (WHERE ln.r = 'note' AND ln.raw <> '')), '[]'::jsonb) AS notes,
         coalesce(jsonb_agg(jsonb_build_object('product_id', ln.pid, 'name', ln.nm, 'qty', ln.q, 'value_mkd', ln.v)
                            ORDER BY ln.ord) FILTER (WHERE ln.r = 'goods' AND (ln.q > 0 OR ln.v > 0)), '[]'::jsonb) AS goods_l,
         (array_agg(ln.pid ORDER BY ln.v DESC, ln.ord) FILTER (WHERE ln.r = 'goods' AND ln.pid IS NOT NULL))[1] AS top,
         left(string_agg(ln.nm, ' + ' ORDER BY ln.ord) FILTER (WHERE ln.r = 'goods' AND (ln.q > 0 OR ln.v > 0)), 300) AS pname,
         greatest(coalesce(sum(greatest(ceil(ln.q), 1)) FILTER (WHERE ln.r = 'goods' AND (ln.q > 0 OR ln.v > 0)), 0), 1)::integer AS qty
    FROM ln
   GROUP BY ln.tracking_id
),
-- rule 4: the customer, in the writer's order: the card → the teleshop registry → the parcel → a parcel-registry
-- card (collabbox_mk_phone8 spelled out: a Macedonian mobile / landline last-8)
cu0 AS (
  SELECT dc.tracking_id,
         CASE WHEN dc.card IS NOT NULL THEN
                CASE WHEN btrim(coalesce(dc.card ->> 'phone8', '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
                     THEN btrim(dc.card ->> 'phone8') END
              WHEN cc.source = 'card' THEN
                CASE WHEN btrim(coalesce(cc.phone8, '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
                     THEN btrim(cc.phone8) END END AS p8_card,
         CASE WHEN dc.card IS NOT NULL THEN nullif(btrim(dc.card ->> 'skip_reason'), '')
              WHEN cc.source = 'card' THEN cc.skip_reason END AS skip_card,
         CASE WHEN dc.card IS NOT NULL THEN nullif(btrim(dc.card ->> 'name'), '')
              WHEN cc.source = 'card' THEN nullif(btrim(cc.name), '') END AS name_card,
         CASE WHEN dc.card IS NOT NULL THEN nullif(btrim(dc.card ->> 'city'), '')
              WHEN cc.source = 'card' THEN nullif(btrim(cc.city), '') END AS city_card,
         CASE WHEN dc.card IS NOT NULL THEN nullif(btrim(dc.card ->> 'address'), '')
              WHEN cc.source = 'card' THEN nullif(btrim(cc.address), '') END AS address_card,
         (dc.card IS NULL AND cc.source IS DISTINCT FROM 'card') AS no_card,
         CASE WHEN cc.source = 'parcel'
               AND btrim(coalesce(cc.phone8, '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
              THEN cc.phone8 END AS p8_registry,
         t.komitent_id IS NOT NULL AS has_tic,
         CASE WHEN btrim(coalesce(t.phone8, '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
              THEN t.phone8 END AS p8_tic,
         CASE WHEN t.outcome = 'skipped'
               AND t.reason IN ('deceased', 'employee', 'company', 'operator_account', 'do_not_ship',
                                'junk_name', 'wrong_number', 'test_name') THEN t.reason END AS skip_tic,
         nullif(btrim(t.name), '') AS name_tic,
         CASE WHEN btrim(coalesce(dc.phone8, '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
              THEN dc.phone8 END AS p8_parcel
    FROM dc
    LEFT JOIN public.collabbox_customers cc ON cc.komitent_id = dc.komitent_id
    LEFT JOIN public.teleshop_import_customers t ON t.komitent_id = dc.komitent_id
   WHERE dc.doc_number IS NOT NULL
),
cu AS (
  SELECT c.tracking_id,
         coalesce(c.p8_card, c.p8_tic, c.p8_parcel, c.p8_registry) AS p8,
         CASE WHEN c.p8_card IS NOT NULL THEN 'card' WHEN c.p8_tic IS NOT NULL THEN 'teleshop_import'
              WHEN c.p8_parcel IS NOT NULL THEN 'parcel' WHEN c.p8_registry IS NOT NULL THEN 'parcel_registry' END AS psrc,
         coalesce(c.skip_card, c.skip_tic,
                  CASE WHEN c.no_card AND NOT c.has_tic THEN nullif(btrim(dc.payload ->> 'name_skip'), '') END) AS skip,
         left(coalesce(c.name_card, c.name_tic, nullif(btrim(dc.komitent_name), ''), nullif(btrim(dc.receiver_name), ''), '—'), 200) AS cname,
         left(coalesce(c.city_card, nullif(btrim(dc.receiver_city), ''), ''), 120) AS city,
         left(coalesce(c.address_card, ''), 600) AS address
    FROM cu0 c
    JOIN dc ON dc.tracking_id = c.tracking_id
),
-- the price (the writer's rule): the goods ден / 61,5 — a document without lines is its header amount — unless the
-- COD is neither the goods nor goods + 150 (± 3): then the COD (COD ≠ price → MEX is right)
pz AS (
  SELECT dc.tracking_id, lg.nlines, lg.notes, lg.goods_l, lg.top, lg.pname, lg.qty,
         CASE WHEN coalesce(lg.nlines, 0) = 0 THEN dc.amount_mkd ELSE lg.goods END AS goods,
         (dc.cod_mkd > 0 AND NOT (abs(dc.cod_mkd - round(CASE WHEN coalesce(lg.nlines, 0) = 0 THEN dc.amount_mkd ELSE lg.goods END)) <= prm.tol
                                  OR abs(dc.cod_mkd - round(CASE WHEN coalesce(lg.nlines, 0) = 0 THEN dc.amount_mkd ELSE lg.goods END) - prm.delivery) <= prm.tol)) AS from_cod
    FROM dc
    CROSS JOIN prm
    LEFT JOIN lg ON lg.tracking_id = dc.tracking_id
   WHERE dc.doc_number IS NOT NULL
),
-- rule 3b / 3c: the sales already on the customer's phone(s) — the writer's phone and the parcel's
tw AS (
  SELECT dc.tracking_id,
         (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'display_id', o.display_id, 'status', o.status::text,
                                              'sale_source', o.sale_source, 'tracking', o.mex_tracking_id,
                                              'hours', round((extract(epoch FROM dc.created_at_mex - o.created_at) / 3600.0)::numeric, 1))
                           ORDER BY o.created_at)
            FROM public.orders o, prm
           WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) IN (dc.phone8, cu.p8)
             AND o.created_at BETWEEN dc.created_at_mex - make_interval(days => prm.twin_days) AND dc.created_at_mex + interval '1 day'
             AND coalesce(o.price, 0) > 0
             AND NOT public.is_synthetic_product_name(o.product_name)
             AND o.sale_source_detail IS DISTINCT FROM 'disposition'
             AND o.status::text <> 'duplicated'
             AND (o.status::text NOT IN ('cancelled', 'trashed') OR o.mex_tracking_id IS NOT NULL)
             AND public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
                 IN ('altercpa', 'elyon_crm')) AS affiliate_sales,
         (SELECT jsonb_agg(jsonb_build_object('order_id', o.id, 'display_id', o.display_id, 'status', o.status::text,
                                              'sale_source', o.sale_source) ORDER BY o.created_at)
            FROM public.orders o, prm
           WHERE cu.p8 IS NOT NULL
             AND right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = cu.p8
             AND o.external_source IS DISTINCT FROM 'collabbox'
             AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
             AND o.mex_tracking_id IS NULL
             AND o.price > 0
             AND NOT public.is_synthetic_product_name(o.product_name)
             AND o.sale_source_detail IS DISTINCT FROM 'disposition'
             AND o.created_at >= dc.sale_at - interval '1 day'
             AND o.created_at <= dc.sale_at + interval '2 days'
             AND (abs(round(o.price * prm.rate) - dc.amount_mkd) <= prm.tol
                  OR abs(round(o.price * prm.rate) + prm.delivery - dc.amount_mkd) <= prm.tol
                  OR abs(round(o.price * prm.rate) - round(pz.goods)) <= prm.tol)) AS writer_twins
    FROM dc
    JOIN cu ON cu.tracking_id = dc.tracking_id
    JOIN pz ON pz.tracking_id = dc.tracking_id
),
dec AS (
  SELECT dc.*, cu.p8, cu.psrc, cu.skip, cu.cname, cu.city, cu.address,
         pz.nlines, pz.notes, pz.goods_l, pz.top, pz.pname, pz.qty, pz.goods, pz.from_cod,
         tw.affiliate_sales, tw.writer_twins, llp.kind AS link_plan,
         CASE WHEN dc.doc_number IS NULL                                     THEN 'no_document'
              WHEN dc.doc_type_id IS DISTINCT FROM '10111' OR dc.role IS DISTINCT FROM 'credit' THEN 'not_a_leads_document'
              WHEN dc.is_storno OR dc.reversed_by IS NOT NULL                THEN 'storno_or_reversed'
              WHEN dc.vanished_at IS NOT NULL                                THEN 'vanished_in_collabbox'
              WHEN dc.payload IS NULL                                        THEN 'no_payload'
              WHEN dc.outcome IS DISTINCT FROM 'credit_pending'              THEN 'document_outcome_' || coalesce(dc.outcome, 'none')
              WHEN dc.doc_is_order                                           THEN 'document_is_an_order'
              WHEN dc.web_claimed                                            THEN 'parcel_claimed_by_web_order'
              WHEN NOT dc.lines_complete                                     THEN 'line_items_not_read'
              WHEN coalesce(dc.amount_mkd, 0) <= 0 OR coalesce(pz.goods, 0) <= 0 THEN 'zero_value'
              WHEN dc.created_at_mex < dc.doc_at                             THEN 'parcel_predates_document'
              WHEN llp.kind IS NOT NULL                                      THEN llp.kind
              WHEN tw.affiliate_sales IS NOT NULL                            THEN 'affiliate_sale_on_phone'
              WHEN tw.writer_twins IS NOT NULL                               THEN 'possible_twin_crm_sale'
              WHEN cu.skip IS NOT NULL                                       THEN 'komitent_' || cu.skip
              WHEN cu.p8 IS NULL                                             THEN 'no_phone'
              WHEN cu.p8 = ANY (prm.ex8)                                     THEN 'test_phone'
         END AS manual_reason
    FROM dc
    CROSS JOIN prm
    LEFT JOIN cu ON cu.tracking_id = dc.tracking_id
    LEFT JOIN pz ON pz.tracking_id = dc.tracking_id
    LEFT JOIN tw ON tw.tracking_id = dc.tracking_id
    LEFT JOIN llp ON llp.tr = dc.tracking_id
),
mk AS (   -- the orders to make, and what each one is
  SELECT d.*,
         CASE WHEN d.status_id = 2 THEN 'paid' ELSE 'returned' END AS target,
         CASE WHEN d.from_cod THEN round(d.cod_mkd / (SELECT rate FROM prm), 2)
              ELSE round(d.goods / (SELECT rate FROM prm), 2) END AS price_eur,
         coalesce(d.created_at_mex, d.doc_at) AS sent_at
    FROM dec d
   WHERE d.manual_reason IS NULL
),
mk2 AS (
  SELECT m.*,
         m.tracking_id || ':LPO_create:' || m.target || ':' || to_char(m.price_eur, 'FM9999990.00') || ':'
           || coalesce(m.author_person_id::text, '-') AS line
    FROM mk m
)
SELECT jsonb_build_object(
  'rule', 'leads-parcel-orders v1 (owner 01.10.2026): a 9110 parcel MEX delivered/returned + its 10111 LEADS document, no order and no candidate → one order from the document',
  'days', (SELECT days FROM prm),
  'at', (SELECT at FROM prm),
  'hash', encode(sha256(convert_to(coalesce((SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C") FROM mk2 x), ''), 'UTF8')), 'hex'),
  'counts', jsonb_build_object(
     'parcels', (SELECT count(*) FROM pr),
     'with_document', (SELECT count(*) FROM dc WHERE dc.doc_number IS NOT NULL),
     'create', (SELECT count(*) FROM mk2),
     'create_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM mk2),
     'manual', (SELECT count(*) FROM dec WHERE manual_reason IS NOT NULL),
     'manual_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM dec WHERE manual_reason IS NOT NULL),
     'by_target', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb) FROM (SELECT target AS k, count(*) AS n FROM mk2 GROUP BY 1) z),
     'manual_by_reason', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb)
                            FROM (SELECT manual_reason AS k, count(*) AS n FROM dec WHERE manual_reason IS NOT NULL GROUP BY 1) z)),
  'create', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'tracking_id', x.tracking_id, 'doc_number', x.doc_number, 'target', x.target,
              'mex_status_id', x.status_id, 'mex_status_name', x.status_name, 'cod_mkd', x.cod_mkd,
              'created_at_mex', x.created_at_mex, 'delivered_at', x.delivered_at, 'returned_at', x.returned_at,
              'last_update_at', x.last_update_at,
              'shipped_at', x.sent_at,
              'paid_at', CASE WHEN x.target = 'paid' THEN coalesce(x.delivered_at, x.last_update_at, x.sent_at) END,
              'returned_at_order', CASE WHEN x.target = 'returned' THEN coalesce(x.returned_at, x.last_update_at, x.sent_at) END,
              'doc_at', x.doc_at, 'booked_at', x.booked_at, 'sale_at', x.sale_at,
              'author', x.author, 'author_person_id', x.author_person_id,
              'amount_mkd', x.amount_mkd, 'goods_mkd', x.goods, 'price_eur', x.price_eur, 'price_from_cod', x.from_cod,
              'product_id', x.top, 'product_name', x.pname, 'quantity', x.qty, 'goods_lines', x.goods_l, 'notes', x.notes,
              'customer_name', x.cname, 'customer_phone', '+389' || x.p8, 'customer_city', x.city,
              'customer_address', x.address, 'phone_source', x.psrc, 'phone8_parcel', x.phone8,
              'phone_differs_from_parcel', (x.p8 IS DISTINCT FROM x.phone8),
              'komitent_id', x.komitent_id, 'line', x.line)
            ORDER BY x.created_at_mex, x.tracking_id), '[]'::jsonb) FROM mk2 x),
  'manual', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'tracking_id', d.tracking_id, 'doc_number', d.doc_number, 'mex_status_id', d.status_id,
              'mex_status_name', d.status_name, 'cod_mkd', d.cod_mkd, 'created_at_mex', d.created_at_mex,
              'doc_at', d.doc_at, 'author', d.author, 'author_person_id', d.author_person_id,
              'reason', d.manual_reason, 'document_outcome', d.outcome, 'document_reason', d.doc_reason,
              'orders', coalesce(d.affiliate_sales, d.writer_twins))
            ORDER BY d.created_at_mex, d.tracking_id), '[]'::jsonb) FROM dec d WHERE d.manual_reason IS NOT NULL))
$plan$;

COMMENT ON FUNCTION public.leads_parcel_orders_plan(integer) IS
  'THE rules (owner 01.10.2026, migration 20260944000970): a 9110 parcel MEX delivered (2) / returned (7), COD > 0, last N days, no order holds or names it + its 10111 Нарачка LEADS document (credit_pending, lines read, value > 0) → one CRM order made from the document — unless the phone + date linker has a row for the parcel, an Affiliate sale is alive on the phone (−30 d … +1 d), or the writer''s possible_twin_crm_sale rule fits. Returns {hash, counts, create[], manual[]}; read-only. Applied by leads_parcel_orders(true).';

-- ── 3. the ledger row of a document — the fields the writer changes (the rollback restores them) ──
CREATE OR REPLACE FUNCTION public.leads_parcel_orders_doc_snapshot(p_doc text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
  SELECT jsonb_build_object(
           'doc_number', d.doc_number, 'outcome', d.outcome, 'reason', d.reason, 'order_id', d.order_id,
           'related_order_id', d.related_order_id, 'credit', d.credit, 'flags', to_jsonb(d.flags),
           'planned_status', d.planned_status, 'paid_basis', d.paid_basis, 'price_eur', d.price_eur,
           'parcel_status_id', d.parcel_status_id, 'parcel_cod_mkd', d.parcel_cod_mkd, 'department', to_jsonb(d.department),
           'created_by_sync', d.created_by_sync, 'created_run_id', d.created_run_id, 'run_id', d.run_id)
    FROM public.collabbox_documents d
   WHERE d.doc_number = p_doc
$function$;

-- ── 4. the apply ────────────────────────────────────────────────────────────
-- p_apply false → the plan (writes nothing). p_apply true → every create row in its own sub-transaction (one refused
-- row never blocks the rest; it is listed in `skipped`), all under ONE repair run:
--   p_run NULL      a new data_repair_runs row (key leads-parcel-orders, dry_run false; summary.trigger =
--                   elyon.leads_orders_trigger — 'cron' from the nightly wrapper — and run_day = the Skopje day)
--   p_run <uuid>    the dry run the backfill script (or the cron in report mode) recorded: refused unless it is an
--                   unapplied leads-parcel-orders dry run whose candidate_hash = the plan's hash NOW (and p_expect_hash).
-- Guards: a read-write session; never beside the phone + date linker (waits for its lock) and one apply at a time;
-- the parcel and the document row-locked and re-checked. elyon.bulk_repair (no paid / returned bells) and
-- elyon.keep_updated_at are set LOCAL. Each order: INSERT (the writer's branch-E shape) → order_items
-- (collabbox_items) → the document's note lines + one owner note → order_history → customer_profiles (only fills) →
-- mex_link_parcel(…, 'collabbox_import') → the LIVE writer re-applies the document (it must answer this order) →
-- data_repair_rows (before = the ledger row + register row, after = the order + the ledger row).
CREATE OR REPLACE FUNCTION public.leads_parcel_orders(p_apply boolean DEFAULT false, p_days integer DEFAULT 75,
                                                     p_run uuid DEFAULT NULL, p_expect_hash text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  c_key     CONSTANT text := 'leads-parcel-orders';
  c_actor   CONSTANT text := 'System (leads-parcel-orders)';
  c_no_items CONSTANT text := 'collabBox: без ставки (непознат производ)';   -- the writer's c_no_items
  _plan     jsonb;
  _hash     text;
  _trigger  text := coalesce(nullif(current_setting('elyon.leads_orders_trigger', true), ''), 'manual');
  _today    date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _t0       timestamptz := clock_timestamp();
  _run      uuid;
  _rr       public.data_repair_runs%ROWTYPE;
  _sync     uuid;
  _it       jsonb;
  _tr       text;
  _p        public.mex_parcels%ROWTYPE;
  _d        public.collabbox_documents%ROWTYPE;
  _oid      uuid;
  _disp     text;
  _price    numeric;
  _status   text;
  _link     text;
  _res      jsonb;
  _e        jsonb;
  _dbefore  jsonb;
  _pbefore  jsonb;
  _applied  integer := 0;
  _moved    integer := 0;
  _skipped  jsonb := '[]'::jsonb;
  _outcomes jsonb := '{}'::jsonb;
  _made     jsonb := '[]'::jsonb;
BEGIN
  IF NOT coalesce(p_apply, false) THEN
    RETURN public.leads_parcel_orders_plan(p_days);
  END IF;
  IF current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'leads_parcel_orders: apply needs a read-write session — call it with p_apply => false here'
      USING ERRCODE = '25006';
  END IF;
  -- never beside the phone + date linker (it may give one of these parcels its order): wait for its run lock
  PERFORM pg_advisory_xact_lock(hashtext('public.link_lead_parcels'));
  IF NOT pg_try_advisory_xact_lock(hashtext('public.leads_parcel_orders')) THEN
    RAISE EXCEPTION 'leads_parcel_orders: another apply holds the run lock' USING ERRCODE = '55P03';
  END IF;

  _plan := public.leads_parcel_orders_plan(p_days);
  _hash := _plan ->> 'hash';
  IF p_expect_hash IS NOT NULL AND p_expect_hash IS DISTINCT FROM _hash THEN
    RAISE EXCEPTION 'leads_parcel_orders: the plan changed since it was reviewed (hash % ≠ %) — dry-run again',
      left(_hash, 12), left(p_expect_hash, 12) USING ERRCODE = '40001';
  END IF;

  IF p_run IS NOT NULL THEN
    SELECT * INTO _rr FROM public.data_repair_runs WHERE id = p_run FOR UPDATE;
    IF NOT FOUND OR _rr.key IS DISTINCT FROM c_key OR NOT _rr.dry_run OR _rr.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'leads_parcel_orders: run % is not an unapplied % dry run', p_run, c_key USING ERRCODE = '22023';
    END IF;
    IF _rr.candidate_hash IS DISTINCT FROM _hash THEN
      RAISE EXCEPTION 'leads_parcel_orders: the plan changed since dry run % (hash % ≠ %) — dry-run again',
        p_run, left(_hash, 12), left(coalesce(_rr.candidate_hash, ''), 12) USING ERRCODE = '40001';
    END IF;
    _run := p_run;
  ELSE
    INSERT INTO public.data_repair_runs (key, dry_run, candidate_hash, summary)
    VALUES (c_key, false, _hash, jsonb_build_object('trigger', _trigger, 'run_day', _today, 'days', _plan -> 'days',
                                                    'counts', _plan -> 'counts', 'manual', _plan -> 'manual'))
    RETURNING id INTO _run;
  END IF;

  -- the live writer re-applies the documents under one collabBox run (it refuses to write without a running one)
  IF jsonb_array_length(_plan -> 'create') > 0 THEN
    INSERT INTO public.collabbox_sync_runs (kind, trigger_kind, status, window_from, window_to, doc_types, stats)
    SELECT 'manual', CASE WHEN _trigger = 'cron' THEN 'cron' ELSE 'manual' END, 'running',
           min(((e ->> 'doc_at')::timestamptz AT TIME ZONE 'Europe/Skopje')::date),
           max(((e ->> 'doc_at')::timestamptz AT TIME ZONE 'Europe/Skopje')::date),
           ARRAY['10111'],
           jsonb_build_object('tool', 'leads_parcel_orders (20260944000970)', 'repair_run', _run, 'trigger', _trigger)
      FROM jsonb_array_elements(_plan -> 'create') e
    RETURNING id INTO _sync;
  END IF;

  PERFORM set_config('elyon.bulk_repair', 'on', true);       -- no paid / returned bells for a batch of orders
  PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- /call-agains reads orders.updated_at as the last call

  FOR _it IN SELECT e FROM jsonb_array_elements(_plan -> 'create') AS e LOOP
    _tr := _it ->> 'tracking_id';
    BEGIN
      SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _tr FOR UPDATE;
      SELECT * INTO _d FROM public.collabbox_documents WHERE doc_number = _tr FOR UPDATE;
      IF _p.tracking_id IS NULL OR _d.doc_number IS NULL
         OR _p.order_id IS NOT NULL
         OR _p.status_id IS DISTINCT FROM (_it ->> 'mex_status_id')::integer
         OR _d.outcome IS DISTINCT FROM 'credit_pending'
         OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = _tr)
         OR EXISTS (SELECT 1 FROM public.orders x WHERE x.external_source = 'collabbox' AND x.external_order_id = _tr) THEN
        _moved := _moved + 1;
        _skipped := _skipped || jsonb_build_array(jsonb_build_object('tracking_id', _tr, 'why', 'moved since the plan'));
        CONTINUE;
      END IF;
      _pbefore := jsonb_build_object('tracking_id', _p.tracking_id, 'order_id', _p.order_id,
                                     'link_method', _p.link_method, 'linked_at', _p.linked_at);
      _dbefore := public.leads_parcel_orders_doc_snapshot(_tr);
      _price   := (_it ->> 'price_eur')::numeric;
      _status  := _it ->> 'target';

      -- the order, in the writer's branch-E shape; sold_* stay empty — the LIVE writer credits the author below
      INSERT INTO public.orders (
             product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
             price, quantity, status, source_type, external_source, external_order_id, delivery_type,
             created_at, confirmed_at, mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at,
             collabbox_doc_type, mex_sent_at)
      VALUES (nullif(_it ->> 'product_id', '')::uuid, coalesce(nullif(_it ->> 'product_name', ''), c_no_items),
              _it ->> 'customer_name', _it ->> 'customer_phone', _it ->> 'customer_city', _it ->> 'customer_address',
              _price, greatest(coalesce((_it ->> 'quantity')::integer, 1), 1), _status::public.order_status,
              'import', 'collabbox', _tr, 'home',
              (_it ->> 'sale_at')::timestamptz, (_it ->> 'sale_at')::timestamptz,   -- created / confirmed = the booking
              _tr, (_it ->> 'paid_at')::timestamptz, CASE WHEN _status = 'paid' THEN 'mex' END,
              (_it ->> 'shipped_at')::timestamptz, (_it ->> 'returned_at_order')::timestamptz,
              '10111', (_it ->> 'shipped_at')::timestamptz)
      RETURNING id, display_id INTO _oid, _disp;

      IF jsonb_array_length(coalesce(_it -> 'goods_lines', '[]'::jsonb)) > 0 THEN
        INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
        SELECT _oid, i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price, (_it ->> 'doc_at')::timestamptz
          FROM public.collabbox_items(_it -> 'goods_lines', _price) i;
      END IF;
      INSERT INTO public.order_notes (order_id, text, author_id, author_name, created_at)
      SELECT _oid, 'collabBox: ' || n, NULL, 'collabBox', (_it ->> 'doc_at')::timestamptz
        FROM jsonb_array_elements_text(coalesce(_it -> 'notes', '[]'::jsonb)) n;
      INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      VALUES (_oid, NULL, _status::public.order_status, NULL, c_actor);
      INSERT INTO public.customer_profiles (phone, customer_name, city, street)
      VALUES (_it ->> 'customer_phone', nullif(_it ->> 'customer_name', '—'), nullif(_it ->> 'customer_city', ''),
              nullif(_it ->> 'customer_address', ''))
      ON CONFLICT (phone) DO NOTHING;

      _link := public.mex_link_parcel(_tr, _oid, 'collabbox_import', false);
      IF _link IS DISTINCT FROM 'linked' AND _link IS DISTINCT FROM 'already' THEN
        RAISE EXCEPTION 'mex_link_parcel % → %', _tr, coalesce(_link, 'null');
      END IF;

      -- the LIVE writer: the document now IS this order (its DocNumber), so it records the order and credits the
      -- author (collabbox_credit_order, the booking time) — exactly as for every collabBox order
      _res := public.collabbox_apply_documents(_sync, jsonb_build_array(_d.payload), false);
      _e := _res -> 'results' -> 0;
      IF _e IS NULL OR (_e ->> 'outcome') NOT IN ('updated', 'exists')
         OR (_e ->> 'order_id') IS DISTINCT FROM _oid::text THEN
        RAISE EXCEPTION 'the live collabBox writer answered % / % for %', coalesce(_e ->> 'outcome', 'nothing'),
          coalesce(_e ->> 'reason', ''), _tr;
      END IF;

      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      VALUES (_oid,
              format('Created from collabBox LEADS document %s because MEX %s the parcel (owner 01.10.2026): MEX %s %s, '
                     || 'COD %s ден, created %s; no CRM order held it and no order fits it (the phone + date rule found '
                     || 'none). Seller = the document''s author %s (credited by the collabBox writer at the booking time). '
                     || 'Nothing was sent to AlterCPA. Run %s (undo: scripts/repair-leads-parcel-orders.mjs --rollback %s).',
                     _tr, CASE WHEN _status = 'paid' THEN 'delivered' ELSE 'returned' END,
                     coalesce(_p.account, '?'), trim(coalesce(_p.status_id::text, '?') || ' ' || coalesce(_p.status_name, '')),
                     replace(to_char(_p.cod_mkd, 'FM999,999,990'), ',', '.'),
                     to_char(_p.created_at_mex AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                     coalesce(_it ->> 'author', 'unknown'), left(_run::text, 8), _run),
              NULL, c_actor);

      INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
      SELECT _run, _oid, 'LPO_create',
             jsonb_build_object('doc', _dbefore, 'parcel', _pbefore),
             jsonb_build_object(
               'order', jsonb_build_object(
                  'display_id', o.display_id, 'status', o.status, 'price', o.price, 'quantity', o.quantity,
                  'product_id', o.product_id, 'product_name', o.product_name, 'customer_phone', o.customer_phone,
                  'external_source', o.external_source, 'external_order_id', o.external_order_id,
                  'sale_source', o.sale_source, 'sale_source_detail', o.sale_source_detail, 'dept_override', o.dept_override,
                  'created_at', o.created_at, 'sold_at', o.sold_at, 'sold_via', o.sold_via, 'sold_by_ext', o.sold_by_ext,
                  'sold_by_person_id', o.sold_by_person_id, 'paid_at', o.paid_at, 'returned_at', o.returned_at,
                  'paid_basis', o.paid_basis, 'mex_tracking_id', o.mex_tracking_id, 'mex_status_id', o.mex_status_id,
                  'mex_cod_mkd', o.mex_cod_mkd),
               'doc', public.leads_parcel_orders_doc_snapshot(_tr),
               'parcel', (SELECT jsonb_build_object('tracking_id', mp.tracking_id, 'order_id', mp.order_id,
                                                    'link_method', mp.link_method, 'linked_at', mp.linked_at)
                            FROM public.mex_parcels mp WHERE mp.tracking_id = _tr)),
             jsonb_build_object('key', c_key, 'order', o.display_id, 'doc', _tr, 'tracking', _tr, 'target', _status,
                                'cod_mkd', _p.cod_mkd, 'author', _it ->> 'author', 'author_person_id', _it -> 'author_person_id',
                                'writer', _e, 'sync_run', _sync, 'trigger', _trigger, 'line', _it ->> 'line', 'unit', 'lpo:' || _tr)
        FROM public.orders o WHERE o.id = _oid;

      _outcomes := jsonb_set(_outcomes, ARRAY[_e ->> 'outcome'],
                             to_jsonb(coalesce((_outcomes ->> (_e ->> 'outcome'))::integer, 0) + 1));
      _made := _made || jsonb_build_array(jsonb_build_object('tracking_id', _tr, 'order', _disp, 'status', _status,
                                                             'writer', _e ->> 'outcome', 'credit', _e ->> 'credit'));
      _applied := _applied + 1;
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped || jsonb_build_array(jsonb_build_object('tracking_id', _tr, 'why', left(SQLERRM, 300)));
    END;
  END LOOP;

  IF _sync IS NOT NULL THEN
    UPDATE public.collabbox_sync_runs
       SET status = 'ok', finished_at = now(),
           duration_ms = (extract(epoch FROM clock_timestamp() - _t0) * 1000)::integer,
           stats = stats || jsonb_build_object('orders_made', _applied, 'writer_outcomes', _outcomes, 'skipped', _skipped)
     WHERE id = _sync;
  END IF;

  UPDATE public.data_repair_runs
     SET applied_at = now(),
         summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', jsonb_build_object(
                     'trigger', _trigger, 'run_day', _today, 'applied', _applied, 'moved', _moved,
                     'skipped', _skipped, 'sync_run', _sync, 'writer_outcomes', _outcomes, 'made', _made, 'at', now()))
   WHERE id = _run;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'hash', _hash, 'trigger', _trigger, 'days', _plan -> 'days',
                            'counts', _plan -> 'counts', 'applied', _applied, 'moved', _moved, 'skipped', _skipped,
                            'sync_run', _sync, 'writer_outcomes', _outcomes);
END;
$function$;

COMMENT ON FUNCTION public.leads_parcel_orders(boolean, integer, uuid, text) IS
  'Applies leads_parcel_orders_plan() (owner 01.10.2026, migration 20260944000970): one CRM order per 9110 parcel MEX delivered/returned whose 10111 LEADS document no order holds — the writer''s branch-E order shape, status from MEX, mex_link_parcel(…, ''collabbox_import''), then the LIVE writer re-applies the document (it records the order and credits its author). Ledger data_repair_runs/rows key leads-parcel-orders — undo: scripts/repair-leads-parcel-orders.mjs --rollback <id>. Never pushes to AlterCPA.';

-- ── 5. the nightly wrapper (the cron) ───────────────────────────────────────
-- app_settings.leads_parcel_orders: mode 'report' (the plan is recorded as a leads-parcel-orders DRY RUN — the owner can
-- apply that very run with the backfill script) | 'apply' | 'off'; days (default 75); hour (default = no_parcel_rule.hour,
-- 21). One scheduled run per Skopje day, AFTER tonight's link-lead-parcels run (unless that switch is off); a collabBox
-- pass still running is waited for (≤ 60 s), else the night is skipped (the parcels qualify again tomorrow).
CREATE OR REPLACE FUNCTION public.leads_parcel_orders_nightly(_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _cfg   jsonb;
  _mode  text;
  _days  integer;
  _hour  integer;
  _now   timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today date;
  _plan  jsonb;
  _id    uuid;
  _wait  integer := 0;
BEGIN
  _today := _now::date;
  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'leads_parcel_orders';
  _cfg  := coalesce(_cfg, '{}'::jsonb);
  _mode := coalesce(_cfg ->> 'mode', 'report');
  IF _mode NOT IN ('report', 'apply', 'off') THEN _mode := 'report'; END IF;
  _days := CASE WHEN btrim(coalesce(_cfg ->> 'days', '')) ~ '^[0-9]{1,3}$'
                THEN least(greatest((_cfg ->> 'days')::integer, 1), 400) ELSE 75 END;
  _hour := coalesce(
             CASE WHEN btrim(coalesce(_cfg ->> 'hour', '')) ~ '^[0-9]{1,2}$' THEN (_cfg ->> 'hour')::integer END,
             (SELECT CASE WHEN btrim(coalesce(s.value ->> 'hour', '')) ~ '^[0-9]{1,2}$' THEN (s.value ->> 'hour')::integer END
                FROM public.app_settings s WHERE s.key = 'no_parcel_rule'),
             21);

  IF _mode = 'off' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'switched off');
  END IF;
  IF NOT _force THEN
    IF extract(hour FROM _now)::integer <> _hour THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'outside the ' || _hour || ':00 Skopje window');
    END IF;
    IF EXISTS (SELECT 1 FROM public.data_repair_runs r
                WHERE r.key = 'leads-parcel-orders' AND r.summary ->> 'trigger' = 'cron'
                  AND r.summary ->> 'run_day' = _today::text) THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
    -- after the phone + date linker: tonight's run must be in the ledger (unless its switch is off)
    IF coalesce((SELECT s.value ->> 'mode' FROM public.app_settings s WHERE s.key = 'link_lead_parcels'), 'report') <> 'off'
       AND NOT EXISTS (SELECT 1 FROM public.data_repair_runs r
                        WHERE r.key = 'link-lead-parcels' AND r.summary ->> 'trigger' = 'cron'
                          AND r.summary ->> 'run_day' = _today::text) THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'tonight''s link-lead-parcels run is not in yet');
    END IF;
  END IF;

  IF _mode = 'apply' THEN
    -- the collabBox writer: one pass at a time — wait for a running pass (≤ 60 s), else skip the night
    WHILE EXISTS (SELECT 1 FROM public.collabbox_sync_runs r
                   WHERE r.status = 'running' AND r.started_at > now() - interval '20 minutes') LOOP
      IF _wait >= 12 THEN
        RETURN jsonb_build_object('ok', true, 'skipped', 'a collabBox pass is still running');
      END IF;
      PERFORM pg_sleep(5);
      _wait := _wait + 1;
    END LOOP;
    PERFORM set_config('elyon.leads_orders_trigger', CASE WHEN _force THEN 'manual' ELSE 'cron' END, true);
    RETURN public.leads_parcel_orders(true, _days);
  END IF;

  _plan := public.leads_parcel_orders_plan(_days);
  INSERT INTO public.data_repair_runs (key, dry_run, candidate_hash, summary)
  VALUES ('leads-parcel-orders', true, _plan ->> 'hash',
          jsonb_build_object('trigger', CASE WHEN _force THEN 'manual' ELSE 'cron' END, 'run_day', _today,
                             'mode', 'report', 'days', _days, 'counts', _plan -> 'counts',
                             'create', _plan -> 'create', 'manual', _plan -> 'manual'))
  RETURNING id INTO _id;
  RETURN jsonb_build_object('ok', true, 'mode', 'report', 'run_id', _id, 'hash', _plan ->> 'hash', 'counts', _plan -> 'counts');
END;
$function$;

COMMENT ON FUNCTION public.leads_parcel_orders_nightly(boolean) IS
  'pg_cron ''leads-parcel-orders'' (6 * * * *, self-gated to the no-parcel rule''s hour → 21:06 Skopje, after tonight''s 21:02 link-lead-parcels run, before the 21:10 no-parcel rule; once per Skopje day). app_settings.leads_parcel_orders {mode report|apply|off, days 75, hour}. Migration 20260944000970.';

-- ── 6. grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.leads_parcel_orders_plan(integer)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_parcel_orders_doc_snapshot(text)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_parcel_orders(boolean, integer, uuid, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.leads_parcel_orders_nightly(boolean)                    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leads_parcel_orders_plan(integer)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.leads_parcel_orders_doc_snapshot(text)               TO service_role;
GRANT EXECUTE ON FUNCTION public.leads_parcel_orders(boolean, integer, uuid, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.leads_parcel_orders_nightly(boolean)                 TO service_role;
-- the read-only verification path (Management API, read_only: true): the backfill's dry run and
-- scripts/verify-folder-orders.mjs call the PLAN only
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.leads_parcel_orders_plan(integer) TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 7. schedule — hourly at :06, self-gated to the no-parcel rule's hour ────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'leads-parcel-orders') THEN
    PERFORM cron.unschedule('leads-parcel-orders');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'leads-parcel-orders',
  '6 * * * *',
  $job$SELECT public.leads_parcel_orders_nightly();$job$
);

COMMIT;
