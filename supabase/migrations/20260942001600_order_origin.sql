-- The order window says where an order came from and what proves it (owner, 29.09.2026: "every
-- order source clear — where from, how, who made it, how much money; MEX is the final proof:
-- delivered, when, where, to whom, from whom, at what price").
--
-- order_origin(id) → jsonb, read-only, display only:
--   department   THE mapping, cohort_order_source(sale_source, detail, mex_tracking_id)
--   seller       the write-once sold_* stamp (person display name, else the external author name,
--                never a bare AlterCPA operator id) + sold_at / sold_via
--   parcel       the MEX register row of the order's tracking id: profile (BIO NATURAL / NATURA),
--                series, status, COD, receiver name + city, created / delivered / returned, last move
--   collabbox    the collabBox document with that DocNumber: folder (type), author, time, amount
--   altercpa     the AlterCPA lead: its decision, when, and the operator (person or #id)
-- confirmed_by_* and the payout tables are not touched (payout math is deferred by the owner).
-- SECURITY DEFINER (people / register / ledgers are owners-only under RLS); EXECUTE for
-- service_role (the api decides who may open the order) and the read-only verification role.

BEGIN;

CREATE OR REPLACE FUNCTION public.order_origin(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'department', public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id),
    'sale_source', o.sale_source,
    'sale_source_detail', o.sale_source_detail,
    'doc_type', o.collabbox_doc_type,
    'intake', o.source_type,
    'seller', coalesce(sp.display_name,
                       CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END),
    'sold_at', o.sold_at,
    'sold_via', o.sold_via,
    'paid_basis', o.paid_basis,
    'price_mkd', CASE WHEN o.price IS NULL THEN NULL ELSE round(o.price * 61.5) END,
    'parcel', (SELECT jsonb_build_object(
                 'tracking', p.tracking_id, 'account', p.account, 'series', p.series,
                 'status_id', p.status_id, 'status_name', p.status_name, 'cod_mkd', p.cod_mkd,
                 'receiver_name', p.receiver_name, 'receiver_city', p.receiver_city,
                 'created_at', p.created_at_mex, 'delivered_at', p.delivered_at,
                 'returned_at', p.returned_at, 'last_update_at', p.last_update_at,
                 'linked_here', p.order_id = o.id)
                 FROM public.mex_parcels p WHERE p.tracking_id = o.mex_tracking_id),
    'collabbox', (SELECT jsonb_build_object(
                    'doc', d.doc_number, 'type', d.doc_type_id, 'type_name', d.doc_type_name,
                    'author', d.author, 'doc_at', d.doc_at, 'amount_mkd', d.amount_mkd)
                    FROM public.collabbox_documents d
                   WHERE d.doc_number = o.mex_tracking_id AND d.vanished_at IS NULL),
    'altercpa', (SELECT jsonb_build_object(
                   'lead', l.altercpa_id, 'decision', l.decision, 'decided_at', l.decided_at,
                   'operator', coalesce(
                     (SELECT sp2.display_name FROM public.sales_person_identities i
                        JOIN public.sales_people sp2 ON sp2.id = i.person_id
                       WHERE i.kind = 'altercpa_user' AND i.value = l.decided_by_altercpa_user::text
                       LIMIT 1),
                     CASE WHEN l.decided_by_altercpa_user IS NOT NULL THEN '#' || l.decided_by_altercpa_user END))
                   FROM public.altercpa_leads l WHERE l.order_id = o.id
                   ORDER BY l.last_seen_at DESC NULLS LAST LIMIT 1))
    FROM public.orders o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
   WHERE o.id = p_id
$fn$;

COMMENT ON FUNCTION public.order_origin(uuid) IS
  'GET /orders/:id "origin" (20260942001600): department (cohort_order_source), seller (sold_*), the MEX parcel (profile, status, COD, receiver, dates), the collabBox document and the AlterCPA decision behind one order. Display only.';

REVOKE ALL ON FUNCTION public.order_origin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_origin(uuid) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.order_origin(uuid) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
