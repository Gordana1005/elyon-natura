-- ============================================================================
-- Тим Маџари → Affiliate, Тим Центар → Teleshop (owner, 15.10.2026)
--
-- Owner: "веќе нема Маџари, Центар … Сите се на иста локација … менуваме имиња (и тоа треба да се
-- случи секаде): МАЏАРИ ИН → Affiliate IN, МАЏАРИ ОУТ → Affiliate Out, ЦЕНТАР ИН → Teleshop In,
-- ЦЕНТАР ОУТ → Teleshop Out." DISPLAY NAMES ONLY — the keys (affiliate, teleshop, altercpa,
-- elyon_crm, teleshop_out, teleshop_other), list names and URLs never change. The same audited path
-- as the 02.10 rename (audit_log 'sales_team.rename'); the access notes follow.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

WITH ren(key, new_name) AS (VALUES ('affiliate', 'Affiliate'), ('teleshop', 'Teleshop')),
up AS (
  UPDATE public.sales_teams t SET name = r.new_name
  FROM ren r
  WHERE t.key = r.key AND t.name IS DISTINCT FROM r.new_name
  RETURNING t.key, t.name
)
INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
SELECT '27f13f6e-fd19-44bb-a3c8-a6855a887cc7'::uuid, 'mile@elyon.com', 'sales_team.rename', 'sales_team', up.key, up.name,
       jsonb_build_object('by', 'claude-code',
         'reason', 'owner 15.10.2026: Тим Маџари → Affiliate, Тим Центар → Teleshop (display names only; keys unchanged)')
FROM up;

-- the access notes written on 02.10 ("Тим Центар" / "Тим Маџари")
UPDATE public.user_access
   SET note = replace(replace(note, 'Тим Маџари', 'Affiliate'), 'Тим Центар', 'Teleshop')
 WHERE note ~ '(Тим Маџари|Тим Центар)';

COMMIT;
