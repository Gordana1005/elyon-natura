import { describe, expect, it } from 'vitest';
import library from './__fixtures__/library.sample.json';
import coverage from './__fixtures__/coverage.sample.json';
import type { CoverageResponse, ScriptsLibrary, TargetedScript } from '@/lib/callScriptsTypes';
import {
  DEFAULT_GRID_OPTIONS, DEFAULT_LIBRARY_FILTERS, cellAlert, cellDraftWins, cellState, draftScript, draftsForCell,
  duplicatePlan, editorDirty, editorHref, editorStateFrom, editorStateToPatch, editorWins, ensureFixedSections, filterLibrary,
  gridLineCounts, gridRows, libraryCounts, localMatch, moveItem, newCustomSectionId, parseGroupsParam, parseProductsParam,
  publishBlockers, readLibraryParams, sampleVars, searchProducts, tabOf, toggleFamily, toggleGroup, twinsOf, visibleTabs,
  withTwins, withoutFamily, writeLibraryParams,
} from './scriptsModel';

const LIB = library as unknown as ScriptsLibrary;
const COV = coverage as unknown as CoverageResponse;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = { prostatol: 'a1000000-0000-4000-8000-000000000001', bundle: 'a1000000-0000-4000-8000-000000000002', neurofix: 'a1000000-0000-4000-8000-000000000003', hepatol: 'a1000000-0000-4000-8000-000000000005', HEPATOL: 'a1000000-0000-4000-8000-000000000007' };
const twins = twinsOf(LIB.products);
const ctx = { twins, productName: (pid: string) => LIB.products.find((p) => p.id === pid)?.name };
const titles = (rows: TargetedScript[]) => rows.map((s) => s.title);

describe('tabs and deep links', () => {
  it('agents get the library and the promo only; an unknown tab falls back to the library', () => {
    expect(visibleTabs(false)).toEqual(['library', 'promo']);
    expect(visibleTabs(true)).toEqual(['library', 'coverage', 'tester', 'current', 'order', 'promo']);
    expect(tabOf(new URLSearchParams('tab=coverage'), visibleTabs(false))).toBe('library');
    expect(tabOf(new URLSearchParams('tab=coverage'), visibleTabs(true))).toBe('coverage');
  });
  it('a coverage cell opens a NEW script already aimed at its group and product', () => {
    const href = editorHref({ groups: ['d21'], products: [P.prostatol], from: 'coverage' });
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(Object.fromEntries(sp)).toEqual({ tab: 'coverage', new: '1', group: 'd21', product: P.prostatol });
    expect(parseGroupsParam('d57,bogus,d21')).toEqual(['d21', 'd57']); // ALL_GROUPS order, unknown dropped
    expect(parseProductsParam(`${P.prostatol},x,${P.prostatol}`)).toEqual([P.prostatol]);
    expect(editorHref({ id: id(1) })).toBe(`/call-scripts?script=${id(1)}`);
  });
});

