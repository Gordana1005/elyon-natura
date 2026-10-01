import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Owner, Mile, 01.10.2026 — two folder rules:
//   A. "the collabBox folder decides": an AlterCPA order holding a NATURA teleshop / social parcel gives it to its
//      collabBox document, which becomes its own order (scripts/repair-folder-decides.mjs, scripts/lib/folder-decides.mjs)
//   B. "If there is delivery from MEX too or return, then of course we will import them": a 9110 parcel MEX delivered /
//      returned whose 10111 LEADS document no order holds becomes ONE order (migration 20260944000970,
//      scripts/repair-leads-parcel-orders.mjs, scripts/lib/leads-parcel-orders.mjs)
// The rules of B are SQL; these tests pin the JS that runs them and the pure classification of A.
import {
  KEY as LPO_KEY, EXPECTED as LPO_EXPECTED, PLAN_LINE_RE, inlinePlanSql, rpcPlanSql, planHashParity, writerPrice, targetFor,
  planCsvRows, createTables, buildRollbackSql as lpoRollbackSql, rollbackCheckSql as lpoRollbackCheckSql,
} from '../../scripts/lib/leads-parcel-orders.mjs';
import { functionBody } from '../../scripts/lib/link-lead-parcels.mjs';
import {
  KEY as FD_KEY, preParcelState, writerPrediction, classifyFolderDecides, deptMoves, personMoves, buildApplySql,
  buildRollbackSql as fdRollbackSql, rollbackCheckSql as fdRollbackCheckSql, STALE_LABEL_DAYS,
} from '../../scripts/lib/folder-decides.mjs';
import { cohortAfter } from '../../scripts/verify-folder-orders.mjs';
import { candidateHash, SNAP_COLUMNS } from '../../scripts/lib/repair-kit.mjs';
import { assertReadOnly } from '../../scripts/verify-insights-ties.mjs';

const MIG = readFileSync(join(process.cwd(), 'supabase/migrations/20260944000970_leads_parcel_orders.sql'), 'utf8');
const md5 = (s: string) => createHash('md5').update(s.replace(/\r/g, '')).digest('hex');
const planBody = functionBody(MIG, 'FUNCTION public.leads_parcel_orders_plan(', '$plan$');
const applyBody = functionBody(MIG, 'FUNCTION public.leads_parcel_orders(p_apply');
const nightlyBody = functionBody(MIG, 'FUNCTION public.leads_parcel_orders_nightly(');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;

// ─── B. a LEADS document becomes an order when MEX delivered / returned ─────────────────────────────────────

