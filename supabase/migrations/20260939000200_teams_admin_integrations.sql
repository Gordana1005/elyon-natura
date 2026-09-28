-- ============================================================================
-- Settings → Teams and Settings → Integrations health (2026-09-28)
-- ============================================================================
-- Two OWNER-ONLY Settings tabs. Everything here is SECURITY DEFINER with
-- EXECUTE for service_role only: the api edge function calls it behind its
-- isBusinessOwner() gate (admin does NOT bypass) and writes the audit_log row
-- (audit_log.actor_id is NOT NULL — a human is required, so SQL never writes it).
--
-- TEAMS ("that list can always be changed and more people added" — Mile)
--   sales_teams_admin_overview()      people · identities · memberships · last
--                                      activity (v_sales_work) · staff logins
--   sales_teams_unmapped(days)        the work queue: AlterCPA deciders with no
--                                      identity · unnamed AlterCPA placeholders ·
--                                      agent logins with no person · sold orders
--                                      with no person, by decider key
--   sales_person_create(…)            a person (+ login, identities, team) in ONE
--                                      transaction, back-stamping their orders
--   sales_person_update(id, patch)     name / active / manager / notes / login
--   sales_person_add_identity(…)      + back-stamp orders.sold_by_person_id
--   sales_person_remove_identity(id)  never un-stamps an order
--   sales_person_move_team(…)         close the current primary membership at
--                                      X−1 and open the new one at X, atomically
--   sales_membership_delete(id)       owner correction of a wrong row
--
-- BACK-STAMPING (sales_backstamp_orders, internal). orders.sold_* are
-- write-once per column (tg_orders_sold_write_once, 20260935000100): a SET value
-- is kept silently, NULL → value is an allowed FILL. So naming a decider may
-- fill sold_by_person_id where it IS NULL and sold_by_ext is exactly the new
-- handle — never restamps an order that already has a person, and never
-- touches sold_at / sold_via / sold_by_ext. Which sold_via a handle may fill is
-- the resolution order scripts/backfill-order-deciders.mjs and
-- tg_orders_stamp_sold use:
--   altercpa_user     sold_via altercpa, ext = the id, the ledger row's account
--   order_name        crm · crm_push · import; collabbox only when no
--                     collabbox_author handle with the same spelling exists
--                     (that kind wins for collabBox rows)
--   collabbox_author  collabbox; import only when no order_name handle with the
--                     same spelling exists (order_name wins for imports)
--   login (user_id)   crm · crm_push where ext is the user id; crm where the
--                     order's confirmer IS that login and ext is its name
-- Orders never stamped at all (sold_at IS NULL — e.g. AlterCPA approvals the
-- backfill has not reached) are NOT stamped here: that is
-- scripts/backfill-order-deciders.mjs' job. The unmapped queue reports them.
-- Like that script, the fill runs with session_replication_role = replica
-- (LOCAL) so trg_orders_updated_at does not bump updated_at (GET /call-agains
-- shows it as last_call_at); replica also skips the FK check, so the UPDATE
-- re-checks the person exists. If the role may not set it, the fill still runs
-- with triggers on (write-once allows NULL → value).
--
-- INTEGRATIONS HEALTH ("when the AlterCPA feed was dead for 24 days nobody
-- noticed; this would have shown it red on day one" — Mile)
--   integrations_health()    every feed in one call: AlterCPA, MEX BIO NATURAL,
--                            MEX NATURA, web shop, collabBox, the 7-day
--                            no-parcel rule and every pg_cron job (needs the
--                            definer to read the cron schema)
--   collabbox_feed_state()   THE collabBox freshness — this page and (next) the
--                            Overview read it; 20260939000350_collabbox_sync
--                            replaces its body with a real run log
--   no_parcel_rule_report(run)  the rows behind one no-parcel run, for the CSV
--   no_parcel_rule_set_mode(mode, actor)  the owners' Report ↔ Apply switch
--   trg_app_settings_guard_owner_keys  app_settings.no_parcel_rule can no
--                            longer be written by an admin/manager session
--                            straight through PostgREST (it could: RLS policy
--                            "Admins can manage app_settings")
--   idx_altercpa_sync_runs_kind_recent  (account_id, kind, started_at DESC)
--                            for the per-job "newest run" probes
--
-- APPLY: node scripts/assert-mk-target.mjs, then
--        node scripts/apply-migration-mk.mjs supabase/migrations/20260939000200_teams_admin_integrations.sql
-- Needs 20260935000100 (sales people), 20260937000000 (web_orders /
-- web_sync_runs) and 20260938000000 (no-parcel rule) applied first.
-- The headline status of AlterCPA / MEX / web / collabBox uses EXACTLY the
-- thresholds of insights_overview()'s freshness block (frj, 20260936000000):
-- AlterCPA rolling 15 min · MEX 45 min before the expected last run of the
-- 07:00–20:55 day · web 45 min · collabBox 7 days. KEEP IN STEP. One deliberate
-- refinement: a run still `running` and younger than 15 minutes is ignored when
-- reading "the last run's status" (the Overview reads it as failed for the
-- second a rolling run is in flight); older than 15 minutes it IS failed (hung).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 0. Internal: back-stamp orders for one handle ──────────────────────────
CREATE OR REPLACE FUNCTION public.sales_backstamp_orders(
  p_person  uuid,
  p_kind    text,
  p_account uuid,
  p_value   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n       integer := 0;
  _replica boolean := false;
  _prev    text := coalesce(current_setting('session_replication_role', true), 'origin');
  _uid     uuid;
BEGIN
  IF p_person IS NULL OR nullif(p_value, '') IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = p_person) THEN
    RETURN 0;
  END IF;

  BEGIN
    PERFORM set_config('session_replication_role', 'replica', true);
    _replica := true;
  EXCEPTION WHEN OTHERS THEN
    _replica := false;
  END;

  IF p_kind = 'altercpa_user' THEN
    UPDATE public.orders o
       SET sold_by_person_id = p_person
     WHERE o.sold_by_person_id IS NULL
       AND o.sold_at IS NOT NULL
       AND o.sold_via = 'altercpa'
       AND o.sold_by_ext = p_value
       AND EXISTS (SELECT 1 FROM public.altercpa_leads l
                    WHERE l.order_id = o.id AND l.account_id = p_account);
    GET DIAGNOSTICS _n = ROW_COUNT;

  ELSIF p_kind = 'order_name' THEN
    UPDATE public.orders o
       SET sold_by_person_id = p_person
     WHERE o.sold_by_person_id IS NULL
       AND o.sold_at IS NOT NULL
       AND o.sold_by_ext = p_value
       AND (o.sold_via IN ('crm', 'crm_push', 'import')
            OR (o.sold_via = 'collabbox'
                AND NOT EXISTS (SELECT 1 FROM public.sales_person_identities i
                                 WHERE i.kind = 'collabbox_author' AND i.account_id IS NULL
                                   AND i.value = p_value AND i.person_id <> p_person)));
    GET DIAGNOSTICS _n = ROW_COUNT;

  ELSIF p_kind = 'collabbox_author' THEN
    UPDATE public.orders o
       SET sold_by_person_id = p_person
     WHERE o.sold_by_person_id IS NULL
       AND o.sold_at IS NOT NULL
       AND o.sold_by_ext = p_value
       AND (o.sold_via = 'collabbox'
            OR (o.sold_via = 'import'
                AND NOT EXISTS (SELECT 1 FROM public.sales_person_identities i
                                 WHERE i.kind = 'order_name' AND i.account_id IS NULL
                                   AND i.value = p_value AND i.person_id <> p_person)));
    GET DIAGNOSTICS _n = ROW_COUNT;

  ELSIF p_kind = 'login' AND p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    _uid := p_value::uuid;
    UPDATE public.orders o
       SET sold_by_person_id = p_person
     WHERE o.sold_by_person_id IS NULL
       AND o.sold_at IS NOT NULL
       AND o.sold_via IN ('crm', 'crm_push')
       AND (o.sold_by_ext = p_value
            OR (o.sold_via = 'crm'
                AND o.confirmed_by_agent_id = _uid
                AND o.sold_by_ext = nullif(btrim(o.confirmed_by_name), '')));
    GET DIAGNOSTICS _n = ROW_COUNT;
  END IF;

  IF _replica THEN
    PERFORM set_config('session_replication_role', _prev, true);
  END IF;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.sales_backstamp_orders(uuid, text, uuid, text) IS
  'Internal (Settings → Teams, 2026-09-28): fill orders.sold_by_person_id where it IS NULL and sold_by_ext is exactly the handle (altercpa_user | order_name | collabbox_author | login). Never restamps; never touches sold_at/sold_via/sold_by_ext. Called only by the sales_person_* definer functions.';

REVOKE ALL ON FUNCTION public.sales_backstamp_orders(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 1. Read: the whole Teams tab in one call ───────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_teams_admin_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH act AS (
  SELECT w.person_id,
         max(w.at)                                                                    AS last_at,
         count(*) FILTER (WHERE w.at > now() - interval '30 days')                   AS n30,
         count(*) FILTER (WHERE w.at > now() - interval '30 days' AND w.outcome = 'sale') AS sales30
    FROM public.v_sales_work w
   WHERE w.person_id IS NOT NULL
   GROUP BY w.person_id
),
roles AS (
  SELECT r.user_id, array_agg(DISTINCT r.role::text ORDER BY r.role::text) AS roles
    FROM public.user_roles r
   GROUP BY r.user_id
)
SELECT jsonb_build_object(
  'today', (now() AT TIME ZONE 'Europe/Skopje')::date,
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'key', t.key, 'name', t.name, 'leaderboard_mode', t.leaderboard_mode)
                   ORDER BY CASE t.key WHEN 'altercpa_leads' THEN 0 WHEN 'crm_prediction' THEN 1
                                       WHEN 'management' THEN 2 ELSE 3 END, t.name), '[]'::jsonb)
              FROM public.sales_teams t),
  'accounts', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', a.id, 'name', a.name, 'is_active', a.is_active) ORDER BY a.name), '[]'::jsonb)
                 FROM public.altercpa_accounts a),
  'people', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', sp.id,
                'display_name', sp.display_name,
                'user_id', sp.user_id,
                'login_name', p.full_name,
                'login_email', p.email,
                'login_active', p.is_active,
                'login_roles', to_jsonb(coalesce(ro.roles, ARRAY[]::text[])),
                'is_active', sp.is_active,
                'is_manager', sp.is_manager,
                'notes', sp.notes,
                'created_at', sp.created_at,
                'last_activity_at', a.last_at,
                'decisions_30d', coalesce(a.n30, 0),
                'sales_30d', coalesce(a.sales30, 0),
                'identities', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                  'id', i.id, 'kind', i.kind, 'account_id', i.account_id,
                                  'value', i.value, 'note', i.note, 'created_at', i.created_at)
                                ORDER BY i.kind, i.value), '[]'::jsonb)
                                 FROM public.sales_person_identities i WHERE i.person_id = sp.id),
                'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                   'id', m.id, 'team_key', m.team_key, 'valid_from', m.valid_from,
                                   'valid_to', m.valid_to, 'role', m.role, 'is_primary', m.is_primary,
                                   'note', m.note, 'created_at', m.created_at)
                                 ORDER BY m.valid_from DESC, m.created_at DESC), '[]'::jsonb)
                                  FROM public.sales_team_members m WHERE m.person_id = sp.id))
              ORDER BY lower(sp.display_name)), '[]'::jsonb)
               FROM public.sales_people sp
               LEFT JOIN public.profiles p ON p.user_id = sp.user_id
               LEFT JOIN roles ro ON ro.user_id = sp.user_id
               LEFT JOIN act a ON a.person_id = sp.id),
  -- Staff logins for the "link a CRM login" picker. A login whose ONLY role is
  -- `affiliate` is an external partner and never offered (the hard wall).
  'logins', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'user_id', p.user_id, 'full_name', p.full_name, 'email', p.email,
                'is_active', p.is_active, 'roles', to_jsonb(coalesce(ro.roles, ARRAY[]::text[])),
                'person_id', sp.id)
              ORDER BY p.is_active DESC, lower(coalesce(p.full_name, p.email, ''))), '[]'::jsonb)
               FROM public.profiles p
               LEFT JOIN roles ro ON ro.user_id = p.user_id
               LEFT JOIN public.sales_people sp ON sp.user_id = p.user_id
              WHERE ro.roles IS NULL OR EXISTS (SELECT 1 FROM unnest(ro.roles) r WHERE r <> 'affiliate'))
);
$fn$;

