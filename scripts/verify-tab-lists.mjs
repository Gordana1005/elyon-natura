/**
 * verify-tab-lists — READ-ONLY proof that Insights → Prediction lists (migration
 * 20260941000400, GET /api/insights/lists) ties out.
 * No shebang: the test suite may import this file. Run with `node`.
 *
 *   node scripts/verify-tab-lists.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-tab-lists.mjs --from 2026-09-01 --to 2026-09-27 --json
 *
 *   --from/--to  Skopje calendar days, inclusive (default: the 7 days ending today). The
 *                window comes from the SAME helper the api uses (insightsCommon.ts
 *                insightsWindows).
 *   --json       one JSON document on stdout instead of the report
 *
 * Before the migration is applied the script runs the migration's own query body (the
 * text between EXECUTE $q$ … $q$, parameters bound exactly as the plpgsql wrapper binds
 * them) — so the numbers can be proven before and after the deploy.
 *
 * What it proves, for the window:
 *   L1  the tab's total = the Overview's Affiliate – Lead out (elyon_crm) · prediction_list split
 *       (insights_cohort),
 *       count and денари, and its parts = the cohort rows' parts (insights_sale_rows)
 *   L2  Σ lists + "list not recorded" = the total (sales, денари, cash, worked, paid, returned,
 *       units, stale); Σ parts = total; every list's parts = its sales; worked = sale + no + trash
 *   L3  the tab's Affiliate – Lead out footer = the Overview's card (count, денари, splits)
 *   L4  an independent recount from public.orders (no foundation function): per list,
 *       sales and денари on the cohort's sale day, parcel COD else price × 61,5 — a list sale
 *       shipped on a NATURA 9102 / 9100 / 9108 / 1300 parcel is another department's (owner
 *       28.09.2026, migration 20260942001000) and not the tab's
 *   L5  worked decisions per list = v_sales_work recounted
 *   L6  every per-list link and the stale link open EXACTLY the counted orders: the api's
 *       own /orders filter (insightsCommon.ts cohortOrdersFilter) + prediction_list, in SQL
 *   L7  cash flow = the MEX register: delivered parcels of list sales in the window
 *   L8  members now = prediction_segment_members (test phones out)
 *   H   the headline numbers
 *
 * Safety: every statement goes through verify-insights-ties.mjs runSql — pinned to the
 * Macedonian ref, refused unless config.toml agrees and .env does not point at Bulgaria,
 * a single SELECT/WITH checked by assertReadOnly(), sent with read_only: true.
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / unreachable.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drillPredicateParts, loadTwin, runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000400_insights_lists.sql');
const LISTS_SIG = 'public.insights_lists(timestamptz,timestamptz,timestamptz,timestamptz,boolean,integer)';
const CASH_SIG = 'public.insights_lists_cash(timestamptz,timestamptz,boolean)';
const STALE_DAYS = 7;
/** The NATURA series that take a CRM-made sale to another department (migration
 *  20260942001000: 9102 Телешоп – Lead out · 9100 Lead in · 9108 / 1300 Social), as LIKE patterns. */
const NATURA_LIKE = ['9102', '9100', '9108', '1300'].map((s) => `'___-${s}-%'`).join(', ');
const EXIT = { OK: 0, FAIL: 1, ERROR: 2 };

