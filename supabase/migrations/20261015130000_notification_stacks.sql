-- ============================================================================
-- STACKED NOTIFICATIONS (owner, 15.10.2026)
--
-- Owner: "по цел ден гледаме само платени и вратени порачки … ако сакам да ги видам
-- нотификациите за affiliate, т.е гаранциите, неможам да ги најдам." The bell read the
-- newest 50 rows; an admin gets ~490 order_paid / order_returned rows a day (every paid
-- order of the company), so the guarantee / collab / shifts bells fell out of those 50
-- within minutes, and the unread count and "mark all read" only ever saw the 50.
--
-- The bell now shows paid / returned / unpaid-chase / AlterCPA milestones / assignments
-- / idle alerts as ONE card per type per Skopje day ("Платени нарачки · 48 · 93.600 ден.",
-- "Види ги сите" opens the rows), and every other type as its own row, fetched apart so a
-- flood of paid orders can never push it out. Which types stack is decided by the client
-- (src/lib/notifications/registry.ts) and passed in; this migration adds:
--
--   1. idx_notifications_user_created (user_id, created_at DESC) — the bell's own order.
--   2. notification_read_marks — ONE watermark per person: every notification created at
--      or before read_before counts as read. "Означи ги сите" moves the watermark instead
--      of UPDATE-ing up to ~20.000 rows of an admin (each one a Realtime change on the
--      published table). Read = is_read OR created_at <= read_before.
--   3. notifications_overview(stack_types, from, to) — unread per type over the WHOLE
--      table (the badge and the category chips) + the stacks of the window (type × Skopje
--      day: total, unread, денари, the newest names; a stack of one carries its row).
--   4. notifications_mark_read(type, from, to) — "mark this stack read" (one type, one
--      Skopje day: ≤ ~500 rows).
--   5. notifications_mark_all_read() — moves the watermark to now().
--   6. tg_notify_order_paid / tg_notify_order_returned: meta.recipient = 'owner' | 'admin'
--      (the arrival toast is shown to the sale's owner only — owner 15.10.2026), and
--      order_returned finally carries meta {i18n 'notif.orderReturned', order, customer,
--      amountMkd} so it is shown in the reader's language. Recipients, messages, links,
--      the bulk_repair silence and the error swallowing are byte-identical to the live
--      definitions (20260940000400 / 20260934000200, read 15.10 with pg_get_functiondef).
--
-- Rollback: drop the three functions and the table, drop the index, re-apply
-- tg_notify_order_paid from 20260940000400 and tg_notify_order_returned from
-- 20260934000200. Rows written meanwhile keep their extra meta keys (harmless).
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

-- ── 2. the per-person read watermark ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_read_marks (
  user_id     uuid PRIMARY KEY,
  read_before timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.notification_read_marks IS
  'One watermark per person: a notification created at or before read_before counts as read (the bell''s "mark all read", 20261015130000). Written only by notifications_mark_all_read().';

ALTER TABLE public.notification_read_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_read_marks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notification_read_marks TO authenticated;
DROP POLICY IF EXISTS "Own read mark" ON public.notification_read_marks;
CREATE POLICY "Own read mark" ON public.notification_read_marks
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- ── 3. the bell's overview ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notifications_overview(
  p_stack_types text[],
  p_from        timestamptz,
  p_to          timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT (SELECT auth.uid()) AS uid
  ), mark AS (
    SELECT COALESCE(
      (SELECT m.read_before FROM public.notification_read_marks m WHERE m.user_id = (SELECT uid FROM me)),
      '-infinity'::timestamptz) AS rb
  ), unread AS (
    SELECT n.type, count(*) AS c
    FROM public.notifications n
    WHERE n.user_id = (SELECT uid FROM me)
      AND NOT n.is_read
      AND n.created_at > (SELECT rb FROM mark)
    GROUP BY n.type
  ), st AS (
    SELECT n.type,
           (n.created_at AT TIME ZONE 'Europe/Skopje')::date AS day,
           count(*) AS total,
           count(*) FILTER (WHERE NOT n.is_read AND n.created_at > (SELECT rb FROM mark)) AS unread,
           sum(CASE WHEN jsonb_typeof(n.meta -> 'amountMkd') = 'number'
                    THEN (n.meta ->> 'amountMkd')::numeric END) AS amount_mkd,
           count(*) FILTER (WHERE jsonb_typeof(n.meta -> 'amountMkd') = 'number') AS amount_rows,
           max(n.created_at) AS latest_at,
           (array_agg(COALESCE(n.meta ->> 'customer', n.meta ->> 'name', n.meta ->> 'affiliate')
                      ORDER BY n.created_at DESC)
              FILTER (WHERE COALESCE(n.meta ->> 'customer', n.meta ->> 'name', n.meta ->> 'affiliate') IS NOT NULL)
           )[1:8] AS names
    FROM public.notifications n
    WHERE n.user_id = (SELECT uid FROM me)
      AND n.type = ANY (p_stack_types)
      AND n.created_at >= p_from
      AND (p_to IS NULL OR n.created_at < p_to)
    GROUP BY 1, 2
  ), one AS (
    -- A stack of one is shown as the row itself.
    SELECT st.type, st.day, to_jsonb(n) AS r
    FROM st
    JOIN public.notifications n
      ON n.user_id = (SELECT uid FROM me) AND n.type = st.type AND n.created_at = st.latest_at
    WHERE st.total = 1
  )
  SELECT jsonb_build_object(
    'readBefore', (SELECT CASE WHEN rb = '-infinity'::timestamptz THEN NULL ELSE rb END FROM mark),
    'unread', COALESCE((SELECT jsonb_object_agg(type, c) FROM unread), '{}'::jsonb),
    'stacks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'type', st.type,
               'day', to_char(st.day, 'YYYY-MM-DD'),
               'total', st.total,
               'unread', st.unread,
               'amountMkd', st.amount_mkd,
               'amountRows', st.amount_rows,
               'latestAt', st.latest_at,
               'names', COALESCE(to_jsonb(st.names), '[]'::jsonb),
               'row', (SELECT one.r FROM one WHERE one.type = st.type AND one.day = st.day LIMIT 1)
             ) ORDER BY st.latest_at DESC)
      FROM st), '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.notifications_overview(text[], timestamptz, timestamptz) IS
  'The bell (20261015130000): unread per type over all of the caller''s notifications (read = is_read OR created_at <= notification_read_marks.read_before) + one stack per stackable type per Skopje day in [p_from, p_to). Caller''s own rows only.';

