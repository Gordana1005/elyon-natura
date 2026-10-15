/**
 * verify-customer-origin — READ-ONLY proof of "where the buyers come from" (owner 15.10.2026;
 * migrations 20261015120000_customer_origin / 20261015120100_insights_cohort_origins).
 *
 *   node scripts/verify-customer-origin.mjs           (text report)
 *   node scripts/verify-customer-origin.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   O1  health: the first full fill ran (< 26 h ago), the 15-minute pass is alive (< 30 min), every
 *       row an 8-digit phone with at least one side, no test phone; the sources behind each side
 *   O2  the table = a fresh recompute (customer_origin_rows) for the phones of last month's
 *       Тим Центар Out / Тим Маџари Out sales — a difference is the 15-minute lag (WARN), > 1 % FAIL
 *   O3  Σ origins = Σ accounts = the department total (count; денари within rounding) for every
 *       department over yesterday · 7 days · last month · this month, owner payload and counted one
 *   O4  last month's Тим Центар Out origins = a sale-by-sale recount over insights_sale_rows +
 *       customer_origin (the same rows, the same rule) — exactly; the figures are printed
 *   O5  the counted payload (p_money = false) carries no *_mkd anywhere, and keeps the counts
 *   O6  information: sales whose only earlier trace is 1–48 h before the sale (possible twins of
 *       the sale's own document) and sales with no phone, per department
 *   T   timings
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia, refused
 * if .env points at Bulgaria, every statement one SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    fail(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}

// Skopje windows as timestamptz literals (the api's own window rule: a day = 00:00 … 23:59:59.999999)
const W = {
  yesterday: `(date_trunc('day', now() AT TIME ZONE 'Europe/Skopje') - interval '1 day') AT TIME ZONE 'Europe/Skopje'`,
  today0: `date_trunc('day', now() AT TIME ZONE 'Europe/Skopje') AT TIME ZONE 'Europe/Skopje'`,
  month0: `date_trunc('month', now() AT TIME ZONE 'Europe/Skopje') AT TIME ZONE 'Europe/Skopje'`,
  prevMonth0: `(date_trunc('month', now() AT TIME ZONE 'Europe/Skopje') - interval '1 month') AT TIME ZONE 'Europe/Skopje'`,
};
const END = (x) => `(${x}) - interval '1 microsecond'`;
const WINDOWS = [
  ['yesterday', W.yesterday, END(W.today0)],
  ['last 7 days', `(${W.today0}) - interval '7 days'`, END(W.today0)],
  ['last month', W.prevMonth0, END(W.month0)],
  ['this month', W.month0, 'now()'],
];

// ── O1 ────────────────────────────────────────────────────────────────────────
async function verifyHealth() {
  const c = check('O1', 'health: filled, fresh, clean rows');
  const [s] = await timed('health', `
    SELECT st.last_full_at, st.watermark, st.last_mode, st.last_ms,
           extract(epoch FROM now() - st.last_full_at) / 3600 AS full_age_h,
           extract(epoch FROM now() - st.watermark) / 60 AS mark_age_min,
           (SELECT count(*) FROM public.customer_origin) AS rows,
           (SELECT count(*) FROM public.customer_origin WHERE phone8 !~ '^[0-9]{8}$') AS bad_phone,
           (SELECT count(*) FROM public.customer_origin WHERE phone8 = ANY (public.report_excluded_phone8s())) AS test_phone,
           (SELECT count(*) FROM public.customer_origin WHERE affiliate_at IS NULL AND natura_at IS NULL AND web_at IS NULL) AS empty,
           (SELECT jsonb_object_agg(k, v) FROM (
              SELECT 'affiliate:' || coalesce(affiliate_src, '-') AS k, count(*) AS v FROM public.customer_origin WHERE affiliate_at IS NOT NULL GROUP BY 1
              UNION ALL SELECT 'natura:' || coalesce(natura_src, '-'), count(*) FROM public.customer_origin WHERE natura_at IS NOT NULL GROUP BY 1
              UNION ALL SELECT 'web:' || coalesce(web_src, '-'), count(*) FROM public.customer_origin WHERE web_at IS NOT NULL GROUP BY 1) x) AS sources
    FROM public.customer_origin_state st WHERE st.id`);
  if (!s?.last_full_at) { c.fail('first full fill', 'never ran — select public.customer_origin_refresh(true)'); return; }
  if (n(s.full_age_h) > 26) c.warn('last full rebuild', `${Math.round(n(s.full_age_h))} h ago (the 05:15 job)`);
  if (n(s.mark_age_min) > 30) c.warn('last 15-minute pass', `${Math.round(n(s.mark_age_min))} min ago`);
  c.tie('rows with a bad phone', 0, n(s.bad_phone));
  c.tie('rows on a test phone', 0, n(s.test_phone));
  c.tie('rows with no side', 0, n(s.empty));
  c.info('rows', n(s.rows));
  c.info('last run', `${s.last_mode} · ${n(s.last_ms)} ms`);
  c.info('earliest trace by source', parse(s.sources));
}

// ── O2 ────────────────────────────────────────────────────────────────────────
async function verifyRecompute() {
  const c = check('O2', 'the table = a fresh recompute (last month\'s Out sales)');
  const [r] = await timed('recompute', `
    WITH r AS MATERIALIZED (
      SELECT DISTINCT s.phone8 FROM public.insights_sale_rows(${W.prevMonth0}, ${END(W.month0)}, false) s
      WHERE s.source IN ('teleshop_out', 'elyon_crm') AND s.in_total AND s.phone8 IS NOT NULL
    ),
    fresh AS MATERIALIZED (SELECT * FROM public.customer_origin_rows((SELECT array_agg(phone8) FROM r)))
    SELECT (SELECT count(*) FROM r) AS phones,
           count(*) FILTER (WHERE (co.affiliate_at, co.natura_at, co.web_at) IS DISTINCT FROM (f.affiliate_at, f.natura_at, f.web_at)) AS diff
    FROM r
    LEFT JOIN public.customer_origin co ON co.phone8 = r.phone8
    LEFT JOIN fresh f ON f.phone8 = r.phone8`);
  const phones = n(r?.phones);
  const diff = n(r?.diff);
  c.info('phones compared', phones);
  if (diff > 0 && phones > 0 && diff / phones > 0.01) c.fail('phones that differ', `${diff} of ${phones} (> 1 %)`);
  else if (diff > 0) c.warn('phones that differ', `${diff} of ${phones} — the 15-minute lag`);
}

// ── O3 / O5 ───────────────────────────────────────────────────────────────────
async function verifySums() {
  const c = check('O3', 'Σ origins = Σ accounts = the department total, every window, owner and counted');
  const c5 = check('O5', 'the counted payload carries no денари, keeps the counts');
  for (const [label, from, to] of WINDOWS) {
    for (const money of [true, false]) {
      const [row] = await timed(`cohort ${label}${money ? '' : ' (counted)'}`,
        `SELECT public.insights_cohort(${from}, ${to}, NULL, NULL, NULL, ${money}) AS j`);
      const j = parse(row.j);
      for (const s of j.by_source ?? []) {
        for (const list of ['origins', 'accounts']) {
          const parts = s[list];
          if (parts == null) { if (list === 'origins') c.warn(`${label} · ${s.key}`, 'origins null (no full fill yet?)'); continue; }
          const cnt = parts.reduce((a, p) => a + n(p.count), 0);
          if (cnt !== n(s.total?.count)) c.fail(`${label} · ${s.key} · ${list} count`, `${cnt} ≠ total ${n(s.total?.count)}`);
          if (money) {
            const v = parts.reduce((a, p) => a + n(p.value_mkd), 0);
            if (Math.abs(v - n(s.total?.value_mkd)) > 3) c.fail(`${label} · ${s.key} · ${list} денари`, `${v} ≠ total ${n(s.total?.value_mkd)}`);
          } else {
            const money_keys = JSON.stringify(parts).match(/_mkd"/g)?.length ?? 0;
            if (money_keys) c5.fail(`${label} · ${s.key} · ${list}`, `${money_keys} *_mkd key(s) in the counted payload`);
            if (parts.some((p) => typeof p.count !== 'number')) c5.fail(`${label} · ${s.key} · ${list}`, 'a count is missing');
          }
        }
      }
      if (!money && JSON.stringify(j).match(/_mkd"/)) c5.fail(`${label}`, 'a *_mkd key somewhere in the counted cohort');
    }
  }
}

// ── O4 ────────────────────────────────────────────────────────────────────────
async function verifyRecount() {
  const c = check('O4', 'last month\'s Тим Центар Out origins = a sale-by-sale recount');
  const [row] = await timed('cohort last month', `SELECT public.insights_cohort(${W.prevMonth0}, ${END(W.month0)}, NULL, NULL, ARRAY['teleshop_out'], true) AS j`);
  const out = (parse(row.j).by_source ?? []).find((s) => s.key === 'teleshop_out');
  const rec = await timed('recount', `
    SELECT CASE WHEN s.phone8 IS NULL THEN 'new'
                ELSE public.customer_origin_at_sale(co.affiliate_at, co.natura_at, co.web_at, s.sale_at) END AS key,
           count(*) AS count, round(sum(s.value_mkd)) AS value_mkd
    FROM public.insights_sale_rows(${W.prevMonth0}, ${END(W.month0)}, false) s
    LEFT JOIN public.customer_origin co ON co.phone8 = s.phone8
    WHERE s.source = 'teleshop_out' AND s.in_total
    GROUP BY 1 ORDER BY 1`);
  if (!out?.origins) { c.fail('origins', 'none in the payload'); return; }
  for (const k of ['bio_natural', 'natura', 'new']) {
    const p = out.origins.find((o) => o.key === k) ?? { count: 0, value_mkd: 0 };
    const r = rec.find((x) => x.key === k) ?? { count: 0, value_mkd: 0 };
    c.tie(`${k} count`, n(r.count), n(p.count));
    c.tie(`${k} денари`, n(r.value_mkd), n(p.value_mkd));
  }
  const tot = n(out.total?.count);
  c.info('Тим Центар Out', out.origins.map((o) => `${o.key} ${n(o.count)} (${tot ? Math.round((n(o.count) / tot) * 100) : 0} %) · ${n(o.value_mkd)} ден`).join(' · '));
  c.info('of which web-first / mixed', `${out.origins.reduce((a, o) => a + n(o.web), 0)} / ${out.origins.reduce((a, o) => a + n(o.mixed), 0)}`);
  c.info('accounts', (out.accounts ?? []).map((a) => `${a.key} ${n(a.count)}`).join(' · '));
}

// ── O6 ────────────────────────────────────────────────────────────────────────
async function verifyEdges() {
  const c = check('O6', 'information: near twins and sales with no phone (last month)');
  const rows = await timed('edges', `
    SELECT s.source,
           count(*) AS sales,
           count(*) FILTER (WHERE s.phone8 IS NULL) AS no_phone,
           count(*) FILTER (WHERE least(co.affiliate_at, co.natura_at, co.web_at) BETWEEN s.sale_at - interval '48 hours' AND s.sale_at - interval '1 hour') AS first_trace_1_48h
    FROM public.insights_sale_rows(${W.prevMonth0}, ${END(W.month0)}, false) s
    LEFT JOIN public.customer_origin co ON co.phone8 = s.phone8
    WHERE s.in_total
    GROUP BY s.source ORDER BY s.source`);
  for (const r of rows) c.info(r.source, `${n(r.sales)} sales · ${n(r.no_phone)} no phone · ${n(r.first_trace_1_48h)} first trace 1–48 h before`);
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regclass('public.customer_origin') IS NOT NULL AS tbl,
           to_regprocedure('public.customer_origin_rows(text[])') IS NOT NULL AS fn,
           position('origins' in pg_get_functiondef('public.insights_cohort(timestamptz,timestamptz,timestamptz,timestamptz,text[],boolean)'::regprocedure)) > 0 AS cohort`);
  const missing = ['tbl', 'fn', 'cohort'].filter((k) => !have[k]);
  if (missing.length) {
    console.error(`verify-customer-origin: not applied yet (${missing.join(', ')}) — apply 20261015120000 and 20261015120100 first`);
    process.exit(2);
  }
  await verifyHealth();
  await verifyRecompute();
  await verifySums();
  await verifyRecount();
  await verifyEdges();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-customer-origin', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log('verify-customer-origin · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: ${l.want == null ? l.got : `want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-customer-origin error: ${e?.message ?? e}`); process.exit(2); });