describe('library filters', () => {
  it('status chips: published / draft / archived among the targeted rows, the legacy panel apart', () => {
    const c = libraryCounts(LIB.scripts, DEFAULT_LIBRARY_FILTERS, ctx);
    expect(c).toEqual({ all: 9, published: 5, draft: 3, archived: 1, legacy: 1 });
    expect(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, status: 'legacy' }, ctx).map((s) => s.context_type)).toEqual(['product']);
  });
  it('a group means attached to it; "every" means groups = {}', () => {
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, group: 'd21' }, ctx)).sort())
      .toEqual(['Предикција 21 ден — Простатол', 'Предикција 21 ден — општо'].sort());
    expect(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, group: 'every' }, ctx).every((s) => s.groups.length === 0)).toBe(true);
  });
  it('a product filter matches its twins (Hepatol ≡ HEPATOL)', () => {
    const viaTwin = filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, product: P.HEPATOL }, ctx);
    const direct = filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, product: P.hepatol }, ctx);
    expect(titles(viaTwin)).toEqual(titles(direct));
    expect(viaTwin.length).toBeGreaterThan(0);
  });
  it('text search is Cyrillic ⇄ Latin and reaches section text and product names', () => {
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, q: 'prostatol' }, ctx))).toContain('Простатол — сите клиенти');
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, q: 'пиреум' }, ctx))).toEqual(['Простатол — сите клиенти']);
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, q: 'pireum' }, ctx))).toEqual(['Простатол — сите клиенти']);
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, q: 'pireum zzz' }, ctx))).toEqual([]);
  });
  it('"без закачување" = targeted with no group and no product; "со предупредувања" = a warn-level lint', () => {
    expect(titles(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, untargeted: true }, ctx))).toEqual(['Општа скрипта']);
    const warn = filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, warnings: true }, ctx);
    expect(warn.every((s) => (s.lint ?? []).some((l) => l.severity === 'warn'))).toBe(true);
    expect(titles(warn)).toEqual(['Хепатол — Предикција 2+ години']); // the BG-content draft
    // the legacy row with ______ shows under its own chip
    expect(filterLibrary(LIB.scripts, { ...DEFAULT_LIBRARY_FILTERS, status: 'legacy', warnings: true }, ctx).map((s) => s.id)).toEqual([id(20)]);
  });
  it('filters round-trip through the URL', () => {
    const sp = writeLibraryParams(new URLSearchParams('tab=library'), { status: 'draft', group: 'trash', q: 'корпа', warnings: true });
    expect(readLibraryParams(sp)).toEqual({ status: 'draft', group: 'trash', product: null, q: 'корпа', untargeted: false, warnings: true });
    expect(sp.get('tab')).toBe('library');
    expect(writeLibraryParams(sp, { status: 'all', group: null, q: '', warnings: false }).toString()).toBe('tab=library');
  });
});

describe('product picker', () => {
  it('twins come along and leave together', () => {
    expect(withTwins([P.hepatol], twins)).toEqual([P.hepatol, P.HEPATOL]);
    expect(withoutFamily([P.prostatol, P.hepatol, P.HEPATOL], P.HEPATOL, twins)).toEqual([P.prostatol]);
  });
  it('search: Latin finds Cyrillic, active first, kind filter', () => {
    expect(searchProducts(LIB.products, 'хепат').map((p) => p.id)).toEqual([P.hepatol, P.HEPATOL]); // active Hepatol first
    expect(searchProducts(LIB.products, 'prostatol', 'bundle').map((p) => p.id)).toEqual([P.bundle]);
  });
});

describe('duplicate preview', () => {
  it('none / product / group / cell, an empty side counting once, 50 at most', () => {
    expect(duplicatePlan(['d21', 'd57'], [P.prostatol], 'none').count).toBe(1);
    expect(duplicatePlan(['d21', 'd57'], [P.prostatol, P.neurofix], 'product').targets)
      .toEqual([{ groups: ['d21', 'd57'], product_ids: [P.prostatol] }, { groups: ['d21', 'd57'], product_ids: [P.neurofix] }]);
    expect(duplicatePlan(['d21', 'd57', 'm4_6'], [], 'group').count).toBe(3);
    expect(duplicatePlan(['d21', 'd57'], [P.prostatol, P.neurofix, P.hepatol], 'cell').count).toBe(6);
    expect(duplicatePlan([], [], 'cell').count).toBe(1);
    const big = duplicatePlan(['d21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus'], Array.from({ length: 9 }, (_, i) => id(100 + i)), 'cell');
    expect(big).toMatchObject({ count: 54, tooMany: true, targets: [] });
  });
});

