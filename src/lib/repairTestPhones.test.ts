import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The pure half of scripts/repair-test-phones.mjs. Owner decision 28.09.2026: "Test phones
// 070123456 and 23123123: DELETE their CRM orders (snapshot first). Exclude their web orders
// and MEX parcels from all reports; you can't touch the shop."
import {
  KEY, TEST_PHONES, TEST_PHONE8S, DEPENDENTS, last8, isTestPhone, testNumberForm, verifyForeignKeys,
  classifyTestPhoneOrders, buildDeleteChunkSql, buildRestoreSql, orderSnapshotSql, phoneSnapshotSql, depSnapshotSql,
} from '../../scripts/lib/test-phones.mjs';

type Row = Record<string, unknown>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;

describe('the test numbers, matched the way the rest of the code matches phones (last 8 digits)', () => {
  it('knows exactly the two numbers the owner named', () => {
    expect(TEST_PHONE8S).toEqual(['70123456', '23123123']);
    expect(TEST_PHONES.map((t: Row) => t.national)).toEqual(['070123456', '023123123']);
  });
  it('the migration seeds the SAME list reports exclude (one list, two twins)', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260939000700_report_excluded_phones.sql'), 'utf8');
    const seeded = [...sql.matchAll(/\('(\d{8})', 'Test phone/g)].map((m) => m[1]);
    expect(seeded).toEqual([...TEST_PHONE8S]);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.is_report_excluded_phone\(p_phone text\)\s+RETURNS boolean/);
  });
  it('accepts every Macedonian spelling, lists a foreign number that merely shares the last 8', () => {
    for (const p of ['+38970123456', '070123456', '70123456', '0038970123456', '389070123456', '+389 70 123 456', '070/123-456',
      '+38923123123', '023123123', '23123123', '02 3123 123']) {
      expect(testNumberForm(p)).toBe('exact');
    }
    expect(testNumberForm('+35970123456')).toBe('other_prefix');
    expect(testNumberForm('+4470123456')).toBe('other_prefix');
    expect(testNumberForm('+38970123457')).toBeNull();
    expect(testNumberForm('')).toBeNull();
    expect(testNumberForm(null)).toBeNull();
    expect(testNumberForm('0123456')).toBeNull();
    expect(last8('+389 70 123 456')).toBe('70123456');
    expect(last8('1234567')).toBe('');
    expect(isTestPhone('+38923123123')).toBe(true);
  });
});

describe('classifyTestPhoneOrders — what is deleted, what is only listed', () => {
  const now = Date.parse('2026-09-28T19:00:00Z');
  const o = (n: number, over: Row = {}): Row => ({
    id: uuid(n), display_id: `ORD-${50000 + n}`, status: 'cancelled', customer_phone: '+38970123456', sale_source: 'elyon_crm',
    source_type: 'manual', created_at: '2026-09-01T10:00:00Z', mex_tracking_id: null, ...over,
  });
  const orders = [
    o(1), o(2, { status: 'paid', customer_phone: '023123123' }), o(3, { customer_phone: '+35970123456' }),
    o(4, { status: 'take' }), o(5), o(6), o(7, { source_type: 'altercpa', sale_source: 'altercpa' }),
    o(8, { source_type: 'altercpa', sale_source: 'altercpa' }), o(9), o(10, { customer_phone: '+38970000000' }),
  ];
  const blocks = new Map([[uuid(5), ['agent_payout_items']], [uuid(6), ['affiliate_leads']]]);
  const cpaLeads = new Map([
    [uuid(7), [{ altercpa_id: '71', phase: 2, created_remote: new Date(now - 10 * DAY).toISOString() }]],
    [uuid(8), [{ altercpa_id: '81', phase: 1, created_remote: new Date(now - 200 * DAY).toISOString() }]],
  ]);
  it('applies the rules in order and hashes only the deletions', () => {
    const plan = classifyTestPhoneOrders({ orders, blocks, cpaLeads, hold: new Set(['ORD-50009']), nowMs: now });
    const rule = (d: string) => plan.rows.find((r: Row) => r.display_id === d)?.rule;
    expect(rule('ORD-50001')).toBe('delete');
    expect(rule('ORD-50002')).toBe('delete');
    expect(rule('ORD-50003')).toBe('other_prefix');
    expect(rule('ORD-50004')).toBe('open_in_agent_hands');
    expect(rule('ORD-50005')).toBe('in_payout');
    expect(rule('ORD-50006')).toBe('affiliate_lead');
    expect(rule('ORD-50007')).toBe('altercpa_would_recreate');
    expect(rule('ORD-50008')).toBe('delete');           // open at AlterCPA but 200 days old: no sweep reads it again
    expect(rule('ORD-50009')).toBe('held');
    expect(rule('ORD-50010')).toBeUndefined();          // not a test number
    expect(plan.counts.total).toBe(9);
    expect(plan.lines).toEqual([
      `${uuid(1)}:delete:cancelled:70123456`, `${uuid(2)}:delete:paid:23123123`, `${uuid(8)}:delete:cancelled:70123456`,
    ]);
  });
  it('--include-pending-altercpa deletes the lead AlterCPA would otherwise re-insert', () => {
    const plan = classifyTestPhoneOrders({ orders, blocks, cpaLeads, includePendingAltercpa: true, nowMs: now });
    expect(plan.rows.find((r: Row) => r.display_id === 'ORD-50007')?.rule).toBe('delete');
  });
});

describe('the dependent-table map is checked against the live foreign keys', () => {
  const live = DEPENDENTS.filter((d: Row) => d.fk).map((d: Row) => ({
    tbl: `public.${d.table}`, col: d.column, rule: { CASCADE: 'c', 'SET NULL': 'n', 'NO ACTION': 'a' }[String(d.fk)],
  }));
  it('passes on exactly the documented FKs (RESTRICT counts as NO ACTION)', () => {
    expect(verifyForeignKeys(live)).toEqual([]);
    expect(verifyForeignKeys(live.map((r: Row) => (r.tbl === 'public.agent_payout_items' ? { ...r, rule: 'r' } : r)))).toEqual([]);
  });
  it('blocks an apply on an unknown, changed or missing FK', () => {
    expect(verifyForeignKeys([...live, { tbl: 'public.new_table', col: 'order_id', rule: 'c' }])[0]).toMatch(/unknown foreign key new_table\.order_id/);
    expect(verifyForeignKeys(live.map((r: Row) => (r.tbl === 'public.mex_parcels' ? { ...r, rule: 'c' } : r)))[0]).toMatch(/mex_parcels\.order_id is ON DELETE CASCADE live/);
    expect(verifyForeignKeys(live.filter((r: Row) => r.tbl !== 'public.order_items'))[0]).toMatch(/order_items\.order_id .* not in the database/);
  });
  it('documents every FK the migrations define on orders(id), with its ON DELETE rule', () => {
    const fk = Object.fromEntries(DEPENDENTS.filter((d: Row) => d.fk).map((d: Row) => [`${d.table}.${d.column}`, d.fk]));
    expect(fk).toEqual({
      'order_items.order_id': 'CASCADE', 'order_history.order_id': 'CASCADE', 'order_notes.order_id': 'CASCADE',
      'order_unpaid_alerts.order_id': 'CASCADE', 'no_parcel_rule_items.order_id': 'CASCADE', 'affiliate_leads.order_id': 'CASCADE',
      'agent_payout_items.order_id': 'NO ACTION', 'altercpa_leads.order_id': 'SET NULL', 'mex_parcels.order_id': 'SET NULL',
      'orders.duplicated_from': 'SET NULL', 'prediction_segment_members.trigger_order_id': 'SET NULL',
    });
  });
  it('never deletes a ledger row: AlterCPA leads, MEX parcels, web orders are unlinked or untouched', () => {
    const act = Object.fromEntries(DEPENDENTS.map((d: Row) => [`${d.table}.${d.column}`, d.action]));
    expect(act['altercpa_leads.order_id']).toBe('unlink');
    expect(act['mex_parcels.order_id']).toBe('unlink');
    expect(Object.keys(act).some((k) => k.startsWith('web_orders'))).toBe(false);
  });
});

describe('the SQL a test-phones apply / restore sends', () => {
  const rows = [{ order_id: uuid(1), expect_status: 'cancelled', expect_phone: '+38970123456', expect_tracking: null, rule: 'delete', evidence: { order: 'ORD-1' } }];
  const s = buildDeleteChunkSql({ runId: uuid(99), rows });
  it('snapshots first, unlinks the ledgers, then deletes — in one transaction with the guards on', () => {
    expect(s).toContain("set local elyon.bulk_repair = 'on'");
    expect(s).toContain("set local elyon.keep_updated_at = 'on'");
    expect(s).not.toMatch(/session_replication_role/);
    expect(s).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);   // one implicit transaction per API call
    const snap = s.indexOf('insert into public.data_repair_rows');
    const unlinkLead = s.indexOf('update public.altercpa_leads x set order_id = null');
    const unlinkParcel = s.indexOf('update public.mex_parcels x set order_id = null, link_method = null, linked_at = null');
    const del = s.indexOf('delete from public.orders o using _ok k');
    expect(snap).toBeGreaterThan(0);
    expect(unlinkLead).toBeGreaterThan(snap);
    expect(unlinkParcel).toBeGreaterThan(snap);
    expect(del).toBeGreaterThan(unlinkParcel);
    expect(s).not.toMatch(/delete from public\.(altercpa_leads|mex_parcels|web_orders)/);
    expect(s).toContain('not exists (select 1 from public.agent_payout_items x where x.order_id = o.id)');
    expect(s).toContain('not exists (select 1 from public.affiliate_leads x where x.order_id = o.id)');
    expect(s).toContain("= any(ARRAY['70123456','23123123']::text[])");
  });
  it('the before-image holds the order and every dependent list', () => {
    const snap = orderSnapshotSql('o');
    expect(snap).toContain("'order', to_jsonb(o)");
    for (const d of DEPENDENTS) expect(snap).toContain(`'${d.table}.${d.column}'`);
    expect(depSnapshotSql(DEPENDENTS.find((d: Row) => d.table === 'orders'), 'o')).toContain('x.id <> o.id');
    expect(phoneSnapshotSql({ runId: uuid(99) })).toContain("'segment_members'");
  });
  it('restores exactly: AlterCPA money statuses via confirmed, write-once columns unlocked for the transaction only', () => {
    const cols = {
      orders: ['id', 'display_id', 'status', 'price', 'customer_phone', 'source_type', 'updated_at'],
      order_items: ['id', 'order_id', 'quantity'], order_history: ['id', 'order_id'], order_notes: ['id', 'order_id'],
      order_unpaid_alerts: ['order_id', 'alert_date'], no_parcel_rule_items: ['run_id', 'order_id'],
    };
    const r = buildRestoreSql({ runId: uuid(99), restoreRunId: uuid(98), orderIds: [uuid(1)], cols });
    expect(r).toContain("set local elyon.allow_sold_change = 'on'");
    expect(r).toContain("set local elyon.allow_source_change = 'on'");
    expect(r).toContain("set local elyon.keep_updated_at = 'on'");
    expect(r).toContain("when r.source_type = 'altercpa' and r.status::text in ('paid', 'returned', 'shipped', 'delivered') then 'confirmed'::public.order_status");
    expect(r).toContain('parcel(s) taken by another order since the delete');
    expect(r).not.toMatch(/session_replication_role/);
    expect(r).toContain('restored_from_run');
    expect(KEY).toBe('test-phones');
    expect(() => buildRestoreSql({ runId: uuid(99), restoreRunId: uuid(98), orderIds: [], cols })).toThrow();
  });
});
