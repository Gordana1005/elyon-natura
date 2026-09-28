import { describe, it, expect } from 'vitest';
// The repair's pure half (scripts/lib/cod-price.mjs). Owner decision 28.09.2026:
// "COD ≠ CRM price: MEX is right. Set the CRM price to the MEX COD when it differs. Not when
// COD = price×61.5+150 (delivery fee), and not when COD is 0. Keep order_items consistent."
import {
  KEY, codToCents, centsToStr, toCents, parcelFamily, orderFamily, linkSuspicion, classifySaleSource,
  explainCod, explanationKey, planItems, packageBonusRate, orderPackageBonus, classifyCodPrice,
  buildPriceChunkSql, buildPriceRollbackSql, itemsFingerprintSql, priceSnapshotSql,
} from '../../scripts/lib/cod-price.mjs';
import { codFit, expectedCodMkd, buildChunkSql, keepUpdatedAtGuarded, inQuietWindow, busyActivitySql, BUSY_FUNCTIONS, canonicalJson } from '../../scripts/lib/repair-kit.mjs';
import { paidLine, moneyTally } from '../../scripts/repair-cod-price.mjs';

type Row = Record<string, unknown>;
type Item = { id: string; quantity: number | string; price_per_unit: string; total_price: string };

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A loader row: the order + its named parcel, agreed link, AlterCPA fields empty. */
function row(n: number, over: Row = {}): Row {
  const id = uuid(n);
  return {
    id, display_id: `ORD-${10000 + n}`, status: 'paid', price: '26.67', quantity: 1, product_name: 'Prostamax',
    source_type: 'altercpa', external_source: 'altercpa', external_order_id: String(900000 + n),
    sale_source: 'altercpa', sale_source_detail: 'bridge', prediction_list_id: null,
    customer_name: 'Test Customer', customer_phone: `+3897${String(1000000 + n).slice(-7)}`, customer_city: 'Skopje',
    created_at: '2026-09-01T10:00:00Z', paid_basis: 'mex', mex_cod_mkd: 4920,
    tracking_id: `002-9110-${150000 + n}/2026`, account: 'bio_natural', series: '9110', status_id: 2, status_name: 'Delivered',
    cod_mkd: 4920, reg_order_id: id, link_method: 'tracking', created_at_mex: '2026-09-02T08:00:00Z',
    delivered_at: '2026-09-04T12:00:00Z', returned_at: null, sender_reference: null,
    holder_ids: null, altercpa_id: null, cpa_price: null, cpa_currency: null, cpa_count: null,
    items_fp: 'fp', ...over,
  };
}
const oneLine = (n: number, qty = 1, ppu = '26.67', total = '26.67'): Item[] => [{ id: uuid(5000 + n), quantity: qty, price_per_unit: ppu, total_price: total }];

describe('cod-price money arithmetic', () => {
  it('re-pricing to COD / 61,5 lands exactly on the COD again, for every COD up to 20.000 ден', () => {
    for (let cod = 1; cod <= 20000; cod++) {
      const cents = codToCents(cod);
      expect(expectedCodMkd(cents / 100)).toBe(cod);
      expect(codFit(cents / 100, cod)).toBe('exact');
    }
  });
  it('formats cents exactly (no float drift) and parses numeric strings', () => {
    expect(centsToStr(8000)).toBe('80.00');
    expect(centsToStr(2667)).toBe('26.67');
    expect(centsToStr(5)).toBe('0.05');
    expect(centsToStr(-150)).toBe('-1.50');
    expect(toCents('26.67')).toBe(2667);
    expect(toCents('0.285')).toBe(29);
    expect(codToCents(1640)).toBe(2667);
    expect(codToCents(4920)).toBe(8000);
  });
});

