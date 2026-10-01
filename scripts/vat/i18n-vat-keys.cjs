// One-off (01.10.2026, per-product VAT — docs/VAT.md): adds the VAT keys to the four
// locales and removes the "18 % pending / confirmed" ones. Re-runnable (sets values).
// node scripts/vat/i18n-vat-keys.cjs
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'src', 'i18n', 'locales');

const K = {
  'insights.profit.step.vatPerProduct': {
    en: 'VAT per product (Sigma)', mk: 'ДДВ по производ (Сигма)', sq: 'TVSH sipas produktit (Sigma)', bg: 'ДДС по продукт (Сигма)',
  },
  'insights.profit.vat.part': { en: '{{pct}}: {{vat}}', mk: '{{pct}}: {{vat}}', sq: '{{pct}}: {{vat}}', bg: '{{pct}}: {{vat}}' },
  'insights.profit.vat.flat': {
    en: 'all at {{pct}} — per-product rates not loaded yet',
    mk: 'сè по {{pct}} — стапките по производ уште не се вчитани',
    sq: 'gjithçka me {{pct}} — normat sipas produktit ende nuk janë ngarkuar',
    bg: 'всичко по {{pct}} — ставките по продукт още не са заредени',
  },
  'insights.profit.vat.unclassified': {
    en: 'unclassified {{value}} at {{pct}}', mk: 'некласифицирано {{value}} по {{pct}}',
    sq: 'e paklasifikuar {{value}} me {{pct}}', bg: 'некласифицирано {{value}} по {{pct}}',
  },
  'insights.profit.vat.note': {
    en: 'VAT per product from Sigma: supplements {{low}}, cosmetics and devices {{high}}. {{value}} has no rate on file (MEX parcels without an order, lines without a product, products not classified yet) and is taxed at {{low}}.',
    mk: 'ДДВ по производ од Сигма: додатоците {{low}}, козметиката и уредите {{high}}. {{value}} нема стапка (MEX пратки без нарачка, ставки без производ, производи што уште не се класифицирани) и е пресметано со {{low}}.',
    sq: 'TVSH sipas produktit nga Sigma: suplementet {{low}}, kozmetika dhe pajisjet {{high}}. {{value}} nuk ka normë (dërgesa MEX pa porosi, rreshta pa produkt, produkte ende të paklasifikuara) dhe llogaritet me {{low}}.',
    bg: 'ДДС по продукт от Сигма: добавките {{low}}, козметиката и уредите {{high}}. {{value}} няма ставка (пратки MEX без поръчка, редове без продукт, още некласифицирани продукти) и е изчислено с {{low}}.',
  },
  'insights.profit.vat.noteAll': {
    en: 'VAT per product from Sigma: supplements {{low}}, cosmetics and devices {{high}}.',
    mk: 'ДДВ по производ од Сигма: додатоците {{low}}, козметиката и уредите {{high}}.',
    sq: 'TVSH sipas produktit nga Sigma: suplementet {{low}}, kozmetika dhe pajisjet {{high}}.',
    bg: 'ДДС по продукт от Сигма: добавките {{low}}, козметиката и уредите {{high}}.',
  },
  'insights.profit.table.vatAt': { en: 'of which at {{pct}}', mk: 'од тоа по {{pct}}', sq: 'prej saj me {{pct}}', bg: 'от него по {{pct}}' },
  'insights.profit.table.vatUnclassified': {
    en: 'of which unclassified (at {{pct}})', mk: 'од тоа некласифицирано (по {{pct}})',
    sq: 'prej saj e paklasifikuar (me {{pct}})', bg: 'от него некласифицирано (по {{pct}})',
  },
  'insights.profit.prod.vat': { en: 'VAT', mk: 'ДДВ', sq: 'TVSH', bg: 'ДДС' },
  'insights.profit.prod.otherCosts': { en: 'Courier + commission', mk: 'Курир + провизија', sq: 'Korrier + komision', bg: 'Куриер + комисионна' },
  'insights.profit.prod.vatNoRate': {
    en: 'no Sigma rate — at {{pct}}', mk: 'нема стапка од Сигма — по {{pct}}', sq: 'pa normë nga Sigma — me {{pct}}', bg: 'няма ставка от Сигма — по {{pct}}',
  },
  'insights.profit.prod.vatMixed': { en: 'mixed rates', mk: 'различни стапки', sq: 'norma të ndryshme', bg: 'различни ставки' },
  'insights.profit.quality.kind.vat_unclassified': {
    en: 'Sales without a Sigma VAT rate', mk: 'Продажби без стапка на ДДВ од Сигма',
    sq: 'Shitje pa normë TVSH nga Sigma', bg: 'Продажби без ставка на ДДС от Сигма',
  },
  'insights.profit.quality.hint.vat_unclassified': {
    en: 'Taxed at 5% (the supplements\' rate): MEX parcels with unknown contents, lines without a product, products with no rate yet. Set the rate in Products.',
    mk: 'Пресметани со 5% (стапката на додатоците): MEX пратки со непозната содржина, ставки без производ, производи без стапка. Поставете ја стапката во Производи.',
    sq: 'Llogariten me 5% (norma e suplementeve): dërgesa MEX me përmbajtje të panjohur, rreshta pa produkt, produkte pa normë. Vendosni normën te Produktet.',
    bg: 'Изчислени с 5% (ставката на добавките): пратки MEX с неизвестно съдържание, редове без продукт, продукти без ставка. Задайте ставката в Продукти.',
  },
  'insights.profit.quality.kind.vat_flat_default': {
    en: 'Per-product VAT is not active yet', mk: 'ДДВ по производ уште не е вклучен',
    sq: 'TVSH sipas produktit ende nuk është aktive', bg: 'ДДС по продукт още не е включен',
  },
  'insights.profit.quality.hint.vat_flat_default': {
    en: 'The database does not return per-product rates yet, so every sale is taxed at 5%.',
    mk: 'Базата уште не враќа стапки по производ, па секоја продажба е пресметана со 5%.',
    sq: 'Baza e të dhënave ende nuk kthen norma sipas produktit, prandaj çdo shitje llogaritet me 5%.',
    bg: 'Базата още не връща ставки по продукт, затова всяка продажба е изчислена с 5%.',
  },
  'insights.margins.floor.help': {
    en: 'Floor = (1 + the product\'s VAT) × (target {{target}} + cost + courier share + commission share); VAT per product from Sigma, included in the price.',
    mk: 'Минимум = (1 + ДДВ на производот) × (цел {{target}} + набавна + удел за курир + удел за провизија); ДДВ по производ од Сигма, вклучен во цената.',
    sq: 'Minimumi = (1 + TVSH e produktit) × (objektivi {{target}} + kosto + pjesa e korrierit + pjesa e komisionit); TVSH sipas produktit nga Sigma, e përfshirë në çmim.',
    bg: 'Минимум = (1 + ДДС на продукта) × (цел {{target}} + доставна цена + дял за куриер + дял за комисионна); ДДС по продукт от Сигма, включен в цената.',
  },
  'insights.margins.floor.vatAt': { en: 'at {{pct}}', mk: 'по {{pct}}', sq: 'me {{pct}}', bg: 'по {{pct}}' },
  'insights.margins.floor.vatNoRate': { en: 'no rate — {{pct}}', mk: 'без стапка — {{pct}}', sq: 'pa normë — {{pct}}', bg: 'без ставка — {{pct}}' },
  'insights.margins.sim.vat': { en: 'Product VAT', mk: 'ДДВ на производот', sq: 'TVSH e produktit', bg: 'ДДС на продукта' },
  'insights.margins.sim.vatFrom': { en: 'Sigma: {{pct}}', mk: 'Сигма: {{pct}}', sq: 'Sigma: {{pct}}', bg: 'Сигма: {{pct}}' },
  'insights.margins.sim.vatNone': { en: 'no rate on file: {{pct}}', mk: 'нема стапка: {{pct}}', sq: 'pa normë: {{pct}}', bg: 'няма ставка: {{pct}}' },
  'products.colVat': { en: 'VAT', mk: 'ДДВ', sq: 'TVSH', bg: 'ДДС' },
  'products.vat.all': { en: 'All', mk: 'Сите', sq: 'Të gjitha', bg: 'Всички' },
  'products.vat.none': { en: 'Unclassified', mk: 'Некласифицирано', sq: 'E paklasifikuar', bg: 'Некласифицирано' },
  'products.vat.setFor': { en: 'VAT for {{name}}', mk: 'ДДВ за {{name}}', sq: 'TVSH për {{name}}', bg: 'ДДС за {{name}}' },
  'products.vat.setForN': { en: 'VAT for {{n}} products', mk: 'ДДВ за {{n}} производи', sq: 'TVSH për {{n}} produkte', bg: 'ДДС за {{n}} продукта' },
  'products.vat.setVat': { en: 'Set VAT', mk: 'Постави ДДВ', sq: 'Vendos TVSH', bg: 'Задай ДДС' },
  'products.vat.hint5': { en: 'food supplements, food', mk: 'додатоци во исхраната, храна', sq: 'suplemente ushqimore, ushqim', bg: 'хранителни добавки, храни' },
  'products.vat.hint18': {
    en: 'cosmetics, gels, creams, oils, devices', mk: 'козметика, гелови, креми, масла, уреди',
    sq: 'kozmetikë, xhele, kremra, vajra, pajisje', bg: 'козметика, гелове, кремове, масла, уреди',
  },
  'products.vat.hint10': { en: 'reduced rate', mk: 'намалена стапка', sq: 'normë e reduktuar', bg: 'намалена ставка' },
  'products.vat.hint0': { en: 'exempt', mk: 'ослободено', sq: 'e përjashtuar', bg: 'освободено' },
  'products.vat.clear': { en: 'Unclassified (clear)', mk: 'Некласифицирано (исчисти)', sq: 'E paklasifikuar (pastro)', bg: 'Некласифицирано (изчисти)' },
  'products.vat.source': { en: 'Source', mk: 'Извор', sq: 'Burimi', bg: 'Източник' },
  'products.vat.src.crosswalk': {
    en: 'Sigma — linked item ({{conf}})', mk: 'Сигма — поврзан артикл ({{conf}})', sq: 'Sigma — artikull i lidhur ({{conf}})', bg: 'Сигма — свързан артикул ({{conf}})',
  },
  'products.vat.src.manual': {
    en: 'Sigma — link corrected by hand', mk: 'Сигма — врската е поправена рачно', sq: 'Sigma — lidhja u korrigjua me dorë', bg: 'Сигма — връзката е поправена ръчно',
  },
  'products.vat.src.byName': {
    en: 'Sigma — by the product name', mk: 'Сигма — според името на производот', sq: 'Sigma — sipas emrit të produktit', bg: 'Сигма — по името на продукта',
  },
  'products.vat.src.byNameMixed': {
    en: 'Sigma — by name; a bundle with items of both rates keeps its main product\'s rate',
    mk: 'Сигма — според името; пакет со производи од двете стапки ја зема стапката на главниот производ',
    sq: 'Sigma — sipas emrit; një paketë me artikuj të dy normave merr normën e produktit kryesor',
    bg: 'Сигма — по името; пакет с продукти от двете ставки взема ставката на основния продукт',
  },
  'products.vat.src.rule': {
    en: 'No Sigma item — by product type ({{rule}})', mk: 'Нема артикл во Сигма — според видот на производот ({{rule}})',
    sq: 'Pa artikull në Sigma — sipas llojit të produktit ({{rule}})', bg: 'Няма артикул в Сигма — по вида на продукта ({{rule}})',
  },
  'products.vat.src.owner': { en: 'Set by an owner', mk: 'Поставено од сопственик', sq: 'Vendosur nga një pronar', bg: 'Зададено от собственик' },
  'products.vat.sigmaItem': {
    en: 'Sigma item {{code}} · {{name}}', mk: 'Артикл во Сигма {{code}} · {{name}}', sq: 'Artikulli në Sigma {{code}} · {{name}}', bg: 'Артикул в Сигма {{code}} · {{name}}',
  },
  'products.vat.evidence': {
    en: 'Sales invoices 2025–2026 (Sigma)', mk: 'Излезни фактури 2025–2026 (Сигма)', sq: 'Faturat e shitjes 2025–2026 (Sigma)', bg: 'Изходящи фактури 2025–2026 (Сигма)',
  },
  'products.vat.evidenceYear': {
    en: '{{year}} at {{pct}}: {{n}} lines', mk: '{{year}} по {{pct}}: {{n}} ставки', sq: '{{year}} me {{pct}}: {{n}} rreshta', bg: '{{year}} по {{pct}}: {{n}} реда',
  },
  'products.vat.evidenceMex': {
    en: 'МЕКС ПОШТА invoices at {{pct}}: {{n}} lines', mk: 'Фактури за МЕКС ПОШТА по {{pct}}: {{n}} ставки',
    sq: 'Faturat e МЕКС ПОШТА me {{pct}}: {{n}} rreshta', bg: 'Фактури за МЕКС ПОШТА по {{pct}}: {{n}} реда',
  },
  'products.vat.setAt': { en: 'Set {{date}}', mk: 'Поставено {{date}}', sq: 'Vendosur {{date}}', bg: 'Зададено {{date}}' },
  'products.vat.savedTitle': { en: 'VAT saved', mk: 'ДДВ е зачуван', sq: 'TVSH u ruajt', bg: 'ДДС е запазен' },
  'products.vat.saved': {
    en: '{{rate}}: {{updated}} changed, {{unchanged}} already set', mk: '{{rate}}: {{updated}} променети, {{unchanged}} веќе беа така',
    sq: '{{rate}}: {{updated}} u ndryshuan, {{unchanged}} ishin tashmë kështu', bg: '{{rate}}: {{updated}} променени, {{unchanged}} вече бяха така',
  },
  'products.vat.note': {
    en: 'Every profit report uses it; a change is written to the audit log.',
    mk: 'Го користи секој извештај за добивка; промената се запишува во дневникот за ревизија.',
    sq: 'E përdor çdo raport fitimi; ndryshimi shënohet në regjistrin e auditimit.',
    bg: 'Използва се от всеки отчет за печалба; промяната се записва в одитния дневник.',
  },
  'products.vat.unclassifiedHint': {
    en: 'No rate — reports tax it at 5% and show it apart.', mk: 'Нема стапка — извештаите го пресметуваат со 5% и го прикажуваат одделно.',
    sq: 'Pa normë — raportet e llogaritin me 5% dhe e tregojnë veçmas.', bg: 'Няма ставка — отчетите го изчисляват с 5% и го показват отделно.',
  },
};

