-- ============================================================================
-- DENARI IN THE BELL (2026-09-28)
--
-- Owner order, 28.09.2026: "I want everywhere to be Денари instead of euro,
-- for the Macedonian market." Display only — prices stay STORED in EUR and
-- MKD_PER_EUR stays 61.5 (frozen). Two notification producers change, both by
-- CREATE OR REPLACE of the live definition (read 28.09 with
-- pg_get_functiondef); everything not listed below is byte-identical to it.
--
--   1. tg_notify_order_paid() — the "Order paid" message printed the price as
--      '€NN.NN' straight from the EUR column. It now prints whole денари at the
--      frozen peg ("… was paid — 2.490 ден.") and carries
--      meta {i18n:'notif.orderPaid', order, customer, amountMkd} so the bell
--      renders it in EN/BG/SQ/MK (elyon-notifications Rule 2). amountMkd is
--      denari; the client formats it with formatDenari, never ×61.5 again.
--      Rows written before this migration (meta NULL, '€NN.NN') are re-rendered
--      in денари by the bell itself (NotificationsDropdown legacy parse).
--      Still SECURITY DEFINER, still swallows every error, still silenced by
--      elyon.bulk_repair — the trigger binding is untouched.
--   2. notify_unpaid_shipped_orders() — the digest's staleness age measured
--      hours since the last 'order.bigarena_status_sync' audit row, a manual
--      upload removed 2026-08-18, so it only ever grew. It now measures hours
--      since the last successful mex_sync_runs row (finished_at, status 'ok'),
--      under a NEW meta key 'mexSyncAgeHours' — old rows keep 'syncAgeHours'
--      and the bell ignores that key, so no stale BigArena age is ever shown.
--      One comment "Sofia day" → "Skopje day" (the code already used Skopje).
--
-- Rollback: re-apply the two definitions from 20260934000200_money_guards.sql
-- (tg_notify_order_paid) and 20260905000100_unpaid_delivery_chase.sql
-- (notify_unpaid_shipped_orders).
-- ============================================================================

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

  -- Agent copy (the sale owner).
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, link, meta)
    VALUES (owner_id, 'order_paid', 'Order paid', msg, '/orders', _meta);
  END IF;

  -- Admin oversight (exclude owner to avoid a dup).
  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT ur.user_id, 'order_paid', 'Order paid', msg, '/orders', _meta
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND ur.user_id <> COALESCE(owner_id, '00000000-0000-0000-0000-000000000000');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_unpaid_shipped_orders(_force boolean DEFAULT false, _dry_run boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _threshold   int;
  _stop        int;
  _skopje_now   timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today       date;
  _day_start   timestamptz;
  _sent        int := 0;   -- agent notifications inserted
  _new_today   int := 0;   -- orders crossing the threshold for the FIRST time
  _total       int := 0;   -- ALL orders unpaid >= threshold (digest headline)
  _sync_age    int;        -- hours since the last successful MEX reconcile run
  _oldest_id   text;
  _oldest_days int;
  _who         text;
  _r           record;
BEGIN
  _today     := _skopje_now::date;
  _day_start := _today::timestamp AT TIME ZONE 'Europe/Skopje';

  -- Morning window only, unless forced. Hourly schedule + this gate + the
  -- ledger PK = self-healing without double-sending.
  IF NOT _force AND EXTRACT(hour FROM _skopje_now)::int NOT BETWEEN 9 AND 11 THEN
    RETURN 0;
  END IF;

  -- app_settings.value is jsonb: `value::int` is NOT a valid cast, the `#>> '{}'`
  -- unwrap to text is required. Getting this wrong fails at runtime, not at
  -- migration time.
  SELECT (value #>> '{}')::int INTO _threshold FROM public.app_settings WHERE key = 'unpaid_chase_days';
  SELECT (value #>> '{}')::int INTO _stop      FROM public.app_settings WHERE key = 'unpaid_chase_stop_days';
  _threshold := GREATEST(COALESCE(_threshold, 3), 1);
  _stop      := GREATEST(COALESCE(_stop, 30), _threshold);

  -- ── per-order pings ──────────────────────────────────────────────────────
  FOR _r IN
    SELECT o.id,
           COALESCE(o.display_id, left(o.id::text, 8)) AS label,
           o.customer_name,
           o.customer_phone,
           COALESCE(o.confirmed_by_agent_id, o.assigned_agent_id) AS owner_id,
           (_today - (o.shipped_at AT TIME ZONE 'Europe/Skopje')::date) AS days
    FROM public.orders o
    WHERE o.status IN ('shipped', 'delivered')   -- `delivered` is dead (0 rows) but eligible in the BigArena sync, so keep it
      AND o.shipped_at IS NOT NULL               -- ~11k legacy imports have no event time; NULL = unknown, never guess
      AND o.duplicated_from IS NULL              -- admin-only order copies are never agent-attributed
      AND o.source_type IS DISTINCT FROM 'monadon_legacy'
      AND (_today - (o.shipped_at AT TIME ZONE 'Europe/Skopje')::date) BETWEEN _threshold AND _stop
    ORDER BY o.shipped_at ASC
  LOOP
    BEGIN
      -- Already handled today? (cheap pre-check; the INSERT below is the
      -- race-safe authority)
      IF EXISTS (
        SELECT 1 FROM public.order_unpaid_alerts a
        WHERE a.order_id = _r.id AND a.alert_date = _today
      ) THEN
        CONTINUE;
      END IF;

      -- First time this order has EVER been chased.
      IF NOT EXISTS (
        SELECT 1 FROM public.order_unpaid_alerts a
        WHERE a.order_id = _r.id AND a.alert_date < _today
      ) THEN
        _new_today := _new_today + 1;
      END IF;

      IF _dry_run THEN
        IF _r.owner_id IS NOT NULL THEN _sent := _sent + 1; END IF;
        CONTINUE;
      END IF;

      INSERT INTO public.order_unpaid_alerts (order_id, alert_date, days_shipped, owner_id)
      VALUES (_r.id, _today, _r.days, _r.owner_id)
      ON CONFLICT (order_id, alert_date) DO NOTHING;
      IF NOT FOUND THEN
        CONTINUE;  -- a concurrent run won the race
      END IF;

      -- Agent copy. Skipped for unowned or deactivated-agent orders — those
      -- still show up in the admin digest, so nothing goes unwatched.
      IF _r.owner_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _r.owner_id AND p.is_active)
      THEN
        _who := COALESCE(NULLIF(_r.customer_name, ''), _r.customer_phone, '');
        INSERT INTO public.notifications (user_id, type, title, message, link, meta)
        VALUES (
          _r.owner_id,
          'shipped_unpaid',
          'Delivery not picked up',
          'Order ' || _r.label || ' (' || _who || ') shipped ' || _r.days::text
            || ' days ago and is still unpaid — call the client.',
          '/?tab=shipped',
          jsonb_build_object(
            'i18n',     'notif.shippedUnpaid',
            'order',    _r.label,
            'customer', _who,
            'days',     _r.days,
            'phone',    _r.customer_phone,
            'orderId',  _r.id
          )
        );
        _sent := _sent + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      -- One malformed row must not abort the morning run. The subtransaction
      -- rolls back this order's ledger row, so it is retried tomorrow.
      CONTINUE;
    END;
  END LOOP;

  IF _dry_run THEN
    RETURN _sent;
  END IF;

  -- ── admin digest ─────────────────────────────────────────────────────────
  -- Headline counts the FULL problem (every order unpaid >= threshold, with no
  -- upper bound), not just the ones that pinged an agent today — otherwise
  -- orders aged past `unpaid_chase_stop_days` would silently vanish from
  -- oversight, which is exactly the kind of blind spot this feature exists to
  -- remove.
  SELECT count(*)::int,
         (array_agg(COALESCE(o.display_id, left(o.id::text, 8)) ORDER BY o.shipped_at ASC))[1],
         max(_today - (o.shipped_at AT TIME ZONE 'Europe/Skopje')::date)
    INTO _total, _oldest_id, _oldest_days
  FROM public.orders o
  WHERE o.status IN ('shipped', 'delivered')
    AND o.shipped_at IS NOT NULL
    AND o.duplicated_from IS NULL
    AND o.source_type IS DISTINCT FROM 'monadon_legacy'
    AND (_today - (o.shipped_at AT TIME ZONE 'Europe/Skopje')::date) >= _threshold;

  IF COALESCE(_total, 0) = 0 THEN
    RETURN _sent;
  END IF;

  -- How fresh is the data behind those numbers? Courier outcomes (paid /
  -- returned) come from the mex-reconcile cron (the BigArena status upload it
  -- used to measure was removed 2026-08-18). If MEX has not completed a run
  -- lately, orders already collected still look unpaid and the digest
  -- overstates the problem. Report the staleness rather than muting the
  -- alerts — muting would hide real returns.
  BEGIN
    SELECT (EXTRACT(epoch FROM (now() - max(finished_at))) / 3600)::int
      INTO _sync_age
    FROM public.mex_sync_runs
    WHERE status = 'ok';
  EXCEPTION WHEN OTHERS THEN
    _sync_age := NULL;
  END;

  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT ur.user_id,
         'unpaid_digest',
         'Unpaid deliveries',
         _total::text || ' shipped orders are still unpaid after ' || _threshold::text
           || '+ days (' || _new_today::text || ' new today). Oldest: '
           || COALESCE(_oldest_id, '—') || ' — ' || COALESCE(_oldest_days, 0)::text || ' days.',
         '/orders',
         jsonb_build_object(
           'i18n',         'notif.unpaidDigest',
           'total',        _total,
           'new',          _new_today,
           'days',         _threshold,
           'oldestOrder',  _oldest_id,
           'oldestDays',   _oldest_days,
           'mexSyncAgeHours', _sync_age
         )
  FROM public.user_roles ur
  JOIN public.profiles p ON p.user_id = ur.user_id AND p.is_active
  WHERE ur.role = 'admin'
    -- one digest per admin per Skopje day, even if the job runs at 9, 10 and 11
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = ur.user_id
        AND n.type = 'unpaid_digest'
        AND n.created_at >= _day_start
    );

  RETURN _sent;
END;
$function$;
