/**
 * complete-catalogue-mk — PURE rules for scripts/complete-catalogue.mjs (Macedonian CRM).
 *
 * Owner 28.09.2026: "Create all the products we don't have that are active at the moment and
 * being sold — even ones sold in the past. No purchase price needed for now."
 *
 * After import-catalogue-products (runs 1a0bb805 + 01d83713) the names still without a catalogue
 * product are mostly: Cyrillic / transliterated spellings of products the catalogue DOES have
 * ("БОНЕ ПРОТЕКТ 30cps" = the "Bone Protect" row made from the web shop's name), N+M sets
 * ("СНАИЛ КОМПЛЕКС 30 СЕТ 2+1"), combos, the teleshop's appliances and loyalty-point rewards,
 * and notes riding on a product name ("… со поени", "… за код ab12c", "… замена за …").
 *
 * This module turns every SPELLING into a key and decides, per group of spellings:
 *   exclude  a note / delivery / points / flyer / gift kind, a service, a test, a scratch card,
 *            or a name that was never sold for money (only ever a free unit)
 *   link     the same product as an existing catalogue row (same key, or the catalogue row
 *            states no pack size and is the only row of that product)
 *   unsure   probably an existing product but the variant / identity is not provable → the
 *            owner's list, nothing is written
 *   create   a product the catalogue lacks → one new row, every spelling aliased to it
 *
 * THE KEY — a sorted SET of tokens (order-insensitive: "гастро протект+гастро алое 2+2" =
 * "2+2 гастро алое + гастро протект"):
 *   words    fold() (Cyrillic → Latin), a few cross-language synonyms (црвен ориз = red yeast
 *            rice, шипка = rosehip …), then phonetic folding (c→k/s, x→ks, y→i, ai→ei, doubled
 *            letters, a final a/e/o) so "протект"/"protect", "бреин"/"brain", "комплекс"/"complex"
 *            meet. Filler words (so, za, od, komplex, formula, extract, gratis, podarok, kod …)
 *            are dropped.
 *   sizes    #<n>c (capsules/tablets: "30cps" = "cps 30" = "30/1" = "30 caps" = "30 таблети"),
 *            #<n>ml ("0,5 л" = 500), #<n>g ("2кг" = 2000), #<n>mg. A different size is a
 *            different product — never merged.
 *   packs    #NpM for "2+1", "(1+1)", "2 парч.+1 парч." — a set is its own product;
 *            "30+30" / "150+150" = #30c + #1p1; a leading "3x" / "2 " binds to the next word
 *            ("2*snail"), so "2x A + 2x B" ≠ "A + 2x B".
 *   flavour  @vanilla, @chocolate … read from the WHOLE spelling (the web shop puts the flavour
 *            in its descriptive tail, which is cut).
 *
 * PURE: no I/O, no database (the SQL builders at the end only return strings).
 */
import { fold, cleanSpelling, headOf, nonProductKind, aliasNorm } from './catalogue-match-mk.mjs';
import { q, qUuid, qJson } from './repair-kit.mjs';

export const MKD_PER_EUR = 61.5;   // FROZEN (src/lib/currency.ts) — never "update" it

