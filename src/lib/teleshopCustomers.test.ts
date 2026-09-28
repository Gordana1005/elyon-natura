import { describe, it, expect } from 'vitest';
// The pure rules behind scripts/build-teleshop-customers.mjs → exports/teleshop/customers-clean.json,
// which scripts/import-teleshop-collabbox.mjs consumes. Every example below is a real shape from the
// 2026-09-10 collabBox crawl (komitenti_full.csv + the 10036 / 10050 document headers); names,
// phones and addresses are synthetic stand-ins with the same shape — never paste real ones back.
import {
  parseMkNumber, extractPhones, komitentPhones, analyzeName, readNotes, companyVerdict,
  buildCityIndex, cityKey, compareNames, buildTeleshopCustomers, placeholderWhy,
} from '../../scripts/lib/teleshop-customers.mjs';

type Row = Record<string, any>;

describe('parseMkNumber — strictly Macedonian, never rewritten', () => {
  it('accepts every spelling of a Macedonian number and returns the 8-digit national number', () => {
    const cases: Array<[string, string, string]> = [
      ['075111333', '75111333', 'mobile'],
      ['070/222-444', '70222444', 'mobile'],
      ['+389 75 111 333', '75111333', 'mobile'],
      ['0038975111333', '75111333', 'mobile'],
      ['38978333444', '78333444', 'mobile'],
      ['389078333444', '78333444', 'mobile'],
      ['78666111', '78666111', 'mobile'],          // the 0 dropped
      ['022777111', '22777111', 'landline'],       // Skopje
      ['42111555', '42111555', 'landline'],        // Gostivar, 0 dropped
      ['/034222666', '34222666', 'landline'],
      ['O76333888', '76333888', 'mobile'],         // letter O typed for the zero
    ];
    for (const [raw, p8, kind] of cases) {
      const r = parseMkNumber(raw);
      expect(r, raw).toMatchObject({ ok: true, p8, e164: `+389${p8}`, kind });
    }
  });
  it('rejects — with a reason — everything that is not provably Macedonian', () => {
    const cases: Array<[string, string]> = [
      ['07033344', 'too_short'],        // a digit missing (Телефон truncated)
      ['078 444 1', 'too_short'],
      ['0', 'too_short'],
      ['0722224444', 'too_long'],
      ['752226666', 'too_long'],
      ['017111444', 'not_mk_range'],    // 017 is no Macedonian prefix
      ['+381691114444', 'foreign'],     // Serbia — never turned into +38981…
      ['+355682223000', 'foreign'],
      ['070000000', 'placeholder_zeros'],
      ['070707070', 'placeholder_pattern'],
      ['070123456', 'placeholder_sequence'],
      ['77777777', 'placeholder_repeated'],
      ['3.59886e+11', 'scientific'],
    ];
    for (const [raw, why] of cases) expect(parseMkNumber(raw), raw).toMatchObject({ ok: false, why });
    expect(parseMkNumber('+381691114444')).toMatchObject({ country: 'RS' });
  });
  it('keeps vanity numbers (070333333) — real subscriptions, not placeholders', () => {
    expect(placeholderWhy('70333333')).toBeNull();
    expect(parseMkNumber('070333333')).toMatchObject({ ok: true, p8: '70333333' });
  });
});

describe('extractPhones — several numbers per field, numbers inside names', () => {
  it('splits two numbers in one field', () => {
    expect(extractPhones('070444777/ 032555888').found.map((f: Row) => f.p8)).toEqual(['70444777', '32555888']);
    expect(extractPhones('070555222 070666333').found.map((f: Row) => f.p8)).toEqual(['70555222', '70666333']);
  });
  it('rejects a truncated field value, keeping its raw text', () => {
    const r = extractPhones('075/888-1');
    expect(r.found).toEqual([]);
    expect(r.rejects[0]).toMatchObject({ raw: '075/888-1', why: 'too_short' });
    expect(extractPhones('/').rejects[0]).toMatchObject({ why: 'no_digits' });
  });
  it('in free text only phone-like runs count — ages, hours, card and house numbers are left alone', () => {
    expect(extractPhones('ЕЛКОВСКА ЕЛКА 071777222', { freeText: true }).found.map((f: Row) => f.p8)).toEqual(['71777222']);
    for (const t of ['ТОМАНИА ТОМОВСКА- 92 години', 'ДОСТАВА ОД 13ч-16ч', 'ИВАНА ИВАНОВА КАРТИЧКА 044455', 'ул Примерна бр 11/1/33 1000 Скопје']) {
      const r = extractPhones(t, { freeText: true });
      expect(r.found, t).toEqual([]);
      expect(r.rejects, t).toEqual([]);
    }
    expect(extractPhones('Tanka Tankaj-+355682223000', { freeText: true }).rejects[0]).toMatchObject({ why: 'foreign' });
  });
});

