import { describe, it, expect } from 'vitest';
// The handoff between the two teleshop scripts and the importer's pure rules:
//   scripts/build-teleshop-customers.mjs → exports/teleshop/customers-clean.json → adaptCustomersClean()
//   the product-lines fetch → exports/teleshop/items-*-summary.json         → adaptItemsSummary()
// consumed by scripts/import-teleshop-collabbox.mjs. The row shapes below are the real ones those
// files carry (2026-09-28); names, phones and addresses are synthetic — never paste real ones back.
import {
  adaptCustomersClean, adaptItemsSummary, mkPhone8, parseCbDatum, parseIsoLocal, engineClassify,
  cohortOrderBucket, cohortParcelBucket, statusFromParcel, codFitsAmount, nameMarker, MKD_PER_EUR, cleanSkip,
} from '../../scripts/lib/teleshop-import.mjs';
import {
  APPLY_PHASES, ROLLBACK_ORDER, buildCustomers, buildCreateChunkSql, buildRollbackChunkSql, buildRollbackMarkersSql,
  buildRollbackLinksSql, buildRollbackRelabelSql, buildRollbackProfilesSql, planLine,
} from '../../scripts/import-teleshop-collabbox.mjs';
import { analyzeName, readNotes } from '../../scripts/lib/teleshop-customers.mjs';

const RUN = 'bbbbbbbb-0000-0000-0000-000000000001';

describe('review 28.09 — resume, markers first, complete rollback, no agent identity', () => {
  const plan = (over: Record<string, any> = {}) => ({
    doc_number: '002-9102-1/2026', type_id: '10050', series: '9102',
    doc: { doc_id: '1', doc_at: '2026-05-01T12:00:00.000Z', komitent_id: 'K1', author: 'Ружица  Ружевска', source: 'items' },
    amount: 2000, price: 32.52, phone8: '70111111', phone_src: 'registry', phone: '+38970111111', match: 'new',
    k: { komitent_id: 'K1', name: 'Нов Клиент', city: 'Скопје', address: 'ул. 1', p8: '70111111', skip: null },
    status: 'paid', basis: 'mex', paid_at: '2026-05-04T10:00:00Z', shipped_at: '2026-05-02T08:00:00Z', returned_at: null,
    tracking: '002-9102-1/2026', remember_tracking: false, parcel: { status_id: 2, cod_mkd: 2000 }, flags: [],
    product_name: 'X', product_id: null, qty: 1, items: null, reason: 'parcel_paid', author: 'Ружица  Ружевска', outcome: 'created', ...over,
  });

  it('#2 the apply writes the trash markers FIRST', () => {
    expect(APPLY_PHASES[0]).toBe('markers');
    expect(APPLY_PHASES.indexOf('markers')).toBeLessThan(APPLY_PHASES.indexOf('orders'));
  });

  it('#1 resume: a document this run already created (now "exists") still gives its komitent a customer + profile', () => {
    const first = buildCustomers([plan()], new Map(), new Map());
    expect(first[0]).toMatchObject({ outcome: 'new', created_orders: 1, profile_action: 'inserted', customer_phone: '+38970111111' });
    const resumed = buildCustomers([plan({ outcome: 'exists', reason: 'order_exists', phone: null, match: null })], new Map(), new Map(),
      () => true, new Map([['002-9102-1/2026', { phone: '+38970111111', match: 'new' }]]));
    expect(resumed[0]).toMatchObject({ outcome: 'new', created_orders: 1, profile_action: 'inserted', customer_phone: '+38970111111' });
  });

  it('#1 the plan hash never contains links (a link the run made cannot break its resume)', () => {
    const line = planLine(plan({ outcome: 'exists', reason: 'order_exists' }));
    expect(line).toBe(planLine(plan({ outcome: 'exists', reason: 'order_exists' })));
    expect(line.startsWith('002-9102-1/2026|exists|order_exists|')).toBe(true);
  });

  it('#3 rollback: markers first, then orders, links, relabels (with their notes), profiles by profile_run_id', () => {
    expect([...ROLLBACK_ORDER]).toEqual(['markers', 'orders', 'links', 'relabels', 'profiles']);
    expect(buildRollbackMarkersSql({ runId: RUN, ids: [RUN] })).toMatch(/delete from public\.orders .*external_source = 'teleshop_import'/);
    expect(buildRollbackChunkSql({ runId: RUN, ids: [RUN] })).toMatch(/profile_run_id = /);
    expect(buildRollbackLinksSql({ runId: RUN })).toMatch(/update public\.mex_parcels m set order_id = null/);
    const rl = buildRollbackRelabelSql({ runId: RUN });
    expect(rl).toMatch(/elyon\.allow_source_change = 'on'/);
    expect(rl).toMatch(/delete from public\.order_notes/);
    const pr = buildRollbackProfilesSql({ runId: RUN });
    expect(pr).toMatch(/t\.profile_run_id = /);
    expect(pr).toMatch(/delete from public\.customer_profiles/);
  });

  it('#4 imported orders carry the seller in sold_* only — never confirmed_by_name / an agent', () => {
    const sqlText = buildCreateChunkSql({ runId: RUN, chunk: [plan()] });
    const cols = sqlText.slice(sqlText.indexOf('insert into public.orders ('), sqlText.indexOf(')', sqlText.indexOf('insert into public.orders (')));
    expect(cols).toContain('sold_by_person_id');
    expect(cols).toContain('sold_via');
    expect(cols).not.toContain('confirmed_by_name');
    expect(cols).not.toContain('confirmed_by_agent_id');
    expect(cols).not.toContain('assigned_agent');
    expect(sqlText).toMatch(/carry an agent-facing identity/);
  });

  it('#5 --vraboten-literal reaches the customers-clean branch; #3 owner: do-not-contact imported, deceased never', () => {
    const legacy = { skip: null, flags: ['legacy_vraboten_da'] };
    expect(cleanSkip(legacy).skip).toBeNull();
    expect(cleanSkip(legacy, { vrabotenLiteral: true }).skip).toBe('employee');
    expect(cleanSkip({ skip: 'do_not_contact', flags: [] }, { bannedAsTrash: true })).toEqual({ skip: null, ban: 'do_not_contact' });
    expect(cleanSkip({ skip: 'phone_marked_do_not_contact', flags: [] }, { bannedAsTrash: true })).toEqual({ skip: null, ban: 'do_not_contact' });
    expect(cleanSkip({ skip: 'deceased', flags: [] }, { bannedAsTrash: true })).toEqual({ skip: 'deceased', ban: 'deceased' });
    expect(cleanSkip({ skip: 'do_not_contact', flags: [] })).toEqual({ skip: 'do_not_contact', ban: 'do_not_contact' });
  });

  it('#6 an operator note never becomes a customer name ("врака", glued, "несака да…")', () => {
    for (const raw of ['ГИ ВРАКАААА НАРАЧКИТЕ', 'Ги Врака Нарачките', 'ГИ ВРАКА СИТЕ НАРАЧКИ', 'Врака НАРАЧКИ']) {
      expect(analyzeName(raw).name, raw).toBe('');
      expect(readNotes([raw]).returns, raw).toBe(true);
    }
    expect(analyzeName('Mенка МенковскаВРАЌА НАРАЧКИ').name).toBe('Менка Менковска');
    expect(readNotes(['Mенка МенковскаВРАЌА НАРАЧКИ']).returns).toBe(true);
    expect(analyzeName('ИВАНА ИВАНЕСКИ несака да се контактира').name).toBe('ИВАНА ИВАНЕСКИ');
    expect([...readNotes(['ЗВОНКО ЗВОНКОВСКИ несакка да му звониме']).markers]).toContain('do_not_contact');
    expect([...readNotes(['ОЛИВЕРА ОЛИВЕРОВАнесака да и се звони']).markers]).toContain('do_not_contact');
    expect(analyzeName('Николина Завракова').name).toBe('Николина Завракова');     // "врак" inside a surname is not a note
    expect(readNotes(['Звонимир Звонимировски']).markers.size).toBe(0);
  });
});

