/**
 * verify-folder-orders — READ-ONLY proof of the owner's 01.10.2026 folder rules:
 *   Task A  scripts/repair-folder-decides.mjs — an AlterCPA order holding a NATURA teleshop / social parcel gives it to
 *           its collabBox document, which becomes its own Телешоп / Социјални order ("the collabBox folder decides")
 *   Task B  migration 20260944000970 + scripts/repair-leads-parcel-orders.mjs — a 9110 parcel MEX delivered / returned
 *           whose 10111 LEADS document no order holds becomes ONE order made from the document
 * Runs before the migration (the FILE's plan, "inline") and after it (the LIVE function), and says which.
 *
 *   node scripts/verify-folder-orders.mjs [--days 75] [--from 2026-09-01 --to 2026-09-30] [--inline] [--list]
 *
 *   B1  the plan's hash = the repair-kit's sha256 of its sorted lines; every line has the ledger shape
 *   B2  rule 1 + 2 re-checked by an INDEPENDENT query: every parcel to import is 9110, MEX 2 / 7, COD > 0, in the window,
 *       held and named by no order, a valid non-test phone; its document is 10111 / credit_pending / not storno,
 *       reversed or vanished, and no order is the document already
 *   B3  NO TWIN — no order is created where an order exists for the sale: the phone + date linker (called on its own)
 *       has no row for the parcel, no living Affiliate sale is on the phone (−30 d … +1 d), and no CRM sale without a
 *       parcel fits the document's price (the writer's own rule); every order on the phone −10 d … +1 d is listed (info)
 *   B4  every order to make = its document: the price (the writer's rule, recomputed in JS from the stored lines), the
 *       status (2 → paid · 7 → returned), the seller (the document's author)
 *   B5  department: the made order classifies as Affiliate – Lead in (collabbox_department('10111') →
 *       cohort_order_source) — the same department its parcel has as MEX-only (cohort_parcel_split → source)
 *   A1  every unit the folder repair moves: the AlterCPA order ends cancelled / trashed (never confirmed), it is in no
 *       payout, the collabBox writer would create the document's order, and the department it gets is a Телешоп /
 *       Социјални one (= the parcel series' department; a differing DocNumber series is listed — the TYPE decides)
 *   C0  the "before" is the Overview's own cohort: insights_cohort per department = insights_sale_rows per department
 *   C1  Σ cohort before / after per department for the window (insights_sale_rows): each moved parcel counted ONCE
 *       before and once after; Σ unchanged except sales whose sale day crosses the window's edge (listed)
 *   L1  applied runs: every order a leads-parcel-orders run made still holds its parcel, is the document's order in the
 *       ledger (outcome updated / exists) and classifies as Affiliate – Lead in; every folder-decides unit's holder is
 *       dead and parcel-less and its made order holds the parcel in its folder's department
 *   W1  after 20260944000970: the live plan body = the file; cron 'leads-parcel-orders' '6 * * * *'; the owner switch;
 *       the guard knows the key; the two writer helpers the plan spells out (collabbox_num / collabbox_mk_phone8) agree
 *
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = refused / unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { runSql } from './verify-insights-ties.mjs';
import { readMigration, functionBody } from './lib/link-lead-parcels.mjs';
import {
  MIGRATION, PLAN_SIG, DEFAULT_DAYS, PLAN_LINE_RE, inlinePlanSql, rpcPlanSql, planOf, planHashParity, writerPrice, targetFor,
} from './lib/leads-parcel-orders.mjs';
import { CANDIDATES_SQL, classifyFolderDecides, DEPT_WORD } from './lib/folder-decides.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md5 = (s) => createHash('md5').update(String(s).replace(/\r/g, '')).digest('hex');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const arr = (xs) => (xs.length ? `ARRAY[${xs.map(lit).join(',')}]::text[]` : 'ARRAY[]::text[]');
const n = (v) => Number(v ?? 0) || 0;
const fmt = (v) => Math.round(n(v)).toLocaleString('de-DE');
const TELESHOP = new Set(['teleshop_out', 'teleshop_other', 'social']);

/** Skopje calendar days → the inclusive [from, to_end] of insights_sale_rows. */
export function windowSql(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error(`bad window ${from} … ${to}`);
  return { from: `(${lit(from)}::date::timestamp AT TIME ZONE 'Europe/Skopje')`,
    to: `((${lit(to)}::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje' - interval '1 microsecond')` };
}