// ─── notes that ride on a product name ──────────────────────────────────────
// Applied to the FOLDED spelling. Each cuts from the note to the end of the name.
const NOTE_CUTS = [
  /\s*[,(]?\s*(?:koristi\s+)?(?:so|sa|za|od)?\s*(?:\d+\s*)?(?:lojal\w*\s*)?(?:poeni|pshoeni)\b.*$/, // со поени, за 400 поени, користи поени
  /so\s*poeni.*$/,                                        // "вагасо поени" (glued)
  /\s*[-,(:]?\s*(?:za|so|od)?\s*[-:]?\s*kod\b.*$/,          // за код ab12c, со код, so kod, -код x2leq
  /\s*namesto\s+kod.*$/,
  /\s*\(?\s*\d*\s*od\s+neisk\.?\s*kod\)?.*$/,
  /\s*\(?\s*kor\.?\s*vauch.*$/,                            // (кор.вауч.500 ден)
  /\s*[,.]?\s*(?:pravime\s+)?zamena\b.*$/,                 // замена за прополис, правиме замена …
  /\s*(?:vrakja|vrskja)\b.*$/,                             // враќа 2 бреин
  /\s*\/\s*minatiot\b.*$/,
  /\s*,\s*edno od\b.*$/,
  /\s*zaboravena\b.*$/,
  /\s*\d*\s*-?dna\s+rod\.?\s*podarok.*$/,                  // 1дна род.подарок.
];

/** The product part of one spelling, folded: web descriptive tail and riding notes cut. */
export function coreOf(spelling, src) {
  let f = src === 'web' ? headOf(spelling) : fold(spelling);
  for (const re of NOTE_CUTS) f = f.replace(re, '');
  return f.replace(/[\s,.;:\-–—/(+&]+$/, '').replace(/^[\s,.;:\-–—/)+&]+/, '').trim();
}

// ─── non-products this module adds to the classifier's kinds ────────────────
const EXTRA_NON_PRODUCT = [
  [/^grepk/, 'грепка — картичка за гребење (промо), не се продава'],
  [/lojal\w*\s*kartichk|^kartichka/, 'лојалти картичка — не е производ'],
  [/^test\b/, 'тест ставка'],
  [/joga|yoga|predizvik|\bfit ?15\b|fit fevruarski|fit joga|transformation pack|^onlajn|online/, 'услуга (јога / фитнес програма)'],
];
/** A yoga MAT is a physical product, not a yoga service. */
export const PHYSICAL_DESPITE_SERVICE = /\b(mat|podloga)\b/;
export function nonProductOf(spelling) {
  const k = nonProductKind(spelling);
  if (k) return { kind: k.kind, why: k.rule };
  const f = fold(spelling);
  for (const [re, why] of EXTRA_NON_PRODUCT) if (re.test(f) && !(why.startsWith('услуга') && PHYSICAL_DESPITE_SERVICE.test(f))) return { kind: 'other', why };
  return null;
}

// ─── tokens ─────────────────────────────────────────────────────────────────
const FLAVOURS = [
  ['vanilla', /vanil|\bvani\b/], ['chocolate', /chokolad|chocolat|shokolad|cokolad|\bchoco\b/],
  ['strawberry', /jagod|strawberr/], ['raspberry', /\bmalin|raspberr|rasberr/], ['plain', /bez vkus|unflavou?r/],
  ['cocoa', /kakao|cocoa/], ['cinnamon', /cimet|cinnamon/], ['lemon', /limon|\blemon/],
  ['pomegranate', /kalink|pomegranat/], ['orange', /portokal|\borange/], ['pineapple', /ananas|pineapple/],
  ['blackberry', /kapin|blackberr/], ['honeymelon', /\bdinj/], ['watermelon', /lubeni/], ['apple', /jabolk|\bapple/],
  ['tomato', /domat/], ['vegetable', /zelenchuk/],
];
const FLAVOUR_WORD = new RegExp(FLAVOURS.map(([, re]) => re.source).join('|'));

/** Phrases the transliteration cannot bring together (checked on the folded core, in order). */
const PHRASES = [
  [/\bcrven(?:iot)? oriz\b|\bred yeast(?: rice)?\b/g, ' redrice '],
  [/\banti[\s-]?cho(?:c)?king(?:\s+(?:device|divice|devise))?(?:\s+mask)?/g, ' antichoking '],
  [/\bured protiv zadushuvanje\b/g, ' antichoking '],
  [/\bi\s*'?\s*am\b/g, ' iam '],
  [/\baha\s+a[cs]id\w*/g, ' aha '],
  [/\banti[\s-]?a[ck]n[ei]\b|\bantikni\b|\bantiakne\b/g, ' antiakne '],
  [/\bandrographis(?:\s+paniculata)?\b|\bandrografis\b/g, ' andrografis '],
  [/\bdr\.?\s*slim\b/g, ' drslim '],
  [/\bgumeni\s+bo[nm]boni\b|\bgumm(?:y|ies)\b/g, ' gummies '],
  [/\bbeta[\s-]?gl[uy][ck]an\b/g, ' betaglukan '],
  [/\bd[\s-]?man+o[sz]+[ae]?\b/g, ' dmanoza '],
];

/** Single words: folded spelling → canonical (applied before the phonetic folding). */
const SYN = new Map(Object.entries({
  zinc: 'zink', zink: 'zink', cink: 'zink', cinc: 'zink', zn: 'zink',
  whey: 'whey', vej: 'whey', wey: 'whey',
  cream: 'krem', krem: 'krem', krema: 'krem', kremi: 'krem',
  oil: 'maslo', maslo: 'maslo',
  powder: 'prav', prav: 'prav', prashok: 'prav',
  drops: 'kapki', kapki: 'kapki',
  syrup: 'sirup', sirup: 'sirup', sirop: 'sirup',
  shake: 'shejk', shejk: 'shejk', shejkovi: 'shejk',
  vit: 'vitamin', vitamini: 'vitamin', vitamins: 'vitamin',
  multivitamins: 'multivitamin', multivitamini: 'multivitamin',
  shipka: 'rosehip', rosehip: 'rosehip',
  maslinka: 'olive', olive: 'olive',
  leaf: 'list', list: 'list',
  mushroom: 'mushroom', mashrom: 'mushroom', mushrom: 'mushroom',
  menopauza: 'menopause', menopause: 'menopause',
  jelly: 'jelly', zheli: 'jelly', zhele: 'jelly',
  royal: 'rojal', rojal: 'rojal',
  ginseng: 'ginseng', zhenshen: 'ginseng',
  siberian: 'sibirski', sibirski: 'sibirski',
  autoimmune: 'autoimun', autoimune: 'autoimun', avtoimuna: 'autoimun', avtoimun: 'autoimun',
  shampon: 'shampon', shampoo: 'shampon', shamp: 'shampon',
  coffee: 'kafe', kafe: 'kafe',
  collagen: 'kolagen', kolagen: 'kolagen',
  peptid: 'peptid', peptide: 'peptid', peptides: 'peptid', peptidi: 'peptid',
  glucosamine: 'glukozamin', glucosamin: 'glukozamin', glukozamin: 'glukozamin', glukosamin: 'glukozamin',
  cholestol: 'holestol', holestol: 'holestol',
  chlorophyll: 'hlorofil', hlorofil: 'hlorofil',
  broncho: 'bronho', bronho: 'bronho',
  diabetol: 'diabetol', dijabetol: 'diabetol',
  terrestris: 'terestris', teresstris: 'terestris', terrestis: 'terestris', terestris: 'terestris',
  turmeric: 'turmerik', tumeric: 'turmerik', turmerik: 'turmerik',
  matcha: 'macha', macha: 'macha',
  glucomannan: 'glukomanan', glukomannan: 'glukomanan', glukomanan: 'glukomanan',
  tongkat: 'tongkat', tongakt: 'tongkat',
  device: 'device', divice: 'device', devise: 'device',
}));

/** Dropped: grammar, promo wording, the packaging words (sizes carry the number), generic. */
const STOP = new Set([
  'od', 'so', 'sa', 's', 'za', 'i', 'na', 'vo', 'do', 'ot', 'po', 'and', 'with', 'the', 'of', 'for', 'in', 'a', 'e',
  'vkus', 'izbor', 'gratis', 'free', 'besplatno', 'podarok', 'poarok', 'podaroka', 'podaroci', 'gift', 'kod', 'koda', 'kodot', 'code',
  'komplex', 'kompleks', 'complex', 'formula', 'extract', 'ekstrakt', 'natura', 'support', 'lice', 'face',
  'cps', 'caps', 'kaps', 'kapsuli', 'kapsula', 'capsules', 'crs', 'cp', 'tbl', 'tabl', 'tab', 'tableti', 'tablets',
  'ml', 'l', 'g', 'gr', 'kg', 'mg', 'x', 'kom', 'parch', 'pc', 'pcs', 'broj',
]);
const SET_WORDS = new Set(['set', 'paket', 'pack', 'komplet', 'combo', 'kombo']);
/** Known compounds: "артрофлекс" = "arthro flex", "неуроактив" = "neuro active". */
const PREFIXES = ['artro', 'neuro', 'nevro', 'gastro', 'hemoro', 'kardio', 'gluko', 'osteo', 'prosta', 'kurkum'];
const SUFFIXES = new Set(['fleks', 'fiks', 'aktiv', 'protekt', 'blu', 'gard', 'fort', 'forte']);

/** Phonetic folding of one Latin word so Cyrillic and English spellings meet. */
export function phon(word) {
  let t = String(word);
  if (SYN.has(t)) return SYN.get(t);
  t = t.replace(/qu/g, 'kv').replace(/ph/g, 'f').replace(/th/g, 't').replace(/dh/g, 'd').replace(/ck/g, 'k')
    .replace(/tch/g, 'ch').replace(/w/g, 'v');
  t = t.replace(/ch/g, '\u0001').replace(/sh/g, '\u0002').replace(/zh/g, '\u0003');   // keep ч ш ж
  t = t.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/x/g, 'ks').replace(/y/g, 'i');
  t = t.replace(/ai/g, 'ei').replace(/ou/g, 'u').replace(/ee/g, 'i');
  t = t.replace(/(.)\1+/g, '$1');
  if (t.length >= 4) t = t.replace(/[aeo]$/, '');
  t = t.replace(/\u0001/g, 'ch').replace(/\u0002/g, 'sh').replace(/\u0003/g, 'zh');
  if (SYN.has(t)) return SYN.get(t);
  return t;
}

const COUNT_SET = new Set([20, 30, 60, 90, 100, 120, 150, 180, 250, 365]);
const num = (s) => parseFloat(String(s).replace(',', '.'));

/**
 * The token set of one spelling.
 * @param {string} spelling  the name as sold (or a catalogue name)
 * @param {string} src       'web' | 'crm' | 'collabbox' | 'catalogue'
 * @returns {{ core: string, tokens: string[], key: string, base: string, sizes: string[],
 *            flavours: string[], packs: string[], words: string[], combo: boolean }}
 */
export function signature(spelling, src = 'crm') {
  const flavours = [...new Set(FLAVOURS.filter(([, re]) => re.test(fold(spelling))).map(([k]) => k))].sort();
  let s = ` ${coreOf(spelling, src)} `;
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  s = s.replace(/\b([a-z])-\s*(?=[a-z]{3})/g, '$1');                  // l-glutamine → lglutamine
  s = s.replace(/(\d+)\s*%/g, ' ');                                     // 100 %, 99%, 5%
  const sizes = [];
  const packs = [];
  // packs first: 30+30 / 150+150 = one pack size twice; N+M sets; "2 парч.+1 парч."
  s = s.replace(/(\d{2,3})\s*\+\s*(\d{2,3})(?![\d.,])/g, (m, a, b) => (a === b ? (sizes.push(`#${Number(a)}c`), packs.push('#1p1'), ' ') : m));
  s = s.replace(/(\d)\s*parch\.?\s*\+\s*(\d)\s*parch\.?/g, (_, a, b) => (packs.push(`#${a}p${b}`), ' '));
  s = s.replace(/(?<![\d.,])(\d)\s*\+\s*(\d)(?![\d.,])/g, (_, a, b) => (packs.push(`#${a}p${b}`), ' '));
  const combo = /[+&]/.test(s.replace(/\s+/g, ''));
  // sizes
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(kg|gr|g)(?![a-z])/g, (_, n, u) => { let v = num(n); if (u === 'kg' || v < 10) v *= 1000; sizes.push(`#${Math.round(v)}g`); return ' '; });
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(ml|l|lit)(?![a-z])/g, (_, n, u) => { let v = num(n); if (u !== 'ml' || v < 10) v *= 1000; sizes.push(`#${Math.round(v)}ml`); return ' '; });
  s = s.replace(/(\d+)\s*mg(?![a-z])/g, (_, n) => (sizes.push(`#${Number(n)}mg`), ' '));
  s = s.replace(/(\d+)\s*(?:\/\s*1\s*)?(?:cps|caps|kaps|kapsuli|kapsula|capsules|crs|cp|tbl|tabl|tableti|tablets|tab|ps)(?![a-z])\.?/g, (_, n) => (sizes.push(`#${Number(n)}c`), ' '));
  s = s.replace(/\b(?:cps|caps|tbl|tab)\.?\s*(\d+)(?!\s*[/\d])/g, (_, n) => (sizes.push(`#${Number(n)}c`), ' '));
  s = s.replace(/(\d+)\s*\/\s*(?:1(?!\d)|tab|tbl|cps)/g, (_, n) => (sizes.push(`#${Number(n)}c`), ' '));
  s = s.replace(/\((\d{2,3})\)/g, (m, n) => (COUNT_SET.has(Number(n)) ? (sizes.push(`#${Number(n)}c`), ' ') : m));
  // words (a leading multiplier binds to the next word)
  const raw = s.split(/[^a-z0-9#]+/).filter(Boolean);
  const words = [];
  let mult = null;
  const hasCount = sizes.some((x) => x.endsWith('c'));
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (/^\d$/.test(w) && i + 1 < raw.length && /^[a-z]/.test(raw[i + 1])) { mult = Number(w) >= 2 ? Number(w) : null; continue; }
    const xm = w.match(/^(\d)x$/);
    if (xm) { mult = Number(xm[1]) >= 2 ? Number(xm[1]) : null; continue; }
    if (/^x\d$/.test(w)) continue;
    if (/^\d+$/.test(w)) {
      if (!hasCount && COUNT_SET.has(Number(w))) sizes.push(`#${Number(w)}c`); else words.push(w);
      mult = null;
      continue;
    }
    if (FLAVOUR_WORD.test(w)) { mult = null; continue; }
    if (SET_WORDS.has(w)) { words.push('#set'); mult = null; continue; }
    if (STOP.has(w)) { mult = null; continue; }
    // compounds are split on the PHONETIC form, so "curcumactiv" and "куркумактив" split alike
    const whole = phon(w);
    const pfx = PREFIXES.find((p) => whole.startsWith(p) && whole.length > p.length && SUFFIXES.has(phon(whole.slice(p.length))));
    const parts = pfx ? [phon(pfx), phon(whole.slice(pfx.length))] : [whole];
    for (const t of parts) {
      if (!t || STOP.has(t)) continue;
      words.push(mult ? `${mult}*${t}` : t);
    }
    mult = null;
  }
  if (packs.length) for (let i = words.length - 1; i >= 0; i--) if (words[i] === '#set') words.splice(i, 1);
  const uniq = (xs) => [...new Set(xs)].sort();
  const w = uniq(words);
  const tokens = uniq([...w, ...sizes, ...packs, ...flavours.map((f) => `@${f}`)]);
  const base = uniq([...w, ...packs, ...flavours.map((f) => `@${f}`)]);
  return {
    core: s.replace(/\s+/g, ' ').trim(), tokens, key: tokens.join(' '), base: base.join(' '),
    sizes: uniq(sizes), flavours, packs: uniq(packs), words: w, combo,
  };
}

/** A set, a multi-pack or a combo of products — always its own catalogue product. */
export const isBundle = (sig) => sig.packs.length > 0 || sig.words.some((w) => /^\d\*/.test(w)) || sig.combo || sig.words.includes('#set');

// ─── catalogue side ─────────────────────────────────────────────────────────
/**
 * Keys of a catalogue name: the full name, and the name without a parenthesised NOTE
 * ("Max Brain (какао напиток)", "Allergo Protect (сируп)"). A bracket holding a number is a
 * pack ("Brain active (30cps)") and is never dropped. The part after " — " is never dropped
 * either: in "Melatonin — гумени бонбони (30)" it is what makes the product.
 */
export function catalogueSignatures(name) {
  const out = [signature(name, 'catalogue')];
  const clean = cleanSpelling(name);
  const noParen = clean.replace(/\([^)0-9]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParen !== clean && noParen) out.push(signature(noParen, 'catalogue'));
  const seen = new Set();
  return out.filter((s) => s.words.length && !seen.has(s.key) && seen.add(s.key));
}

/**
 * Index the catalogue by key and by base (key without sizes).
 * @param {Array<{id,name,...}>} products
 */
export function indexCatalogue(products) {
  const byKey = new Map();
  const byBase = new Map();
  const loose = [];   // + the part before " — ": used ONLY to flag look-alikes, never to link
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).some((x) => x.p.id === v.p.id)) m.get(k).push(v); };
  for (const p of products) {
    const sigs = catalogueSignatures(p.name);
    for (const sig of sigs) {
      add(byKey, sig.key, { p, sig });
      add(byBase, sig.base, { p, sig });
      loose.push({ p, sig });
    }
    const head = cleanSpelling(p.name).split(/\s+[—–]\s+/)[0];
    if (head !== cleanSpelling(p.name)) {
      const hs = signature(head, 'catalogue');
      if (hs.words.length && !sigs.some((s) => s.key === hs.key)) loose.push({ p, sig: hs });
    }
  }
  return { byKey, byBase, loose };
}

