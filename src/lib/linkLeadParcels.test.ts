import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Owner, Mile, 01.10.2026: an orphan BIO NATURAL parcel is linked to its CRM order by phone + date (amount ignored),
// and the 10-day no-parcel rule spares a sale entered in collabBox or a postponed delivery. The RULES are SQL
// (migrations 20260944000950 / 0960); these tests pin the JS that runs them (inline extraction, the ledger's hash,
// the snapshot shape rollback-repair.mjs reads) and prove the postponement regex on the owner's examples.
import {
  KEY, EXPECTED, PLAN_LINE_RE, POSTPONE_FIXTURES, functionBody, inlinePlanSql, rpcPlanSql, planHashParity, planCsvRows,
  moveTable, compareWithElyonRepair, noParcelBody, regexConstants, sqlStringValue, inlineNoParcelScanSql, postponedTextJs,
  recreditBucket, skopjeDayRange, PLAN_MIGRATION, LINK_MIGRATION,
} from '../../scripts/lib/link-lead-parcels.mjs';
import { SNAP_COLUMNS, candidateHash, lineOrderId } from '../../scripts/lib/repair-kit.mjs';
import { assertReadOnly } from '../../scripts/verify-insights-ties.mjs';
import { foldFixtureSql, postponeFixtureSql, FOLD_FIXTURES, excludedPairSql } from '../../scripts/verify-parcel-link-rules.mjs';
import { crmReasonFor } from '../../supabase/functions/altercpa-sync/altercpa';
import { scopeSql, recreditLines, buildRecreditBatchSql, buildRecreditRollbackSql, rollbackCheckSql } from '../../scripts/collabbox-recredit.mjs';

