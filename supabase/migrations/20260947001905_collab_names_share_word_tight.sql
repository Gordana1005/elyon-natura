-- ============================================================================
-- collab_names_share_word: equal words, or a GLUED name — not any substring (03.10.2026)
-- ============================================================================
-- 20260947001900 let a name word contained in another match ("angel" ⊂ "vangel" / "angela", "spaso" ⊂ "spasovska"):
-- the dry run of 03.10 showed one phoneless 10111 booking ("Ангел Алексовски", 1.640 ден) sparing three different
-- AlterCPA approvals (Angela · Vangel Bakylev · Laste Aleksovski). Every true match in the September backtest was an
-- equal word, except one GLUED name ("Janevskgjorgji" ⊃ "gorgi" — first + last name without a space). So containment
-- counts only when the longer word is at least 5 letters longer than the shorter (two names glued together).
-- Backtest after the change (September sale days 01–27, as of sale day + 5, with the komitent phones loaded 03.10):
-- 0 wrong cancels, 0 never-shipped sales spared by the amount twin. A false match only spares an order.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF to_regprocedure('public.collab_names_share_word(text,text)') IS NULL
     OR to_regprocedure('public.collab_name_words(text)') IS NULL THEN
    RAISE EXCEPTION 'collab_names_share_word: 20260947001900 is missing';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.collab_names_share_word(p_a text, p_b text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $fn$
  -- an equal word (4+ letters, mk_geo_norm-folded), or a glued name: the shorter word inside a word at least 5 letters
  -- longer ("janevskgorgi" ⊃ "gorgi") — never "angel" ⊂ "vangel"
  SELECT EXISTS (SELECT 1 FROM unnest(public.collab_name_words(p_a)) x, unnest(public.collab_name_words(p_b)) y
                  WHERE x = y
                     OR (length(x) >= length(y) + 5 AND strpos(x, y) > 0)
                     OR (length(y) >= length(x) + 5 AND strpos(y, x) > 0));
$fn$;
COMMENT ON FUNCTION public.collab_names_share_word(text, text) IS
  'Owner 03.10.2026: do two names share a word — an equal word (4+ letters, folded by collab_name_words), or a glued name (the shorter word inside a word ≥ 5 letters longer). Used by sale_collab_amount_twin. Migrations 20260947001900 / 1905.';

REVOKE ALL ON FUNCTION public.collab_names_share_word(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collab_names_share_word(text, text) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collab_names_share_word(text, text) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