COMMENT ON FUNCTION public.sales_teams_admin_overview() IS
  'Settings → Teams (2026-09-28): teams, AlterCPA accounts, every sales person with identities, dated memberships and last v_sales_work decision, and the staff logins that can be linked. Owners only, via GET /api/sales-people.';

-- ── 2. Read: the unmapped queue ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_teams_unmapped(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH win AS (
  SELECT greatest(1, least(coalesce(p_days, 90), 400)) AS days,
         now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 400))) AS since
),
-- AlterCPA operators who decided MK leads in the window but name nobody.
acpa AS (
  SELECT l.account_id, l.decided_by_altercpa_user AS uid,
         count(*)                                                         AS decisions,
         count(*) FILTER (WHERE l.decision IN ('approved', 'cancel_other')) AS sales,
         min(l.decided_at) AS first_at, max(l.decided_at) AS last_at,
         (array_agg(jsonb_build_object('id', o.id, 'display_id', o.display_id)
                    ORDER BY l.decided_at DESC) FILTER (WHERE o.id IS NOT NULL))[1:5] AS sample
    FROM public.altercpa_leads l
    CROSS JOIN win
    LEFT JOIN public.orders o ON o.id = l.order_id
   WHERE upper(coalesce(l.geo, '')) = 'MK'
     AND l.decision IS NOT NULL
     AND l.skip_reason IS DISTINCT FROM 'test_order'
     AND l.decided_by_altercpa_user IS NOT NULL
     AND l.decided_at >= win.since
     AND NOT EXISTS (SELECT 1 FROM public.sales_person_identities i
                      WHERE i.kind = 'altercpa_user' AND i.account_id = l.account_id
                        AND i.value = l.decided_by_altercpa_user::text)
   GROUP BY l.account_id, l.decided_by_altercpa_user
),
-- The seed's placeholders for ids nobody has named ("AlterCPA #4531 (unnamed)",
-- scripts/seed-sales-people.mjs): a person with no login and that name shape.
unnamed AS (
  SELECT sp.id, sp.display_name, sp.notes,
         (SELECT string_agg(i.value, ', ' ORDER BY i.value) FROM public.sales_person_identities i
           WHERE i.person_id = sp.id AND i.kind = 'altercpa_user') AS altercpa_ids,
         (SELECT count(*) FROM public.v_sales_work w, win
           WHERE w.person_id = sp.id AND w.at >= win.since) AS decisions,
         (SELECT max(w.at) FROM public.v_sales_work w WHERE w.person_id = sp.id) AS last_at
    FROM public.sales_people sp
   WHERE sp.user_id IS NULL
     AND sp.display_name ~ '^AlterCPA #[0-9]+'
),
-- CRM logins holding an agent role that are nobody. Test logins (the seed's
-- isTestLogin rule) are flagged, not hidden.
logins AS (
  SELECT p.user_id, p.full_name, p.email, p.is_active, p.last_seen_at,
         array_agg(DISTINCT r.role::text ORDER BY r.role::text) AS roles,
         (SELECT max(h.changed_at) FROM public.order_history h WHERE h.changed_by = p.user_id) AS last_work_at,
         (coalesce(p.full_name, '') ~* '(^|[[:space:]_.-])(test|qa|e2e)([[:space:]_.-]|$)'
          OR coalesce(p.full_name, '') ~* 'тест'
          OR split_part(coalesce(p.email, ''), '@', 1) ~* '^(qa-|test|pregled)') AS is_test
    FROM public.profiles p
    JOIN public.user_roles r ON r.user_id = p.user_id
   WHERE r.role::text IN ('agent', 'pending_agent', 'prediction_agent', 'inbound_agent')
     AND NOT EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.user_id = p.user_id)
   GROUP BY p.user_id, p.full_name, p.email, p.is_active, p.last_seen_at
),
-- Sales in the window that name no person: stamped with a decider key nobody
-- owns, or real sales never stamped at all (the backfill has not reached them).
ord AS (
  SELECT coalesce(o.sold_by_ext, nullif(btrim(o.confirmed_by_name), '')) AS ext,
         o.sold_via,
         (o.sold_at IS NOT NULL) AS stamped,
         o.sale_source,
         count(*) AS n,
         min(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS first_at,
         max(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS last_at,
         (array_agg(jsonb_build_object('id', o.id, 'display_id', o.display_id)
                    ORDER BY coalesce(o.sold_at, o.confirmed_at, o.created_at) DESC))[1:5] AS sample
    FROM public.orders o
    CROSS JOIN win
   WHERE o.sold_by_person_id IS NULL
     AND ((o.sold_at IS NOT NULL AND o.sold_at >= win.since)
       OR (o.sold_at IS NULL
           AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
           AND coalesce(o.price, 0) > 0
           AND NOT public.is_synthetic_product_name(o.product_name)
           AND coalesce(o.confirmed_at, o.created_at) >= win.since))
   GROUP BY 1, 2, 3, 4
)
SELECT jsonb_build_object(
  'days', (SELECT days FROM win),
  'altercpa', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'account_id', a.account_id, 'account_name', ac.name, 'altercpa_user', a.uid,
                  'decisions', a.decisions, 'sales', a.sales, 'first_at', a.first_at, 'last_at', a.last_at,
                  'sample', to_jsonb(coalesce(a.sample, ARRAY[]::jsonb[])))
                ORDER BY a.decisions DESC, a.uid), '[]'::jsonb)
                 FROM acpa a LEFT JOIN public.altercpa_accounts ac ON ac.id = a.account_id),
  'unnamed', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'person_id', u.id, 'display_name', u.display_name, 'notes', u.notes,
                 'altercpa_ids', u.altercpa_ids, 'decisions', u.decisions, 'last_at', u.last_at)
               ORDER BY u.decisions DESC, u.display_name), '[]'::jsonb)
                FROM unnamed u),
  'logins', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'user_id', g.user_id, 'full_name', g.full_name, 'email', g.email, 'is_active', g.is_active,
                'roles', to_jsonb(g.roles), 'last_seen_at', g.last_seen_at, 'last_work_at', g.last_work_at,
                'is_test', g.is_test)
              ORDER BY g.is_active DESC, g.is_test, lower(coalesce(g.full_name, g.email, ''))), '[]'::jsonb)
               FROM logins g),
  'orders', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'ext', x.ext, 'sold_via', x.sold_via, 'stamped', x.stamped, 'sale_source', x.sale_source,
                'n', x.n, 'first_at', x.first_at, 'last_at', x.last_at,
                'sample', to_jsonb(coalesce(x.sample, ARRAY[]::jsonb[])))
              ORDER BY x.n DESC, x.ext NULLS LAST), '[]'::jsonb)
               FROM ord x)
);
$fn$;

