-- ============================================================================
-- STAMP ORDER DECIDERS EVERY 5 MINUTES — orders.sold_* for every sale, not
-- only CRM confirmations (2026-09-28)
--
-- WHY. orders.sold_at / sold_by_person_id / sold_via / sold_by_ext ("who made
-- this a sale", migration 20260935000100) are stamped live only by
-- trg_orders_stamp_sold, i.e. for CRM confirmations. AlterCPA approvals that
-- altercpa-sync mirrors, collabBox imports and history imports were stamped
-- only when someone ran `scripts/backfill-order-deciders.mjs --apply` by
-- hand — nothing scheduled it. Nina's approval at 00:25 on 28.09 sat without a
-- seller until the next manual run, and the Overview, the leaderboard (see the
-- temporary ledger fallback in 20260939000000_leaderboard_day.sql) and every
-- tab read sellers from these columns.
--
-- WHAT THIS ADDS
--   order_decider_plan(p_since)     read-only: the backfill script's plan, as
--                                   rows (pure SQL, no temp tables — runs in a
--                                   read-only transaction)
--   stamp_order_deciders(p_since, p_dry_run, p_limit) → jsonb
--                                   plan + apply in one call
--   update_updated_at_column()      honours elyon.keep_updated_at = 'on'
--   pg_cron 'stamp-order-deciders'  every 5 minutes (at :01, :06, … — one
--                                   minute after altercpa-sync-status)
--
-- ── THE RULES — a faithful port of scripts/backfill-order-deciders.mjs ──────
-- (planPageSql, 2026-09-27). KEEP IN STEP: a rule change goes into BOTH.
-- Which orders: a REAL SALE with no sold_at yet —
--   price > 0 · not a synthetic product (is_synthetic_product_name(), the SQL
--   twin of mex-reconcile's isRealSale) · status <> 'duplicated' (an unworked
--   copy) · and it IS or WAS a sale: a sale status now
--   (confirmed/shipped/delivered/paid/returned), OR order_history shows a
--   transition into one, OR AlterCPA approved it (approved | cancel_other,
--   the 2026-08-11 manager rule) on an AlterCPA-sourced order.
-- Who decided — the FIRST rule that applies:
--   collabbox_author   sale_source collabbox, confirmed_by_name set → the
--                      collabBox Avtor                           via collabbox
--   history_import     altercpa/history, not a duplicate → the operator the
--                      2026-08 import wrote (confirmed_by_name; ''/'Import'/
--                      'System' fall back to assigned_agent_name) via import
--   crm_decided        the FIRST transition into a sale status in
--                      order_history was made by a person (not 'System (…)',
--                      not an annotated '… — …' row)              via crm
--   crm_decided_pushed …and a real (non-noop) audit_log order.altercpa_push
--                      landed 15 min before … 5 min after AlterCPA's approval
--                      (approved | cancel_other): AlterCPA's approval is the
--                      MIRROR of the CRM decision            via crm_push
--   crm_push_only      AlterCPA-sourced, approved/cancel_other, a push in that
--                      window but no human CRM transition → the pushing CRM
--                      user                                  via crm_push
--   altercpa_ledger    AlterCPA-sourced, approved/cancel_other → the ledger's
--                      decided_by_altercpa_user, resolved through
--                      sales_person_identities kind altercpa_user of THAT
--                      ledger row's account                  via altercpa
--   crm_confirmer      no order_history at all (pre-history rows) and not an
--                      AlterCPA order → confirmed_by_agent_id's person, else
--                      the exact confirmed_by_name (elyon_crm only) via crm
-- sold_at: collabbox/import/confirmer → coalesce(confirmed_at, created_at);
-- crm_decided(_pushed) → that first transition's changed_at; crm_push_only /
-- altercpa_ledger → the ledger's decided_at. A rule without a time is left
-- unstamped (reported as no_decision_time), exactly like the script.
-- Anything else stays NULL and is reported by bucket (same text as the
-- script's CSV) — e.g. AlterCPA leads THEY cancelled that MEX delivered.
--
-- Names resolve to people EXACTLY through sales_person_identities (the ledger
-- id per account; order_name / collabbox_author spellings, in the script's
-- kind order) and sales_people.user_id for logins. There is deliberately NO
-- fold here: the cross-script fold (agentIdentityKey) is a human-reviewed,
-- seed-time step (scripts/seed-sales-people.mjs, Settings → Teams) that
-- REGISTERS every spelling as its own identity; the backfill script, the live
-- trigger and v_sales_work all match exactly, and so does this.
--
-- sold_by_ext keeps the raw key (AlterCPA user id, operator name, collabBox
-- author) even when no person matches. sold_* are write-once per column
-- (trg_orders_sold_write_once), so a NULL sold_by_person_id may still be
-- FILLED later: every run also fills the person on already-stamped orders
-- whose sold_by_ext now resolves (an identity added in Settings → Teams),
-- with the same resolution the stamp would have used —
--   altercpa   altercpa_user identity of the order's (latest) ledger account
--   collabbox  collabbox_author, else order_name
--   import     order_name, else collabbox_author
--   crm / crm_push   the login that carried exactly that name on this order
--              (ext is a user id · the confirmer whose name it is · the first
--              sale transition's changed_by · the non-noop pusher whose profile
--              name it is), else the order_name identity
-- No time window for fills: an identity added today may name months of
-- orders; p_limit caps one run and the next run continues.
--
-- ── SCOPE (per run) ─────────────────────────────────────────────────────────
-- stamps: sold_at IS NULL and, within now() - p_since, the order was
-- created or updated, OR got an order_history transition into a sale, OR its
-- AlterCPA ledger row was decided / changed phase (a ledger decision on an
-- order the sync does not touch still lands). p_since => '10 years' is a full
-- sweep, equivalent to the script's dry run.
-- p_limit caps the rows WRITTEN per run: stamps first, newest sale first,
-- then person fills. Counts in the result are always over the whole scope.
--
-- ── updated_at — why NOT session_replication_role ────────────────────────────
-- The script writes under SET LOCAL session_replication_role = replica so
-- trg_orders_updated_at does not bump updated_at (GET /call-agains reads it as
-- last_call_at). In a function that is not a safe contract here: `postgres`
-- is not a superuser and holds no SET grant on the parameter
-- (has_parameter_privilege('postgres', 'session_replication_role', 'SET') =
-- false on MK, 2026-09-28). The script's top-level SET works because
-- supautils escalates SET *statements* for its privileged role
-- (supautils.privileged_role_allowed_configs lists session_replication_role);
-- set_config() is not a SET statement, and a SET inside a definer function
-- would lean on supautils internals nobody tests. Replica would also switch
-- off the sold_by FK and the write-once trigger for the whole transaction.
-- Instead: update_updated_at_column() (the function behind
-- trg_orders_updated_at and 20 other tables' triggers) returns NEW untouched
-- when the transaction sets elyon.keep_updated_at = 'on' — set LOCAL by this
-- function around its one UPDATE only and cleared right after. Unset (every
-- other write in the system) it behaves exactly as before. On a write of the
-- sold_* columns alone the only other triggers are trg_orders_sold_write_once
-- (NULL → value is allowed) and the FK — both stay ON; the person id is still
-- re-checked in the UPDATE so a person deleted mid-run skips the row instead of
-- failing the batch.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
--   * Guarded by sold_at IS NULL (stamp) / sold_by_person_id IS NULL AND the
--     same sold_via + sold_by_ext (fill): idempotent, never overwrites the live
--     trigger's stamp or anything set.
--   * Rows another writer holds are SKIPPED (FOR UPDATE SKIP LOCKED) and taken
--     next run — the cron never waits on altercpa-sync or an agent.
--   * One run at a time (transaction advisory lock).
--   * Dry run = SELECTs only: callable read-only (supabase_read_only_user,
--     for verification). Apply refuses a read-only session outright.
--   * SECURITY DEFINER (the people tables are owners-only under RLS),
--     search_path pinned, EXECUTE for service_role only (+ the read-only
--     verification role, dry run only).
--
-- PARITY (2026-09-28, live MK, read-only): order_decider_plan's body vs the
-- script's planPageSql fed the SAME scope clause, compared row by row on
-- rule, via, person, ext, sold_at, bucket, source/detail and status:
--   14 days, unstamped (what the cron sees)   1.129 = 1.129 rows, 0 diffs
--     (all unresolved — nothing was waiting: the script had just been run)
--   14 days, incl. already-stamped orders     6.575 = 6.575 rows, 0 diffs
--     collabbox_author 2.622 · altercpa_ledger 2.019 · crm_decided 560 ·
--     history_import 242 · crm_decided_pushed 3 · unresolved 1.129
--   every real sale in the DB, incl. stamped  47.917 = 47.917 rows, 0 diffs;
--     re-derived via/ext/person/sold_at equal the stored stamp on every
--     stamped order (the 953 crm/crm_push rows differ below 1 ms only: the
--     script round-trips sold_at through a JS Date; this keeps microseconds)
-- Dry-run SELECT, 14 days: ~210 ms server-side (pg_stat_statements, 5 runs).
-- An ephemeral PGlite build of 20260935000000 + 20260935000100 + this file
-- also checked apply == `backfill-order-deciders.mjs --apply` on identical
-- data, updated_at untouched, fills, p_limit, read-only refusals (39 checks).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. updated_at may be kept by an explicit bookkeeping write ──────────────
-- Same signature, language, search_path and owner as the original
-- (20260214204904); only the guard is new.
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Bookkeeping writes (stamp_order_deciders) keep the row's updated_at:
  -- GET /call-agains reads orders.updated_at as last_call_at.
  IF current_setting('elyon.keep_updated_at', true) = 'on' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.update_updated_at_column() IS
  'BEFORE UPDATE: NEW.updated_at = now(), unless the transaction set elyon.keep_updated_at = ''on'' (LOCAL) for a bookkeeping write that must not look like activity — stamp_order_deciders() (2026-09-28). GET /call-agains reads orders.updated_at as last_call_at.';

-- ── 2. The plan (read-only) ─────────────────────────────────────────────────
-- One row per order in scope:
--   action 'stamp'        a decider and a time → will be stamped
--          'no_time'      a decider but no decision time → left unstamped
--          'unresolved'   no decider in our data → left NULL (bucket says why)
--          'fill_person'  already stamped, person NULL, sold_by_ext now
--                         resolves → person will be filled (rule 'person_fill')
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
  -- a real CRM push of this order landing around AlterCPA's decision
  SELECT DISTINCT ON (led.order_id) led.order_id, a.actor_id, a.created_at, p.full_name AS actor_name
    FROM led
    JOIN public.audit_log a
      ON a.target_type = 'order' AND a.target_id = led.order_id::text
     AND a.action = 'order.altercpa_push'
     AND (a.payload ->> 'noop') IS DISTINCT FROM 'true'
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
         push.actor_id AS push_by, push.actor_name AS push_name,
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
      WHEN x.src = 'altercpa' AND x.decision IN ('approved', 'cancel_other')
        THEN CASE WHEN x.push_by IS NOT NULL THEN 'crm_push_only' ELSE 'altercpa_ledger' END
      -- Pre-history rows only, and never an AlterCPA order: a confirmer recorded
      -- on those can be whoever moved the parcel on, not who sold it.
      WHEN NOT x.has_fr AND x.src <> 'altercpa' AND x.confirmed_by_agent_id IS NOT NULL THEN 'crm_confirmer'
      WHEN NOT x.has_fr AND x.src = 'elyon_crm' AND nullif(btrim(x.confirmed_by_name), '') IS NOT NULL THEN 'crm_confirmer'
    END AS rule
    FROM x
   WHERE x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
      OR x.has_fr
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
        (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = r.push_by)
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
      WHEN 'crm_push_only'      THEN coalesce(r.push_name, r.push_by::text)
      WHEN 'altercpa_ledger'    THEN r.alt_user::text
      WHEN 'crm_confirmer'      THEN coalesce(nullif(btrim(r.confirmed_by_name), ''), r.confirmed_by_agent_id::text)
    END AS ext,
    CASE WHEN r.rule IS NULL THEN concat_ws(' · ',
      r.src || '/' || r.det,
      'AlterCPA ' || coalesce(r.decision, CASE WHEN r.has_led THEN 'open' ELSE 'no ledger row' END),
      CASE WHEN r.src = 'collabbox' OR (r.src = 'altercpa' AND r.det = 'history' AND r.duplicated_from IS NULL)
           THEN 'no operator name on the import' END,
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
      WHEN 'crm_push' THEN coalesce(
        CASE WHEN fo.sold_by_ext ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (SELECT sp.id FROM public.sales_people sp WHERE sp.user_id = fo.sold_by_ext::uuid) END,
        (SELECT sp.id FROM public.order_history h
           JOIN public.sales_people sp ON sp.user_id = h.changed_by
          WHERE h.order_id = fo.id AND h.changed_by_name = fo.sold_by_ext
            AND h.to_status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
            AND (h.from_status IS NULL OR h.from_status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
          ORDER BY h.changed_at, h.id LIMIT 1),
        (SELECT sp.id FROM public.audit_log a
           JOIN public.profiles p ON p.user_id = a.actor_id
           JOIN public.sales_people sp ON sp.user_id = a.actor_id
          WHERE a.target_type = 'order' AND a.target_id = fo.id::text
            AND a.action = 'order.altercpa_push'
            AND (a.payload ->> 'noop') IS DISTINCT FROM 'true'
            AND p.full_name = fo.sold_by_ext
          ORDER BY a.created_at LIMIT 1),
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
  '2026-09-28: read-only plan of stamp_order_deciders() — a faithful SQL port of scripts/backfill-order-deciders.mjs planPageSql (keep in step). One row per in-scope order: action stamp | no_time | unresolved (bucket says why) | fill_person (already stamped, sold_by_ext now resolves to a person). Pure SQL, no temp tables: runs in a read-only transaction.';

-- ── 3. Plan + apply ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stamp_order_deciders(
  p_since   interval DEFAULT interval '14 days',
  p_dry_run boolean  DEFAULT false,
  p_limit   integer  DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _t0       timestamptz := clock_timestamp();
  _since    interval    := coalesce(p_since, interval '14 days');
  _limit    integer     := least(greatest(coalesce(p_limit, 5000), 1), 50000);
  _summary  jsonb;
  _todo     jsonb;
  _stamped  integer := 0;
  _st_rule  jsonb   := '{}'::jsonb;
  _filled   integer := 0;
  _plan_ms  integer;
BEGIN
  IF _since <= interval '0' THEN
    RAISE EXCEPTION 'stamp_order_deciders: p_since must be positive (got %)', _since
      USING ERRCODE = '22023';
  END IF;

  IF NOT coalesce(p_dry_run, false) THEN
    -- The dry run is granted to the read-only verification role; apply never is.
    IF session_user::text = 'supabase_read_only_user'
       OR current_setting('transaction_read_only') = 'on' THEN
      RAISE EXCEPTION 'stamp_order_deciders: apply needs a read-write session — call it with p_dry_run => true here'
        USING ERRCODE = '25006';
    END IF;
    -- One run at a time: a slow run is never overlapped by the next tick.
    IF NOT pg_try_advisory_xact_lock(hashtext('public.stamp_order_deciders')) THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'another run is in progress');
    END IF;
  END IF;

  -- The plan, computed ONCE: the summary over the whole scope, and the rows to
  -- write (stamps first, newest sale first, then person fills) up to p_limit.
  WITH p AS MATERIALIZED (
    SELECT * FROM public.order_decider_plan(_since)
  ), agg AS (
    SELECT count(*) FILTER (WHERE p.action <> 'fill_person')::int               AS candidates,
           count(*) FILTER (WHERE p.action = 'stamp')::int                      AS resolvable,
           count(*) FILTER (WHERE p.action = 'stamp' AND p.person_id IS NOT NULL)::int AS with_person,
           count(*) FILTER (WHERE p.action = 'no_time')::int                    AS no_time,
           count(*) FILTER (WHERE p.action = 'unresolved')::int                 AS unresolved,
           count(*) FILTER (WHERE p.action = 'fill_person')::int                AS fillable
      FROM p
  ), br AS (
    SELECT coalesce(jsonb_object_agg(z.rule, z.n), '{}'::jsonb) AS j
      FROM (SELECT p.rule, count(*)::int AS n FROM p WHERE p.action = 'stamp' GROUP BY p.rule) z
  ), bv AS (
    SELECT coalesce(jsonb_object_agg(z.via, z.n), '{}'::jsonb) AS j
      FROM (SELECT p.via, count(*)::int AS n FROM p WHERE p.action = 'stamp' GROUP BY p.via) z
  ), ub AS (
    SELECT coalesce(jsonb_object_agg(z.bucket, z.n), '{}'::jsonb) AS j
      FROM (SELECT p.bucket, count(*)::int AS n FROM p WHERE p.action = 'unresolved' GROUP BY p.bucket) z
  ), np AS (
    -- decider known, no person (the Settings → Teams "unmapped" queue), top 30
    SELECT coalesce(jsonb_object_agg(z.k, z.n), '{}'::jsonb) AS j
      FROM (SELECT p.via || ': ' || coalesce(p.ext, '(none)') AS k, count(*)::int AS n
              FROM p WHERE p.action = 'stamp' AND p.person_id IS NULL
             GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30) z
  ), todo AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'order_id', t.order_id, 'action', t.action, 'rule', t.rule, 'via', t.via,
             'sold_at', t.sold_at, 'person_id', t.person_id, 'ext', t.ext)), '[]'::jsonb) AS j
      FROM (SELECT p.* FROM p
             WHERE p.action IN ('stamp', 'fill_person')
             ORDER BY (p.action = 'fill_person'), p.sold_at DESC, p.order_id
             LIMIT _limit) t
  )
  SELECT jsonb_build_object(
           'candidates',           agg.candidates,
           'resolvable',           agg.resolvable,
           'resolvable_with_person', agg.with_person,
           'no_decision_time',     agg.no_time,
           'unresolved',           agg.unresolved,
           'person_fillable',      agg.fillable,
           'by_rule',              br.j,
           'by_via',               bv.j,
           'unresolved_by_bucket', ub.j,
           'decider_without_person', np.j),
         todo.j
    INTO _summary, _todo
    FROM agg, br, bv, ub, np, todo;

  _plan_ms := (extract(epoch FROM clock_timestamp() - _t0) * 1000)::int;

  IF NOT coalesce(p_dry_run, false) AND jsonb_array_length(_todo) > 0 THEN
    PERFORM set_config('lock_timeout', '5s', true);
    -- keep updated_at (GET /call-agains last_call_at) — see the header
    PERFORM set_config('elyon.keep_updated_at', 'on', true);

    -- ONE guarded UPDATE for both kinds of row:
    --   stamp        all four columns, only while sold_at is still NULL
    --   fill_person  sold_by_person_id only, only while it is NULL and only on
    --                the attribution it was resolved for (same sold_via +
    --                sold_by_ext); sold_at/via/ext are re-written with their
    --                own values (the write-once trigger keeps them anyway)
    -- Person ids are re-checked (a person deleted mid-run skips the row
    -- instead of failing the batch on the FK). Rows another writer holds are
    -- skipped and taken next run.
    WITH v AS (
      SELECT * FROM jsonb_to_recordset(_todo)
               AS v(order_id uuid, action text, rule text, via text, sold_at timestamptz, person_id uuid, ext text)
    ), lk AS (
      SELECT o.id FROM public.orders o JOIN v ON v.order_id = o.id
       WHERE (v.action = 'stamp' AND o.sold_at IS NULL)
          OR (v.action = 'fill_person' AND o.sold_by_person_id IS NULL)
       ORDER BY o.id
         FOR UPDATE OF o SKIP LOCKED
    ), upd AS (
      UPDATE public.orders o
         SET sold_at           = CASE WHEN v.action = 'stamp' THEN v.sold_at ELSE o.sold_at     END,
             sold_via          = CASE WHEN v.action = 'stamp' THEN v.via     ELSE o.sold_via    END,
             sold_by_ext       = CASE WHEN v.action = 'stamp' THEN v.ext     ELSE o.sold_by_ext END,
             sold_by_person_id = v.person_id
        FROM v JOIN lk ON lk.id = v.order_id
       WHERE o.id = v.order_id
         AND CASE v.action
               WHEN 'stamp' THEN
                 o.sold_at IS NULL
                 AND (v.person_id IS NULL
                      OR EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = v.person_id))
               WHEN 'fill_person' THEN
                 o.sold_by_person_id IS NULL
                 AND o.sold_at IS NOT NULL
                 AND o.sold_via = v.via
                 AND o.sold_by_ext = v.ext
                 AND EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = v.person_id)
               ELSE false
             END
      RETURNING v.action, v.rule
    )
    SELECT count(*) FILTER (WHERE u.action = 'stamp')::int,
           count(*) FILTER (WHERE u.action = 'fill_person')::int,
           coalesce((SELECT jsonb_object_agg(z.rule, z.n)
                       FROM (SELECT u2.rule, count(*)::int AS n FROM upd u2
                              WHERE u2.action = 'stamp' GROUP BY u2.rule) z), '{}'::jsonb)
      INTO _stamped, _filled, _st_rule
      FROM upd u;

    PERFORM set_config('elyon.keep_updated_at', '', true);
  END IF;

  RETURN _summary || jsonb_build_object(
    'ok',             true,
    'dry_run',        coalesce(p_dry_run, false),
    'since',          _since::text,
    'limit',          _limit,
    'to_write',       jsonb_array_length(_todo),
    'stamped',        _stamped,
    'stamped_by_rule', _st_rule,
    'person_filled',  _filled,
    'plan_ms',        _plan_ms,
    'ms',             (extract(epoch FROM clock_timestamp() - _t0) * 1000)::int);
