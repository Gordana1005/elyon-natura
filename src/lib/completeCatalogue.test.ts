import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
// The pure rules behind scripts/complete-catalogue.mjs (owner 28.09.2026: every product that is or
// was sold must exist in the catalogue). Product names below are real catalogue / sales spellings;
// there is no customer data in this file.
import {
  signature, isBundle, coreOf, nonProductOf, displayName, planGroups, priceFor, samplesOf, activeTwinOf,
  windowStart, typicalPriceEur, buildApplySql, buildRollbackSql, lookAlikes, indexCatalogue, aliasSources,
} from '../../scripts/lib/complete-catalogue-mk.mjs';
import { stableUuid } from '../../scripts/lib/catalogue-match-mk.mjs';

const key = (name: string, src = 'crm') => signature(name, src).key;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const P = (name: string, extra: Record<string, unknown> = {}) => ({ id: uuid(), name, sku: `T-${n}`, is_active: true, price: 10, stock_quantity: 1000, low_stock_threshold: 5, ...extra });
type Line = { lkind: string; qty: number; val: number; d: string; bad_qty: boolean };
const line = (d: string, val = 1490, qty = 1, lkind = 'product'): Line => ({ lkind, qty, val, d, bad_qty: false });
const V = (src: string, name: string, lines: Line[], classification: Record<string, unknown> | null = null) =>
  ({ src, norm: name.trim().replace(/\s+/g, ' ').toLowerCase(), spellings: new Map([[name, lines.length]]), lines, classification });
const TODAY = '2026-09-28';