COMMENT ON FUNCTION public.sales_teams_unmapped(integer) IS
  'Settings → Teams unmapped queue (2026-09-28), last p_days (1–400, default 90): AlterCPA deciders of MK leads with no identity · unnamed AlterCPA placeholder people · agent-role logins with no person · sales with no person grouped by decider key (stamped or not yet stamped). Owners only, via GET /api/sales-people/unmapped.';

-- ── 3. Write: identities ───────────────────────────────────────────────────
-- Business-rule failures come back as {ok:false, error:<code>} (the api maps
-- the code to an HTTP status and the UI translates it); only a genuine bug raises.
CREATE OR REPLACE FUNCTION public.sales_person_add_identity(
  p_person_id  uuid,
  p_kind       text,
  p_account_id uuid,
  p_value      text,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _value   text := btrim(coalesce(p_value, ''));
  _account uuid := p_account_id;
  _owner   uuid;
  _row     public.sales_person_identities%ROWTYPE;
  _n       integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales_people WHERE id = p_person_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'person_not_found');
  END IF;
  IF p_kind NOT IN ('altercpa_user', 'collabbox_author', 'order_name') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_kind');
  END IF;

  IF p_kind = 'altercpa_user' THEN
    _value := regexp_replace(_value, '^#', '');
    IF _value !~ '^[0-9]{1,9}$' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_altercpa_id');
    END IF;
    _value := (_value::bigint)::text;              -- '04429' → '4429', as the ledger writes it
    IF _account IS NULL THEN
      -- One AlterCPA install: its account is implied. More than one: say which.
      IF (SELECT count(*) FROM public.altercpa_accounts) = 1 THEN
        SELECT id INTO _account FROM public.altercpa_accounts;
      ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'account_required');
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.altercpa_accounts WHERE id = _account) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
    END IF;
  ELSE
    _account := NULL;
    IF _value = '' OR length(_value) > 200 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_value');
    END IF;
  END IF;

  SELECT i.person_id INTO _owner
    FROM public.sales_person_identities i
   WHERE i.kind = p_kind
     AND coalesce(i.account_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(_account, '00000000-0000-0000-0000-000000000000'::uuid)
     AND i.value = _value;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', CASE WHEN _owner = p_person_id THEN 'identity_exists' ELSE 'identity_taken' END,
      'person_id', _owner,
      'person_name', (SELECT display_name FROM public.sales_people WHERE id = _owner));
  END IF;

  INSERT INTO public.sales_person_identities (person_id, kind, account_id, value, note)
  VALUES (p_person_id, p_kind, _account, _value, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING * INTO _row;

  _n := public.sales_backstamp_orders(p_person_id, p_kind, _account, _value);

  RETURN jsonb_build_object('ok', true, 'identity', to_jsonb(_row), 'backstamped', _n);
EXCEPTION WHEN unique_violation THEN
  -- Two owners adding the same handle at once: the loser lands here.
  RETURN jsonb_build_object('ok', false, 'error', 'identity_taken');
END;
$fn$;

COMMENT ON FUNCTION public.sales_person_add_identity(uuid, text, uuid, text, text) IS
  'Settings → Teams: name a person by one more handle (altercpa_user id — account implied when there is one install —, order_name, collabbox_author; stored exactly, outer spaces trimmed) and back-stamp orders.sold_by_person_id where it IS NULL and sold_by_ext is exactly that handle. Returns {ok, identity, backstamped} or {ok:false, error}.';

CREATE OR REPLACE FUNCTION public.sales_person_remove_identity(p_identity_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _row     public.sales_person_identities%ROWTYPE;
  _stamped integer;
BEGIN
  DELETE FROM public.sales_person_identities WHERE id = p_identity_id RETURNING * INTO _row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'identity_not_found');
  END IF;
  -- Orders stamped through this handle KEEP their person (write-once; the first
  -- decider wins). Reported so the audit row says what stayed attributed.
  SELECT count(*) INTO _stamped
    FROM public.orders o
   WHERE o.sold_by_person_id = _row.person_id
     AND o.sold_by_ext = _row.value;
  RETURN jsonb_build_object('ok', true, 'identity', to_jsonb(_row), 'orders_keep_person', _stamped);
END;
$fn$;

COMMENT ON FUNCTION public.sales_person_remove_identity(uuid) IS
  'Settings → Teams: remove one handle. Orders already stamped with the person keep it (orders.sold_* are write-once); the count is returned for the audit row.';

-- ── 4. Write: people ───────────────────────────────────────────────────────
-- Shared login check: the profile exists, is staff (not an affiliate-only
-- partner login) and is not somebody else already.
CREATE OR REPLACE FUNCTION public.sales_login_check(p_user_id uuid, p_person_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = p_user_id) THEN 'login_not_found'
           WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_user_id)
                AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_user_id AND r.role::text <> 'affiliate')
             THEN 'login_not_staff'
           WHEN EXISTS (SELECT 1 FROM public.sales_people sp
                         WHERE sp.user_id = p_user_id AND sp.id IS DISTINCT FROM p_person_id) THEN 'login_already_linked'
         END;
$fn$;

