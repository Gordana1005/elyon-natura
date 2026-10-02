/**
 * verify-parcel-link-rules — READ-ONLY proof of the owner's 01.10.2026 parcel rules (migrations
 * 20260944000950 link_lead_parcels + 0980 rule 2b, 20260944000960 no-parcel exemptions). Runs before a migration (the
 * FILE's SQL, "inline") and after it (the LIVE functions, "rpc" — only while the live plan body equals the file), and
 * says which.
 *
 *   node scripts/verify-parcel-link-rules.mjs [--days 75] [--inline] [--json] [--list]
 *
 *   L1  the plan's hash = the repair-kit's sha256 of its sorted lines; every line has the ledger shape
 *   L2  rule 1, re-checked on the live rows by an INDEPENDENT query: every linked parcel is 9110/9103 (or BIO NATURAL
 *       without a series), COD > 0, inside the window, unlinked, named by no order, a valid non-test phone8
 *   L3  rule 2, re-checked the same way: every linked order is on the parcel's last-8 phone, created −10 d … +1 d,
 *       holds no parcel, a priced real sale, not a disposition, an allowed status
 *   L4  rule 3, counted independently (after rule 2b, spelled out here — excludedPairSql): each linked parcel has
 *       exactly ONE kept candidate order and each linked order is the kept candidate of exactly ONE orphan parcel
 *   L5  rule 4: phone_date ⇔ ≤ 72 h; every phone_date_product link has a collabBox document with goods lines
 *   L6  the status each order takes = the MEX law (2 → paid/basis · 7 → returned · 8 → unchanged · else → shipped)
 *   L7  no linked order sits in agent_payout_items or affiliate_leads
 *   L8  the name fold (rule 4) on the owner's examples, in PostgreSQL with the plan's OWN fold expression + stop words
 *   L9  after 20260944000980: the live plan body = the file (WARN while the live body is still 0950's); cron
 *       'link-lead-parcels' '2 * * * *'; the owner switch
 *   L10 rule 2b (0980): no linked order is a dead DUPLICATE or an AlterCPA lead created after its parcel's collabBox
 *       booking, and the independent count of dropped pairs = the plan's counts.excluded (by reason)
 *   N1  the postponement regex on the fixtures, in PostgreSQL, with the migration's OWN constants
 *   N2  today's no-parcel scan with the exemptions: candidates · needs_linking · in_collab · postponed · cancel
 *       (= how many orders each exemption saves today); vs tonight's run when it already ran
 *   N3  after 20260944000960: the live apply_no_parcel_rule body = the file
 *
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = refused / unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';
import {
  PLAN_MIGRATION, LINK_MIGRATION, EXEMPT_MIGRATION, PLAN_SIG, DEFAULT_DAYS, PLAN_LINE_RE, POSTPONE_FIXTURES,
  readMigration, functionBody, inlinePlanSql, rpcPlanSql, planOf, planHashParity, noParcelBody, regexConstants,
  inlineNoParcelScanSql,
} from './lib/link-lead-parcels.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md5 = (s) => createHash('md5').update(String(s).replace(/\r/g, '')).digest('hex');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const n = (v) => Number(v ?? 0) || 0;

/**
 * Rule 2b (20260944000980), spelled out INDEPENDENTLY of the plan body: is the (order `o`, parcel tracking `tr`)
 * pair dropped before the uniqueness check, and why → 'duplicate' | 'after_booking' | NULL.
 *   duplicate      o is cancelled / trashed AND marked a duplicate: duplicate_order (cancel or trash reason), the
 *                  bridge's trash note "duplicate" / "duplicate — …", or the AlterCPA mirror's trashed reason 7;
 *   after_booking  o is an AlterCPA lead (bridge / history, or a ledger row) whose earliest existence (created_at, the
 *                  lead's created_remote) is after the booking of the parcel's live collabBox document — by Skopje day
 *                  for a date-only history import (or the 14:00:00 import stamp).
 */