const DAY = 86_400_000;

describe('adaptCustomersClean — customers-clean.json → the importer', () => {
  const file = {
    rules: 'teleshop-customers v1 (2026-09-28)',
    stats: {},
    customers: [
      { komitent_id: '45910', status: 'import', reason: 'new_customer', reasons: [], flags: [],
        name: 'Борко Борковски', customer_phone: '+38975111333', phone_e164: '+38975111333', phone8: '75111333',
        city: 'Скопје', address: 'Ул.Примерна бр.18а', crm: null },
      { komitent_id: '51642', status: 'merge_existing', reason: 'existing_crm_customer', reasons: [], flags: ['crm_phone_noncanonical'],
        name: 'Живка Живкова', customer_phone: '+38938076222888', phone_e164: '+38976222888', phone8: '76222888',
        city: 'Скопје', address: null, crm: { phone: '+38938076222888', orders: 4 } },
      { komitent_id: '43729', status: 'merge_existing', reason: 'existing_crm_customer', reasons: [], flags: [],
        name: 'Павлина Павлинова', customer_phone: '+38971444999', phone_e164: '+38971444999', phone8: '71444999',
        city: 'Скопје', address: null, crm: { phone: '+38971444999', orders: 9 } },
      { komitent_id: '42513', status: 'skip', reason: 'deceased', reasons: ['deceased'], flags: ['returns_orders'],
        name: 'ПОЧИНАТА', customer_phone: null, phone_e164: '+38978777111', phone8: '78777111', city: 'Скопје', crm: { phone: '+38978777111', orders: 43 } },
      { komitent_id: '124424', status: 'skip', reason: 'test_name', reasons: ['test_name'], flags: [],
        name: 'Test Accent', customer_phone: null, phone_e164: '+38971888333', phone8: '71888333' },
    ],
  };
  const m = adaptCustomersClean(file);

  it('reads every komitent, keyed by its collabBox id', () => {
    expect(m.size).toBe(5);
    expect([...m.keys()]).toEqual(['45910', '51642', '43729', '42513', '124424']);
  });

  it('a new customer: importable, clean E.164, match new', () => {
    expect(m.get('45910')).toMatchObject({ skip: null, match: 'new', phone: '+38975111333', p8: '75111333', city: 'Скопје' });
  });

  it('an existing customer keeps the CRM phone when it is a clean E.164', () => {
    expect(m.get('43729')).toMatchObject({ skip: null, match: 'existing', phone: '+38971444999', in_crm: true });
  });

  it('NEVER writes a malformed CRM phone string onto an order — the clean E.164 instead', () => {
    const r = m.get('51642');
    expect(r.phone).toBe('+38976222888');
    expect(r.match).toBe('existing_noncanonical');
    expect(r.crm_phone).toBe('+38938076222888');            // kept only to find the old identity
  });

  it('a skip keeps its reason, its flags and its phone (for a ban marker on the CRM identity)', () => {
    expect(m.get('42513')).toMatchObject({ skip: 'deceased', p8: '78777111', in_crm: true, crm_orders: 43 });
    expect(m.get('42513').flags).toContain('returns_orders');
    expect(m.get('124424').skip).toBe('test_name');
  });

  it('accepts a bare array and an object keyed by komitent id', () => {
    expect(adaptCustomersClean(file.customers).size).toBe(5);
    const keyed = adaptCustomersClean({ '777': { status: 'import', customer_phone: '+38970000001', phone8: '70000001' } });
    expect(keyed.get('777')).toMatchObject({ skip: null, match: 'new' });
  });

  it('refuses a file where no row carries a komitent id (a wrong file must not skip everyone)', () => {
    expect(() => adaptCustomersClean({ customers: [{ status: 'skip', reason: 'x' }] })).toThrow(/komitent id/);
  });
});