describe('channel families — which parcel belongs to which source', () => {
  it('reads the family from the series first, then ORD-/NTMK ids, then the account', () => {
    expect(parcelFamily({ series: '9110', account: 'natura' }).family).toBe('elyon');
    expect(parcelFamily({ series: '9103' }).family).toBe('elyon');
    expect(parcelFamily({ series: '9100', account: 'bio_natural' }).family).toBe('natura');
    expect(parcelFamily({ series: '9102' }).family).toBe('natura');
    expect(parcelFamily({ series: '9108' }).family).toBe('natura');
    expect(parcelFamily({ tracking_id: 'ORD-89109', account: 'bio_natural' }).family).toBe('elyon');
    expect(parcelFamily({ tracking_id: 'NTMK40556', account: 'natura' }).family).toBe('natura');
    expect(parcelFamily({ tracking_id: 'M3258911', account: 'natura' }).family).toBe('natura');
    expect(parcelFamily({ tracking_id: '3324341', account: 'bio_natural' }).family).toBe('elyon');
    expect(parcelFamily({ tracking_id: 'X', account: null }).family).toBeNull();
  });
  it('an order must hold a parcel of the family it arrived through', () => {
    expect(orderFamily({ sale_source: 'altercpa' }).family).toBe('elyon');
    expect(orderFamily({ sale_source: 'affiliate' }).family).toBe('elyon');
    expect(orderFamily({ sale_source: 'elyon_crm', sale_source_detail: 'prediction_list' }).family).toBe('elyon');
    expect(orderFamily({ sale_source: 'web' }).family).toBe('natura');
    expect(orderFamily({ sale_source: 'collabbox', sale_source_detail: 'teleshop', external_order_id: '002-9102-119150/2025' }).family).toBe('natura');
    expect(orderFamily({ sale_source: 'collabbox', sale_source_detail: 'leads', external_order_id: '002-9110-119150/2025' }).family).toBe('elyon');
    expect(orderFamily({ sale_source: 'legacy', sale_source_detail: 'monadon_legacy' }).family).toBeNull();
  });
  it('mirrors classify_sale_source for rows the backfill has not reached', () => {
    expect(classifySaleSource({ source_type: 'altercpa' })).toEqual(['altercpa', 'bridge']);
    expect(classifySaleSource({ source_type: 'import', external_source: 'altercpa' })).toEqual(['altercpa', 'history']);
    expect(classifySaleSource({ source_type: 'import', external_source: 'collabbox', external_order_id: '002-9108-1/2026' })).toEqual(['collabbox', 'social']);
    expect(classifySaleSource({ source_type: 'manual', price: 0, product_name: 'Cancelled order' })).toEqual(['elyon_crm', 'disposition']);
    expect(classifySaleSource({ source_type: 'manual', price: 30, product_name: 'X', prediction_list_id: 'l' })).toEqual(['elyon_crm', 'prediction_list']);
    expect(classifySaleSource({ source_type: 'opencart' })).toEqual(['web', 'opencart']);
  });
  it('flags the wrong-channel links the owner does not want re-priced', () => {
    const alter = { sale_source: 'altercpa', display_id: 'ORD-1' };
    expect(linkSuspicion(alter, { tracking_id: '002-9100-1/2026', series: '9100', account: 'natura' })).toMatch(/NATURA/);
    expect(linkSuspicion(alter, { tracking_id: '002-9108-1/2026', series: '9108', account: 'natura' })).toMatch(/NATURA/);
    expect(linkSuspicion(alter, { tracking_id: '002-9110-1/2026', series: '9110', account: 'bio_natural' })).toBeNull();
    // the teleshop team confirms in AlterCPA and books in collabBox (owner 28.09): the document proves the link
    expect(linkSuspicion({ ...alter, collab_twin: true }, { tracking_id: '002-9102-1/2026', series: '9102', account: 'natura' })).toBeNull();
    expect(linkSuspicion({ sale_source: 'elyon_crm', display_id: 'ORD-2' }, { tracking_id: '002-9102-1/2026', series: '9102' })).toMatch(/NATURA/);
    const tele = { sale_source: 'collabbox', sale_source_detail: 'teleshop', external_source: 'collabbox', external_order_id: '002-9102-5/2025', display_id: 'ORD-3' };
    expect(linkSuspicion(tele, { tracking_id: '002-9102-5/2025', series: '9102' })).toBeNull();          // its own DocNumber
    expect(linkSuspicion(tele, { tracking_id: '002-9110-7/2026', series: '9110' })).toMatch(/BIO NATURAL/);
    expect(linkSuspicion(tele, { tracking_id: '002-9103-7/2026', series: '9103' })).toMatch(/BIO NATURAL/);
    const leads = { sale_source: 'collabbox', sale_source_detail: 'leads', external_source: 'collabbox', external_order_id: '002-9110-9/2025', display_id: 'ORD-4' };
    expect(linkSuspicion(leads, { tracking_id: '002-9110-8/2025', series: '9110' })).toBeNull();
    expect(linkSuspicion({ sale_source: 'web', display_id: 'ORD-5' }, { tracking_id: '002-9103-1/2026', series: '9103' })).toMatch(/BIO NATURAL/);
    expect(linkSuspicion({ sale_source: 'elyon_crm', display_id: 'ORD-6' }, { tracking_id: 'ORD-99999' })).toMatch(/another CRM order/);
    expect(linkSuspicion({ sale_source: 'elyon_crm', display_id: 'ORD-99999' }, { tracking_id: 'ORD-99999' })).toBeNull();
    expect(linkSuspicion({ sale_source: 'legacy', display_id: 'ORD-7' }, { tracking_id: '002-9100-1/2026', series: '9100' })).toBeNull();
  });
});