const mig = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8');
const PLAN = mig('20260944000950_link_lead_parcels.sql');            // the apply / nightly / snapshot / switch (and plan v1)
const PLAN_V2 = mig('20260944000980_link_lead_parcels_exclusions.sql');   // THE plan body today (rule 2b)
const EXEMPT = mig('20260944000960_no_parcel_exemptions.sql');
const md5 = (s: string) => createHash('md5').update(s.replace(/\r/g, '')).digest('hex');
const planBody = functionBody(PLAN_V2, 'FUNCTION public.link_lead_parcels_plan(', '$plan$');
const planBodyV1 = functionBody(PLAN, 'FUNCTION public.link_lead_parcels_plan(', '$plan$');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the plan is ONE read-only SELECT the cron and the backfill share', () => {
  it('inlines $1::integer exactly once and passes the repo read-only guard', () => {
    expect(PLAN_MIGRATION).toBe('20260944000980_link_lead_parcels_exclusions.sql');
    expect(LINK_MIGRATION).toBe('20260944000950_link_lead_parcels.sql');
    expect(() => assertReadOnly(inlinePlanSql(PLAN, 75))).not.toThrow();
    const q = inlinePlanSql(PLAN_V2, 75);
    expect(q.startsWith('SELECT (')).toBe(true);
    expect(q).toContain('coalesce(75::integer, 75)');
    expect(q).not.toMatch(/\$1/);
    expect(() => assertReadOnly(q)).not.toThrow();
    expect(() => assertReadOnly(rpcPlanSql(75))).not.toThrow();
    expect(() => inlinePlanSql(PLAN_V2, 0)).toThrow();
    expect(() => inlinePlanSql(PLAN, 401)).toThrow();
    expect(() => inlinePlanSql(PLAN.replace('coalesce($1::integer, 75)', 'coalesce($1::integer, $1::integer)'), 75)).toThrow(/exactly once/);
  });

  it('states the owner\'s rules literally (windows, statuses, series, 72 h, uniqueness)', () => {
    expect(planBody).toContain("o.created_at BETWEEN pr.created_at_mex - interval '10 days' AND pr.created_at_mex + interval '1 day'");
    expect(planBody).toContain("right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = pr.phone8");   // idx_orders_phone_last8
    expect(planBody).toContain("o.status::text IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed')");
    expect(planBody).toContain("(p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))");
    expect(planBody).toContain('o.mex_tracking_id IS NULL');
    expect(planBody).toContain("o.sale_source_detail IS DISTINCT FROM 'disposition'");
    expect(planBody).toContain('NOT public.is_synthetic_product_name(o.product_name)');
    expect(planBody).toContain('NOT (p.phone8 = ANY (prm.ex8))');
    expect(planBody).toContain('72 AS product_hours');
    expect(planBody).toContain('WHERE pc.n = 1 AND oc.n = 1');
    // the amount is ignored: no COD / price comparison anywhere in the rules
    expect(planBody).not.toMatch(/61\.5|cod_mkd\s*-|codFit|price\s*\*/);
    // the MEX law (8 = за пакување → no status change)
    expect(planBody).toMatch(/WHEN d\.status_id = 8 THEN NULL/);
    // the hash is the repair-kit's: sha256 of the lines sorted bytewise, joined by \n
    expect(planBody).toContain(`encode(sha256(convert_to(coalesce((SELECT string_agg(x.line, E'\\n' ORDER BY x.line COLLATE "C") FROM lk2 x), ''), 'UTF8')), 'hex')`);
  });

  it('applies through mex_link_parcel(…, \'repair\'), never AlterCPA, never a price', () => {
    const apply = functionBody(PLAN, 'FUNCTION public.link_lead_parcels(p_apply');
    expect(apply).toContain("public.mex_link_parcel(_tr, _oid, 'repair', false)");
    expect(apply).not.toMatch(/altercpa_push|altercpa-push|SET price|price =/i);
    expect(apply).toContain("set_config('elyon.bulk_repair', 'on', true)");
    expect(apply).toContain("set_config('elyon.keep_updated_at', 'on', true)");
    expect(apply).toContain('pg_try_advisory_xact_lock');
    expect(apply).toContain("_rr.candidate_hash IS DISTINCT FROM _hash");
    expect(PLAN).toMatch(/cron\.schedule\(\s*'link-lead-parcels',\s*'2 \* \* \* \*'/);
    expect(PLAN).toContain("VALUES ('link_lead_parcels', jsonb_build_object('mode', 'report', 'days', 75))");
  });

  it('writes the ledger snapshot in exactly the repair-kit shape (rollback-repair.mjs reads it)', () => {
    const snap = functionBody(PLAN, 'FUNCTION public.link_lead_parcels_snapshot(');
    const keys = [...snap.matchAll(/'([a-z_]+)', o\.\1/g)].map((m) => m[1]);
    expect(keys).toEqual(SNAP_COLUMNS);
    expect(snap).toContain("'parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('tracking_id', mp.tracking_id, 'order_id', mp.order_id,");
    expect(PLAN).toMatch(/link_lead_parcels_snapshot\(p_order uuid, p_tracking text\)[\s\S]*?SET "TimeZone" TO 'UTC'/);
  });

  it('re-emits the owner-key guard from its live body with ONE edit (drift guard md5s are right)', () => {
    const before = functionBody(mig('20260943001800_guard_mex_push_switch.sql'), 'FUNCTION public.tg_app_settings_guard_owner_keys(');
    const after = functionBody(PLAN, 'FUNCTION public.tg_app_settings_guard_owner_keys(');
    expect(PLAN).toContain(`'${md5(before)}', '${md5(after)}'`);
    expect(after).toBe(before.replace("'mex_push']", "'mex_push', 'link_lead_parcels']"));
  });
});