describe('komitentPhones — every field, mobile first', () => {
  it('orders mobiles before landlines and de-duplicates', () => {
    const r = komitentPhones({ Telefon: '022333777', Mobilen: '', Ime: 'Љубе Љубевски-070888111', Lice_kontakt: '022333777' });
    expect(r.phones.map((p: Row) => [p.p8, p.source])).toEqual([['70888111', 'name'], ['22333777', 'telefon']]);
  });
  it('rescues the full number an operator wrote into the name when Телефон is truncated', () => {
    const r = komitentPhones({ Telefon: '07177722', Ime: 'ЕЛКОВСКА ЕЛКА 071777222' });
    expect(r.phones.map((p: Row) => p.e164)).toEqual(['+38971777222']);
    expect(r.rejects).toEqual([{ raw: '07177722', field: 'telefon', why: 'too_short', nsn: '7177722' }]);
  });
  it('reads Факс / Лице за контакт / address numbers too', () => {
    expect(komitentPhones({ Faks: '072333555' }).phones[0]).toMatchObject({ p8: '72333555', source: 'faks' });
    expect(komitentPhones({ Adresa: 'Плоштад Примерен бр.3 БР ЗА КОНТАКТ 075444888' }).phones[0]).toMatchObject({ p8: '75444888', source: 'address' });
  });
});

describe('analyzeName — the person, notes and phones lifted out, typos repaired', () => {
  const nm = (s: string) => analyzeName(s).name;
  it('lifts operator notes out of the name', () => {
    expect(nm('НЕ КОНТАКТИРАЈ!!! Славка Славкова')).toBe('Славка Славкова');
    expect(nm('Соња Соневска - ДОСТАВА ДО 14Ч')).toBe('Соња Соневска');
    expect(nm('РИСТО РИСТЕВСКИ-Достава По 13 часот')).toBe('РИСТО РИСТЕВСКИ');
    expect(nm('Олга Олговска да не се контактира')).toBe('Олга Олговска');
    expect(nm('Ферикс Ферикси &#40;Пенка&#41;')).toBe('Ферикс Ферикси');
    expect(nm('Драгана Драганова - МАЈКА НА ЈАСМИНА')).toBe('Драгана Драганова');
    expect(nm('МИЛКА МИЛКОВСКА КОНТАКТ 070333666')).toBe('МИЛКА МИЛКОВСКА');
    expect(nm('Душанка Душанова 077555333 и 070777444')).toBe('Душанка Душанова');
    expect(analyzeName('Сунчица Сунчевска ВРАЌА НАРАЧКИ').name_note).toBe('ВРАЌА НАРАЧКИ');
  });
  it('never cuts a real name', () => {
    expect(nm('АЛИСА АЛИСОВСКА-МАРКОВСКА')).toBe('АЛИСА АЛИСОВСКА-МАРКОВСКА');
    expect(nm('Дане Даневски')).toBe('Дане Даневски');             // "Дане" is a first name, not "да не"
    expect(nm('Невена Невеновска')).toBe('Невена Невеновска');
    expect(nm('БлаГа Благоевска')).toBe('БлаГа Благоевска');         // not two glued words
  });
  it('repairs typing accidents', () => {
    expect(nm('МИЛИЦА МИЛИЦО0ВА')).toBe('МИЛИЦА МИЛИЦОВА');         // extra 0 next to О
    expect(nm('Грозде Гр0здевски')).toBe('Грозде Гроздевски');     // 0 typed for о
    expect(nm('ПАВЛИ9НКА ПАВЛОВСКА')).toBe('ПАВЛИНКА ПАВЛОВСКА');
    expect(nm('ТАШКО ТАШКОВ0')).toBe('ТАШКО ТАШКОВ');
    expect(nm('ДаниелаДаниелова')).toBe('Даниела Даниелова');
    expect(nm('Сократ сОКРАТОВСКИ')).toBe('Сократ Сократовски');     // caps lock
    expect(nm('Mенка Менковска')).toBe('Менка Менковска');           // Latin M → Cyrillic М
    expect(nm('С Т Р А Ш О')).toBe('СТРАШО');
  });
  it('knows junk, test and employee names', () => {
    for (const j of ['сссддфф', 'ј', 'BB BB', 'гфтрфгф']) expect(analyzeName(j).junk, j).toBe(true);
    for (const ok of ['Нана', 'Маре', 'Ѓорѓи']) expect(analyzeName(ok).junk, ok).toBe(false);
    expect(analyzeName('075222666')).toMatchObject({ name: '', junk: false });   // a number only: nameless, not junk
    expect(analyzeName('Маре').weak).toBe(true);
    for (const t of ['Test Accent', 'тест', 'Тест']) expect(analyzeName(t).test, t).toBe(true);
    expect(analyzeName('Ана Тестова').test).toBe(false);
    for (const e of ['ОПЕРАТОР Мартина Мартиновска', 'Теодора Теодоровска вработена', 'Александра - вработена']) expect(analyzeName(e).employee, e).toBe(true);
    expect(analyzeName('ЕФТО ЕФТОВСКИ-ДА НЕ СЕ КОНТАКТИРА ОД ОПЕРАТОР').employee).toBe(false);
  });
});

