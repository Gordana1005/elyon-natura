/**
 * catalogue-match-mk — which catalogue product does a SALES LINE NAME mean? (Macedonian CRM)
 *
 * Owner question 2026-09-28: "Which names aren't in the catalogue? We need all the products
 * in the CRM that had sales." Insights keys a line by product_key(): its order_items.product_id,
 * else a public.product_aliases row, else 'n:<product_alias_norm(name)>'. The alias table ships
 * EMPTY, so every web-shop line, every September collabBox line and a few CRM lines are
 * 'n:' keys. This module classifies each such name; scripts/import-catalogue-products.mjs
 * turns the certain ones into alias rows (+ the catalogue products that are missing) and
 * writes the rest to the owner's review file.
 *
 * PURE: no I/O, no database. Everything is decided from (name, source, catalogue, collabBox map).
 *
 * Confidence (owner's words):
 *   exact   same name after normalisation / transliteration, OR the collabBox article code of
 *           this exact collabBox name IS the catalogue product's SKU (scripts/data/collabbox-sku-map.json
 *           "matched", 2026-08-12 — the catalogue SKUs were set to the collabBox article codes)
 *   strong  one identifiable product, same brand + form; the name only differs by pack size or
 *           count (1+1, 2+1, 30+30, 2x, 500 vs 250 ml), a stated flavour, a free gift / discount
 *           code / shaker, or the web shop's descriptive tail
 *   weak    a bundle of two or more PAID products, a changed form (tablets vs capsules vs
 *           gummies), an unknown pack content, or a plausible-but-unproven rename
 *   none    nothing identifiable
 * Only exact + strong (and a NEW product for an identified base that the catalogue lacks) are
 * ever applied; weak / none go to the owner.
 *
 * Line kinds (product_aliases.kind): product | gift | loyalty_point | delivery | note | flyer.
 * A physical item given away free stays 'product' — the Sales tab's structural rule already
 * turns a free unit on a paid sale into a gift line; aliasing the NAME as 'gift' would also
 * zero the units the day that item is sold.
 */

// ─── normalisation ──────────────────────────────────────────────────────────
/** products.name / alias key exactly as SQL product_alias_norm(): lower, trim, collapse spaces. */
export const aliasNorm = (s) => {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return t || null;
};

// Full (non-lossy) Macedonian transliteration, plus stray Bulgarian / Russian letters.
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'gj', е: 'e', ж: 'zh', з: 'z', ѕ: 'dz', и: 'i', ј: 'j',
  к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'kj',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', џ: 'dzh', ш: 'sh',
  ъ: 'a', й: 'j', щ: 'sht', ю: 'ju', я: 'ja', ь: '', ы: 'y', э: 'e', ё: 'e', і: 'i', ї: 'ji', є: 'je', ґ: 'g',
};
const decodeEntities = (s) => s
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');

/** Human spelling: entities decoded, whitespace collapsed (case kept). */
export const cleanSpelling = (s) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();

/** Lowercase Latin: entities decoded, Cyrillic transliterated, diacritics and fancy dashes gone. */
export function fold(s) {
  const lower = decodeEntities(String(s ?? '')).toLowerCase();
  let out = '';
  for (const ch of lower) out += CYR[ch] ?? ch;
  return out.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'").replace(/[—–−]/g, '-').replace(/×/g, 'x').replace(/“|”/g, '"')
    .replace(/\s+/g, ' ').trim();
}

const UNIT = { cps: 'cps', caps: 'cps', kaps: 'cps', crs: 'cps', cp: 'cps', tbl: 'tab', tab: 'tab', tabl: 'tab', tableti: 'tab',
  ml: 'ml', l: 'l', g: 'g', gr: 'g', kg: 'kg', mg: 'mg' };
/**
 * Order-insensitive key for "the same name": "ПРОСТАТОЛ КОМПЛЕКС cps 30" = "простатол комплекс 30 cps"
 * = "Prostatol Komplex cps 30". Punctuation is dropped, "30 cps"/"cps 30"/"30cps" glue into one token.
 */
export function exactKey(s) {
  let t = fold(s).replace(/[^a-z0-9+%]+/g, ' ').trim();
  t = t.replace(/\b(\d+(?:[.,]\d+)?)\s*(cps|caps|kaps|crs|tbl|tabl|tab|tableti|ml|l|gr|g|kg|mg)\b/g, (_, n, u) => `${n}${UNIT[u]}`);
  t = t.replace(/\b(cps|caps|kaps|tbl|tab|ml|gr|mg)\s+(\d+)\b/g, (_, u, n) => `${n}${UNIT[u]}`);
  return t.split(' ').filter(Boolean).sort().join(' ');
}

// ─── line kinds that are not products ───────────────────────────────────────
/**
 * Non-product lines by NAME (owner 2026-09-28: loyalty points, delivery, notes, flyers and
 * gifts are not products). Returns { kind, rule } or null.
 */
export function nonProductKind(name) {
  const f = fold(name);
  if (/^\s*poen(i)?([^a-z]|$)/.test(f)) return { kind: 'loyalty_point', rule: 'ПОЕН — поени за лојалност' };
  if (/^flaer|^flyer|\bflaer\b/.test(f)) return { kind: 'flyer', rule: 'флаер' };
  if (/^zabeleshka/.test(f)) return { kind: 'note', rule: 'ЗАБЕЛЕШКА — белешка за курир/клиент' };
  if (/^dostava\s*$/.test(f)) return { kind: 'delivery', rule: 'ДОСТАВА — трошок за достава' };
  if (/^dostava\b/.test(f)) return { kind: 'note', rule: 'ДОСТАВА + упатство — белешка за доставата' };
  if (/^(ve molam|itna|itno|hitn|dostavuvachot|kje vrati|upatstvo)/.test(f)) return { kind: 'note', rule: 'упатство/белешка во полето за производ' };
  if (/^chashka\s*\/\s*merach$/.test(f)) return { kind: 'gift', rule: 'чашка/мерач — подарок, не се продава' };
  if (/^(adastra )?shaker\s*\/\s*matalka$/.test(f)) return { kind: 'gift', rule: 'маталка (shaker) — подарок, не се продава' };
  return null;
}

