-- ============================================================================
-- THE STAMP PLAN COUNTS A MEX FLIP ONLY WHILE THE PARCEL IS STILL THERE
-- (owner, 01.10.2026 — seller matching; NOT applied)
--
-- WHY. order_decider_plan() (20260939000300) lists a REAL SALE when it IS a sale now, OR
-- order_history shows it became one (its first step into confirmed / shipped / delivered /
-- paid / returned), OR AlterCPA approved it. The middle test also lists 60 AlterCPA leads
-- (01.10.2026, live) whose only "sale" was a `System (mex)` flip that a repair has since
-- undone: cancelled / trashed again, no parcel, last change `System (repair…)`. They are not
-- sales — no cohort counts them (cohort_order_bucket → cancelled / trashed) — yet the cron
-- reports them as `unresolved` every five minutes (bucket "AlterCPA cancelled · first sale by
-- System (mex)") and the seller hunt kept finding them.
--
-- THE RULE. A first step into a sale makes the order a sale that WAS only when a PERSON took
-- it (the plan's existing fr_human test: not 'System (…)', not an annotated '… — …' row) or
-- when the order STILL HOLDS A PARCEL (orders.mex_tracking_id, or a mex_parcels row linked to
-- it — the MEX proof). Everything else is unchanged: a sale status now and an AlterCPA
-- approval / cancel_other still list the order by themselves; every rule, time, person and
-- bucket is the same; only the population shrinks.
--   The owner's words were "from MEX and the order still holds a parcel". "A person, or the
--   parcel is still there" drops the same unstamped orders today (all 60 first steps are
--   `System (mex)`) and stays right for the other MEX-backed writers (link-lead-parcels, the
--   collabBox writer), whose first step is only as good as the parcel behind it. It also drops
--   46 STAMPED history imports whose first step was `System (altercpa:cancel-other-is-paid)` and
--   that the no-parcel rule / a repair cancelled since — the strict wording drops them too
--   (no person, not MEX). A bridge lead's AlterCPA approval / cancel_other keeps listing it by
--   the ledger clause, so "approved, never shipped" stays credited to its operator.
--
-- LIVE IMPACT (read-only, 02.10.2026 ~00:30 Skopje, the old vs the new body over 10 years):
--   unstamped (what the cron sees)  1.107 → 1.047 rows, all unresolved: −60 = 47 cancelled + 13
--                                   trashed altercpa/bridge, no parcel, first step System (mex)
--   incl. already stamped           299.451 → 299.189: also −202 stamped orders (200 history
--                                   imports via `import` + 2 bridge), cancelled / trashed now, no
--                                   parcel. Their stamps are write-once and STAY; no cohort counts
--                                   them; verify-stamp-parity check 3 shows them as "not in plan",
--                                   never as a diff.
--
-- KEEP IN STEP: scripts/backfill-order-deciders.mjs planPageSql carries the same change, and
-- scripts/verify-stamp-parity.mjs now reads the NEWEST migration that defines the function
-- (this one), so it proves the twins equal before AND after this is applied.
-- The body is re-emitted from the LIVE function (pg_proc.prosrc md5
-- 63b774c4f445fc380b46ff8659b0b948 = the body of 20260939000300); the only edits are
-- o.mex_tracking_id, x.holds_parcel and the WHERE of r.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.order_decider_plan(
  p_since interval DEFAULT interval '14 days'
)
RETURNS TABLE (
  order_id   uuid,
  display_id text,
  action     text,
  src        text,
  det        text,
  status     text,
  rule       text,
  via        text,
  sold_at    timestamptz,
  person_id  uuid,
  ext        text,
  bucket     text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$

WITH o AS (
  -- Candidates = real sales without sold_at (price > 0, not synthetic, not an
  -- unworked duplicate) touched in the window; "is or was a sale" is applied
  -- after the joins (r).
  SELECT o.id, o.display_id, o.status::text AS status, o.price, o.duplicated_from,
         o.confirmed_by_agent_id, o.confirmed_by_name, o.assigned_agent_name, o.confirmed_at, o.created_at,
         o.mex_tracking_id,
         coalesce(o.sale_source, cl.c[1])        AS src,
         coalesce(o.sale_source_detail, cl.c[2]) AS det
    FROM public.orders o
    CROSS JOIN LATERAL (SELECT public.classify_sale_source(o.source_type, o.external_source, o.external_order_id,
                                                           o.prediction_list_id, o.price, o.product_name) AS c) cl
   WHERE o.sold_at IS NULL /*SCOPE_SOLD*/
     AND coalesce(o.price, 0) > 0
     AND NOT public.is_synthetic_product_name(o.product_name)
     AND o.status::text <> 'duplicated'
     AND (   o.created_at >= now() - p_since
          OR o.updated_at >= now() - p_since
          OR o.id IN (SELECT h.order_id FROM public.order_history h
                       WHERE h.changed_at >= now() - p_since
                         AND h.to_status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
          OR o.id IN (SELECT l.order_id FROM public.altercpa_leads l
                       WHERE l.order_id IS NOT NULL
                         AND (l.decided_at >= now() - p_since OR l.phase_seen_at >= now() - p_since)))
), fr AS (
  -- the FIRST transition into a sale status, and who made it
  SELECT DISTINCT ON (h.order_id) h.order_id, h.changed_at, h.changed_by, h.changed_by_name,
         (coalesce(h.changed_by_name, '') NOT LIKE 'System (%'
          AND coalesce(h.changed_by_name, '') NOT LIKE '% — %'
          AND (h.changed_by IS NOT NULL OR h.changed_by_name IS NOT NULL)) AS human
    FROM public.order_history h
    JOIN o ON o.id = h.order_id
   WHERE h.to_status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     AND (h.from_status IS NULL OR h.from_status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
   ORDER BY h.order_id, h.changed_at, h.id
), led AS (
  SELECT DISTINCT ON (l.order_id) l.order_id, l.account_id, l.decision, l.decided_by_altercpa_user, l.decided_at
    FROM public.altercpa_leads l
    JOIN o ON o.id = l.order_id
   ORDER BY l.order_id, l.last_seen_at DESC, l.id
), push AS (
  -- a real CRM APPROVAL push of this order (params.accept = '1' — a callback
  -- or cancel push never makes a sale) landing around AlterCPA's decision,
  -- and the agent its comment names ("Agent: <name> — <reason>"; the push
  -- always writes it, because AlterCPA has no operator-name param)
  SELECT DISTINCT ON (led.order_id) led.order_id, a.actor_id, a.created_at, p.full_name AS actor_name,
         nullif(btrim(split_part(substring(a.payload -> 'params' ->> 'comment' FROM '^Agent: (.*)$'), ' — ', 1)), '')
           AS agent_name
    FROM led
    JOIN public.audit_log a
      ON a.target_type = 'order' AND a.target_id = led.order_id::text
     AND a.action = 'order.altercpa_push'
     AND (a.payload ->> 'noop') IS DISTINCT FROM 'true'
     AND a.payload -> 'params' ->> 'accept' = '1'
     AND a.created_at BETWEEN led.decided_at - interval '15 minutes' AND led.decided_at + interval '5 minutes'
    LEFT JOIN public.profiles p ON p.user_id = a.actor_id
   WHERE led.decided_at IS NOT NULL
   ORDER BY led.order_id, abs(extract(epoch FROM (a.created_at - led.decided_at)))
), x AS (
  SELECT o.*,
         (fr.order_id IS NOT NULL) AS has_fr, coalesce(fr.human, false) AS fr_human,
         fr.changed_at AS fr_at, fr.changed_by AS fr_by, fr.changed_by_name AS fr_name,
         (led.order_id IS NOT NULL) AS has_led, led.account_id, led.decision,
         led.decided_by_altercpa_user AS alt_user, led.decided_at,
         push.actor_id AS push_by, push.actor_name AS push_name, push.agent_name AS push_agent,
         (o.mex_tracking_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.order_id = o.id)) AS holds_parcel,
         CASE WHEN lower(btrim(coalesce(o.confirmed_by_name, ''))) IN ('', 'import', 'system')
              THEN nullif(btrim(o.assigned_agent_name), '')
              ELSE o.confirmed_by_name END AS hist_name
    FROM o
    LEFT JOIN fr   ON fr.order_id = o.id
    LEFT JOIN led  ON led.order_id = o.id
    LEFT JOIN push ON push.order_id = o.id
), r AS (
  SELECT x.*,
    CASE
      -- Imports name their operator or they have no decider: a nameless row is
      -- reported, never stamped with an empty key.
      WHEN x.src = 'collabbox' AND nullif(btrim(x.confirmed_by_name), '') IS NOT NULL THEN 'collabbox_author'
      WHEN x.src = 'altercpa' AND x.det = 'history' AND x.duplicated_from IS NULL AND x.hist_name IS NOT NULL THEN 'history_import'
      WHEN x.fr_human THEN CASE WHEN x.push_by IS NOT NULL AND x.decision IN ('approved', 'cancel_other')
                                THEN 'crm_decided_pushed' ELSE 'crm_decided' END
      -- An approval push that names no agent leaves the order unresolved: the
      -- manager who pressed it is not the seller, and AlterCPA's ledger user
      -- for a pushed approval is the push token's account.
      WHEN x.src = 'altercpa' AND x.decision IN ('approved', 'cancel_other')
        THEN CASE WHEN x.push_by IS NULL THEN 'altercpa_ledger'
                  WHEN x.push_agent IS NOT NULL THEN 'crm_push_only' END
      -- Pre-history rows only, and never an AlterCPA order: a confirmer recorded
      -- on those can be whoever moved the parcel on, not who sold it.
      WHEN NOT x.has_fr AND x.src <> 'altercpa' AND x.confirmed_by_agent_id IS NOT NULL THEN 'crm_confirmer'
      WHEN NOT x.has_fr AND x.src = 'elyon_crm' AND nullif(btrim(x.confirmed_by_name), '') IS NOT NULL THEN 'crm_confirmer'
    END AS rule
    FROM x
   WHERE x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
      -- 2026-10-01 (owner): a first step into a sale makes it a sale that WAS only when a
      -- person took it, or when the order still holds a parcel (the MEX proof). A
      -- `System (mex)` flip that a repair has since undone (cancelled / trashed again,
      -- parcel taken away) is not a sale — 60 AlterCPA leads on 01.10.2026.
      OR (x.has_fr AND (x.fr_human OR x.holds_parcel))
      OR (x.src = 'altercpa' AND x.decision IN ('approved', 'cancel_other'))
), s AS (
  SELECT r.id, r.display_id, r.src, r.det, r.status, r.rule,
    CASE r.rule
      WHEN 'collabbox_author'   THEN 'collabbox'
      WHEN 'history_import'     THEN 'import'
      WHEN 'crm_decided'        THEN 'crm'
      WHEN 'crm_decided_pushed' THEN 'crm_push'
      WHEN 'crm_push_only'      THEN 'crm_push'
      WHEN 'altercpa_ledger'    THEN 'altercpa'
      WHEN 'crm_confirmer'      THEN 'crm'
    END AS via,
    CASE r.rule
      WHEN 'collabbox_author'   THEN coalesce(r.confirmed_at, r.created_at)
      WHEN 'history_import'     THEN coalesce(r.confirmed_at, r.created_at)
      WHEN 'crm_decided'        THEN r.fr_at
      WHEN 'crm_decided_pushed' THEN r.fr_at
      WHEN 'crm_push_only'      THEN r.decided_at
      WHEN 'altercpa_ledger'    THEN r.decided_at
      WHEN 'crm_confirmer'      THEN coalesce(r.confirmed_at, r.created_at)
    END AS sold_at,
    CASE r.rule
      WHEN 'collabbox_author' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.confirmed_by_name
            AND i.kind = ANY (ARRAY['collabbox_author', 'order_name'])
          ORDER BY array_position(ARRAY['collabbox_author', 'order_name'], i.kind) LIMIT 1)
      WHEN 'history_import' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.hist_name
            AND i.kind = ANY (ARRAY['order_name', 'collabbox_author'])
          ORDER BY array_position(ARRAY['order_name', 'collabbox_author'], i.kind) LIMIT 1)
      WHEN 'crm_decided' THEN coalesce(
        (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = r.fr_by),
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.fr_name AND i.kind = 'order_name' LIMIT 1))
      WHEN 'crm_decided_pushed' THEN coalesce(
        (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = r.fr_by),
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.fr_name AND i.kind = 'order_name' LIMIT 1))
      WHEN 'crm_push_only' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.push_agent AND i.kind = 'order_name' LIMIT 1)
      WHEN 'altercpa_ledger' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.kind = 'altercpa_user' AND i.account_id = r.account_id
            AND i.value = r.alt_user::text)
      WHEN 'crm_confirmer' THEN coalesce(
        (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = r.confirmed_by_agent_id),
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = r.confirmed_by_name AND i.kind = 'order_name' LIMIT 1))
    END AS person_id,
    CASE r.rule
      WHEN 'collabbox_author'   THEN r.confirmed_by_name
      WHEN 'history_import'     THEN r.hist_name
      WHEN 'crm_decided'        THEN coalesce(r.fr_name, r.fr_by::text)
      WHEN 'crm_decided_pushed' THEN coalesce(r.fr_name, r.fr_by::text)
      WHEN 'crm_push_only'      THEN r.push_agent
      WHEN 'altercpa_ledger'    THEN r.alt_user::text
      WHEN 'crm_confirmer'      THEN coalesce(nullif(btrim(r.confirmed_by_name), ''), r.confirmed_by_agent_id::text)
    END AS ext,
    CASE WHEN r.rule IS NULL THEN concat_ws(' · ',
      r.src || '/' || r.det,
      'AlterCPA ' || coalesce(r.decision, CASE WHEN r.has_led THEN 'open' ELSE 'no ledger row' END),
      CASE WHEN r.src = 'collabbox' OR (r.src = 'altercpa' AND r.det = 'history' AND r.duplicated_from IS NULL)
           THEN 'no operator name on the import' END,
      CASE WHEN r.push_by IS NOT NULL AND r.push_agent IS NULL THEN 'approval pushed naming no agent' END,
      'first sale by ' || CASE WHEN NOT r.has_fr THEN 'nobody on record'
                               ELSE regexp_replace(coalesce(r.fr_name, '?'), '^System \(([^:)]*).*$', 'System (\1)') END)
    END AS bucket
  FROM r
), fo AS (
  -- Already stamped, no person yet, and the raw key might now name someone.
  SELECT o.id, o.display_id, o.status::text AS status, o.sale_source, o.sale_source_detail,
         o.sold_at, o.sold_via, o.sold_by_ext, o.confirmed_by_agent_id, o.confirmed_by_name
    FROM public.orders o
   WHERE o.sold_at IS NOT NULL
     AND o.sold_by_person_id IS NULL
     AND o.sold_by_ext IS NOT NULL
     AND (o.sold_via IN ('crm', 'crm_push')
          OR o.sold_by_ext IN (SELECT i.value FROM public.sales_person_identities i))
), f AS (
  SELECT fo.*,
    CASE fo.sold_via
      WHEN 'altercpa' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.kind = 'altercpa_user' AND i.value = fo.sold_by_ext
            AND i.account_id = (SELECT l.account_id FROM public.altercpa_leads l
                                 WHERE l.order_id = fo.id
                                 ORDER BY l.last_seen_at DESC, l.id LIMIT 1))
      WHEN 'collabbox' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = fo.sold_by_ext
            AND i.kind = ANY (ARRAY['collabbox_author', 'order_name'])
          ORDER BY array_position(ARRAY['collabbox_author', 'order_name'], i.kind) LIMIT 1)
      WHEN 'import' THEN
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = fo.sold_by_ext
            AND i.kind = ANY (ARRAY['order_name', 'collabbox_author'])
          ORDER BY array_position(ARRAY['order_name', 'collabbox_author'], i.kind) LIMIT 1)
      WHEN 'crm' THEN coalesce(
        CASE WHEN fo.sold_by_ext ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = fo.sold_by_ext::uuid) END,
        CASE WHEN fo.sold_by_ext = nullif(btrim(fo.confirmed_by_name), '')
             THEN (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = fo.confirmed_by_agent_id) END,
        (SELECT sp.id FROM public.order_history h
           JOIN public.sales_people sp ON sp.user_id = h.changed_by
          WHERE h.order_id = fo.id AND h.changed_by_name = fo.sold_by_ext
            AND h.to_status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
            AND (h.from_status IS NULL OR h.from_status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
          ORDER BY h.changed_at, h.id LIMIT 1),
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = fo.sold_by_ext AND i.kind = 'order_name' LIMIT 1))
      -- never through the pusher (review defect 1): a crm_push ext is the
      -- deciding agent's name, not the manager who pressed the button
      WHEN 'crm_push' THEN coalesce(
        CASE WHEN fo.sold_by_ext ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = fo.sold_by_ext::uuid) END,
        (SELECT sp.id FROM public.order_history h
           JOIN public.sales_people sp ON sp.user_id = h.changed_by
          WHERE h.order_id = fo.id AND h.changed_by_name = fo.sold_by_ext
            AND h.to_status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
            AND (h.from_status IS NULL OR h.from_status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
          ORDER BY h.changed_at, h.id LIMIT 1),
        (SELECT i.person_id FROM public.sales_person_identities i
          WHERE i.account_id IS NULL AND i.value = fo.sold_by_ext AND i.kind = 'order_name' LIMIT 1))
    END AS person_id
    FROM fo
)
SELECT s.id AS order_id, s.display_id,
       CASE WHEN s.rule IS NULL THEN 'unresolved' WHEN s.sold_at IS NULL THEN 'no_time' ELSE 'stamp' END AS action,
       s.src, s.det, s.status, s.rule, s.via, s.sold_at, s.person_id, s.ext, s.bucket
  FROM s
UNION ALL
SELECT f.id, f.display_id, 'fill_person',
       f.sale_source, f.sale_source_detail, f.status, 'person_fill', f.sold_via, f.sold_at, f.person_id, f.sold_by_ext, NULL::text
  FROM f
 WHERE f.person_id IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.order_decider_plan(interval) IS
  '2026-09-28 / 2026-10-01: read-only plan of stamp_order_deciders() — a faithful SQL port of scripts/backfill-order-deciders.mjs planPageSql (keep in step). One row per in-scope order: action stamp | no_time | unresolved (bucket says why) | fill_person (already stamped, sold_by_ext now resolves to a person). A first step into a sale counts only when a person took it or the order still holds a parcel (20260944001200). Pure SQL, no temp tables: runs in a read-only transaction.';

-- privileges as in 20260939000300 (CREATE OR REPLACE keeps them; restated so this file stands alone)
REVOKE ALL ON FUNCTION public.order_decider_plan(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_decider_plan(interval) TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.order_decider_plan(interval) TO supabase_read_only_user;
  END IF;
END
$grant$;
