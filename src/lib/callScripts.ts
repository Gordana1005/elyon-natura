import i18n from '@/i18n';
import type { CallScript, CallScriptHelper, CallScriptTranslation } from '@/lib/api';

// The language the existing base columns (title/description/script_text/helpers)
// were authored in. Everything else lives in call_scripts.translations[<lang>]
// and falls back to these base columns per field.
export const BASE_SCRIPT_LANG = 'mk';

/**
 * The ONLY languages call scripts are written in for Macedonia (operator rule
 * 2026-08-12): Macedonian (the base columns) and Albanian (translations.sq).
 * en/bg stay valid UI languages — an agent reading the app in English still
 * reads the script in Macedonian, because what they say to a Macedonian
 * customer has nothing to do with the language of their own buttons.
 */
export const SCRIPT_LANGS = [BASE_SCRIPT_LANG, 'sq'] as const;
export type ScriptLang = typeof SCRIPT_LANGS[number];

/** Per-device pick, so a switch survives a refresh mid-shift. */
export const SCRIPT_LANG_STORAGE_KEY = 'elyon.scriptLang';

export function storedScriptLang(): ScriptLang {
  try {
    const v = localStorage.getItem(SCRIPT_LANG_STORAGE_KEY);
    if (v && (SCRIPT_LANGS as readonly string[]).includes(v)) return v as ScriptLang;
  } catch { /* private mode */ }
  return BASE_SCRIPT_LANG;
}

export function persistScriptLang(lang: ScriptLang) {
  try { localStorage.setItem(SCRIPT_LANG_STORAGE_KEY, lang); } catch { /* private mode */ }
}

export interface ResolvedScript {
  title: string;
  description: string | null;
  script_text: string;
  helpers: CallScriptHelper[];
}

/** Normalise an i18next language tag ('sq', 'sq-MK', undefined) to a bare code. */
function normalizeLang(lang?: string): string {
  return (lang || i18n.language || BASE_SCRIPT_LANG).split('-')[0];
}

const hasText = (v?: string | null): v is string => typeof v === 'string' && v.trim().length > 0;

/** The raw translation object for a given language, if any (no fallback applied). */
export function getTranslation(script: CallScript, lang?: string): CallScriptTranslation | undefined {
  const code = normalizeLang(lang);
  if (code === BASE_SCRIPT_LANG) return undefined;
  return script.translations?.[code];
}

/**
 * Resolve the script for the active (or given) language, falling back PER FIELD to
 * the Macedonian base column when a translated field is empty/missing. Helpers fall
 * back as a whole array (a non-empty translated array replaces the base set),
 * which avoids index drift on partially translated helper lists.
 */
export function resolveScript(script: CallScript, lang?: string): ResolvedScript {
  const base: ResolvedScript = {
    title: script.title,
    description: script.description ?? null,
    script_text: script.script_text,
    helpers: script.helpers ?? [],
  };
  const tr = getTranslation(script, lang);
  if (!tr) return base;
  return {
    title: hasText(tr.title) ? tr.title : base.title,
    description: hasText(tr.description) ? tr.description : base.description,
    script_text: hasText(tr.script_text) ? tr.script_text : base.script_text,
    helpers: Array.isArray(tr.helpers) && tr.helpers.length > 0 ? tr.helpers : base.helpers,
  };
}

/** Language codes (other than the base) that have any non-empty translated field. */
export function translatedLanguages(script: CallScript): string[] {
  const t = script.translations;
  if (!t) return [];
  return Object.keys(t).filter((lang) => {
    const v = t[lang];
    return !!v && (hasText(v.title) || hasText(v.description) || hasText(v.script_text) || (Array.isArray(v.helpers) && v.helpers.length > 0));
  });
}
