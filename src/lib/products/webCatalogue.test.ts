import { describe, expect, it } from 'vitest';
// The pure half of scripts/map-web-catalogue.mjs (owner 01.10.2026: the brand lines from the official
// web shop). Product names are real web / catalogue spellings; no customer data.
import {
  applyPlan, basesOf, bioAnchorOf, buildWebCatalogue, flightText, gridProducts, pageCards, pageProductId, productLd,
  proposeLines, sitemapLocs, slugOf, webEvidence, indexWeb,
} from '../../../scripts/lib/web-catalogue-mk.mjs';

const flight = (obj: unknown) => `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(obj))}])</script>`;

describe('reading the public pages', () => {
  it('sitemaps, slugs, cards, the flight payload and JSON-LD', () => {
    expect(sitemapLocs('<urlset><url><loc>https://naturatherapy.mk/diet-shake</loc></url><url><loc> https://naturatherapy.mk/zinc </loc></url></urlset>'))
      .toEqual(['https://naturatherapy.mk/diet-shake', 'https://naturatherapy.mk/zinc']);
    expect(slugOf('https://naturatherapy.mk/collagen-peptides/')).toBe('collagen-peptides');
    expect(pageCards('<a class="x" href="/2x-creatine-bcaa-zinc"><div class="y"><img alt="2x Creatine + BCAA + Zinc 120" src="a"></div></a>'))
      .toEqual([{ slug: '2x-creatine-bcaa-zinc', name: '2x Creatine + BCAA + Zinc 120' }]);
    const html = flight({ grid: [{ product_id: 1150, name: 'COLLAGEN PEPTIDES 400 г — колаген', price: 1490, manufacturer: 'AdAstra', slug: 'collagen-peptides',
      packOffers: [{ bundleId: 115, slug: 'collagen-peptides-2-1', label: '2+1' }] }], product: { product_id: 1148, name: 'x' } });
    const f = flightText(html);
    expect(gridProducts(f)).toEqual([{ productId: 1150, name: 'COLLAGEN PEPTIDES 400 г — колаген', slug: 'collagen-peptides', manufacturer: 'AdAstra', price: 1490,
      packOffers: [{ bundleId: 115, slug: 'collagen-peptides-2-1', label: '2+1' }] }]);
    expect(pageProductId(flightText(flight({ product: { product_id: 1148, name: 'x' } })))).toBe(1148);
    expect(productLd('<script type="application/ld+json">{"@type":"Product","name":"Diet Shake","sku":"NT-1109","brand":{"name":"NaturaTherapy"},"offers":{"price":"990.00"}}</script>'))
      .toEqual({ name: 'Diet Shake', sku: 'NT-1109', price: '990.00', brand: 'NaturaTherapy' });
  });

  it('Ad Astra = what /adastra-nutrition shows (its grid and its pack offers)', () => {
    const pages = new Map([
      ['adastra-nutrition', { cards: [], grid: [{ productId: 1109, name: 'Diet Shake', slug: 'diet-shake', manufacturer: null, price: 990,
        packOffers: [{ bundleId: 70, slug: 'diet-shake-1-1', label: '1+1' }] }] }],
      ['imunitet', { cards: [{ slug: 'zinc', name: 'Zinc — 120 таблети' }], grid: [] }],
    ]);
    const web = buildWebCatalogue({ productSlugs: ['diet-shake', 'zinc'], bundleSlugs: ['diet-shake-1-1'], pages });
    expect(web.map((w: { slug: string; adAstra: boolean }) => [w.slug, w.adAstra])).toEqual([['diet-shake', true], ['zinc', false], ['diet-shake-1-1', true]]);
  });
});

describe('matching web names to CRM names (Latin ⇄ Cyrillic, sizes, flavours)', () => {
  it('the same base product across spellings', () => {
    expect(basesOf('COLLAGEN PEPTIDES 400 г — колаген за кожа, зглобови и коски', { web: true })).toEqual(basesOf('Колаген Пептид со ВАНИЛА 200 гр'));
    expect(basesOf('Snail Complex — за зглобови', { web: true })).toEqual(basesOf('СНАИЛ КОМПЛЕКС cps 30'));
    expect(basesOf('Diet Shake — заменски оброк', { web: true })).toEqual(basesOf('ДИЕТ ШЕЈК Јагода 500g'));
    expect(basesOf('Magnesium Citrat — магнезиум за мускули', { web: true })).toEqual(basesOf('MAGNESIUM CITRAT 325mg'));
    // a flavour word is not another product ("хлорофил"), the gummies are not the extract
    expect(basesOf('Nutri Soup — зеленчук и хлорофил')).toEqual(['nutriSoup']);
    expect(basesOf('Ashwagandha — гумени бонбони (30)')).not.toEqual(basesOf('АШВАГАНДА ЕКСТРАКТ 60/1 cps'));
    // a bundle names its parts in name order
    expect(basesOf('2x Diet Shake + Slim Complex')).toEqual(['dietShake', 'slimComplex']);
  });
  it('the Bio Natural anchors (the 12 folder products + BIONATURAL)', () => {
    expect(bioAnchorOf('NEUROFIX BIONATURAL 30/1')).toBe('neurofix');
    expect(bioAnchorOf('Slim Fit')).toBe('slimfit');
    expect(bioAnchorOf('D3 180/1 tab BIONATURAL')).toBe('bionatural');
    expect(bioAnchorOf('SLIM Complex')).toBeNull();
  });
});