END;
$fn$;

COMMENT ON FUNCTION public.stamp_order_deciders(interval, boolean, integer) IS
  '2026-09-28: stamps orders.sold_* (who made the sale) for every real sale in the window that has none — AlterCPA approvals, collabBox and history imports, CRM decisions — by the rules of scripts/backfill-order-deciders.mjs (order_decider_plan), and fills sold_by_person_id where sold_by_ext now resolves. Write-once guarded, SKIP LOCKED, keeps updated_at (elyon.keep_updated_at). Cron stamp-order-deciders every 5 min. p_dry_run => true writes nothing (read-only safe). Returns {candidates, stamped, by_rule, unresolved_by_bucket, …}.';

-- ── 4. Privileges ───────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.order_decider_plan(interval)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stamp_order_deciders(interval, boolean, integer)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_decider_plan(interval)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.stamp_order_deciders(interval, boolean, integer) TO service_role;

-- Read-only verification (dry run / plan only — apply refuses this role, and
-- its sessions are read-only). Guarded: the role exists on the hosted project,
-- not necessarily on a local stack.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.order_decider_plan(interval)                     TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stamp_order_deciders(interval, boolean, integer) TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 5. Schedule — every 5 minutes, one minute after altercpa-sync-status ────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stamp-order-deciders') THEN
    PERFORM cron.unschedule('stamp-order-deciders');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'stamp-order-deciders',
  '1-59/5 * * * *',
  $job$SELECT public.stamp_order_deciders();$job$
);