describe('readNotes — bans versus hints', () => {
  const m = (...t: string[]) => [...readNotes(t).markers].sort();
  it('reads every spelling of a ban', () => {
    for (const t of ['НЕ КОНТАКТИРАЈ!!!', 'да не се контактира', 'Н Е КОНТАКТИРАЈ!!!', 'ННЕ КОНТАКТИРАЈ!!', 'НЕ Коонтактирајте!!!!',
      'МАРИЈАНА МАРИЈАНОВСКА-ДАНЕ СЕ БАРААААА', 'не се јавувај!', 'не сака да го контактираме', 'ДЕМЕНТНА ОСОБА', 'СЛУЖБЕН БРОЈ НЕ БАРАЈ',
      'ne kontaktirajte', 'Да не се досага, жената е судија', 'да не се контактира од операторите на Натура, кумашинка ми е']) {
      expect(m(t), t).toContain('do_not_contact');
    }
    expect(m('ПОЧИНАТА')).toEqual(['deceased']);
    expect(m('Петко Петковски Починатио лице')).toEqual(['deceased']);
    expect(m('Еленка Еленкова погрешен број')).toEqual(['wrong_number']);
    expect(m('не барај бројот е променет не е тој клиент на овој број')).toEqual(['do_not_contact', 'wrong_number']);
    expect(m('НЕ ПРАЌАЈ!!! Аленка Аленковска')).toEqual(['do_not_ship']);
    expect(m('дементна да не и се прати')).toContain('do_not_ship');
  });
  it('an hour window is a hint, not a ban', () => {
    const r = readNotes(['БИЛЈАНА БИЛЈАНОВИЌ ДА НЕ И СЕ ЗВОНИ ОД 14 - 17 ЧАСОТ']);
    expect([...r.markers]).toEqual([]);
    expect(r.call_window).toBe(true);
  });
  it('returns and delivery notes are flags only', () => {
    const r = readNotes(['Сунчица Сунчевска ВРАЌА НАРАЧКИ']);
    expect([...r.markers]).toEqual([]);
    expect(r.returns).toBe(true);
    expect(readNotes(['Анита Анитова ДОСТАВА ОД 13ч-16ч']).delivery).toBe(true);
    expect([...readNotes(['Дане Даневски', 'Невенка Невенкова']).markers]).toEqual([]);
  });
});