// ─── fuzzy look-alikes (only ever FLAGS, never links) ───────────────────────
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** Same word, or a one-letter typo between two words of 5+ letters. */
export const tokenLike = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
const plain = (sig) => sig.words.filter((w) => !w.startsWith('#') && !/^\d/.test(w));
const within = (xs, ys) => xs.every((x) => ys.some((y) => tokenLike(x, y)));
/** Two explicit, different pack sizes = two products. */
export const sizesConflict = (a, b) => a.sizes.length > 0 && b.sizes.length > 0 && a.sizes.join() !== b.sizes.join();

/** Catalogue rows that look like the same product (one extra / one missing word, or a typo). */
export function lookAlikes(sig, index) {
  const g = plain(sig);
  if (!g.length) return [];
  const out = new Map();
  for (const { p, sig: cs } of index.loose) {
    if (out.has(p.id) || sizesConflict(sig, cs) || cs.packs.join() !== sig.packs.join() || cs.flavours.join() !== sig.flavours.join()) continue;
    const c = plain(cs);
    if (!c.length) continue;
    const hit = (within(c, g) && g.length - c.length <= 1) || (within(g, c) && c.length - g.length <= 1);
    if (hit) out.set(p.id, p);
  }
  return [...out.values()];
}

/** Catalogue rows sharing a distinctive word — shown to the owner next to a NEW product. */
export function similarInCatalogue(sig, index, limit = 3) {
  const g = plain(sig).filter((w) => w.length >= 4 && !/^(vitamin|eliksi|maslo|krem|serum|gel|prav|kapki)$/.test(w));
  if (!g.length) return [];
  const out = new Map();
  for (const { p, sig: cs } of index.loose) {
    const c = plain(cs);
    const shared = g.filter((w) => c.some((x) => tokenLike(w, x))).length;
    if (shared && shared > (out.get(p.id)?.shared ?? 0)) out.set(p.id, { p, shared });
  }
  return [...out.values()].sort((a, b) => b.shared - a.shared || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0)).slice(0, limit).map((x) => x.p);
}