describe('the line proposal', () => {
  const WEB = [
    { slug: 'diet-shake', type: 'product', name: 'Diet Shake — заменски оброк', productId: 1109, adAstra: true },
    { slug: 'slim-complex', type: 'product', name: 'SLIM Complex — за слабеење', productId: 1211, adAstra: false },
    { slug: 'snail-complex', type: 'product', name: 'Snail Complex', productId: 1041, adAstra: false },
    { slug: 'alpha-male', type: 'product', name: 'Alpha Male — за мажи', productId: 1100, adAstra: false },
    { slug: 'tongkat-ali', type: 'product', name: 'Tongkat Ali', productId: 1248, adAstra: false },
  ].map((w) => ({ manufacturer: null, categories: [], ...w }));
  const C = (id: string, name: string, o: Record<string, unknown> = {}) => ({ id, name, sku: null, is_active: true, brand_line: null, bio: 0, nat: 0, bio_recent: 0, nat_recent: 0, ...o });
  const crm = [
    C('a', 'ДИЕТ ШЕЈК Ванила 500g'),
    C('b', 'СНАИЛ КОМПЛЕКС cps 30', { brand_line: 'bio_natural' }),
    C('c', 'Neurofix', { bio: 2500, nat: 20 }),
    C('d', 'ALPHA MALE 60 cps', { bio: 21, nat: 306 }),
    C('e', 'Alpha Male', { bio: 5000, nat: 30 }),
    C('f', 'TONGAKT ALI 60/1', { brand_line: 'ad_astra' }),
    C('g', 'GlucoCare', { bio: 11, bio_recent: 11 }),
    C('h', 'Магнезиум гел 250мл', { bio: 17, nat: 7, bio_recent: 17 }),
    C('i', 'MAGNESIUM GEL 50ml', { bio: 41, nat: 2901 }),
    C('j', 'AURA Маскара за веѓи DARK BROWN'),
    C('k', '2x Diet Shake + Slim Complex'),
  ];
  const rows = proposeLines({ crm, web: WEB, webSales: new Map([['j', new Map([[900, 6]])]]) });
  const by = (id: string) => rows.find((r: { id: string }) => r.id === id);

  it('today\'s web: Ad Astra page → Ad Astra, the rest → Natura Therapy', () => {
    expect(by('a')).toMatchObject({ proposed: 'ad_astra', source: 'web', how: 'base', change: 'new' });
    expect(webEvidence('Snail Complex', indexWeb(WEB))).toMatchObject({ line: 'natura_therapy', how: 'exact' });
  });
  it('a set line the web contradicts is overwritten (and reported); an owner\'s Ad Astra tag is kept', () => {
    expect(by('b')).toMatchObject({ current: 'bio_natural', proposed: 'natura_therapy', change: 'overwrite' });
    expect(by('f')).toMatchObject({ current: 'ad_astra', proposed: 'natura_therapy', change: 'keep' });
  });
  it('anchors are Bio Natural — unless a namesake the web sells and NATURA ships', () => {
    expect(by('c')).toMatchObject({ proposed: 'bio_natural', source: 'anchor' });
    expect(by('d')).toMatchObject({ proposed: 'natura_therapy', note: 'anchor_namesake' });
    expect(by('e')).toMatchObject({ proposed: 'bio_natural', source: 'anchor' });
  });
  it('not on the web: BIO NATURAL parcels of the last months → Bio Natural, unless its family ships via NATURA', () => {
    expect(by('g')).toMatchObject({ proposed: 'bio_natural', source: 'parcels_bio_recent' });
    expect(by('h')).toMatchObject({ proposed: 'natura_therapy', source: 'family' });
    expect(by('i')).toMatchObject({ proposed: 'natura_therapy', source: 'parcels_natura' });
  });
  it('sold on the old web shop → Natura Therapy (the web never sold Bio Natural)', () => {
    expect(by('j')).toMatchObject({ proposed: 'natura_therapy', source: 'web_history' });
  });
  it('a bundle of two lines takes its main (first) part', () => {
    expect(by('k')).toMatchObject({ proposed: 'ad_astra', how: 'parts_main' });
  });
  it('--apply writes the new rows and the overwrites only', () => {
    const plan = applyPlan(rows);
    const ids = plan.flatMap((c: { ids: string[] }) => c.ids);
    expect(ids).toContain('b');
    expect(ids).not.toContain('f');
    expect(applyPlan(rows, { allowOverwrite: false }).flatMap((c: { ids: string[] }) => c.ids)).not.toContain('b');
  });
});
