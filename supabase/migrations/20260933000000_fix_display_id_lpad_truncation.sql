-- URGENT: order creation was failing for EVERY new order.
--
-- generate_order_display_id() built the number as:
--     'ORD-' || LPAD(nextval('order_display_id_seq')::text, 5, '0')
--
-- LPAD does not only pad — it TRUNCATES when the input is longer than the target
-- width. That is harmless for five digits or fewer, but the sequence passed
-- 99999 on 2026-09-18 and from that moment:
--
--     lpad('100000', 5, '0') -> '10000'
--     lpad('102392', 5, '0') -> '10239'
--
-- so every new order was handed a five-character id that an OLD order already
-- owned, and the insert died on orders_display_id_key:
--     duplicate key value violates unique constraint "orders_display_id_key"
--     Key (display_id)=(ORD-10239) already exists.
--
-- Found because a bulk import created 250 rows and then failed 2.391 times in a
-- row; checking the live table showed only 2 orders created in the preceding two
-- hours — agents could not save an order at all. This is a hard outage of order
-- creation, not an import-only problem.
--
-- FIX: pad only while the value is short, never truncate. ORD-00001 … ORD-99999
-- keep their existing five-digit shape, and ORD-100000 onward simply grow a
-- digit. Nothing already stored changes, and the sequence (102392) is already
-- clear of the highest number in use (99999).
CREATE OR REPLACE FUNCTION public.generate_order_display_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v text;
BEGIN
  IF NEW.display_id IS NULL OR NEW.display_id = '' THEN
    v := nextval('public.order_display_id_seq')::text;
    NEW.display_id := 'ORD-' || CASE WHEN length(v) < 5 THEN lpad(v, 5, '0') ELSE v END;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.generate_order_display_id() IS
  'Assigns ORD-NNNNN from order_display_id_seq. Pads to 5 digits but NEVER truncates — LPAD(x,5) silently shortened 6-digit sequence values and collided with existing ids (outage 2026-09-18).';

-- Safety net: if the sequence were ever behind the numbers already in use, the
-- same collision would come back by a different route. Push it past the highest
-- numeric display_id in the table. (No-op when it is already ahead.)
SELECT setval(
  'public.order_display_id_seq',
  GREATEST(
    (SELECT last_value FROM public.order_display_id_seq),
    COALESCE((SELECT max(regexp_replace(display_id, '^ORD-', '')::bigint)
              FROM public.orders
              WHERE display_id ~ '^ORD-[0-9]+$'), 0) + 1
  ),
  true
);