describe('companyVerdict', () => {
  it('finds legal entities and institutions', () => {
    for (const n of ['Меди Фарм Куманово', 'Дом за стари лица ПУСЗ Нана', 'КЕМО ФАРМАЦИЈА ПЛУС', 'хотел Премиум Хоме', 'Маријан Автосервис Мерцедес', 'Бисер ДООЕЛ']) {
      expect(companyVerdict({ Ime: n }).company, n).toBe(true);
    }
    expect(companyVerdict({ Ime: 'Петре Петров', Danocen_broj: '4030999123456' }).company).toBe(true);
  });
  it('is not fooled by a store in a loyalty note or a note in the tax-number field', () => {
    expect(companyVerdict({ Ime: 'ДЕЛЧЕ ДЕЛЧЕВСКИ поените му се префрлени во продавница и од генера' }).company).toBe(false);
    expect(companyVerdict({ Ime: 'САШКО САШКОВ ПОЕНИТЕ МУ СЕ ПРЕФРЛЕНИ ВО АЕРОДРОМ ПРОДАВНИЦА' }).company).toBe(false);
    expect(companyVerdict({ Ime: 'Веса Весевска', Danocen_broj: 'НЕ ЈА БАРАЈТЕ' }).company).toBe(false);
    expect(companyVerdict({ Ime: 'ЈАСМИНКА (СЛАВЈАН ОД ЕВН) ЈАСМИНОВСКА' }).company).toBe(false);
  });
});

describe('cityKey — the mk_city_key twin', () => {
  const idx = buildCityIndex([
    { id: 'a', name_norm: 'skopje', kind: 'city', parent_norm: null },
    { id: 'b', name_norm: 'aerodrom', kind: 'city_district', parent_norm: 'skopje' },
    { id: 'c', name_norm: 'bitola', kind: 'city', parent_norm: null },
  ]);
  it('folds scripts, districts and the MEX "City - District" form', () => {
    expect(cityKey('Скопје', idx)).toEqual({ key: 'skopje', known: true });
    expect(cityKey('Skopje - Aerodrom', idx)).toEqual({ key: 'skopje', known: true });
    expect(cityKey('Аеродром', idx)).toEqual({ key: 'skopje', known: true });
    expect(cityKey('Bitola', idx)).toEqual({ key: 'bitola', known: true });
    expect(cityKey('Странство', idx)).toEqual({ key: 'stranstvo', known: false });
    expect(cityKey('', idx)).toEqual({ key: null, known: false });
  });
});

describe('compareNames — script-, gender-, spacing- and typo-blind', () => {
  it('matches', () => {
    expect(compareNames('Бранко Бранков', 'Branko Brankov')).toBe('same');
    expect(compareNames('Весна Весновска', 'Vesnavesnovska')).toBe('same');
    expect(compareNames('Марковска Марија', 'Marija Markovski')).toBe('same');
    expect(compareNames('Анѓелија Анѓеловиќ', 'Anǵelija Anǵelovikj')).toBe('same');
    expect(compareNames('ЕСМА ЕСМОВИЧ', 'Едма Есмовиќ')).toBe('same');
    expect(compareNames('Гордана Гордановска', 'Gordana')).toBe('partial');
    expect(compareNames('Сариоски Саре', 'Саријоска Благојка')).toBe('partial');
    expect(compareNames('Борис Борисовски', 'Jovan Jovanovski')).toBe('different');
    expect(compareNames('', 'Jovan')).toBe('unknown');
  });
});

// ─── the whole pass on a small fixture ─────────────────────────────────────
const K = (o: Row) => ({ Sifra: '', VnatresenID: '', Ime: '', Ime_lat: '', Adresa: '', Adresa_lat: '', Grad: 'Скопје', Drzava: 'Македонија', Datum_raganje: '',
  Telefon: '', Mobilen: '', Email: '', Ziro_smetka: '', Broj_kartica: '', Danocen_broj: '', Faks: '', Lice_kontakt: '', DDV_broj: '', EMBS: '', Vraboten: 'Не', ...o });
let docNo = 1;
const D = (komitent: string, o: Row = {}) => ({ DocNumber: `002-9102-${docNo++}/2025`, TipID: '10050', KomitentID: komitent, Komitent: '', Iznos: '2,000.00', Datum: '10.05.2025 10:00:00', Avtor: 'Оператор Прва', ...o });

