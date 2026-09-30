-- ============================================================================
-- THE ASSIGNER'S LISTS BY THE BUYER'S DEPARTMENT — assigner_lists() (30.09.2026)
--
-- Owner decision 29.09 (plan "Assigner redesign", Part A3): each prediction
-- list's clients are split by the department of the customer's LAST PURCHASE
-- (public.customer_departments, 20260942001955). The lists themselves do not
-- change — the engine still builds them by exact name; the department chips only
-- filter what the Assigner counts and distributes.
--
-- assigner_lists(p_departments text[] DEFAULT NULL) → jsonb
--   departments   the selection, normalised (canonical order, de-duplicated);
--                 NULL = all. Keys: altercpa, elyon_crm, teleshop_out,
--                 teleshop_other, social, web, unknown (unknown = no cache row).
--                 Any other key raises 'invalid department'.
--   lists[]       every ACTIVE list with at least one member (what the Assigner
--                 has always shown: is_active AND member_count > 0), by
--                 display_order then name:
--     id, name, description, category, is_static, display_order
--     assignable      NOT is_static, or the two statics managers distribute
--                     ('FULL MONAD LIST', 'Trash List') — ASSIGNABLE_STATIC in
--                     src/pages/AssignerPage.tsx; the rest (Due to Reorder,
--                     Cancelled Pendings, …) are informational
--     total           members in the SELECTED departments
--     distributable   … not completed AND unassigned (the pool distribute takes)
--     assigned        … with an agent (done included)
--     done            … is_completed
--     open            … not completed
--     by_department   {dept: {total, distributable, assigned, done}} for ALL
--                     seven keys, zeros included, whatever the selection:
--                     Σ by_department[*].total = the list's whole membership
--   totals        Σ over lists[] of total / distributable / assigned / done
--                 (selected departments)
--
-- Members join the cache on the EXACT customer_phone (primary key). ~113k
-- members; see the report for the measured time.
-- Access: service role only.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.assigner_lists(p_departments text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '32MB'          -- the member x cache hash join stays in memory
AS $fn$
DECLARE
  c_keys CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                  'social', 'web', 'unknown'];
  v_sel  text[];
  v_bad  text;
  v_out  jsonb;
BEGIN
  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(k ORDER BY i) INTO v_sel
      FROM unnest(c_keys) WITH ORDINALITY AS u(k, i)
     WHERE k = ANY (p_departments);
  END IF;

  WITH
  lists AS (
    SELECT l.id, l.name, l.description, l.category, l.is_static, l.display_order,
           (NOT l.is_static OR l.name IN ('FULL MONAD LIST', 'Trash List')) AS assignable
    FROM public.prediction_segment_lists l
    WHERE l.is_active
  ),
  agg AS (
    SELECT m.list_id,
           public.assigner_dept_key(cd.department)                                  AS dept,
           count(*)::int                                                              AS total,
           count(*) FILTER (WHERE NOT m.is_completed AND m.assigned_agent_id IS NULL)::int AS distributable,
           count(*) FILTER (WHERE m.assigned_agent_id IS NOT NULL)::int              AS assigned,
           count(*) FILTER (WHERE m.is_completed)::int                               AS done,
           count(*) FILTER (WHERE NOT m.is_completed)::int                           AS open
    FROM public.prediction_segment_members m
    JOIN lists ON lists.id = m.list_id
    LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
    GROUP BY 1, 2
  ),
  per AS (
    SELECT l.id,
           sum(a.total)::int AS all_total,
           coalesce(sum(a.total)         FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS total,
           coalesce(sum(a.distributable) FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS distributable,
           coalesce(sum(a.assigned)      FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS assigned,
           coalesce(sum(a.done)          FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS done,
           coalesce(sum(a.open)          FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS open,
           (SELECT jsonb_object_agg(k.k, jsonb_build_object(
                     'total',         coalesce(b.total, 0),
                     'distributable', coalesce(b.distributable, 0),
                     'assigned',      coalesce(b.assigned, 0),
                     'done',          coalesce(b.done, 0)))
              FROM unnest(c_keys) AS k(k)
              LEFT JOIN agg b ON b.list_id = l.id AND b.dept = k.k)                AS by_department
    FROM lists l
    JOIN agg a ON a.list_id = l.id
    GROUP BY l.id
  ),
  ol AS (
    SELECT l.*, p.total, p.distributable, p.assigned, p.done, p.open, p.by_department
    FROM lists l
    JOIN per p ON p.id = l.id
    WHERE p.all_total > 0
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'departments',  to_jsonb(v_sel),
    'lists', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id',            r.id,
               'name',          r.name,
               'description',   r.description,
               'category',      r.category,
               'is_static',     r.is_static,
               'display_order', r.display_order,
               'assignable',    r.assignable,
               'total',         r.total,
               'distributable', r.distributable,
               'assigned',      r.assigned,
               'done',          r.done,
               'open',          r.open,
               'by_department', r.by_department)
             ORDER BY r.display_order, r.name)
      FROM ol r), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
               'total',         coalesce(sum(r.total), 0),
               'distributable', coalesce(sum(r.distributable), 0),
               'assigned',      coalesce(sum(r.assigned), 0),
               'done',          coalesce(sum(r.done), 0))
      FROM ol r)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.assigner_lists(text[]) IS
  'GET /api/assigner/lists (20260942001957): every active non-empty prediction list with assignable (NOT is_static, or FULL MONAD LIST / Trash List), total / distributable (open, unassigned) / assigned / done / open for the selected buyer departments (customer_departments; unknown = no row; NULL = all), and by_department for all seven keys (Σ totals = the list). Service role only.';

REVOKE ALL ON FUNCTION public.assigner_lists(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_lists(text[]) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