class UsageError extends Error {}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ts = (iso) => `${q(iso)}::timestamptz`;
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const tie = (label, want, got) => ({ label, want, got, ok: want === got });
const statusOf = (lines) => (lines.every((l) => l.ok) ? 'PASS' : 'FAIL');
const addDays = (ymd, k) => new Date(Date.parse(`${ymd}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const skopjeToday = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(now);

/** The migration's EXECUTE body with its parameters bound as the wrapper binds them. */
export function listsBodySql(w, now = new Date()) {
  const mig = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const body = mig.split('EXECUTE $q$')[1]?.split('  $q$\n  INTO')[0];
  if (!body) throw new Error('cannot find the EXECUTE $q$ body in migration 20260941000400');
  const sfd = daysBetween(w.from, w.to) + 1 >= 14 ? w.from : addDays(w.to, -13);
  const gran = daysBetween(sfd, w.to) + 1 <= 62 ? 'day' : 'month';
  const sfdIso = w.sfdIso;   // Skopje midnight of the trend's first day
  const lo = [w.fromIso, sfdIso].sort()[0];
  const P = {
    1: ts(w.fromIso), 2: ts(w.toEndIso), 3: 'NULL::timestamptz', 4: 'NULL::timestamptz', 5: ts(lo),
    6: '(SELECT public.report_excluded_phone8s())', 7: `${q(w.from)}::date`, 8: `${q(w.to)}::date`,
    9: `${q(sfd)}::date`, 10: `${q(gran)}::text`, 11: `${q(skopjeToday(now))}::date`, 12: String(STALE_DAYS),
  };
  return body.replace(/\$(\d+)/g, (_, k) => P[k] ?? `$${k}`).trim();
}

const CASH_BODY = (w) => `
SELECT jsonb_build_object(
  'parcels', count(c.tracking_id),
  'cod_mkd', round(coalesce(sum(c.cod_mkd), 0)),
  'from_this_period_mkd', round(coalesce(sum(c.cod_mkd) FILTER (WHERE c.sale_at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}), 0)),
  'from_earlier_mkd', round(coalesce(sum(c.cod_mkd) FILTER (WHERE c.sale_at IS NULL OR NOT (c.sale_at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)})), 0)),
  'from_earlier', count(c.tracking_id) FILTER (WHERE c.sale_at IS NULL OR NOT (c.sale_at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}))) AS j
FROM public.insights_cash_rows(${ts(w.fromIso)}, ${ts(w.toEndIso)}) c
WHERE c.split = 'prediction_list'`;   // list sales of every department (20260942001800)

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export async function verify({ from, to, sql, now = new Date(), IC: twin = null }) {
  const IC = twin ?? await loadTwin();
  const toDay = to ?? IC.insightsWindows(null, null, false, now).to;
  const fromDay = from ?? addDays(toDay, -6);
  const w = IC.insightsWindows(fromDay, toDay, false, now);
  if ('error' in w) throw new UsageError(w.error);
  const sfd = daysBetween(w.from, w.to) + 1 >= 14 ? w.from : addDays(w.to, -13);
  const [sfdRow] = await sql(`SELECT (${q(sfd)}::date::timestamp AT TIME ZONE 'Europe/Skopje') AS t`);
  w.sfdIso = new Date(sfdRow.t).toISOString();

  const [probe] = await sql(`SELECT to_regprocedure(${q(LISTS_SIG)}) IS NOT NULL AS lists,
    coalesce(has_function_privilege(to_regprocedure(${q(LISTS_SIG)}), 'execute'), false) AS can_lists,
    to_regprocedure(${q(CASH_SIG)}) IS NOT NULL AS cash,
    coalesce(has_function_privilege(to_regprocedure(${q(CASH_SIG)}), 'execute'), false) AS can_cash`);
  const viaRpc = probe.lists && probe.can_lists;
  const [lr] = viaRpc
    ? await sql(`SELECT public.insights_lists(${ts(w.fromIso)}, ${ts(w.toEndIso)}, NULL, NULL, true, ${STALE_DAYS}) AS j`)
    : await sql(`WITH zz AS (${listsBodySql(w, now)}) SELECT zz.jsonb_build_object AS j FROM zz`);
  const L = parse(lr.j);
  const [cr] = probe.cash && probe.can_cash
    ? await sql(`SELECT public.insights_lists_cash(${ts(w.fromIso)}, ${ts(w.toEndIso)}, true) AS j`)
    : await sql(CASH_BODY(w));
  const cash = parse(cr.j);
  const [cc] = await sql(`SELECT public.insights_cohort(${ts(w.fromIso)}, ${ts(w.toEndIso)}, NULL, NULL, ARRAY['altercpa','elyon_crm','teleshop_out','teleshop_other','social','web'], true) AS j`);
  const C = parse(cc.j);
  const [exRow] = await sql(`SELECT public.insights_cohort_order_exceptions(${ts(w.fromIso)}, ${ts(w.toEndIso)}) AS ex`);
  const ex = IC.parseCohortExceptions(parse(exRow.ex));
  if (!ex) throw new Error('insights_cohort_order_exceptions() returned an unusable payload');

  const results = [];
  const src = (C.by_source ?? []).find((s) => s.key === 'elyon_crm') ?? { total: {}, splits: [] };
  // since 20260942001800 a list sale counts in its agent's department: the tab = the prediction_list
  // split summed over every department
  const listSplits = (C.by_source ?? []).map((x) => (x.splits ?? []).find((s) => s.key === 'prediction_list') ?? {});
  const split = { count: listSplits.reduce((a, x) => a + n(x.count), 0), value_mkd: listSplits.reduce((a, x) => a + n(x.value_mkd), 0) };
  const sum = (list, k) => (list ?? []).reduce((a, x) => a + n(x?.[k]), 0);

  // L1 — the Overview's split, and the parts from the cohort rows themselves
  {
    const [p] = await sql(`