describe('the key — spellings of the SAME product meet', () => {
  it('Cyrillic, Latin and English spellings fold together', () => {
    expect(key('БОНЕ ПРОТЕКТ 30cps')).toBe(key('Bone Protect 30 cps'));
    expect(key('БРАИН ПРОТЕКТ 30crs')).toBe(key('Brain Protect 30 cps'));
    expect(key('МАШРОМ КОМПЛЕКС 0,5 Л')).toBe(key('Mushroom Complex 500 ml'));
    expect(key('ЦРВЕН ОРИЗ 30 cps.')).toBe(key('Red Yeast Rice 30 cps'));
    expect(key('Л-ГЛУТАМИН ВО ПРАВ 200ГР')).toBe(key('L-GLUTAMINE powder 200 gr.'));
    expect(key('100% WHEY PROTEIN-COKOLADO 1.5kg')).toBe(key('Whey Protein 1.5 kg с вкус на шоколад'));
    expect(key('I AM Антикни серум 30 мл')).toBe(key("I'AM Anti-Acne серум 30 ml"));
  });

  it('pack notations of one size are one size: 30cps = cps 30 = 30/1 = 30 caps = 30 таблети', () => {
    const k = key('Prostatol 30cps');
    for (const s of ['Prostatol cps 30', 'Prostatol 30/1', 'PROSTATOL 30 caps', 'Простатол 30 таблети', 'Prostatol (30)']) expect(key(s)).toBe(k);
  });

  it('a different pack size is a different product — never merged', () => {
    expect(key('Prostatol 30 cps')).not.toBe(key('Prostatol 60 caps'));
    expect(key('АЛОЕ РОЈАЛ 250 ml.')).not.toBe(key('АЛОЕ РОЈАЛ 0,5 Л'));
    expect(key('100% WHEY ЧОКОЛАДО 2.0gr')).toBe(key('100% WHEY ЧОКОЛАДО 2.0 КГ'));   // "2.0gr" is the 2 kg tub
    expect(key('100% WHEY ЧОКОЛАДО 2.0 КГ')).not.toBe(key('100 % whey протеин чоколадо 500gr'));
  });

  it('"2+1" / "1+1" sets are their own product; "30+30" is a 1+1 of the 30 pack', () => {
    expect(key('СНАИЛ КОМПЛЕКС 30 сет 2+1')).not.toBe(key('СНАИЛ КОМПЛЕКС cps 30'));
    expect(key('СНАИЛ КОМПЛЕКС 30 сет 2+1')).not.toBe(key('СНАИЛ КОМПЛЕКС сет 2+2'));
    expect(key('СНАИЛ КОМПЛЕКС 30 сет 2+1')).toBe(key('СНАИЛ КОМПЛЕКС 30/1 сет (2+1)'));
    expect(key('Brain Protect 30+30 Gratis', 'web')).toBe(key('Brain Protect 30 cps (1+1) GRATIS', 'web'));
    expect(key('Brain Protect (30+30cps)', 'web')).toBe(key('Brain Protect 30 cps (1+1)', 'web'));
    expect(isBundle(signature('OXI JET POWER 1+1'))).toBe(true);
    expect(isBundle(signature('OXI JET POWER'))).toBe(false);
  });

  it('a combo is order-insensitive, but "2x A + 2x B" ≠ "A + 2x B"', () => {
    expect(key('Гастро протект+Гастро Алое 2+2')).toBe(key('2+2 ГАСТРО АЛОЕ + ГАСТРО ПРОТЕКТ'));
    expect(key('2x Slim Complex + 2x Slim Fiber', 'web')).not.toBe(key('Slim complex + 2X Slim Fiber Set', 'web'));
    expect(key('2 КРЕАТИН + ГЛУТАМИН')).toBe(key('1 ГЛУТАМИН + 2 КРЕАТИН'));
  });

  it('notes riding on a name are cut: points, promo codes, vouchers, replacements', () => {
    const k = key('СПИРУЛИНА 100 tbl');
    for (const s of ['СПИРУЛИНА 100 tbl за код HA9Y4', 'СПИРУЛИНА 100 tbl со поени', 'СПИРУЛИНА 100 tbl ЗА КОД-2XLGK',
      'СПИРУЛИНА 100 tbl 1дна род.подарок.']) expect(key(s)).toBe(k);
    expect(key('МАЛ ГРИЛ ТОСТЕР ЗА ПОЕНИ ОД ЛОЈАЛТИ')).toBe(key('МАЛ ГРИЛ ТОСТЕР'));
    expect(key('КУЈИНСКА ВАГА користи поени')).toBe(key('КУЈИНСКА ВАГА'));
    expect(key('ТЕЛЕСНА ВАГАсо поени од прод,Струмица и од тука')).toBe(key('ТЕЛЕСНА ВАГА'));
    expect(key('БОНЕ ПРОТЕКТ 30cps (кор.вауч.500 ден)')).toBe(key('БОНЕ ПРОТЕКТ 30cps'));
    expect(key('РОЈАЛ ЖЕЛИ 30 cps замена за прополис')).toBe(key('РОЈАЛ ЖЕЛИ 30 cps'));
    expect(coreOf('ПРОПОЛИС КАПКИ 5% - 50 ml/МИНАТИОТ ПАТ НЕМАЛО НА ЗАЛИХА', 'crm')).toBe('propolis kapki 5% - 50 ml');
  });

  it('the web shop\'s descriptive tail is cut, its flavour is not', () => {
    const choc = '100% WHEY Protein (2+1) + подарок - со вкус на чоколадо';
    const van = '100% WHEY Protein (2+1) + подарок - со вкус на ванила';
    expect(key(choc, 'web')).not.toBe(key(van, 'web'));
    expect(key('Brain Protect (2+1) - суплемент за мемориja и концентрациja', 'web')).toBe(key('Brain Protect (2+1) Gratis', 'web'));
    expect(displayName(choc, 'web')).toBe('100% WHEY Protein (2+1) + подарок — со вкус на чоколадо');
    expect(displayName('ЦРВЕН ОРИЗ 30 cps. ЗА КОД JP9ST', 'crm')).toBe('ЦРВЕН ОРИЗ 30 cps.');
    expect(displayName('Gastro Protect &amp; Aloe - препарат за дигестивно здравје', 'web')).toBe('Gastro Protect & Aloe');
  });
});