describe('rule 2b (20260944000980): duplicates and AlterCPA leads created after the booking are dropped before rule 3', () => {
  const seg = (body: string, from: string, to: string) => {
    const a = body.indexOf(from), b = body.indexOf(to, a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    return body.slice(a, b);
  };

  it('re-emits the plan from the LIVE 0950 body with a drift guard on both md5s', () => {
    expect(PLAN_V2).toContain(`('public.link_lead_parcels_plan(integer)', '${md5(planBodyV1)}', '${md5(planBody)}')`);
    expect(md5(planBodyV1)).toBe('bb592cb550602f8dc27c59b06db49452');   // live on 01.10.2026 23:40 Skopje
    expect(PLAN_V2).not.toMatch(/CREATE OR REPLACE FUNCTION public\.link_lead_parcels\(|link_lead_parcels_nightly\(_force|cron\.schedule/);
  });

  it('keeps every other rule identical: rules 1–2, and rule 4 … the plan lines, byte for byte', () => {
    expect(seg(planBody, 'WITH prm AS MATERIALIZED', '-- rule 2b')).toBe(seg(planBodyV1, 'WITH prm AS MATERIALIZED', 'pc AS ('));
    expect(seg(planBody, '-- rule 4 (only a pair', 'mn AS (')).toBe(seg(planBodyV1, '-- rule 4 (only a pair', 'mn AS ('));
    // rule 3 now counts the KEPT candidates
    expect(planBody).toContain('pc AS (SELECT c.tracking_id, count(*)::int AS n FROM ck c GROUP BY 1)');
    expect(planBody).toContain('oc AS (SELECT c.order_id, count(*)::int AS n FROM ck c GROUP BY 1)');
    expect(planBody).toContain('SELECT c.* FROM ck c\n    JOIN pc ON pc.tracking_id = c.tracking_id');
    // a parcel rule 2b emptied stays on the manual list (leads_parcel_orders_plan reads it as a link-plan candidate)
    expect(planBody).toContain("CASE WHEN pc.n IS NULL THEN 'only_excluded_candidates'");
    expect(planBody).toContain('FROM (SELECT DISTINCT c.tracking_id FROM cand c) p');
  });

  it('a duplicate = a DEAD order with the CRM\'s / the bridge\'s / the mirror\'s own mark — never free text', () => {
    expect(planBody).toContain("WHEN c.status IN ('cancelled', 'trashed')");
    expect(planBody).toContain("(c.status = 'cancelled' AND o.cancellation_reason = 'duplicate_order')");
    expect(planBody).toContain("(c.status = 'trashed' AND o.trash_reason = 'duplicate_order')");
    expect(planBody).toContain("l.decision = 'trashed' AND l.reason = 7");
    expect(planBody).not.toMatch(/нарачал|naracal|vcera|вчера/i);
    const rx = planBody.match(/o\.trash_reason_notes ~\* '([^']+)'/)?.[1];
    expect(rx).toBe('^duplicate( —|$)');
    const re = new RegExp(rx!, 'i');
    // exactly what altercpa-sync writes for an AlterCPA TRASH reason 7 (the label kept ahead of the comment)
    expect(crmReasonFor('trash', 7, 'ne se javuva')).toEqual({ value: 'other', notes: 'duplicate — ne se javuva' });
    expect(re.test(crmReasonFor('trash', 7, 'ne se javuva').notes!)).toBe(true);
    expect(re.test(crmReasonFor('trash', 7, '').notes!)).toBe(true);
    expect(crmReasonFor('cancel', 7, 'x').value).toBe('duplicate_order');   // a CANCEL reason 7 → the reason value itself
    for (const note of ['duplicates', 'веќе нарачал', 'не е duplicate', 'wrong number — duplicate']) expect(re.test(note)).toBe(false);
  });

  it('after_booking = an AlterCPA lead that came into existence after THE booking of the parcel\'s document', () => {
    expect(planBody).toContain('public.collabbox_sale_at(d.doc_at, d.booked_at) AS at FROM public.collabbox_documents d');
    expect(planBody).toContain('WHERE d.doc_number = c.tracking_id AND d.vanished_at IS NULL');
    expect(planBody).toContain("(o.sale_source_detail IN ('bridge', 'history') OR la.n > 0)");
    expect(planBody).toContain('least(o.created_at, la.lead_at)');   // the EARLIEST evidence the lead existed
    // a date-only history import (the 14:00:00 stamp) is compared by Skopje DAY, strictly after
    expect(planBody).toContain("OR (o.created_at AT TIME ZONE 'Europe/Skopje')::time = time '14:00:00'");
    expect(planBody).toMatch(/AT TIME ZONE 'Europe\/Skopje'\)::date\s+> \(bk\.at AT TIME ZONE 'Europe\/Skopje'\)::date/);
    expect(planBody).toContain('ELSE least(o.created_at, la.lead_at) > bk.at END');
  });

  it('counts what it dropped, and the verify spells rule 2b out independently (read-only)', () => {
    expect(planBody).toContain("'excluded', (SELECT count(*) FROM cx WHERE cx.excluded IS NOT NULL)");
    expect(planBody).toContain("'excluded', x.excluded");
    expect(planBody).toContain("'rule', 'link-lead-parcels v2 (owner 01.10.2026)");
    const q = `SELECT (${excludedPairSql('o', "'002-9110-1/2026'")}) AS why FROM public.orders o LIMIT 1`;
    expect(() => assertReadOnly(q)).not.toThrow();
    expect(excludedPairSql('o', 'p.tracking_id')).toContain("LIKE 'duplicate —%'");
    expect(excludedPairSql('o', 'p.tracking_id')).not.toContain('~*');   // not the plan's own regex: an independent spelling
  });
});

describe('the ledger contract: plan lines, hash, CSV', () => {
  const plan = {
    hash: '', link: [
      { tracking_id: '002-9110-1/2026', order_id: uuid(1), display_id: 'ORD-1', status: 'cancelled', target: 'paid', kind: 'phone_date', hours: 20,
        sale_source: 'altercpa', product: 'Adenofrin', series: '9110', mex_status_id: 2, mex_status_name: 'Delivered', cod_mkd: 3000,
        created_at_mex: '2026-09-10T06:00:00Z', line: `${uuid(1)}:LL_phone_date:cancelled>paid:002-9110-1/2026` },
      { tracking_id: '002-9110-2/2026', order_id: uuid(2), display_id: 'ORD-2', status: 'cancelled', target: null, kind: 'phone_date_product', hours: 90,
        sale_source: 'altercpa', product: 'Neurofix', series: '9110', mex_status_id: 8, mex_status_name: 'Shipment created', cod_mkd: 2990,
        created_at_mex: '2026-09-11T06:00:00Z', line: `${uuid(2)}:LL_phone_date_product:cancelled>=:002-9110-2/2026` },
    ],
    manual: [{ tracking_id: '002-9110-3/2026', series: '9110', mex_status_id: 10, mex_status_name: 'In transit', cod_mkd: 4000,
      created_at_mex: '2026-09-12T06:00:00Z', reason: 'ambiguous_orders',
      orders: [{ display_id: 'ORD-3', status: 'cancelled', hours: 5, sale_source: 'altercpa', product: 'X' },
               { display_id: 'ORD-4', status: 'confirmed', hours: 40, sale_source: 'altercpa', product: 'Y' }] }],
  };
  plan.hash = candidateHash(plan.link.map((l) => l.line));

  it('every line has the ledger shape and lineOrderId reads its order', () => {
    for (const l of plan.link) {
      expect(l.line).toMatch(PLAN_LINE_RE);
      expect(lineOrderId(l.line)).toBe(l.order_id);
    }
    expect(planHashParity(plan)).toMatchObject({ ok: true });
    expect(planHashParity({ ...plan, hash: 'x' })).toMatchObject({ ok: false });
  });

  it('the CSV lists links then manual parcels with the reason; the move table counts by status → target', () => {
    const rows = planCsvRows(plan);
    expect(rows.map((r) => r.action)).toEqual(['link', 'link', 'manual']);
    expect(rows[1].target).toBe('(unchanged)');
    expect(rows[2]).toMatchObject({ why: 'ambiguous_orders', order: 'ORD-3 (cancelled, 5 h) | ORD-4 (confirmed, 40 h)' });
    expect(moveTable(plan).map((r) => r.move)).toEqual(['cancelled → paid', 'cancelled → unchanged (MEX 8)']);
  });

  it('sits next to the COD-based repair: agree / conflict / its re-ships', () => {
    const units = [
      { rows: [{ order_id: uuid(1), rule: 'LE_cancel_then_ship', link: { tracking: '002-9110-1/2026' }, evidence: { order: 'ORD-1' } }] },
      { rows: [{ order_id: uuid(9), rule: 'LE_no_parcel', link: { tracking: '002-9110-2/2026' }, evidence: { order: 'ORD-9' } }] },
      { rows: [{ order_id: uuid(7), rule: 'LE_reship', link: { tracking: '002-9110-7/2026' }, evidence: { order: 'ORD-7' } }] },
    ];
    expect(compareWithElyonRepair(plan, units)).toEqual({
      agree: 1, conflict: [{ tracking: '002-9110-2/2026', elyon_order: 'ORD-9', kind: 'no_parcel' }],
      only_elyon: { reship: 1, no_parcel: 0, cancel_then_ship: 0 },
    });
  });

  it('expects the owner\'s own count of 01.10.2026', () => {
    expect(KEY).toBe('link-lead-parcels');
    expect(EXPECTED).toEqual({ parcels: 397, link: 98, manual: 46 });
  });
});

describe('rule 4 — the name fold proof runs the plan\'s OWN expression', () => {
  it('lifts the fold and the stop words out of the plan body into a read-only SELECT', () => {
    const q = foldFixtureSql(planBody);
    expect(() => assertReadOnly(q)).not.toThrow();
    expect(q).toContain('public.mk_geo_norm(fx.l)');
    expect(q).toContain("'bionatural'");
    expect(FOLD_FIXTURES.some(([o, l, want]) => o === 'GlucoFix' && /GlucoCare/.test(l) && want === false)).toBe(true);
  });
});

describe('the no-parcel exemptions (20260944000960)', () => {
  const body = noParcelBody(EXEMPT);

  it('starts from the LIVE body of apply_no_parcel_rule (= 20260942000700) and the guard md5s are right', () => {
    const live = functionBody(mig('20260942000700_department_sources.sql'), 'FUNCTION public.apply_no_parcel_rule(');
    expect(md5(live)).toBe('f2ed73a70435a9726ad7071b7dffdb64');
    expect(EXEMPT).toContain(`'f2ed73a70435a9726ad7071b7dffdb64', '${md5(body)}'`);
    // counted edits only: every line the new body drops is one of E3/E4/E6/E7/E8's
    const kept = new Set(body.split('\n'));
    const dropped = live.split('\n').filter((l) => !kept.has(l));
    expect(dropped).toHaveLength(12);
    expect(dropped.every((l) => /other_order_id|FROM anp a;|unlinked_tracking IS (NOT )?NULL|INTO _cand|needs_linking, value_eur, settings\)|_link, round\(_value, 2\), _cfg\)|parcel_tracking, other_order_id\)/.test(l))).toBe(true);
    for (const e of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9']) expect(body).toContain(`-- ${e}`);
  });

  it('keeps the rule: 10 days, AlterCPA + affiliate, the 21:00 hour, cancel reason no_parcel_7d', () => {
    expect(body).toContain('_days      := public.no_parcel_rule_days();');
    expect(body).toContain("ARRAY['altercpa', 'affiliate']");
    expect(body).toContain("cancellation_reason = 'no_parcel_7d'");
    expect(body).toContain("WHEN s.unlinked_tracking IS NOT NULL THEN 'needs_linking'\n              WHEN s.collab_doc IS NOT NULL THEN 'in_collab'\n              WHEN s.postponed_note IS NOT NULL THEN 'postponed'\n              ELSE 'cancel' END AS plan_action");
    expect(body).toContain("WHERE n.plan_action = 'cancel'");
    expect(EXEMPT).toContain("CHECK (action IN ('cancel', 'needs_linking', 'cancelled', 'skipped', 'in_collab', 'postponed'))");
  });

  it('in_collab: a sales document for the customer since the sale, never a storno / another order\'s document', () => {
    expect(body).toContain("d.role IN ('credit', 'order', 'order_unless_held')");
    expect(body).toContain('d.reversed_by IS NULL AND d.vanished_at IS NULL');
    expect(body).toContain("d.doc_at >= a.sold_at - interval '1 day'");
    expect(body).toContain('(d.order_id IS NULL OR d.order_id = a.id)');
    expect(body).toContain('OR d.komitent_id IN (SELECT c.komitent_id FROM public.collabbox_customers c WHERE c.phone8 = a.p8)');
  });

  it('the postponement regex (JS twin built from the migration) on the owner\'s examples and the traps', () => {
    const postponed = postponedTextJs(body);
    for (const [text, want] of POSTPONE_FIXTURES) expect([text, postponed(text)]).toEqual([text, want]);
    // "will call back" is a cancellation reason, never a postponement
    expect(postponed('ќе се јави')).toBe(false);
    expect(postponed('да се јави после плата')).toBe(false);
    expect(sqlStringValue(regexConstants(body).c_rx_d)).toBe('(достав|стигн|стаса|испрат|прат[иаеку]|dostav|stign|stasa|isprat|prat[iaeku])');
  });

  it('the scan inlines to one read-only SELECT with no plpgsql variable left', () => {
    const q = inlineNoParcelScanSql(body, { days: 10, sources: ['altercpa', 'affiliate'], fromDate: '2026-08-01', today: '2026-10-01', postponeDays: 45 });
    expect(q.startsWith('WITH anp AS')).toBe(true);
    expect(q).toContain('make_interval(days => 10)');
    expect(q).toContain("ARRAY['altercpa', 'affiliate']::text[]");
    expect(q).toContain("<= 45");
    expect(q).not.toMatch(/\bc_rx_[dlwc]\b/);
    expect(() => assertReadOnly(`SELECT count(*) FROM (${q}) n`)).not.toThrow();
    expect(() => assertReadOnly(postponeFixtureSql(body))).not.toThrow();
    expect(() => inlineNoParcelScanSql(body, { days: 10, sources: ["x'; drop"], fromDate: '2026-08-01', today: '2026-10-01', postponeDays: 45 })).toThrow();
  });
});