SELECT coalesce(jsonb_object_agg(x.bucket, jsonb_build_object('n', x.n, 'v', x.v)), '{}'::jsonb) AS parts
FROM (SELECT r.bucket, count(*)::int AS n, round(coalesce(sum(r.value_mkd), 0))::bigint AS v
        FROM public.insights_sale_rows(${ts(w.fromIso)}, ${ts(w.toEndIso)}, false) r
       WHERE r.split = 'prediction_list'
       GROUP BY r.bucket) x`);
    const parts = parse(p.parts) ?? {};
    const lines = [
      tie('sales = Overview Affiliate – Lead out · prediction_list', n(split.count), n(L.total.count)),
      tie('денари = Overview Affiliate – Lead out · prediction_list', n(split.value_mkd), n(L.total.value_mkd)),
    ];
    for (const b of [...(L.buckets ?? []), ...(L.outside ?? [])]) {
      lines.push(tie(`part ${b.key}: count = cohort rows`, n(parts[b.key]?.n), n(b.count)));
      lines.push(tie(`part ${b.key}: денари = cohort rows`, n(parts[b.key]?.v), n(b.value_mkd)));
    }
    results.push({ id: 'L1', title: 'the tab = the Overview\'s Affiliate – Lead out · prediction_list split', status: statusOf(lines), lines });
  }

  // L2 — the payload adds up
  {
    const nr = L.not_recorded ?? {};
    const lines = [];
    for (const k of ['count', 'value_mkd', 'cash_mkd', 'worked']) {
      lines.push(tie(`Σ lists + not recorded = total · ${k}`, n(L.total[k]), sum(L.lists, k) + n(nr[k])));
    }
    for (const k of ['paid', 'returned', 'units', 'stale_to_pack']) {
      lines.push(tie(`Σ lists + not recorded = total · ${k}`, n(L.total[k]), sum(L.lists, k) + n(nr[k])));
    }
    lines.push(tie('Σ parts = total (count)', n(L.total.count), sum(L.buckets, 'count')));
    lines.push(tie('Σ parts = total (денари)', n(L.total.value_mkd), sum(L.buckets, 'value_mkd')));
    const badLists = (L.lists ?? []).filter((l) => sum(l.buckets, 'count') !== n(l.count)
      || n(l.worked_sale) + n(l.worked_no) + n(l.worked_trash) !== n(l.worked));
    lines.push(tie('every list: Σ its parts = its sales, sale + no + trash = worked', 0, badLists.length));
    results.push({ id: 'L2', title: 'Σ lists + not recorded = total; parts add up', status: statusOf(lines), lines });
  }

  // L3 — the Affiliate – Lead out footer = the Overview's card
  {
    const lines = [
      tie('Affiliate – Lead out sales = Overview card', n(src.total?.count), n(L.elyon_crm?.count)),
      tie('Affiliate – Lead out денари = Overview card', n(src.total?.value_mkd), n(L.elyon_crm?.value_mkd)),
    ];
    for (const s of src.splits ?? []) {
      const mine = (L.elyon_crm?.splits ?? []).find((x) => x.key === s.key);
      lines.push(tie(`split ${s.key}: sales`, n(s.count), n(mine?.count)));
    }
    results.push({ id: 'L3', title: 'Affiliate – Lead out footer = the Overview\'s card', status: statusOf(lines), lines });
  }

  // L4 — independent recount from public.orders
  {
    const rows = await sql(`
WITH wc AS (SELECT DISTINCT wo.mex_tracking_id AS tr FROM public.web_orders wo
             WHERE wo.mex_tracking_id IS NOT NULL AND wo.deleted_in_shop_at IS NULL),
