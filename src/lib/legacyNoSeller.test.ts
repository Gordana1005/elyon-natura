import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Owner, Mile, 02.10.2026: of the sales the stamping cron cannot credit, the seller sources he approved
// (login-names + canceller) credit 271; the 626 no evidence can credit become "legacy – no seller"
// (orders.sold_via = 'legacy_no_seller', no person, no handle — migration 20260944001300); the ~143 only an
// unapproved source would credit stay plain unresolved. Pinned here: the verdict, the groups, the apply SQL,
// the classifier fixes it relies on (a parcel that is not the sale's is held whatever the sources), and the
// migration's guards / edits.
import {
  KEY, VIA, APPROVED_DEFAULT, legacyVerdict, legacyGroup, legacyLine, buildLegacyChunkSql,
} from '../../scripts/repair-legacy-no-seller.mjs';
import {
  classify, proposalFor, periodOf, PARCEL_HOLDS, LOGIN_MIN_DOCS,
} from '../../scripts/repair-seller-matching.mjs';

const ROOT = join(__dirname, '..', '..');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the legacy verdict (A = approved sources, B = every source)', () => {
  const stamp = (source: string) => ({ outcome: 'stamp', source });
  it('an approved-source stamp belongs to the seller-matching run, never to the marker', () => {
    expect(legacyVerdict(stamp('login-names'), stamp('login-names'))).toEqual({ verdict: 'approved_sources', source: 'login-names' });
    expect(legacyVerdict(stamp('canceller'), stamp('own-doc'))).toEqual({ verdict: 'approved_sources', source: 'canceller' });
  });
  it('a sale only an unapproved source names stays plain unresolved', () => {
    expect(legacyVerdict({ outcome: 'unknown', reason: 'phone_sources_off · login_3054@2025-12_not_one_person' }, stamp('export-phone')))
      .toEqual({ verdict: 'other_sources_only', source: 'export-phone' });
  });
  it('not a cohort sale (a replacement parcel) or a test phone is left alone', () => {
    expect(legacyVerdict({ outcome: 'skip', reason: 'not_a_sale_now' }, { outcome: 'skip', reason: 'not_a_sale_now' }))
      .toEqual({ verdict: 'skip', reason: 'not_a_sale_now' });
  });
  it('held or unknown under every source → legacy, with its group', () => {
    expect(legacyVerdict({ outcome: 'unknown', reason: 'x' }, { outcome: 'unknown', reason: 'no_doc_in_window · login_2720_no_documents' }))
      .toEqual({ verdict: 'legacy', group: 'login_2720_no_documents' });
    expect(APPROVED_DEFAULT).toEqual(['login-names', 'canceller']);
  });
});

describe('the groups the owner reads', () => {
  it.each([
    [{ outcome: 'hold', reason: 'export-phone:doc_fits_another_sale' }, 'phone_ambiguous'],
    [{ outcome: 'hold', reason: 'mex-phone:several_authors' }, 'phone_ambiguous'],
    [{ outcome: 'hold', reason: 'corrections:several_authors' }, 'corrections_ambiguous'],
    [{ outcome: 'hold', reason: 'doc_predates_order' }, 'doc_predates_order'],
    [{ outcome: 'hold', reason: 'non_collabbox_parcel' }, 'non_collabbox_parcel'],
    [{ outcome: 'unknown', reason: 'no_doc_in_window · login_3054@2025-12_not_one_person' }, 'login_3054_not_one_person'],
    [{ outcome: 'unknown', reason: 'mex_era_sale_without_parcel · login_3807@2026-04_not_one_person' }, 'login_3807_not_one_person'],
    [{ outcome: 'unknown', reason: 'no_doc_for_phone · login_2720_no_documents' }, 'login_2720_no_documents'],
    [{ outcome: 'unknown', reason: 'parcel_document_gone' }, 'parcel_document_gone'],
  ])('%j → %s', (b, g) => expect(legacyGroup(b)).toBe(g));
});

