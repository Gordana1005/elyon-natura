import { describe, expect, it } from 'vitest';
import library from '@/components/callscripts/__fixtures__/library.sample.json';
import coverage from '@/components/callscripts/__fixtures__/coverage.sample.json';
import forLead from '@/components/callscripts/__fixtures__/forCall.lead.sample.json';
import forPrediction from '@/components/callscripts/__fixtures__/forCall.prediction.sample.json';
import forEmpty from '@/components/callscripts/__fixtures__/forCall.empty.sample.json';
import {
  ALL_GROUPS, buildTwins, matchScripts, sectionsToText, validateSections,
  type CallScriptsForCall, type CoverageResponse, type ScriptsLibrary,
} from './callScriptsTypes';

// The fixtures workstreams B (/call-scripts) and C (/calls dock) build against must stay
// consistent with the pure rules the server runs.
const lib = library as unknown as ScriptsLibrary;
const cov = coverage as unknown as CoverageResponse;

describe('call-scripts fixtures', () => {
  it('library: every targeted script has valid sections and the derived script_text', () => {
    const targeted = lib.scripts.filter((s) => s.context_type === 'targeted');
    expect(targeted.length).toBeGreaterThan(5);
    for (const s of targeted) {
      expect(validateSections(s.sections).ok, s.title).toBe(true);
      expect(s.script_text).toBe(sectionsToText(s.sections));
      for (const g of s.groups) expect(ALL_GROUPS as readonly string[]).toContain(g);
    }
    expect(new Set(lib.scripts.map((s) => s.status))).toEqual(new Set(['published', 'draft', 'archived']));
  });

  it('coverage: every row and the all-products row carry all 12 groups', () => {
    expect(cov.groups).toEqual([...ALL_GROUPS]);
    for (const g of ALL_GROUPS) expect(cov.all_products[g]).toBeTruthy();
    for (const r of cov.rows) for (const g of ALL_GROUPS) expect(r.cells[g], `${r.key}/${g}`).toBeTruthy();
  });

  it('for-call: best + alternatives are what matchScripts picks for the context', () => {
    const twins = buildTwins(lib.products);
    for (const fc of [forLead, forPrediction] as unknown as CallScriptsForCall[]) {
      const ctx = fc.context!;
      const r = matchScripts(lib.scripts, { group: ctx.group, primary: ctx.product?.id ?? null, products: ctx.products.map((p) => p.id), twins });
      expect(fc.best?.id).toBe(r.best?.script.id);
      expect(fc.best?.match).toEqual(r.best?.match);
      expect(fc.alternatives.map((a) => a.id)).toEqual(r.alternatives.map((a) => a.script.id));
    }
    const empty = forEmpty as unknown as CallScriptsForCall;
    expect(empty.enabled).toBe(false);
    expect(empty.best).toBeNull();
  });
});
