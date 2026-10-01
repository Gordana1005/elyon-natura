-- The Orders list's "Оператор" column (owner 01.10.2026): WHO PRODUCED EACH ORDER'S CURRENT STATUS,
-- whatever the status is — not only on sales. 0740693 (this morning) turned the column from the
-- assignee into the seller, so every cancel / trash went blank ("до вчера пишуваше зад секој cancel кој
-- оператор стои"). This brings the name back for every status, from the best evidence we hold:
--
--   sale statuses (confirmed · shipped · delivered · paid · returned; packed is a substate of confirmed)
--       → the SELLER, exactly as the column shows it today: order_departments.seller_name (the write-once
--         sold_* stamp → sales_people.display_name, else the external name, never a bare AlterCPA id),
--         else the confirmer (the frontend's old fallback, moved here).            basis 'sale'
--   every other status (cancelled · trashed · call_again · pending · take · duplicated)
--     (a) the latest PERSON in order_history who moved the order INTO its current status (a real
--         transition first, an edit at the same status only after that); System actors never count;
--         the " — Products synced (…)" suffix is cut off.                           basis 'history'
--     (b) else the agent the order is assigned to (orders from before 01.08.2026, when order_history
--         did not exist yet — what the column showed until 0740693).                basis 'assigned'
--     (c) else the AlterCPA operator: who decided the lead in their panel (decided_by_altercpa_user),
--         or, for an AlterCPA callback (their status 3 → our call_again), the operator holding it
--         (payload.user).                                                           basis 'altercpa'
--     (d) else nothing ("—").
--   A person is shown by ONE spelling: a CRM login → sales_people.user_id; a written name → the
--   sales_person_identities 'order_name' / 'collabbox_author' value (the decider plan's own lookup,
--   20260939000300); an AlterCPA id → 'altercpa_user'. Different people are never merged.
--   operator_auto = the current status was set by an automatic rule (the no-parcel rule, a repair) —
--   the last transition into it was a System actor other than the AlterCPA mirror. The name is then
--   the person behind the lead, not the one who cancelled it; the list says so.
--
-- DISPLAY ONLY. A new read function: no writer, no status rule, no cohort, confirmed_by_* / sold_*
-- untouched. order_departments is NOT changed (the Assigner calls it in batches of 1.000 and needs only
-- the department). One page (≤ 200 ids) costs ~10–25 ms: order_history(order_id, to_status),
-- altercpa_leads(order_id) and sales_people(user_id) are all indexed (verified 01.10).
-- SECURITY DEFINER (sales_people is owners-only under RLS); EXECUTE for service_role (the api) and the
-- read-only verification role only.

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'order_operators') THEN
    RAISE EXCEPTION 'public.order_operators already exists — another session created it; re-read it before replacing';
  END IF;
END
$guard$;

CREATE FUNCTION public.order_operators(p_ids uuid[])
RETURNS TABLE (id uuid, operator_name text, operator_basis text, operator_auto boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT o.id,
         CASE WHEN x.sale THEN x.seller
              ELSE coalesce(x.hist_name, x.asg_name, x.acpa_name) END                          AS operator_name,
         CASE WHEN x.sale THEN CASE WHEN x.seller IS NOT NULL THEN 'sale' END
              WHEN x.hist_name IS NOT NULL THEN 'history'
              WHEN x.asg_name  IS NOT NULL THEN 'assigned'
              WHEN x.acpa_name IS NOT NULL THEN 'altercpa' END                                   AS operator_basis,
         (NOT x.sale AND coalesce(x.auto_last, false))                                           AS operator_auto
    FROM public.orders o
    CROSS JOIN LATERAL (
      SELECT
        (o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) AS sale,
        -- (sale) the seller, exactly as the column showed it: order_departments.seller_name, else the confirmer
        coalesce(sp.display_name,
                 CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END,
                 nullif(btrim(o.confirmed_by_name), ''))                                           AS seller,
        -- (a) the latest PERSON who moved the order into its current status in the CRM
        coalesce(hp.display_name, hi.display_name, nullif(btrim(split_part(hh.changed_by_name, ' — ', 1)), '')) AS hist_name,
        -- (b) the agent the order is assigned to (orders from before order_history, 01.08.2026)
        coalesce(ap.display_name, ai.display_name, nullif(btrim(o.assigned_agent_name), ''))        AS asg_name,
        -- (c) the AlterCPA operator: who decided the lead in their panel, or who set the callback
        CASE WHEN lc.uid IS NOT NULL THEN coalesce(lp.display_name, 'AlterCPA #' || lc.uid) END        AS acpa_name,
        -- the current status came from an automatic rule (no-parcel, a repair), not from a person
        (ha.changed_by IS NULL OR coalesce(ha.changed_by_name, '') LIKE 'System%')
          AND coalesce(ha.changed_by_name, '') NOT LIKE 'System (altercpa:%'
          AND ha.order_id IS NOT NULL                                                                AS auto_last
      FROM (SELECT 1) one
      LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
      LEFT JOIN LATERAL (
        SELECT h.changed_by, h.changed_by_name
          FROM public.order_history h
         WHERE h.order_id = o.id AND h.to_status = o.status
           AND o.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
           AND h.changed_by IS NOT NULL
           AND coalesce(h.changed_by_name, '') NOT LIKE 'System%'
         ORDER BY (h.from_status IS DISTINCT FROM h.to_status) DESC, h.changed_at DESC, h.id DESC
         LIMIT 1) hh ON true
      LEFT JOIN public.sales_people hp ON hp.user_id = hh.changed_by
      LEFT JOIN LATERAL (
        SELECT p.display_name FROM public.sales_person_identities i JOIN public.sales_people p ON p.id = i.person_id
         WHERE hp.id IS NULL AND i.account_id IS NULL AND i.kind IN ('order_name', 'collabbox_author')
           AND i.value = btrim(split_part(hh.changed_by_name, ' — ', 1))
         ORDER BY array_position(ARRAY['order_name', 'collabbox_author'], i.kind) LIMIT 1) hi ON true
      LEFT JOIN LATERAL (
        SELECT h.order_id, h.changed_by, h.changed_by_name
          FROM public.order_history h
         WHERE h.order_id = o.id AND h.to_status = o.status AND h.from_status IS DISTINCT FROM h.to_status
           AND o.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 1) ha ON true
      LEFT JOIN public.sales_people ap ON ap.user_id = o.assigned_agent_id
      LEFT JOIN LATERAL (
        SELECT p.display_name FROM public.sales_person_identities i JOIN public.sales_people p ON p.id = i.person_id
         WHERE ap.id IS NULL AND i.account_id IS NULL AND i.kind IN ('order_name', 'collabbox_author')
           AND i.value = btrim(o.assigned_agent_name)
         ORDER BY array_position(ARRAY['order_name', 'collabbox_author'], i.kind) LIMIT 1) ai ON true
      LEFT JOIN LATERAL (
        SELECT l.account_id,
               coalesce(l.decided_by_altercpa_user,
                        CASE WHEN o.status::text = 'call_again' AND l.status = 3
                             THEN nullif(public.altercpa_payload_int(l.payload, 'user'), 0) END) AS uid
          FROM public.altercpa_leads l
         WHERE l.order_id = o.id
           AND o.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         ORDER BY l.last_seen_at DESC NULLS LAST, l.id
         LIMIT 1) lc ON true
      LEFT JOIN LATERAL (
        SELECT p.display_name FROM public.sales_person_identities i JOIN public.sales_people p ON p.id = i.person_id
         WHERE i.kind = 'altercpa_user' AND i.value = lc.uid::text
           AND (i.account_id = lc.account_id OR i.account_id IS NULL)
         ORDER BY (i.account_id IS NULL) LIMIT 1) lp ON true
    ) x
   WHERE o.id = ANY (p_ids)
$fn$;

COMMENT ON FUNCTION public.order_operators(uuid[]) IS
  'GET /orders + the customer window (search): who produced each order''s CURRENT status. Sale → the seller (sold_* stamp, else the confirmer); otherwise (a) the latest person in order_history into the current status, (b) the assignee (pre-01.08 orders), (c) the AlterCPA operator (decider, or the callback holder), (d) NULL. basis = sale | history | assigned | altercpa; auto = the status came from an automatic rule. Display only. 20260943002000.';

REVOKE ALL ON FUNCTION public.order_operators(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_operators(uuid[]) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.order_operators(uuid[]) TO supabase_read_only_user';
  END IF;
END
$g$;

NOTIFY pgrst, 'reload schema';