// ─── the catalogue side ─────────────────────────────────────────────────────
/** New catalogue products — only created when an exact/strong name needs them. */
export const NEW_PRODUCTS = {
  allergo:        { name: 'Allergo Protect (сируп)', group: 'natura' },
  noni:           { name: 'Нони екстракт 0,5 л', group: 'natura' },
  mushroom:       { name: 'Mushroom Complex 500 ml', group: 'natura' },
  dietshots:      { name: 'Diet Shots 500 ml', group: 'natura' },
  elderberil:     { name: 'Elderberil Imun сируп', group: 'natura' },
  gastrocomplex:  { name: 'Гастро Комплекс 250 ml', group: 'natura' },
  bone:           { name: 'Bone Protect', group: 'natura' },
  redrice:        { name: 'Red Yeast Rice 30 cps', group: 'natura' },
  pulmo:          { name: 'Pulmo Complex', group: 'natura' },
  pms:            { name: 'PMS Complex', group: 'natura' },
  menopause:      { name: 'Menopause Complex 30 cps', group: 'natura' },
  autoimmune:     { name: 'Autoimmune Support Formula 30 cps', group: 'natura' },
  andrographis:   { name: 'Andrographis Paniculata Extract', group: 'natura' },
  bittermelon:    { name: 'Bitter Melon Extract', group: 'natura' },
  acai:           { name: 'Acai Berry Extract', group: 'natura' },
  oliveleaf:      { name: 'Olive Leaf Extract', group: 'natura' },
  quercetin:      { name: 'Quercetin', group: 'natura' },
  royaljelly:     { name: 'Royal Jelly 30 cps', group: 'natura' },
  ginseng:        { name: 'Siberian Ginseng Extract', group: 'natura' },
  nicotine:       { name: 'Nicotine Protect 60 cps', group: 'natura' },
  nightburn:      { name: 'Night Burn', group: 'natura' },
  nmn:            { name: 'NMN (Nicotinamide Mononucleotide) 60 cps', group: 'natura' },
  oxyjet:         { name: 'Oxy Jet Power', group: 'natura' },
  testobooster:   { name: 'Natural Testosterone Booster', group: 'natura' },
  maxbrain:       { name: 'Max Brain (какао напиток)', group: 'natura' },
  massgainer:     { name: 'Mass Gainer', group: 'natura' },
  preworkout:     { name: 'Pre-Workout прав 200 г', group: 'natura' },
  icecream:       { name: 'Протеински сладолед ванила 200 гр', group: 'natura' },
  whey2kgchoc:    { name: '100% WHEY ЧОКОЛАДО 2.0 КГ', group: 'natura' },
  whey12van:      { name: '100 % whey протеин ванила 1.2кг', group: 'natura' },
  whey1kg:        { name: '100% whey протеин 1 кг', group: 'natura' },
  whey400:        { name: '100% whey протеин 400 г', group: 'natura' },
  nutrisoupTom:   { name: 'Nutri Soup — домат', group: 'natura' },
  nutrisoupVeg:   { name: 'Nutri Soup — зеленчук и хлорофил', group: 'natura' },
  ashwaGummy:     { name: 'Ashwagandha — гумени бонбони (30)', group: 'natura' },
  melatoninGummy: { name: 'Melatonin — гумени бонбони (30)', group: 'natura' },
  d3Gummy:        { name: 'Vitamin D3 — гумени бонбони (30)', group: 'natura' },
  zincChrom:      { name: 'Zinc + Chromium (пиколинат) 120 таб', group: 'natura' },
  reishiCoffee:   { name: 'Reishi премиум кафе', group: 'natura' },
  elixyOlive:     { name: 'ELIXY Масло од маслинка', group: 'elixy' },
  elixyJojoba:    { name: 'ELIXY Масло од јојоба 30 ml', group: 'elixy' },
  elixyRosehip:   { name: 'ELIXY Масло од шипка (rosehip)', group: 'elixy' },
  elixy55:        { name: 'ELIXY Hyaluronic&Aloe Vera 55+', group: 'elixy' },
  elixyHoney:     { name: 'ELIXY Honey — крема со мед и шеа путер', group: 'elixy' },
  elixyImmortelle:{ name: 'ELIXY Immortelle — регенеративна крема', group: 'elixy' },
  iamAha:         { name: "I'AM AHA серум за лице", group: 'elixy' },
  iamAcne:        { name: "I'AM Anti-Acne серум за лице", group: 'elixy' },
  iamBeta:        { name: "I'AM Beta Glucan серум за лице", group: 'elixy' },
  iamB3:          { name: "I'AM Vitamin B3 серум за лице", group: 'elixy' },
  balsamBubble:   { name: 'Balsam Bubble Gum — маска за усни', group: 'elixy' },
  balsamHoney:    { name: 'Balsam Honey — маска за усни', group: 'elixy' },
  dermaRoller:    { name: 'Derma Roller', group: 'device' },
  beautyMassager: { name: '5 in 1 Beauty Care Massager', group: 'device' },
  antiChoke:      { name: 'Anti Chocking Device — уред против задушување', group: 'device' },
  magnumCooler:   { name: 'Magnum Cooler', group: 'device' },
  yogaMatTpe:     { name: 'TPE подлога за јога (сина)', group: 'device' },
  yogaMatPu:      { name: 'PU гумена подлога за јога (виолетова)', group: 'device' },
  foreverLina:    { name: 'Forever Lina mini', group: 'thirdparty' },
};

// ─── the lexicon: product mentions inside a folded name ─────────────────────
// Every entry: id (the BASE product — two mentions of one base are one product), re (tested on
// the folded HEAD of the name, i.e. before the web shop's descriptive tail), pick(full) → the
// catalogue SKU (or new:<key>) for the variant the FULL folded name states, and optionally
// accessory:true (shaker, roller … — a giveaway, never makes a bundle) or form:'…' (a form the
// catalogue does not stock → weak).
const has = (f, re) => re.test(f);
const flav = (f) => {
  // first flavour mentioned wins ("малина и ванила" → малина)
  const cands = [
    ['vanilla', /vanil/], ['chocolate', /chokolad|chocolat|shokolad|choco\b/], ['strawberry', /jagod|strawberr/],
    ['raspberry', /malin|raspberr|rasberr/], ['plain', /bez vkus|unflavou?r/], ['tomato', /domat/], ['veg', /zelenchuk/],
  ];
  let best = null;
  for (const [k, re] of cands) { const m = f.match(re); if (m && (best === null || m.index < best.i)) best = { k, i: m.index }; }
  return best?.k ?? null;
};
const grams = (f) => { const m = f.match(/(\d+(?:[.,]\d+)?)\s*(kg|gr?|g)\b(?!\w)/); if (!m) return null; const n = parseFloat(m[1].replace(',', '.')); return m[2] === 'kg' ? n * 1000 : n; };
// "0,5ml." in a catalogue name means half a litre
const ml = (f) => { const m = f.match(/(\d+(?:[.,]\d+)?)\s*(ml|l)\b/); if (!m) return null; const n = parseFloat(m[1].replace(',', '.')); return m[2] === 'l' || n < 10 ? n * 1000 : n; };
const count = (f) => { const m = f.match(/(\d+)\s*(?:\/\s*1\s*)?(?:cps|caps|kaps|kapsuli|tbl|tab|tableti|ps)\b/); return m ? Number(m[1]) : null; };

