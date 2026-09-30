-- ============================================================================
-- THE ASSIGNER'S DISTRIBUTION, IN SQL — assigner_distribute() (30.09.2026)
--
-- Owner decisions 29.09 (plan "Assigner redesign", Part A4): one count
-- (20 / 50 / 100 / 200 / all / custom) goes to ONE operator or is shared across
-- several (100 over 3 = 34 / 33 / 33), or is given to EACH ("per agent");
-- newest or oldest first (random for lists); lists and call-agains can be split
-- by department. Selected and written on the server, atomically — the old
-- routes pulled ids into the edge function and wrote them back in chunks.
--
-- assigner_distribute(p_kind, p_list_id, p_departments, p_order, p_count,
--                     p_split, p_agent_ids, p_include_assigned, p_dry_run,
--                     p_source DEFAULT 'all', p_actor_name DEFAULT NULL) → jsonb
--
-- KINDS (the pool; "unassigned" unless p_include_assigned)
--   'list'         members of p_list_id, NOT is_completed; department = the
--                  BUYER's (customer_departments; no row = 'unknown'). The list
--                  must be active and ASSIGNABLE: NOT is_static, or 'FULL MONAD
--                  LIST' / 'Trash List' (ASSIGNABLE_STATIC in AssignerPage.tsx) —
--                  anything else raises 'list is not assignable'.
--   'pendings'     orders status = 'pending' on LEAD sources only (lead rules 4 /
--                  6 — is_lead_source); department = the ORDER's own
--                  cohort_order_source(4-arg). take / call_again are never taken.
--   'call_agains'  lead orders in 'call_again' (department = the order's) +
--                  members with call_again_since set and NOT is_completed
--                  (department = the buyer's). p_source 'order' | 'prediction' |
--                  'all'. Callbacks stay pool-owned (any agent may still claim
--                  one on /calls).
-- ORDER            'newest' / 'oldest' by the natural time — members
--                  trigger_event_at (the "Last order" date), pendings created_at,
--                  call-agains call_again_since; a missing time sorts last either
--                  way. 'random' — lists only.
-- COUNT / SPLIT    p_count NULL = all. 'total': p_count items shared round-robin
--                  in the agents' given order (100 over 3 = 34/33/33 — the first
--                  agents take the remainder); 'per_agent': p_count EACH (the
--                  selection is p_count × agents, dealt round-robin, so everyone
--                  gets the same mix of new and old). One agent: both the same.
--                  A pool smaller than asked is dealt the same way.
-- AGENTS           p_agent_ids, duplicates dropped (first position kept); each
--                  must be an ACTIVE profile holding a staff role; the name
--                  written is profiles.full_name (else the e-mail).
-- CONCURRENCY      a real run selects with FOR UPDATE SKIP LOCKED: two admins
--                  distributing at once get disjoint rows, and a row the lead
--                  engine (assign_one_lead) is stamping is skipped.
-- WRITES           ONLY the assignment triple — assigned_agent_id,
--                  assigned_agent_name, assigned_at — plus assigned_by on orders
--                  (p_actor_name). Never is_completed, last_call_*,
--                  in_call_again_until, call_again_since or confirmed_by_*.
--                  Orders are written under elyon.keep_updated_at = 'on': GET
--                  /call-agains read orders.updated_at as the last call, and an
--                  assignment is not a call (the flag is reset right after).
--                  Each UPDATE re-checks the pool condition.
-- DRY RUN          p_dry_run (NULL counts as true): the same selection without
--                  locks and without writing — safe in a read-only transaction.
-- RETURNS          {kind, dry_run, list_id, departments, order, split, count,
--                   source, agents, pool (eligible now), selected,
--                   per_agent: [{agent_id, full_name, count, orders, members}]
--                   (planned in a dry run, written in a real one),
--                   assigned (0 in a dry run), ids (≤ 5000, else null:
--                   'order:<uuid>' / 'member:<list_id>:<phone>'), ids_truncated}
-- Errors raise SQLSTATE 22023 with a short message (invalid kind / order /
-- split / source / count / department, no agents, inactive or unknown agent,
-- list not found / not active / not assignable, list_id required).
--
-- The api (POST /api/assigner/distribute) gates it (module assigner + admin /
-- manager), rate-limits it, audits a real run (assigner.distribute) and sends
-- each agent the notification the old per-kind routes sent.
-- Access: service role only.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.assigner_distribute(
  p_kind             text,
  p_list_id          uuid,
  p_departments      text[],
  p_order            text,
  p_count            integer,
  p_split            text,
  p_agent_ids        uuid[],
  p_include_assigned boolean,
  p_dry_run          boolean,
  p_source           text DEFAULT 'all',
  p_actor_name       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_keys    CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                     'social', 'web', 'unknown'];
  c_ids_cap CONSTANT integer := 5000;
  v_kind    text    := lower(btrim(coalesce(p_kind, '')));
  v_order   text    := lower(btrim(coalesce(p_order, 'newest')));
  v_split   text    := lower(btrim(coalesce(p_split, 'total')));
  v_source  text    := lower(btrim(coalesce(p_source, 'all')));
  v_incl    boolean := coalesce(p_include_assigned, false);
  v_dry     boolean := coalesce(p_dry_run, true);
  v_actor   text    := coalesce(nullif(btrim(p_actor_name), ''), 'Assigner');
  v_now     timestamptz := now();
  v_sel     text[];
  v_bad     text;
  v_agents  uuid[];
  v_names   text[];
  v_n       integer;
  v_need    integer;
  v_list    record;
  v_sk      text;
  v_qo      text;   -- orders branch
  v_qm      text;   -- members branch
  v_lock_o  text;
  v_lock_m  text;
  v_pool    integer := 0;
  v_cnt     integer;
  v_src     text[];
  v_oid     uuid[];
  v_lid     uuid[];
  v_ph      text[];
  v_selected integer := 0;
  v_done_o  integer[];
  v_done_m  integer[];
  v_prev    text;
  v_assigned integer := 0;
  v_per     jsonb;
  v_ids     jsonb;
BEGIN
  -- ── arguments ──────────────────────────────────────────────────────────────
  IF v_kind NOT IN ('list', 'pendings', 'call_agains') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF v_order NOT IN ('newest', 'oldest', 'random') THEN
    RAISE EXCEPTION 'invalid order: %', p_order USING ERRCODE = '22023';
  END IF;
  IF v_order = 'random' AND v_kind <> 'list' THEN
    RAISE EXCEPTION 'invalid order: random is for lists only' USING ERRCODE = '22023';
  END IF;
  IF v_split NOT IN ('total', 'per_agent') THEN
    RAISE EXCEPTION 'invalid split: %', p_split USING ERRCODE = '22023';
  END IF;
  IF v_source NOT IN ('all', 'order', 'prediction') THEN
    RAISE EXCEPTION 'invalid source: %', p_source USING ERRCODE = '22023';
  END IF;
  IF p_count IS NOT NULL AND p_count < 1 THEN
    RAISE EXCEPTION 'invalid count: % (a positive number, or null for all)', p_count USING ERRCODE = '22023';
  END IF;

  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(k ORDER BY i) INTO v_sel
      FROM unnest(c_keys) WITH ORDINALITY AS u(k, i)
     WHERE k = ANY (p_departments);
  END IF;

  -- agents: duplicates dropped, the given order kept
  SELECT array_agg(z.a ORDER BY z.i) INTO v_agents
    FROM (SELECT DISTINCT ON (u.a) u.a, u.i
            FROM unnest(p_agent_ids) WITH ORDINALITY AS u(a, i)
           WHERE u.a IS NOT NULL
           ORDER BY u.a, u.i) z;
  v_n := coalesce(cardinality(v_agents), 0);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'no agents' USING ERRCODE = '22023';
  END IF;

  SELECT u.a::text INTO v_bad
    FROM unnest(v_agents) AS u(a)
   WHERE NOT EXISTS (
           SELECT 1 FROM public.profiles p
            WHERE p.user_id = u.a AND p.is_active
              AND EXISTS (SELECT 1 FROM public.user_roles r
                           WHERE r.user_id = p.user_id AND r.role::text <> 'affiliate'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'inactive or unknown agent: %', v_bad USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(coalesce(nullif(btrim(p.full_name), ''), p.email) ORDER BY u.i) INTO v_names
    FROM unnest(v_agents) WITH ORDINALITY AS u(a, i)
    JOIN public.profiles p ON p.user_id = u.a;

  IF v_kind = 'list' THEN
    IF p_list_id IS NULL THEN
      RAISE EXCEPTION 'list_id required' USING ERRCODE = '22023';
    END IF;
    SELECT l.id, l.name, l.is_static, l.is_active INTO v_list
      FROM public.prediction_segment_lists l WHERE l.id = p_list_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'list not found' USING ERRCODE = '22023';
    END IF;
    IF NOT v_list.is_active THEN
      RAISE EXCEPTION 'list is not active' USING ERRCODE = '22023';
    END IF;
    IF v_list.is_static AND v_list.name NOT IN ('FULL MONAD LIST', 'Trash List') THEN
      RAISE EXCEPTION 'list is not assignable' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_need := CASE WHEN p_count IS NULL THEN NULL
                 WHEN v_split = 'per_agent' THEN p_count * v_n
                 ELSE p_count END;

  -- ── the pool ───────────────────────────────────────────────────────────────
  -- One sort key for every branch: newest = −epoch, oldest = +epoch, random.
  -- $1 list_id · $2 include_assigned · $3 departments · $4 need · $5 source
  v_sk := CASE v_order WHEN 'newest' THEN '-extract(epoch FROM %1$s)::float8'
                       WHEN 'oldest' THEN 'extract(epoch FROM %1$s)::float8'
                       ELSE 'random()' END;

  IF v_kind = 'list' THEN
    v_qm := format($q$
      SELECT 'm'::text AS src, NULL::uuid AS oid, m.list_id AS lid, m.customer_phone AS ph,
             %s AS sk, m.list_id::text || '|' || m.customer_phone AS tb
        FROM public.prediction_segment_members m
        LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
       WHERE m.list_id = $1
         AND NOT m.is_completed
         AND ($2 OR m.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(cd.department) = ANY ($3::text[]))$q$,
      format(v_sk, 'm.trigger_event_at'));
  ELSIF v_kind = 'pendings' THEN
    v_qo := format($q$
      SELECT 'o'::text AS src, o.id AS oid, NULL::uuid AS lid, NULL::text AS ph,
             %s AS sk, o.id::text AS tb
        FROM public.orders o
       WHERE o.status = 'pending'
         AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
         AND ($2 OR o.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(public.cohort_order_source(
               o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) = ANY ($3::text[]))$q$,
      format(v_sk, 'o.created_at'));
  ELSE
    v_qo := format($q$
      SELECT 'o'::text AS src, o.id AS oid, NULL::uuid AS lid, NULL::text AS ph,
             %s AS sk, o.id::text AS tb
        FROM public.orders o
       WHERE o.status = 'call_again'
         AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
         AND ($2 OR o.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(public.cohort_order_source(
               o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) = ANY ($3::text[]))
         AND $5 IN ('all', 'order')$q$,
      format(v_sk, 'o.call_again_since'));
    v_qm := format($q$
      SELECT 'm'::text AS src, NULL::uuid AS oid, m.list_id AS lid, m.customer_phone AS ph,
             %s AS sk, m.list_id::text || '|' || m.customer_phone AS tb
        FROM public.prediction_segment_members m
        LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
       WHERE m.call_again_since IS NOT NULL
         AND NOT m.is_completed
         AND ($2 OR m.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(cd.department) = ANY ($3::text[]))
         AND $5 IN ('all', 'prediction')$q$,
      format(v_sk, 'm.call_again_since'));
  END IF;

  IF v_qo IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::int FROM (' || v_qo || ') c' INTO v_cnt
      USING p_list_id, v_incl, v_sel, v_need, v_source;
    v_pool := v_pool + v_cnt;
  END IF;
  IF v_qm IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::int FROM (' || v_qm || ') c' INTO v_cnt
      USING p_list_id, v_incl, v_sel, v_need, v_source;
    v_pool := v_pool + v_cnt;
  END IF;

  -- ── the selection (locked in a real run) ───────────────────────────────────
  v_lock_o := CASE WHEN v_dry THEN '' ELSE ' FOR UPDATE OF o SKIP LOCKED' END;
  v_lock_m := CASE WHEN v_dry THEN '' ELSE ' FOR UPDATE OF m SKIP LOCKED' END;

  EXECUTE
    'SELECT coalesce(array_agg(x.src ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.oid ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.lid ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.ph  ORDER BY x.sk NULLS LAST, x.tb), ''{}'')'
    || '  FROM (SELECT u.* FROM ('
    || CASE WHEN v_qo IS NOT NULL
            THEN 'SELECT a.* FROM (' || v_qo || ' ORDER BY sk NULLS LAST, tb LIMIT $4' || v_lock_o || ') a'
            ELSE '' END
    || CASE WHEN v_qo IS NOT NULL AND v_qm IS NOT NULL THEN ' UNION ALL ' ELSE '' END
    || CASE WHEN v_qm IS NOT NULL
            THEN 'SELECT b.* FROM (' || v_qm || ' ORDER BY sk NULLS LAST, tb LIMIT $4' || v_lock_m || ') b'
            ELSE '' END
    || '  ) u ORDER BY u.sk NULLS LAST, u.tb LIMIT $4) x'
    INTO v_src, v_oid, v_lid, v_ph
    USING p_list_id, v_incl, v_sel, v_need, v_source;

  v_selected := coalesce(cardinality(v_src), 0);

  -- ── the deal: item k (1-based, in the chosen order) → agent ((k-1) mod n)+1
  -- planned per agent (a dry run reports these)
  SELECT coalesce(array_agg(coalesce(c.o, 0) ORDER BY g.ai), '{}'),
         coalesce(array_agg(coalesce(c.m, 0) ORDER BY g.ai), '{}')
    INTO v_done_o, v_done_m
    FROM generate_series(1, v_n) AS g(ai)
    LEFT JOIN (
      SELECT ((s.k - 1) % v_n + 1)::int AS ai,
             count(*) FILTER (WHERE s.src = 'o')::int AS o,
             count(*) FILTER (WHERE s.src = 'm')::int AS m
        FROM unnest(v_src) WITH ORDINALITY AS s(src, k)
       GROUP BY 1) c ON c.ai = g.ai;

  -- ── the writes ─────────────────────────────────────────────────────────────
  IF NOT v_dry AND v_selected > 0 THEN
    IF 'o' = ANY (v_src) THEN
      -- an assignment is not a call: keep orders.updated_at (GET /call-agains)
      v_prev := current_setting('elyon.keep_updated_at', true);
      PERFORM set_config('elyon.keep_updated_at', 'on', true);

      WITH s AS (
        SELECT s.oid, ((s.k - 1) % v_n + 1)::int AS ai
          FROM unnest(v_src, v_oid) WITH ORDINALITY AS s(src, oid, k)
         WHERE s.src = 'o'
      ),
      u AS (
        UPDATE public.orders o
           SET assigned_agent_id   = v_agents[s.ai],
               assigned_agent_name = v_names[s.ai],
               assigned_at         = v_now,
               assigned_by         = v_actor
          FROM s
         WHERE o.id = s.oid
           AND o.status = CASE WHEN v_kind = 'pendings' THEN 'pending'::public.order_status
                               ELSE 'call_again'::public.order_status END
           AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
           AND (v_incl OR o.assigned_agent_id IS NULL)
        RETURNING s.ai
      )
      SELECT coalesce(array_agg(coalesce(c.n, 0) ORDER BY g.ai), '{}') INTO v_done_o
        FROM generate_series(1, v_n) AS g(ai)
        LEFT JOIN (SELECT u.ai, count(*)::int AS n FROM u GROUP BY u.ai) c ON c.ai = g.ai;

      PERFORM set_config('elyon.keep_updated_at', coalesce(v_prev, ''), true);
    ELSE
      v_done_o := array_fill(0, ARRAY[v_n]);
    END IF;

    IF 'm' = ANY (v_src) THEN
      WITH s AS (
        SELECT s.lid, s.ph, ((s.k - 1) % v_n + 1)::int AS ai
          FROM unnest(v_src, v_lid, v_ph) WITH ORDINALITY AS s(src, lid, ph, k)
         WHERE s.src = 'm'
      ),
      u AS (
        UPDATE public.prediction_segment_members m
           SET assigned_agent_id   = v_agents[s.ai],
               assigned_agent_name = v_names[s.ai],
               assigned_at         = v_now
          FROM s
         WHERE m.list_id = s.lid
           AND m.customer_phone = s.ph
           AND NOT m.is_completed
           AND (v_kind <> 'call_agains' OR m.call_again_since IS NOT NULL)
           AND (v_incl OR m.assigned_agent_id IS NULL)
        RETURNING s.ai
      )
      SELECT coalesce(array_agg(coalesce(c.n, 0) ORDER BY g.ai), '{}') INTO v_done_m
        FROM generate_series(1, v_n) AS g(ai)
        LEFT JOIN (SELECT u.ai, count(*)::int AS n FROM u GROUP BY u.ai) c ON c.ai = g.ai;
    ELSE
      v_done_m := array_fill(0, ARRAY[v_n]);
    END IF;

    SELECT coalesce(sum(x), 0)::int INTO v_assigned FROM unnest(v_done_o || v_done_m) x;
  END IF;

  -- ── the answer ─────────────────────────────────────────────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'agent_id',  v_agents[g.ai],
           'full_name', v_names[g.ai],
           'count',     v_done_o[g.ai] + v_done_m[g.ai],
           'orders',    v_done_o[g.ai],
           'members',   v_done_m[g.ai]) ORDER BY g.ai)
    INTO v_per
    FROM generate_series(1, v_n) AS g(ai);

  IF v_selected <= c_ids_cap THEN
    SELECT coalesce(jsonb_agg(CASE WHEN s.src = 'o' THEN 'order:' || s.oid::text
                                   ELSE 'member:' || s.lid::text || ':' || s.ph END ORDER BY s.k), '[]'::jsonb)
      INTO v_ids
      FROM unnest(v_src, v_oid, v_lid, v_ph) WITH ORDINALITY AS s(src, oid, lid, ph, k);
  END IF;

  RETURN jsonb_build_object(
    'kind',          v_kind,
    'dry_run',       v_dry,
    'list_id',       p_list_id,
    'departments',   to_jsonb(v_sel),
    'order',         v_order,
    'split',         v_split,
    'count',         p_count,
    'source',        CASE WHEN v_kind = 'call_agains' THEN v_source END,
    'agents',        v_n,
    'pool',          v_pool,
    'selected',      v_selected,
    'assigned',      v_assigned,
    'per_agent',     coalesce(v_per, '[]'::jsonb),
    'ids',           v_ids,
    'ids_truncated', v_selected > c_ids_cap
  );
END;
$fn$;

COMMENT ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text) IS
  'POST /api/assigner/distribute (20260942001960): deals a list''s members (assignable lists only; buyer department filter), unassigned lead pendings, or call-agains (lead call_again orders + member callbacks) to agents — newest / oldest (random for lists), p_count NULL = all, split total (round-robin, first agents take the remainder) or per_agent (p_count each). FOR UPDATE SKIP LOCKED; writes only the assignment triple (+ assigned_by on orders, under elyon.keep_updated_at). p_dry_run = the same selection, no locks, no writes.';

REVOKE ALL ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