describe('the apply SQL: the mark, and nothing else', () => {
  const runId = '12345678-aaaa-4bbb-8ccc-1234567890ab';
  const row = (n: number) => ({ order_id: uuid(n), group: 'login_2720_no_documents', sold_at: '2025-05-10 12:00:00+00', status: 'paid',
    expect_tracking: null, line: legacyLine(uuid(n), '2025-05-10 12:00:00+00', 'login_2720_no_documents'), evidence: { group: 'login_2720_no_documents' } });
  const s = buildLegacyChunkSql({ runId, rows: [row(1), row(2)] });
  it('sets sold_at + sold_via only; never a person or a handle', () => {
    expect(KEY).toBe('legacy-no-seller');
    expect(VIA).toBe('legacy_no_seller');
    expect(s).toContain("set sold_at = k.sold_at, sold_via = 'legacy_no_seller'");
    expect(s).not.toMatch(/set[^;]*sold_by_person_id\s*=/i);
    expect(s).not.toMatch(/set[^;]*sold_by_ext\s*=/i);
    expect(s).toContain("or o.sold_by_person_id is not null or o.sold_by_ext is not null");
  });
  it('touches only orders still entirely unstamped, in the planned status and parcel; keeps updated_at; ledgers before/after', () => {
    expect(s).toContain('where o.sold_at is null and o.sold_by_person_id is null and o.sold_via is null and o.sold_by_ext is null');
    expect(s).toContain('o.mex_tracking_id is not distinct from p.expect_tracking');
    expect(s).toContain("set local elyon.keep_updated_at = 'on'");
    expect(s).toContain("set local elyon.bulk_repair = 'on'");
    expect(s).toContain("'legacy:' || k.group_key");
    expect(s).toContain("jsonb_build_object('kind', 'sold'");   // the shape backfill-sellers-collabbox's rollback reads
    expect(s).toContain('for no key update');
  });
  it('refuses an empty or an oversized chunk', () => {
    expect(() => buildLegacyChunkSql({ runId, rows: [] })).toThrow();
    expect(() => buildLegacyChunkSql({ runId, rows: Array.from({ length: 201 }, (_, i) => row(i + 1)) })).toThrow();
  });
  it('the hash line names the order, the marker, the sale moment and the group', () => {
    expect(legacyLine(uuid(9), '2025-05-10 12:00:00+00', 'phone_ambiguous'))
      .toBe(`${uuid(9)}:legacy:legacy_no_seller|2025-05-10 12:00:00+00:phone_ambiguous`);
  });
});

// a minimal evidence context for repair-seller-matching's classify()
function ctxFor(sources: string[], docs: Record<string, { tip: string; author: string; at: string } | null> = {}) {
  return {
    opts: { sources: new Set(sources) },
    db: { mkAccount: 'acc' },
    altUser: new Map([['acc:4134', { person_id: 'p-iva' }]]),
    logins: new Map(), raw: new Map(), corrections: new Map(), holders: new Map(),
    exp: { leadByP8: new Map() }, ledgerByP8: new Map(), parcelsByP8: new Map(), compByP8: new Map(),
    resolver: { author: (a: string) => ({ person_id: `p-${a}`, ext: a }), person: () => null },
    docOf: (t: string) => (docs[t] ? { doc: t, tip: docs[t]!.tip, author: docs[t]!.author, at: new Date(docs[t]!.at), from: 'ledger' } : null),
  };
}
const order = (over: Record<string, unknown> = {}) => ({
  id: uuid(1), display_id: 'ORD-1', status: 'paid', det: 'bridge', created_at: '2026-09-20 10:00:00+00', sale_at: '2026-09-20 10:00:00+00',
  price: 24.23, tr: '002-9110-176000/2026', parcels: [], p8: '70123456', in_total: true, test_phone: false, cohort_bucket: 'paid',
  decision: 'cancelled', lead_user: 4134, lead_account: 'acc', ext_id: null, ...over,
});