export const LEXICON = [
  // ── whole-set products first (they contain other names) ──
  { id: 'thermocryo', re: /thermo\s*(gel)?\s*&\s*cryo|termo\s*gel.*krio/, pick: () => '005030' },
  { id: 'aloeVitamins', re: /aloe( vera)?( gel)? (with|so) vit(amin)? c.*(zinc|cink)( & aronia( extract)?)?|aloe aronija so vit c/, pick: () => '000994' },
  { id: 'drslimSet', re: /dr\.? ?slim powder \+ dr\.? ?slim caps \+ podarok dr\.? ?slim caps|1 dr\.?slim powder\+2 dr\.?slim caps/, pick: () => '700085' },
  { id: 'glutKreatinSet', re: /2\s*x\s*creatine( monohydrate)? \+ l-?glutamine (pack|gratis)/, pick: () => '700036' },
  { id: 'hyaluronMatrix', re: /hyaluronic acid & collagen matrix/, pick: () => '005033', why: 'истиот производ во веб-продавницата (shop product 1184) како Hyaluron 5' },
  { id: 'elixyHyalCollagen', re: /elixy-?hyaluronic acid-?collagen&aloe vera/, pick: () => '005037' },
  // ── Elixy / I'AM cosmetics ──
  { id: 'elixyFaceCream', re: /hyaluronic\s*&\s*aloe vera (face )?cream|hyaluronic&aloe vera (35|45|55)\+|hyaluronic\s*&\s*aloe vera krema/, pick: (f) => (/55\+/.test(f) ? 'new:elixy55' : /35\+/.test(f) ? '005031' : '005032'), unsure: (f) => !/(35|45|55)\+/.test(f) },
  { id: 'elixyHyalSerum', re: /hyaluronic acid\s*&\s*aloe vera( face serum)?|hijaluron i aloe serum|hyaluronic ?& ?aloe serum|serum za lice so hijaluron&aloe/, pick: () => '005012' },
  { id: 'snailDuo', re: /snail repair duo/, pick: () => '005005', weakWhy: 'Snail Repair Duo = серум + крема (два производи)' },
  { id: 'snailRepair50', re: /snail repair 50 ml/, pick: (f) => (/nokj?na/.test(f) ? '005006' : '005007') },
  { id: 'snailSerum', re: /snail (repair )?serum|snail repair face serum|serum za lice so 20% ekstrakt od polzhav|serum so 20% ?snail|serum so 20%snail/, pick: () => '005005' },
  { id: 'snailDay', re: /snail repair (dnevna krema|face cream)|elixy dnevna krema|dnevna krema so 10% ekstrakt od polzhav|dnevenkrem snail/, pick: () => '005007' },
  { id: 'snailNight', re: /snail repair nokna krema|elixy nokna krema|nokj?na krema so 3% ekstrakt od polzhav|nokjen krem snail/, pick: () => '005006' },
  { id: 'snailEye', re: /krema za okolu och?i|okoluochen krem/, pick: () => '005008' },
  { id: 'elixyVitC', re: /vitamin c serum|serum so vitamin c/, pick: () => '005019' },
  { id: 'iamCollagen', re: /i'?am collagen|elixy collagen face serum|collagen face serum|eliksi kolagen serum/, pick: () => '005023' },
  { id: 'iamAha', re: /i'?am aha/, pick: () => 'new:iamAha' },
  { id: 'iamAcne', re: /i'?am anti-?acne|\banti acne\b/, pick: () => 'new:iamAcne' },
  { id: 'iamBeta', re: /i'?am beta glucan|\bbeta glucan\b/, pick: () => 'new:iamBeta' },
  { id: 'iamB3', re: /i'?am vitamin b3|\bvit b3\b/, pick: () => 'new:iamB3' },
  { id: 'elixyAvocado', re: /avocado oil|maslo od avokado/, pick: () => '005010' },
  { id: 'elixyMarula', re: /marula oil|maslo od marula/, pick: () => '005017' },
  { id: 'elixyJojoba', re: /jojoba oil|j?ojoba oil|maslo od jojoba|joj?oba\b/, pick: () => 'new:elixyJojoba' },
  { id: 'elixyOlive', re: /olive oil/, pick: () => 'new:elixyOlive' },
  { id: 'elixyRosehip', re: /rosehip oil/, pick: () => 'new:elixyRosehip' },
  { id: 'elixyHoney', re: /elixy honey/, pick: () => 'new:elixyHoney' },
  { id: 'elixyImmortelle', re: /elixy immortelle/, pick: () => 'new:elixyImmortelle' },
  { id: 'elixyShampoo', re: /elixy shampon|shampon aloe vera/, pick: () => '005043' },
  { id: 'elixyHairCaps', re: /kapsuli (protiv opagjanje na kosa|za kosa)/, pick: () => '005046' },
  { id: 'elixyAloeSpf', re: /aloe krema spf/, pick: () => '005047', accessoryIfGift: true },
  { id: 'sunCream', re: /krema za sonchanje/, pick: () => '002391', accessoryIfGift: true },
  { id: 'balsamBubble', re: /balsam bubble gum/, pick: () => 'new:balsamBubble' },
  { id: 'balsamHoney', re: /balsam honey/, pick: () => 'new:balsamHoney' },
  { id: 'aloeBodyGel', re: /aloe (vera )?body gel|aloe bodi gel/, pick: () => '005015' },
  // ── accessories (a giveaway next to a product never makes a bundle) ──
  { id: 'jadeRoller', re: /jade roll?er|facial roller|jade roler/, pick: () => 'SKU-000006', accessory: true },
  { id: 'dermaRoller', re: /derma roller/, pick: () => 'new:dermaRoller', accessory: true },
  { id: 'iceRoller', re: /ice roller|3d body(\/face)? massager/, pick: () => null, accessory: true },
  { id: 'massager5in1', re: /5 in 1 beauty care massager/, pick: () => 'new:beautyMassager' },
  { id: 'shaker', re: /\bshaker\b|matalka|\btermos\b/, pick: () => '001461', accessory: true },
  { id: 'stegach', re: /stegach/, pick: () => '8003', accessory: true },
  { id: 'saunaPants', re: /sauna pants|helanki|leggings/, pick: () => 'ХЕЛАНКИ', accessoryIfGift: true },
  // ── drinks / liquids ──
  { id: 'aloeResveratrol', re: /aloe vera (gel )?so resveratrol|aloe vera gel-?resvera/, pick: () => '000074' },
  { id: 'aloeRoyal', re: /aloe royal/, pick: () => '000319' },
  { id: 'aloeAronija', re: /aloe (vera )?(gel )?(so|with|so extract od|so ekstrakt od) (extract od )?aronij|aloe & aronia|aloe vera gel so aronija|aloe vera so aronija/, pick: (f) => ((ml(f) ?? 1000) <= 500 ? '000165' : '000109') },
  { id: 'aloeSkinGel', re: /aloe vera gel 99%|aloe vera gel \(250ml ?\)|aloe vera gel \(za nadvoreshna|aloe vera gel za nadvoreshna/, pick: () => '005015', weakWhy: 'гел за кожа — најблиску „АЛОЕ БОДИ ГЕЛ 100ml“, но пакувањето/формулата не се потврдени' },
  { id: 'aloeVera', re: /\baloe vera\b(?! gel 99)/, pick: () => '000109', weakWhy: 'само „Aloe Vera“ — не е наведено со аронија/ресвератрол' },
  { id: 'bronchoForte', re: /bron(c)?ho protect forte|bronho protekt forte/, pick: () => '001462' },
  { id: 'bronchoComplex', re: /broncho complex/, pick: () => 'SKU-000034' },
  { id: 'broncho', re: /bron(c)?ho protect|bronho protekt/, pick: (f) => ((ml(f) ?? 500) <= 250 ? '000503' : '000489') },
  { id: 'curcumactiv', re: /curcumactiv|kurkumaktiv|kurkuma aktiv/, pick: (f) => (/^\D*250\s*ml/.test(f) && !/500/.test(f) ? '000592' : 'SKU-000040') },
  { id: 'liquidCurcumin', re: /liquid cur(c|k)umin|techen kurkumin|kurkumin likvid/, pick: () => '000194' },
  { id: 'turmericBoost', re: /turmeric boost|turmerik boost/, pick: () => 'SKU-000014' },
  { id: 'turmericCurcumin', re: /tu?r?meric curcumin|turmerik kurkumin/, pick: () => '001072' },
  { id: 'curcuminExtract', re: /curcumin extract|extract od kurkuma|kurkumin ekstrakt/, pick: () => '000126' },
  { id: 'gastroComplex', re: /gastro complex|gastro kompleks/, pick: () => 'new:gastrocomplex' },
  { id: 'gastroDuo', re: /gastro protect\s*(&|\+)\s*(gastro )?aloe/, pick: () => '000568', bundleOf: 2, why: 'Gastro Protect + Gastro Aloe (два производи)' },
  { id: 'gastroAloe', re: /gastro aloe/, pick: () => '000565' },
  { id: 'gastroProtect', re: /gastro prote(c|k)t/, pick: (f) => ((ml(f) ?? 500) <= 250 ? '000536' : '000568') },
  { id: 'megaMulti', re: /mega multivitamin/, pick: () => '000543' },
  { id: 'vitCKids', re: /vit c kids|vitamin c za deca/, pick: () => '000597' },
  { id: 'vitCLiquid', re: /vitamin c - ?complex|vitamin c complex|liquid vitamin c|vit\.? ?c za vozrasni/, pick: (f) => { const v = ml(f); return v === null ? '000448' : v >= 1000 ? '000033' : v <= 250 ? '000604' : '000448'; } },
  { id: 'c1000', re: /\bc ?1000\b|vitamin c 1000|vitamin c-1000/, pick: () => '001054' },
  { id: 'chia', re: /chia therapy|chia terapija/, pick: (f) => (/dinj/.test(f) ? '000583' : /lubenic|lubeni\./.test(f) ? '000584' : '000652') },
  { id: 'immuno', re: /imm?uno bo?ost|imuno bust/, pick: (f) => (/portokal|ananas/.test(f) ? '000797' : '000796'), unsure: (f) => !/portokal|ananas|kapina/.test(f) },
  { id: 'isomax', re: /iso max|izo maks/, pick: () => '001033' },
  { id: 'sambucus', re: /sambucus|sambukus/, pick: () => '001159' },
  { id: 'elderberil', re: /elderberil/, pick: () => 'new:elderberil' },
  { id: 'allergo', re: /allergo protect|alergo protekt/, pick: () => 'new:allergo' },
  { id: 'noni', re: /\bnoni\b/, pick: () => 'new:noni' },
  { id: 'mushroom', re: /mushroom complex/, pick: () => 'new:mushroom' },
  { id: 'dietShots', re: /diet shots/, pick: () => 'new:dietshots' },
  { id: 'liquidCollagen', re: /liquid collagen|techen kolagen/, pick: () => '000605' },
  { id: 'beautyCollagen', re: /beauty collagen|bjuti kolagen/, pick: () => '000585' },
  { id: 'omega3', re: /omega 3/, pick: () => '000752' },
  { id: 'chlorophyll', re: /hlorofil|chlorophyll/, pick: () => '000456' },
  { id: 'aminoEnergy', re: /amino energy/, pick: () => 'SKU-000021' },
  // ── collagen / whey / sport powders ──
  { id: 'matcha', re: /matcha collagen|macha so kolagen|macha s kolagen/, pick: () => '001427' },
  { id: 'coconutCollagen', re: /collagen & coconut water/, pick: () => 'SKU-000089' },
  { id: 'collagenPeptides', re: /collagen peptides|kolagen peptid|\bcollagen 200g\b/, pick: (f) => ({ raspberry: '001023', chocolate: '001112', plain: '001113' }[flav(f)] ?? '000982'), flavourNote: true },
  { id: 'hyaluron5', re: /hyaluron 5|hialuron 5/, pick: () => '005033' },
  { id: 'wheyProtein', re: /whey|surutkin protein/, pick: (f) => {
    const g = grams(f); const fl = flav(f);
    if (g === 2000 || /\b2 ?kg\b/.test(f)) return fl === 'vanilla' ? '001318' : fl === 'chocolate' ? 'new:whey2kgchoc' : null;
    if (g === 1500) return fl === 'vanilla' ? 'SKU-000018' : fl === 'chocolate' ? 'SKU-000019' : null;
    if (g === 1200) return fl === 'vanilla' ? 'new:whey12van' : fl === 'chocolate' ? '001061' : null;
    if (g === 1000) return 'new:whey1kg';
    if (g === 500) return fl === 'vanilla' ? '001088' : fl === 'chocolate' ? '001087' : null;
    if (g === 400) return 'new:whey400';
    return null;
  }, unknownWhy: 'големина или вкус на whey не е наведен' },
  { id: 'massGainer', re: /mass gainer/, pick: () => 'new:massgainer' },
  { id: 'preWorkout', re: /pre-? ?workout/, pick: () => 'new:preworkout' },
  { id: 'iceCream', re: /protein ice cream|proteinski sladoled/, pick: () => 'new:icecream' },
  { id: 'creatine', re: /creatine|kreatin/, pick: () => '000953' },
  { id: 'bcaa', re: /\bbcaa\b/, pick: () => '000957' },
  { id: 'glutamine', re: /l-? ?glut(a|e)min/, pick: () => 'SKU-000056' },
  { id: 'carnitine', re: /l-? ?carnitine|l-karnitin/, pick: () => '000923' },
  // ── shakes ──
  { id: 'dietShake', re: /diet shake|diet shejk/, pick: (f) => ({ vanilla: '000889', strawberry: '000893', chocolate: '000891' }[flav(f)] ?? 'SKU-000079'), flavourNote: true },
  { id: 'nutriShake', re: /nutri shake|nutri shejk/, pick: (f) => ({ vanilla: '001227', strawberry: '001229', chocolate: '001228' }[flav(f)] ?? null), unknownWhy: 'вкусот на Nutri Shake не е наведен' },
  { id: 'nutriSoup', re: /nutri soup/, pick: (f) => (flav(f) === 'tomato' ? 'new:nutrisoupTom' : flav(f) === 'veg' ? 'new:nutrisoupVeg' : null), unknownWhy: 'вкусот на Nutri Soup не е наведен' },
  // ── slimming ──
  { id: 'drSlimPowder', re: /dr\.? ?slim powder|dr\.?slim rastitelen|dr\.?slim 210/, pick: (f) => (/rastitelen/.test(f) ? '001230' : '001026') },
  { id: 'drSlimCaps', re: /dr\.? ?slim caps|dr\.?slim 90/, pick: () => '001225' },
  { id: 'drSlim', re: /dr\.? ?slim/, pick: () => '001026', why: 'Dr. Slim во веб-продавницата е прашокот (се продава со маталка)' },
  { id: 'slimComplex', re: /slim complex|slim kompleks/, pick: () => 'SKU-000011' },
  { id: 'slimFiber', re: /slim fiber|slim fiber/, pick: () => '000616' },
  { id: 'glucomannan', re: /glukomann?an/, pick: () => '000616', weakWhy: 'Глукоманан е состојката на Slim Fiber, но во продавницата е посебен артикл' },
  { id: 'fiberFormula', re: /fiber formula|natural fiber/, pick: () => '001277' },
  { id: 'laxative', re: /laxative formula|natural laxative/, pick: () => '001293' },
  { id: 'nightBurn', re: /night burn/, pick: () => 'new:nightburn' },
  // ── capsules / tablets ──
  { id: 'prostatol', re: /prostatol/, pick: () => 'SKU-000066' },
  { id: 'snailCream', re: /snail complex cream|snail krema/, pick: () => '000040' },
  { id: 'snailComplex', re: /snail compl?(e|a)ks|snail complex|\bsnail\b(?! repair)/, pick: () => 'SKU-000060' },
  { id: 'diabetol', re: /di(j)?abetol/, pick: () => 'SKU-000063' },
  { id: 'alphaMale', re: /alpha male/, pick: (f) => (/bionatural/.test(f) ? '001315' : '001055'), why: 'веб-продавницата продава Natura Alpha Male 60 cps (Bionatural е друга линија)' },
  { id: 'tribulus', re: /tribulus|tribulus teres+tris|tribulus terrestis/, pick: (f) => (/60\s*(cps|\/1)/.test(f) ? '001076' : '000312') },
  { id: 'femme', re: /femme ?7/, pick: () => '001200' },
  { id: 'calm', re: /\bcalm\b/, pick: () => '001019' },
  { id: 'epimedium', re: /epimedium/, pick: () => '000325' },
  { id: 'ashwaGummy', re: /ashwagandha - gumeni|ashwagandha gumeni/, pick: () => 'new:ashwaGummy' },
  { id: 'ashwagandha', re: /ashwagandha|ashvaganda|ashwaganda/, pick: () => '001073' },
  { id: 'maca', re: /\bmaca\b|\bmaka\b/, pick: () => '001075' },
  { id: 'brainActive', re: /brain aktiv|brain active|brain 1\+1|brain aktiv/, pick: () => '000636' },
  { id: 'brainProtect', re: /brain protect|brein protekt/, pick: () => '000636', weakWhy: 'можеби преименуван Brain Active (ист опис во продавницата), не е потврдено' },
  { id: 'neuroActive', re: /neuro acti(ve|v)|neuro aktiv|nevro aktiv/, pick: () => '000166' },
  { id: 'greenTea', re: /green tea extract|zelen chaj ekstrakt|ekstrakt od zelen caj|zelen caj/, pick: (f) => (/60\s*(cps|\/1)/.test(f) ? '001074' : '000306') },
  { id: 'goji', re: /goji|godzhi/, pick: () => '000301', weakWhy: 'во каталогот е само „ЕКСТРАКТ ОД ЦРНО ГОЏИ“ (црно гоџи) — да се потврди дека е истиот' },
  { id: 'reishiCoffee', re: /reishi premium kafe/, pick: () => 'new:reishiCoffee' },
  { id: 'reishi', re: /reishi|reishi/, pick: () => 'SKU-000058' },
  { id: 'bilberry', re: /bill?berr?y|bilberi/, pick: (f) => (/90\s*(\/1)?\s*tab/.test(f) ? '001232' : '000523') },
  { id: 'spirulina', re: /spirulina/, pick: () => '000305', weakWhy: 'во каталогот е „СПИРУЛИНА КАПСУЛИ cps 60“ — продавницата продава таблети (друга форма)' },
  { id: 'citrus', re: /citrus bioflavonoids|citrus ekstrakt/, pick: () => '000313' },
  { id: 'resveratrol', re: /resveratrol/, pick: () => '000300' },
  { id: 'redRice', re: /red yeast( rice)?/, pick: () => 'new:redrice' },
  { id: 'cholestol', re: /cholestol|holestol/, pick: () => 'SKU-000067' },
  { id: 'hepatol', re: /hepatol/, pick: () => '000328' },
  { id: 'liverDetox', re: /liver detox|liver detoks/, pick: () => '001156' },
  { id: 'paraDetox', re: /para deto(x|ks)/, pick: () => 'SKU-000078' },
  { id: 'uroProtect', re: /uro protect|uro protekt/, pick: () => 'SKU-000062' },
  { id: 'dMannose', re: /d-? ?mann?oss?e|d-manoza/, pick: () => '000593' },
  { id: 'hemoroGel', re: /hemoro (forte )?gel/, pick: () => '005035' },
  { id: 'hemoroForte', re: /hemoro forte/, pick: () => '001058' },
  { id: 'venoGard', re: /veno gard/, pick: () => '001311' },
  { id: 'venogel', re: /venogel|veno gel/, pick: () => '000502' },
  { id: 'glucosamine', re: /glucosamin|glukozamin/, pick: () => '000273' },
  { id: 'glucatol', re: /glucatol|glukatol/, pick: (f) => (/180/.test(f) ? '001214' : '700100') },
  { id: 'bone', re: /bone protect/, pick: () => 'new:bone' },
  { id: 'osteoFix', re: /osteo fi(x|ks)/, pick: () => '001150' },
  { id: 'arthroBlue', re: /arthro blue|artro blu/, pick: () => '000949' },
  { id: 'arthroFlex', re: /arthro flex|artro fleks/, pick: () => '001239' },
  { id: 'tigerBalm', re: /tiger balm|tigrova mast/, pick: () => '000541' },
  { id: 'rrMelem', re: /r ?& ?r melem|r i r melem|melem r&r/, pick: () => 'SKU-000082', why: 'големината не е наведена → „R&R Melem“' },
  { id: 'antiInflamGel', re: /anti inflamatoren gel|anti-inflamatoren gel/, pick: () => '005042' },
  { id: 'kidsMulti', re: /kid'?s multivitamins|kids multivitamins/, pick: () => '001111' },
  { id: 'magGel', re: /magnesium gel|magnezium gel/, pick: (f) => ((ml(f) ?? 50) >= 250 ? '002366' : '001641') },
  { id: 'magBis', re: /magnesium bisglycinate/, pick: () => '001659' },
  { id: 'magZnB', re: /magnesium ?\+ ?(zinc|zink|zn) ?\+ ?b/, pick: () => '001575' },
  { id: 'magB6', re: /magnesium ?\+ ?b6/, pick: () => '001573' },
  { id: 'magnesium', re: /magnesium|magnesium citrat|magnezium/, pick: (f) => (/\b60\s*(tbl|\/1)|\(60tbl\)/.test(f) ? '001129' : '001571') },
  { id: 'd3k2', re: /d3 ?\+ ?k2( ?\+ ?bor)?|d3k2/, pick: () => '001630' },
  { id: 'd3Gummy', re: /vitamin d3 - gumeni|d3 gummies|d3 gumeni/, pick: () => 'new:d3Gummy' },
  { id: 'vitD3', re: /vitamin d3|vitamin d3|\bd3\b|\bd3 \(/, pick: (f) => ({ 30: '000942', 60: '000601', 90: '001152', 120: '001661', 180: '001110', 365: '001527' }[count(f) ?? 0] ?? '000942'), unsure: (f) => ![30, 60, 90, 120, 180, 365].includes(count(f)) },
  { id: 'vitB6', re: /vitamin b6|\bb6\b/, pick: (f) => ({ 30: '000944', 60: '000603', 120: '001660', 365: '001660' }[count(f) ?? 0] ?? '000944'), unsure: (f) => ![30, 60, 120, 365].includes(count(f)) },
  { id: 'melatoninGummy', re: /melatonin - gumeni/, pick: () => 'new:melatoninGummy' },
  { id: 'melatonin', re: /melatonin/, pick: (f) => ((count(f) ?? 30) >= 120 ? '001530' : '000941'), unsure: (f) => count(f) === null },
  { id: 'zincChrom', re: /zinc \+ chromium/, pick: () => 'new:zincChrom' },
  { id: 'zinc', re: /\bzin(c|k)\b|\bcink\b|zink\(/, pick: (f) => ({ 30: '000940', 60: '000602', 120: '001670', 365: '001529' }[count(f) ?? 0] ?? '000940'), unsure: (f) => ![30, 60, 120, 365].includes(count(f)) },
  { id: 'saw', re: /saw palmetto|palmetto/, pick: () => '000271' },
  { id: 'tongkat', re: /tongkat ali|tongakt ali/, pick: () => '001335' },
  { id: 'shilajit', re: /shilajit/, pick: () => '001333' },
  { id: 'nmn', re: /\bnmn\b/, pick: () => 'new:nmn' },
  { id: 'oxyjet', re: /oxy jet power/, pick: () => 'new:oxyjet' },
  { id: 'testoBooster', re: /natural testosterone booster/, pick: () => 'new:testobooster' },
  { id: 'maxBrain', re: /max brain/, pick: () => 'new:maxbrain' },
  { id: 'pulmo', re: /pulmo complex/, pick: () => 'new:pulmo' },
  { id: 'pms', re: /\bpms complex/, pick: () => 'new:pms' },
  { id: 'menopause', re: /menopause complex/, pick: () => 'new:menopause' },
  { id: 'autoimmune', re: /autoimmune support/, pick: () => 'new:autoimmune' },
  { id: 'andrographis', re: /andrographis/, pick: () => 'new:andrographis' },
  { id: 'bitterMelon', re: /bitter melon/, pick: () => 'new:bittermelon' },
  { id: 'acai', re: /acai berry/, pick: () => 'new:acai' },
  { id: 'oliveLeaf', re: /olive leaf/, pick: () => 'new:oliveleaf' },
  { id: 'quercetin', re: /quercetin/, pick: () => 'new:quercetin' },
  { id: 'royalJelly', re: /royal jelly/, pick: () => 'new:royaljelly' },
  { id: 'ginseng', re: /siberian ginseng/, pick: () => 'new:ginseng' },
  { id: 'nicotine', re: /nicotine protect/, pick: () => 'new:nicotine' },
  { id: 'antiChoke', re: /anti chocking device/, pick: () => 'new:antiChoke' },
  { id: 'magnumCooler', re: /magnum cooler/, pick: () => 'new:magnumCooler', weakWhy: 'непознат артикл (3 продажби по ~20.000 ден) — да се потврди што е' },
  { id: 'yogaMatTpe', re: /tpe yoga mat/, pick: () => 'new:yogaMatTpe' },
  { id: 'yogaMatPu', re: /pu rubber/, pick: () => 'new:yogaMatPu' },
  { id: 'foreverLina', re: /forever lina/, pick: () => 'new:foreverLina' },
  // ── Bionatural line (collabBox article names) ──
  // the Bionatural line — only catalogue / collabBox names carry these (used to spot catalogue duplicates)
  { id: 'adenofrin', re: /adenofrin/, pick: () => 'SKU-000076' },
  { id: 'neurofix', re: /neuro ?fix/, pick: () => 'SKU-000073' },
  { id: 'urofix', re: /uro ?fix/, pick: () => '001538' },
  { id: 'glucofix', re: /gluco ?fix/, pick: () => '001314' },
  { id: 'prostafix', re: /prosta ?fix/, pick: () => '001317' },
  { id: 'arthrofix', re: /arthro ?fix/, pick: () => '001313' },
  { id: 'cardiofix', re: /cardio ?fix/, pick: () => '001291' },
  { id: 'hemorofix', re: /hemoro ?fix/, pick: () => '001540' },
  { id: 'liverfix', re: /liver ?fix/, pick: () => '001537' },
  { id: 'parafix', re: /para ?fix/, pick: () => '001536' },
  { id: 'brainfix', re: /brain ?fix/, pick: () => '001316' },
  { id: 'slimfit', re: /slim ?fit\b/, pick: () => '001312' },
  { id: 'optiCare', re: /opti ?care/, pick: () => 'SKU-000090' },
];

/** Third-party cosmetics resold by the web shop: one catalogue product per distinct article. */
const THIRD_PARTY = /^(aura\b|aurafalse|wet n wild|prime focus|babe\b|bio:ve|dr\.? ?scheller|olival|cosmetics sponge)/;

/** Web-shop services (not physical products) — the owner decides whether they belong in the catalogue. */
const SERVICE = /yoga|joga|predizvik|\bfit ?15\b|fit fevruarski|lazarov transformation/;

/** Named web combos whose content the name does not state. */
const NAMED_COMBO = /terminator|hulk -|fit&lean|slimbox|adastra combo|novogodishen podarok|elixy combo paket|snail ?repair ?(collection)?combo|weight loss pack|magnum cooler(?!)/;

// ─── head / tail and promo tokens ───────────────────────────────────────────
/**
 * Cut the web shop's descriptive tail ("- препарат за …", ", заменски оброк …") from the ORIGINAL
 * spelling: the tail starts at a dash or comma followed by Cyrillic text or an English
 * description. A Latin continuation ("Vitamin C - Complex", "Melatonin - Gumeni bomboni",
 * "Terminator - Shredded Combo") is part of the name. Sizes and flavours are read from the
 * FULL folded name.
 */
export function headOf(name) {
  const t = decodeEntities(String(name ?? '')).toLowerCase();
  const m = t.match(/\s*[-—–]\s*(?=[\u0400-\u04ff])|\s[-—–]\s+(?=(preparation|nutritional|dietary|to |joint|meal|anti-cellulite|preparat)\b)|\s*,\s*(?=[\u0400-\u04ff])/);
  return fold(m ? t.slice(0, m.index) : t);
}
/** Pack multiplier guess (info only): (2+1) → 3, 30+30 → 2, 2x / 3 x / leading "3 " → N. */
export function packMultiplier(f) {
  let m = f.match(/\(?\s*(\d)\s*\+\s*(\d)\s*\)?/);
  if (m && Number(m[1]) <= 5 && Number(m[2]) <= 5) return Number(m[1]) + Number(m[2]);
  m = f.match(/\b(30|60|90|150)\s*\+\s*(30|60|90|150)\b/);
  if (m) return 2;
  m = f.match(/^(\d)\s*(x|х)\s*/) || f.match(/^(\d)\s+(?=[a-z])/) || f.match(/^(\d)x/);
  if (m) return Number(m[1]);
  m = f.match(/\((\d)\s*x\s*\d+\s*ml/);
  if (m) return Number(m[1]);
  return 1;
}

/**
 * Find every product mention in the head, most specific first, masking what matched.
 * Returns [{ entry, index, gift }].
 */
function mentions(head) {
  // pack patterns must not split segments: "(2+1)" → " pack "; discount codes are not products
  let h = ` ${head} `
    .replace(/\(\s*\d\s*\+\s*\d\s*(vegan|gratis)?\s*\)/g, ' pack ')
    .replace(/\b\d\s*\+\s*\d\b/g, ' pack ')
    .replace(/\b(30|60|90|150)\s*\+\s*(30|60|90|150)\b/g, ' pack ')
    .replace(/\+\s*(\d\s*)?koda?\b/g, ' ')
    .replace(/\bpack\s+(gratis|free)\b/g, ' pack ')
    .replace(/\(\s*(\d+\s*ml\s*\+\s*\d+\s*ml|\d+\s*\+\s*\d+\s*ml)\s*\)/g, ' ')
    .replace(/\(\s*\d+\s*x\s*\d+\s*ml\s*(\+\s*\d+\s*ml)?\s*\)/g, ' ');
  const giftAt = (() => { const m = h.match(/podarok|poarok|\bgift\b|free product|besplatno/); return m ? m.index : Infinity; })();
  const found = [];
  for (const entry of LEXICON) {
    const re = new RegExp(entry.re.source, 'g');
    let m;
    while ((m = re.exec(h)) !== null) {
      found.push({ entry, index: m.index });
      h = h.slice(0, m.index) + ' '.repeat(m[0].length) + h.slice(m.index + m[0].length);
      re.lastIndex = m.index + m[0].length;
    }
  }
  found.sort((a, b) => a.index - b.index);
  // segment by '+' / '&' (after the masking above) and decide gift status
  const cuts = [];
  for (let i = 0; i < h.length; i++) if (h[i] === '+' || h[i] === '&') cuts.push(i);
  const segOf = (i) => cuts.filter((c) => c < i).length;
  const segBounds = (s) => [s === 0 ? 0 : cuts[s - 1] + 1, s < cuts.length ? cuts[s] : h.length];
  const segRaw = (s) => { const [a, b] = segBounds(s); return h.slice(a, b); };   // masked: mentions blanked out
  for (const x of found) {
    const s = segOf(x.index);
    const seg = segRaw(s);
    x.gift = x.index > giftAt
      || (s > 0 && /\b(gratis|free|besplatno)\b|gratis/.test(seg))
      || /(podarok|gratis)\s*\)?\s*$/.test(seg.trim());                          // "… + масло од јојоба подарок"
  }
  // "… + A + B (подарок)" at the very end: everything after the first paid mention is a gift
  if (/\(podarok\)\s*$/.test(head.trim())) { let first = true; for (const x of found) { if (first && !x.gift) { first = false; continue; } x.gift = true; } }
  // a PAID '+' segment that names something the lexicon does not know ("+ elixy matcha face
  // cream 50ml") makes the name a bundle too
  const FILLER = /\b(pack|set|paket|kod|koda|gratis|free|podarok|poarok|gift|po izbor|podaroka|ml|l|g|gr|kg|mg|cps|caps|tbl|tab|tableti|kapsuli|x|fizichki|so|vkus|na|i|and|with|vanila|chokolado|jagoda|malina|bez|dinja|jabolka|lubenica|kapina|limon|limeta|lime|portokal|ananas|aronia|aronija|domat|zelenchuk|hlorofil|vegan|whey|kod-?a?|elixy|natura|extract|ekstrakt|complex|kompleks|gel|od|za)\b|[0-9%().,/+&'"-]/g;
  const unknownSegments = [];
  const withMention = new Set(found.map((x) => segOf(x.index)));
  for (let s = 0; s <= cuts.length; s++) {
    const [a] = segBounds(s);
    if (a > giftAt || withMention.has(s)) continue;               // after "подарок": a gift, whatever it is
    const seg = segRaw(s);
    if (/podarok|gratis|\bfree\b|poarok/.test(seg)) continue;
    const rest = seg.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    if (rest.length >= 4) unknownSegments.push(rest);
  }
  found.unknownSegments = unknownSegments;
  return found;
}

// ─── the classifier ─────────────────────────────────────────────────────────
/**
 * @param {string} name       one spelling of the line name
 * @param {object} ctx        { catalogue: [{id,name,sku,...}], bySku: Map, byExact: Map<exactKey,[product]>,
 *                              cbMap: Map<aliasNorm, collabBox map entry>, sources: Set<'crm'|'collabbox'|'web'>,
 *                              pickAmong: (products) => product }
 * @returns {{ kind, confidence, target: {sku?, newKey?, productId?}|null, reason, bundle, service,
 *            thirdParty, multiplier, components }}
 */
export function classifyName(name, ctx) {
  const f = fold(name);
  const out = { kind: 'product', confidence: 'none', target: null, reason: '', bundle: false, service: false, thirdParty: false, multiplier: packMultiplier(f), components: [] };

  const np = nonProductKind(name);
  if (np) return { ...out, kind: np.kind, confidence: 'exact', reason: np.rule, multiplier: 1 };
  if (/^test\b/.test(f)) return { ...out, reason: 'тест ставка во веб-продавницата — не е производ? (за сопственикот)' };

  // 1) the same name as a catalogue product
  const ek = exactKey(name);
  const same = ctx.byExact.get(ek);
  if (same?.length) {
    const p = ctx.pickAmong(same);
    return { ...out, confidence: 'exact', target: { sku: p.sku, productId: p.id, productName: p.name },
      reason: same.length > 1 ? `исто име како „${p.name}“ (во каталогот има ${same.length} исти имиња — избран најпродаваниот)` : `исто име како „${p.name}“ по нормализација/транслитерација`, multiplier: 1 };
  }
  // 2) the collabBox article code of this exact collabBox name is the catalogue SKU
  if (ctx.sources.has('collabbox')) {
    const e = ctx.cbMap.get(aliasNorm(name));
    if (e && e.product_id) {
      const p = ctx.bySku.get(String(e.collabbox_sku));
      if (p && p.id === e.product_id) {
        const nameOnly = /name only/.test(e.how || '');
        return { ...out, confidence: nameOnly ? 'strong' : 'exact', target: { sku: p.sku, productId: p.id, productName: p.name },
          reason: nameOnly
            ? `collabBox шифра ${e.collabbox_sku} = SKU на „${p.name}“, но големината на пакувањето во имињата се разликува`
            : `collabBox шифра ${e.collabbox_sku} = SKU на „${p.name}“ (мапа 12.08.2026, ${e.how})` };
      }
    }
  }
  // 3) web-shop services / named combos / third-party cosmetics
  if (SERVICE.test(f)) return { ...out, service: true, reason: 'услуга (јога / фитнес програма), не физички производ — дали да се води во каталогот?' };
  if (THIRD_PARTY.test(f)) return { ...out, thirdParty: true, confidence: 'none', target: { newKey: `tp:${aliasNorm(cleanSpelling(name))}`, thirdPartyName: cleanSpelling(name) },
    reason: 'козметика од друг производител, продавана во веб-продавницата — нов производ во каталогот' };

  const head = headOf(name);
  const ms = mentions(head);
  const isNamedCombo = NAMED_COMBO.test(f);
  if (!ms.length) {
    return { ...out, bundle: isNamedCombo, reason: isNamedCombo ? 'именуван пакет во веб-продавницата — содржината не е во името' : 'нема препознаен производ' };
  }
  const real = ms.filter((x) => !x.entry.accessory && !(x.entry.accessoryIfGift && x.gift));
  const paid = real.filter((x) => !x.gift);
  const bases = [...new Map(paid.map((x) => [x.entry.id, x])).values()];
  out.components = ms.map((x) => `${x.entry.id}${x.gift ? '(подарок)' : ''}${x.entry.accessory ? '(додаток)' : ''}`);

  let main;
  if (bases.length === 0) {
    // only gifts / accessories named: the first real mention (e.g. "jade roller & massager")
    if (isNamedCombo) return { ...out, confidence: 'weak', bundle: true, reason: 'именуван пакет во веб-продавницата — содржината не е во името' };
    main = real[0] ?? ms[0];
  } else main = bases[0];

  const pickRaw = main.entry.pick(f);
  const target = pickRaw === null || pickRaw === undefined ? null
    : String(pickRaw).startsWith('new:') ? { newKey: String(pickRaw).slice(4) } : { sku: String(pickRaw) };
  if (target?.sku) {
    const p = ctx.bySku.get(target.sku);
    if (!p) throw new Error(`lexicon ${main.entry.id}: SKU ${target.sku} is not in the catalogue`);
    target.productId = p.id; target.productName = p.name;
  }
  if (target?.newKey) target.productName = NEW_PRODUCTS[target.newKey].name;

  const tname = target?.productName ? `„${target.productName}“${target.newKey ? ' (НОВ)' : ''}` : '';
  const leadingMulti = /^\s*\d\s*x/.test(head);

  const unknownPaid = bases.length >= 1 && ms.unknownSegments.length > 0;
  if (bases.length >= 2 || isNamedCombo || bases.some((x) => x.entry.bundleOf) || unknownPaid) {
    const names = bases.map((x) => x.entry.id).concat(unknownPaid ? ms.unknownSegments.map((u) => `„${u}“`) : []).join(' + ');
    const n = bases.reduce((k, x) => k + (x.entry.bundleOf || 1), 0) + (unknownPaid ? ms.unknownSegments.length : 0);
    return { ...out, confidence: 'weak', bundle: true, target, components: out.components,
      reason: isNamedCombo ? `именуван пакет (${names || 'содржина непозната'}) — предлог: главниот производ ${tname}`
        : `пакет од ${n} платени производи (${names}) — предлог: првиот ${tname}` };
  }
  if (!target) {
    return { ...out, confidence: 'weak', target: null, reason: `${main.entry.id}: ${main.entry.unknownWhy || 'варијантата не може да се определи'}` };
  }
  if (main.entry.weakWhy) return { ...out, confidence: 'weak', target, reason: `${tname}: ${main.entry.weakWhy}` };
  if (main.entry.unsure?.(f)) return { ...out, confidence: 'weak', target, reason: `${tname}: пакувањето/варијантата не е наведена во името` };
  if (/\b(pack|paket|set|combo|kombo)\b/.test(head.replace(/\bpack\b/g, '')) && !leadingMulti) {
    return { ...out, confidence: 'weak', bundle: true, target, reason: `пакет/сет со непозната содржина — предлог ${tname}` };
  }

  const bits = [];
  if (out.multiplier > 1) bits.push(`пакување ×${out.multiplier}`);
  if (ms.some((x) => x.gift)) bits.push('+ подарок');
  if (ms.some((x) => x.entry.accessory && !x.gift)) bits.push('+ додаток (маталка/ролер)');
  if (main.entry.flavourNote && !flav(f)) bits.push('вкусот не е наведен → основниот вкус');
  if (main.entry.why) bits.push(main.entry.why);
  const isNew = !!target.newKey;
  return { ...out, confidence: isNew ? 'none' : 'strong', target,
    reason: isNew
      ? `нема во каталогот — нов производ ${tname}${bits.length ? ` (${bits.join(', ')})` : ''}`
      : `ист производ како ${tname}${bits.length ? ` — ${bits.join(', ')}` : ' — друго пишување'}` };
}

/**
 * The base product a CATALOGUE name stands for, as the lexicon's canonical SKU (or new:<key>).
 * Two catalogue rows with the same answer are the same physical product sold under two rows
 * ("Snail Complex" + "СНАИЛ КОМПЛЕКС cps 30") — reported to the owner, never merged here.
 */
export function canonicalOf(name) {
  const f = fold(name);
  if (/\+\s*\d/.test(f)) return null;   // a bundle article ("1 ГЛУТАМИН + 2 КРЕАТИН") is not a duplicate of its parts
  const ms = mentions(headOf(name)).filter((x) => !x.entry.accessory);
  if (ms.length !== 1) return null;
  try { const t = ms[0].entry.pick(f); return t ? String(t) : null; } catch { return null; }
}

/** Pack signature of a name (count · ml · g · Bionatural line) — two rows only duplicate when these do not conflict. */
export function sizeSig(name) {
  const f = fold(name);
  return { count: count(f), ml: ml(f), g: grams(f), bionatural: /bionatural/.test(f) };
}

/** Deterministic UUID for a new product (idempotent re-runs create nothing twice). */
export function stableUuid(seed, createHash) {
  const h = createHash('sha256').update(`elyon-mk:catalogue:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