describe('coverage grid', () => {
  it('cell states follow the winner tier; red = nobody while clients wait; dashed = a draft would win', () => {
    const rowP = COV.rows.find((r) => r.key === P.prostatol)!;
    expect(cellState(rowP.cells.d21)).toBe('product_group');
    expect(cellState(COV.rows.find((r) => r.key === P.neurofix)!.cells.d21)).toBe('group');
    expect(cellState({ winner: null } as never)).toBe('none');
    const empty = Object.values(COV.all_products).find((c) => !c.winner && c.waiting > 0);
    if (empty) expect(cellAlert(empty)).toBe(true);
    expect(cellAlert({ waiting: 0, assigned: 0, winner: null, draft_winner: null, overlap: 0 })).toBe(false);
    expect(cellDraftWins({ waiting: 1, assigned: 0, winner: null, draft_winner: { script_id: id(6), title: 'x', tier: 2 }, overlap: 0 })).toBe(true);
    expect(cellDraftWins({ waiting: 1, assigned: 0, winner: { script_id: id(6), title: 'x', tier: 2 }, draft_winner: { script_id: id(6), title: 'x', tier: 2 }, overlap: 1 })).toBe(false);
  });
  it('rows: no-client products hidden by default, sorted by waiting, then by name; twins merged by the api stay one row', () => {
    const rows = gridRows(COV.rows, DEFAULT_GRID_OPTIONS);
    expect(rows.every((r) => r.waiting > 0)).toBe(true);
    expect(rows.map((r) => r.waiting)).toEqual([...rows.map((r) => r.waiting)].sort((a, b) => b - a));
    expect(rows.find((r) => r.key === 'hepatol')?.product_ids.sort()).toEqual([P.hepatol, P.HEPATOL].sort());
    expect(gridRows(COV.rows, { ...DEFAULT_GRID_OPTIONS, showEmpty: true }).length).toBe(COV.rows.length);
    const byName = gridRows(COV.rows, { ...DEFAULT_GRID_OPTIONS, sort: 'name' }).map((r) => r.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'mk')));
  });
  it('search and brand-line chips', () => {
    expect(gridRows(COV.rows, { ...DEFAULT_GRID_OPTIONS, q: 'простатол' }).map((r) => r.key)).toEqual([P.prostatol, P.bundle]);
    expect(gridRows(COV.rows, { ...DEFAULT_GRID_OPTIONS, lines: ['bio_natural'] }).every((r) => r.brand_line === 'bio_natural')).toBe(true);
    const counts = gridLineCounts(COV.rows, { q: '', showEmpty: false });
    expect(counts.bio_natural).toBe(2);
    expect(counts.natura_therapy).toBe(3);
  });
  it('the drafts aimed at a cell', () => {
    expect(draftsForCell(LIB.scripts, 'trash', null).map((s) => s.id)).toEqual([id(6), id(7)]);
    expect(draftsForCell(LIB.scripts, 'y2plus', [P.hepatol]).map((s) => s.id)).toEqual([id(7), id(9)]);
  });
});