REVOKE ALL ON FUNCTION public.sales_login_check(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- p_identities: [{kind, account_id?, value, note?}] — each added exactly as
-- sales_person_add_identity would, in the same transaction.
-- p_team_key + p_team_from (optional): the first primary membership.
CREATE OR REPLACE FUNCTION public.sales_person_create(
  p_display_name text,
  p_user_id      uuid    DEFAULT NULL,
  p_is_manager   boolean DEFAULT false,
  p_notes        text    DEFAULT NULL,
  p_team_key     text    DEFAULT NULL,
  p_team_from    date    DEFAULT NULL,
  p_team_role    text    DEFAULT 'member',
  p_identities   jsonb   DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _name   text := btrim(coalesce(p_display_name, ''));
  _chk    text;
  _person public.sales_people%ROWTYPE;
  _idn    jsonb;
  _res    jsonb;
  _added  jsonb := '[]'::jsonb;
  _stamp  integer := 0;
  _mem    public.sales_team_members%ROWTYPE;
  _role   text := coalesce(nullif(p_team_role, ''), 'member');
BEGIN
  IF _name = '' OR length(_name) > 120 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_name');
  END IF;
  IF p_user_id IS NOT NULL THEN
    _chk := public.sales_login_check(p_user_id, NULL);
    IF _chk IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', _chk);
    END IF;
  END IF;
  IF p_team_key IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.sales_teams WHERE key = p_team_key) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'team_not_found');
    END IF;
    IF p_team_from IS NULL OR p_team_from < DATE '2020-01-01'
       OR p_team_from > (now() AT TIME ZONE 'Europe/Skopje')::date + 366 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
    END IF;
    IF _role NOT IN ('member', 'lead') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_role');
    END IF;
  END IF;
  IF jsonb_typeof(coalesce(p_identities, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_identities');
  END IF;

  INSERT INTO public.sales_people (display_name, user_id, is_manager, notes)
  VALUES (_name, p_user_id, coalesce(p_is_manager, false), nullif(btrim(coalesce(p_notes, '')), ''))
  RETURNING * INTO _person;

  IF p_user_id IS NOT NULL THEN
    _stamp := _stamp + public.sales_backstamp_orders(_person.id, 'login', NULL, p_user_id::text);
  END IF;

  FOR _idn IN SELECT * FROM jsonb_array_elements(coalesce(p_identities, '[]'::jsonb)) LOOP
    _res := public.sales_person_add_identity(
      _person.id, _idn ->> 'kind',
      CASE WHEN (_idn ->> 'account_id') ~* '^[0-9a-f-]{36}$' THEN (_idn ->> 'account_id')::uuid END,
      _idn ->> 'value', _idn ->> 'note');
    IF coalesce((_res ->> 'ok')::boolean, false) IS NOT TRUE THEN
      -- All or nothing: a person half-created with a missing handle is worse
      -- than no person. The caller shows which handle failed.
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'sales_person_create:' || coalesce(_res ->> 'error', 'identity_failed'),
        DETAIL  = coalesce(_idn ->> 'value', '');
    END IF;
    _added := _added || jsonb_build_array(_res -> 'identity');
    _stamp := _stamp + coalesce((_res ->> 'backstamped')::integer, 0);
  END LOOP;

  IF p_team_key IS NOT NULL THEN
    INSERT INTO public.sales_team_members (person_id, team_key, valid_from, valid_to, role, is_primary)
    VALUES (_person.id, p_team_key, p_team_from, NULL, _role, true)
    RETURNING * INTO _mem;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'person', to_jsonb(_person),
    'identities', _added,
    'membership', CASE WHEN p_team_key IS NOT NULL THEN to_jsonb(_mem) END,
    'backstamped', _stamp);
END;
$fn$;

COMMENT ON FUNCTION public.sales_person_create(text, uuid, boolean, text, text, date, text, jsonb) IS
  'Settings → Teams "Add person" (2026-09-28): the person, optional CRM login, identities (all-or-nothing) and first primary team in ONE transaction; back-stamps their orders. {ok, person, identities, membership, backstamped} or {ok:false, error}; an identity that cannot be added raises sales_person_create:<code>.';

-- p_patch keys (all optional): display_name · is_active · is_manager · notes ·
-- user_id (present = set; JSON null = unlink the login).
CREATE OR REPLACE FUNCTION public.sales_person_update(p_person_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _before public.sales_people%ROWTYPE;
  _after  public.sales_people%ROWTYPE;
  _name   text;
  _uid    uuid;
  _chk    text;
  _stamp  integer := 0;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_patch');
  END IF;
  SELECT * INTO _before FROM public.sales_people WHERE id = p_person_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'person_not_found');
  END IF;
  _after := _before;

  IF p_patch ? 'display_name' THEN
    _name := btrim(coalesce(p_patch ->> 'display_name', ''));
    IF _name = '' OR length(_name) > 120 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_name');
    END IF;
    _after.display_name := _name;
  END IF;
  IF p_patch ? 'is_active' THEN
    IF jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_patch');
    END IF;
    _after.is_active := (p_patch ->> 'is_active')::boolean;
  END IF;
  IF p_patch ? 'is_manager' THEN
    IF jsonb_typeof(p_patch -> 'is_manager') <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_patch');
    END IF;
    _after.is_manager := (p_patch ->> 'is_manager')::boolean;
  END IF;
  IF p_patch ? 'notes' THEN
    _after.notes := nullif(btrim(coalesce(p_patch ->> 'notes', '')), '');
    IF length(coalesce(_after.notes, '')) > 1000 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_patch');
    END IF;
  END IF;
  IF p_patch ? 'user_id' THEN
    IF jsonb_typeof(p_patch -> 'user_id') = 'null' THEN
      _after.user_id := NULL;
    ELSIF (p_patch ->> 'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      _uid := (p_patch ->> 'user_id')::uuid;
      IF _uid IS DISTINCT FROM _before.user_id THEN
        _chk := public.sales_login_check(_uid, p_person_id);
        IF _chk IS NOT NULL THEN
          RETURN jsonb_build_object('ok', false, 'error', _chk);
        END IF;
      END IF;
      _after.user_id := _uid;
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'bad_patch');
    END IF;
  END IF;

  UPDATE public.sales_people
     SET display_name = _after.display_name,
         is_active    = _after.is_active,
         is_manager   = _after.is_manager,
         notes        = _after.notes,
         user_id      = _after.user_id
   WHERE id = p_person_id
  RETURNING * INTO _after;

  IF _after.user_id IS NOT NULL AND _after.user_id IS DISTINCT FROM _before.user_id THEN
    _stamp := public.sales_backstamp_orders(p_person_id, 'login', NULL, _after.user_id::text);
  END IF;

  RETURN jsonb_build_object('ok', true, 'before', to_jsonb(_before), 'after', to_jsonb(_after),
                            'backstamped', _stamp);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', 'login_already_linked');
END;
$fn$;

COMMENT ON FUNCTION public.sales_person_update(uuid, jsonb) IS
  'Settings → Teams person drawer: patch display_name / is_active / is_manager / notes / user_id (JSON null unlinks). Linking a login back-stamps that login''s CRM sales that name no person. {ok, before, after, backstamped} or {ok:false, error}.';

-- ── 5. Write: team memberships ─────────────────────────────────────────────
-- "Move to team T from date X": the primary membership covering X is closed at
-- X−1 (or replaced when it starts ON X — a same-day correction) and the new
-- one opens at X, in one transaction, so the EXCLUDE (one primary team per
-- person per day) holds at every statement. p_team_key NULL = "no team from X".
-- A primary membership that starts AFTER X is never silently overwritten:
-- the move is refused and the owner deletes or re-dates that row first.
CREATE OR REPLACE FUNCTION public.sales_person_move_team(
  p_person_id uuid,
  p_team_key  text,
  p_from      date,
  p_role      text DEFAULT 'member',
  p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _role    text := coalesce(nullif(p_role, ''), 'member');
  _later   jsonb;
  _cur     public.sales_team_members%ROWTYPE;
  _closed  jsonb;
  _deleted jsonb;
  _new     public.sales_team_members%ROWTYPE;
BEGIN
  IF p_from IS NULL OR p_from < DATE '2020-01-01'
     OR p_from > (now() AT TIME ZONE 'Europe/Skopje')::date + 366 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;
  IF _role NOT IN ('member', 'lead') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_role');
  END IF;
  -- Serialises concurrent moves of the same person.
  PERFORM 1 FROM public.sales_people WHERE id = p_person_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'person_not_found');
  END IF;
  IF p_team_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sales_teams WHERE key = p_team_key) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'team_not_found');
  END IF;

  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.valid_from) INTO _later
    FROM public.sales_team_members m
   WHERE m.person_id = p_person_id AND m.is_primary AND m.valid_from > p_from;
  IF _later IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'later_membership_exists', 'memberships', _later);
  END IF;

  SELECT * INTO _cur
    FROM public.sales_team_members m
   WHERE m.person_id = p_person_id AND m.is_primary
     AND m.valid_from <= p_from AND (m.valid_to IS NULL OR m.valid_to >= p_from)
   FOR UPDATE;

  IF FOUND THEN
    IF p_team_key IS NOT DISTINCT FROM _cur.team_key AND _role = _cur.role THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_in_team');
    END IF;
    IF _cur.valid_from = p_from THEN
      DELETE FROM public.sales_team_members WHERE id = _cur.id;
      _deleted := to_jsonb(_cur);
    ELSE
      UPDATE public.sales_team_members SET valid_to = p_from - 1 WHERE id = _cur.id;
      _closed := to_jsonb(_cur) || jsonb_build_object('valid_to', p_from - 1);
    END IF;
  ELSIF p_team_key IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_membership_to_end');
  END IF;

  IF p_team_key IS NOT NULL THEN
    INSERT INTO public.sales_team_members (person_id, team_key, valid_from, valid_to, role, is_primary, note)
    VALUES (p_person_id, p_team_key, p_from, NULL, _role, true, nullif(btrim(coalesce(p_note, '')), ''))
    RETURNING * INTO _new;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'closed', _closed,
    'replaced', _deleted,
    'opened', CASE WHEN p_team_key IS NOT NULL THEN to_jsonb(_new) END);