describe('repair-seller-matching classify: what the marker relies on', () => {
  it('a parcel older than the lead is held whatever the sources (the canceller used to take two of these)', () => {
    const docs = { '002-9110-176000/2026': { tip: '10111', author: 'Кристина Даневска', at: '2026-09-15T10:00:00Z' } };
    expect(classify(order(), ctxFor(['login-names', 'canceller'], docs))).toMatchObject({ outcome: 'hold', reason: 'doc_predates_order' });
    expect(classify(order(), ctxFor(['own-doc', 'canceller'], docs))).toMatchObject({ outcome: 'hold', reason: 'doc_predates_order' });
    expect(PARCEL_HOLDS).toContain('doc_predates_order');
  });
  it('a web / NATURA parcel on an AlterCPA lead is held whatever the sources', () => {
    expect(classify(order({ tr: 'NTMK62345' }), ctxFor(['login-names', 'canceller']))).toMatchObject({ outcome: 'hold', reason: 'non_collabbox_parcel' });
  });
  it('the canceller stands in only for a document that is GONE', () => {
    expect(classify(order(), ctxFor(['login-names', 'canceller']))).toMatchObject({ outcome: 'stamp', source: 'canceller', via: 'altercpa', person_id: 'p-iva', ext: '4134' });
    expect(classify(order(), ctxFor(['login-names']))).toMatchObject({ outcome: 'unknown', reason: 'parcel_document_gone' });
    const docs = { '002-9110-176000/2026': { tip: '10111', author: 'Ива Куноска', at: '2026-09-21T10:00:00Z' } };
    expect(classify(order(), ctxFor(['login-names', 'canceller'], docs))).toMatchObject({ outcome: 'unknown', reason: 'own_doc_not_enabled' });
    expect(classify(order(), ctxFor(['own-doc', 'canceller'], docs))).toMatchObject({ outcome: 'stamp', source: 'own-doc', via: 'collabbox' });
  });
  it('a replacement parcel (not a cohort sale now) is skipped, never marked', () => {
    expect(classify(order({ in_total: false, cohort_bucket: 'replacement' }), ctxFor(['login-names', 'canceller']))).toMatchObject({ outcome: 'skip', reason: 'not_a_sale_now' });
  });
  it('periods: before March · March · from 02.04 (the MEX register)', () => {
    expect(periodOf('2026-02-28 12:00:00+00')).toBe('before_march');
    expect(periodOf('2026-04-01 12:00:00+00')).toBe('march');
    expect(periodOf('2026-04-02 12:00:00+00')).toBe('from_april');
  });
});

describe('login-names: a login is a person only in a month that says so', () => {
  const t = (login: string, month: string | null, docs: number, share: number, person = 'p-x', identity: string | null = null) =>
    [month ? `${login}|${month}` : login, { key: month ? `${login}|${month}` : login, login, month, docs, share, author: 'A', person_id: person, identity,
      strong: share >= 0.85 && docs >= LOGIN_MIN_DOCS }] as const;
  const logins = new Map([
    t('3807', null, 702, 0.86), t('3807', '2026-03', 308, 0.98), t('3807', '2026-04', 139, 0.43),
    t('3834', null, 24, 0.88), t('3834', '2026-02', 18, 0.83),
    t('3054', null, 786, 0.55), t('3054', '2025-08', 138, 0.99),
    t('3453', null, 2401, 0.97, 'p-sashka', 'Sashka'),
  ]);
  it('a well-evidenced month decides by itself', () => {
    expect(proposalFor(logins, '3807', '2026-03')).toMatchObject({ basis: 'month' });
    expect(proposalFor(logins, '3807', '2026-04')).toBeNull();
    expect(proposalFor(logins, '3054', '2025-08')).toMatchObject({ basis: 'month' });
  });
  it('a thin month borrows the whole-life author only if no well-evidenced month disagrees', () => {
    expect(proposalFor(logins, '3834', '2026-02')).toMatchObject({ basis: 'login' });
    expect(proposalFor(logins, '3807', '2026-01')).toBeNull();     // April says "shared"
    expect(proposalFor(logins, '3054', '2025-12')).toBeNull();     // whole life 55 %
  });
  it('a login the owner already named is the operator source, never a proposal', () => {
    expect(proposalFor(logins, '3453', '2026-03')).toBeNull();
  });
});