describe('editor state', () => {
  const s1 = LIB.scripts.find((s) => s.id === id(1))!;
  it('always shows the four fixed parts; keeps the custom ones in place', () => {
    expect(ensureFixedSections([{ id: 'closing', key: 'closing', text: 'x' }]).map((s) => s.id)).toEqual(['opening', 'pitch', 'objections', 'closing']);
    const st = editorStateFrom(s1);
    expect(st.sections.map((s) => s.id)).toEqual(['opening', 'pitch', 'objections', 'closing', 'custom-gift01']);
    expect(st.sq.sections.opening.text).toMatch(/^Mirëdita/);
  });
  it('round-trips a script unchanged (not dirty) and drops empty fixed parts on save', () => {
    const st = editorStateFrom(s1);
    const p = editorStateToPatch(st);
    expect(p.sections).toEqual(s1.sections);
    expect(p.groups).toEqual(['d21', 'd57']);
    expect(p.translations?.sq?.sections?.map((s) => s.id)).toEqual(['opening', 'pitch']);
    expect(editorDirty(st, editorStateFrom(s1))).toBe(false);
    const two = LIB.scripts.find((s) => s.id === id(2))!; // opening + closing only
    expect(editorStateToPatch(editorStateFrom(two)).sections!.map((s) => s.id)).toEqual(['opening', 'closing']);
  });
  it('a new script from a cell starts aimed at it; publishing needs a title and a part with text', () => {
    const st = editorStateFrom(null, { groups: ['d57', 'd21'], product_ids: [P.prostatol] });
    expect(st.groups).toEqual(['d21', 'd57']);
    expect(publishBlockers(st)).toEqual(['title', 'text']);
    st.title = 'Наслов';
    st.sections = st.sections.map((s) => (s.id === 'pitch' ? { ...s, text: 'Текст' } : s));
    expect(publishBlockers(st)).toEqual([]);
  });
  it('custom section ids follow the contract; moving parts', () => {
    expect(newCustomSectionId()).toMatch(/^custom-[a-z0-9]{6,12}$/);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
  it('group chips: one, and a whole family', () => {
    expect(toggleGroup(['d57'], 'd21')).toEqual(['d21', 'd57']);
    expect(toggleFamily([], 'leads')).toEqual(['lead_new', 'lead_callback']);
    expect(toggleFamily(['lead_new', 'lead_callback', 'd21'], 'leads')).toEqual(['d21']);
  });
});

describe('where it wins (the server matcher)', () => {
  it('A [d21] loses its d21 × Prostatol cells to B (product + group) and wins the rest', () => {
    const a = draftScript(editorStateFrom(LIB.scripts.find((s) => s.id === id(2))!), { id: id(2), status: 'published' });
    const r = editorWins(a, LIB.scripts, { coverage: COV, products: LIB.products });
    expect(r.cells.every((c) => c.group === 'd21')).toBe(true);
    const lostTo = new Set(r.lost.map((c) => c.winner_id));
    expect(lostTo.has(id(1))).toBe(true);
    expect(r.wins).toBeGreaterThan(0);
    expect(r.wins + r.loses).toBe(r.cells.length);
    expect(r.lost[0].waiting).toBeGreaterThanOrEqual(r.lost[r.lost.length - 1].waiting);
  });
  it('a draft competes only when asked; the edited script always competes', () => {
    const general = draftScript(editorStateFrom(null, { groups: ['trash'] }), { id: 'new' });
    general.sections = [{ id: 'opening', key: 'opening', text: 'x' }];
    const off = editorWins(general, LIB.scripts, { products: LIB.products });
    expect(off.wins).toBe(off.cells.length);
    const on = editorWins({ ...general, published_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' }, LIB.scripts, { products: LIB.products, includeDrafts: true });
    expect(on.loses).toBeGreaterThan(0); // the trash draft (newer) beats it once drafts compete
  });
});

describe('tester', () => {
  it('local match = the contract examples (21d + Prostatol → B; lead_new + Neurofix → F)', () => {
    expect(localMatch(LIB.scripts, 'd21', P.prostatol, LIB.products, false).best?.script.id).toBe(id(1));
    expect(localMatch(LIB.scripts, 'lead_new', P.neurofix, LIB.products, false).best?.script.id).toBe(id(5));
    expect(localMatch(LIB.scripts, 'trash', null, LIB.products, false).best).toBeNull();
    expect(localMatch(LIB.scripts, 'trash', null, LIB.products, true).best?.script.id).toBe(id(6));
  });
  it('a sample client becomes the variables (days since the purchase on the clock given)', () => {
    const v = sampleVars({ kind: 'member', customer_name: 'Петар Тестоски', customer_phone: null, list_id: 'l', list_name: '21d ≤26 (1-3 orders)', order_id: null, product_id: P.prostatol, product_name: 'Prostatol Complex', last_purchase_at: '2026-09-01T10:00:00Z', assigned: true }, { agentName: 'Ана', now: Date.parse('2026-10-02T10:00:00Z') });
    expect(v).toMatchObject({ customer_name: 'Петар Тестоски', agent_name: 'Ана', product: 'Prostatol Complex', last_product: 'Prostatol Complex', days_since_purchase: 31 });
    expect(sampleVars(null)).toBeNull();
  });
});