o AS (
  SELECT x.prediction_list_id AS lid, x.status::text AS st, x.price, x.sold_at,
         (x.mex_tracking_id IS NOT NULL AND (x.mex_status_id IS NOT NULL OR x.mex_delivered_at IS NOT NULL)
          AND x.mex_tracking_id NOT IN (SELECT tr FROM wc)) AS hp,
         x.mex_status_id AS ms, x.mex_cod_mkd AS cod, x.mex_delivered_at AS md
  FROM public.orders x
  WHERE x.sale_source = 'elyon_crm' AND x.sale_source_detail = 'prediction_list'
    -- the owner's department rule, restated: a list sale on a NATURA teleshop / social parcel is not the tab's
    AND NOT coalesce(x.mex_tracking_id LIKE ANY (ARRAY[${NATURA_LIKE}]), false)
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at) BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}
    AND NOT coalesce(right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ((SELECT public.report_excluded_phone8s())::text[]), false)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT p.tracking_id FROM public.mex_parcels p
                                             WHERE p.phone8 = ANY ((SELECT public.report_excluded_phone8s())::text[])), false)
),
s AS (   -- a sale: a parcel with something to collect, or a sold CRM status with a price
  SELECT o.*, CASE WHEN o.hp THEN coalesce(o.cod, 0) > 0 OR (o.cod IS NULL AND coalesce(o.price, 0) > 0)
                   ELSE o.st IN ('confirmed', 'shipped', 'paid', 'delivered', 'returned') AND coalesce(o.price, 0) > 0 END AS sale
  FROM o
)
SELECT coalesce(s.lid::text, '-') AS lid, count(*)::int AS n,
       round(sum(CASE WHEN s.hp AND s.cod IS NOT NULL THEN s.cod ELSE round(coalesce(s.price, 0) * 61.5) END))::bigint AS v
FROM s WHERE s.sale GROUP BY 1`);
    const byId = new Map(rows.map((r) => [r.lid, r]));
    const lines = [];
    let bad = 0;
    for (const l of L.lists ?? []) {
      const r = byId.get(l.id);
      if (n(r?.n) !== n(l.count) || n(r?.v) !== n(l.value_mkd)) {
        bad++;
        lines.push(tie(`${l.name}: sales / денари`, `${n(r?.n)} / ${n(r?.v)}`, `${n(l.count)} / ${n(l.value_mkd)}`));
      }
    }
    const nr = byId.get('-');
    lines.push(tie('list not recorded: sales', n(nr?.n), n(L.not_recorded?.count)));
    lines.push(tie('lists that differ from the raw recount', 0, bad));
    // shared parcels split their COD (foundation rule) — a raw recount can differ by that only
    const [sh] = await sql(`SELECT count(*)::int AS n FROM (SELECT x.mex_tracking_id FROM public.orders x
      WHERE x.mex_tracking_id IS NOT NULL AND x.sale_source_detail IS DISTINCT FROM 'disposition'
      GROUP BY 1 HAVING count(*) > 1) z`);
    results.push({ id: 'L4', title: 'independent recount from public.orders, per list', status: statusOf(lines), lines,
      note: `${sh.n} tracking ids are held by two orders (COD split by the foundation) — a difference on such a list is that split, not an error` });
  }

  // L5 — worked decisions per list
  {
    const rows = await sql(`
SELECT coalesce(o.prediction_list_id::text, '-') AS lid, count(*)::int AS n
FROM public.v_sales_work v JOIN public.orders o ON o.id = v.order_id
WHERE v.via = 'crm' AND v.at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}
  AND o.sale_source = 'elyon_crm' AND o.sale_source_detail IN ('prediction_list', 'disposition')
  AND (v.outcome IN ('cancel', 'trash') OR (v.outcome = 'sale' AND o.sale_source_detail = 'prediction_list'))
  AND NOT coalesce(right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ((SELECT public.report_excluded_phone8s())::text[]), false)