function fixture() {
  const komitenti = [
    K({ Sifra: '17720', Ime: 'Валентина Валентинова', Grad: 'Прилеп', Telefon: '075666999', Vraboten: 'Да' }),  // legacy register: Да is stale
    K({ Sifra: '168249', Ime: 'Верица Верицова', Telefon: '070111444', Vraboten: 'Да' }),                   // current register: employee
    K({ Sifra: '117638', Ime: 'Анита Анитевска', Telefon: '075777333' }),                                    // operator account
    K({ Sifra: '54381', Ime: 'МАРИЈА МАРИЈОВСКА', Grad: 'Прилеп', Telefon: '077222555' }),                  // one self-authored doc: customer
    K({ Sifra: '120001', Ime: 'Марко Марковски', Telefon: '071 111 222' }),                                  // same phone, 2 komitenti
    K({ Sifra: '120002', Ime: 'МАРКО МАРКОВСКИ', Telefon: '+38971111222' }),
    K({ Sifra: '120010', Ime: 'Сузана Сузановска', Telefon: '072222333' }),                                  // ban on one → both
    K({ Sifra: '120011', Ime: 'Сузана Сузановска НЕ КОНТАКТИРАЈ!', Telefon: '072222333' }),
    K({ Sifra: '120020', Ime: 'Еленка Еленкова погрешен број', Telefon: '076444555' }),                     // wrong number: not spread
    K({ Sifra: '120021', Ime: 'Петар Петров', Telefon: '076444555' }),
    K({ Sifra: '120030', Ime: 'Горан Горановски', Grad: 'Битола', Telefon: '078555666' }),                 // in the CRM
    K({ Sifra: '120040', Ime: 'Тест', Telefon: '070123456' }),                                                // test + owner's test phone
    K({ Sifra: '120041', Ime: 'Нада Надевска', Telefon: '023123123' }),                                       // owner's test phone
    K({ Sifra: '120050', Ime: 'Ана Анева', Telefon: '077888999' }),                                           // only a 0-value doc
    K({ Sifra: '120060', Ime: 'Бобан Бобевски', Telefon: '022555666', Mobilen: '070999888' }),              // landline known to the CRM
    K({ Sifra: '120070', Ime: 'Меди Фарм Куманово', Telefon: '078111999' }),
    K({ Sifra: '120080', Ime: 'Лидија Лидијоска', Telefon: '07033344' }),                                    // truncated: no valid phone
  ];
  const docs = [
    D('17720'), D('168249', { Avtor: 'Верица Верицова' }),
    D('117638', { Avtor: 'Анита Анитевска' }), D('117638', { Avtor: 'Анита Анитевска' }), D('117638'),
    D('54381', { Avtor: 'Марија Маријовска' }), D('54381'), D('54381'),
    D('120001', { Datum: '01.02.2024 10:00:00' }), D('120002', { Datum: '01.02.2026 10:00:00' }),
    D('120010'), D('120011'), D('120020'), D('120021'), D('120030'), D('120040'), D('120041'),
    D('120050', { Iznos: '0.00' }), D('120050', { DocNumber: '002-9103-1/2025' }),
    D('120060'), D('120070'), D('120080'), D('999999', { Komitent: 'Непознат Коминтент' }),
    { DocNumber: '002-9110-1/2025', TipID: '10111', KomitentID: '120030', Iznos: '1,000.00', Datum: '01.01.2025 10:00:00', Avtor: 'x' }, // not a teleshop type
  ];
  const crm = [
    { p8: '78555666', top_phone: '+38978555666', n: 3, n_spellings: 1, last_name: 'Goran Goranovski', names: ['Goran Goranovski'], last_city: 'Skopje',
      cities_trusted: null, cities_cpa: ['Skopje'], mex_cities: ['Bitola'], paid: 2, trashed: 0, wrong: 0, cb: 0, first_at: '2025-01-01', last_at: '2026-01-01' },
    { p8: '22555666', top_phone: '+38922555666', n: 1, n_spellings: 1, last_name: 'Бобан Бобевски', names: ['Бобан Бобевски'], last_city: 'Skopje',
      cities_trusted: null, cities_cpa: ['Skopje'], mex_cities: null, paid: 1, trashed: 0, wrong: 0, cb: 0 },
  ];
  const settlements = [
    { id: '1', name_norm: 'skopje', kind: 'city', parent_norm: null }, { id: '2', name_norm: 'bitola', kind: 'city', parent_norm: null },
    { id: '3', name_norm: 'prilep', kind: 'city', parent_norm: null },
  ];
  return buildTeleshopCustomers({ komitenti, docs, crm, profiles: [], excludedPhone8s: ['70123456', '23123123'], settlements });
}