END;
$fn$;

COMMENT ON FUNCTION public.sales_person_move_team(uuid, text, date, text, text) IS
  'Settings → Teams "Move to team from date X" (2026-09-28): closes the primary membership covering X at X−1 (replaces it when it starts on X) and opens the new primary at X in ONE transaction — the one-primary-team EXCLUDE holds throughout. Team NULL = no team from X. Refuses (later_membership_exists) rather than overwrite a primary row that starts after X.';

CREATE OR REPLACE FUNCTION public.sales_membership_delete(p_membership_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _row public.sales_team_members%ROWTYPE;
BEGIN
  DELETE FROM public.sales_team_members WHERE id = p_membership_id RETURNING * INTO _row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'membership_not_found');
  END IF;
  RETURN jsonb_build_object('ok', true, 'membership', to_jsonb(_row));
END;
$fn$;

COMMENT ON FUNCTION public.sales_membership_delete(uuid) IS
  'Settings → Teams: delete one membership row (an owner correcting a wrong date or team). The api audits the deleted row in full.';

-- ── 6a. collabBox feed state — THE one definition ──────────────────────────
-- Settings → Integrations health reads collabBox freshness from here, and the
-- Overview's freshness strip is to call it too, so the two can never disagree.
-- Today's logic (fr_cb of insights_overview): collabBox is a manual import,
-- so fresh = the newest collabBox document (orders.created_at, sale_source
-- 'collabbox') is under 7 days old; no document at all = 'n/a'.
--   lag_parcels  NATURA teleshop / social parcels (series 9100 · 9102 · 9108)
--                with COD > 0, older than 48 h, linked to no order and not
--                claimed by a live web order (the Overview's claim test) —
--                the collabBox documents still to import.
-- Keys: feed · last_ok_at · status (ok | stale | failed | n/a) · detail ·
-- data_through · lag_parcels. Migration 20260939000350_collabbox_sync.sql
-- will CREATE OR REPLACE this to read collabbox_sync_runs; keep the keys.
CREATE OR REPLACE FUNCTION public.collabbox_feed_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH c AS (
  SELECT max(o.created_at) AS last_doc
    FROM public.orders o
   WHERE o.sale_source = 'collabbox'
),
lag AS (
  SELECT count(*) AS n
    FROM public.mex_parcels p
   WHERE p.account = 'natura'
     AND p.series IN ('9100', '9102', '9108')
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.created_at_mex < now() - interval '48 hours'
     AND p.order_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                      WHERE w.mex_tracking_id = p.tracking_id AND w.deleted_in_shop_at IS NULL)
)
SELECT jsonb_build_object(
  'feed', 'collabbox',
  'last_ok_at', c.last_doc,
  'status', CASE WHEN c.last_doc IS NULL THEN 'n/a'
                 WHEN c.last_doc < now() - interval '7 days' THEN 'stale'
                 ELSE 'ok' END,
  'detail', 'manual import; newest document '
            || coalesce(to_char(c.last_doc AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'), '-')
            || '; ' || lag.n || ' NATURA parcels not imported',
  'data_through', c.last_doc,
  'lag_parcels', lag.n)
  FROM c CROSS JOIN lag;
$fn$;

COMMENT ON FUNCTION public.collabbox_feed_state() IS
  'THE collabBox freshness (2026-09-28): {feed, last_ok_at, status ok|stale|failed|n/a, detail, data_through, lag_parcels}. Today: newest collabBox document, stale after 7 days; lag = unlinked NATURA 9100/9102/9108 COD parcels older than 48 h not claimed by a web order. Read by integrations_health() and (to come) the Overview; 20260939000350 replaces the body.';

REVOKE ALL ON FUNCTION public.collabbox_feed_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_feed_state() TO service_role;
-- The read-only verification path (Management API, read_only: true) runs as
-- supabase_read_only_user, which already reads every table; conditional so a
-- fresh local database without the platform role still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collabbox_feed_state() TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 6. Read: integrations health ───────────────────────────────────────────
-- "Newest run of THIS kind" probes (last ok / last settled / last failure):
-- without kind in the index a job that has failed for weeks (the nightly
-- sweep, 2026-09-28: last ok 08-09) scans the whole run log with a heap visit
-- per row. ~46k rows: the build takes well under a second.
CREATE INDEX IF NOT EXISTS idx_altercpa_sync_runs_kind_recent
  ON public.altercpa_sync_runs (account_id, kind, started_at DESC);

-- Status words: ok · stale · failing · n/a. See the header for the thresholds
-- (identical to insights_overview's frj; KEEP IN STEP). Counts read only the
-- last 7 days and 'last ok / last run / last failure' are index-backed probes,
-- so the 60-second auto-refresh stays cheap as the run logs grow
-- (altercpa_sync_runs gains ~900 rows a day).
CREATE OR REPLACE FUNCTION public.integrations_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH v AS (
  SELECT now() AS now_ts,
         now() AT TIME ZONE 'Europe/Skopje' AS l,
         (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
         ((((now() AT TIME ZONE 'Europe/Skopje')::date) - 6)::timestamp AT TIME ZONE 'Europe/Skopje') AS since7
),
days AS (
  SELECT (v.today - g)::date AS d FROM v, generate_series(0, 6) g
),
-- The 07:00–20:55 Skopje crons: outside the working day "fresh" means "the
-- last run of the day happened". mex = fr_mex_expect of insights_overview.
expect AS (
  SELECT CASE WHEN v.l::time BETWEEN time '07:45' AND time '21:00' THEN v.now_ts
              WHEN v.l::time < time '07:45' THEN ((v.l::date - 1) + time '20:40') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '20:40') AT TIME ZONE 'Europe/Skopje' END AS mex,
         CASE WHEN v.l::time BETWEEN time '07:30' AND time '21:00' THEN v.now_ts
              WHEN v.l::time < time '07:30' THEN ((v.l::date - 1) + time '20:55') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '20:55') AT TIME ZONE 'Europe/Skopje' END AS acpa_status
    FROM v
),
-- Every sync run of the last 7 Skopje days in one shape, keyed by the card it
-- belongs to (24 h counts and the strip). st: ok (web 'partial' counts, as in
-- the Overview) · failed · running; a run still running after 15 minutes is
-- hung = failed. MEX runs are shared by both accounts: an ok run counts for
-- the account it fetched (skipped ? fetched_<acct>, the Overview's test) with
-- that account's row count; a failed run fails BOTH (it stops before
-- matching, so no order moved).
feed_runs AS (
  SELECT x.fkey, x.job, x.started_at, x.rows_in,
         CASE WHEN x.st = 'running' AND x.started_at < v.now_ts - interval '15 minutes' THEN 'failed'
              ELSE x.st END AS st
    FROM v, (
      SELECT 'altercpa'::text AS fkey, r.kind AS job, r.started_at,
             coalesce(r.ledger_new, 0) AS rows_in,
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END AS st
        FROM public.altercpa_sync_runs r
        JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'mex_' || a.acct, r.kind, r.started_at,
             coalesce((r.skipped ->> ('fetched_' || a.acct))::integer, 0),
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.mex_sync_runs r
        JOIN (VALUES ('bio_natural'), ('natura')) a(acct)
          ON r.status <> 'ok' OR r.skipped ? ('fetched_' || a.acct)
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'web', r.kind, r.started_at,
             coalesce(r.new_orders, 0) + coalesce(r.changed_orders, 0),
             CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.web_sync_runs r
       WHERE r.started_at >= (SELECT since7 FROM v)
    ) x
),
-- The jobs each card is expected to run (the cron.job schedules), plus any
-- other kind seen this week (a manual backfill …). An expected job that has
-- stopped running entirely still shows — as stale — instead of vanishing.
expected AS (
  SELECT * FROM (VALUES
    ('altercpa',        'rolling',     'rolling_2m'),
    ('altercpa',        'status',      'daytime_5m'),
    ('altercpa',        'nightly',     'nightly'),
    ('altercpa',        'weekly',      'weekly'),
    ('mex_bio_natural', 'rolling',     'daytime_30m'),
    ('mex_bio_natural', 'backfill',    'weekly'),
    ('mex_natura',      'rolling',     'daytime_30m'),
    ('mex_natura',      'backfill',    'weekly'),
    ('web',             'incremental', 'every_15m'),
    ('web',             'backfill',    'nightly')
  ) e(fkey, job, expect)
),
job_set AS (
  SELECT e.fkey, e.job, e.expect FROM expected e
  UNION
  SELECT DISTINCT f.fkey, f.job, 'manual' FROM feed_runs f
   WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.fkey = f.fkey AND e.job = f.job)
),
-- Last ok / last settled / last failure per job, over ALL history, each an
-- index-backed "newest matching row" probe (altercpa_sync_runs:
-- (account_id, started_at DESC)); a chronically failing job costs a scan
-- back to its last success, nothing else does.
job_last AS (
  SELECT js.fkey, js.job, js.expect, lo.finished_at AS last_ok, ls.started_at AS last_settled_at, ls.st AS last_status,
         lf.started_at AS last_failed_at, left(lf.error, 1000) AS last_error
    FROM job_set js
    CROSS JOIN v
    LEFT JOIN LATERAL (
      (SELECT r.finished_at FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job AND r.status = 'ok'
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job AND r.status = 'ok'
          AND r.skipped ? ('fetched_' || substr(js.fkey, 5))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job AND r.status IN ('ok', 'partial')
        ORDER BY r.started_at DESC LIMIT 1)
    ) lo ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
         FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END
         FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status <> 'ok' OR r.skipped ? ('fetched_' || substr(js.fkey, 5)))
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
         FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
    ) ls ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, r.error FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, r.error FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, coalesce(r.error, r.warning) FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'partial', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
    ) lf ON true
),
job_counts AS (
  SELECT f.fkey, f.job,
         max(f.started_at)                                                                          AS last_run_7d,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st <> 'running') AS runs_24h,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'failed')   AS failed_24h,
         coalesce(sum(f.rows_in) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'ok'), 0) AS rows_24h
    FROM feed_runs f, v
   GROUP BY f.fkey, f.job
),
jobs_status AS (
  SELECT jl.*,
         coalesce(jc.last_run_7d, jl.last_settled_at) AS last_run,
         coalesce(jc.runs_24h, 0) AS runs_24h, coalesce(jc.failed_24h, 0) AS failed_24h, coalesce(jc.rows_24h, 0) AS rows_24h,
         CASE
           WHEN jl.last_status = 'failed' THEN 'failing'
           WHEN jl.last_ok IS NULL THEN CASE WHEN jl.expect = 'manual' THEN 'n/a' ELSE 'failing' END
           WHEN jl.expect = 'rolling_2m'  AND jl.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_5m'  AND jl.last_ok < e.acpa_status - interval '30 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_30m' AND jl.last_ok < e.mex - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'every_15m'   AND jl.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'nightly'     AND jl.last_ok < v.now_ts - interval '26 hours' THEN 'stale'
           WHEN jl.expect = 'weekly'      AND jl.last_ok < v.now_ts - interval '8 days' THEN 'stale'
           ELSE 'ok'
         END AS status
    FROM job_last jl
    LEFT JOIN job_counts jc ON jc.fkey = jl.fkey AND jc.job = jl.job
    CROSS JOIN v
    CROSS JOIN expect e
),
feed_agg AS (
  SELECT js.fkey,
         jsonb_agg(jsonb_build_object(
           'job', js.job, 'expect', js.expect, 'status', js.status,
           'last_ok_at', js.last_ok, 'last_run_at', js.last_run, 'last_run_status', js.last_status,
           'last_error', js.last_error, 'last_error_at', js.last_failed_at,
           'runs_24h', js.runs_24h, 'failed_24h', js.failed_24h, 'rows_24h', js.rows_24h)
           ORDER BY CASE js.job WHEN 'rolling' THEN 0 WHEN 'incremental' THEN 0 WHEN 'status' THEN 1
                                WHEN 'nightly' THEN 2 WHEN 'weekly' THEN 3 WHEN 'backfill' THEN 4 ELSE 5 END,
                    js.job) AS jobs,
         sum(js.runs_24h)       AS runs_24h,
         sum(js.failed_24h)     AS failed_24h,
         max(js.last_run)       AS last_run_at,
         max(js.last_failed_at) AS last_failed_at,
         (array_agg(js.last_error ORDER BY js.last_failed_at DESC NULLS LAST))[1] AS last_error
    FROM jobs_status js
   GROUP BY js.fkey
),
-- 7-day strip: settled runs per Skopje day.
strip AS (
  SELECT f.fkey, (f.started_at AT TIME ZONE 'Europe/Skopje')::date AS d,
         count(*) FILTER (WHERE f.st = 'ok')     AS ok,
         count(*) FILTER (WHERE f.st = 'failed') AS failed
    FROM feed_runs f
   GROUP BY 1, 2
),
strips AS (
  SELECT fk.k AS fkey,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM (VALUES ('altercpa'), ('mex_bio_natural'), ('mex_natura'), ('web')) fk(k)
    CROSS JOIN days d
    LEFT JOIN strip s ON s.fkey = fk.k AND s.d = d.d
   GROUP BY fk.k
),
-- ── headline statuses: the Overview's frj formulas ─────────────────────────
-- AlterCPA: the rolling job alone. MEX: last ok for the account in 10 days
-- (else the register's last sighting); last status = the newest settled MEX
-- run of any kind in 10 days (both cards share it, as in the Overview). Web:
-- any kind.
h_acpa AS (
  SELECT js.last_ok, js.last_status FROM jobs_status js WHERE js.fkey = 'altercpa' AND js.job = 'rolling'
),
mex_last AS (
  SELECT CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
    FROM public.mex_sync_runs r, v
   WHERE r.started_at > v.now_ts - interval '10 days'
     AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
   ORDER BY r.started_at DESC
   LIMIT 1
),
parcels AS (
  SELECT p.account,
         max(p.last_seen_at)   AS last_seen,
         max(p.last_update_at) AS data_through,
         count(*) FILTER (WHERE p.created_at_mex > v.now_ts - interval '24 hours') AS parcels_new,
         count(*) FILTER (WHERE p.last_update_at > v.now_ts - interval '24 hours') AS parcels_moved,
         count(*) FILTER (WHERE p.delivered_at   > v.now_ts - interval '24 hours') AS delivered,
         count(*) FILTER (WHERE p.returned_at    > v.now_ts - interval '24 hours') AS returned
    FROM public.mex_parcels p, v
   GROUP BY p.account
),
h_mex AS (
  SELECT a.acct,
         coalesce((SELECT max(r.finished_at) FROM public.mex_sync_runs r, v
                    WHERE r.status = 'ok' AND r.started_at > v.now_ts - interval '10 days'
                      AND r.skipped ? ('fetched_' || a.acct)),
                  pc.last_seen) AS last_ok,
         (SELECT st FROM mex_last) AS last_status,
         pc.data_through,
         jsonb_build_object('parcels_new', coalesce(pc.parcels_new, 0), 'parcels_moved', coalesce(pc.parcels_moved, 0),
                            'delivered', coalesce(pc.delivered, 0), 'returned', coalesce(pc.returned, 0)) AS rows
    FROM (VALUES ('bio_natural'), ('natura')) a(acct)
    LEFT JOIN parcels pc ON pc.account = a.acct
),
h_web AS (
  SELECT (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')) AS last_ok,
         (SELECT CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
            FROM public.web_sync_runs r, v
           WHERE NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
           ORDER BY r.started_at DESC LIMIT 1) AS last_status
),
-- ── rows that came in ──────────────────────────────────────────────────────
r_acpa AS (
  SELECT count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours')                                  AS leads_new,
         count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours' AND upper(coalesce(l.geo, '')) = 'MK') AS leads_mk,
         count(*) FILTER (WHERE l.first_seen_at >= (v.today::timestamp AT TIME ZONE 'Europe/Skopje'))             AS leads_today
    FROM public.altercpa_leads l, v
   WHERE l.first_seen_at > v.now_ts - interval '2 days'
),
r_acpa_runs AS (
  SELECT coalesce(sum(r.orders_created) FILTER (WHERE r.status = 'ok'), 0) AS orders_created,
         coalesce(sum(r.orders_updated) FILTER (WHERE r.status = 'ok'), 0) AS orders_updated
    FROM public.altercpa_sync_runs r
    JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
    CROSS JOIN v
   WHERE r.started_at > v.now_ts - interval '24 hours'
),
r_web AS (
  SELECT (SELECT count(*) FROM public.web_orders w, v WHERE w.created_at > v.now_ts - interval '24 hours') AS orders_new,
         (SELECT coalesce(sum(r.changed_orders), 0) FROM public.web_sync_runs r, v
           WHERE r.started_at > v.now_ts - interval '24 hours' AND r.status IN ('ok', 'partial')) AS orders_changed
),
-- collabBox: whatever THE helper says (collabbox_feed_state, 6a above — the
-- Overview reads the same). It has no run log yet, so no runs and no strip:
-- documents are not runs.
cb AS (
  SELECT public.collabbox_feed_state() AS j
),
-- ── pg_cron ────────────────────────────────────────────────────────────────
-- job_run_details (never purged; 213k rows on 2026-09-28) has only its runid
-- primary key. runid is monotonic, so the newest 50.000 runs are a PK range
-- scan instead of a full-table seq scan — ~12 days at today's ~4.100 runs/day,
-- the 8 days read here with room for the schedule to grow by half. Past that
-- the strip's oldest days read short; they never read wrong.
cron_runs AS (
  SELECT d.jobid, d.status, d.start_time, d.end_time, d.return_message
    FROM cron.job_run_details d, v
   WHERE d.runid > (SELECT coalesce(max(x.runid), 0) - 50000 FROM cron.job_run_details x)
     AND d.start_time >= v.now_ts - interval '8 days'
),
cron_agg AS (
  SELECT c.jobid,
         max(c.start_time)                                                   AS last_start,
         max(c.start_time) FILTER (WHERE c.status = 'failed')               AS last_failed,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours') AS runs_24h,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours' AND c.status = 'failed') AS failed_24h
    FROM cron_runs c, v
   GROUP BY c.jobid
),
cron_last AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.status, c.start_time, c.end_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_start
   ORDER BY a.jobid
),
cron_fail AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.start_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_failed AND c.status = 'failed'
   ORDER BY a.jobid
),
cron_strip AS (
  SELECT j.jobid,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM cron.job j
    CROSS JOIN days d
    LEFT JOIN (SELECT c.jobid, (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d,
                      count(*) FILTER (WHERE c.status = 'succeeded') AS ok,
                      count(*) FILTER (WHERE c.status = 'failed')    AS failed
                 FROM cron_runs c, v
                WHERE c.start_time >= v.since7
                GROUP BY 1, 2) s ON s.jobid = j.jobid AND s.d = d.d
   GROUP BY j.jobid
),
cron_json AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
           -- pg_cron "succeeded" on an invoke_* job only means the HTTP call was
           -- queued; the feed cards above say whether the sync itself worked.
           'status', CASE WHEN NOT j.active THEN 'n/a'
                          WHEN cl.jobid IS NULL THEN 'n/a'
                          WHEN cl.status = 'failed' THEN 'failing'
                          ELSE 'ok' END,
           'last_status', cl.status, 'last_start', cl.start_time, 'last_end', cl.end_time,
           'last_message', cl.msg,
           'last_error', cf.msg, 'last_error_at', cf.start_time,
           'runs_24h', coalesce(ca.runs_24h, 0), 'failed_24h', coalesce(ca.failed_24h, 0),
           'days', cs.days)
         ORDER BY j.jobname), '[]'::jsonb) AS j
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
    LEFT JOIN cron_fail cf ON cf.jobid = j.jobid
    LEFT JOIN cron_agg ca ON ca.jobid = j.jobid
    LEFT JOIN cron_strip cs ON cs.jobid = j.jobid
),
-- ── the 7-day no-parcel rule ───────────────────────────────────────────────
np AS (
  SELECT c.cfg,
         coalesce(c.cfg ->> 'mode', 'report') AS mode,
         greatest(coalesce((c.cfg ->> 'days')::int, 7), 3) AS days_n,
         coalesce((c.cfg ->> 'hour')::int, 21) AS hour_n
    FROM (SELECT coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'no_parcel_rule'), '{}'::jsonb) AS cfg) c
),
np_runs AS (
  SELECT max(r.ran_at) AS last_any,
         max(r.ran_at) FILTER (WHERE r.trigger_kind = 'cron') AS last_cron,
         bool_or(r.run_day = v.today AND r.trigger_kind = 'cron') AS cron_today,
         count(*) FILTER (WHERE r.ran_at > v.now_ts - interval '24 hours') AS runs_24h
    FROM public.no_parcel_rule_runs r, v
),
np_slot AS (
  -- The scheduled slot (hour:10 Skopje — apply_no_parcel_rule's own gate)
  -- that should already have run, and the next one.
  SELECT np.*, nr.*,
         CASE WHEN v.l >= (v.today + make_time(np.hour_n, 10, 0))
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today - 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS last_slot,
         CASE WHEN v.l < (v.today + make_time(np.hour_n, 10, 0)) AND NOT coalesce(nr.cron_today, false)
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today + 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS next_run
    FROM np CROSS JOIN np_runs nr CROSS JOIN v
),
np_job AS (
  SELECT j.jobid, j.active, cl.status AS last_status, cl.start_time, cl.msg
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
   WHERE j.jobname = 'no-parcel-rule'
   LIMIT 1
),
np_strip AS (
  SELECT jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.n, 0), 'failed', coalesce(f.n, 0),
                                      'to_cancel', s.to_cancel, 'cancelled', s.cancelled)
                   ORDER BY d.d) AS days
    FROM days d
    LEFT JOIN (SELECT r.run_day AS d, count(*) AS n,
                      (array_agg(r.to_cancel ORDER BY r.ran_at DESC))[1] AS to_cancel,
                      sum(r.cancelled) AS cancelled
                 FROM public.no_parcel_rule_runs r, v
                WHERE r.run_day >= v.today - 6
                GROUP BY r.run_day) s ON s.d = d.d
    LEFT JOIN (SELECT (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d, count(*) AS n
                 FROM cron_runs c JOIN np_job nj ON nj.jobid = c.jobid
                WHERE c.status = 'failed'
                GROUP BY 1) f ON f.d = d.d
),
np_json AS (
  SELECT jsonb_build_object(
    'key', 'no_parcel_rule',
    'settings', s.cfg,
    'mode', s.mode,
    'days_n', s.days_n,
    'hour', s.hour_n,
    'status', CASE WHEN nj.jobid IS NULL OR NOT nj.active THEN 'n/a'
                   WHEN nj.last_status = 'failed' THEN 'failing'
                   -- nothing ran since the slot that should have (20 min grace)
                   WHEN v.now_ts > s.last_slot + interval '20 minutes'
                        AND coalesce(s.last_any, '-infinity'::timestamptz) < s.last_slot - interval '10 minutes' THEN 'stale'
                   ELSE 'ok' END,
    'last_ok_at', s.last_any,
    'last_cron_run_at', s.last_cron,
    'next_run_at', s.next_run,
    'last_run', (SELECT to_jsonb(r) - 'settings' FROM public.no_parcel_rule_runs r ORDER BY r.ran_at DESC LIMIT 1),
    'cron_last_status', nj.last_status,
    'cron_last_at', nj.start_time,
    'last_error', CASE WHEN nj.last_status = 'failed' THEN nj.msg END,
    'runs_24h', s.runs_24h,
    'days', (SELECT days FROM np_strip)) AS j
    FROM np_slot s
    CROSS JOIN v
    LEFT JOIN np_job nj ON true
),
feed_json AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_build_object(
       'key', 'altercpa',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('leads_new', ra.leads_new, 'leads_mk', ra.leads_mk,
                                  'orders_created', rr.orders_created, 'orders_updated', rr.orders_updated),
       'leads_today', ra.leads_today,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_acpa ra CROSS JOIN r_acpa_runs rr
       LEFT JOIN h_acpa h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'altercpa'
       LEFT JOIN strips st ON st.fkey = 'altercpa'),
    (SELECT jsonb_build_object(
       'key', 'mex_bio_natural',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_bio_natural'
       LEFT JOIN strips st ON st.fkey = 'mex_bio_natural'
      WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'key', 'mex_natura',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_natura'
       LEFT JOIN strips st ON st.fkey = 'mex_natura'
      WHERE m.acct = 'natura'),
    (SELECT jsonb_build_object(
       'key', 'web',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status = 'failed' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('orders_new', rw.orders_new, 'orders_changed', rw.orders_changed),
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_web rw
       LEFT JOIN h_web h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'web'
       LEFT JOIN strips st ON st.fkey = 'web'),
    (SELECT jsonb_build_object(
       'key', 'collabbox',
       -- the helper speaks the Overview's words (failed); this page says failing
       'status', CASE WHEN c.j ->> 'status' = 'failed' THEN 'failing'
                      WHEN c.j ->> 'status' IN ('ok', 'stale', 'failing') THEN c.j ->> 'status'
                      ELSE 'n/a' END,
       'last_ok_at', c.j -> 'last_ok_at', 'data_through', c.j -> 'data_through',
       'detail', c.j -> 'detail',
       'last_run_at', NULL, 'last_error', NULL, 'last_error_at', NULL,
       'runs_24h', 0, 'failed_24h', 0,
       'rows', jsonb_build_object('lag_parcels', coalesce((c.j ->> 'lag_parcels')::bigint, 0)),
       'jobs', '[]'::jsonb,
       'days', NULL)
       FROM cb c)
  ) AS j
)
SELECT jsonb_build_object(
  'generated_at', (SELECT now_ts FROM v),
  'today', (SELECT today FROM v),
  'feeds', (SELECT j FROM feed_json),
  'no_parcel', (SELECT j FROM np_json),
  'cron', (SELECT j FROM cron_json)
);
$fn$;