const REMOVE = [
  'insights.profit.chip.vatPending',
  'insights.profit.quality.kind.vat_unconfirmed',
  'insights.profit.quality.hint.vat_unconfirmed',
];

for (const lang of ['en', 'mk', 'sq', 'bg']) {
  const file = path.join(DIR, `${lang}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const json = JSON.parse(raw);
  for (const [key, vals] of Object.entries(K)) {
    const parts = key.split('.');
    let o = json;
    for (const p of parts.slice(0, -1)) {
      if (o[p] == null) o[p] = {};
      if (typeof o[p] !== 'object') throw new Error(`${lang}: ${key} — ${p} is not an object`);
      o = o[p];
    }
    if (!(lang in vals)) throw new Error(`${key}: no ${lang}`);
    o[parts[parts.length - 1]] = vals[lang];
  }
  for (const key of REMOVE) {
    const parts = key.split('.');
    let o = json;
    for (const p of parts.slice(0, -1)) o = o?.[p];
    if (o && parts[parts.length - 1] in o) delete o[parts[parts.length - 1]];
  }
  let out = JSON.stringify(json, null, 2) + '\n';
  if (crlf) out = out.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, out);
  console.log(`${lang}: ${Object.keys(K).length} keys set, ${REMOVE.length} removed`);
}
