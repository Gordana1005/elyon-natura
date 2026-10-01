-- ============================================================================
-- Link an orphan BIO NATURAL lead parcel to its CRM order by PHONE + DATE (owner, Mile, 01.10.2026)
-- ============================================================================
-- OWNER LAW (01.10.2026): the truth is MEX (+ collabBox), never AlterCPA. AlterCPA statuses are a
-- commercial artifact (affiliates are paid on a ~30 % confirmation guarantee, so agents sometimes cancel
-- real sales in AlterCPA or pre-confirm non-sales). NOTHING here is pushed to AlterCPA — no call to
-- /orders/:id/altercpa-push, app_settings.altercpa_push_enabled untouched.
--
-- An orphan parcel is linked to its order by phone + date, IGNORING the amount (agents up-sell: the lead
-- offer is 1 box, the parcel 3–6):
--   1. parcel   series 9110 / 9103 (or account bio_natural with no series), cod_mkd > 0, created at MEX in the
--               last `days` (75), mex_parcels.order_id IS NULL, no order names it, a valid phone8 that is not
--               a test phone (report_excluded_phone8s()).
--   2. order    the same last 8 digits (right(regexp_replace(customer_phone,'[^0-9]','','g'),8) — the
--               idx_orders_phone_last8 expression), created from parcel − 10 days to parcel + 1 day,
--               mex_tracking_id IS NULL, price > 0, not is_synthetic_product_name(product_name),
--               sale_source_detail IS DISTINCT FROM 'disposition', status pending / call_again / confirmed /
--               paid / shipped / returned / cancelled / trashed (never take, delivered, duplicated).
--   3. unique   exactly one candidate order for the parcel AND that order a candidate of no other orphan
--               parcel. Otherwise → the manual list.
--   4. product  a parcel created more than 72 h after the order must carry the order's product BY NAME:
--               the order's product (orders.product_name split on , + ; and every order_items line) against
--               the goods lines of the collabBox document whose doc_number = the tracking id (name +
--               product_name). Folded: public.mk_geo_norm (Macedonian Cyrillic → Latin, digraphs, accents),
--               letters only, c/q → k, w → v, y → i, x → ks, doubled letters collapsed. A part matches when
--               ALL its key words (≥ 3 letters, not a stop word: bionatural, tab, cps, forte, complex, gel, …)
--               are contained in the squashed line text (key ≥ 4 letters). No document / no goods lines / no
--               usable key = "product unknown" → manual. ≤ 72 h → linked whatever the product (agents switch
--               e.g. ProstaFix → Adenofrin on the same call).
--   5. a customer who ordered 2–3 weeks earlier and orders again is NEVER linked to the old order — rules 2
--      (the 10-day window) and 3 (the order holds no parcel, unique both ways) guarantee it.
--   + safety (repo law, never automatic): an order in agent_payout_items, or an affiliate lead (its status
--     change would send a partner postback) → manual.
--
-- AFTER THE LINK the order follows MEX exactly like scripts/repair-link-elyon-parcels.mjs: delivered (2) →
-- paid (paid_at = the delivery, paid_basis 'mex'; an order already paid only gains basis 'mex'), returned (7)
-- → returned, MEX 8 "Shipment created" (за пакување, owner 30.09) → NO status change (mex-reconcile moves it
-- on at the pickup: shipGate 'open', or rule C for an AlterCPA cancel), anything else → shipped. The
-- disposition fields are cleared as mex-reconcile clears them. mex-reconcile then sees the order already at
-- its MEX target (status = target → 'unchanged') — the two never fight. Prices are NOT touched here (the
-- established practice): scripts/repair-cod-price.mjs makes the CRM price follow the COD afterwards (owner
-- 28.09), and every money report already values a linked order at its parcel COD.
--
-- WHAT THIS MIGRATION CREATES
--   link_lead_parcels_plan(days)          THE rules — one read-only SELECT returning the plan
--                                         {hash, counts, link[], manual[]}. scripts/repair-link-lead-parcels.mjs
--                                         and scripts/verify-parcel-link-rules.mjs run this very body (the
--                                         "inline" mode extracts it from THIS FILE before the migration exists).
--   link_lead_parcels(apply, days, run, expect_hash)
--                                         apply = false → the plan; apply = true → links through mex_link_parcel
--                                         (method 'repair'), the MEX status, order_history, one order note, and the
--                                         repair ledger (data_repair_runs / data_repair_rows, before + after in the
--                                         repair-kit snapshot shape) — every change is undone by
--                                         `node scripts/rollback-repair.mjs --run <run_id>`. A run id from a dry run
--                                         applies ONLY when the plan still hashes to what was reviewed.
--   link_lead_parcels_nightly(force)      the cron's wrapper: app_settings.link_lead_parcels {mode report|apply|off,
--                                         days 75, hour = the no-parcel rule's hour}, once per Skopje day.
--   cron 'link-lead-parcels' '2 * * * *'  self-gated to the no-parcel rule's hour → 21:02 Skopje: AFTER the
--                                         20:52 mex-reconcile pass (rolling runs take ≤ 30 s) and BEFORE the
--                                         21:10 no-parcel rule, which then no longer sees a linked order.
--   app_settings.link_lead_parcels        seeded {mode: 'report', days: 75}; owners flip it to 'apply' after the
--                                         one-off backfill (scripts/repair-link-lead-parcels.mjs --switch apply).
--                                         Guarded like no_parcel_rule (tg_app_settings_guard_owner_keys, one edit).
--
-- Reference (read-only, 01.10.2026 ~20:00 Skopje): 397 orphan parcels, 144 with a candidate, 201 pairs, 102
-- unique, 98 to link (323.820 ден: 80 cancelled, 14 confirmed, 3 trashed, 1 paid; MEX 37 delivered, 10
-- returned, 4 label), 46 manual (42 ambiguous, 4 a different product after 72 h).
-- Revert: SELECT cron.unschedule('link-lead-parcels'); DROP the four functions; DELETE the app_settings row;
-- re-apply 20260943001800's guard body. Links already made are undone per run with rollback-repair.mjs.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.tg_app_settings_guard_owner_keys()', '85b5d14002b3cdbc6615bf8438742a1e', 'e8bab1d453fb9bab1640c7d84c86e7c7')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'link lead parcels: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)') IS NULL
     OR position('''repair''' IN (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)'))) = 0 THEN
    RAISE EXCEPTION 'link lead parcels: mex_link_parcel(text,uuid,text,boolean) accepting method ''repair'' is required (20260943001200)';
  END IF;
  IF to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.is_synthetic_product_name(text)') IS NULL
     OR to_regprocedure('public.mk_geo_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'link lead parcels: report_excluded_phone8s / is_synthetic_product_name / mk_geo_norm missing';
  END IF;
  IF to_regclass('public.data_repair_runs') IS NULL OR to_regclass('public.data_repair_rows') IS NULL
     OR to_regclass('public.collabbox_documents') IS NULL OR to_regclass('public.agent_payout_items') IS NULL
     OR to_regclass('public.affiliate_leads') IS NULL THEN
    RAISE EXCEPTION 'link lead parcels: the repair ledger / collabbox_documents / agent_payout_items / affiliate_leads are required';
  END IF;
END
$drift$;

-- ── 1. the owner switch ─────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('link_lead_parcels', jsonb_build_object('mode', 'report', 'days', 75))
ON CONFLICT (key) DO NOTHING;

-- the LIVE body (md5 85b5d14002b3cdbc6615bf8438742a1e) with ONE edit: 'link_lead_parcels' joins the guarded keys
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels'];
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
-- The body between the $plan$ tags is run verbatim by scripts/repair-link-lead-parcels.mjs and
-- scripts/verify-parcel-link-rules.mjs in "inline" mode (with $1::integer replaced) — keep it ONE statement
-- with exactly one $1::integer.
CREATE OR REPLACE FUNCTION public.link_lead_parcels_plan(p_days integer DEFAULT 75)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $plan$
WITH prm AS MATERIALIZED (
  SELECT greatest(1, least(coalesce($1::integer, 75), 400)) AS days,
         now() AS at,
         72 AS product_hours,                         -- rule 4: a parcel this long after the order must carry its product
         public.report_excluded_phone8s() AS ex8
),
-- rule 1: an orphan BIO NATURAL lead parcel (9110 Нарачка LEADS / 9103 LEADS-OUT, or BIO NATURAL with no series)
pr AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd, p.phone8,
         p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at
    FROM public.mex_parcels p, prm
   WHERE p.order_id IS NULL
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.phone8 ~ '^[0-9]{8}$'
     AND (p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))
     AND p.created_at_mex >= prm.at - make_interval(days => prm.days)
     AND NOT (p.phone8 = ANY (prm.ex8))
     AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)
),
-- rule 2: a candidate order — same last 8 digits (the idx_orders_phone_last8 expression), created from 10 days
-- before to 1 day after the parcel, holding no parcel, a real priced sale, not a /calls disposition, not a duplicate
cand AS MATERIALIZED (
  SELECT pr.tracking_id, o.id AS order_id, o.display_id, o.status::text AS status, o.sale_source, o.source_type,
         o.created_at AS order_at, o.product_name, o.paid_basis,
         round((extract(epoch FROM pr.created_at_mex - o.created_at) / 3600.0)::numeric, 1) AS hours
    FROM pr
    JOIN public.orders o
      ON right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = pr.phone8
     AND o.created_at BETWEEN pr.created_at_mex - interval '10 days' AND pr.created_at_mex + interval '1 day'
   WHERE o.mex_tracking_id IS NULL
     AND coalesce(o.price, 0) > 0
     AND NOT public.is_synthetic_product_name(o.product_name)
     AND o.sale_source_detail IS DISTINCT FROM 'disposition'
     AND o.status::text IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed')
),
pc AS (SELECT c.tracking_id, count(*)::int AS n FROM cand c GROUP BY 1),
oc AS (SELECT c.order_id, count(*)::int AS n FROM cand c GROUP BY 1),
-- rule 3: unique both ways
uq AS MATERIALIZED (
  SELECT c.* FROM cand c
    JOIN pc ON pc.tracking_id = c.tracking_id
    JOIN oc ON oc.order_id = c.order_id
   WHERE pc.n = 1 AND oc.n = 1
),
-- rule 4 (only a pair whose parcel came more than 72 h after the order): every text the rule compares,
-- folded below by ONE expression — the order's product parts word by word (orders.product_name split on
-- , + ; and every order_items line), the collabBox document's goods lines (name + product_name), the stop words
txt AS (
  SELECT 'o'::text AS kind, u.order_id::text AS ref, pt.part_no AS part, w.word_no AS word, w.w AS raw
    FROM uq u
    CROSS JOIN prm
    CROSS JOIN LATERAL (
      SELECT row_number() OVER (ORDER BY s.part) AS part_no, s.part
        FROM (SELECT btrim(x) AS part FROM regexp_split_to_table(coalesce(u.product_name, ''), '[,+;]') AS x
              UNION
              SELECT btrim(i.product_name) FROM public.order_items i WHERE i.order_id = u.order_id) s
       WHERE coalesce(s.part, '') <> '') pt
    CROSS JOIN LATERAL regexp_split_to_table(pt.part, '[^[:alpha:]]+') WITH ORDINALITY AS w(w, word_no)
   WHERE u.hours > prm.product_hours
  UNION ALL
  SELECT 'l', u.tracking_id, l.line_no::int, 0, coalesce(l.e ->> 'name', '') || ' ' || coalesce(l.e ->> 'product_name', '')
    FROM uq u
    CROSS JOIN prm
    JOIN public.collabbox_documents d ON d.doc_number = u.tracking_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload -> 'lines') = 'array'
                                                 THEN d.payload -> 'lines' ELSE '[]'::jsonb END) WITH ORDINALITY AS l(e, line_no)
   WHERE u.hours > prm.product_hours
     AND coalesce(l.e ->> 'role', 'goods') = 'goods'
  UNION ALL
  SELECT 's', s.w, 0, 0, s.w
    FROM unnest(ARRAY['bionatural', 'bio', 'natural', 'natura', 'naturatherapy', 'therapy', 'terapija', 'tab', 'tabs',
                      'tablet', 'tablets', 'tableti', 'tableta', 'tbl', 'cps', 'caps', 'kaps', 'capsule', 'capsules',
                      'kapsuli', 'kapsula', 'forte', 'complex', 'kompleks', 'gel', 'krem', 'krema', 'cream', 'plus',
                      'max', 'extra', 'ekstra', 'premium', 'becker', 'set', 'paket', 'pack', 'mast', 'sirup', 'syrup',
                      'kapki', 'drops', 'sprej', 'spray', 'ampuli', 'original', 'new', 'nov', 'nova', 'kom', 'komada',
                      'kutija', 'kutii', 'box', 'dostava', 'delivery']) AS s(w)
),
-- THE fold: Macedonian Cyrillic → Latin (public.mk_geo_norm: digraphs, accents), letters only, then the same
-- spelling bridges on both sides (c/q → k, w → v, y → i, x → ks) and doubled letters collapsed
fold AS (
  SELECT t.kind, t.ref, t.part, t.word,
         regexp_replace(replace(translate(regexp_replace(public.mk_geo_norm(t.raw), '[^a-z]', '', 'g'),
                                          'cqwy', 'kkvi'), 'x', 'ks'), '(.)\1+', '\1', 'g') AS k
    FROM txt t
),
stop AS (SELECT DISTINCT f.k FROM fold f WHERE f.kind = 's'),
lines AS (
  SELECT f.ref AS tracking_id, string_agg(f.k, '' ORDER BY f.part) AS txt
    FROM fold f WHERE f.kind = 'l' GROUP BY f.ref
),
parts AS (   -- an order part's key words: ≥ 3 letters, not a stop word
  SELECT f.ref AS order_id, f.part, array_agg(f.k ORDER BY f.word) AS keys
    FROM fold f
   WHERE f.kind = 'o' AND length(f.k) >= 3 AND NOT EXISTS (SELECT 1 FROM stop s WHERE s.k = f.k)
   GROUP BY f.ref, f.part
),
prod AS (
  SELECT u.tracking_id,
         (SELECT l.txt FROM lines l WHERE l.tracking_id = u.tracking_id) AS line_txt,
         EXISTS (SELECT 1 FROM parts p WHERE p.order_id = u.order_id::text
                    AND length(array_to_string(p.keys, '')) >= 4) AS has_key,
         EXISTS (SELECT 1 FROM parts p, lines l
                  WHERE p.order_id = u.order_id::text AND l.tracking_id = u.tracking_id
                    AND length(array_to_string(p.keys, '')) >= 4
                    AND NOT EXISTS (SELECT 1 FROM unnest(p.keys) kw WHERE position(kw IN l.txt) = 0)) AS matches
    FROM uq u, prm
   WHERE u.hours > prm.product_hours
),
dec AS (
  SELECT u.*, pr.account, pr.series, pr.status_id, pr.status_name, pr.cod_mkd, pr.created_at_mex,
         pr.delivered_at, pr.returned_at, pr.last_update_at,
         CASE WHEN u.hours <= (SELECT product_hours FROM prm) THEN NULL
              WHEN pd.line_txt IS NULL OR pd.line_txt = '' OR NOT pd.has_key THEN 'product_unknown'
              WHEN NOT pd.matches THEN 'product_differs' END AS product_fail,
         EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = u.order_id) AS in_payout,
         EXISTS (SELECT 1 FROM public.affiliate_leads al WHERE al.order_id = u.order_id) AS affiliate_lead
    FROM uq u
    JOIN pr ON pr.tracking_id = u.tracking_id
    LEFT JOIN prod pd ON pd.tracking_id = u.tracking_id
),
lk AS (   -- the links, and the status each order takes from MEX
  SELECT d.*,
         CASE WHEN d.hours <= (SELECT product_hours FROM prm) THEN 'phone_date' ELSE 'phone_date_product' END AS kind,
         CASE WHEN d.status_id = 2 THEN CASE WHEN d.status = 'paid'
                                             THEN CASE WHEN d.paid_basis = 'mex' THEN NULL ELSE 'basis' END
                                             ELSE 'paid' END
              WHEN d.status_id = 7 THEN CASE WHEN d.status = 'returned' THEN NULL ELSE 'returned' END
              WHEN d.status_id = 8 THEN NULL     -- label only (MEX 8 = за пакување): linked, the status waits for the pickup
              ELSE CASE WHEN d.status = 'shipped' THEN NULL ELSE 'shipped' END END AS target
    FROM dec d
   WHERE d.product_fail IS NULL AND NOT d.in_payout AND NOT d.affiliate_lead
),
lk2 AS (   -- the plan line the hash covers: order:LL_kind:status>target:tracking
  SELECT l.*, l.order_id::text || ':LL_' || l.kind || ':' || l.status || '>' || coalesce(l.target, '=') || ':' || l.tracking_id AS line
    FROM lk l
),
mn AS (   -- every parcel with a candidate that is not linked, and why
  SELECT p.tracking_id, pr.series, pr.status_id, pr.status_name, pr.cod_mkd, pr.created_at_mex,
         CASE WHEN pc.n > 1 THEN 'ambiguous_orders'
              WHEN oc.n > 1 THEN 'order_fits_other_parcels'
              WHEN d.in_payout THEN 'in_payout'
              WHEN d.affiliate_lead THEN 'affiliate_lead'
              ELSE d.product_fail END AS reason,
         (SELECT jsonb_agg(jsonb_build_object('order_id', c.order_id, 'display_id', c.display_id, 'status', c.status,
                                              'sale_source', c.sale_source, 'hours', c.hours, 'product', c.product_name)
                           ORDER BY c.order_at) FROM cand c WHERE c.tracking_id = p.tracking_id) AS orders
    FROM (SELECT DISTINCT c.tracking_id FROM cand c) p
    JOIN pr ON pr.tracking_id = p.tracking_id
    JOIN pc ON pc.tracking_id = p.tracking_id
    LEFT JOIN cand c1 ON c1.tracking_id = p.tracking_id AND pc.n = 1
    LEFT JOIN oc ON oc.order_id = c1.order_id
    LEFT JOIN dec d ON d.tracking_id = p.tracking_id
   WHERE NOT EXISTS (SELECT 1 FROM lk2 x WHERE x.tracking_id = p.tracking_id)
)
SELECT jsonb_build_object(
  'rule', 'link-lead-parcels v1 (owner 01.10.2026): phone8 + created −10 d … +1 d, unique both ways, product by name after 72 h',
  'days', (SELECT days FROM prm),
  'at', (SELECT at FROM prm),
  'hash', encode(sha256(convert_to(coalesce((SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C") FROM lk2 x), ''), 'UTF8')), 'hex'),
  'counts', jsonb_build_object(
     'parcels', (SELECT count(*) FROM pr),
     'with_candidates', (SELECT count(*) FROM pc),
     'pairs', (SELECT count(*) FROM cand),
     'unique', (SELECT count(*) FROM uq),
     'link', (SELECT count(*) FROM lk2),
     'link_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM lk2),
     'manual', (SELECT count(*) FROM mn),
     'by_kind', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb) FROM (SELECT kind AS k, count(*) AS n FROM lk2 GROUP BY 1) z),
     'by_move', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb)
                   FROM (SELECT status || '>' || coalesce(target, '=') AS k, count(*) AS n FROM lk2 GROUP BY 1) z),
     'by_mex_status', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb)
                         FROM (SELECT coalesce(status_id::text, '?') AS k, count(*) AS n FROM lk2 GROUP BY 1) z),
     'manual_by_reason', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb) FROM (SELECT reason AS k, count(*) AS n FROM mn GROUP BY 1) z)),
  'link', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'tracking_id', x.tracking_id, 'order_id', x.order_id, 'display_id', x.display_id, 'status', x.status,
              'target', x.target, 'kind', x.kind, 'hours', x.hours, 'sale_source', x.sale_source, 'product', x.product_name,
              'account', x.account, 'series', x.series, 'mex_status_id', x.status_id, 'mex_status_name', x.status_name,
              'cod_mkd', x.cod_mkd, 'created_at_mex', x.created_at_mex, 'delivered_at', x.delivered_at,
              'returned_at', x.returned_at, 'last_update_at', x.last_update_at, 'order_at', x.order_at, 'line', x.line)
            ORDER BY x.created_at_mex, x.tracking_id), '[]'::jsonb) FROM lk2 x),
  'manual', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'tracking_id', m.tracking_id, 'series', m.series, 'mex_status_id', m.status_id, 'mex_status_name', m.status_name,
              'cod_mkd', m.cod_mkd, 'created_at_mex', m.created_at_mex, 'reason', m.reason, 'orders', m.orders)
            ORDER BY m.created_at_mex, m.tracking_id), '[]'::jsonb) FROM mn m))