export const excludedPairSql = (o, tr) => `CASE
  WHEN (${o}.status = 'cancelled' AND (${o}.cancellation_reason = 'duplicate_order'
          OR EXISTS (SELECT 1 FROM public.altercpa_leads l7 WHERE l7.order_id = ${o}.id AND l7.reason = 7 AND l7.decision = 'trashed')))
    OR (${o}.status = 'trashed' AND (${o}.trash_reason = 'duplicate_order'
          OR (${o}.trash_reason = 'other' AND (lower(${o}.trash_reason_notes) = 'duplicate' OR lower(${o}.trash_reason_notes) LIKE 'duplicate —%'))
          OR EXISTS (SELECT 1 FROM public.altercpa_leads l7 WHERE l7.order_id = ${o}.id AND l7.reason = 7 AND l7.decision = 'trashed')))
    THEN 'duplicate'
  WHEN (${o}.sale_source_detail IN ('bridge', 'history') OR EXISTS (SELECT 1 FROM public.altercpa_leads la WHERE la.order_id = ${o}.id))
   AND EXISTS (SELECT 1 FROM public.collabbox_documents bd
                WHERE bd.doc_number = ${tr} AND bd.vanished_at IS NULL AND bd.doc_at IS NOT NULL
                  AND CASE WHEN ${o}.sale_source_detail = 'history'
                                OR to_char(${o}.created_at AT TIME ZONE 'Europe/Skopje', 'HH24:MI:SS') = '14:00:00'
                           THEN to_char(LEAST(${o}.created_at, (SELECT min(lr.created_remote) FROM public.altercpa_leads lr WHERE lr.order_id = ${o}.id))
                                        AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD')
                                > to_char(public.collabbox_sale_at(bd.doc_at, bd.booked_at) AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD')
                           ELSE LEAST(${o}.created_at, (SELECT min(lr.created_remote) FROM public.altercpa_leads lr WHERE lr.order_id = ${o}.id))
                                > public.collabbox_sale_at(bd.doc_at, bd.booked_at) END)
    THEN 'after_booking'
END`;

/** The owner's rule-4 examples: order product → collabBox line → must the names match? */
export const FOLD_FIXTURES = Object.freeze([
  ['Adenofrin', 'ADENOFRIN 20/1 cps', true],
  ['ProstaFix', 'PROSTA FIX BIONATURAL 30/1', true],
  ['Prosta Fix', 'PROSTA FIX BIONATURAL 30/1', true],
  ['Neurofix x3', 'NEUROFIX BIONATURAL 30/1', true],
  ['Cardiofix', 'КАРДИОФИКС 30 капсули', true],
  ['R&R Melem', 'МЕЛЕМ R&R 30МЛ', true],
  ['Alpha Male', 'ALPHA MALE BIONATURAL 30.1', true],
  ['GlucoFix', 'Dr Becker GlucoCare 20/1 cps', false],
  ['GlucoFix', 'PROSTA FIX BIONATURAL 30/1', false],
  ['Adenofrin', 'PARAFIX BIONATURAL 30/1cps PROSTA FIX BIONATURAL 30/1', false],
  ['Magnesium Bisglycinate', 'MAGNESIUM CITRAT 325mg 150/1 tab', false],
]);

/** L8: the plan's fold expression and stop words, lifted out of the plan body. */
export function foldFixtureSql(planBody) {
  const f = planBody.match(/fold AS \(\s*SELECT t\.kind, t\.ref, t\.part, t\.word,\s*([\s\S]*?)\s+AS k\s+FROM txt t\s*\)/);
  const s = planBody.match(/unnest\((ARRAY\[[\s\S]*?\])\) AS s\(w\)/);
  if (!f || !s) throw new Error('the fold expression / stop words are not in the plan body');
  const fold = (col) => f[1].replace(/t\.raw/g, col);
  const rows = FOLD_FIXTURES.map(([o, l, want], i) => `(${i}, ${lit(o)}, ${lit(l)}, ${want})`).join(', ');
  return `WITH fx(i, o, l, want) AS (VALUES ${rows}),
stop AS (SELECT DISTINCT ${fold('w')} AS k FROM unnest(${s[1]}) AS x(w)),
words AS (SELECT fx.i, ${fold('w.w')} AS k, w.ord FROM fx CROSS JOIN LATERAL regexp_split_to_table(fx.o, '[^[:alpha:]]+') WITH ORDINALITY AS w(w, ord)),
keys AS (SELECT i, array_agg(k ORDER BY ord) AS keys FROM words WHERE length(k) >= 3 AND k NOT IN (SELECT k FROM stop) GROUP BY i),
line AS (SELECT fx.i, ${fold('fx.l')} AS txt FROM fx)
SELECT fx.i, fx.o, fx.l, fx.want, k.keys, li.txt,
       (length(array_to_string(k.keys, '')) >= 4 AND NOT EXISTS (SELECT 1 FROM unnest(k.keys) kw WHERE position(kw IN li.txt) = 0)) AS got
  FROM fx LEFT JOIN keys k ON k.i = fx.i JOIN line li ON li.i = fx.i ORDER BY fx.i`;
}