/**
 * The cohort per department before and after, from the live sale rows of the parcels that move: a moved row leaves
 * its department (if its sale day is in the window) and arrives in the new one (if the new sale day is in the window).
 * Pure: `rows` = insights_sale_rows of the moved parcels (kind, source, tracking_id, sale_day, in_total, value_mkd),
 * `moves` = { tracking, dept_after, day_after (YYYY-MM-DD Skopje), in_total_after } — `totals` = the window's Σ per source.
 */
export function cohortAfter({ totals, rows, moves, from, to }) {
  const inWin = (d) => !!d && d >= from && d <= to;
  const out = new Map(Object.entries(totals).map(([k, v]) => [k, { before: v.mkd, before_n: v.n, after: v.mkd, after_n: v.n }]));
  const get = (k) => out.get(k) ?? out.set(k, { before: 0, before_n: 0, after: 0, after_n: 0 }).get(k);
  const seen = new Map();
  const crossing = [];
  for (const r of rows) {
    seen.set(r.tracking_id, (seen.get(r.tracking_id) || 0) + 1);
    if (!r.in_total) continue;
    const g = get(r.source);
    g.after -= n(r.value_mkd);
    g.after_n -= 1;
  }
  for (const m of moves) {
    const was = rows.find((r) => r.tracking_id === m.tracking && r.in_total);
    if (inWin(m.day_after) && m.in_total_after !== false) {
      const g = get(m.dept_after);
      g.after += n(m.value_mkd ?? was?.value_mkd);
      g.after_n += 1;
    }
    if (!!was !== inWin(m.day_after)) crossing.push({ tracking: m.tracking, before: was ? `${was.source} ${was.sale_day}` : 'outside', after: `${m.dept_after} ${m.day_after}` });
  }
  const twice = [...seen].filter(([, c]) => c > 1).map(([t]) => t);
  const sumB = [...out.values()].reduce((s, v) => s + v.before, 0);
  const sumA = [...out.values()].reduce((s, v) => s + v.after, 0);
  return { table: [...out].map(([source, v]) => ({ department: DEPT_WORD[source] || source, before: v.before, after: v.after, delta: v.after - v.before, before_n: v.before_n, after_n: v.after_n })),
    sumB, sumA, crossing, twice };
}

const skopjeDay = (v) => (v ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date(v)) : null);