$plan$;

COMMENT ON FUNCTION public.link_lead_parcels_plan(integer) IS
  'THE phone + date link rules (owner 01.10.2026, migration 20260944000950): an orphan BIO NATURAL 9110/9103 parcel (COD > 0, last N days, no order names it) → the ONE order on the same last-8 phone created −10 d … +1 d that holds no parcel, is a real priced sale (not a disposition / duplicate) and fits no other orphan parcel; more than 72 h apart the collabBox document must carry the order''s product BY NAME. Amount ignored (up-sells). Returns {hash, counts, link[], manual[]}; read-only. Applied by link_lead_parcels(true).';

-- ── 3. the snapshot the repair ledger keeps (the repair-kit shape — rollback-repair.mjs reads it) ──
-- SNAP_COLUMNS of scripts/lib/repair-kit.mjs + 'parcels' (the register rows of the order and of the linked
-- parcel). TimeZone UTC: the kit writes and compares its snapshots in UTC.
CREATE OR REPLACE FUNCTION public.link_lead_parcels_snapshot(p_order uuid, p_tracking text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
  SELECT jsonb_build_object(
           'status', o.status, 'paid_at', o.paid_at, 'returned_at', o.returned_at, 'shipped_at', o.shipped_at,
           'cancelled_at', o.cancelled_at, 'trashed_at', o.trashed_at,
           'cancellation_reason', o.cancellation_reason, 'cancellation_reason_notes', o.cancellation_reason_notes,
           'trash_reason', o.trash_reason, 'trash_reason_notes', o.trash_reason_notes,
           'mex_tracking_id', o.mex_tracking_id, 'mex_account', o.mex_account, 'mex_status_id', o.mex_status_id,
           'mex_cod_mkd', o.mex_cod_mkd, 'mex_delivered_at', o.mex_delivered_at, 'mex_returned_at', o.mex_returned_at,
           'mex_last_update_at', o.mex_last_update_at, 'paid_basis', o.paid_basis,
           'parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('tracking_id', mp.tracking_id, 'order_id', mp.order_id,
                                                                    'link_method', mp.link_method, 'linked_at', mp.linked_at)
                                                 ORDER BY mp.tracking_id)
                                  FROM public.mex_parcels mp
                                 WHERE mp.order_id = o.id OR mp.tracking_id = p_tracking), '[]'::jsonb))
    FROM public.orders o
   WHERE o.id = p_order