COMMENT ON FUNCTION public.integrations_health() IS
  'Settings → Integrations health (2026-09-28): per feed (AlterCPA, MEX bio_natural / natura, web shop, collabBox) status ok|stale|failing|n/a on the insights_overview freshness thresholds, last success, last error, runs/rows in 24 h, per-job rows and a 7-day ok/failed strip; the 7-day no-parcel rule (mode, last run, next run); every pg_cron job. Owners only, via GET /api/integrations/health.';

-- ── 7. Read: one no-parcel run's rows (the CSV) ────────────────────────────
CREATE OR REPLACE FUNCTION public.no_parcel_rule_report(p_run_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH run AS (
  SELECT r.* FROM public.no_parcel_rule_runs r
   WHERE (p_run_id IS NULL OR r.id = p_run_id)
   ORDER BY r.ran_at DESC
   LIMIT 1
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM run) THEN NULL ELSE jsonb_build_object(
  'run', (SELECT to_jsonb(run) - 'settings' FROM run),
  'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'order_id', i.order_id,
              'display_id', coalesce(o.display_id, i.display_id),
              'customer_name', o.customer_name,
              'customer_phone', o.customer_phone,
              'city', o.customer_city,
              'product', o.product_name,
              'quantity', o.quantity,
              'price_eur', i.price_eur,
              'sold_at', i.sold_at,
              'days_waiting', i.days_waiting,
              'seller', sp.display_name,
              'sale_source', o.sale_source,
              'status_now', o.status,
              'action', i.action,
              'parcel', i.parcel_tracking,
              'other_order', oo.display_id)
            ORDER BY CASE i.action WHEN 'cancel' THEN 0 WHEN 'cancelled' THEN 0 WHEN 'needs_linking' THEN 1 ELSE 2 END,
                     i.sold_at, coalesce(o.display_id, i.display_id)), '[]'::jsonb)
             FROM run
             JOIN public.no_parcel_rule_items i ON i.run_id = run.id
             LEFT JOIN public.orders o ON o.id = i.order_id
             LEFT JOIN public.orders oo ON oo.id = i.other_order_id
             LEFT JOIN public.sales_people sp ON sp.id = i.sold_by_person_id)
) END;
$fn$;