GROUP BY 1`);
    const byId = new Map(rows.map((r) => [r.lid, n(r.n)]));
    const bad = (L.lists ?? []).filter((l) => (byId.get(l.id) ?? 0) !== n(l.worked));
    const lines = [
      tie('worked total = v_sales_work', rows.reduce((a, r) => a + n(r.n), 0), n(L.total.worked)),
      tie('lists whose worked ≠ v_sales_work', 0, bad.length),
    ];
    results.push({ id: 'L5', title: 'worked decisions per list = v_sales_work', status: statusOf(lines), lines });
  }

  // L6 — the links open exactly the counted orders
  {
    const window = { fromIso: w.fromIso, toEndIso: w.toEndIso };
    const probes = [];
    // the tab's links carry sale_source + detail, no cohort_source (listModel.ts listsHref, 20260942001800)
    const base = (keys) => drillPredicateParts(IC, { keys, cohortSources: [], saleSources: ['elyon_crm'], detail: 'prediction_list', window, ex });
    const total = IC.parseCohortBucketParam('total').values;
    probes.push({ label: 'slice total', want: n(L.total.count), parts: base(total) });
    for (const b of L.buckets ?? []) {
      if (!n(b.count)) continue;
      probes.push({ label: `slice ${b.key}`, want: n(b.count), parts: base(IC.parseCohortBucketParam(b.key).values) });
    }
    for (const l of L.lists ?? []) {
      if (!n(l.count)) continue;
      if (!l.drill_name) { probes.push({ label: `${l.name}: no exact link (names differ)`, want: 'no link', got: 'no link' }); continue; }
      probes.push({ label: `${l.name}`, want: n(l.count), parts: [...base(total), `o.prediction_list_name = ${q(l.drill_name)}`] });
    }
    // the stale card: to pack, sold on or before today − stale − 1
    const last = addDays(skopjeToday(now), -(STALE_DAYS + 1));
    if (n(L.total.stale_to_pack) > 0 && last >= w.from) {
      const soldTo = last < w.to ? last : w.to;
      const [endRow] = await sql(`SELECT ((${q(soldTo)}::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond' AS t`);
      const sw = { fromIso: w.fromIso, toEndIso: new Date(endRow.t).toISOString() };
      probes.push({ label: `stale to pack (sold ≤ ${soldTo})`, want: n(L.total.stale_to_pack),
        parts: drillPredicateParts(IC, { keys: ['to_pack'], cohortSources: [], saleSources: ['elyon_crm'], detail: 'prediction_list', window: sw, ex }) });
    }
    const live = probes.filter((p) => p.parts);
    const cols = live.map((p, i) => `count(*) FILTER (WHERE ${p.parts.join(' AND ')})::int AS p${i}`);
    const [r] = live.length ? await sql(`SELECT ${cols.join(',\n  ')} FROM public.orders o`) : [{}];
    const lines = probes.map((p) => (p.parts ? tie(`${p.label}: /orders lists = the count`, p.want, n(r[`p${live.indexOf(p)}`])) : tie(p.label, p.want, p.got)));
    results.push({ id: 'L6', title: 'every link opens exactly the counted orders', status: statusOf(lines), lines });
  }

  // L7 — cash flow = the MEX register (delivered parcels of list sales)
  {
    const [r] = await sql(`
SELECT count(DISTINCT p.tracking_id)::int AS n, coalesce(sum(p.cod_mkd), 0)::bigint AS cod
FROM public.mex_parcels p
WHERE p.delivered_at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}
  AND NOT coalesce(p.phone8 = ANY ((SELECT public.report_excluded_phone8s())::text[]), false)
  AND NOT EXISTS (SELECT 1 FROM public.web_orders wo WHERE wo.mex_tracking_id = p.tracking_id AND wo.deleted_in_shop_at IS NULL)
  AND (SELECT x.sale_source_detail FROM public.orders x
        WHERE x.mex_tracking_id = p.tracking_id AND x.sale_source_detail IS DISTINCT FROM 'disposition'
        ORDER BY x.created_at, x.id LIMIT 1) = 'prediction_list'
  AND (SELECT x.sale_source FROM public.orders x
        WHERE x.mex_tracking_id = p.tracking_id AND x.sale_source_detail IS DISTINCT FROM 'disposition'
        ORDER BY x.created_at, x.id LIMIT 1) = 'elyon_crm'
  AND NOT (p.tracking_id LIKE ANY (ARRAY[${NATURA_LIKE}]))`);
    const lines = [
      tie('parcels = MEX register', n(r.n), n(cash.parcels)),
      tie('COD = MEX register', n(r.cod), n(cash.cod_mkd)),
      tie('this period + earlier = COD', n(cash.cod_mkd), n(cash.from_this_period_mkd) + n(cash.from_earlier_mkd)),
    ];
    results.push({ id: 'L7', title: 'cash flow = the MEX register', status: statusOf(lines), lines });
  }

  // L8 — members now
  {
    const [r] = await sql(`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT coalesce(m.is_completed, false))::int AS a
      FROM public.prediction_segment_members m
      WHERE NOT coalesce(right(regexp_replace(m.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ((SELECT public.report_excluded_phone8s())::text[]), false)`);
    const lines = [
      tie('members = prediction_segment_members', n(r.n), sum(L.lists, 'members')),
      tie('members to call = not completed', n(r.a), sum(L.lists, 'members_active')),
    ];
    results.push({ id: 'L8', title: 'members now = prediction_segment_members', status: statusOf(lines), lines });
  }

  const conv = n(L.total.worked) > 0 ? n(L.total.count) / n(L.total.worked) : null;
  const headline = {
    window: `${w.from} .. ${w.to}`, via: viaRpc ? 'insights_lists()' : 'migration body (not deployed yet)',
    sales: n(L.total.count), value_mkd: n(L.total.value_mkd), cash_mkd: n(L.total.cash_mkd),
    paid: n(L.total.paid), returned: n(L.total.returned), worked: n(L.total.worked),
    conversion: conv, stale_to_pack: n(L.total.stale_to_pack), not_recorded: n(L.not_recorded?.count),
    elyon_crm: `${n(L.elyon_crm?.count)} / ${n(L.elyon_crm?.value_mkd)}`,
    cash_flow: `${n(cash.parcels)} parcels / ${n(cash.cod_mkd)}`,
    buckets: Object.fromEntries((L.buckets ?? []).map((b) => [b.key, `${n(b.count)} / ${n(b.value_mkd)}`])),
    top: [...(L.lists ?? [])].sort((a, b) => n(b.value_mkd) - n(a.value_mkd)).slice(0, 5)
      .map((l) => `${l.name}: ${n(l.count)} / ${n(l.value_mkd)} (worked ${n(l.worked)})`),
  };
  return { w, results, headline, payload: L };
}