/** N1: the fixtures through the migration's own regex constants. */
export function postponeFixtureSql(body) {
  const rx = regexConstants(body);
  const rows = POSTPONE_FIXTURES.map(([t, want], i) => `(${i}, ${lit(t)}, ${want})`).join(', ');
  return `WITH fx(i, t, want) AS (VALUES ${rows})
SELECT fx.i, fx.t, fx.want,
       (lower(fx.t) ~ ((${rx.c_rx_d}) || '.{0,40}' || (${rx.c_rx_l}))
        OR lower(fx.t) ~ ((${rx.c_rx_l}) || '.{0,40}' || (${rx.c_rx_d}))
        OR (lower(fx.t) ~ (${rx.c_rx_w}) AND lower(fx.t) !~ (${rx.c_rx_c}))) AS got
  FROM fx ORDER BY fx.i`;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { days: DEFAULT_DAYS, inline: false, json: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--inline') args.inline = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--list') args.list = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const results = [];
  const add = (id, status, detail) => results.push({ id, status, detail });

  // ── which bodies run ──
  const planFile = readMigration(ROOT, PLAN_MIGRATION);
  const exemptFile = readMigration(ROOT, EXEMPT_MIGRATION);
  const [st] = await runSql(`SELECT to_regprocedure(${lit(PLAN_SIG)}) IS NOT NULL AS plan_live,
      (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(${lit(PLAN_SIG)})) AS plan_md5,
      (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.apply_no_parcel_rule(boolean,boolean)')) AS anpr_md5,
      (SELECT pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid = to_regprocedure('public.apply_no_parcel_rule(boolean,boolean)')) AS anpr_def,
      (SELECT schedule FROM cron.job WHERE jobname = 'link-lead-parcels') AS cron,
      (SELECT value FROM public.app_settings WHERE key = 'link_lead_parcels') AS setting,
      (SELECT value FROM public.app_settings WHERE key = 'no_parcel_rule') AS np_cfg,
      public.no_parcel_rule_days() AS np_days,
      (now() AT TIME ZONE 'Europe/Skopje')::date::text AS today`);
  const planBodyFile = functionBody(planFile, 'FUNCTION public.link_lead_parcels_plan(', '$plan$');
  const anprBodyFile = noParcelBody(exemptFile);
  const prevPlanMd5 = md5(functionBody(readMigration(ROOT, LINK_MIGRATION), 'FUNCTION public.link_lead_parcels_plan(', '$plan$'));
  const liveIsFile = !!st.plan_live && st.plan_md5 === md5(planBodyFile);
  const planMode = liveIsFile && !args.inline ? 'rpc' : 'inline';

  const anprLiveIsNew = st.anpr_md5 === md5(anprBodyFile);
  const anprBody = anprLiveIsNew && !args.inline ? noParcelBody(st.anpr_def) : anprBodyFile;

  // ── L: the plan ──
  const [pr] = await runSql(planMode === 'rpc' ? rpcPlanSql(args.days) : inlinePlanSql(planFile, args.days));
  const plan = planOf(pr);
  const links = plan.link;
  const parity = planHashParity(plan);
  const badLines = parity.lines.filter((l) => !PLAN_LINE_RE.test(l));
  add('L1', parity.ok && !badLines.length ? 'PASS' : 'FAIL', `hash ${String(plan.hash).slice(0, 12)}… ${parity.ok ? '=' : '≠'} kit ${parity.js.slice(0, 12)}…; ${badLines.length} malformed lines`);

  const l10 = [];
  let l10bad = 0;
  const trs = links.map((l) => lit(l.tracking_id)).join(', ') || "''";
  const pairs = links.map((l) => `(${lit(l.tracking_id)}, ${lit(l.order_id)}::uuid)`).join(', ');
  if (links.length) {
    const [r2] = await runSql(`SELECT count(*) FILTER (WHERE NOT (p.order_id IS NULL AND coalesce(p.cod_mkd, 0) > 0
          AND (p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))
          AND p.created_at_mex >= now() - make_interval(days => ${args.days}) AND p.phone8 ~ '^[0-9]{8}$'
          AND NOT (p.phone8 = ANY (public.report_excluded_phone8s()))
          AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p.tracking_id)))::int AS bad,
        count(*)::int AS n FROM public.mex_parcels p WHERE p.tracking_id IN (${trs})`);
    add('L2', r2.bad === 0 && r2.n === links.length ? 'PASS' : 'FAIL', `${r2.n}/${links.length} parcels found, ${r2.bad} break rule 1`);

    const [r3] = await runSql(`SELECT count(*) FILTER (WHERE NOT (
          right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = p.phone8
          AND o.created_at >= p.created_at_mex - interval '10 days' AND o.created_at <= p.created_at_mex + interval '1 day'
          AND o.mex_tracking_id IS NULL AND coalesce(o.price, 0) > 0 AND NOT public.is_synthetic_product_name(o.product_name)
          AND o.sale_source_detail IS DISTINCT FROM 'disposition'
          AND o.status::text IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed')))::int AS bad
        FROM (VALUES ${pairs}) v(tr, oid) JOIN public.mex_parcels p ON p.tracking_id = v.tr JOIN public.orders o ON o.id = v.oid`);
    add('L3', r3.bad === 0 ? 'PASS' : 'FAIL', `${r3.bad} linked orders break rule 2`);

    // rule 3, independently: candidates per linked parcel / orphan parcels per linked order
    const [r4] = await runSql(`WITH orphan AS (
        SELECT p.tracking_id, p.phone8, p.created_at_mex FROM public.mex_parcels p
         WHERE p.order_id IS NULL AND coalesce(p.cod_mkd, 0) > 0 AND p.phone8 ~ '^[0-9]{8}$'
           AND (p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))
           AND p.created_at_mex >= now() - make_interval(days => ${args.days})
           AND NOT (p.phone8 = ANY (public.report_excluded_phone8s()))
           AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p.tracking_id)),
      ok AS (SELECT o.id, right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) AS p8, o.created_at FROM public.orders o
              WHERE o.mex_tracking_id IS NULL AND coalesce(o.price, 0) > 0 AND NOT public.is_synthetic_product_name(o.product_name)
                AND o.sale_source_detail IS DISTINCT FROM 'disposition'
                AND o.status::text IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed')
                AND right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) IN (SELECT phone8 FROM orphan)),
      kept AS (SELECT p.tracking_id, o.id FROM orphan p JOIN ok o ON o.p8 = p.phone8
                 AND o.created_at BETWEEN p.created_at_mex - interval '10 days' AND p.created_at_mex + interval '1 day'
                JOIN public.orders oo ON oo.id = o.id
               WHERE (${excludedPairSql('oo', 'p.tracking_id')}) IS NULL),
      v AS (SELECT * FROM (VALUES ${pairs}) v(tr, oid))
      SELECT (SELECT count(*) FROM v WHERE (SELECT count(*) FROM kept k WHERE k.tracking_id = v.tr) <> 1)::int AS parcel_not_unique,
             (SELECT count(*) FROM v WHERE (SELECT count(*) FROM kept k WHERE k.id = v.oid) <> 1)::int AS order_not_unique,
             (SELECT count(DISTINCT tr) FROM v)::int AS parcels, (SELECT count(DISTINCT oid) FROM v)::int AS orders`);
    add('L4', !r4.parcel_not_unique && !r4.order_not_unique && r4.parcels === links.length && r4.orders === links.length ? 'PASS' : 'FAIL',
      `${r4.parcel_not_unique} parcels with ≠ 1 candidate, ${r4.order_not_unique} orders fitting ≠ 1 parcel (${r4.parcels} parcels / ${r4.orders} orders distinct)`);

    const kindBad = links.filter((l) => (l.kind === 'phone_date') !== (Number(l.hours) <= 72));
    const prodTrs = links.filter((l) => l.kind === 'phone_date_product').map((l) => lit(l.tracking_id));
    let noDoc = 0;
    if (prodTrs.length) {
      const [r5] = await runSql(`SELECT count(*)::int AS n FROM unnest(ARRAY[${prodTrs.join(', ')}]) t(tr)
         WHERE NOT EXISTS (SELECT 1 FROM public.collabbox_documents d, jsonb_array_elements(d.payload -> 'lines') e
                            WHERE d.doc_number = t.tr AND coalesce(e ->> 'role', 'goods') = 'goods')`);
      noDoc = r5.n;
    }
    add('L5', !kindBad.length && !noDoc ? 'PASS' : 'FAIL', `${kindBad.length} links whose kind disagrees with the 72 h line; ${noDoc} product-checked links without document lines (${prodTrs.length} product-checked)`);

    const want = (l) => {
      const s = Number(l.mex_status_id);
      if (s === 2) return l.status === 'paid' ? ['basis', null] : ['paid'];
      if (s === 7) return l.status === 'returned' ? [null] : ['returned'];
      if (s === 8) return [null];
      return l.status === 'shipped' ? [null] : ['shipped'];
    };
    const tBad = links.filter((l) => !want(l).includes(l.target ?? null));
    add('L6', tBad.length ? 'FAIL' : 'PASS', `${tBad.length} links whose target is not the MEX law`);

    const [r7] = await runSql(`SELECT (SELECT count(*) FROM public.agent_payout_items a WHERE a.order_id IN (SELECT oid FROM (VALUES ${pairs}) v(tr, oid)))::int AS payout,
        (SELECT count(*) FROM public.affiliate_leads a WHERE a.order_id IN (SELECT oid FROM (VALUES ${pairs}) v(tr, oid)))::int AS aff`);
    add('L7', r7.payout || r7.aff ? 'FAIL' : 'PASS', `${r7.payout} in agent_payout_items, ${r7.aff} affiliate leads`);

    const [r10] = await runSql(`SELECT count(*) FILTER (WHERE (${excludedPairSql('o', 'v.tr')}) IS NOT NULL)::int AS bad
        FROM (VALUES ${pairs}) v(tr, oid) JOIN public.orders o ON o.id = v.oid`);
    l10.push(r10.bad ? `${r10.bad} linked orders are dropped by rule 2b` : 'no linked order is a duplicate / a lead created after the booking');
    l10bad += r10.bad;
  } else {
    for (const id of ['L2', 'L3', 'L4', 'L5', 'L6', 'L7']) add(id, 'PASS', 'no links planned');
  }
  // rule 2b's dropped pairs, counted independently over every orphan parcel × candidate (the 0980 body counts them)
  const [rx] = await runSql(`WITH orphan AS (
      SELECT p.tracking_id, p.phone8, p.created_at_mex FROM public.mex_parcels p
       WHERE p.order_id IS NULL AND coalesce(p.cod_mkd, 0) > 0 AND p.phone8 ~ '^[0-9]{8}$'
         AND (p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))
         AND p.created_at_mex >= now() - make_interval(days => ${args.days})
         AND NOT (p.phone8 = ANY (public.report_excluded_phone8s()))
         AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p.tracking_id)),
    pairs AS (SELECT p.tracking_id, o.id, (${excludedPairSql('o', 'p.tracking_id')}) AS why
      FROM orphan p JOIN public.orders o ON right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = p.phone8
       AND o.created_at BETWEEN p.created_at_mex - interval '10 days' AND p.created_at_mex + interval '1 day'
     WHERE o.mex_tracking_id IS NULL AND coalesce(o.price, 0) > 0 AND NOT public.is_synthetic_product_name(o.product_name)
       AND o.sale_source_detail IS DISTINCT FROM 'disposition'
       AND o.status::text IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed'))
    SELECT count(*) FILTER (WHERE why = 'duplicate')::int AS duplicate, count(*) FILTER (WHERE why = 'after_booking')::int AS after_booking,
           count(*)::int AS pairs FROM pairs`);
  const ex = plan.counts?.excluded_by_reason;
  if (ex) {
    const same = n(ex.duplicate) === rx.duplicate && n(ex.after_booking) === rx.after_booking && n(plan.counts.pairs) === rx.pairs;
    if (!same) l10bad++;
    l10.push(`dropped pairs: independent ${rx.duplicate} duplicate + ${rx.after_booking} after_booking of ${rx.pairs} ${same ? '=' : '≠'} plan ${JSON.stringify(ex)} of ${plan.counts.pairs}`);
    add('L10', l10bad ? 'FAIL' : 'PASS', l10.join(' · '));
  } else {
    add('L10', 'WARN', `the plan that ran has no rule 2b (pre-0980 body) — it would drop ${rx.duplicate} duplicate + ${rx.after_booking} after_booking pairs`);
  }

  const fx = await runSql(foldFixtureSql(planBodyFile));
  const fxBad = fx.filter((r) => r.got !== r.want);
  add('L8', fxBad.length ? 'FAIL' : 'PASS', `${fx.length - fxBad.length}/${fx.length} name examples` +
    (fxBad.length ? ` — wrong: ${fxBad.map((r) => `${r.o} vs ${r.l}`).join('; ')}` : ''));

  if (!st.plan_live) add('L9', 'WARN', `migration ${LINK_MIGRATION} not applied — the FILE's plan body ran (inline)`);
  else if (st.plan_md5 === prevPlanMd5 && !liveIsFile) {
    add('L9', 'WARN', `the live plan body is still ${LINK_MIGRATION}'s (md5 ${prevPlanMd5}) — ${PLAN_MIGRATION} not applied; the FILE's plan body ran (inline)`);
  } else {
    const cfg = typeof st.setting === 'string' ? JSON.parse(st.setting) : st.setting;
    const okBody = st.plan_md5 === md5(planBodyFile);
    const okCron = st.cron === '2 * * * *';
    add('L9', okBody && okCron && cfg ? 'PASS' : 'FAIL', `live plan body ${okBody ? '=' : '≠'} file · cron ${st.cron ?? 'missing'} · switch ${cfg ? JSON.stringify(cfg) : 'missing'}`);
  }

  // ── N: the no-parcel exemptions ──
  const nfx = await runSql(postponeFixtureSql(anprBody));
  const nBad = nfx.filter((r) => r.got !== r.want);
  add('N1', nBad.length ? 'FAIL' : 'PASS', `${nfx.length - nBad.length}/${nfx.length} postponement examples` +
    (nBad.length ? ` — wrong: ${nBad.map((r) => `"${r.t}" (want ${r.want})`).join('; ')}` : ''));

  const cfg = typeof st.np_cfg === 'string' ? JSON.parse(st.np_cfg) : (st.np_cfg ?? {});
  const postponeDays = Math.max(/^\d{1,3}$/.test(String(cfg.postpone_days ?? '').trim()) ? Number(cfg.postpone_days) : 45, n(st.np_days));
  const scan = inlineNoParcelScanSql(anprBody, {
    days: n(st.np_days), sources: Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : ['altercpa', 'affiliate'],
    fromDate: cfg.from_date || '2026-08-01', today: st.today, postponeDays,
  });
  const npRows = await runSql(`SELECT n.display_id, n.plan_action, n.days_waiting, n.price, n.unlinked_tracking, n.collab_doc,
      left(n.postponed_note, 120) AS postponed_note FROM (${scan}) n ORDER BY n.plan_action, n.days_waiting DESC`);
  const by = (a) => npRows.filter((r) => r.plan_action === a).length;
  const counts = { candidates: npRows.length, needs_linking: by('needs_linking'), in_collab: by('in_collab'), postponed: by('postponed'), cancel: by('cancel') };
  const [tonight] = await runSql(`SELECT candidates, needs_linking, to_cancel, cancelled FROM public.no_parcel_rule_runs
     WHERE run_day = ${lit(st.today)}::date AND trigger_kind = 'cron' ORDER BY ran_at DESC LIMIT 1`);
  add('N2', 'INFO', `today ${st.today}: ${JSON.stringify(counts)} (postpone_days ${postponeDays}; body ${anprLiveIsNew && !args.inline ? 'LIVE' : 'FILE'})` +
    (tonight ? ` · tonight's run: candidates ${tonight.candidates}, needs_linking ${tonight.needs_linking}, cancelled ${tonight.cancelled}` : ' · the 21:10 run has not run today'));
  add('N3', anprLiveIsNew ? 'PASS' : 'WARN', anprLiveIsNew ? 'the live apply_no_parcel_rule = the file' : `migration ${EXEMPT_MIGRATION} not applied (live md5 ${st.anpr_md5})`);

  const fail = results.some((r) => r.status === 'FAIL');
  if (args.json) {
    console.log(JSON.stringify({ tool: 'verify-parcel-link-rules', read_only: true, plan_mode: planMode, counts: plan.counts, no_parcel: counts,
      results, status: fail ? 'FAIL' : 'PASS', exemptions: args.list ? npRows.filter((r) => ['in_collab', 'postponed'].includes(r.plan_action)) : undefined }, null, 1));
  } else {
    console.log(`\nverify-parcel-link-rules — plan ${planMode} · ${JSON.stringify({ link: plan.counts.link, manual: plan.counts.manual, link_cod_mkd: plan.counts.link_cod_mkd })}`);
    console.table(results);
    if (args.list) console.table(npRows.filter((r) => ['in_collab', 'postponed'].includes(r.plan_action)));
    console.log(fail ? 'FAIL' : 'PASS');
  }
  process.exitCode = fail ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(String(e?.stack || e)); process.exitCode = 2; });
}