$function$;

-- ── 4. the apply ────────────────────────────────────────────────────────────
-- p_apply false → the plan (writes nothing). p_apply true → every planned link, each in its own
-- sub-transaction (one bad row never blocks the rest; it is listed in `skipped`), all under ONE repair run:
--   p_run NULL      a new data_repair_runs row (key link-lead-parcels, dry_run false; summary.trigger =
--                   elyon.link_trigger — 'cron' from the nightly wrapper — and run_day = the Skopje day)
--   p_run <uuid>    the dry run the backfill script recorded: refused unless it is an unapplied
--                   link-lead-parcels dry run whose candidate_hash = the plan's hash NOW (and p_expect_hash, when
--                   given) — the apply acts on exactly what was reviewed.
-- Guards: a read-write session; one apply at a time (advisory lock); every order and parcel row-locked and
-- re-checked (status as planned, still no parcel; the parcel still unlinked and named by nobody).
-- elyon.bulk_repair (no paid/returned bells) and elyon.keep_updated_at (/call-agains reads updated_at) are set
-- LOCAL. The ledger rows are the undo: node scripts/rollback-repair.mjs --run <run_id> [--loose].
CREATE OR REPLACE FUNCTION public.link_lead_parcels(p_apply boolean DEFAULT false, p_days integer DEFAULT 75,
                                                   p_run uuid DEFAULT NULL, p_expect_hash text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  c_key     CONSTANT text := 'link-lead-parcels';
  c_actor   CONSTANT text := 'System (link-lead-parcels)';
  _plan     jsonb;
  _hash     text;
  _trigger  text := coalesce(nullif(current_setting('elyon.link_trigger', true), ''), 'manual');
  _today    date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _run      uuid;
  _rr       public.data_repair_runs%ROWTYPE;
  _it       jsonb;
  _oid      uuid;
  _tr       text;
  _target   text;
  _o        public.orders%ROWTYPE;
  _p        public.mex_parcels%ROWTYPE;
  _row      bigint;
  _res      text;
  _move     text;
  _applied  integer := 0;
  _moved    integer := 0;
  _skipped  jsonb := '[]'::jsonb;
BEGIN
  _plan := public.link_lead_parcels_plan(p_days);
  IF NOT coalesce(p_apply, false) THEN
    RETURN _plan;
  END IF;
  IF current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'link_lead_parcels: apply needs a read-write session — call it with p_apply => false here'
      USING ERRCODE = '25006';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('public.link_lead_parcels')) THEN
    RAISE EXCEPTION 'link_lead_parcels: another apply holds the run lock' USING ERRCODE = '55P03';
  END IF;
  _hash := _plan ->> 'hash';
  IF p_expect_hash IS NOT NULL AND p_expect_hash IS DISTINCT FROM _hash THEN
    RAISE EXCEPTION 'link_lead_parcels: the plan changed since it was reviewed (hash % ≠ %) — dry-run again',
      left(_hash, 12), left(p_expect_hash, 12) USING ERRCODE = '40001';
  END IF;

  IF p_run IS NOT NULL THEN
    SELECT * INTO _rr FROM public.data_repair_runs WHERE id = p_run FOR UPDATE;
    IF NOT FOUND OR _rr.key IS DISTINCT FROM c_key OR NOT _rr.dry_run OR _rr.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'link_lead_parcels: run % is not an unapplied % dry run', p_run, c_key USING ERRCODE = '22023';
    END IF;
    IF _rr.candidate_hash IS DISTINCT FROM _hash THEN
      RAISE EXCEPTION 'link_lead_parcels: the plan changed since dry run % (hash % ≠ %) — dry-run again',
        p_run, left(_hash, 12), left(coalesce(_rr.candidate_hash, ''), 12) USING ERRCODE = '40001';
    END IF;
    _run := p_run;
  ELSE
    INSERT INTO public.data_repair_runs (key, dry_run, candidate_hash, summary)
    VALUES (c_key, false, _hash, jsonb_build_object('trigger', _trigger, 'run_day', _today, 'days', _plan -> 'days',
                                                    'counts', _plan -> 'counts', 'manual', _plan -> 'manual'))
    RETURNING id INTO _run;
  END IF;

  PERFORM set_config('elyon.bulk_repair', 'on', true);       -- no paid / returned bells for a batch of links
  PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- /call-agains reads orders.updated_at as the last call

  FOR _it IN SELECT e FROM jsonb_array_elements(_plan -> 'link') AS e LOOP
    _oid    := (_it ->> 'order_id')::uuid;
    _tr     := _it ->> 'tracking_id';
    _target := _it ->> 'target';
    BEGIN
      SELECT * INTO _o FROM public.orders WHERE id = _oid FOR UPDATE;
      SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _tr FOR UPDATE;
      IF _o.id IS NULL OR _p.tracking_id IS NULL
         OR _o.status::text IS DISTINCT FROM (_it ->> 'status')
         OR _o.mex_tracking_id IS NOT NULL
         OR _p.order_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = _tr) THEN
        _moved := _moved + 1;
        _skipped := _skipped || jsonb_build_array(jsonb_build_object(
                      'tracking_id', _tr, 'display_id', _it ->> 'display_id', 'why', 'moved since the plan'));
        CONTINUE;
      END IF;

      INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, evidence)
      VALUES (_run, _oid, 'LL_' || (_it ->> 'kind'), public.link_lead_parcels_snapshot(_oid, _tr),
              jsonb_build_object('key', c_key, 'order', _it ->> 'display_id', 'tracking', _tr, 'kind', _it ->> 'kind',
                                 'hours', _it -> 'hours', 'target', _target, 'parcel_status', _p.status_id,
                                 'cod_mkd', _p.cod_mkd, 'trigger', _trigger, 'line', _it ->> 'line', 'unit', 'll:' || _tr))
      RETURNING id INTO _row;

      -- MEX decides (the repair-kit's mexStatusSet): disposition fields cleared as mex-reconcile clears them
      IF _target = 'paid' THEN
        UPDATE public.orders
           SET status = 'paid', paid_at = coalesce(_p.delivered_at, _p.last_update_at, _p.created_at_mex, now()),
               returned_at = NULL, paid_basis = 'mex',
               cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
               trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
         WHERE id = _oid;
      ELSIF _target = 'returned' THEN
        UPDATE public.orders
           SET status = 'returned', returned_at = coalesce(_p.returned_at, _p.last_update_at, now()),
               paid_at = NULL, paid_basis = NULL,
               cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
               trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
         WHERE id = _oid;
      ELSIF _target = 'shipped' THEN
        UPDATE public.orders
           SET status = 'shipped', shipped_at = coalesce(_p.created_at_mex, now()),
               paid_at = NULL, paid_basis = NULL,
               cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
               trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
         WHERE id = _oid;
      ELSIF _target = 'basis' THEN
        UPDATE public.orders SET paid_basis = 'mex' WHERE id = _oid;
      END IF;

      _res := public.mex_link_parcel(_tr, _oid, 'repair', false);
      IF _res IS DISTINCT FROM 'linked' AND _res IS DISTINCT FROM 'already' THEN
        RAISE EXCEPTION 'mex_link_parcel % → %', _tr, coalesce(_res, 'null');
      END IF;

      IF _target IN ('paid', 'returned', 'shipped') THEN
        INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
        VALUES (_oid, _o.status, _target::public.order_status, NULL, c_actor);
      END IF;

      _move := CASE WHEN _target IN ('paid', 'returned', 'shipped')
                    THEN format('The status follows MEX: %s → %s.', _o.status, _target)
                    WHEN _target = 'basis' THEN 'The order was already paid; MEX now proves it (paid basis mex).'
                    WHEN _p.status_id = 8 THEN 'The parcel is at MEX 8 (за пакување): the status waits for the courier''s pickup.'
                    ELSE format('The status (%s) already matches MEX.', _o.status) END;
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      VALUES (_oid,
              format('MEX parcel %s (%s, %s, COD %s ден, created %s) linked by the phone + date rule (owner 01.10.2026): '
                     || 'the same customer by the last 8 digits, this order created %s, %s h before the parcel — the only '
                     || 'order that fits the parcel, and it fits no other parcel%s. %s Nothing was sent to AlterCPA. '
                     || 'Run %s (undo: scripts/rollback-repair.mjs --run %s).',
                     _tr, coalesce(_p.account, '?'), trim(coalesce(_p.status_id::text, '?') || ' ' || coalesce(_p.status_name, '')),
                     replace(to_char(_p.cod_mkd, 'FM999,999,990'), ',', '.'),
                     to_char(_p.created_at_mex AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                     to_char(_o.created_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                     _it ->> 'hours',
                     CASE WHEN _it ->> 'kind' = 'phone_date_product'
                          THEN '; more than 72 h apart, so the product was checked by name: collabBox document ' || _tr || ' carries it'
                          ELSE '' END,
                     _move, left(_run::text, 8), _run),
              NULL, c_actor);

      UPDATE public.data_repair_rows SET after = public.link_lead_parcels_snapshot(_oid, _tr) WHERE id = _row;
      _applied := _applied + 1;
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped || jsonb_build_array(jsonb_build_object(
                    'tracking_id', _tr, 'display_id', _it ->> 'display_id', 'why', left(SQLERRM, 300)));
    END;
  END LOOP;

  UPDATE public.data_repair_runs
     SET applied_at = now(),
         summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', jsonb_build_object(
                     'trigger', _trigger, 'run_day', _today, 'applied', _applied, 'moved', _moved,
                     'skipped', _skipped, 'at', now()))
   WHERE id = _run;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'hash', _hash, 'trigger', _trigger, 'days', _plan -> 'days',
                            'counts', _plan -> 'counts', 'applied', _applied, 'moved', _moved, 'skipped', _skipped);
