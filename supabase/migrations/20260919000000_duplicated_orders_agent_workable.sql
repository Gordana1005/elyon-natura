-- Reversal of the 2026-08-02 rule (20260802000100): agents now SEE and WORK
-- duplicated orders like open leads (operator decision 2026-08-13, ported from
-- BG cf4c966 / 20260920000000).
-- Admins/managers still create the duplicates; agents follow up and settle them.
-- Restores the pre-20260802 agent policy semantics: assignment is the only gate.
-- Unassigned duplicates stay RLS-invisible to agents, same as unassigned leads —
-- agent surfaces reach them through the edge function's adminClient guards.
--
-- The SOURCE order is never touched by any of this: a duplicate lives its own
-- life under its own order id, and `duplicated_from` stays a permanent link.

DROP POLICY IF EXISTS "Agents can view assigned orders" ON public.orders;
CREATE POLICY "Agents can view assigned orders" ON public.orders
  FOR SELECT TO authenticated
  USING (assigned_agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can update assigned orders" ON public.orders;
CREATE POLICY "Agents can update assigned orders" ON public.orders
  FOR UPDATE TO authenticated
  USING (assigned_agent_id = auth.uid());

-- check_phone_duplicates: identical to 20260802000100 except the non-admin
-- order branch no longer excludes duplicates (drop "AND o.duplicated_from IS NULL").
-- The prediction_leads branch is unchanged.
CREATE OR REPLACE FUNCTION public.check_phone_duplicates(_phone text, _exclude_order_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(source text, source_id text, source_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  normalized TEXT;
  caller_is_admin BOOLEAN;
BEGIN
  normalized := regexp_replace(_phone, '[^0-9+]', '', 'g');
  IF length(normalized) < 8 THEN
    RETURN;
  END IF;

  caller_is_admin := public.has_role(auth.uid(), 'admin'::app_role);

  RETURN QUERY
    SELECT 'order'::TEXT, o.display_id, o.customer_name
    FROM public.orders o
    WHERE regexp_replace(o.customer_phone, '[^0-9+]', '', 'g') = normalized
    AND (_exclude_order_id IS NULL OR o.id != _exclude_order_id)
    AND (caller_is_admin OR o.assigned_agent_id = auth.uid())
    UNION ALL
    SELECT 'prediction_lead'::TEXT, pl.name, pl2.name
    FROM public.prediction_leads pl
    JOIN public.prediction_lists pl2 ON pl2.id = pl.list_id
    WHERE regexp_replace(pl.telephone, '[^0-9+]', '', 'g') = normalized
    AND (caller_is_admin OR pl.assigned_agent_id = auth.uid());
END;
$function$;

NOTIFY pgrst, 'reload schema';