describe('adaptItemsSummary — items-*-summary.json → lines + fresh headers', () => {
  const file = {
    meta: {},
    documents: [
      { doc_number: '002-9100-1/2026', doc_id: '10714973', type_id: '10036', doc_at: '2026-01-01T09:11:05', komitent_id: '87089',
        author: 'Ружица Ружевска', amount_mkd: 1950, sum_check: 'ok', flags: ['has_gift_line'],
        lines: [
          { article: 'БРОНХО ПРОТЕКТ 500ml', articleCode: '000489', qty: 3, units: 3, value_mkd: 1800, kind: 'product', product_id: 'c5d5659f-8997-41c5-aa68-cf98032c4215' },
          { article: 'САМБУКУС сируп 250 мл', articleCode: '001159', qty: 1, units: 1, value_mkd: 0, kind: 'gift', product_id: '318077bc-32bc-4e9b-aee6-33ddcfe71380' },
          { article: '2+2 ПРОСТАТОЛ КОМПЛЕКС', articleCode: '700999', qty: 1, units: 4, value_mkd: 0, kind: 'product', product_id: null },
          { article: 'ДОСТАВА', articleCode: '8001', qty: 1, units: 1, value_mkd: 150, kind: 'delivery', product_id: null },
        ] },
      { doc_number: '002-9102-1064/2023', doc_id: '1419279', type_id: '10050', doc_at: '2023-02-06T11:21:34', komitent_id: '43471',
        author: 'Марија Маријевска', amount_mkd: null, sum_check: 'mismatch', flags: [],
        lines: [{ article: 'ПРОСТАТОЛ КОМПЛЕКС cps 30', articleCode: '000265', qty: -4, units: -4, value_mkd: -2000, kind: 'product', product_id: '0a67af01-ba33-42fc-949e-9fc5e60960e2' }] },
    ],
  };
  const headers: any[] = [];
  const m = adaptItemsSummary(file, headers);

  it('keeps the helper product_id (null stays null — never re-mapped here) and uses UNITS as the quantity', () => {
    const l = m.get('002-9100-1/2026')!;
    expect(l).toHaveLength(4);
    expect(l[0]).toMatchObject({ code: '000489', qty: 3, qty_doc: 3, value_mkd: 1800, kind: 'product', product_id: 'c5d5659f-8997-41c5-aa68-cf98032c4215' });
    expect(l[2]).toMatchObject({ qty: 4, qty_doc: 1, product_id: null });
  });

  it('builds a fresh header in Skopje time (CET in January: 09:11 local = 08:11 UTC)', () => {
    const h = headers.find((x) => x.doc_number === '002-9100-1/2026');
    expect(h).toMatchObject({ type_id: '10036', komitent_id: '87089', amount_mkd: 1950, source: 'items', storno: false });
    expect(h.doc_at).toBe('2026-01-01T08:11:05.000Z');
  });

  it('a storno (blank amount, negative lines) is marked and keeps NO amount', () => {
    const h = headers.find((x) => x.doc_number === '002-9102-1064/2023');
    expect(h.storno).toBe(true);
    expect(h.amount_mkd).toBeNull();
    expect(h.lines_value_mkd).toBe(-2000);
  });
});

