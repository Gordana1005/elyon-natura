import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import bg from './locales/bg.json';
import sq from './locales/sq.json';
import mk from './locales/mk.json';

// App-wide i18n singleton. Imported for its side effect at the very top of
// src/main.tsx so the cached language is active before the first paint.
//
// Re-render contract: changing language re-renders ONLY components subscribed
// via useTranslation(). Components that render translated text through helper
// functions (statusLabel, cancelReasonLabel, friendlyRoleLabel, …) must call
// useTranslation() themselves — even if they don't use `t` directly — so they
// re-render on switch. NEVER force a tree remount with key={language}: that
// would wipe an agent's half-filled order form mid-call.

export type AppLanguage = 'en' | 'bg' | 'sq' | 'mk';
// This deployment serves MACEDONIA: 'mk' (literary Skopje standard) is the
// default. Albanian ('sq') is kept for Albanian-speaking agents, and bg/en are
// kept as fallbacks — all four ship. Professional wording review
// happens in-app (operator workflow); keys stay stable, only values change.
// Cross-device persistence needs the profiles.language CHECK constraint to allow
// the code (migrations 20260622120000_profiles_language_sq.sql /
// 20260906000000_profiles_language_mk.sql); until applied the choice still
// sticks per-device via localStorage.
export const SUPPORTED_LANGUAGES: AppLanguage[] = ['en', 'bg', 'sq', 'mk'];
export const LANG_STORAGE_KEY = 'elyon.lang';

/** Macedonia's default UI language. Mirrors profiles.language's column DEFAULT
 *  (migration 20260920000000) — keep the two in step, or a fresh login lands in
 *  one language and the DB pushes it to another a moment later. */
export const DEFAULT_LANGUAGE: AppLanguage = 'mk';

function storedLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY) as AppLanguage | null;
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;
  } catch {
    // localStorage unavailable (private mode etc.) — fall through to default.
  }
  // Macedonia default = Macedonian. Albanian ('sq') stays shipped for
  // Albanian-speaking agents — that is a language choice, not a market one.
  // fallbackLng stays 'en' below so a missing key still resolves.
  return DEFAULT_LANGUAGE;
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    bg: { translation: bg },
    sq: { translation: sq },
    mk: { translation: mk },
  },
  lng: storedLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
  saveMissing: import.meta.env.DEV,
  missingKeyHandler: import.meta.env.DEV
    ? (_langs, _ns, key) => console.warn(`[i18n] missing key: ${key}`)
    : undefined,
  // In dev, render misses loudly as ⟪key⟫; in prod a miss falls back to the
  // English value (fallbackLng) or, failing that, the key itself.
  parseMissingKeyHandler: import.meta.env.DEV ? (key) => `⟪${key}⟫` : undefined,
});

export default i18n;
