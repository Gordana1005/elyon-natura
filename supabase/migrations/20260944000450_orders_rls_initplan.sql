-- ============================================================================
-- orders / order_items RLS: evaluate the role checks ONCE per query, not per row
-- (01.10.2026 — agents' order search on /calls timed out)
-- ============================================================================
-- Found by the production check of 01.10.2026: as an agent (pregled.agent),
-- GET /api/orders?search=<phone>&limit=50 answered 400 "Operation failed" for every
-- customer. Reproduced as the agent: `select count(*) from orders where customer_phone
-- like '%70123456'` → 57014 statement timeout, CONTEXT: SQL function "has_role".
--
-- Why: the policies call has_role(auth.uid(), …) directly. LIKE is not leakproof, so
-- under RLS Postgres must evaluate the policy quals BEFORE the search predicate — on
-- every one of the ~358k rows, two has_role() look-ups each. The last-8 phone search
-- (ordersList.ts searchOps: customer_phone LIKE '%<last8>') therefore scanned the whole
-- table through has_role() and hit the timeout. Admins and managers read through the
-- service role and never saw it.
--
-- The fix is the standard Supabase pattern: wrap the calls in scalar sub-selects, so
-- the planner turns them into InitPlans evaluated once per query. The LOGIC is
-- unchanged — same policies, same names, same commands, same roles, no WITH CHECK
-- added or removed (none of these policies has one). ALTER POLICY keeps everything
-- except the USING expression.
-- ============================================================================

SET lock_timeout = '5s';

BEGIN;

-- ── orders ──────────────────────────────────────────────────────────────────
ALTER POLICY "Admins can manage orders" ON public.orders
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

ALTER POLICY "Managers can manage orders" ON public.orders
  USING ((SELECT public.has_role((SELECT auth.uid()), 'manager'::public.app_role)));

ALTER POLICY "Agents can view assigned orders" ON public.orders
  USING (assigned_agent_id = (SELECT auth.uid()));

ALTER POLICY "Agents can update assigned orders" ON public.orders
  USING (assigned_agent_id = (SELECT auth.uid()));

-- ── order_items ─────────────────────────────────────────────────────────────
ALTER POLICY "Admins can manage order items" ON public.order_items
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

ALTER POLICY "Managers can manage order items" ON public.order_items
  USING ((SELECT public.has_role((SELECT auth.uid()), 'manager'::public.app_role)));

ALTER POLICY "Warehouse can view order items" ON public.order_items
  USING ((SELECT public.has_role((SELECT auth.uid()), 'warehouse'::public.app_role)));

ALTER POLICY "Agents can manage order items for assigned orders" ON public.order_items
  USING (EXISTS (SELECT 1 FROM public.orders
                 WHERE orders.id = order_items.order_id
                   AND orders.assigned_agent_id = (SELECT auth.uid())));

ALTER POLICY "Agents can view order items for assigned orders" ON public.order_items
  USING (EXISTS (SELECT 1 FROM public.orders
                 WHERE orders.id = order_items.order_id
                   AND orders.assigned_agent_id = (SELECT auth.uid())));

COMMIT;

NOTIFY pgrst, 'reload schema';