describe('explainCod — what the owner reads, and the only case a quantity changes', () => {
  const base = { priceCents: 2667, qty: 1, unitCents: 2667, cpaCount: null as number | null, cpaMkd: null as number | null };
  it('changes the quantity only when AlterCPA count × unit is the COD exactly', () => {
    const e = explainCod({ ...base, cod: 4920, cpaCount: 3 });
    expect(explanationKey(e.explained)).toBe('altercpa_count_exact');
    expect(e.newQty).toBe(3);
  });
  it('reports but never applies a count that fits only with the 150 ден fee', () => {
    const e = explainCod({ ...base, cod: 5070, cpaCount: 3 });
    expect(explanationKey(e.explained)).toBe('altercpa_count_plus_delivery');
    expect(e.newQty).toBeNull();
  });
  it('reports AlterCPA\'s own total, k × the price, or plain above/below', () => {
    expect(explanationKey(explainCod({ ...base, cod: 2500, cpaMkd: 2500 }).explained)).toBe('altercpa_total_fits');
    expect(explainCod({ ...base, cod: 2500, cpaMkd: 2500 }).newQty).toBeNull();
    expect(explanationKey(explainCod({ ...base, cod: 3280 }).explained)).toBe('cod_is_2x_price');
    expect(explanationKey(explainCod({ ...base, cod: 3430 }).explained)).toBe('cod_is_2x_price_plus_delivery');
    expect(explainCod({ ...base, cod: 2000 }).explained).toBe('cod_above_price');
    expect(explainCod({ ...base, cod: 1000 }).explained).toBe('cod_below_price');
  });
  it('never infers a count for a multi-line order (no single unit)', () => {
    const e = explainCod({ priceCents: 5334, qty: null, unitCents: null, cod: 16400, cpaCount: 5, cpaMkd: null });
    expect(e.newQty).toBeNull();
  });
});

