-- The MEX PROFILE decides, not the agent's team (owner, 29.09.2026 ~12:05, after seeing that the
-- CRM sales of the crm_prediction agents ship 98% via BIO NATURAL 9103):
--   "Every order sent to MEX via BIO NATURAL comes from affiliate IN and OUT; no teleshop order has
--    ever been sent via BIO NATURAL — teleshop sends via NATURA. Agents placed in teleshop who send
--    via BIO NATURAL are not teleshop, they are affiliate out or in."
--
-- So the team rule of 20260942001800 (crm_prediction seller → Телешоп – Lead out) is WITHDRAWN:
--   · order_dept_override(...) returns NULL for every order;
--   · every orders.dept_override is reset to NULL → the 4-argument cohort_order_source equals THE
--     folder / series mapping again: a CRM-made sale is Affiliate – Lead out, and a NATURA parcel's
--     series moves it (9102 → Телешоп – Lead out, 9100 → Телешоп – Lead in, 9108 / 1300 → social);
--     a LEADS-OUT (BIO NATURAL 9103) is Affiliate – Lead out.
-- The column, the 4-argument function, the triggers and the report functions stay (inert: they pass
-- NULL) — a future owner rule can use them without re-emitting 15 functions. The Prediction-lists
-- tab keeps holding the list sales of every department (a list sale on a NATURA parcel included).

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.order_dept_override(p_sale_source text, p_detail text, p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- No agent-team override: the MEX profile / folder decides (owner, 29.09.2026 ~12:05,
  -- migration 20260942001850). Kept as the one place a future rule would go.
  SELECT NULL::text
$fn$;
COMMENT ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz) IS
  'Returns NULL: the MEX profile / collabBox folder decides the department (owner 29.09.2026 ~12:05, 20260942001850 withdrew the crm_prediction team rule of 20260942001800). The one place a future agent rule would go.';

COMMENT ON COLUMN public.orders.dept_override IS
  'Reserved (20260942001800 / 20260942001850): NULL for every order — the MEX profile / folder decides (THE mapping, cohort_order_source 3-arg). Maintained by tg_orders_zz_dept_override from order_dept_override(), which returns NULL.';

SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
UPDATE public.orders SET dept_override = NULL WHERE dept_override IS NOT NULL;

COMMIT;