// ─── money ──────────────────────────────────────────────────────────────────
export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
/** The typical sale price in EUR: median денари per unit ÷ 61,5, 2 decimals. */
export function typicalPriceEur(unitValuesMkd) {
  const m = median(unitValuesMkd);
  return m === null ? null : Math.round((m / MKD_PER_EUR) * 100) / 100;
}
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** First day of "the last N days": today and the N−1 days before it (Skopje sale days). */
export const windowStart = (today, days) => addDays(today, -(days - 1));

// ─── display name ───────────────────────────────────────────────────────────
/**
 * The catalogue name for one spelling: entities decoded, riding notes cut, the web shop's
 * descriptive tail cut (its flavour kept: "… (2+1) + подарок — со вкус на чоколадо").
 */
export function displayName(spelling, src) {
  let t = cleanSpelling(spelling);
  let flavourTail = '';
  if (src === 'web') {
    const m = t.match(/\s*[-—–]\s*(?=[Ѐ-ӿ])|\s[-—–]\s+(?=(preparation|nutritional|dietary|to |joint|meal|anti-cellulite|preparat)\b)|\s*,\s*(?=[Ѐ-ӿ])/i);
    if (m) {
      const tail = t.slice(m.index);
      const fl = tail.match(/со вкус на [^-—–,]+/i);
      if (fl) flavourTail = ` — ${fl[0].trim()}`;
      t = t.slice(0, m.index);
    }
  }
  // riding notes, on the original spelling (Cyrillic or Latin)
  // (\b does not see Cyrillic letters in JS — (?!\p{L}) is the word end)
  t = t.replace(/\s*[,(]?\s*(?:користи\s+)?(?:со|за|од|so|za)?\s*(?:\d+\s*)?(?:лојал\S*\s*)?(?:поени|пшоени)(?!\p{L}).*$/iu, '')
    .replace(/со\s*поени.*$/iu, '')
    .replace(/\s*[-,(:]?\s*(?:за|со|од|so|za)?\s*[-:]?\s*(?:код|kod)(?!\p{L}).*$/iu, '')
    .replace(/\s*наместо\s+код.*$/iu, '')
    .replace(/\s*\(?\s*\d*\s*од\s+неиск\.?\s*код\)?.*$/iu, '')
    .replace(/\s*\(?\s*кор\.?\s*вауч.*$/iu, '')
    .replace(/\s*[,.]?\s*(?:правиме\s+)?замена(?!\p{L}).*$/iu, '')
    .replace(/\s*(?:враќа|врсќа)(?!\p{L}).*$/iu, '')
    .replace(/\s*\/\s*минатиот(?!\p{L}).*$/iu, '')
    .replace(/\s*,\s*едно од(?!\p{L}).*$/iu, '')
    .replace(/\s*заборавена(?!\p{L}).*$/iu, '')
    .replace(/\s*\d*\s*-?дна\s+род\.?\s*подарок.*$/iu, '');
  t = t.replace(/[\s,;:\-–—/(+&]+$/, '').replace(/^[\s,;:\-–—/)+&]+/, '').trim();
  return `${t}${flavourTail}`.slice(0, 200);
}

// ─── grouping + decisions ───────────────────────────────────────────────────
/** Lexicon mentions whose "weak" verdict is a doubt about IDENTITY (maybe an existing product). */
export const IDENTITY_DOUBT = new Map([
  ['brainProtect', 'Brain Protect — можеби преименуван Brain Active (ист опис во продавницата); не е потврдено'],
  ['aloeSkinGel', 'гел за кожа — можеби „АЛОЕ БОДИ ГЕЛ 100ml“; пакувањето/формулата не се потврдени'],
  ['glucomannan', 'Глукоманан — состојката на Slim Fiber, но во продавницата е посебен артикл'],
  ['goji', 'гоџи — во каталогот е само „ЕКСТРАКТ ОД ЦРНО ГОЏИ“; да се потврди дека е истиот'],
  ['magnumCooler', '„Magnum Cooler“ — најверојатно „МАГНУМ КЛИМА УРЕД“ (иста цена ~20.000 ден); да се потврди'],
  ['iceRoller', 'Ice roller — варијантата не е позната'],
]);

/** Price samples of a line set: one { d, u } (sale day, денари per unit) per priced product line. */
export const samplesOf = (lines) => lines
  .filter((l) => l.lkind === 'product' && !l.bad_qty && l.qty >= 1 && l.val > 0)
  .map((l) => ({ d: l.d, u: l.val / l.qty }));

/**
 * The typical sale price, EUR: the median денари per unit of the last `priceDays` days ÷ 61,5;
 * when that window holds fewer than `minSamples` priced lines, the median of the product's
 * `recentN` most recent priced lines (a single 100-ден gift-ish sale is not a typical price).
 * @param {Array<{d:string,u:number}>} samples
 * @returns {{ eur: number|null, n: number, basis: 'last90'|'recent20'|'none' }}
 */
export function priceFor(samples, { today, priceDays = 90, minSamples = 3, recentN = 20 }) {
  const since = windowStart(today, priceDays);
  const recent = samples.filter((s) => s.d >= since && s.d <= today).map((s) => s.u);
  if (recent.length >= minSamples) return { eur: typicalPriceEur(recent), n: recent.length, basis: 'last90' };
  const latest = samples.filter((s) => s.d <= today)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : a.u - b.u)).slice(0, recentN).map((s) => s.u);
  if (!latest.length) return { eur: null, n: 0, basis: 'none' };
  return { eur: typicalPriceEur(latest), n: latest.length, basis: 'recent20' };
}

/**
 * An ACTIVE catalogue row that is the same product as `p` — activating `p` would list the
 * product twice in the agents' order form. Same key; or the same product where one of the two
 * names states no pack AND they are the only two rows of that product (a pack-less "Vitamin D3"
 * next to four other D3 packs proves nothing).
 * @param {object} p           the inactive row
 * @param {Array<object>} catalogue
 * @param {object} [index]     indexCatalogue(catalogue), for speed
 */
export function activeTwinOf(p, catalogue, index = indexCatalogue(catalogue)) {
  for (const ps of catalogueSignatures(p.name)) {
    const same = (index.byKey.get(ps.key) || []).find((x) => x.p.id !== p.id && x.p.is_active);
    if (same) return same.p;
    const bases = index.byBase.get(ps.base) || [];
    const others = [...new Map(bases.filter((x) => x.p.id !== p.id).map((x) => [x.p.id, x])).values()];
    if (others.length === 1 && others[0].p.is_active && (!others[0].sig.sizes.length || !ps.sizes.length)) return others[0].p;
  }
  return null;
}

const LINK_SAME = (p, n) => `исто како „${p.name}“ (${n > 1 ? `${n} исти реда во каталогот — избран најпродаваниот` : 'исто име по нормализација/транслитерација'})`;

/**
 * Decide every group.
 * @param {Array<object>} variants  one per (src, norm): { src, norm, spellings: Map<spelling, lines>,
 *                                  lines: [{lkind,qty,val,d,bad_qty}], classification? (classifyName) }
 * @param {Array<object>} catalogue public.products rows ({ id, name, is_active, … })
 * @param {object} opts             { pickAmong(products) → product, today: 'YYYY-MM-DD', activeDays: 60, priceDays: 90 }
 * @returns {{ groups: Array<object>, merged: Array<object>, index }}
 *   group: { key, sig, variants, lines, value, firstSold, lastSold, soldRecently, decision
 *            ('exclude'|'link'|'unsure'|'create'), why, target?, candidates?, suggest?, bundle?,
 *            name?, price?, similar? }
 */
export function planGroups(variants, catalogue, opts) {
  const index = indexCatalogue(catalogue);
  const pick = opts.pickAmong || ((ps) => ps[0]);
  const since = windowStart(opts.today, opts.activeDays ?? 60);
  const idsOf = (xs) => [...new Map(xs.map((x) => [x.p.id, x.p])).values()];

  // 1) one signature per variant: its most frequent spelling (ties: alphabetical)
  for (const v of variants) {
    const spellings = [...v.spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    v.top = spellings[0][0];
    v.sig = signature(v.top, v.src);
    v.nonProduct = nonProductOf(v.top);
    v.service = !!v.classification?.service && !PHYSICAL_DESPITE_SERVICE.test(fold(v.top));
    v.namedCombo = !!v.classification?.bundle;
    v.sold = v.lines.some((l) => l.lkind === 'product' && l.val > 0);
  }

  // 2) group by key (a non-product, or a name with no word left, stays on its own)
  const byKey = new Map();
  for (const v of variants) {
    const k = v.nonProduct || v.service || !v.sig.words.length ? `!${v.src}:${v.norm}` : v.sig.key;
    if (!byKey.has(k)) byKey.set(k, { key: k, variants: [] });
    byKey.get(k).variants.push(v);
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.sig = g.variants[0].sig;

  // 3) a group that states no size joins the ONE sized group of the same product, when the
  //    catalogue has no row of that product to confuse it with
  const sizedByBase = new Map();
  for (const g of groups) {
    if (g.key.startsWith('!') || !g.sig.sizes.length) continue;
    if (!sizedByBase.has(g.sig.base)) sizedByBase.set(g.sig.base, []);
    sizedByBase.get(g.sig.base).push(g);
  }
  for (const g of groups) {
    if (g.key.startsWith('!') || g.sig.sizes.length) continue;
    const sized = sizedByBase.get(g.sig.base) || [];
    if (sized.length === 1 && !index.byBase.has(g.sig.base)) {
      sized[0].variants.push(...g.variants.map((v) => ({ ...v, sizeInferred: true })));
      g.merged = sized[0].key;
    }
  }
  const live = groups.filter((g) => !g.merged);

  // 4) decide
  for (const g of live) {
    const vs = g.variants;
    g.lines = vs.flatMap((v) => v.lines);
    const sold = g.lines.filter((l) => l.lkind === 'product');
    g.value = sold.reduce((s, l) => s + l.val, 0);
    g.lastSold = sold.reduce((m, l) => (l.d > m ? l.d : m), '');
    g.firstSold = sold.reduce((m, l) => (!m || l.d < m ? l.d : m), '');
    g.soldRecently = !!g.lastSold && g.lastSold >= since;
    const np = vs.find((v) => v.nonProduct)?.nonProduct;
    const cls = vs.map((v) => v.classification).filter(Boolean);
    if (np) { g.decision = 'exclude'; g.why = np.why; continue; }
    if (vs.some((v) => v.service)) { g.decision = 'exclude'; g.why = 'услуга (јога / фитнес програма), не физички производ'; continue; }
    if (g.key.startsWith('!')) { g.decision = 'exclude'; g.why = 'по отстранување на белешките не останува име на производ'; continue; }
    if (!vs.some((v) => v.sold)) { g.decision = 'exclude'; g.why = 'никогаш не е продаден за пари — само бесплатна единица (подарок)'; continue; }
    const bundle = isBundle(g.sig) || vs.some((v) => v.namedCombo);
    g.bundle = bundle;
    const bases = index.byBase.get(g.sig.base) || [];
    const same = index.byKey.get(g.sig.key) || [];

    if (g.sig.sizes.length) {
      // the same product and pack as a catalogue row
      if (same.length) { const p = pick(idsOf(same)); g.decision = 'link'; g.target = p; g.why = LINK_SAME(p, idsOf(same).length); continue; }
      // the catalogue row states no pack and is the only row of that product
      const ids = idsOf(bases);
      const sizeless = bases.filter((x) => !x.sig.sizes.length);
      const others = ids.length === 1 && sizeless.length && !bundle ? lookAlikes(g.sig, index).filter((p) => p.id !== ids[0].id) : [];
      if (ids.length === 1 && sizeless.length && others.length) { g.decision = 'unsure'; g.candidates = [ids[0], ...others]; g.why = `каталогот не го наведува пакувањето на „${ids[0].name}“, а има и слични редови`; continue; }
      if (ids.length === 1 && sizeless.length) { g.decision = 'link'; g.target = ids[0]; g.why = `ист производ како „${ids[0].name}“ — каталогот не го наведува пакувањето, а е единствениот ред`; continue; }
      if (sizeless.length) { g.decision = 'unsure'; g.candidates = ids; g.why = 'во каталогот има ред без наведено пакување и други пакувања — не може да се докаже кој е'; continue; }
      // otherwise: only other packs in the catalogue → a different product (created below)
    } else {
      // the name states no pack: fine when there is exactly ONE candidate (catalogue or a sized group)
      // (an identical pack-less catalogue name is no proof either when that product has other packs)
      const ids = idsOf(bases);
      const siblings = (sizedByBase.get(g.sig.base) || []).length;
      const others = ids.length === 1 && !siblings && !bundle ? lookAlikes(g.sig, index).filter((p) => p.id !== ids[0].id) : [];
      if (ids.length === 1 && !siblings && !others.length) {
        g.decision = 'link'; g.target = ids[0];
        g.why = same.length ? LINK_SAME(ids[0], 1) : `ист производ како „${ids[0].name}“ — името не го наведува пакувањето, во каталогот има само едно`;
        continue;
      }
      if (ids.length === 1 && others.length) { g.decision = 'unsure'; g.candidates = [ids[0], ...others]; g.why = 'пакувањето не е наведено, а во каталогот има и слични производи'; continue; }
      if (ids.length + siblings >= 2) {
        g.decision = 'unsure'; g.candidates = ids;
        g.why = `пакувањето не е наведено, а производот го има во ${ids.length + siblings} пакувања${siblings ? ` (${siblings} меѓу имињата од продажби)` : ''}`;
        continue;
      }
    }
    // flavour not stated, but the catalogue sells that product in flavours
    if (!g.sig.flavours.length) {
      const flav = [];
      for (const list of index.byKey.values()) for (const { p, sig } of list) {
        if (sig.flavours.length && sig.words.join() === g.sig.words.join() && sig.packs.join() === g.sig.packs.join() && !sizesConflict(sig, g.sig)) flav.push(p);
      }
      if (flav.length) { g.decision = 'unsure'; g.candidates = [...new Map(flav.map((p) => [p.id, p])).values()]; g.why = 'вкусот не е наведен, а каталогот го има производот во повеќе вкусови'; continue; }
    }
    // the previous review's doubt about IDENTITY (a set / combo is its own product anyway)
    const doubt = cls.map((c) => (c.components || []).map((x) => String(x).replace(/\(.*$/, '')).find((id) => IDENTITY_DOUBT.has(id))).find(Boolean);
    if (doubt && !bundle) {
      g.decision = 'unsure'; g.why = IDENTITY_DOUBT.get(doubt);
      g.suggest = cls.map((c) => c.target?.productName).find(Boolean) || null;
      continue;
    }
    // a single product one word / a typo away from a catalogue row → the owner decides
    if (!bundle) {
      const like = lookAlikes(g.sig, index);
      if (like.length) { g.decision = 'unsure'; g.candidates = like; g.why = `многу слично на ${like.map((p) => `„${p.name}“`).join(', ')} — да се потврди дали е истиот`; continue; }
    }
    g.decision = 'create';
    g.why = bundle ? 'сет / пакет / комбинација — свој производ' : 'го нема во каталогот';
  }

  // 5) the new rows: name, price, look-alikes to show; two groups with one visible name are one product
  const byName = new Map();
  for (const g of live.filter((x) => x.decision === 'create').sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1))) {
    const name = nameOfGroup(g);
    const k = String(name).toLowerCase();
    if (byName.has(k)) {
      const host = byName.get(k);
      host.variants.push(...g.variants);
      host.lines.push(...g.lines);
      host.value += g.value;
      if (g.lastSold > host.lastSold) host.lastSold = g.lastSold;
      if (!host.firstSold || (g.firstSold && g.firstSold < host.firstSold)) host.firstSold = g.firstSold;
      host.soldRecently = host.soldRecently || g.soldRecently;
      host.alsoKeys = [...(host.alsoKeys || []), g.key];
      g.decision = 'merged'; g.merged = host.key;
      continue;
    }
    g.name = name;
    byName.set(k, g);
  }
  for (const g of live.filter((x) => x.decision === 'create')) {
    g.price = priceFor(samplesOf(g.lines), { today: opts.today, priceDays: opts.priceDays ?? 90 });
    g.similar = similarInCatalogue(g.sig, index);
  }
  return { groups: live.filter((g) => g.decision !== 'merged'), merged: groups.filter((g) => g.merged), index };
}


/** The catalogue name of a created group: its most frequent spelling (lines), display-cleaned. */
export function nameOfGroup(g) {
  const counts = new Map();
  for (const v of g.variants) {
    for (const [s, n] of v.spellings) {
      const d = displayName(s, v.src);
      if (!d) continue;
      counts.set(d, (counts.get(d) || 0) + n);
    }
  }
  // code-unit order, never localeCompare: the name feeds the plan hash on any machine
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? null;
}

/**
 * Alias sources for one spelling: 'any' — a spelling names the same product whichever department
 * sold it, and a line's source (crm / collabbox) follows orders.sale_source, which the department
 * reclass (scripts/reclass-by-folder.mjs, 28.09) moves; a source-specific row would silently stop
 * matching. Only when the spelling already has an alias row somewhere: one row per source it sold
 * in unresolved (the existing row keeps its own source).
 */
export function aliasSources(unresolvedSources, hasAnyRowForName = false) {
  if (!hasAnyRowForName) return ['any'];
  return [...new Set(unresolvedSources)].sort();
}

// ─── the SQL the apply / rollback run (pure string builders) ────────────────
/** (id, name, description, price, active, stock, thr, category) */
export const productValuesSql = (products) => products.map((p) => `(${qUuid(p.id)}, ${q(p.name)}, ${q(p.description)}, ${Number(p.price).toFixed(2)}::numeric, ${p.is_active ? 'true' : 'false'}, ${Number(p.stock)}::int, ${Number(p.threshold)}::int, ${q(p.category)})`);
/** (id, mode, act_before, price_before, stock_before, price_after, stock_after, thr_after) — price_before verbatim from the database */
export const activationValuesSql = (acts) => acts.map((a) => `(${qUuid(a.id)}, ${q(a.mode)}, ${a.before.is_active ? 'true' : 'false'}, ${q(a.price_text ?? String(a.before.price))}::numeric, ${Number(a.before.stock)}::int, ${Number(a.after.price).toFixed(2)}::numeric, ${Number(a.after.stock)}::int, ${Number(a.after.threshold)}::int)`);
/** (source, alias_norm, product_id, kind, note) */
export const aliasValuesSql = (aliases) => aliases.map((r) => `(${q(r.source)}, ${q(r.alias_norm)}, ${qUuid(r.product_id)}, 'product', ${q(r.note)})`);
const uuidArray = (ids) => (ids.length ? `ARRAY[${ids.map(qUuid).join(',')}]` : 'ARRAY[]::uuid[]');

/**
 * ONE implicit transaction (one Management-API call): lock the rows to change → guards → new
 * products (+ inventory_logs for a placeholder stock) → activation UPDATE (+ inventory_logs for
 * every stock move) → aliases → the run ledger → one audit_log row → counts. Any guard failing
 * raises → nothing is written.
 * The rows are locked by the guard block, NEVER by a FOR UPDATE inside the snapshot CTE: a locking
 * read silently skips a row the same statement's UPDATE already touched (it lost one row's log in
 * the sandbox). The plain snapshot CTE sees the old values — every sub-statement shares one snapshot.
 */
export function buildApplySql({ key, runId, hash, products, activations, aliases, actorId, actorEmail, runSummary, auditPayload, invNote }) {
  const pv = productValuesSql(products);
  const av = activationValuesSql(activations);
  const lv = aliasValuesSql(aliases);
  const guard = `DO $guard$
BEGIN
  ${av.length ? `PERFORM 1 FROM public.products WHERE id = ANY (${uuidArray(activations.map((a) => a.id))}) ORDER BY id FOR UPDATE;` : ''}
  ${pv.length ? `IF EXISTS (SELECT 1 FROM public.products WHERE id = ANY (${uuidArray(products.map((p) => p.id))})) THEN
    RAISE EXCEPTION '${key}: a planned product id already exists — nothing written';
  END IF;
  IF EXISTS (SELECT 1 FROM public.products p JOIN (VALUES ${products.map((p) => `(${q(p.name)})`).join(',')}) v(name)
             ON lower(btrim(p.name)) = lower(btrim(v.name))) THEN
    RAISE EXCEPTION '${key}: a planned product name already exists — nothing written';
  END IF;` : ''}
  ${av.length ? `IF EXISTS (SELECT 1 FROM (VALUES ${av.join(',\n')}) v(id, mode, act_before, price_before, stock_before, price_after, stock_after, thr_after)
             LEFT JOIN public.products x ON x.id = v.id
             WHERE x.id IS NULL OR x.is_active IS DISTINCT FROM v.act_before OR x.price IS DISTINCT FROM v.price_before
                OR x.stock_quantity IS DISTINCT FROM v.stock_before) THEN
    RAISE EXCEPTION '${key}: a product to activate changed since the dry run — nothing written';
  END IF;` : ''}
  ${lv.length ? `IF EXISTS (SELECT 1 FROM (VALUES ${aliases.map((r) => `(${q(r.source)}, ${q(r.alias_norm)})`).join(',')}) v(source, alias_norm)
             JOIN public.product_aliases a ON a.alias_norm = v.alias_norm AND a.source IN (v.source, 'any')) THEN
    RAISE EXCEPTION '${key}: a planned alias key already exists — nothing written';
  END IF;` : ''}
END
$guard$;`;
  const insertProducts = pv.length ? `INSERT INTO public.products (id, name, description, price, cost_price, is_active, stock_quantity, low_stock_threshold, category)
SELECT v.id, v.name, v.description, v.price, 0, v.active, v.stock, v.thr, v.category
FROM (VALUES ${pv.join(',\n')}) v(id, name, description, price, active, stock, thr, category);
INSERT INTO public.inventory_logs (product_id, change_amount, previous_stock, new_stock, reason, movement_type, notes, user_id)
SELECT v.id, v.stock, 0, v.stock, 'manual', 'manual_adjust', ${q(invNote)}, ${qUuid(actorId)}
FROM (VALUES ${products.map((p) => `(${qUuid(p.id)}, ${Number(p.stock)}::int)`).join(',')}) v(id, stock)
WHERE v.stock > 0;` : '';
  const updateProducts = av.length ? `WITH plan AS (
  SELECT * FROM (VALUES ${av.join(',\n')}) v(id, mode, act_before, price_before, stock_before, price_after, stock_after, thr_after)
),
snap AS MATERIALIZED (
  SELECT p.id, p.stock_quantity AS stock_old
  FROM public.products p JOIN plan ON plan.id = p.id
),
upd AS (
  UPDATE public.products p
     SET is_active = true,
         price = CASE WHEN p.price = 0 AND plan.price_after > 0 THEN plan.price_after ELSE p.price END,
         stock_quantity = CASE WHEN p.stock_quantity <= 0 AND plan.stock_after > p.stock_quantity THEN plan.stock_after ELSE p.stock_quantity END,
         low_stock_threshold = CASE WHEN p.stock_quantity <= 0 AND plan.stock_after > p.stock_quantity THEN plan.thr_after ELSE p.low_stock_threshold END
    FROM plan
   WHERE p.id = plan.id
  RETURNING p.id, p.stock_quantity AS stock_new
)
INSERT INTO public.inventory_logs (product_id, change_amount, previous_stock, new_stock, reason, movement_type, notes, user_id)
SELECT u.id, u.stock_new - s.stock_old, s.stock_old, u.stock_new, 'manual', 'manual_adjust', ${q(invNote)}, ${qUuid(actorId)}
FROM upd u JOIN snap s ON s.id = u.id
WHERE u.stock_new <> s.stock_old;` : '';
  const insertAliases = lv.length ? `INSERT INTO public.product_aliases (source, alias_norm, product_id, kind, note)
VALUES ${lv.join(',\n')};` : '';
  return `
SET LOCAL lock_timeout = '5s';
${guard}
${insertProducts}
${updateProducts}
${insertAliases}
INSERT INTO public.data_repair_runs (id, key, dry_run, candidate_hash, summary, applied_at, applied_by)
VALUES (gen_random_uuid(), ${q(key)}, false, ${q(hash)}, ${qJson(runSummary)}, now(), ${qUuid(actorId)});
INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
VALUES (${qUuid(actorId)}, ${q(actorEmail)}, 'catalogue.complete_from_sales', 'data_repair_run', ${q(runId)}, ${q(key)}, ${qJson(auditPayload)});
SELECT (SELECT count(*) FROM public.products WHERE description LIKE ${q(`%run ${runId}%`)})::int AS products,
       (SELECT count(*) FROM public.product_aliases WHERE note LIKE ${q(`%run ${runId}%`)})::int AS aliases,
       (SELECT count(*) FROM public.products WHERE id = ANY (${uuidArray(activations.map((a) => a.id))}) AND is_active)::int AS active_now;`;
}

/** Tables whose rows point at a product (live FKs, 28.09.2026): a created row is only ever deleted when none does. */
export const PRODUCT_REFERENCES = ['order_items', 'orders', 'prediction_lead_items', 'product_aliases', 'stock_count_lines',
  'stock_mex_ledger_lines', 'lead_routing_rules', 'user_warehouse', 'altercpa_offer_map', 'altercpa_leads', 'offers'];

/**
 * Undo one applied run:
 *  · its still-unreviewed aliases;
 *  · the products it created that NOTHING references any more — no order / lead line, alias,
 *    stock count or ledger line, routing rule, offer, and no stock movement but its own placeholder
 *    (a cascade would silently erase that history, so such a row is kept and reported);
 *  · each activated row's is_active / price / stock / threshold back to the recorded before-state
 *    WHERE it still holds what the run set (an owner's later edit is kept), with an inventory_logs
 *    row per stock move. The low-stock trigger would ring every admin's bell for each placeholder
 *    returned to 0: the threshold is parked at −1 while the stock goes back, then restored (a
 *    threshold-only UPDATE does not fire the trigger, which is `AFTER UPDATE OF stock_quantity`).
 * @param {Array<{id, before, after, price_text}>} before   data_repair_runs.summary.before
 */
export function buildRollbackSql({ key, runId, before, actorId, actorEmail, auditPayload, invNote }) {
  const like = q(`%run ${runId}%`);
  const vals = before.map((b) => `(${qUuid(b.id)}, ${b.before.is_active ? 'true' : 'false'}, ${q(b.price_text ?? String(b.before.price))}::numeric, ${Number(b.before.stock)}::int, ${Number(b.before.threshold)}::int, ${Number(b.after.price).toFixed(2)}::numeric, ${Number(b.after.stock)}::int)`);
  const plan = `plan AS (SELECT * FROM (VALUES ${vals.join(',\n')}) v(id, act_before, price_before, stock_before, thr_before, price_after, stock_after))`;
  const restock = 'p.stock_quantity = plan.stock_after AND plan.stock_after <> plan.stock_before';
  return `SET LOCAL lock_timeout = '5s';
DELETE FROM public.product_aliases WHERE note LIKE ${like} AND reviewed_by IS NULL;
DELETE FROM public.products p WHERE p.description LIKE ${like}
  ${PRODUCT_REFERENCES.map((t) => `AND NOT EXISTS (SELECT 1 FROM public.${t} r WHERE r.product_id = p.id)`).join('\n  ')}
  AND NOT EXISTS (SELECT 1 FROM public.inventory_logs l WHERE l.product_id = p.id AND coalesce(l.notes, '') NOT LIKE ${like});
${vals.length ? `SELECT count(*) FROM (SELECT 1 FROM public.products WHERE id = ANY (${uuidArray(before.map((b) => b.id))}) ORDER BY id FOR UPDATE) locked;
WITH ${plan}
UPDATE public.products p SET low_stock_threshold = -1 FROM plan WHERE p.id = plan.id AND ${restock};
WITH ${plan},
snap AS MATERIALIZED (SELECT p.id, p.stock_quantity AS stock_old FROM public.products p JOIN plan ON plan.id = p.id),
upd AS (
  UPDATE public.products p
     SET is_active = CASE WHEN plan.act_before = false THEN false ELSE p.is_active END,
         price = CASE WHEN p.price = plan.price_after AND plan.price_after <> plan.price_before THEN plan.price_before ELSE p.price END,
         stock_quantity = CASE WHEN ${restock} THEN plan.stock_before ELSE p.stock_quantity END
    FROM plan WHERE p.id = plan.id
  RETURNING p.id, p.stock_quantity AS stock_new)
INSERT INTO public.inventory_logs (product_id, change_amount, previous_stock, new_stock, reason, movement_type, notes, user_id)
SELECT u.id, u.stock_new - s.stock_old, s.stock_old, u.stock_new, 'manual', 'manual_adjust', ${q(invNote)}, ${qUuid(actorId)}
FROM upd u JOIN snap s ON s.id = u.id WHERE u.stock_new <> s.stock_old;
WITH ${plan}
UPDATE public.products p SET low_stock_threshold = plan.thr_before FROM plan WHERE p.id = plan.id AND p.low_stock_threshold = -1;` : ''}
INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
VALUES (${qUuid(actorId)}, ${q(actorEmail)}, 'catalogue.complete_from_sales_rollback', 'data_repair_run', ${q(runId)}, ${q(key)}, ${qJson(auditPayload)});`;
}

export { aliasNorm };