describe('B — the plan is ONE read-only SELECT the cron and the backfill share', () => {
  it('inlines $1::integer exactly once and passes the repo read-only guard', () => {
    const q = inlinePlanSql(MIG, 75);
    expect(q.startsWith('SELECT (')).toBe(true);
    expect(q).toContain('coalesce(75::integer, 75)');
    expect(q).not.toMatch(/\$1/);
    expect(() => assertReadOnly(q)).not.toThrow();
    expect(() => assertReadOnly(rpcPlanSql(75))).not.toThrow();
    expect(() => inlinePlanSql(MIG, 0)).toThrow();
    expect(() => inlinePlanSql(MIG, 401)).toThrow();
  });

  it('calls only what the read-only role may execute (the writer helpers are spelled out)', () => {
    expect(planBody).not.toMatch(/collabbox_num\s*\(|collabbox_mk_phone8\s*\(|collabbox_items\s*\(|collabbox_author_identity\s*\(/);
    expect(planBody).toContain("'^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'");   // collabbox_mk_phone8
    expect(planBody).toContain("'^-?[0-9]+(\\.[0-9]+)?$'");                                     // collabbox_num
  });

  it('states the owner\'s rules literally', () => {
    expect(planBody).toContain("p.series = '9110'");
    expect(planBody).toContain('p.status_id IN (2, 7)');                       // delivered or returned — in transit waits
    expect(planBody).toContain('coalesce(p.cod_mkd, 0) > 0');
    expect(planBody).toContain('p.order_id IS NULL');
    expect(planBody).toContain('NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)');
    expect(planBody).toContain('NOT (p.phone8 = ANY (prm.ex8))');             // report_excluded_phone8s()
    expect(planBody).toContain("dc.doc_type_id IS DISTINCT FROM '10111' OR dc.role IS DISTINCT FROM 'credit'");
    expect(planBody).toContain("dc.outcome IS DISTINCT FROM 'credit_pending'");
    expect(planBody).toContain('public.link_lead_parcels_plan((SELECT days FROM prm))');   // the nightly linker's own plan
    expect(planBody).toContain("IN ('altercpa', 'elyon_crm')) AS affiliate_sales");          // a living Affiliate sale = a twin
    expect(planBody).toContain('30 AS twin_days');
    expect(planBody).toContain('61.5::numeric AS rate');                                     // MKD_PER_EUR, frozen
    expect(planBody).toContain('public.collabbox_sale_at(d.doc_at, least(coalesce(d.booked_at, d.doc_at), d.doc_at))');
    expect(planBody).toContain(`encode(sha256(convert_to(coalesce((SELECT string_agg(x.line, E'\\n' ORDER BY x.line COLLATE "C") FROM mk2 x), ''), 'UTF8')), 'hex')`);
  });

  it('makes the order the writer\'s way and lets the LIVE writer credit the author — never AlterCPA', () => {
    expect(applyBody).toContain("'import', 'collabbox', _tr, 'home'");                       // external_order_id = the DocNumber
    expect(applyBody).toContain("'10111', (_it ->> 'shipped_at')::timestamptz");
    expect(applyBody).toContain("public.mex_link_parcel(_tr, _oid, 'collabbox_import', false)");
    expect(applyBody).toContain('public.collabbox_apply_documents(_sync, jsonb_build_array(_d.payload), false)');
    expect(applyBody).toContain("(_e ->> 'outcome') NOT IN ('updated', 'exists')");
    expect(applyBody).toContain('public.collabbox_items(_it -> \'goods_lines\', _price)');
    // sold_* are NOT in the INSERT: collabbox_credit_order (the live path) stamps them
    const insert = applyBody.slice(applyBody.indexOf('INSERT INTO public.orders ('), applyBody.indexOf('RETURNING id, display_id'));
    expect(insert).not.toMatch(/sold_at|sold_by|sold_via/);
    expect(applyBody).toContain("pg_advisory_xact_lock(hashtext('public.link_lead_parcels'))");
    expect(applyBody).toContain("set_config('elyon.keep_updated_at', 'on', true)");
    const code = MIG.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');   // the header names the push only to forbid it
    expect(code).not.toMatch(/altercpa-push|altercpa_push|affiliate_leads/i);
  });

  it('the cron: 21:06 after the link run, switch seeded report, guarded key; the drift guard knows the new body', () => {
    expect(MIG).toContain("'leads-parcel-orders',\n  '6 * * * *'");
    expect(MIG).toContain("VALUES ('leads_parcel_orders', jsonb_build_object('mode', 'report', 'days', 75))");
    expect(nightlyBody).toContain("r.key = 'link-lead-parcels' AND r.summary ->> 'trigger' = 'cron'");
    expect(nightlyBody).toContain('pg_sleep(5)');
    const guard = functionBody(MIG, 'FUNCTION public.tg_app_settings_guard_owner_keys(');
    expect(guard).toContain("'link_lead_parcels', 'leads_parcel_orders'");
    expect(MIG).toContain(`'e8bab1d453fb9bab1640c7d84c86e7c7', '${md5(guard)}'`);
  });

  it('the plan line + hash are the repair-kit\'s', () => {
    const lines = ['002-9110-176683/2026:LPO_create:paid:48.78:' + uuid(1), '002-9110-170096/2026:LPO_create:returned:24.23:-'];
    for (const l of lines) expect(l).toMatch(PLAN_LINE_RE);
    expect('002-9103-1/2026:LPO_create:paid:1.00:-').not.toMatch(PLAN_LINE_RE);
    const plan = { hash: candidateHash(lines), create: lines.map((line) => ({ line })) };
    expect(planHashParity(plan).ok).toBe(true);
    expect(planHashParity({ ...plan, hash: 'x' }).ok).toBe(false);
    expect(LPO_KEY).toBe('leads-parcel-orders');
    expect(LPO_EXPECTED.create).toBeGreaterThan(0);
  });

  it('the writer\'s price rule: goods ÷ 61,5 — unless the COD is neither goods nor goods + 150', () => {
    expect(writerPrice({ goodsMkd: 3000, amountMkd: 3000, nlines: 1, codMkd: 3000 })).toEqual({ price: 48.78, fromCod: false });
    expect(writerPrice({ goodsMkd: 3000, amountMkd: 3150, nlines: 2, codMkd: 3150 })).toEqual({ price: 48.78, fromCod: false });
    expect(writerPrice({ goodsMkd: 3000, amountMkd: 3000, nlines: 1, codMkd: 4000 })).toEqual({ price: 65.04, fromCod: true });
    expect(writerPrice({ goodsMkd: 0, amountMkd: 1640, nlines: 0, codMkd: 1640 })).toEqual({ price: 26.67, fromCod: false });
  });

  it('only a delivered or returned parcel qualifies', () => {
    expect(targetFor(2)).toBe('paid');
    expect(targetFor(7)).toBe('returned');
    for (const s of [1, 3, 4, 8, 9, 10, 13]) expect(targetFor(s)).toBeNull();
  });

  it('the owner tables: per status and per seller, the window and one month', () => {
    const plan = { create: [
      { target: 'paid', cod_mkd: 3000, author_person_id: uuid(1), author: 'A', sale_at: '2026-09-10T10:00:00Z' },
      { target: 'returned', cod_mkd: 1640, author_person_id: uuid(1), author: 'A', sale_at: '2026-08-10T10:00:00Z' },
      { target: 'paid', cod_mkd: 4000, author_person_id: null, author: 'Б', sale_at: '2026-09-11T10:00:00Z' },
    ] };
    const all = createTables(plan, new Map([[uuid(1), 'Ana']]));
    expect(all.n).toBe(3);
    expect(all.mkd).toBe(8640);
    expect(all.byAuthor.find((r: { seller: string }) => r.seller === 'Ana')).toMatchObject({ orders: 2, paid: 1, returned: 1 });
    expect(all.byAuthor.find((r: { seller: string }) => r.seller === 'Б (unmapped)')).toMatchObject({ orders: 1 });
    expect(createTables(plan, new Map(), '2026-09').n).toBe(2);
    const rows = planCsvRows({ create: [{ ...plan.create[0], tracking_id: 't', mex_status_id: 2, product_id: null }], manual: [{ tracking_id: 'm', reason: 'affiliate_sale_on_phone', orders: [{ display_id: 'ORD-1', status: 'paid', sale_source: 'altercpa' }] }] });
    expect(rows[0]).toMatchObject({ action: 'create', product_mapped: 'NO' });
    expect(rows[1]).toMatchObject({ action: 'manual', reason: 'affiliate_sale_on_phone' });
  });

  it('the undo deletes only orders the run made and still exactly as made; the register first, then the ledger row back', () => {
    const run = uuid(7);
    const q = lpoRollbackSql({ runId: run, rbRunId: uuid(8), actor: { id: uuid(9), email: 'mile@elyon.com' } });
    expect(q).toContain(`x.run_id = '${run}'::uuid and x.rule = 'LPO_create' and x.after is not null`);
    expect(q.indexOf('update public.mex_parcels mp')).toBeLessThan(q.indexOf('delete from public.orders where id = o.id'));
    expect(q).toContain('mp.order_id = o.id');
    expect(q).toContain("outcome = r.before -> 'doc' ->> 'outcome'");
    expect(q).toContain('exists (select 1 from public.agent_payout_items ap where ap.order_id = o.id)');
    expect(q).toContain("'rollback:LPO_create'");
    expect(() => assertReadOnly(lpoRollbackCheckSql(run))).not.toThrow();
  });
});

// ─── A. the collabBox folder decides ────────────────────────────────────────────────────────────────────────

const H = (order_id: string, from: string | null, to: string, by: string, at: string, person = false) =>
  ({ order_id, from_status: from, to_status: to, changed_by: person ? uuid(99) : null, changed_by_name: by, changed_at: at });

describe('A — what the AlterCPA order was before the parcel made it a sale', () => {
  const o = { id: uuid(1), status: 'paid', created_at: '2026-05-01T10:00:00Z', confirmed_at: '2026-05-02T10:00:00Z' };

  it('imported straight as paid (no history) → never cancelled: cancelled now, dated by the AlterCPA decision', () => {
    const s = preParcelState({ order: o, history: [], decidedAt: '2026-05-03T09:00:00Z' });
    expect(s).toMatchObject({ revertTo: 'cancelled', kind: 'never_cancelled', at: '2026-05-03T09:00:00.000Z' });
    expect(preParcelState({ order: o, history: [] }).at).toBe('2026-05-02T10:00:00.000Z');   // else confirmed_at
  });

  it('pending → shipped by MEX → never cancelled', () => {
    const h = [H(o.id, null, 'pending', 'System (altercpa:cpa.moe main)', '2026-05-01T10:00:00Z'),
      H(o.id, 'pending', 'shipped', 'System (mex:reconciliation)', '2026-05-05T10:00:00Z'),
      H(o.id, 'shipped', 'paid', 'System (mex:reconciliation)', '2026-05-08T10:00:00Z')];
    expect(preParcelState({ order: o, history: h })).toMatchObject({ kind: 'never_cancelled', before: 'pending' });
  });

  it('a cancel the parcel wiped is restored, dated by the move into it', () => {
    const h = [H(o.id, null, 'pending', 'x', '2026-05-01T10:00:00Z'), H(o.id, 'pending', 'cancelled', 'Ana', '2026-05-02T08:00:00Z', true),
      H(o.id, 'cancelled', 'returned', 'System (mex:reconciliation)', '2026-07-01T10:00:00Z')];
    expect(preParcelState({ order: o, history: h })).toMatchObject({ revertTo: 'cancelled', kind: 'restored', at: '2026-05-02T08:00:00.000Z' });
  });

  it('imported cancelled, then the AlterCPA cancel-other rule → restored cancel (dated by the decision / creation)', () => {
    const h = [H(o.id, 'cancelled', 'paid', 'System (altercpa:cancel-other-…)', '2026-08-11T10:00:00Z'),
      H(o.id, 'paid', 'confirmed', 'System (altercpa:cancel-other-…)', '2026-08-12T10:00:00Z'),
      H(o.id, 'confirmed', 'paid', 'System (altercpa:cancel-other-…)', '2026-08-13T10:00:00Z')];
    expect(preParcelState({ order: o, history: h })).toMatchObject({ revertTo: 'cancelled', kind: 'restored', at: '2026-05-01T10:00:00.000Z' });
  });

  it('a trash is restored as trash', () => {
    const h = [H(o.id, null, 'trashed', 'x', '2026-05-01T11:00:00Z'), H(o.id, 'trashed', 'paid', 'System (mex:reconciliation)', '2026-06-01T10:00:00Z')];
    expect(preParcelState({ order: o, history: h })).toMatchObject({ revertTo: 'trashed', kind: 'restored', at: '2026-05-01T11:00:00.000Z' });
  });
});

const cand = (over: Record<string, unknown> = {}) => ({
  id: uuid(1), display_id: 'ORD-1', status: 'paid', created_at: '2026-05-01T10:00:00Z', confirmed_at: null, sale_source: 'altercpa',
  sale_source_detail: 'history', sold_at: null, sold_by_person_id: uuid(50), tracking: '002-9102-170000/2026', series: '9102',
  mex_status_id: 2, mex_status_name: 'Delivered', cod_mkd: 2000, created_at_mex: '2026-07-20T07:00:00Z', reg_owner: uuid(1),
  link_method: 'tracking', doc_number: '002-9102-170000/2026', doc_type_id: '10050', doc_role: 'order', doc_outcome: 'conflict',
  doc_reason: 'parcel_held_by_other_order', doc_at: '2026-07-19T12:00:00Z', doc_sale_at: '2026-07-19T12:00:00Z', author: 'Тамара',
  author_person_id: uuid(60), amount_mkd: 2000, is_storno: false, reversed_by: null, vanished_at: null, has_payload: true,
  lines_complete: true, doc_is_order: false, web_claimed: false, in_payout: false, namers: 1, writer_p8: '70123457',
  writer_skip: null, writer_test_phone: false, writer_twins: null, dept_before: 'altercpa', dept_after: 'teleshop_out',
  led_decided_at: '2026-05-01T12:00:00Z', any_decided_at: '2026-05-01T12:00:00Z', ...over,
});

describe('A — which units move, which are listed', () => {
  const NOW = Date.parse('2026-10-01T20:00:00Z');

  it('the writer\'s branch-E verdict, predicted', () => {
    expect(writerPrediction(cand())).toBe('created');
    expect(writerPrediction(cand({ doc_number: null }))).toBe('no_document');
    expect(writerPrediction(cand({ doc_type_id: '10055', doc_role: 'record' }))).toMatch(/^not_an_order_document/);
    expect(writerPrediction(cand({ doc_outcome: 'replacement', doc_reason: 'replacement_zero_value' }))).toMatch(/^replacement/);
    expect(writerPrediction(cand({ writer_twins: 'ORD-9 paid' }))).toMatch(/^possible_twin_crm_sale/);
    expect(writerPrediction(cand({ writer_p8: null }))).toBe('no_phone');
    expect(writerPrediction(cand({ created_at_mex: '2026-07-18T07:00:00Z' }))).toBe('parcel_predates_document');
  });

  it('moves a paid AlterCPA order to cancelled and the parcel to its folder; lists payouts, LEADS orders, stale labels', () => {
    const cands = [
      cand(),
      cand({ id: uuid(2), display_id: 'ORD-2', in_payout: true, tracking: 't2', reg_owner: uuid(2) }),
      cand({ id: uuid(3), display_id: 'ORD-3', sale_source_detail: 'collabbox_leads', external_order_id: '002-9110-1/2026', tracking: 't3', reg_owner: uuid(3) }),
      cand({ id: uuid(4), display_id: 'ORD-4', mex_status_id: 8, created_at_mex: new Date(NOW - (STALE_LABEL_DAYS + 1) * DAY).toISOString(), tracking: 't4', reg_owner: uuid(4) }),
      cand({ id: uuid(5), display_id: 'ORD-5', mex_status_id: 8, created_at_mex: new Date(NOW - DAY).toISOString(), doc_at: new Date(NOW - 2 * DAY).toISOString(), tracking: 't5', reg_owner: uuid(5) }),
      cand({ id: uuid(6), display_id: 'ORD-6', status: 'cancelled', tracking: 't6', reg_owner: uuid(6) }),
      cand({ id: uuid(7), display_id: 'ORD-7', status: 'confirmed', tracking: 't7', reg_owner: uuid(7) }),
    ];
    const p = classifyFolderDecides({ cands, history: [], nowMs: NOW });
    expect(p.counts).toMatchObject({ candidates: 7, move: 3, manual: 3, excluded_payout: 1 });
    const byOrder = Object.fromEntries(p.csv.map((r: { order: string }) => [r.order, r]));
    expect(byOrder['ORD-1']).toMatchObject({ action: 'move', back_to: 'cancelled', how: 'never_cancelled', dept_after: 'Телешоп – Lead out' });
    expect(byOrder['ORD-3'].why).toMatch(/LEADS document/);
    expect(byOrder['ORD-4'].why).toMatch(/MEX 8/);
    expect(byOrder['ORD-5'].action).toBe('move');                      // a fresh label follows the writer (за пакување)
    expect(byOrder['ORD-7'].why).toMatch(/confirmed/);
    const u1 = p.units.find((u: { display_id: string }) => u.display_id === 'ORD-1');
    expect(u1.set).toMatchObject({ status: 'cancelled', cancellation_reason: 'other', mex_tracking_id: null, paid_at: null, cancelled_at: '2026-05-01T12:00:00.000Z' });
    expect(u1.history).toEqual({ from: 'paid', to: 'cancelled' });
    expect(u1.note).toMatch(/owner 01\.10\.2026/);
    expect(u1.note).toMatch(/Nothing was sent to AlterCPA/);
    // a dead holder keeps its status: only the MEX copy is cleared
    const u6 = p.units.find((u: { display_id: string }) => u.display_id === 'ORD-6');
    expect(u6.set).not.toHaveProperty('status');
    expect(u6.set).toMatchObject({ mex_tracking_id: null });
    expect(u6.history).toBeNull();
    for (const u of p.units) expect(['cancelled', 'trashed']).toContain(u.evidence.back_to);
    expect(p.lines.length).toBe(7);
    expect(FD_KEY).toBe('folder-decides');
  });

  it('money and people: a sale leaves Affiliate – Lead in and arrives in its folder, once', () => {
    const moves = [
      { tracking: 'a', cod: 2000, status_id: 2, dept_before: 'altercpa', dept_after: 'teleshop_out', person_before: uuid(50), person_after: uuid(60), day_before: '2026-06-01T10:00:00Z', day_after: '2026-07-01T10:00:00Z' },
      { tracking: 'b', cod: 3000, status_id: 7, dept_before: 'altercpa', dept_after: 'social', person_before: null, person_after: uuid(60), day_before: '2026-09-01T10:00:00Z', day_after: '2026-09-02T10:00:00Z' },
    ];
    const all = deptMoves(moves);
    expect(all.find((r: { department: string }) => r.department === 'Affiliate – Lead in')).toMatchObject({ '−orders': 2, '−ден': '5.000' });
    expect(deptMoves(moves, '2026-09').find((r: { department: string }) => r.department === 'Социјални мрежи')).toMatchObject({ '+orders': 1 });
    expect(deptMoves(moves, '2026-09').find((r: { department: string }) => r.department === 'Телешоп – Lead out')).toBeUndefined();
    const people = personMoves(moves, new Map([[uuid(50), 'Nina'], [uuid(60), 'Тамара']]));
    expect(people.find((r: { person: string }) => r.person === 'Тамара')).toMatchObject({ '+sales': 2, '+ден': '5.000' });
    expect(people.find((r: { person: string }) => r.person === 'Nina')).toMatchObject({ '−sales': 1 });
    expect(people.find((r: { person: string }) => r.person === '(nobody credited)')).toMatchObject({ '−sales': 1 });
  });
});

describe('A — the apply and the undo', () => {
  const typeMap = Object.fromEntries([...SNAP_COLUMNS, 'shipped_at'].map((c) => [c, c.endsWith('_at') ? 'timestamp with time zone' : c.includes('status_id') || c.includes('cod') ? 'integer' : 'text']));
  const p = classifyFolderDecides({ cands: [cand()], history: [], nowMs: Date.parse('2026-10-01T20:00:00Z') });

  it('one sub-transaction per unit: revert + unlink, then the LIVE writer must answer created', () => {
    const q = buildApplySql({ runId: uuid(7), syncRun: uuid(8), units: p.units, typeMap });
    expect(q).toContain('do $fd$');
    expect(q).toContain(`public.collabbox_apply_documents('${uuid(8)}'::uuid, jsonb_build_array(d.payload), false)`);
    expect(q).toContain("e ->> 'outcome' is distinct from 'created'");
    expect(q).toContain("raise exception 'the parcel is not on the new order'");
    expect(q).toContain("update public.mex_parcels set order_id = null, link_method = null, linked_at = null");
    expect(q).toContain("'System (repair:folder-decides)'");
    expect(q).toContain('exception when others then');
    expect(q.indexOf("'FD_revert'")).toBeLessThan(q.indexOf('collabbox_apply_documents'));
    expect(() => buildApplySql({ runId: uuid(7), syncRun: uuid(8), units: [{ ...p.units[0], set: { status: 'confirmed' } }], typeMap })).toThrow(/confirmed/);
  });

  it('the undo removes the made order, puts the ledger row and the AlterCPA order + register back', () => {
    const q = fdRollbackSql({ runId: uuid(7), rbRunId: uuid(9), actor: { id: uuid(10), email: 'mile@elyon.com' }, typeMap });
    expect(q).toContain("delete from public.orders where id = n.id");
    expect(q).toContain("outcome = r.evidence -> 'doc_before' ->> 'outcome'");
    expect(q).toContain("for bp in select x from jsonb_array_elements(r.before -> 'parcels') x loop");
    expect(q).toContain("'rollback:FD_revert'");
    expect(() => assertReadOnly(fdRollbackCheckSql(uuid(7)))).not.toThrow();
  });

  it('rollback-repair.mjs refuses both keys (each run made orders)', () => {
    const rb = readFileSync(join(process.cwd(), 'scripts/rollback-repair.mjs'), 'utf8');
    expect(rb).toContain("if (key === 'folder-decides' || key === 'leads-parcel-orders') {");
  });
});

describe('the Σ cohort check (verify-folder-orders C1)', () => {
  it('a moved parcel leaves its department and arrives in the new one; Σ moves only across the window edge', () => {
    const totals = { altercpa: { n: 10, mkd: 30000 }, teleshop_out: { n: 5, mkd: 10000 } };
    const rows = [
      { kind: 'order', source: 'altercpa', tracking_id: 'a', sale_day: '2026-09-05', in_total: true, value_mkd: 2000 },
      { kind: 'mex', source: 'altercpa', tracking_id: 'b', sale_day: '2026-09-30', in_total: true, value_mkd: 3000 },
    ];
    const moves = [
      { tracking: 'a', dept_after: 'teleshop_out', day_after: '2026-09-04', value_mkd: 2000 },
      { tracking: 'b', dept_after: 'altercpa', day_after: '2026-10-01', value_mkd: 3000 },   // booked after the window
    ];
    const r = cohortAfter({ totals, rows, moves, from: '2026-09-01', to: '2026-09-30' });
    const by = Object.fromEntries(r.table.map((x: { department: string }) => [x.department, x]));
    expect(by['Affiliate – Lead in']).toMatchObject({ before: 30000, after: 25000 });
    expect(by['Телешоп – Lead out']).toMatchObject({ before: 10000, after: 12000 });
    expect(r.sumA - r.sumB).toBe(-3000);
    expect(r.crossing.map((c: { tracking: string }) => c.tracking)).toEqual(['b']);
    expect(r.twice).toEqual([]);
  });
});