describe('buildTeleshopCustomers', () => {
  const { rows, stats } = fixture();
  const by = (id: string) => rows.find((r: Row) => r.komitent_id === id) as Row;

  it('covers exactly the komitenti on teleshop documents', () => {
    expect(rows.map((r: Row) => r.komitent_id)).toEqual(['17720', '54381', '117638', '120001', '120002', '120010', '120011', '120020', '120021',
      '120030', '120040', '120041', '120050', '120060', '120070', '120080', '168249', '999999']);
    expect(stats.komitenti).toBe(18);
  });
  it('Vraboten = Да is stale on the legacy register, real above it', () => {
    expect(by('17720')).toMatchObject({ status: 'import', reason: 'new_customer', customer_phone: '+38975666999' });
    expect(by('17720').flags).toContain('legacy_vraboten_da');
    expect(by('168249')).toMatchObject({ status: 'skip', reason: 'employee' });
  });
  it('an operator writing orders on her own name is an operator account; one self-written doc is not', () => {
    expect(by('117638')).toMatchObject({ status: 'skip', reason: 'operator_account' });
    expect(by('54381')).toMatchObject({ status: 'import' });
    expect(by('54381').flags).toContain('name_matches_own_author');
  });
  it('one phone = one customer: the most recent complete name, every komitent id listed', () => {
    for (const id of ['120001', '120002']) {
      expect(by(id)).toMatchObject({ status: 'import', reason: 'new_customer_merged', phone8: '71111222', customer_phone: '+38971111222', customer_name: 'МАРКО МАРКОВСКИ' });
      expect(by(id).group).toMatchObject({ size: 2, komitent_ids: ['120001', '120002'], canonical_komitent_id: '120002', names_agree: 'same' });
    }
    expect(stats.customers.komitenti_folded).toBe(1);
  });
  it('a ban on one komitent covers the phone; "wrong number" does not', () => {
    expect(by('120011')).toMatchObject({ status: 'skip', reason: 'do_not_contact', name: 'Сузана Сузановска' });
    expect(by('120010')).toMatchObject({ status: 'skip', reason: 'phone_marked_do_not_contact' });
    expect(by('120020')).toMatchObject({ status: 'skip', reason: 'wrong_number' });
    expect(by('120021')).toMatchObject({ status: 'import' });
    expect(by('120021').flags).toContain('phone_marked_wrong_number_elsewhere');
  });
  it('an existing CRM customer is merged under the CRM phone, with name / city agreement', () => {
    expect(by('120030')).toMatchObject({ status: 'merge_existing', reason: 'existing_crm_customer', customer_phone: '+38978555666' });
    expect(by('120030').crm).toMatchObject({ name_match: 'same', city_match: 'same', city_source: 'trusted', orders: 3 });
  });
  it('prefers the number the CRM already knows over a new mobile, so no customer is split', () => {
    expect(by('120060')).toMatchObject({ status: 'merge_existing', customer_phone: '+38922555666', phone8: '22555666' });
    expect(by('120060').phones).toEqual(['+38970999888', '+38922555666']);
    expect(by('120060').flags).toContain('primary_by_crm_match');
    expect(by('120060').crm.city_match).toBe('same');
  });
  it("skips the owner's test phones, companies, junk and phoneless komitenti — with the reason", () => {
    expect(by('120040')).toMatchObject({ status: 'skip', reason: 'test_name' });
    expect(by('120040').reasons).toContain('owner_test_phone');
    expect(by('120041')).toMatchObject({ status: 'skip', reason: 'owner_test_phone' });
    expect(by('120070')).toMatchObject({ status: 'skip', reason: 'company' });
    expect(by('120080')).toMatchObject({ status: 'skip', reason: 'no_valid_phone' });
    expect(by('120080').phone_rejects).toEqual([{ raw: '07033344', field: 'telefon', why: 'too_short', nsn: '7033344' }]);
    expect(by('120050')).toMatchObject({ status: 'skip', reason: 'no_teleshop_order_document' });
    expect(by('999999')).toMatchObject({ status: 'skip', reason: 'not_in_registry', name: 'Непознат Коминтент' });
  });
  it('never emits a non-skipped row without a canonical +389 phone', () => {
    for (const r of rows.filter((x: Row) => x.status !== 'skip')) {
      expect(r.phone_e164, r.komitent_id).toMatch(/^\+389\d{8}$/);
      expect(r.customer_phone, r.komitent_id).toBeTruthy();
    }
    for (const r of rows.filter((x: Row) => x.status === 'skip')) expect(r.customer_phone).toBeNull();
  });
});