describe('phones, dates, money, markers', () => {
  it('Macedonian phones are read, foreign ones rejected — never rewritten into +389', () => {
    expect(mkPhone8('070/222-444').p8).toBe('70222444');
    expect(mkPhone8('071234567 или 072345678').p8).toBe('71234567');
    expect(mkPhone8('022333777')).toMatchObject({ p8: '22333777', kind: 'landline' });
    expect(mkPhone8('+381691114444')).toMatchObject({ p8: null, why: 'foreign' });
    expect(mkPhone8('017111444')).toMatchObject({ p8: null, why: 'not_mk_range' });
    expect(mkPhone8('3.59886e+11')).toMatchObject({ p8: null, why: 'scientific' });
  });

  it('collabBox wall-clock time is DST-exact (not a fixed +02:00)', () => {
    expect(parseCbDatum('15.01.2026 17:07:23')!.toISOString()).toBe('2026-01-15T16:07:23.000Z');
    expect(parseCbDatum('30.04.2023 17:07:23')!.toISOString()).toBe('2023-04-30T15:07:23.000Z');
    expect(parseIsoLocal('2026-09-25T20:17:03')!.toISOString()).toBe('2026-09-25T18:17:03.000Z');
  });

  it('the parcel decides the status; COD fits the amount', () => {
    expect(statusFromParcel({ status_id: 2, delivered_at: 'd', created_at_mex: 'c' })).toMatchObject({ status: 'paid', paid_basis: 'mex', paid_at: 'd' });
    expect(statusFromParcel({ status_id: 7, returned_at: 'r', created_at_mex: 'c' }).status).toBe('returned');
    expect(statusFromParcel({ status_id: 4, created_at_mex: 'c' }).status).toBe('shipped');
    expect(codFitsAmount(2000, 2000)).toBe('exact');
    expect(codFitsAmount(2000, 2150)).toBe('plus_delivery');
    expect(Math.round(32.52 * MKD_PER_EUR)).toBe(2000);
  });

  it('cohort buckets: pre-MEX paid is paid_legacy, a COD-0 parcel is a replacement', () => {
    expect(cohortOrderBucket({ status: 'paid', price: 32.52, paid_basis: 'legacy_import', tracking: null })).toBe('paid_legacy');
    expect(cohortOrderBucket({ status: 'paid', price: 32.52, paid_basis: 'mex', tracking: 'x', mex_status_id: 2, mex_cod_mkd: 2000 })).toBe('paid');
    expect(cohortParcelBucket(2, 0)).toBe('replacement');
  });

  it('operator notes in a name', () => {
    expect(nameMarker('ПОЧИНАТА')).toBe('deceased');
    expect(nameMarker('Соња Соњевиќ &#40;да не се контактира од операторите на Натура&#41;')).toBe('do_not_contact');
    expect(nameMarker('Васил Тестера')).toBeNull();
  });
});

describe('engine v3.7-mk mirror — a ban marker keeps a customer out of every calling list', () => {
  const now = Date.parse('2026-09-28T20:00:00Z');
  const paid = (daysAgo: number) => ({ status: 'paid', created_at: now - daysAgo * DAY, price: 32.52, source_type: 'import', trash_reason: null, trashed_at: null });
  const marker = { status: 'trashed', created_at: now, price: 0, source_type: 'manual', trash_reason: 'other', trashed_at: now };

  it('without the marker a teleshop buyer lands in a calling band', () => {
    expect(engineClassify([paid(400), paid(30)], now)).toMatchObject({ target: '21d 26+ (1-3 orders)', trash: false });
  });

  it('with the marker (dated after every imported order): permanent trash, no band', () => {
    expect(engineClassify([paid(400), paid(30), marker], now)).toMatchObject({ target: null, trash: true, perm: true });
  });

  it('only a PAID order dated after the marker releases them (the MK rule)', () => {
    const later = { ...paid(0), created_at: now + DAY };
    expect(engineClassify([paid(30), marker, later], now + 2 * DAY).trash).toBe(false);
  });
});
