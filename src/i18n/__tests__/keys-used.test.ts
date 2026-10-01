import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../locales/en.json';
import bg from '../locales/bg.json';
import sq from '../locales/sq.json';
import mk from '../locales/mk.json';

// Guards the bug class we shipped on 2026-06-13: code referencing keys that
// don't exist (renders the raw key in prod) and the locales drifting on
// interpolation placeholders or plural forms. Checked for EVERY translated
// language — a dropped {{count}} in one locale is invisible until a user
// switches to it.

function flat(obj: Record<string, unknown>, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v as Record<string, unknown>, key, out);
    else out[key] = String(v);
  }
  return out;
}
const EN = flat(en as Record<string, unknown>);
// Every translated locale, checked against EN. Adding a language = one entry.
const TRANSLATED: Record<string, Record<string, string>> = {
  bg: flat(bg as Record<string, unknown>),
  sq: flat(sq as Record<string, unknown>),
  mk: flat(mk as Record<string, unknown>),
};

const exists = (key: string) => key in EN || `${key}_other` in EN || `${key}_one` in EN;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (!/node_modules|__tests__/.test(p)) sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('i18n key usage', () => {
  it('every statically referenced key exists in en.json', () => {
    const keyRe = /(?:[^a-zA-Z0-9_.]|^)(?:t|i18n\.t)\(\s*['"`]([a-zA-Z][a-zA-Z0-9_.]*)['"`]\s*[,)]/g;
    const propRe = /(?:labelKey|descKey|titleKey|subtitleKey)\s*:\s*['"]([a-zA-Z][a-zA-Z0-9_.]*)['"]/g;
    const missing: string[] = [];
    for (const f of sourceFiles('src')) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(keyRe)) {
        if (m[1].includes('.') && !m[1].endsWith('.') && !exists(m[1])) missing.push(`${f}: t('${m[1]}')`);
      }
      for (const m of src.matchAll(propRe)) {
        if (!exists(m[1])) missing.push(`${f}: '${m[1]}'`);
      }
    }
    expect(missing).toEqual([]);
  }, 30_000); // scans every source file: slow under full-suite load

  it.each(Object.keys(TRANSLATED))('EN and %s agree on {{placeholders}} per key', (lang) => {
    const dict = TRANSLATED[lang];
    const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]).sort().join(',');
    const mismatches: string[] = [];
    for (const k of Object.keys(EN)) {
      if (k in dict && ph(EN[k]) !== ph(dict[k])) {
        mismatches.push(`${k}: en(${ph(EN[k])}) vs ${lang}(${ph(dict[k])})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('plural keys come in complete _one/_other pairs', () => {
    const issues: string[] = [];
    for (const [lang, dict] of Object.entries({ en: EN, ...TRANSLATED })) {
      for (const k of Object.keys(dict)) {
        if (k.endsWith('_one') && !(k.replace(/_one$/, '_other') in dict)) issues.push(`${lang}:${k} missing _other`);
        if (k.endsWith('_other') && !(k.replace(/_other$/, '_one') in dict)) issues.push(`${lang}:${k} missing _one`);
      }
    }
    expect(issues).toEqual([]);
  });
});