describe('planItems — order_items stay consistent (Σ lines = the new price, to the cent)', () => {
  const sumCents = (items: Array<{ total_price: string }>) => items.reduce((s, i) => s + toCents(i.total_price), 0);
  it('one line takes the whole new total; price_per_unit = total / qty rounded to the cent (the api/sync convention)', () => {
    const p = planItems(oneLine(1), 8000);
    expect(p.ok).toBe(true);
    expect(p.items).toEqual([{ id: uuid(5001), quantity: 1, price_per_unit: '80.00', total_price: '80.00' }]);
    const three = planItems(oneLine(1, 3, '26.67', '80.01'), 8000);
    expect(three.items[0]).toMatchObject({ quantity: 3, price_per_unit: '26.67', total_price: '80.00' });
  });
  it('a proven quantity change rewrites the line quantity', () => {
    const p = planItems(oneLine(1), 8000, { newQty: 3 });
    expect(p.items[0]).toMatchObject({ quantity: 3, price_per_unit: '26.67', total_price: '80.00' });
    expect(p.qty).toBe(3);
  });
  it('several lines scale in proportion, the cent remainder lands on the largest line', () => {
    const items: Item[] = [
      { id: uuid(1), quantity: 1, price_per_unit: '10.00', total_price: '10.00' },
      { id: uuid(2), quantity: 2, price_per_unit: '15.00', total_price: '30.00' },
      { id: uuid(3), quantity: 1, price_per_unit: '3.33', total_price: '3.33' },
    ];
    for (const target of [1, 999, 4333, 8000, 12345, 100001]) {
      const p = planItems(items, target);
      expect(p.ok).toBe(true);
      expect(sumCents(p.items)).toBe(target);
      expect(p.items.map((i: Item) => i.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    }
    const p = planItems(items, 8666);   // × 2 exactly
    expect(p.items.map((i: Item) => i.total_price)).toEqual(['20.00', '60.00', '6.66']);
  });
  it('refuses what it cannot keep consistent', () => {
    const zero: Item[] = [{ id: uuid(1), quantity: 1, price_per_unit: '0', total_price: '0' }, { id: uuid(2), quantity: 1, price_per_unit: '0', total_price: '0' }];
    expect(planItems(zero, 8000).ok).toBe(false);
    expect(planItems([...zero, ...oneLine(9)], 8000, { newQty: 3 }).ok).toBe(false);
  });
  it('legacy orders without lines change only the order', () => {
    expect(planItems([], 8000)).toEqual({ ok: true, items: [], qty: null });
    expect(planItems([], 8000, { newQty: 2 })).toEqual({ ok: true, items: [], qty: 2 });
  });
});

describe('the deferred commission — mirrored for REPORTING only', () => {
  it('matches the api tiers (<25 → 1, 25–35 → 2, ≥35 → 3; exactly 25 → 1)', () => {
    expect(packageBonusRate(24.99)).toBe(1);
    expect(packageBonusRate(25)).toBe(1);
    expect(packageBonusRate(25.01)).toBe(2);
    expect(packageBonusRate(34.99)).toBe(2);
    expect(packageBonusRate(35)).toBe(3);
    expect(orderPackageBonus('paid', 80, 3, [{ price_per_unit: '26.67', quantity: 3 }])).toBe(6);
    expect(orderPackageBonus('shipped', 80, 3, null)).toBe(0);
    expect(orderPackageBonus('paid', 80, 1, null)).toBe(3);
  });
});

describe('classifyCodPrice — candidates and the exclusions the owner must see listed', () => {
  const items = new Map<string, Item[]>();
  const rows: Row[] = [];
  const add = (n: number, over: Row = {}, its: Item[] | null = oneLine(n)) => { const r = row(n, over); rows.push(r); if (its) items.set(String(r.id), its); return r; };
  add(1, { cod_mkd: 1640 });                                            // fits exactly → not a mismatch
  add(2, { cod_mkd: 1790 });                                            // +150 delivery → not a mismatch
  add(3, { cod_mkd: 0 });                                               // COD 0 → never
  const cand = add(4, { cod_mkd: 2500 });                               // plain candidate
  const qty = add(5, { cod_mkd: 4920, cpa_count: '3', altercpa_id: '777' });   // AlterCPA proves 3 packs
  add(6, { cod_mkd: 2500, product_name: 'No prior product on file', sale_source: 'elyon_crm', sale_source_detail: 'disposition', source_type: 'manual' });
  add(7, { cod_mkd: 2500, price: '0.00' });
  add(8, { cod_mkd: 2500, reg_order_id: null });
  add(9, { cod_mkd: 2500, holder_ids: ['ORD-10009', 'ORD-20000'] });
  add(10, { cod_mkd: 2500, tracking_id: '002-9102-1/2026', series: '9102', account: 'natura' });
  add(11, { cod_mkd: 2500, status: 'cancelled' });
  add(12, { cod_mkd: 2500 });                                           // in payout
  add(13, { cod_mkd: 2500, customer_phone: '+38970123456' });           // test phone
  add(14, { cod_mkd: 2500 });                                           // --hold
  const multi = add(15, { cod_mkd: 4000, price: '40.00', quantity: 3 }, [
    { id: uuid(71), quantity: 1, price_per_unit: '10.00', total_price: '10.00' },
    { id: uuid(72), quantity: 2, price_per_unit: '15.00', total_price: '30.00' },
  ]);
  add(16, { cod_mkd: 2500, price: '40.00' }, [
    { id: uuid(81), quantity: 1, price_per_unit: '0', total_price: '0' },
    { id: uuid(82), quantity: 1, price_per_unit: '0', total_price: '0' },
  ]);
  const legacy = add(17, { cod_mkd: 2500, status: 'returned' }, null);
  const accepted = [{ tracking_id: String(rows[8].tracking_id), orders: ['ORD-10009', 'ORD-20000'], key: 'ORD-10009|ORD-20000', reason: 'both real', owner_date: '2026-09-28' }];
  const plan = classifyCodPrice({ rows, items, payout: new Set([uuid(12)]), hold: new Set(['ORD-10014']), accepted });
  const ruleOf = (d: string) => [...plan.candidates, ...plan.excluded].find((r: Row) => r.order === d)?.rule;

  it('skips fits, +150 and COD 0 entirely', () => {
    expect(plan.counts.mismatches).toBe(14);
    for (const d of ['ORD-10001', 'ORD-10002', 'ORD-10003']) expect(ruleOf(d)).toBeUndefined();
  });
  it('re-prices only the clean candidates', () => {
    expect(plan.candidates.map((r: Row) => r.order).sort()).toEqual(['ORD-10004', 'ORD-10005', 'ORD-10015', 'ORD-10017']);
    expect(ruleOf('ORD-10005')).toBe('reprice_qty');
    expect(ruleOf('ORD-10004')).toBe('reprice');
  });
  it('lists every exclusion with its reason', () => {
    expect(ruleOf('ORD-10006')).toBe('disposition');
    expect(ruleOf('ORD-10007')).toBe('zero_price');
    expect(ruleOf('ORD-10008')).toBe('link_not_agreed');
    expect(ruleOf('ORD-10009')).toBe('double_held');
    expect(plan.excluded.find((r: Row) => r.order === 'ORD-10009')?.owner_accepted).toBe('yes');
    expect(ruleOf('ORD-10010')).toBe('suspect_link');
    expect(ruleOf('ORD-10011')).toBe('not_a_sale_status');
    expect(ruleOf('ORD-10012')).toBe('in_payout');
    expect(ruleOf('ORD-10013')).toBe('test_phone');
    expect(ruleOf('ORD-10014')).toBe('held');
    expect(ruleOf('ORD-10016')).toBe('items_unscalable');
  });
  it('hashes only what it writes, and every plan keeps Σ lines = the new price', () => {
    expect(plan.lines).toHaveLength(4);
    expect(plan.lines).toContain(`${cand.id}:reprice:40.65:${cand.tracking_id}`);
    expect(plan.lines).toContain(`${qty.id}:reprice_qty:80.00x3:${qty.tracking_id}`);
    for (const u of plan.units) {
      if (u.new_items.length) expect(u.new_items.reduce((s: number, i: Item) => s + toCents(i.total_price), 0)).toBe(toCents(u.new_price));
      expect(expectedCodMkd(Number(u.new_price))).toBe(u.expect_cod);
      expect(u.note).toMatch(/MEX is right/);
    }
    const q = plan.units.find((u: Row) => u.order_id === qty.id);
    expect(q.new_quantity).toBe(3);
    expect(q.new_items[0]).toMatchObject({ quantity: 3, total_price: '80.00' });
    const m = plan.units.find((u: Row) => u.order_id === multi.id);
    expect(m.new_items.map((i: Item) => i.total_price)).toEqual(['16.26', '48.78']);
    const l = plan.units.find((u: Row) => u.order_id === legacy.id);
    expect(l.new_items).toEqual([]);
  });
  it('the paid line counts paid orders and the (reported) bonus move', () => {
    const p = paidLine(plan.candidates);
    expect(p.orders).toBe(3);            // ORD-10004, 10005, 10015 are paid; 10017 is returned
    expect(p.quantity_changes).toBe(1);
    // 10004: 1 pack at 26,67 € (tier 2) → 40,65 € (tier 3): +1; 10005: 1 → 3 packs at 26,67 €: +4;
    // 10015: lines 16,26 € + 2 × 24,39 € stay in tier 1: 0
    expect(p.bonus_delta_eur).toBe(5);
    expect(p.bonus_changes).toBe(2);
    expect(moneyTally(plan.candidates, (r: Row) => String(r.status)).paid.orders).toBe(3);
  });
});

describe('the SQL a cod-price apply sends', () => {
  const unit = {
    order_id: uuid(1), rule: 'reprice', line: 'x', expect_status: 'paid', expect_tracking: '002-9110-1/2026', expect_price: '26.67',
    expect_price_raw: '26.67', expect_quantity: 1, expect_items_fp: 'abc', expect_cod: 2500, new_price: '40.65', new_quantity: null,
    new_items: [{ id: uuid(2), quantity: 1, price_per_unit: '40.65', total_price: '40.65' }], note: "it's a note", evidence: {},
  };
  it('keeps updated_at, silences the bells, never flips replication off', () => {
    const s = buildPriceChunkSql({ runId: uuid(99), units: [unit] });
    expect(s).toContain("set local elyon.bulk_repair = 'on'");
    expect(s).toContain("set local elyon.keep_updated_at = 'on'");
    expect(s).not.toMatch(/session_replication_role/);
    expect(s).toContain("it''s a note");
    expect(s).toContain(itemsFingerprintSql('o.id'));
    expect(s).not.toMatch(/order_history/);
    const rb = buildPriceRollbackSql({ key: KEY, runId: uuid(98), rbRunId: uuid(97), orderIds: [uuid(1)] });
    expect(rb).toContain("set local elyon.keep_updated_at = 'on'");
    expect(rb).toContain(priceSnapshotSql('o'));
  });
  it('refuses empty and oversized chunks', () => {
    expect(() => buildPriceChunkSql({ runId: uuid(99), units: [] })).toThrow();
    expect(() => buildPriceChunkSql({ runId: uuid(99), units: Array.from({ length: 201 }, (_, i) => ({ ...unit, order_id: uuid(i + 1) })) })).toThrow();
  });
});

describe('repair-kit bulk-write guards (owner rules 28.09)', () => {
  it('knows the keep_updated_at guard by its source', () => {
    expect(keepUpdatedAtGuarded("BEGIN IF current_setting('elyon.keep_updated_at', true) = 'on' THEN RETURN NEW; END IF; NEW.updated_at = now(); RETURN NEW; END")).toBe(true);
    expect(keepUpdatedAtGuarded('BEGIN NEW.updated_at = now(); RETURN NEW; END')).toBe(false);
    expect(keepUpdatedAtGuarded(null)).toBe(false);
  });
  it('the status repairs (A/B engine) keep updated_at too', () => {
    const s = buildChunkSql({ key: 'x', runId: uuid(1), rows: [{ unit: 'u', order_id: uuid(2), rule: 'r', line: 'l', expect_status: 'paid', set: {}, note: null }], typeMap: {} });
    expect(s).toContain("set local elyon.keep_updated_at = 'on'");
  });
  it('the quiet window is 20:55–07:00 Skopje, in summer (CEST) and winter (CET)', () => {
    expect(inQuietWindow(Date.parse('2026-09-28T18:54:00Z'))).toBe(false);   // 20:54 CEST
    expect(inQuietWindow(Date.parse('2026-09-28T18:55:00Z'))).toBe(true);    // 20:55 CEST
    expect(inQuietWindow(Date.parse('2026-09-29T00:30:00Z'))).toBe(true);    // 02:30
    expect(inQuietWindow(Date.parse('2026-09-29T04:59:00Z'))).toBe(true);    // 06:59
    expect(inQuietWindow(Date.parse('2026-09-29T05:00:00Z'))).toBe(false);   // 07:00
    expect(inQuietWindow(Date.parse('2026-09-29T10:00:00Z'))).toBe(false);   // noon
    expect(inQuietWindow(Date.parse('2026-12-15T19:54:00Z'))).toBe(false);   // 20:54 CET
    expect(inQuietWindow(Date.parse('2026-12-15T19:55:00Z'))).toBe(true);    // 20:55 CET
  });
  it('compares run options key-order-free (jsonb re-orders the recorded object)', () => {
    // found by the sandbox end-to-end run: {since, until, hold} came back as {hold, since, until}
    expect(canonicalJson({ since: null, until: null, hold: [] })).toBe(canonicalJson({ hold: [], since: null, until: null }));
    expect(canonicalJson({ a: { d: 1, c: [{ f: 1, e: 2 }] } })).toBe('{"a":{"c":[{"e":2,"f":1}],"d":1}}');
    expect(canonicalJson({ hold: ['ORD-2', 'ORD-1'] })).not.toBe(canonicalJson({ hold: ['ORD-1', 'ORD-2'] }));
  });
  it('watches both bulk writers', () => {
    expect(BUSY_FUNCTIONS).toEqual(['recompute_all_segments', 'apply_no_parcel_rule']);
    for (const f of BUSY_FUNCTIONS) expect(busyActivitySql()).toContain(f);
  });
});