END;
$function$;

COMMENT ON FUNCTION public.link_lead_parcels(boolean, integer, uuid, text) IS
  'Applies link_lead_parcels_plan() (owner 01.10.2026, migration 20260944000950): mex_link_parcel(…, ''repair''), the order follows MEX (2 → paid, 7 → returned, 8 → unchanged, else → shipped), order_history + one order note, the repair ledger data_repair_runs/rows (key link-lead-parcels — undo: scripts/rollback-repair.mjs --run <id>). p_run = a reviewed dry run (hash-checked). Never pushes to AlterCPA, never changes a price (repair-cod-price.mjs follows the COD).';

-- ── 5. the nightly wrapper (the cron) ───────────────────────────────────────
-- app_settings.link_lead_parcels: mode 'report' (the plan is recorded as a link-lead-parcels DRY RUN — the
-- owner can apply that very run with the backfill script) | 'apply' | 'off'; days (default 75); hour
-- (default = no_parcel_rule.hour, 21). One scheduled run per Skopje day. _force = a manual run now.
CREATE OR REPLACE FUNCTION public.link_lead_parcels_nightly(_force boolean DEFAULT false)
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
BEGIN
  _today := _now::date;
  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'link_lead_parcels';
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
                WHERE r.key = 'link-lead-parcels' AND r.summary ->> 'trigger' = 'cron'
                  AND r.summary ->> 'run_day' = _today::text) THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
  END IF;

  PERFORM set_config('elyon.link_trigger', CASE WHEN _force THEN 'manual' ELSE 'cron' END, true);
  IF _mode = 'apply' THEN
    RETURN public.link_lead_parcels(true, _days);
  END IF;

  _plan := public.link_lead_parcels_plan(_days);
  INSERT INTO public.data_repair_runs (key, dry_run, candidate_hash, summary)
  VALUES ('link-lead-parcels', true, _plan ->> 'hash',
          jsonb_build_object('trigger', CASE WHEN _force THEN 'manual' ELSE 'cron' END, 'run_day', _today,
                             'mode', 'report', 'days', _days, 'counts', _plan -> 'counts',
                             'link', _plan -> 'link', 'manual', _plan -> 'manual'))
  RETURNING id INTO _id;
  RETURN jsonb_build_object('ok', true, 'mode', 'report', 'run_id', _id, 'hash', _plan ->> 'hash', 'counts', _plan -> 'counts');
