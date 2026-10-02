-- 20260947001801 — the read-only verification role may run the sale-day plan (like
-- link_lead_parcels_plan / leads_parcel_orders_plan / collab_entry_rule_plan): the dry run and
-- scripts/verify-sale-day-revive.mjs read it through the Management API's read-only query.
GRANT EXECUTE ON FUNCTION public.order_status_at(uuid, timestamptz) TO supabase_read_only_user;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) TO supabase_read_only_user;
GRANT SELECT ON public.sale_day_revive_runs, public.sale_day_revive_moves TO supabase_read_only_user;
