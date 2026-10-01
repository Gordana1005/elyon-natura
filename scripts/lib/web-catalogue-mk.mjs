/**
 * web-catalogue-mk — the PUBLIC naturatherapy.mk catalogue and which CRM product each item is
 * (owner 01.10.2026, "Производи 2.0", point 2 — the brand lines).
 *
 * Owner rulings (01.10.2026):
 *   • every product on the official web shop is Natura Therapy or Ad Astra; Bio Natural products
 *     NEVER appear on the official web;
 *   • Ad Astra = the products on https://naturatherapy.mk/adastra-nutrition (already tagged by the
 *     owner — never taken away here);
 *   • the rest of the web catalogue is Natura Therapy;
 *   • a product that is not on the web: the MEX parcel history decides (NATURA → Natura Therapy;
 *     sold via BIO NATURAL in the last ~4 months → Bio Natural);
 *   • Bio Natural = the 12 anchor products (`bionatural products/` folder) + BIONATURAL in the name.
 *
 * PURE: no I/O. scripts/map-web-catalogue.mjs fetches the pages (politely, cached) and the CRM rows
 * and calls these. The shop itself is never written to — only its public pages are read (the
 * live-shop no-change rule).
 *
 * Matching (web item ↔ CRM product) happens on the BASE product: the curated lexicon of
 * scripts/lib/catalogue-match-mk.mjs (built on 28.09 from every web and collabBox spelling) maps
 * "COLLAGEN PEPTIDES 400 г — колаген…" and "Колаген Пептид со ВАНИЛА 200 гр" to the same base
 * `collagenPeptides`. A line belongs to the brand product, not to a size or flavour, so every CRM
 * row of a base gets that base's web line. Names the lexicon does not know fall back to the
 * order-insensitive exact key (Cyrillic ⇄ Latin, units glued).
 */
import { LEXICON, exactKey, fold, headOf } from './catalogue-match-mk.mjs';

export const LINES = ['natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker'];
export const AD_ASTRA_CATEGORY = 'adastra-nutrition';

// ─── the Bio Natural anchors (the `bionatural products/` folder + BIONATURAL in the name) ───
/** Squashed (lower case, no spaces / dots / dashes) — the same list as SQL product_brand_line_proposal(). */
export const BIO_ANCHOR_RE = /(bionatural|бионатурал|adenofrin|аденофрин|alphamale|алфамејл|алфамале|arthrofix|артрофикс|brainfix|браинфикс|cardiofix|кардиофикс|glucofix|глукофикс|hemorofix|хеморофикс|liverfix|ливерфикс|neurofix|неурофикс|parafix|парафикс|prostafix|простафикс|slimfit|слимфит)/;
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[\s._-]+/g, '');
export const bioAnchorOf = (name) => squash(name).match(BIO_ANCHOR_RE)?.[1] ?? null;