END;
$function$;

COMMENT ON FUNCTION public.link_lead_parcels_nightly(boolean) IS
  'pg_cron ''link-lead-parcels'' (2 * * * *, self-gated to the no-parcel rule''s hour → 21:02 Skopje, after the 20:52 mex-reconcile pass, before the 21:10 no-parcel rule; once per Skopje day). app_settings.link_lead_parcels {mode report|apply|off, days 75, hour}. Migration 20260944000950.';

-- ── 6. grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.link_lead_parcels_plan(integer)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_lead_parcels_snapshot(uuid, text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_lead_parcels(boolean, integer, uuid, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_lead_parcels_nightly(boolean)                    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_lead_parcels_plan(integer)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.link_lead_parcels_snapshot(uuid, text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.link_lead_parcels(boolean, integer, uuid, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.link_lead_parcels_nightly(boolean)                 TO service_role;
-- the read-only verification path (Management API, read_only: true): the backfill's dry run and
-- scripts/verify-parcel-link-rules.mjs call the PLAN only
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.link_lead_parcels_plan(integer) TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 7. schedule — hourly at :02, self-gated to the no-parcel rule's hour ────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'link-lead-parcels') THEN
    PERFORM cron.unschedule('link-lead-parcels');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'link-lead-parcels',
  '2 * * * *',
  $job$SELECT public.link_lead_parcels_nightly();$job$
);

COMMIT;
