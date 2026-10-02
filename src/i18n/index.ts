import i18n, { type BackendModule, type ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';

// App-wide i18n singleton. src/main.tsx mounts the app only once `i18nReady` resolves, so the
// starting language is active from the first paint.
//
// Re-render contract: changing language re-renders ONLY components subscribed
// via useTranslation(). Components that render translated text through helper
// functions (statusLabel, cancelReasonLabel, friendlyRoleLabel, …) must call
// useTranslation() themselves — even if they don't use `t` directly — so they
// re-render on switch. NEVER force a tree remount with key={language}: that
// would wipe an agent's half-filled order form mid-call.

export type AppLanguage = 'en' | 'sq' | 'mk';
// This deployment serves MACEDONIA: 'mk' (literary Skopje standard) is the
// default. Albanian ('sq') is kept for Albanian-speaking agents, English as the
// third language. Bulgarian was switched off by the owner on 02.10.2026 ("not
// needed") — its locale file is gone. Professional wording review happens in-app
// (operator workflow); keys stay stable, only values change.
// Cross-device persistence needs the profiles.language CHECK constraint to allow
// the code (migrations 20260622120000_profiles_language_sq.sql /
// 20260906000000_profiles_language_mk.sql); until applied the choice still
// sticks per-device via localStorage. A stored 'bg' (device or profile) is simply
// not supported any more and falls back to the default.
export const SUPPORTED_LANGUAGES: AppLanguage[] = ['en', 'sq', 'mk'];
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
  return DEFAULT_LANGUAGE;
}

// Each language is its own lazy chunk (owner, 02.10.2026 — "fast, no delays"): the first load
// carries only the language in use (~140 KB gzipped) instead of every language (~530 KB, which
// was 90 % of the entry bundle). A language switch fetches its chunk once; changeLanguage()
// resolves after it arrived, so nobody sees raw keys.
const LOCALE_FILES = import.meta.glob<ResourceKey>('./locales/*.json', { import: 'default' });

const lazyLocales: BackendModule = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    const load = LOCALE_FILES[`./locales/${language}.json`];
    if (!load) {
      callback(new Error(`i18n: no locale file for "${language}"`), false);
      return;
    }
    load().then(
      (data) => callback(null, data),
      (err: unknown) => {
        // A tab opened before a deploy asks for a locale chunk that no longer exists: hand it to
        // main.tsx's "reload once to pick up the new build" handler, like every other lazy chunk.
        try {
          window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
        } catch {
          // no DOM
        }
        callback(err instanceof Error ? err : new Error(String(err)), false);
      },
    );
  },
};

// <html lang> follows the UI language (WCAG 3.1.1): screen readers pick the right voice and the
// browser stops offering to "translate from English" a Macedonian page.
function syncDocumentLang(lng: string) {
  try {
    document.documentElement.lang = lng;
  } catch {
    // no DOM
  }
}
i18n.on('languageChanged', syncDocumentLang);

/** Resolves once the starting language is loaded — src/main.tsx mounts the app after it. */
export const i18nReady = i18n
  .use(lazyLocales)
  .use(initReactI18next)
  .init({
    lng: storedLanguage(),
    supportedLngs: SUPPORTED_LANGUAGES,
    // The fallback is Macedonian, the default — so a Macedonian session loads ONE file. Every
    // locale carries every key anyway (src/i18n/__tests__/parity.test.ts).
    fallbackLng: DEFAULT_LANGUAGE,
    ns: ['translation'],
    defaultNS: 'translation',
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
    // The app mounts after i18nReady and changeLanguage() waits for its chunk — never suspend.
    react: { useSuspense: false },
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: import.meta.env.DEV
      ? (_langs, _ns, key) => console.warn(`[i18n] missing key: ${key}`)
      : undefined,
    // In dev, render misses loudly as ⟪key⟫; in prod a miss falls back to the
    // Macedonian value (fallbackLng) or, failing that, the key itself.
    parseMissingKeyHandler: import.meta.env.DEV ? (key) => `⟪${key}⟫` : undefined,
  });

syncDocumentLang(i18n.language || DEFAULT_LANGUAGE);

export default i18n;