// ─── HTML / sitemap parsing ───────────────────────────────────────────────────
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'", '#039': "'" };
export const decodeHtml = (s) => String(s ?? '')
  .replace(/&(amp|quot|apos|lt|gt|nbsp|#39|#039);/g, (_, e) => ENTITIES[e])
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** <loc> URLs of a sitemap (or sitemap index). */
export const sitemapLocs = (xml) => [...String(xml ?? '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decodeHtml(m[1]));

/** "https://naturatherapy.mk/diet-shake" → "diet-shake" (no leading / trailing slash, no query). */
export function slugOf(url) {
  try { return new URL(url).pathname.replace(/^\/+|\/+$/g, ''); } catch { return String(url ?? '').replace(/^\/+|\/+$/g, ''); }
}

/**
 * The product / bundle CARDS rendered on a page: an <a href="/slug"> whose first image's alt is the
 * item's name. Returns [{slug, name}] in page order, de-duplicated by slug.
 */
export function pageCards(html) {
  const out = new Map();
  const re = /<a\b[^>]*\bhref="\/([a-z0-9][a-z0-9-]*)"[^>]*>\s*<div\b[^>]*>\s*<img\b[^>]*\balt="([^"]*)"/g;
  for (const m of String(html ?? '').matchAll(re)) {
    const slug = m[1];
    const name = decodeHtml(m[2]).replace(/\s+/g, ' ').trim();
    if (name && !out.has(slug)) out.set(slug, { slug, name });
  }
  return [...out.values()];
}

/** The Next.js flight payload of a page: every `self.__next_f.push([1,"…"])` string, decoded and joined. */
export function flightText(html) {
  const parts = [];
  for (const m of String(html ?? '').matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { parts.push(JSON.parse(m[1])); } catch { /* a fragment we cannot read — skip it */ }
  }
  return parts.join('');
}

/** The JSON object that starts at `start` (a "{"), string-aware brace matching; null if unbalanced. */
function objectAt(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * Product grid entries in a flight payload: {"product_id":N,"name":…,"slug":…,"manufacturer":…,
 * "packOffers":[{bundleId, slug, label}]}. Returns [{productId, name, slug, manufacturer, price, packOffers}].
 */
export function gridProducts(flight) {
  const out = new Map();
  const text = String(flight ?? '');
  let at = text.indexOf('{"product_id":');
  while (at !== -1) {
    const raw = objectAt(text, at);
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (o && o.product_id != null && o.slug && !out.has(o.slug)) {
          out.set(o.slug, {
            productId: Number(o.product_id),
            name: String(o.name ?? '').trim(),
            slug: String(o.slug),
            manufacturer: o.manufacturer ? String(o.manufacturer) : null,
            price: o.price == null ? null : Number(o.price),
            packOffers: (Array.isArray(o.packOffers) ? o.packOffers : [])
              .filter((p) => p && p.slug)
              .map((p) => ({ bundleId: p.bundleId == null ? null : Number(p.bundleId), slug: String(p.slug), label: p.label ? String(p.label) : null })),
          });
        }
      } catch { /* not a complete object — skip */ }
    }
    at = text.indexOf('{"product_id":', at + 14);
  }
  return [...out.values()];
}

/** The page's own product id ("product":{"product_id":N…) from its flight payload, or null. */
export function pageProductId(flight) {
  const m = String(flight ?? '').match(/"product":\{"product_id":(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The schema.org Product of a page: {name, sku, price, brand} or null. */
export function productLd(html) {
  for (const m of String(html ?? '').matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j;
    try { j = JSON.parse(m[1]); } catch { continue; }
    if (!/Product/.test(String(j?.['@type'] ?? ''))) continue;
    const offers = Array.isArray(j.offers) ? j.offers[0] : j.offers;
    return {
      name: String(j.name ?? '').trim(),
      sku: j.sku == null ? null : String(j.sku),
      price: offers?.price ?? offers?.lowPrice ?? null,
      brand: typeof j.brand === 'object' ? j.brand?.name ?? null : j.brand ?? null,
    };
  }
  return null;
}

// ─── the web catalogue model ─────────────────────────────────────────────────
/**
 * Build the catalogue from what the pages said.
 * @param productSlugs  slugs of sitemaps/products.xml
 * @param bundleSlugs   slugs of sitemaps/bundles.xml
 * @param pages         Map<slug, {cards, grid, ld, productId}> — every page that was read (categories,
 *                      products, bundles)
 * @returns [{slug, type: product|bundle, name, productId, manufacturer, adAstra, categories[]}]
 */
export function buildWebCatalogue({ productSlugs, bundleSlugs, pages }) {
  const items = new Map();
  const add = (slug, type) => { if (!items.has(slug)) items.set(slug, { slug, type, name: null, productId: null, manufacturer: null, adAstra: false, categories: [] }); };
  for (const s of productSlugs) add(s, 'product');
  for (const s of bundleSlugs) add(s, 'bundle');
  for (const [pageSlug, p] of pages) {
    const isCategory = !items.has(pageSlug);
    for (const c of p.cards ?? []) {
      const it = items.get(c.slug);
      if (!it) continue;
      it.name ??= c.name;
      if (isCategory && !it.categories.includes(pageSlug)) it.categories.push(pageSlug);
    }
    for (const g of p.grid ?? []) {
      const it = items.get(g.slug);
      if (!it) continue;
      it.productId ??= g.productId;
      if (g.manufacturer) it.manufacturer ??= g.manufacturer;
      if (!it.name) it.name = g.name;
      if (isCategory && !it.categories.includes(pageSlug)) it.categories.push(pageSlug);
      // a pack offer shown on a category page belongs to that category too
      if (isCategory) {
        for (const po of g.packOffers) {
          const b = items.get(po.slug);
          if (b && !b.categories.includes(pageSlug)) b.categories.push(pageSlug);
        }
      }
    }
    if (!isCategory) {
      const it = items.get(pageSlug);
      if (p.ld?.name) it.name = p.ld.name;   // the page's own name wins over a card's alt
      if (p.productId != null) it.productId ??= p.productId;
    }
  }
  for (const it of items.values()) {
    it.adAstra = it.categories.includes(AD_ASTRA_CATEGORY) || /^adastra/i.test(String(it.manufacturer ?? '').replace(/\s+/g, ''));
  }
  return [...items.values()];
}

/** The line the web says for an item: Ad Astra (on /adastra-nutrition) or Natura Therapy (the rest). */
export const webLineOf = (item) => (item.adAstra ? 'ad_astra' : 'natura_therapy');

// ─── the base products a name mentions (the lexicon of catalogue-match-mk) ─────
/**
 * Lexicon entries that name the same catalogue product (their default pick is one SKU, e.g.
 * `hyaluronMatrix` and `hyaluron5` → 005033) are one base: entry id → the first such entry's id.
 */
export const BASE_OF_ENTRY = (() => {
  const bySku = new Map();
  const out = new Map();
  for (const e of LEXICON) {
    let sku = null;
    try { sku = e.pick(''); } catch { sku = null; }
    const k = sku == null ? null : String(sku);
    if (k && bySku.has(k)) out.set(e.id, bySku.get(k));
    else { if (k) bySku.set(k, e.id); out.set(e.id, e.id); }
  }
  return out;
})();

function mentionedBases(text) {
  let h = ` ${text} `;
  const found = new Map();   // base → first position in the name
  for (const entry of LEXICON) {
    if (entry.accessory) continue;
    const re = new RegExp(entry.re.source, 'g');
    let m;
    while ((m = re.exec(h)) !== null) {
      const base = BASE_OF_ENTRY.get(entry.id) ?? entry.id;
      if (!found.has(base) || found.get(base) > m.index) found.set(base, m.index);
      h = h.slice(0, m.index) + ' '.repeat(m[0].length) + h.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  }
  // in NAME order: the first one is the bundle's main product
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([base]) => base);
}

/**
 * Every lexicon BASE a name mentions, in name order (matched text masked so a base is not found
 * twice), accessories (shaker, roller …) left out: ["collagenPeptides"], or ["dietShake",
 * "slimComplex"] for a bundle, or [] when the lexicon does not know the name.
 *   web: true   a web-shop name — its descriptive tail ("— заменски оброк …") is cut first (the
 *               full name only when the head names nothing);
 *   web: false  a CRM name — read whole ("Ashwagandha — гумени бонбони (30)" is the gummies); when
 *               the whole name is ambiguous but its head names ONE base, the head wins ("Nutri Soup
 *               — зеленчук и хлорофил" is the soup, the flavour is not the chlorophyll product).
 */
export function basesOf(name, { web = false } = {}) {
  if (web) {
    const head = mentionedBases(headOf(name));
    return head.length ? head : mentionedBases(fold(name));
  }
  const full = mentionedBases(fold(name));
  if (full.length <= 1) return full;
  const head = mentionedBases(headOf(name));
  return head.length === 1 ? head : full;
}

/** The web item's name without the shop's descriptive tail ("Diet Shake — заменски оброк …" → "diet shake"). */
export const webCore = (name) => headOf(name);

// ─── the proposal ────────────────────────────────────────────────────────────
/**
 * Index the web PRODUCTS (not bundles) by base and by exact key → the line each implies.
 * A key found on both an Ad Astra and a Natura Therapy product is `mixed` (never used on its own).
 */
export function indexWeb(web) {
  const byBase = new Map();
  const byExact = new Map();
  const put = (map, key, item) => {
    if (!key) return;
    const cur = map.get(key) ?? { lines: new Set(), items: [] };
    cur.lines.add(webLineOf(item));
    if (!cur.items.includes(item)) cur.items.push(item);
    map.set(key, cur);
  };
  for (const it of web) {
    if (it.type !== 'product' || !it.name) continue;
    const bases = basesOf(it.name, { web: true });
    if (bases.length === 1) put(byBase, bases[0], it);
    put(byExact, exactKey(webCore(it.name)), it);
    put(byExact, exactKey(it.name), it);
  }
  return { byBase, byExact };
}

const oneLine = (hit) => (hit && hit.lines.size === 1 ? [...hit.lines][0] : null);
const slugs = (hits) => [...new Set(hits.flatMap((h) => h.items.map((i) => i.slug)))];

/**
 * Where TODAY's web puts one CRM product, or null when it is not on the web:
 *   {line, how: 'exact'}      the same name as a web product (Cyrillic ⇄ Latin, units glued, any order)
 *   {line, how: 'base'}       the same base product (another size / flavour / spelling)
 *   {line, how: 'parts'}      a bundle whose every part is on the web with ONE line
 *   {line, how: 'parts_main'} a bundle whose parts are on the web with BOTH lines → its first
 *                             (main) part's line (Ad Astra and Natura Therapy both ship via NATURA)
 *   {partial: true}           a bundle with a part the web does not sell (it could be Bio Natural)
 *   {mixed: true}             the web evidence names both lines for one product
 */
export function webEvidence(crmName, idx) {
  const exact = idx.byExact.get(exactKey(crmName));
  if (exact) {
    const line = oneLine(exact);
    return line ? { line, how: 'exact', web: slugs([exact]) } : { mixed: true, how: 'exact', web: slugs([exact]) };
  }
  const bases = basesOf(crmName);
  if (bases.length === 1) {
    const hit = idx.byBase.get(bases[0]);
    if (!hit) return null;
    const line = oneLine(hit);
    return line ? { line, how: 'base', base: bases[0], web: slugs([hit]) } : { mixed: true, how: 'base', base: bases[0], web: slugs([hit]) };
  }
  if (bases.length > 1) {
    const hits = bases.map((b) => idx.byBase.get(b));
    const known = hits.filter(Boolean);
    if (!known.length) return null;
    const web = slugs(known);
    if (known.length < bases.length) return { partial: true, how: 'parts', bases, web };
    const lines = new Set(known.flatMap((h) => [...h.lines]));
    if (lines.size === 1) return { line: [...lines][0], how: 'parts', bases, web };
    const main = oneLine(hits[0]);
    return main ? { line: main, how: 'parts_main', bases, web } : { mixed: true, how: 'parts', bases, web };
  }
  return null;
}

/** The single base of a CRM name, or null (unknown to the lexicon, or a bundle of several). */
const singleBase = (name) => { const b = basesOf(name); return b.length === 1 ? b[0] : null; };

/**
 * The line proposal for every CRM product.
 * @param crm       [{id, name, sku, is_active, brand_line, bio, nat, bio_recent, nat_recent}]
 *                  bio / nat = its MEX parcels all time per account; *_recent = the last ~4 months
 * @param web       buildWebCatalogue() output (today's public catalogue)
 * @param webSales  Map<crm product id, Map<shop product id, order lines> | number> — the shop's own
 *                  order history (the CRM mirror web_order_items → product_aliases). The web never
 *                  sold a Bio Natural product; lines of a shop product that is on /adastra-nutrition
 *                  today count for Ad Astra, the rest (and a bare number) for Natura Therapy.
 * @returns [{id, name, sku, active, current, proposed, source, how, web, webSales, anchor, change, note}]
 *   source  anchor | web | web_history | family | parcels_bio_recent | parcels_natura | none
 *   change  new       undecided → the proposed line
 *           same      already on it
 *           overwrite TODAY's web (same name or same base) says otherwise — reported, applied
 *           keep      a set line the rules never overwrite (an owner's Ad Astra / Dr.Becker tag, or a
 *                     proposal that is not today's web) — reported when it differs
 *           none      no proposal
 *   note    anchor_namesake · web_mixed · web_partial · parcels_mixed · few_parcels
 */
export function proposeLines({ crm, web, webSales = new Map(), natShare = 0.9, familyMin = 20 }) {
  const idx = indexWeb(web);
  const aaShop = new Set(web.filter((w) => w.adAstra && w.productId != null).map((w) => Number(w.productId)));
  const salesOf = (id) => {
    const v = webSales.get(id);
    if (v == null) return { lines: 0, aa: 0 };
    if (typeof v === 'number') return { lines: v, aa: 0 };
    let lines = 0;
    let aa = 0;
    for (const [shopId, n] of v) { lines += Number(n); if (aaShop.has(Number(shopId))) aa += Number(n); }
    return { lines, aa };
  };
  // same-base families: the parcels of the OTHER rows of one base (a typo twin, another size …)
  const family = new Map();
  for (const p of crm) {
    const b = singleBase(p.name);
    if (!b) continue;
    const f = family.get(b) ?? { bio: 0, nat: 0 };
    f.bio += Number(p.bio || 0);
    f.nat += Number(p.nat || 0);
    family.set(b, f);
  }

  return crm.map((p) => {
    const current = LINES.includes(p.brand_line) ? p.brand_line : null;
    const anchor = bioAnchorOf(p.name);
    const ev = webEvidence(p.name, idx);
    const sales = salesOf(p.id);
    const sold = sales.lines;
    const historyLine = sales.aa * 2 > sales.lines ? 'ad_astra' : 'natura_therapy';
    const bio = Number(p.bio || 0);
    const nat = Number(p.nat || 0);
    const bioR = Number(p.bio_recent || 0);
    const natR = Number(p.nat_recent || 0);
    const out = {
      id: p.id, name: p.name, sku: p.sku ?? null, active: !!p.is_active, current, proposed: null, source: 'none',
      how: null, web: ev?.web ?? [], webSales: sold, anchor, change: 'none', note: '',
    };
    const decide = (line, source, how = null) => { out.proposed = line; out.source = source; out.how = how; };
    const naturaParcels = bio + nat === 0 || nat / (bio + nat) >= natShare;

    if (anchor) {
      // BIONATURAL in the name is Bio Natural, full stop. One of the 12 anchor NAMES can also be a
      // Natura Therapy namesake (ALPHA MALE 60 cps: on the web, its parcels on NATURA) — the web never
      // sells a Bio Natural product, so web + NATURA parcels make it Natura Therapy.
      const named = anchor === 'bionatural' || anchor === 'бионатурал';
      const onWeb = (ev?.line && ev.how !== 'parts_main') || sold > 0;
      if (!named && onWeb && naturaParcels) {
        decide(ev?.line ?? historyLine, ev?.line ? 'web' : 'web_history', ev?.line ? ev.how : null);
        out.note = 'anchor_namesake';
      } else decide('bio_natural', 'anchor');
    } else if (ev?.line) {
      decide(ev.line, 'web', ev.how);
    } else if (sold > 0) {
      decide(historyLine, 'web_history');
      if (ev?.partial) out.note = 'web_partial';
      else if (ev?.mixed) out.note = 'web_mixed';
    } else {
      if (ev?.mixed) out.note = 'web_mixed';
      else if (ev?.partial) out.note = 'web_partial';
      const b = singleBase(p.name);
      const f = b ? family.get(b) : null;
      const fBio = f ? f.bio - bio : 0;
      const fNat = f ? f.nat - nat : 0;
      if (fBio + fNat >= familyMin && fNat / (fBio + fNat) >= natShare) decide('natura_therapy', 'family');
      else if (bioR > 0 && bioR >= natR) { decide('bio_natural', 'parcels_bio_recent'); if (bioR < 5) out.note ||= 'few_parcels'; }
      else if (bio + nat > 0 && nat / (bio + nat) >= natShare) { decide('natura_therapy', 'parcels_natura'); if (bio + nat < 5) out.note ||= 'few_parcels'; }
      else if (bio + nat > 0) out.note ||= 'parcels_mixed';
    }

    const todayWeb = out.source === 'web' && (out.how === 'exact' || out.how === 'base');
    if (!out.proposed) out.change = 'none';
    else if (current === null) out.change = 'new';
    else if (current === out.proposed) out.change = 'same';
    else if (todayWeb && current !== 'ad_astra' && current !== 'dr_becker') out.change = 'overwrite';
    else out.change = 'keep';
    return out;
  });
}

/** What --apply writes: {line → ids} for the `new` rows and (allowOverwrite) the `overwrite` rows. */
export function applyPlan(rows, { allowOverwrite = true } = {}) {
  const by = new Map(LINES.map((l) => [l, []]));
  for (const r of rows) {
    if (r.change === 'new' || (allowOverwrite && r.change === 'overwrite')) by.get(r.proposed).push(r.id);
  }
  return LINES.map((line) => ({ line, ids: by.get(line) })).filter((c) => c.ids.length);
}

export { exactKey, fold };