describe('non-products are never catalogue products', () => {
  it('keeps the import script\'s kinds and adds scratch cards, loyalty cards, tests and services', () => {
    expect(nonProductOf('ЗАБЕЛЕШКА фали цинк')?.kind).toBe('note');
    expect(nonProductOf('ПОЕН')?.kind).toBe('loyalty_point');
    expect(nonProductOf('ДОСТАВА')?.kind).toBe('delivery');
    expect(nonProductOf('чашка/мерач')?.kind).toBe('gift');
    expect(nonProductOf('Adastra shaker / маталка')?.kind).toBe('gift');
    expect(nonProductOf('ГРЕПКА')).not.toBeNull();
    expect(nonProductOf('ЛОЈАЛИТИ КАРТИЧКА')).not.toBeNull();
    expect(nonProductOf('yoga fit online')).not.toBeNull();
    expect(nonProductOf('TPE Yoga Mat - Blue')).toBeNull();          // a mat is a product
    expect(nonProductOf('БОНЕ ПРОТЕКТ 30cps')).toBeNull();
  });
});

describe('planGroups — link / create / unsure / exclude', () => {
  const catalogue = [
    P('Bone Protect', { is_active: false, price: 0, stock_quantity: 0 }),
    P('Red Yeast Rice 30 cps', { is_active: false, price: 0, stock_quantity: 0 }),
    P('АЛОЕ РОЈАЛ 0,5 Л', { is_active: false }),
    P('СПИРУЛИНА КАПСУЛИ cps 60- (600мг)', { is_active: false }),
    P('100 % whey протеин ванила 500gr'), P('100 % whey протеин чоколадо 500gr'),
    P('Oxy Jet Power', { is_active: false }),
    P('Vitamin B6'), P('ВИТАМИН B6 60tbl'),
  ];
  const d = '2026-09-20';
  const old = '2024-05-10';
  const vs = [
    V('crm', 'БОНЕ ПРОТЕКТ 30cps', [line(old, 550), line(old, 600)]),
    V('collabbox', 'БОНЕ ПРОТЕКТ 30cps', [line(old, 600)]),
    V('crm', 'ЦРВЕН ОРИЗ 30 cps.', [line(d, 250), line(old, 250)]),
    V('crm', 'ЦРВЕН ОРИЗ 30 cps. за код 7NLE3', [line(old, 0, 1, 'gift')]),
    V('crm', 'АЛОЕ РОЈАЛ 250 ml.', [line(old, 225)]),
    V('crm', 'СПИРУЛИНА 100 tbl', [line(old, 175), line(old, 175), line(old, 180)]),
    V('web', 'Spirulina', [line(old, 400)]),
    V('web', '100% WHEY Protein 500 г — суруткин протеин за мускули и опоравување', [line(d, 1500)]),
    V('crm', 'OXI JET POWER', [line(old, 1490)]),
    V('crm', 'OXI JET POWER 1+1', [line(d, 1000), line(d, 1000), line(d, 1100)]),
    V('web', 'Vitamin B6 — за енергија, метаболизам и нервен систем', [line(d, 775)]),
    V('crm', 'ПИКНИК ФРИЖИДЕР', [line(old, 0, 1, 'gift')]),
    V('crm', 'БРАИН ПРОТЕКТ 30crs-сет2+1', [line(old, 1830)]),
    V('web', 'Brain Protect (2+1) Gratis', [line(old, 1990), line(old, 1990)]),
    V('crm', 'ГРЕПКА', [line(old, 30)]),
  ];
  const { groups } = planGroups(vs, catalogue, { today: TODAY, pickAmong: (ps: any[]) => ps[0] });
  const find = (spelling: string) => groups.find((g: any) => g.variants.some((v: any) => v.top === spelling))!;

  it('links a Cyrillic spelling to the pack-less row the web shop\'s name created (every variant of it)', () => {
    const g = find('БОНЕ ПРОТЕКТ 30cps');
    expect(g.decision).toBe('link');
    expect(g.target.name).toBe('Bone Protect');
    expect(g.variants.map((v: any) => v.src).sort()).toEqual(['collabbox', 'crm']);
  });

  it('links across languages and keeps the note-carrying spelling in the same group', () => {
    const g = find('ЦРВЕН ОРИЗ 30 cps.');
    expect(g.decision).toBe('link');
    expect(g.target.name).toBe('Red Yeast Rice 30 cps');
    expect(g.variants).toHaveLength(2);
    expect(g.soldRecently).toBe(true);
  });

  it('creates a product for a pack size the catalogue does not have', () => {
    expect(find('АЛОЕ РОЈАЛ 250 ml.').decision).toBe('create');
    expect(find('СПИРУЛИНА 100 tbl').decision).toBe('create');
  });

  it('is unsure when a pack or a flavour is not stated and several exist', () => {
    expect(find('Spirulina').decision).toBe('unsure');
    expect(find('100% WHEY Protein 500 г — суруткин протеин за мускули и опоравување').decision).toBe('unsure');
    expect(find('Vitamin B6 — за енергија, метаболизам и нервен систем').decision).toBe('unsure');
  });

  it('a set of an existing product is its own new product; the single links', () => {
    expect(find('OXI JET POWER').decision).toBe('link');
    const set = find('OXI JET POWER 1+1');
    expect(set.decision).toBe('create');
    expect(set.bundle).toBe(true);
    expect(set.name).toBe('OXI JET POWER 1+1');
    expect(set.price).toEqual({ eur: 16.26, n: 3, basis: 'last90' });
  });

  it('a pack-less web set joins the one sized set of the same product', () => {
    const g = find('БРАИН ПРОТЕКТ 30crs-сет2+1');
    expect(g.decision).toBe('create');
    expect(g.variants.map((v: any) => v.top).sort()).toEqual(['Brain Protect (2+1) Gratis', 'БРАИН ПРОТЕКТ 30crs-сет2+1']);
    expect(g.name).toBe('Brain Protect (2+1) Gratis');       // the most frequent spelling
  });

  it('excludes what was never sold for money, and non-products', () => {
    expect(find('ПИКНИК ФРИЖИДЕР').decision).toBe('exclude');
    expect(find('ГРЕПКА').decision).toBe('exclude');
  });

  it('flags a name one word away from a catalogue row instead of creating a duplicate', () => {
    const idx = indexCatalogue([P('ELIXY Honey — крема со мед и шеа путер')]);
    expect(lookAlikes(signature('ELIXY -крем за лице HONEY 100 мл'), idx)).toHaveLength(1);
    expect(lookAlikes(signature('АЛОЕ СОК со вкус на лимон 500 ml'), indexCatalogue([P('АЛОЕ СОК со вкус на портокал 500 ml')]))).toHaveLength(0);
  });

  it('two groups with the same visible name become one product', () => {
    const { groups: gs } = planGroups([
      V('crm', 'ФЕН ЗА КОСА', [line(old, 100)]),
      V('crm', 'ФЕН ЗА КОСА со лојални поени', [line(old, 100)]),
    ], [], { today: TODAY });
    expect(gs.filter((g: any) => g.decision === 'create')).toHaveLength(1);
  });
});

