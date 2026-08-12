-- Macedonian is the default UI language (operator decision 2026-08-12).
--
-- The app already defaulted to 'mk' when localStorage was empty, but
-- profiles.language DEFAULTed to 'en' and LanguageContext lets the DB value win
-- over the local cache — so every agent was pushed back to English on login and
-- the app-level default never had a chance to apply.
--
-- Existing 'en' rows are inherited column defaults, not deliberate choices: the
-- switcher writes the chosen code explicitly, and the Macedonian instance has
-- only ever been staffed by Macedonian speakers. Anyone who genuinely wants
-- English can pick it again from the switcher, which re-persists it here.
-- 'bg' and 'sq' rows are left alone — those ARE deliberate picks.

ALTER TABLE public.profiles ALTER COLUMN language SET DEFAULT 'mk';

UPDATE public.profiles
   SET language = 'mk'
 WHERE language IS NULL OR language = 'en';

NOTIFY pgrst, 'reload schema';
