-- Customer 360 names each order's DEPARTMENT (owner 28–29.09.2026: the six departments; "no need to
-- mention Elyon-CRM or AlterCPA anymore"). customer_timeline's order events gain 'department' =
-- cohort_order_source(sale_source, detail, mex_tracking_id) — THE mapping; the badge shows it.
-- The body is the LIVE one (29.09.2026 ~09:20) with one counted, exact edit; drift-guarded.

BEGIN;

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.customer_timeline(text,boolean)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('c0948158513d799e4ee4bed7aa11d036', '29e19c44e519dba1bc38431c6ca7deba')) THEN
    RAISE EXCEPTION 'customer_timeline changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.customer_timeline(p_phone text, p_include_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH prm AS MATERIALIZED (
  SELECT CASE WHEN length(x.d) >= 8 THEN right(x.d, 8) END AS p8,
         coalesce(p_include_money, false)                   AS money,
         300                                                AS cap
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS d) x
),
-- ── CRM orders ──────────────────────────────────────────────────────────────
ord AS MATERIALIZED (
  SELECT o.id, o.display_id, o.created_at, o.status::text AS status,
         o.sale_source, o.sale_source_detail, o.source_type,
         o.product_name, o.quantity, o.price,
         o.customer_name, o.customer_city, o.customer_phone,
         o.sold_at, o.sold_via, sp.display_name AS sold_by,
         o.confirmed_by_name, o.confirmed_at, o.assigned_agent_name,
         o.cancellation_reason, o.cancellation_reason_notes,
         o.trash_reason, o.trash_reason_notes,
         o.return_reason, o.return_reason_notes,
         o.prediction_list_name, o.duplicated_from_display,
         o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd,
         o.mex_delivered_at, o.mex_returned_at,
         o.paid_at, o.paid_basis, o.shipped_at, o.returned_at,
         -- The 0 ден cancel/trash call-outcome rows /calls writes: a call
         -- result, not a purchase (classify_sale_source, 20260935000000).
         (coalesce(o.sale_source_detail = 'disposition', false)
          OR coalesce(public.is_synthetic_product_name(o.product_name), false)) AS disposition
  FROM public.orders o
  LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
  WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = (SELECT p8 FROM prm)
),
items AS (
  SELECT oi.order_id,
         jsonb_agg(jsonb_build_object('name', oi.product_name, 'qty', oi.quantity)
                   ORDER BY oi.created_at, oi.id) AS j
  FROM public.order_items oi
  WHERE oi.order_id IN (SELECT id FROM ord)
  GROUP BY oi.order_id
),
-- ── Web shop (naturatherapy.mk) ─────────────────────────────────────────────
web AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.is_legacy, w.status, w.payment_method,
         w.payment_status,
         public.web_order_outcome(w.status, w.payment_status, w.payment_method) AS outcome,
         w.total, w.shipping_total, w.currency, w.city, w.source, w.channel,
         w.created_at, w.shipped_at, w.mex_tracking_id, w.tracking_status
  FROM public.web_orders w
  WHERE w.phone8 = (SELECT p8 FROM prm)
    AND w.deleted_in_shop_at IS NULL
),
web_items AS (
  SELECT i.shop_order_id,
         jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant_label,
                                      'qty', i.quantity, 'gift', i.kind = 'GIFT')
                   ORDER BY i.shop_item_id) AS j
  FROM public.web_order_items i
  WHERE i.shop_order_id IN (SELECT shop_order_id FROM web)
  GROUP BY i.shop_order_id
),
-- ── MEX parcels: on the phone, or carried by one of the above ───────────────
par_keys AS (
  SELECT m.tracking_id FROM public.mex_parcels m WHERE m.phone8 = (SELECT p8 FROM prm)
  UNION
  SELECT m.tracking_id FROM public.mex_parcels m WHERE m.order_id IN (SELECT id FROM ord)
  UNION
  SELECT o.mex_tracking_id FROM ord o WHERE o.mex_tracking_id IS NOT NULL
  UNION
  SELECT w.mex_tracking_id FROM web w WHERE w.mex_tracking_id IS NOT NULL
),
par AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd,
         p.receiver_name, p.receiver_city, p.order_id, p.link_method,
         coalesce(p.created_at_mex, p.first_seen_at) AS at,
         p.delivered_at, p.returned_at,
         -- coalesce: `NULL IN (…)` is NULL, and NOT NULL would drop the row
         (coalesce(p.order_id IN (SELECT id FROM ord), false)
          OR p.tracking_id IN (SELECT o.mex_tracking_id FROM ord o WHERE o.mex_tracking_id IS NOT NULL)) AS under_order,
         p.tracking_id IN (SELECT w.mex_tracking_id FROM web w WHERE w.mex_tracking_id IS NOT NULL)   AS under_web,
         lo.display_id AS linked_display_id,
         jsonb_build_object(
           'tracking_id',    p.tracking_id,
           'account',        p.account,
           'series',         p.series,
           -- The DocNumber series names the sales channel (20260935000000).
           'channel',        CASE WHEN p.sender_reference ~* '^NTMK' OR p.tracking_id ~* '^NTMK' THEN 'web'
                                  WHEN p.series IN ('9100', '9102') THEN 'teleshop'
                                  WHEN p.series = '9108' THEN 'social'
                                  WHEN p.series = '9103' THEN 'leads_out'
                                  WHEN p.series = '9110' THEN 'leads'
                                  WHEN p.tracking_id ~ '^ORD-' THEN 'crm'
                                  ELSE 'other' END,
           'status_id',      p.status_id,
           'status_name',    p.status_name,
           'created_at',     coalesce(p.created_at_mex, p.first_seen_at),
           'delivered_at',   p.delivered_at,
           'returned_at',    p.returned_at,
           'receiver_name',  p.receiver_name,
           'receiver_city',  p.receiver_city,
           'link_method',    p.link_method,
           'phone_match',    coalesce(p.phone8 = (SELECT p8 FROM prm), false)
         ) || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('cod_mkd', p.cod_mkd)
                   ELSE '{}'::jsonb END AS pj
  FROM public.mex_parcels p
  JOIN par_keys k ON k.tracking_id = p.tracking_id
  LEFT JOIN public.orders lo ON lo.id = p.order_id
),
-- ── AlterCPA ledger ─────────────────────────────────────────────────────────
acl AS MATERIALIZED (
  SELECT a.altercpa_id, a.order_id, a.geo, a.offer_name, a.webmaster, a.phase, a.status,
         a.reason, a.decision, a.decided_at, a.customer_name, a.city, a.quantity,
         a.skip_reason, a.price_eur,
         coalesce(a.created_remote, a.first_seen_at) AS at,
         coalesce(a.order_id IN (SELECT id FROM ord), false) AS under_order,
         lo.display_id AS linked_display_id,
         dsp.display_name AS decided_by
  FROM public.altercpa_leads a
  LEFT JOIN public.sales_person_identities si
         ON si.kind = 'altercpa_user' AND si.account_id = a.account_id
        AND si.value = a.decided_by_altercpa_user::text
  LEFT JOIN public.sales_people dsp ON dsp.id = si.person_id
  LEFT JOIN public.orders lo ON lo.id = a.order_id
  WHERE a.order_id IN (SELECT id FROM ord)
     OR (right(regexp_replace(coalesce(a.phone_e164, a.phone_raw, ''), '[^0-9]', '', 'g'), 8) = (SELECT p8 FROM prm)
         AND (a.geo = 'MK' OR a.order_id IS NOT NULL))
),
acl_j AS (
  SELECT a.*,
         jsonb_build_object(
           'altercpa_id',   a.altercpa_id,
           'geo',           a.geo,
           'offer',         a.offer_name,
           'webmaster',     a.webmaster,
           'phase',         a.phase,
           'lead_status',   a.status,
           'reason',        a.reason,
           'decision',      a.decision,
           'decided_by',    a.decided_by,
           'decided_at',    a.decided_at,
           'created_at',    a.at,
           'customer_name', a.customer_name,
           'city',          a.city,
           'quantity',      a.quantity,
           'skip_reason',   a.skip_reason
         ) || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('price_eur', a.price_eur)
                   ELSE '{}'::jsonb END AS lj
  FROM acl a
),
-- ── Calls, notes, lists ─────────────────────────────────────────────────────
cl AS (
  SELECT c.id, c.context_type, c.context_id, c.outcome, c.notes, c.connection_state,
         c.total_seconds, c.talk_seconds,
         coalesce(c.started_at, c.created_at) AS at,
         pr.full_name AS agent_name
  FROM public.call_logs c
  LEFT JOIN public.profiles pr ON pr.user_id = c.agent_id
  WHERE c.customer_phone IS NOT NULL
    AND right(regexp_replace(COALESCE(c.customer_phone, ''), '\D', '', 'g'), 8) = (SELECT p8 FROM prm)
),
-- ~99% of order_notes are written by importers and repair runs ("System …").
-- Those stay with their order (the newest 3, in the order event); only what a
-- person wrote becomes a timeline event of its own.
nt AS (
  SELECT n.id, n.order_id, n.text, n.author_name, n.created_at,
         coalesce(n.author_name ILIKE 'System%', false) AS is_system
  FROM public.order_notes n
  WHERE n.order_id IN (SELECT id FROM ord)
),
nt_ord AS (
  SELECT n.order_id,
         count(*) FILTER (WHERE NOT n.is_system) AS human_n,
         count(*) FILTER (WHERE n.is_system)     AS system_n,
         jsonb_path_query_array(
           coalesce(jsonb_agg(jsonb_build_object('at', n.created_at, 'who', n.author_name,
                                                 'text', left(n.text, 400))
                              ORDER BY n.created_at DESC) FILTER (WHERE n.is_system), '[]'::jsonb),
           '$[0 to 2]') AS system_notes
  FROM nt n
  GROUP BY n.order_id
),
-- Members are keyed by the exact phone string the engine copied from orders;
-- the canonical +389 form catches a member whose orders were re-keyed.
phones AS (
  SELECT o.customer_phone AS phone FROM ord o WHERE o.customer_phone IS NOT NULL
  UNION
  SELECT '+389' || (SELECT p8 FROM prm)
),
mem AS (
  SELECT l.name, l.category, m.created_at, m.assigned_agent_name, m.is_completed,
         m.last_call_at, m.last_call_outcome, m.in_call_again_until, m.product_name,
         m.trigger_event_at
  FROM public.prediction_segment_members m
  JOIN public.prediction_segment_lists l ON l.id = m.list_id
  WHERE m.customer_phone IN (SELECT phone FROM phones)
),
prof AS (
  SELECT cp.customer_name, cp.city
  FROM public.customer_profiles cp
  WHERE cp.phone IN (SELECT phone FROM phones)
),
-- ── Events ──────────────────────────────────────────────────────────────────
ev AS (
  -- CRM orders, with their parcel(s) and AlterCPA ledger row nested
  SELECT o.created_at AS at, jsonb_build_object(
           'kind',          'order',
           'key',           'o:' || o.id,
           'at',            o.created_at,
           'status',        o.status,
           'source',        o.sale_source,
           'source_detail', o.sale_source_detail,
           'department',    public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id),
           'source_type',   o.source_type,
           'disposition',   o.disposition,
           'title',         o.product_name,
           'items',         coalesce(it.j, '[]'::jsonb),
           'quantity',      o.quantity,
           'amount_eur',    o.price,
           'who',           coalesce(o.sold_by, o.confirmed_by_name, o.assigned_agent_name),
           'sold_by',       o.sold_by,
           'sold_at',       o.sold_at,
           'sold_via',      o.sold_via,
           'confirmed_by',  o.confirmed_by_name,
           'assigned_to',   o.assigned_agent_name,
           'list',          o.prediction_list_name,
           'customer_name', o.customer_name,
           'city',          o.customer_city,
           'cancellation_reason',       o.cancellation_reason,
           'cancellation_reason_notes', o.cancellation_reason_notes,
           'trash_reason',              o.trash_reason,
           'trash_reason_notes',        o.trash_reason_notes,
           'return_reason',             o.return_reason,
           'return_reason_notes',       o.return_reason_notes,
           'duplicated_from', o.duplicated_from_display,
           'paid_at',       o.paid_at,
           'paid_basis',    o.paid_basis,
           'shipped_at',    o.shipped_at,
           'returned_at',   o.returned_at,
           'notes_count',   coalesce(no.human_n, 0),
           'system_notes_count', coalesce(no.system_n, 0),
           'system_notes',  coalesce(no.system_notes, '[]'::jsonb),
           'parcels',       coalesce(
                              (SELECT jsonb_agg(p.pj ORDER BY p.at) FROM par p
                                WHERE p.order_id = o.id OR p.tracking_id = o.mex_tracking_id),
                              -- the order knows its tracking id but the register
                              -- has no row for it yet: show the order's own copy
                              CASE WHEN o.mex_tracking_id IS NOT NULL THEN jsonb_build_array(
                                jsonb_build_object(
                                  'tracking_id',  o.mex_tracking_id,
                                  'account',      o.mex_account,
                                  'status_id',    o.mex_status_id,
                                  'delivered_at', o.mex_delivered_at,
                                  'returned_at',  o.mex_returned_at,
                                  'from_order',   true)
                                || CASE WHEN (SELECT money FROM prm) THEN jsonb_build_object('cod_mkd', o.mex_cod_mkd)
                                        ELSE '{}'::jsonb END)
                              END,
                              '[]'::jsonb),
           'lead',          (SELECT a.lj FROM acl_j a WHERE a.order_id = o.id
                              ORDER BY a.at DESC NULLS LAST LIMIT 1),
           'refs',          jsonb_build_object(
                              'order_id',    o.id,
                              'display_id',  o.display_id,
                              'tracking_id', o.mex_tracking_id,
                              'altercpa_id', (SELECT a.altercpa_id FROM acl a WHERE a.order_id = o.id
                                               ORDER BY a.at DESC NULLS LAST LIMIT 1))
         ) AS j
  FROM ord o
  LEFT JOIN items it ON it.order_id = o.id
  LEFT JOIN nt_ord no ON no.order_id = o.id

  UNION ALL
  -- Web-shop orders, with their MEX parcel nested
  SELECT w.created_at, jsonb_build_object(
           'kind',           'web_order',
           'key',            'w:' || w.shop_order_id,
           'at',             w.created_at,
           'status',         w.outcome,
           'shop_status',    w.status,
           'payment_method', w.payment_method,
           'payment_status', w.payment_status,
           'source',         'web',
           'legacy',         w.is_legacy,
           'title',          w.order_number,
           'items',          coalesce(wi.j, '[]'::jsonb),
           'city',           w.city,
           'channel',        w.channel,
           'shop_source',    w.source,
           'tracking_status', w.tracking_status,
           'shipped_at',     w.shipped_at,
           'parcels',        coalesce((SELECT jsonb_agg(p.pj ORDER BY p.at) FROM par p
                                        WHERE p.tracking_id = w.mex_tracking_id), '[]'::jsonb),
           'refs',           jsonb_build_object('web_number', w.order_number, 'tracking_id', w.mex_tracking_id)
         ) || CASE WHEN (SELECT money FROM prm)
                   THEN jsonb_build_object('amount_mkd', w.total, 'shipping_mkd', w.shipping_total, 'currency', w.currency)
                   ELSE '{}'::jsonb END
  FROM web w
  LEFT JOIN web_items wi ON wi.shop_order_id = w.shop_order_id

  UNION ALL
  -- AlterCPA leads that are not one of this customer's orders
  SELECT a.at, jsonb_build_object(
           'kind',        'altercpa_lead',
           'key',         'a:' || a.altercpa_id,
           'at',          a.at,
           'status',      coalesce(a.decision, 'open'),
           'source',      'altercpa',
           'title',       a.offer_name,
           'who',         a.decided_by,
           'lead',        a.lj,
           'refs',        jsonb_build_object('altercpa_id', a.altercpa_id, 'order_id', a.order_id,
                                             'display_id', a.linked_display_id)
         )
  FROM acl_j a
  WHERE NOT a.under_order

  UNION ALL
  -- MEX parcels that belong to none of the above (MEX-only sales, or a parcel
  -- linked to another phone's order)
  SELECT p.at, jsonb_build_object(
           'kind',             'parcel',
           'key',              'p:' || p.tracking_id,
           'at',               p.at,
           'status',           p.status_name,
           'source',           p.pj ->> 'channel',
           'title',            p.tracking_id,
           'parcel',           p.pj,
           'linked_elsewhere', p.order_id IS NOT NULL,
           'refs',             jsonb_build_object('tracking_id', p.tracking_id, 'order_id', p.order_id,
                                                  'display_id', p.linked_display_id)
         )
  FROM par p
  WHERE NOT p.under_order AND NOT p.under_web

  UNION ALL
  SELECT c.at, jsonb_build_object(
           'kind',             'call',
           'key',              'c:' || c.id,
           'at',               c.at,
           'status',           c.outcome,
           'who',              c.agent_name,
           'context_type',     c.context_type,
           'connection_state', c.connection_state,
           'seconds',          c.total_seconds,
           'talk_seconds',     c.talk_seconds,
           'text',             c.notes,
           'refs',             jsonb_build_object(
                                 'order_id',   CASE WHEN c.context_type = 'order' THEN c.context_id END,
                                 'display_id', (SELECT o.display_id FROM ord o WHERE o.id = c.context_id))
         )
  FROM cl c

  UNION ALL
  SELECT n.created_at, jsonb_build_object(
           'kind', 'note',
           'key',  'n:' || n.id,
           'at',   n.created_at,
           'who',  n.author_name,
           'text', n.text,
           'refs', jsonb_build_object('order_id', n.order_id,
                                      'display_id', (SELECT o.display_id FROM ord o WHERE o.id = n.order_id))
         )
  FROM nt n
  WHERE NOT n.is_system

  UNION ALL
  SELECT m.created_at, jsonb_build_object(
           'kind',              'list',
           'key',               'l:' || m.name,
           'at',                m.created_at,
           'title',             m.name,
           'category',          m.category,
           'status',            CASE WHEN m.is_completed THEN 'completed'
                                     WHEN m.in_call_again_until > now() THEN 'call_again'
                                     WHEN m.assigned_agent_name IS NOT NULL THEN 'assigned'
                                     ELSE 'waiting' END,
           'who',               m.assigned_agent_name,
           'product',           m.product_name,
           'trigger_at',        m.trigger_event_at,
           'last_call_at',      m.last_call_at,
           'last_call_outcome', m.last_call_outcome,
           'refs',              '{}'::jsonb
         )
  FROM mem m
),
-- Two caps, so a chatty customer's calls and notes can never push her
-- purchases off the page: the newest `cap` purchase-type events
-- (order / web_order / altercpa_lead / parcel / list) plus the newest
-- `cap / 2` calls and notes.
evr AS (
  SELECT e.at, e.j,
         (e.j ->> 'kind') IN ('call', 'note') AS aux,
         row_number() OVER (PARTITION BY (e.j ->> 'kind') IN ('call', 'note')
                            ORDER BY e.at DESC NULLS LAST, e.j ->> 'key') AS rn
  FROM ev e
),
evl AS (
  SELECT r.at, jsonb_strip_nulls(r.j) AS j
  FROM evr r
  WHERE r.rn <= CASE WHEN r.aux THEN (SELECT cap FROM prm) / 2 ELSE (SELECT cap FROM prm) END
),
-- ── Header ──────────────────────────────────────────────────────────────────
-- Spellings that differ only by case or spacing are one name ("Suta  Topkoska"
-- = "SUTA TOPKOSKA"); the most frequent spelling represents the group.
-- Cyrillic and Latin forms stay separate on purpose — both are real.
nm AS (
  SELECT regexp_replace(btrim(n), '\s+', ' ', 'g') AS n FROM (
    SELECT customer_name AS n FROM ord
    UNION ALL SELECT customer_name FROM acl
    UNION ALL SELECT customer_name FROM prof
    UNION ALL SELECT receiver_name FROM par
  ) s WHERE coalesce(btrim(n), '') <> ''
),
nm_top AS (
  SELECT g.n, g.k FROM (
    SELECT count(*) AS k, mode() WITHIN GROUP (ORDER BY n) AS n
    FROM nm GROUP BY lower(n)
  ) g
  ORDER BY g.k DESC, g.n
  LIMIT 6
),
ct AS (
  SELECT c FROM (
    SELECT btrim(customer_city) AS c FROM ord
    UNION ALL SELECT btrim(city) FROM web
    UNION ALL SELECT btrim(city) FROM acl
    UNION ALL SELECT btrim(city) FROM prof
    UNION ALL SELECT btrim(receiver_city) FROM par
  ) s WHERE coalesce(c, '') <> ''
),
seen AS (
  SELECT min(at) AS first_seen, max(at) AS last_seen FROM ev WHERE (j ->> 'kind') <> 'list'
)
SELECT CASE
  WHEN (SELECT p8 FROM prm) IS NULL THEN jsonb_build_object('ok', false, 'error', 'phone_too_short')
  ELSE jsonb_build_object(
    'ok',           true,
    'phone8',       (SELECT p8 FROM prm),
    'money',        (SELECT money FROM prm),
    'generated_at', now(),
    'customer', jsonb_build_object(
      'names',      coalesce((SELECT jsonb_agg(q.n ORDER BY q.k DESC, q.n) FROM nm_top q), '[]'::jsonb),
      'cities',     coalesce((SELECT jsonb_agg(q.c ORDER BY q.k DESC, q.c) FROM
                               (SELECT c, count(*) AS k FROM ct GROUP BY c ORDER BY count(*) DESC, c LIMIT 6) q), '[]'::jsonb),
      'first_seen', (SELECT first_seen FROM seen),
      'last_seen',  (SELECT last_seen FROM seen)
    ),
    'summary', jsonb_build_object(
      'orders',          (SELECT count(*) FROM ord),
      'sales',           (SELECT count(*) FROM ord WHERE NOT disposition),
      'dispositions',    (SELECT count(*) FROM ord WHERE disposition),
      'delivered',       (SELECT count(*) FROM ord WHERE status IN ('paid', 'delivered')),
      'returned',        (SELECT count(*) FROM ord WHERE status = 'returned'),
      'cancelled',       (SELECT count(*) FROM ord WHERE status = 'cancelled'),
      'trashed',         (SELECT count(*) FROM ord WHERE status = 'trashed'),
      'open',            (SELECT count(*) FROM ord WHERE status IN ('pending', 'take', 'call_again', 'duplicated')),
      'in_progress',     (SELECT count(*) FROM ord WHERE status IN ('confirmed', 'shipped')),
      -- card_unpaid = a failed card checkout; the shop counts it nowhere
      'web_orders',      (SELECT count(*) FROM web WHERE outcome <> 'card_unpaid'),
      'web_delivered',   (SELECT count(*) FROM web WHERE outcome = 'delivered'),
      'altercpa_leads',  (SELECT count(*) FROM acl),
      'parcels',         (SELECT count(*) FROM par),
      'parcels_delivered', (SELECT count(*) FROM par WHERE status_id = 2),
      'parcels_returned',  (SELECT count(*) FROM par WHERE status_id = 7),
      'parcels_mex_only',  (SELECT count(*) FROM par WHERE NOT under_order AND NOT under_web AND order_id IS NULL),
      'calls',           (SELECT count(*) FROM cl),
      'notes',           (SELECT count(*) FROM nt WHERE NOT is_system),
      'system_notes',    (SELECT count(*) FROM nt WHERE is_system),
      'lists',           coalesce((SELECT jsonb_agg(DISTINCT name) FROM mem), '[]'::jsonb)
    ) || CASE WHEN (SELECT money FROM prm)
              THEN jsonb_build_object(
                     -- MEX-proven cash: delivered parcels, each counted once
                     'lifetime_delivered_mkd',
                       coalesce((SELECT sum(cod_mkd) FROM par WHERE status_id = 2), 0),
                     -- what the CRM says was paid (price, EUR) — includes the
                     -- imported history that predates the MEX register
                     'paid_orders_eur',
                       coalesce((SELECT sum(price) FROM ord
                                  WHERE status IN ('paid', 'delivered') AND NOT disposition), 0))
              ELSE '{}'::jsonb END,
    'events',       coalesce((SELECT jsonb_agg(e.j ORDER BY e.at DESC NULLS LAST, e.j ->> 'key') FROM evl e), '[]'::jsonb),
    'total_events', (SELECT count(*) FROM ev),
    'kind_counts',  coalesce((SELECT jsonb_object_agg(k.kind, k.n) FROM
                               (SELECT e.j ->> 'kind' AS kind, count(*) AS n FROM ev e GROUP BY 1) k), '{}'::jsonb),
    'truncated',    (SELECT count(*) FROM ev) > (SELECT count(*) FROM evl)
  )
END
$function$;

COMMIT;