describe('prices, twins, windows, ids', () => {
  it('typical price = median денари per unit of the last 90 days ÷ 61,5 (2 decimals)', () => {
    expect(typicalPriceEur([1490, 1490, 2990])).toBe(24.23);
    // 2.980 ден for 2 units = 1.490 per unit; the 2025 line is outside the 90 days
    const s = samplesOf([line('2026-09-01', 2990), line('2026-08-01', 2980, 2), line('2026-07-15', 1490), line('2025-01-01', 9999)]);
    expect(priceFor(s, { today: TODAY })).toEqual({ eur: 24.23, n: 3, basis: 'last90' });
  });

  it('fewer than 3 priced lines in 90 days → the 20 most recent priced lines', () => {
    const s = samplesOf([line('2026-09-01', 100), ...Array.from({ length: 25 }, (_, i) => line(`2025-0${1 + (i % 9)}-10`, 250))]);
    expect(priceFor(s, { today: TODAY })).toEqual({ eur: 4.07, n: 20, basis: 'recent20' });
    expect(priceFor([], { today: TODAY })).toEqual({ eur: null, n: 0, basis: 'none' });
    expect(samplesOf([line('2026-09-01', 0, 1, 'gift'), { ...line('2026-09-01', 50, 40), bad_qty: true }])).toEqual([]);
  });

  it('"the last 60 days" is today and the 59 before it', () => {
    expect(windowStart(TODAY, 60)).toBe('2026-07-31');
    expect(windowStart(TODAY, 90)).toBe('2026-07-01');
  });

  it('an inactive row with an ACTIVE twin is not activated; a pack-less row among several packs is no twin', () => {
    const creatine = P('CREATINE powder 200 gr.');
    const kreatin = P('КРЕАТИН ВО ПРАВ 200ГР', { is_active: false });
    const d3 = [P('Vitamin D3'), P('VITAMIN D3 120/1 tab'), P('ВИТАМИН Д3 180 tbl')];
    const d360 = P('ВИТАМИН Д3 60 tbl', { is_active: false });
    const cat = [creatine, kreatin, ...d3, d360];
    expect(activeTwinOf(kreatin, cat)?.id).toBe(creatine.id);
    expect(activeTwinOf(d360, cat)).toBeNull();
  });

  it('aliases are source "any" (they survive the department reclass) unless the spelling already has a row', () => {
    expect(aliasSources(['crm'])).toEqual(['any']);
    expect(aliasSources(['collabbox', 'crm'])).toEqual(['any']);
    expect(aliasSources(['web', 'crm', 'crm'], true)).toEqual(['crm', 'web']);
  });

  it('a new product\'s id is a pure function of its group key (a re-run never duplicates)', () => {
    const k = signature('СНАИЛ КОМПЛЕКС 30 сет 2+1').key;
    expect(stableUuid(`complete-catalogue:${k}`, createHash)).toBe(stableUuid(`complete-catalogue:${signature('СНАИЛ КОМПЛЕКС 30/1 сет (2+1)').key}`, createHash));
  });
});