async function main() {
  const argv = process.argv.slice(2);
  const args = { days: DEFAULT_DAYS, inline: false, list: false, from: '2026-09-01', to: '2026-09-30' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--to') args.to = argv[++i];
    else if (argv[i] === '--inline') args.inline = true;
    else if (argv[i] === '--list') args.list = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  const results = [];
  const add = (id, status, detail) => results.push({ id, status, detail });
  const w = windowSql(args.from, args.to);

  // ── which body runs ──
  const file = readMigration(ROOT, MIGRATION);
  const fileBody = functionBody(file, 'FUNCTION public.leads_parcel_orders_plan(', '$plan$');
  const [st] = await runSql(`SELECT to_regprocedure(${lit(PLAN_SIG)}) IS NOT NULL AS live,
      (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(${lit(PLAN_SIG)})) AS live_md5,
      (SELECT schedule FROM cron.job WHERE jobname = 'leads-parcel-orders') AS cron,
      (SELECT value FROM public.app_settings WHERE key = 'leads_parcel_orders') AS setting,
      (SELECT position('leads_parcel_orders' IN p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()')) AS guarded,
      (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.collabbox_num(text)')) AS num_src,
      (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.collabbox_mk_phone8(text)')) AS p8_src`);
  const mode = st.live && !args.inline ? 'rpc' : 'inline';

  // ── W1 ──
  if (st.live) {
    const ok = st.live_md5 === md5(fileBody) && st.cron === '6 * * * *' && !!st.setting && st.guarded;
    add('W1', ok ? 'PASS' : 'FAIL', `live plan ${st.live_md5 === md5(fileBody) ? '= file' : `≠ file (${st.live_md5})`} · cron ${st.cron ?? 'missing'} · switch ${JSON.stringify(st.setting)} · guard ${st.guarded ? 'knows the key' : 'MISSING the key'}`);
  } else add('W1', 'INFO', `migration ${MIGRATION} not applied yet — the plan runs from the FILE (inline)`);
  const helpersOk = String(st.num_src).includes("'^-?[0-9]+(\\.[0-9]+)?$'") && String(st.p8_src).includes("'^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'");
  add('W1b', helpersOk ? 'PASS' : 'FAIL', `the writer helpers the plan spells out (collabbox_num / collabbox_mk_phone8) ${helpersOk ? 'still agree' : 'CHANGED — re-emit the plan'}`);

  // ── B: the plan ──
  const [pr] = await runSql(mode === 'rpc' ? rpcPlanSql(args.days) : inlinePlanSql(file, args.days));
  const plan = planOf(pr);
  const par = planHashParity(plan);
  const badLines = par.lines.filter((l) => !PLAN_LINE_RE.test(l));
  add('B1', par.ok && !badLines.length ? 'PASS' : 'FAIL', `hash ${String(plan.hash).slice(0, 12)}… ${par.ok ? '=' : '≠'} sha256 of ${par.lines.length} lines${badLines.length ? ` · ${badLines.length} malformed` : ''} (${mode})`);
  const create = plan.create ?? [];
  const trs = create.map((c) => c.tracking_id);

  if (trs.length) {
    // B2 — independent re-check of rules 1 + 2
    const b2 = await runSql(`SELECT p.tracking_id,
        (p.series = '9110' AND p.status_id IN (2, 7) AND coalesce(p.cod_mkd, 0) > 0 AND p.order_id IS NULL
         AND p.created_at_mex >= now() - make_interval(days => ${Number(args.days)})
         AND p.phone8 ~ '^[0-9]{8}$' AND NOT (p.phone8 = ANY (public.report_excluded_phone8s()))
         AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = p.tracking_id)) AS parcel_ok,
        (d.doc_type_id = '10111' AND d.role = 'credit' AND d.outcome = 'credit_pending' AND NOT d.is_storno AND d.reversed_by IS NULL
         AND d.vanished_at IS NULL AND d.payload IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.external_source = 'collabbox' AND o.external_order_id = d.doc_number)) AS doc_ok
      FROM public.mex_parcels p LEFT JOIN public.collabbox_documents d ON d.doc_number = p.tracking_id
     WHERE p.tracking_id = ANY (${arr(trs)})`);
    const bad2 = b2.filter((r) => !r.parcel_ok || !r.doc_ok);
    add('B2', bad2.length || b2.length !== trs.length ? 'FAIL' : 'PASS', `${b2.length}/${trs.length} parcels + documents re-checked independently${bad2.length ? ` · ${bad2.length} break rule 1/2: ${bad2.slice(0, 5).map((r) => r.tracking_id).join(', ')}` : ''}`);

    // B3 — no twin
    const [ll] = await runSql(`SELECT public.link_lead_parcels_plan(${Number(args.days)}::integer) AS plan`);
    const llp = planOf(ll);
    const llSet = new Set([...(llp?.link ?? []), ...(llp?.manual ?? [])].map((x) => x.tracking_id));
    const inLink = trs.filter((t) => llSet.has(t));
    const phones = create.map((c) => ({ t: c.tracking_id, p8a: c.phone8_parcel, p8b: String(c.customer_phone).slice(-8), at: c.created_at_mex, sale: c.sale_at, amount: c.amount_mkd, goods: c.goods_mkd }));
    const near = await runSql(`WITH x(t, p8a, p8b, at, sale_at, amount, goods) AS (VALUES ${phones.map((p) => `(${lit(p.t)}, ${lit(p.p8a)}, ${lit(p.p8b)}, ${lit(p.at)}::timestamptz, ${lit(p.sale)}::timestamptz, ${n(p.amount)}::numeric, ${n(p.goods)}::numeric)`).join(', ')})
      SELECT x.t, o.display_id, o.status::text AS status, o.sale_source, o.mex_tracking_id,
             public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept,
             o.created_at >= x.at - interval '10 days' AS within_10d,
             (o.mex_tracking_id IS NULL AND o.external_source IS DISTINCT FROM 'collabbox'
              AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
              AND o.created_at BETWEEN x.sale_at - interval '1 day' AND x.sale_at + interval '2 days'
              AND (abs(round(o.price * 61.5) - x.amount) <= 3 OR abs(round(o.price * 61.5) + 150 - x.amount) <= 3
                   OR abs(round(o.price * 61.5) - round(x.goods)) <= 3)) AS writer_twin
        FROM x JOIN public.orders o
          ON right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) IN (x.p8a, x.p8b)
         AND o.created_at BETWEEN x.at - interval '30 days' AND x.at + interval '1 day'
       WHERE coalesce(o.price, 0) > 0 AND NOT public.is_synthetic_product_name(o.product_name)
         AND o.sale_source_detail IS DISTINCT FROM 'disposition' AND o.status::text <> 'duplicated'`);
    const aliveAff = near.filter((r) => ['altercpa', 'elyon_crm'].includes(r.dept) && (!['cancelled', 'trashed'].includes(r.status) || r.mex_tracking_id));
    const twins = near.filter((r) => r.writer_twin);
    const bad3 = inLink.length + aliveAff.length + twins.length;
    add('B3', bad3 ? 'FAIL' : 'PASS', `no twin: link plan rows ${inLink.length} · living Affiliate sales on the phone (−30 d) ${aliveAff.length} · writer twins ${twins.length}` +
      ` · info: other orders on the phone −10 d … +1 d ${near.filter((r) => r.within_10d).length} (${[...new Set(near.filter((r) => r.within_10d).map((r) => `${r.dept}/${r.status}`))].join(', ') || 'none'})`);
    if (args.list) for (const r of [...aliveAff, ...twins]) console.log(`    B3 ${r.t} ← ${r.display_id} ${r.status} ${r.dept}`);

    // B4 — every order = its document
    const docs = await runSql(`SELECT d.doc_number, d.amount_mkd, d.author_person_id, d.payload -> 'lines' AS lines, p.cod_mkd, p.status_id
      FROM public.collabbox_documents d JOIN public.mex_parcels p ON p.tracking_id = d.doc_number WHERE d.doc_number = ANY (${arr(trs)})`);
    const byDoc = new Map(docs.map((d) => [d.doc_number, d]));
    const bad4 = [];
    for (const c of create) {
      const d = byDoc.get(c.tracking_id);
      const lines = Array.isArray(d?.lines) ? d.lines : (typeof d?.lines === 'string' ? JSON.parse(d.lines) : []);
      const num = (v) => (/^-?\d+(\.\d+)?$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : 0);
      const goods = lines.filter((l) => l?.role === 'goods').reduce((s, l) => s + num(l.value_mkd), 0);
      const wp = writerPrice({ goodsMkd: goods, amountMkd: d?.amount_mkd, nlines: lines.length, codMkd: d?.cod_mkd });
      const why = [];
      if (Math.abs(wp.price - n(c.price_eur)) > 0.005) why.push(`price ${c.price_eur} ≠ ${wp.price}`);
      if (targetFor(d?.status_id) !== c.target) why.push(`status ${c.target} ≠ MEX ${d?.status_id}`);
      if ((d?.author_person_id ?? null) !== (c.author_person_id ?? null)) why.push('seller ≠ the author');
      if (why.length) bad4.push(`${c.tracking_id}: ${why.join(', ')}`);
    }
    add('B4', bad4.length ? 'FAIL' : 'PASS', `${create.length} orders = their documents (price by the writer's rule, status by MEX, seller = author)${bad4.length ? ` · ${bad4.slice(0, 3).join(' | ')}` : ''}`);

    // B5 — department
    const [b5] = await runSql(`SELECT count(*) FILTER (WHERE public.cohort_order_source(d[1], d[2], t) IS DISTINCT FROM 'altercpa')::int AS order_not_in,
        count(*) FILTER (WHERE public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference)) IS DISTINCT FROM 'altercpa')::int AS parcel_not_in
      FROM unnest(${arr(trs)}) t
      CROSS JOIN LATERAL (SELECT public.collabbox_department('10111', t, NULL::uuid, now()) AS d) z
      JOIN public.mex_parcels p ON p.tracking_id = t`);
    add('B5', b5.order_not_in || b5.parcel_not_in ? 'FAIL' : 'PASS', `the made orders classify as Affiliate – Lead in (${trs.length - b5.order_not_in}/${trs.length}); their parcels were Affiliate – Lead in as MEX-only (${trs.length - b5.parcel_not_in}/${trs.length}) — no department moves`);
  } else add('B2', 'INFO', 'the plan makes no order today');

  // ── A: the folder repair, re-classified on the live rows ──
  const cands = await runSql(CANDIDATES_SQL);
  const ids = cands.map((c) => c.id);
  const history = ids.length ? await runSql(`SELECT order_id, from_status::text AS from_status, to_status::text AS to_status, changed_by, changed_by_name, changed_at
      FROM public.order_history WHERE order_id = ANY (ARRAY[${ids.map((x) => `${lit(x)}::uuid`).join(',')}]) ORDER BY changed_at, id`) : [];
  const fd = classifyFolderDecides({ cands, history });
  const series = await runSql(`SELECT p.tracking_id, public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference)) AS dept
      FROM public.mex_parcels p WHERE p.tracking_id = ANY (${arr(fd.units.map((u) => u.tracking))})`);
  const seriesDept = new Map(series.map((s) => [s.tracking_id, s.dept]));
  const badA = fd.units.filter((u) => !['cancelled', 'trashed'].includes(u.evidence.back_to) || !TELESHOP.has(u.evidence.dept_after));
  const seriesDiff = fd.units.filter((u) => seriesDept.get(u.tracking) !== u.evidence.dept_after);
  add('A1', badA.length ? 'FAIL' : 'PASS', `${fd.counts.move} units move (${fd.counts.manual + fd.counts.excluded_payout} listed): every holder ends cancelled / trashed, every parcel goes to a Телешоп / Социјални department` +
    `${badA.length ? ` · ${badA.length} break it` : ''}${seriesDiff.length ? ` · info: ${seriesDiff.length} documents whose TYPE department differs from the DocNumber series (the type decides)` : ''}`);

  // ── C1: Σ cohort before / after per department for the window ──
  const totalsRows = await runSql(`SELECT source, count(*) FILTER (WHERE in_total)::int AS n, coalesce(sum(value_mkd) FILTER (WHERE in_total), 0) AS mkd
      FROM public.insights_sale_rows(${w.from}, ${w.to}, false) GROUP BY 1`);
  const totals = Object.fromEntries(totalsRows.map((r) => [r.source, { n: n(r.n), mkd: n(r.mkd) }]));
  // C0: the "before" is the Overview's own cohort (insights_cohort, the one calculation) — it must tie to the rows
  const [co0] = await runSql(`SELECT public.insights_cohort(${w.from}, ${w.to}, NULL, NULL, NULL, true) AS c`);
  const cohort = typeof co0.c === 'string' ? JSON.parse(co0.c) : co0.c;
  const tieBad = (cohort.by_source ?? []).filter((s) => Math.abs(n(s.total?.value_mkd) - Math.round(n(totals[s.key]?.mkd))) > 1);
  add('C0', tieBad.length ? 'FAIL' : 'PASS', `insights_cohort ${args.from} … ${args.to}: Σ ${fmt(cohort.total?.value_mkd)} ден / ${n(cohort.total?.count)} sales` +
    ` ${tieBad.length ? `≠ insights_sale_rows for ${tieBad.map((s) => s.key).join(', ')}` : '= insights_sale_rows per department'}`);
  const movedT = [...fd.units.map((u) => u.tracking), ...trs];
  const rows = movedT.length ? await runSql(`SELECT kind, source, tracking_id, display_id, sale_day::text AS sale_day, in_total, value_mkd
      FROM public.insights_sale_rows(${w.from}, ${w.to}, false) WHERE tracking_id = ANY (${arr(movedT)})`) : [];
  const moves = [
    ...fd.moves.map((m) => ({ tracking: m.tracking, dept_after: m.dept_after, day_after: skopjeDay(m.day_after), value_mkd: m.cod })),
    ...create.map((c) => ({ tracking: c.tracking_id, dept_after: 'altercpa', day_after: skopjeDay(c.sale_at), value_mkd: c.cod_mkd })),
  ];
  const co = cohortAfter({ totals, rows, moves, from: args.from, to: args.to });
  const crossingNet = co.sumA - co.sumB;
  add('C1', co.twice.length ? 'FAIL' : 'PASS', `${args.from} … ${args.to}: Σ ${fmt(co.sumB)} → ${fmt(co.sumA)} ден (Δ ${fmt(crossingNet)} = ${co.crossing.length} sales whose sale day crosses the window's edge)` +
    `${co.twice.length ? ` · ${co.twice.length} parcels counted TWICE` : ' · every moved parcel counted once'}`);
  console.log(`\nCohort ${args.from} … ${args.to} per department (ден, in-total buckets) — before → after both repairs:`);
  console.table(co.table.map((r) => ({ department: r.department, before: fmt(r.before), after: fmt(r.after), 'Δ': fmt(r.delta), 'sales before': r.before_n, 'sales after': r.after_n })));
  if (args.list) for (const c of co.crossing) console.log(`    C1 crosses the edge: ${c.tracking} ${c.before} → ${c.after}`);

  // ── L1: applied runs ──
  const [l1] = await runSql(`SELECT
      (SELECT count(*) FROM public.data_repair_rows r JOIN public.data_repair_runs u ON u.id = r.run_id
        WHERE u.key = 'leads-parcel-orders' AND r.rule = 'LPO_create')::int AS lpo_made,
      (SELECT count(*) FROM public.data_repair_rows r JOIN public.orders o ON o.id = r.order_id
         LEFT JOIN public.mex_parcels p ON p.tracking_id = r.evidence ->> 'doc'
         LEFT JOIN public.collabbox_documents d ON d.doc_number = r.evidence ->> 'doc'
        WHERE r.rule = 'LPO_create'
          AND (p.order_id IS DISTINCT FROM o.id OR d.order_id IS DISTINCT FROM o.id OR d.outcome NOT IN ('updated', 'exists')
               OR public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) <> 'altercpa'))::int AS lpo_bad,
      (SELECT count(*) FROM public.data_repair_rows r WHERE r.rule = 'FD_revert' AND r.after IS NOT NULL AND r.evidence ? 'created_order')::int AS fd_units,
      (SELECT count(*) FROM public.data_repair_rows r JOIN public.orders o ON o.id = r.order_id
         LEFT JOIN public.orders m ON m.id = (r.evidence ->> 'created_order')::uuid
         LEFT JOIN public.mex_parcels p ON p.tracking_id = r.evidence ->> 'tracking'
        WHERE r.rule = 'FD_revert' AND r.after IS NOT NULL AND r.evidence ? 'created_order'
          AND (o.status::text NOT IN ('cancelled', 'trashed') OR o.mex_tracking_id IS NOT NULL OR m.id IS NULL OR p.order_id IS DISTINCT FROM m.id
               OR public.cohort_order_source(m.sale_source, m.sale_source_detail, m.mex_tracking_id, m.dept_override) IS DISTINCT FROM r.evidence ->> 'dept_after'))::int AS fd_bad,
      (SELECT count(*) FROM public.collabbox_documents d JOIN public.orders o ON o.external_source = 'collabbox' AND o.external_order_id = d.doc_number
        WHERE d.doc_type_id = '10111' AND d.outcome NOT IN ('exists', 'updated'))::int AS leads_doc_order_not_recorded`);
  add('L1', l1.lpo_bad || l1.fd_bad ? 'FAIL' : (l1.lpo_made || l1.fd_units ? 'PASS' : 'INFO'),
    `applied: ${l1.lpo_made} LEADS orders made (${l1.lpo_bad} off) · ${l1.fd_units} folder units (${l1.fd_bad} off) · 10111 documents that ARE an order but not recorded so: ${l1.leads_doc_order_not_recorded}`);

  // ── report ──
  console.log('');
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.id.padEnd(4)} ${r.detail}`);
  const fail = results.some((r) => r.status === 'FAIL');
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${results.length} checks (${mode}; plan ${plan.counts?.create ?? 0} to make, folder ${fd.counts.move} to move)\n`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message || String(e)); process.exit(2); });
}