COMMENT ON FUNCTION public.no_parcel_rule_report(uuid) IS
  'The rows of one 7-day no-parcel run (default: the latest) joined to orders — display id, customer, phone, city, product, price (EUR; the UI shows denari), sold at, seller, action, parcel. Owners only, via GET /api/integrations/no-parcel-rule/report (the Settings → Integrations health CSV).';

-- ── 7b. Write: the no-parcel rule's Report ↔ Apply switch ──────────────────
-- Only `mode` changes; days / sources / from_date / hour stay as they are. One
-- statement, so two owners flipping at once cannot lose each other's other
-- keys. apply_no_parcel_rule() re-reads the setting on every run, so the next
-- 21:10 Skopje run follows the new mode.
CREATE OR REPLACE FUNCTION public.no_parcel_rule_set_mode(p_mode text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _before jsonb;
  _after  jsonb;
BEGIN
  IF p_mode NOT IN ('report', 'apply') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_mode');
  END IF;
  SELECT value INTO _before FROM public.app_settings WHERE key = 'no_parcel_rule' FOR UPDATE;
  IF NOT FOUND THEN
    -- The rule's migration (20260938000000) seeds the row; without it there is no rule to switch.
    RETURN jsonb_build_object('ok', false, 'error', 'rule_not_installed');
  END IF;
  UPDATE public.app_settings
     SET value      = coalesce(value, '{}'::jsonb) || jsonb_build_object('mode', p_mode),
         updated_at = now(),
         updated_by = p_actor
   WHERE key = 'no_parcel_rule'
  RETURNING value INTO _after;
  RETURN jsonb_build_object('ok', true, 'before', _before, 'after', _after);
END;
$fn$;

COMMENT ON FUNCTION public.no_parcel_rule_set_mode(text, uuid) IS
  'Settings → Integrations health: set app_settings.no_parcel_rule.mode (report | apply), nothing else. The api gates it to business owners and writes the audit_log row with the dry-run count the next run would cancel.';

-- The switch decides whether ~500 orders get cancelled tonight, and it is
-- owners-only. app_settings, though, is writable by ANY admin/manager session
-- straight through PostgREST (policy "Admins can manage app_settings" +
-- the default table grants, checked 2026-09-28), which would bypass both the
-- owner gate and the audit row. Close that for this one key: an API session
-- (anon / authenticated) may not write it; the service role (the api, after
-- its owner check) and the migration role still can. Every other key keeps
-- its current behaviour.
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = 'no_parcel_rule'
          OR (TG_OP = 'UPDATE' AND OLD.key = 'no_parcel_rule')) THEN
    RAISE EXCEPTION 'app_settings.no_parcel_rule is changed only through the owners'' switch (Settings → Integrations health)'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tg_app_settings_guard_owner_keys() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_app_settings_guard_owner_keys ON public.app_settings;