describe('the apply / rollback SQL', () => {
  const act = { id: uuid(), mode: 'activate', price_text: '0', before: { is_active: false, price: 0, stock: 0, threshold: 5 }, after: { is_active: true, price: 24.23, stock: 1000, threshold: 5 } };
  const prod = { id: uuid(), name: "O'Brien — тест", description: 'run R', price: 16.26, is_active: true, stock: 1000, threshold: 5, category: 'Од продажби — collabBox/web (28.09.2026)' };
  const sql = buildApplySql({ key: 'complete-catalogue', runId: 'R', hash: 'h', products: [prod], activations: [act],
    aliases: [{ source: 'any', alias_norm: 'x', product_id: prod.id, note: 'AUTO complete-catalogue 28.09 — чека одобрување · run R' }],
    actorId: uuid(), actorEmail: 'mile@elyon.com', runSummary: {}, auditPayload: {}, invNote: 'run R' });

  it('locks, then guards, then writes — never FOR UPDATE inside the snapshot CTE (it drops rows)', () => {
    expect(sql.indexOf('FOR UPDATE')).toBeLessThan(sql.indexOf('RAISE EXCEPTION'));
    expect(sql).not.toMatch(/stock_old\s+FROM public\.products p JOIN plan ON plan\.id = p\.id\s+FOR UPDATE/);
    expect(sql).toContain("O''Brien");                                    // quoted
    expect(sql).toMatch(/INSERT INTO public\.inventory_logs[\s\S]*'manual', 'manual_adjust'/);
    expect(sql).toMatch(/SELECT \(SELECT count\(\*\) FROM public\.products WHERE description LIKE '%run R%'\)/);
  });

  it('the rollback parks the low-stock threshold so no bell rings, and never cascades away stock history', () => {
    const rb = buildRollbackSql({ key: 'complete-catalogue', runId: 'R', before: [act], actorId: uuid(), actorEmail: 'mile@elyon.com', auditPayload: {}, invNote: 'ROLLBACK run R' });
    expect(rb.indexOf('low_stock_threshold = -1')).toBeLessThan(rb.indexOf('stock_quantity = CASE'));
    expect(rb).toMatch(/SET low_stock_threshold = plan\.thr_before[\s\S]*low_stock_threshold = -1;/);
    for (const t of ['order_items', 'stock_count_lines', 'stock_mex_ledger_lines', 'prediction_lead_items']) expect(rb).toContain(`public.${t} r WHERE r.product_id = p.id`);
  });
});
