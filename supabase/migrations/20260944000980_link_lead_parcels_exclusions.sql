-- ============================================================================
-- Phone + date links: drop the candidates that cannot be the parcel's sale BEFORE the uniqueness check
-- (owner, Mile, 01.10.2026 — "the safe rule")
-- ============================================================================
-- OWNER LAW (01.10.2026, unchanged): the truth is MEX (+ collabBox), never AlterCPA. NOTHING is pushed to AlterCPA.
--
-- WHY: of the 41 parcels the nightly linker (20260944000950) left on the manual list on 01.10.2026, a read-only
-- reviewer found two patterns that are certain, not judgement (exports/MEX_рачна_проверка_предлог_2026-10-01.xlsx,
-- sheet Збир, "Предлог за ноќното правило", A):
--   (1) the later leads of the same customer are decided as DUPLICATES ("веќе нарачал" — the sale is the first lead);
--   (2) an AlterCPA lead that reached the CRM AFTER the parcel's collabBox document was booked cannot be that sale.
-- Simulated on that list: 8 of the 41 resolve by themselves, all 8 the same pick as the human proposal, 0 wrong.
--
-- THE ONE CHANGE — rule 2b, between rule 2 (the candidates) and rule 3 (unique both ways). A candidate pair is dropped
-- when:
--   duplicate      the ORDER is cancelled / trashed AS A DUPLICATE — exactly one of the CRM's own marks:
--                    a. cancellation_reason = 'duplicate_order' (cancelled) or trash_reason = 'duplicate_order' (trashed)
--                       — the CRM's reason value, also what the bridge writes for an AlterCPA CANCEL reason 7;
--                    b. trashed, trash_reason 'other' and trash_reason_notes = 'duplicate' or 'duplicate — …' — what the
--                       bridge / history import writes for an AlterCPA TRASH reason 7 (crmReasonFor: the label
--                       "duplicate" kept ahead of the operator's comment);
--                    c. the AlterCPA mirror itself: an altercpa_leads row of the order with decision 'trashed', reason 7.
--                  NOT a duplicate: an operator's free text alone ("веќе нарачал", "вчера нарачала" — not a mark); the
--                  status 'duplicated' (never a candidate already — and in this CRM it is the re-issue COPY made by
--                  POST /orders/:id/duplicate, not a duplicate lead); a duplicate mark on an order that is NOT dead
--                  (confirmed / paid / …: the CRM overrode AlterCPA — kept).
--   after_booking  an AlterCPA LEAD order (sale_source_detail 'bridge' / 'history', or an altercpa_leads row) that came
--                  into existence AFTER the parcel was booked in collabBox:
--                    booking = collabbox_sale_at(doc_at, booked_at) of the document whose doc_number = the tracking id
--                              (THE sale time, 20260944000500/0600 — booked_at when earlier than doc_at, else doc_at:
--                              July documents with no earlier booking use doc_at); no live document → no booking →
--                              nothing dropped;
--                    lead     = the EARLIEST evidence the lead existed: least(orders.created_at,
--                              altercpa_leads.created_remote);
--                    a history import (sale_source_detail 'history') or an order stamped at the import's placeholder
--                    14:00:00 Skopje carries a DATE only → compared by Skopje DAY (dropped only when its day is after
--                    the booking's day); every other lead by the instant (strictly after).
-- Every other rule is IDENTICAL to 20260944000950 (rule 1 parcels, rule 2 candidates, rule 3 unique both ways — now over
-- the kept candidates —, rule 4 product by name after 72 h, the payout / affiliate safety, the MEX status law, the
-- hash). The manual list keeps EVERY parcel with a candidate that is not linked (so leads_parcel_orders_plan,
-- 20260944000970, still sees it as "a link-plan candidate" — a LEADS document never becomes an order beside a CRM lead);
-- a parcel whose candidates were ALL dropped is listed with the new reason 'only_excluded_candidates'; each listed
-- candidate carries 'excluded' (null / duplicate / after_booking). counts: + excluded, excluded_by_reason.
--
-- Reference (read-only, 01.10.2026 ~23:55 Skopje, the 0950 body vs this body, both inline): 156 orphan parcels, 98
-- candidate pairs; before 4 link (13.640 ден) / 40 manual (37 ambiguous, 3 product_differs) → after 11 link (33.840 ден)
-- / 33 manual (29 ambiguous, 4 product_differs); 16 pairs dropped (11 duplicate, 5 after_booking). The 7 new links are
-- exactly the reviewer's picks (002-9110-170060 → ORD-77627, 170439 → ORD-78381, 171067 → ORD-79621, 172768 → ORD-88294,
-- 173105 → ORD-88912, 173593 → ORD-90570, 176564 → ORD-107936); 172523 (ЗА ГАЗДАТА) narrows to one candidate that
-- fails the product check → stays manual. No existing link is lost.
-- Revert: re-apply the plan body of 20260944000950 (md5 bb592cb550602f8dc27c59b06db49452) — nothing else changes.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    -- the 20260944000950 plan body (old) / this file's (new, re-run)
    ('public.link_lead_parcels_plan(integer)', 'bb592cb550602f8dc27c59b06db49452', '8ac592c7dcc2f1d9f68319bdd2d05e16')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'link lead parcels exclusions: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF to_regprocedure('public.collabbox_sale_at(timestamp with time zone,timestamp with time zone)') IS NULL
     OR to_regclass('public.altercpa_leads') IS NULL OR to_regclass('public.collabbox_documents') IS NULL THEN
    RAISE EXCEPTION 'link lead parcels exclusions: collabbox_sale_at / altercpa_leads / collabbox_documents are required';
  END IF;
  -- the callers read the plan's link[] / manual[] / hash — they must still be the 20260944000950 / 0970 bodies
  IF to_regprocedure('public.link_lead_parcels(boolean,integer,uuid,text)') IS NULL
     OR to_regprocedure('public.link_lead_parcels_nightly(boolean)') IS NULL THEN
    RAISE EXCEPTION 'link lead parcels exclusions: link_lead_parcels / link_lead_parcels_nightly (20260944000950) are required';
  END IF;
END
$drift$;

-- ── THE rules: the plan (one read-only SELECT; $1 = days) ────────────────────
-- The LIVE body (md5 bb592cb550602f8dc27c59b06db49452, 20260944000950) with ONE edit: rule 2b (cx / ck) between the
-- candidates and the uniqueness check, the manual list's reason / 'excluded' marker, two counts, the rule text.
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
-- rule 2b (owner 01.10.2026, 20260944000980): a candidate that cannot be the parcel's sale is dropped BEFORE the
-- uniqueness check — the order was decided as a DUPLICATE (the CRM's / the bridge's / the mirror's own mark, never
-- free text), or it is an AlterCPA lead that came into existence after the parcel was booked in collabBox
cx AS MATERIALIZED (
  SELECT c.tracking_id, c.order_id,
         CASE WHEN c.status IN ('cancelled', 'trashed')
                   AND (   (c.status = 'cancelled' AND o.cancellation_reason = 'duplicate_order')
                        OR (c.status = 'trashed' AND o.trash_reason = 'duplicate_order')
                        OR (c.status = 'trashed' AND o.trash_reason = 'other'
                            AND o.trash_reason_notes ~* '^duplicate( —|$)')
                        OR EXISTS (SELECT 1 FROM public.altercpa_leads l
                                    WHERE l.order_id = c.order_id AND l.decision = 'trashed' AND l.reason = 7))
              THEN 'duplicate'
              WHEN bk.at IS NOT NULL
                   AND (o.sale_source_detail IN ('bridge', 'history') OR la.n > 0)
                   AND CASE WHEN o.sale_source_detail = 'history'
                                 OR (o.created_at AT TIME ZONE 'Europe/Skopje')::time = time '14:00:00'
                            THEN (least(o.created_at, la.lead_at) AT TIME ZONE 'Europe/Skopje')::date
                                 > (bk.at AT TIME ZONE 'Europe/Skopje')::date
                            ELSE least(o.created_at, la.lead_at) > bk.at END
              THEN 'after_booking' END AS excluded
    FROM cand c
    JOIN public.orders o ON o.id = c.order_id
    LEFT JOIN LATERAL (SELECT min(l.created_remote) AS lead_at, count(*) AS n FROM public.altercpa_leads l
                        WHERE l.order_id = c.order_id) la ON true
    LEFT JOIN LATERAL (SELECT public.collabbox_sale_at(d.doc_at, d.booked_at) AS at FROM public.collabbox_documents d
                        WHERE d.doc_number = c.tracking_id AND d.vanished_at IS NULL AND d.doc_at IS NOT NULL
                        LIMIT 1) bk ON true
),
ck AS MATERIALIZED (   -- the candidates rule 3 counts: every candidate rule 2b kept
  SELECT c.* FROM cand c
   WHERE NOT EXISTS (SELECT 1 FROM cx WHERE cx.tracking_id = c.tracking_id AND cx.order_id = c.order_id
                                        AND cx.excluded IS NOT NULL)
),
pc AS (SELECT c.tracking_id, count(*)::int AS n FROM ck c GROUP BY 1),
oc AS (SELECT c.order_id, count(*)::int AS n FROM ck c GROUP BY 1),
-- rule 3: unique both ways
uq AS MATERIALIZED (
  SELECT c.* FROM ck c
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
mn AS (   -- every parcel with a candidate that is not linked, and why (a parcel rule 2b emptied stays listed)
  SELECT p.tracking_id, pr.series, pr.status_id, pr.status_name, pr.cod_mkd, pr.created_at_mex,
         CASE WHEN pc.n IS NULL THEN 'only_excluded_candidates'
              WHEN pc.n > 1 THEN 'ambiguous_orders'
              WHEN oc.n > 1 THEN 'order_fits_other_parcels'
              WHEN d.in_payout THEN 'in_payout'
              WHEN d.affiliate_lead THEN 'affiliate_lead'
              ELSE d.product_fail END AS reason,
         (SELECT jsonb_agg(jsonb_build_object('order_id', c.order_id, 'display_id', c.display_id, 'status', c.status,
                                              'sale_source', c.sale_source, 'hours', c.hours, 'product', c.product_name,
                                              'excluded', x.excluded)
                           ORDER BY c.order_at)
            FROM cand c JOIN cx x ON x.tracking_id = c.tracking_id AND x.order_id = c.order_id
           WHERE c.tracking_id = p.tracking_id) AS orders
    FROM (SELECT DISTINCT c.tracking_id FROM cand c) p
    JOIN pr ON pr.tracking_id = p.tracking_id
    LEFT JOIN pc ON pc.tracking_id = p.tracking_id
    LEFT JOIN ck c1 ON c1.tracking_id = p.tracking_id AND pc.n = 1
    LEFT JOIN oc ON oc.order_id = c1.order_id
    LEFT JOIN dec d ON d.tracking_id = p.tracking_id
   WHERE NOT EXISTS (SELECT 1 FROM lk2 x WHERE x.tracking_id = p.tracking_id)
)
SELECT jsonb_build_object(
  'rule', 'link-lead-parcels v2 (owner 01.10.2026): phone8 + created −10 d … +1 d, duplicates and AlterCPA leads created after the collabBox booking dropped, unique both ways, product by name after 72 h',
  'days', (SELECT days FROM prm),
  'at', (SELECT at FROM prm),
  'hash', encode(sha256(convert_to(coalesce((SELECT string_agg(x.line, E'\n' ORDER BY x.line COLLATE "C") FROM lk2 x), ''), 'UTF8')), 'hex'),
  'counts', jsonb_build_object(
     'parcels', (SELECT count(*) FROM pr),
     'with_candidates', (SELECT count(DISTINCT c.tracking_id) FROM cand c),
     'pairs', (SELECT count(*) FROM cand),
     'excluded', (SELECT count(*) FROM cx WHERE cx.excluded IS NOT NULL),
     'excluded_by_reason', (SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb)
                              FROM (SELECT excluded AS k, count(*) AS n FROM cx WHERE excluded IS NOT NULL GROUP BY 1) z),
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
  'THE phone + date link rules (owner 01.10.2026, migrations 20260944000950 + 0980): an orphan BIO NATURAL 9110/9103 parcel (COD > 0, last N days, no order names it) → the ONE order on the same last-8 phone created −10 d … +1 d that holds no parcel, is a real priced sale (not a disposition / duplicate) and fits no other orphan parcel — after dropping (0980) the candidates cancelled / trashed AS A DUPLICATE (duplicate_order, the bridge''s "duplicate — …", the mirror''s trashed reason 7) and the AlterCPA leads that came into existence after the parcel''s collabBox booking (collabbox_sale_at; a date-only history import by Skopje day); more than 72 h apart the collabBox document must carry the order''s product BY NAME. Amount ignored (up-sells). Returns {hash, counts, link[], manual[]}; read-only. Applied by link_lead_parcels(true).';

COMMIT;