CREATE TRIGGER trg_app_settings_guard_owner_keys
BEFORE INSERT OR UPDATE OR DELETE ON public.app_settings
FOR EACH ROW
EXECUTE FUNCTION public.tg_app_settings_guard_owner_keys();

-- ── 8. Grants: service role only ───────────────────────────────────────────
REVOKE ALL ON FUNCTION public.no_parcel_rule_set_mode(text, uuid)                               FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.no_parcel_rule_set_mode(text, uuid)                               TO service_role;
REVOKE ALL ON FUNCTION public.sales_teams_admin_overview()                                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_teams_unmapped(integer)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_person_add_identity(uuid, text, uuid, text, text)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_person_remove_identity(uuid)                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_person_create(text, uuid, boolean, text, text, date, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_person_update(uuid, jsonb)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_person_move_team(uuid, text, date, text, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_membership_delete(uuid)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.integrations_health()                                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_parcel_rule_report(uuid)                                       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.sales_teams_admin_overview()                                      TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_teams_unmapped(integer)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_person_add_identity(uuid, text, uuid, text, text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_person_remove_identity(uuid)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_person_create(text, uuid, boolean, text, text, date, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_person_update(uuid, jsonb)                                  TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_person_move_team(uuid, text, date, text, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_membership_delete(uuid)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.integrations_health()                                             TO service_role;
GRANT EXECUTE ON FUNCTION public.no_parcel_rule_report(uuid)                                       TO service_role;

NOTIFY pgrst, 'reload schema';