describe('migrations 20260944001200 / 1300 and their twins', () => {
  const m1200 = readFileSync(join(ROOT, 'supabase/migrations/20260944001200_decider_plan_first_sale_proof.sql'), 'utf8');
  const m1300 = readFileSync(join(ROOT, 'supabase/migrations/20260944001300_legacy_no_seller.sql'), 'utf8');
  // the twin is read as text: backfill-order-deciders.mjs carries a shebang vitest cannot import
  const twin = readFileSync(join(ROOT, 'scripts/backfill-order-deciders.mjs'), 'utf8');
  it('1200: the plan counts a first sale step only from a person or with the parcel still there — in the twin too', () => {
    expect(m1200).toContain('OR (x.has_fr AND (x.fr_human OR x.holds_parcel))');
    expect(twin).toContain('(has_fr AND (fr_human OR holds_parcel))');
    // the plan never lists a marked sale: it takes only sold_at IS NULL, in both
    expect(m1200).toContain('WHERE o.sold_at IS NULL /*SCOPE_SOLD*/');
    expect(twin).toContain('WHERE o.sold_at IS NULL');
  });
  it('1300: drift guards for the five bodies it re-emits, before anything changes', () => {
    const guard = m1300.indexOf('DO $guard$');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(m1300.indexOf('ALTER TABLE public.orders'));
    for (const md5 of ['40301048c57be0f2314cfc4077ba08e3', '9a240b7c367aced4aff17c80a795c7da', '9b58ced2efcbf7d8ac23f8cad04c0ad9',
      '68ef32a711dea9190d225913367c1c37', 'e48ed7ea8dc7138a4fad23b5948f46cc']) expect(m1300).toContain(md5);
    expect((m1300.match(/CREATE OR REPLACE FUNCTION public\./g) || []).length).toBe(5);
  });
  it('1300: the marker never names anybody (CHECK), and each reader got its one edit', () => {
    expect(m1300).toContain("OR (sold_via = 'legacy_no_seller' AND sold_by_person_id IS NULL AND sold_by_ext IS NULL)) NOT VALID");
    expect(m1300).toContain('VALIDATE CONSTRAINT orders_sold_via_check');
    expect(m1300).toContain("AND ob.sold_via IS DISTINCT FROM 'legacy_no_seller') AS q_no_seller");
    expect(m1300).toContain("AND r.q_no_seller) END");
    expect(m1300).toContain("CASE WHEN np.sold_via = 'legacy_no_seller' THEN 'legacy_no_seller'");
    expect(m1300).toContain("CASE WHEN so.sold_via = 'legacy_no_seller' THEN 'legacy_no_seller'");
    expect(m1300).toContain('o.sold_at, o.sold_by_ext, o.sold_via,');
    expect(m1300).toContain("AND o.sold_via IS DISTINCT FROM 'legacy_no_seller'   -- accepted with no seller");
  });
});

describe('the UI knows the reason in every locale', () => {
  it.each(['en', 'mk', 'sq', 'bg'])('%s', (l) => {
    const j = JSON.parse(readFileSync(join(ROOT, `src/i18n/locales/${l}.json`), 'utf8'));
    expect(j.insights.agents.noSeller.reason.legacy_no_seller).toBeTruthy();
    expect(j.insights.agents.noSeller.hint.legacy_no_seller).toBeTruthy();
    expect(j.orderOrigin.via.legacy_no_seller).toBeTruthy();
  });
});