-- ── 4. mark one stack read ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notifications_mark_read(
  p_type text,
  p_from timestamptz,
  p_to   timestamptz
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := (SELECT auth.uid());
  _n   integer;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  IF p_type IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '2 days' THEN
    RAISE EXCEPTION 'one type and one day only' USING ERRCODE = '22023';
  END IF;
  UPDATE public.notifications
     SET is_read = true
   WHERE user_id = _uid
     AND type = p_type
     AND created_at >= p_from
     AND created_at < p_to
     AND NOT is_read;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

-- ── 5. mark everything read (the watermark) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.notifications_mark_all_read()
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := (SELECT auth.uid());
  _at  timestamptz := now();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.notification_read_marks (user_id, read_before, updated_at)
  VALUES (_uid, _at, _at)
  ON CONFLICT (user_id) DO UPDATE
    SET read_before = GREATEST(public.notification_read_marks.read_before, EXCLUDED.read_before),
        updated_at  = EXCLUDED.updated_at;
  RETURN _at;
END;
$function$;

REVOKE ALL ON FUNCTION public.notifications_overview(text[], timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notifications_mark_read(text, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notifications_mark_all_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notifications_overview(text[], timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notifications_mark_read(text, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notifications_mark_all_read() TO authenticated;

-- ── 6. the two order triggers: meta.recipient (+ meta for order_returned) ───
CREATE OR REPLACE FUNCTION public.tg_notify_order_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_id uuid;
  label    text;
  amount   text;
  msg      text;
  _mkd     numeric;
  _meta    jsonb;
BEGIN
  -- Bulk data repair (SET LOCAL elyon.bulk_repair = 'on'): no bells.
  IF coalesce(current_setting('elyon.bulk_repair', true), '') = 'on' THEN RETURN NEW; END IF;

  owner_id := COALESCE(NEW.confirmed_by_agent_id, NEW.assigned_agent_id);
  label := 'Order ' || COALESCE(NEW.display_id, left(NEW.id::text, 8));
  -- Денари, never euro (owner, 2026-09-28). orders.price is stored EUR; the
  -- denar figure is derived at the FROZEN 61.5 peg (src/lib/currency.ts
  -- MKD_PER_EUR — never "update" it), whole denars, Macedonian grouping
  -- ("2.490 ден"), exactly what formatMoney() shows everywhere else.
  _mkd := round(COALESCE(NEW.price, 0) * 61.5);
  amount := replace(to_char(_mkd, 'FM999,999,999,990'), ',', '.') || ' ден';
  msg := label || ' (' || COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, '') || ') was paid — ' || amount || '.';
  -- English above is the fallback; the bell renders notif.orderPaid.* in the
  -- reader's language (elyon-notifications Rule 2). amountMkd is DENARI
  -- (formatDenari on the client — never ×61.5 again).
  _meta := jsonb_build_object(
    'i18n',      'notif.orderPaid',
    'order',     COALESCE(NEW.display_id, left(NEW.id::text, 8)),
    'customer',  COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, ''),
    'amountMkd', _mkd
  );

  -- Agent copy (the sale owner). recipient 'owner' = the one copy that pops a toast.
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, link, meta)
    VALUES (owner_id, 'order_paid', 'Order paid', msg, '/orders', _meta || '{"recipient":"owner"}'::jsonb);
  END IF;

  -- Admin oversight (exclude owner to avoid a dup).
  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT ur.user_id, 'order_paid', 'Order paid', msg, '/orders', _meta || '{"recipient":"admin"}'::jsonb
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND ur.user_id <> COALESCE(owner_id, '00000000-0000-0000-0000-000000000000');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_notify_order_returned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_id uuid;
  label    text;
  msg      text;
  _meta    jsonb;
BEGIN
  -- Bulk data repair (SET LOCAL elyon.bulk_repair = 'on'): no bells.
  IF coalesce(current_setting('elyon.bulk_repair', true), '') = 'on' THEN RETURN NEW; END IF;

  owner_id := COALESCE(NEW.confirmed_by_agent_id, NEW.assigned_agent_id);
  label := 'Order ' || COALESCE(NEW.display_id, left(NEW.id::text, 8));
  msg := label || ' (' || COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, '') || ') was marked Returned.';
  -- The reader's language (notif.orderReturned.*); amountMkd is DENARI at the frozen peg.
  _meta := jsonb_build_object(
    'i18n',      'notif.orderReturned',
    'order',     COALESCE(NEW.display_id, left(NEW.id::text, 8)),
    'customer',  COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, ''),
    'amountMkd', round(COALESCE(NEW.price, 0) * 61.5)
  );

  -- Agent copy (the sale owner).
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, link, meta)
    VALUES (owner_id, 'order_returned', 'Order returned', msg, '/orders', _meta || '{"recipient":"owner"}'::jsonb);
  END IF;

  -- Admin oversight (exclude owner to avoid a dup).
  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT ur.user_id, 'order_returned', 'Order returned', msg, '/orders', _meta || '{"recipient":"admin"}'::jsonb
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND ur.user_id <> COALESCE(owner_id, '00000000-0000-0000-0000-000000000000');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;