describe('the collabBox credit re-run', () => {
  it('reads a live-path answer', () => {
    expect(recreditBucket({ outcome: 'credited', credit: 'stamped' })).toBe('credited (stamped)');
    expect(recreditBucket({ outcome: 'credit_pending', reason: 'parcel_not_linked_yet' })).toBe('still pending (parcel_not_linked_yet)');
    expect(recreditBucket({ outcome: 'recorded', credit: 'other_decider' })).toBe('recorded (other_decider)');
    expect(recreditBucket(undefined)).toBe('error');
  });
  it('scopes Skopje days, credit_pending LEADS documents, and (by default) only parcels an order holds', () => {
    const q = scopeSql({ from: '2026-09-01', to: '2026-10-01', reasons: ['parcel_not_linked_yet'], all: false });
    expect(q).toContain("d.outcome = 'credit_pending' and d.role = 'credit'");
    expect(q).toContain("('2026-09-01'::date::timestamp AT TIME ZONE 'Europe/Skopje')");
    expect(q).toContain("(('2026-10-01'::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje')");
    expect(q).toMatch(/and coalesce\(p\.order_id/);
    expect(scopeSql({ from: '2026-09-01', to: '2026-10-01', reasons: ['parcel_not_linked_yet'], all: true })).not.toMatch(/and coalesce\(p\.order_id/);
    expect(() => assertReadOnly(q)).not.toThrow();
    expect(() => skopjeDayRange('2026-10-02', '2026-10-01')).toThrow();
    expect(recreditLines([{ doc_number: '002-9110-1/2026', holder: uuid(1) }, { doc_number: '002-9110-2/2026', holder: null }]))
      .toEqual([`002-9110-1/2026:recredit:${uuid(1)}:`, '002-9110-2/2026:recredit::']);
  });
  it('one batch = one transaction through the LIVE writer, before/after in the ledger; the undo lifts the write-once guard', () => {
    const b = buildRecreditBatchSql({ runId: uuid(1), syncRun: uuid(2), docNumbers: ['002-9110-1/2026'] });
    expect(b).not.toMatch(/^\s*(begin|commit)\s*;/im);   // no BEGIN / COMMIT statement: the API's implicit transaction (kit contract)
    expect(b).toContain(`public.collabbox_apply_documents('${uuid(2)}'::uuid,`);
    expect(b).toMatch(/, false\) as res;/);
    expect(b).toContain("d.outcome = 'credit_pending'");
    expect(b).not.toMatch(/collabbox_credit_order|collabbox_apply_one/);   // another session's functions: called through the writer only
    const r = buildRecreditRollbackSql({ runId: uuid(1), rbRunId: uuid(3), actor: { id: uuid(4), email: 'x@y' } });
    expect(r).toContain("set local elyon.allow_sold_change = 'on';");
    expect(r).toContain('delete from _rb where not same;');
    expect(() => assertReadOnly(`${rollbackCheckSql(uuid(1))}`)).not.toThrow();
  });
});