function printText({ headline: h, results }, exitCode) {
  const out = [`verify-tab-lists — ${h.window} (Skopje) via ${h.via}`, ''];
  out.push(`  sales ${h.sales} · ${h.value_mkd} ден · MEX cash ${h.cash_mkd} ден · paid ${h.paid} · returned ${h.returned}`);
  out.push(`  worked ${h.worked} · conversion ${h.conversion == null ? '—' : (h.conversion * 100).toFixed(1) + '%'} · stale to pack ${h.stale_to_pack} · list not recorded ${h.not_recorded}`);
  out.push(`  Affiliate – Lead out ${h.elyon_crm} ден · cash flow ${h.cash_flow} ден`);
  out.push(`  parts ${JSON.stringify(h.buckets)}`);
  for (const t of h.top) out.push(`  top: ${t}`);
  out.push('');
  for (const r of results) {
    out.push(`${r.status.padEnd(4)} ${r.id}  ${r.title}`);
    for (const l of r.lines) if (!l.ok || r.lines.length <= 6) out.push(`       ${l.ok ? 'ok ' : 'BAD'} ${l.label}: want ${l.want} · got ${l.got}`);
    if (r.note) out.push(`       note: ${r.note}`);
  }
  out.push('', `exit ${exitCode}`);
  console.log(out.join('\n'));
}

const USAGE = `usage: node scripts/verify-tab-lists.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
Read-only. Dates are Skopje calendar days (inclusive; default the 7 days ending today).`;

export function parseArgs(argv) {
  const opts = { json: false, from: null, to: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === '--json' && val === undefined) opts.json = true;
    else if ((arg === '--help' || arg === '-h') && val === undefined) opts.help = true;
    else if (arg === '--from' || arg === '--to') {
      if (val === undefined) val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = val;
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  for (const k of ['from', 'to']) {
    if (opts[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new UsageError(`--${k} must be YYYY-MM-DD`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return EXIT.OK; }
  const res = await verify({ from: opts.from, to: opts.to, sql: runSql });
  const exitCode = res.results.some((r) => r.status === 'FAIL') ? EXIT.FAIL : EXIT.OK;
  if (opts.json) {
    const { payload: _p, ...rest } = res;
    console.log(JSON.stringify({ tool: 'verify-tab-lists', read_only: true, exit_code: exitCode, ...rest }, null, 2));
  } else printText(res, exitCode);
  return exitCode;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* keep as given */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
}

if (invokedAsCli()) {
  const argv = process.argv.slice(2);
  main(argv).then((code) => { process.exitCode = code; }, (e) => {
    const kind = e instanceof UsageError ? 'usage' : e?.constructor?.name === 'Refusal' ? 'REFUSED' : 'error';
    console.error(`verify-tab-lists ${kind}: ${e?.message ?? e}${e instanceof UsageError ? `\n${USAGE}` : ''}`);
    process.exitCode = EXIT.ERROR;
  });
}
