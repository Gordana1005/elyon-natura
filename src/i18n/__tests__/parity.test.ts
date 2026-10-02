import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import sq from '../locales/sq.json';
import mk from '../locales/mk.json';
import { ALL_STATUSES, PREDICTION_LEAD_STATUSES } from '@/types';
import { CANCEL_REASON_VALUES } from '@/lib/cancellationReasons';
import { TRASH_REASON_VALUES } from '@/lib/trashReasons';

// CI guard for the translation files: every key must exist in ALL languages
// (a missing key would silently fall back to English in production), and
// every enum value rendered through statusLabel / predictionLeadLabel /
// cancelReasonLabel must have a corresponding entry.
//
// en.json is the reference tree. Adding a 5th language = one line in LOCALES.

type Tree = { [key: string]: string | Tree };

const LOCALES = { sq, mk } as unknown as Record<string, Tree>; // en is the reference
const TRANSLATED = Object.keys(LOCALES);
const ALL_LOCALES: Record<string, Tree> = { en: en as unknown as Tree, ...LOCALES };

function flattenKeys(obj: Tree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? [path] : flattenKeys(v as Tree, path);
  });
}

describe('i18n locale parity', () => {
  const enKeys = new Set(flattenKeys(en as Tree));

  it.each(TRANSLATED)('%s.json has every key from en.json', (lang) => {
    const keys = new Set(flattenKeys(LOCALES[lang]));
    const missing = [...enKeys].filter(k => !keys.has(k));
    expect(missing, `keys missing from ${lang}.json: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(TRANSLATED)('%s.json has no extra keys absent from en.json', (lang) => {
    const extra = flattenKeys(LOCALES[lang]).filter(k => !enKeys.has(k));
    expect(extra, `keys in ${lang}.json but not en.json: ${extra.join(', ')}`).toEqual([]);
  });

  it('no empty translation values', () => {
    const empties = (lang: Tree, name: string) =>
      flattenKeys(lang).filter(k => {
        const value = k.split('.').reduce<Tree | string>((o, part) => (o as Tree)[part], lang);
        return typeof value === 'string' && value.trim() === '';
      }).map(k => `${name}:${k}`);
    expect(Object.entries(ALL_LOCALES).flatMap(([name, tree]) => empties(tree, name))).toEqual([]);
  });
});

describe('i18n enum coverage', () => {
  const langs = Object.keys(ALL_LOCALES);

  it.each(langs)('%s covers all order statuses', (lang) => {
    const statusKeys = Object.keys(ALL_LOCALES[lang].status as Tree);
    for (const s of ALL_STATUSES) expect(statusKeys, `status.${s} missing in ${lang}`).toContain(s);
  });

  it.each(langs)('%s covers all prediction lead statuses', (lang) => {
    const keys = Object.keys(ALL_LOCALES[lang].leadStatus as Tree);
    for (const s of PREDICTION_LEAD_STATUSES) expect(keys, `leadStatus.${s} missing in ${lang}`).toContain(s);
  });

  it.each(langs)('%s covers all active cancellation reasons (and retired ones)', (lang) => {
    const keys = Object.keys(ALL_LOCALES[lang].cancelReason as Tree);
    for (const v of CANCEL_REASON_VALUES) expect(keys, `cancelReason.${v} missing in ${lang}`).toContain(v);
    // Retired reasons still on historical orders must keep rendering friendly labels.
    for (const v of ['family_refused', 'wrong_product', 'duplicate_order']) {
      expect(keys, `retired cancelReason.${v} missing in ${lang}`).toContain(v);
    }
  });

  it.each(langs)('%s covers all trash reasons', (lang) => {
    const keys = Object.keys(ALL_LOCALES[lang].trashReason as Tree);
    for (const v of TRASH_REASON_VALUES) expect(keys, `trashReason.${v} missing in ${lang}`).toContain(v);
  });
});

describe('macedonian orthography', () => {
  // Macedonian has no ъ / щ / я / ю / ь. Their presence means a Bulgarian value
  // leaked into mk.json — the exact failure mode this locale was reviewed for.
  //
  // The exceptions below are NOT language, they are DATA that happens to be
  // Bulgarian, and translating them breaks the feature (the Bulgarian UI itself
  // was switched off on 02.10.2026 — bg.json and languages.bg are gone):
  //   bigArenaStock.errUnrecognized — literal column headers of the BigArena
  //                                   export file the agent is looking at.
  //   delivery.typeCityPlaceholder  — the address DB holds Bulgarian city
  //                                   names; "Софија" would match nothing.
  const FOREIGN_LITERALS = new Set([
    'bigArenaStock.errUnrecognized',
    'delivery.typeCityPlaceholder',
  ]);

  it('mk.json contains no Bulgarian-only letters', () => {
    const tree = ALL_LOCALES.mk;
    const offenders = flattenKeys(tree)
      .filter(k => !FOREIGN_LITERALS.has(k))
      .map(k => [k, k.split('.').reduce<Tree | string>((o, p) => (o as Tree)[p], tree)] as const)
      .filter(([, v]) => typeof v === 'string' && /[ъщяюь]/i.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders, `Bulgarian letters in mk.json:\n${offenders.join('\n')}`).toEqual([]);
  });
});
