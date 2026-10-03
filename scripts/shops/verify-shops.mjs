#!/usr/bin/env node
/**
 * verify-shops — READ-ONLY checks of the shops data (collabbox-shops reader, migrations 20260946000100–0300;
 * contract docs/SHOPS.md). Owner request 02.10.2026.
 *
 *   node scripts/shops/verify-shops.mjs                 (text report, the last 14 Skopje days)
 *   node scripts/shops/verify-shops.mjs --days=30
 *   node scripts/shops/verify-shops.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   H1  receipts == the daily control: per shop and day, the 10022 lines (ПОЕН included — the till includes them)
 *       minus 10010 returns == the 10018 Дневен Финансиски Извештај and the trade book, within
 *       max(1, 0,5 × receipts) ден (both are rounded per receipt). Recomputed from the lines, not read from `ok`.
 *   H2  the stock chain: for consecutive nightly takes of a shop, snapshot(t1) + the lines after it (receipts,
 *       returns, goods documents by shops_doc_delta) == snapshot(t2), article by article (ПОЕН apart).
 *       ≤ 2 % of the articles off = WARN (a document dated before the read but typed after it), more = FAIL.
 *   H3  Natura ↔ Stores: every Sigma invoice to client 000001 (ПМ1/ПМ2/ПМ9) since the first 10042 read is
 *       received in collabBox as a 10042 with Natura's number (shops_natura_doc_key), with the same units.
 *       Not received after 3 days, or other units = WARN (the number is hand-typed).
 *   H4  no money for managers: every report with p_money = false holds no *_mkd key (also unit-tested in
 *       supabase/functions/api/shops.test.ts).
 *   H5  never added up: no 10018 / 10016 / 10066 / 10008 among the sales or the goods documents; ПОЕН lines
 *       flagged; trade-book corrections listed (info).
 *   H6  no customer data: shop_sales_lines has no customer column; receipts with a named komitent (info).
 *   H7  freshness while the reader is on (07:30–23:00 Skopje): receipts < 35 min, goods < 75 min, stock < 26 h.
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia (oufoazmnbwugtfldkwsn),
 * refused if .env points at Bulgaria, every statement a single SELECT / WITH sent with read_only: true.
 */
import { runSql } from '../verify-insights-ties.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const n = (v) => Number(v ?? 0) || 0;
const DAYS = Math.min(120, Math.max(1, Number(arg('days')) || 14));

const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    fail(label, detail) { c.lines.push({ label, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, got: detail, ok: true, info: true }); },
    skip(label) { c.lines.push({ label, got: '', ok: true, info: true }); if (c.status === 'PASS') c.status = 'SKIP'; },
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regclass('public.shop_sales_lines') IS NOT NULL AS tables,
           to_regprocedure('public.shops_day(date,boolean)') IS NOT NULL AS reports,
           to_regclass('public.stock_sigma_docs') IS NOT NULL AS sigma,
           (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
           to_char(now() AT TIME ZONE 'Europe/Skopje', 'HH24:MI') AS now_hm,
           (SELECT value FROM public.app_settings WHERE key = 'shops_reader') AS setting`);
  if (!have.tables || !have.reports) {
    console.error('verify-shops: the shops tables / reports are missing — apply 20260946000100 / 0200 first');
    process.exit(2);
  }
  const today = String(have.today).slice(0, 10);
  const from = `(DATE '${today}' - ${DAYS})`;

  // ── H1 controls ────────────────────────────────────────────────────────────
  {
    const c = check('H1', `receipts == the 10018 report and the trade book (last ${DAYS} days)`);
    const rows = await runSql(`
      WITH l AS (
        SELECT (sold_at AT TIME ZONE 'Europe/Skopje')::date AS day, shop_code,
               count(DISTINCT doc_number) FILTER (WHERE doc_type = '10022') AS receipts,
               round(sum(CASE WHEN is_return THEN -1 ELSE 1 END * coalesce(sale_value_mkd, 0)), 2) AS total
          FROM public.shop_sales_lines
         WHERE sold_at >= (${from})::timestamp AT TIME ZONE 'Europe/Skopje'
           AND sold_at < (DATE '${today}')::timestamp AT TIME ZONE 'Europe/Skopje'
         GROUP BY 1, 2
      )
      SELECT k.day, k.shop_code, coalesce(l.receipts, 0) AS receipts, coalesce(l.total, 0) AS lines_total,
             k.report_total_mkd AS report, k.tk_total_mkd AS tk, greatest(1, 0.5 * coalesce(l.receipts, 0)) AS tol
        FROM public.shop_day_controls k
        LEFT JOIN l ON l.day = k.day AND l.shop_code = k.shop_code
       WHERE k.day >= ${from} AND k.day < DATE '${today}'
       ORDER BY k.day, k.shop_code`);
    if (!rows.length) c.skip('no controls in the window yet (the nightly / backfill has not read any)');
    let bad = 0;
    for (const r of rows) {
      const t = n(r.lines_total), tol = n(r.tol);
      const offR = r.report != null && Math.abs(t - n(r.report)) > tol;
      const offT = r.tk != null && Math.abs(t - n(r.tk)) > tol;
      if (offR || offT) {
        bad++;
        if (bad <= 15) c.fail(`${String(r.day).slice(0, 10)} ${r.shop_code}`, `lines ${t} · 10018 ${r.report ?? '–'} · trade book ${r.tk ?? '–'} (tolerance ${tol})`);
      }
    }
    if (rows.length) c.info('shop-days checked', `${rows.length}, ${bad} off`);
    const [missing] = await runSql(`
      SELECT count(*) AS n FROM (
        SELECT DISTINCT (sold_at AT TIME ZONE 'Europe/Skopje')::date AS day, shop_code FROM public.shop_sales_lines
         WHERE doc_type = '10022' AND sold_at >= (${from})::timestamp AT TIME ZONE 'Europe/Skopje'
           AND sold_at < (DATE '${today}')::timestamp AT TIME ZONE 'Europe/Skopje') s
       WHERE NOT EXISTS (SELECT 1 FROM public.shop_day_controls k WHERE k.day = s.day AND k.shop_code = s.shop_code)`);
    if (n(missing.n)) c.warn('shop-days with receipts but no control yet', n(missing.n));
  }

  // ── H2 the stock chain ────────────────────────────────────────────────────
  {
    const c = check('H2', 'snapshot(t1) + moves after it == snapshot(t2), per shop and article');
    const rows = await runSql(`
      WITH tk AS (
        SELECT shop_code, taken_at, lead(taken_at) OVER (PARTITION BY shop_code ORDER BY taken_at) AS next_at
          FROM public.shop_stock_takes
         WHERE source = 'infollc' AND taken_at >= (${from})::timestamp AT TIME ZONE 'Europe/Skopje'
      ), pairs AS (SELECT * FROM tk WHERE next_at IS NOT NULL),
      -- the stock an instant before t2 = snapshot(t1) + every line in (t1, t2)
      snap_before AS (
        SELECT p.shop_code, p.taken_at, p.next_at, s.article_code, s.qty
          FROM pairs p CROSS JOIN LATERAL public.shops_stock_at(p.next_at - interval '1 microsecond', ARRAY[p.shop_code]) s
      ), snap_after AS (
        SELECT p.shop_code, p.taken_at, p.next_at, z.article_code, z.qty
          FROM pairs p JOIN public.shop_stock_snapshots z ON z.taken_at = p.next_at AND z.shop_code = p.shop_code
      ), cmp AS (
        SELECT coalesce(a.shop_code, b.shop_code) AS shop_code, coalesce(a.taken_at, b.taken_at) AS taken_at,
               coalesce(a.next_at, b.next_at) AS next_at, coalesce(a.article_code, b.article_code) AS article_code,
               coalesce(a.qty, 0) AS want, coalesce(b.qty, 0) AS got
          FROM snap_before a
          FULL JOIN snap_after b ON b.shop_code = a.shop_code AND b.next_at = a.next_at AND b.article_code = a.article_code
      )
      SELECT x.shop_code, x.taken_at, x.next_at, count(*) AS articles,
             count(*) FILTER (WHERE abs(x.want - x.got) > 0.0005) AS off,
             (array_agg(x.article_code || ':' || round(x.want, 3) || '≠' || round(x.got, 3) ORDER BY x.article_code)
                FILTER (WHERE abs(x.want - x.got) > 0.0005))[1:5] AS sample
        FROM cmp x
       WHERE NOT public.shops_is_point(x.article_code, NULL)
         AND NOT EXISTS (SELECT 1 FROM public.shop_articles sa WHERE sa.article_code = x.article_code AND sa.is_point)
       GROUP BY x.shop_code, x.taken_at, x.next_at
       ORDER BY x.taken_at, x.shop_code`);
    if (!rows.length) c.skip('fewer than two nightly takes per shop in the window');
    let arts = 0, off = 0;
    for (const r of rows) {
      arts += n(r.articles); off += n(r.off);
      if (n(r.off)) {
        const pct = (100 * n(r.off)) / Math.max(1, n(r.articles));
        const line = `${r.shop_code} ${String(r.taken_at).slice(0, 16)} → ${String(r.next_at).slice(0, 16)}: ${r.off}/${r.articles} articles off (${pct.toFixed(1)} %) ${JSON.stringify(r.sample)}`;
        if (pct > 2) c.fail('chain broken', line); else c.warn('chain', line);
      }
    }
    if (rows.length) c.info('take pairs · articles · off', `${rows.length} · ${arts} · ${off}`);
  }

  // ── H3 Sigma ↔ collabBox 10042 ────────────────────────────────────────────
  {
    const c = check('H3', 'Sigma invoices to Stores (000001) ↔ collabBox 10042 by Natura\'s number');
    if (!have.sigma) c.skip('stock_sigma_docs missing (Stock v2 not applied)');
    else {
      const rows = await runSql(`
        WITH first AS (SELECT min(doc_at AT TIME ZONE 'Europe/Skopje')::date AS d FROM public.shop_docs WHERE doc_type = '10042' AND header_seen),
        inv AS (
          SELECT d.doc_no, d.doc_date, d.object_to,
                 (SELECT coalesce(sum(l.qty), 0) FROM jsonb_to_recordset(d.lines) AS l(item_code text, qty numeric, side text) WHERE l.side = 'out') AS units
            FROM public.stock_sigma_docs d, first
           WHERE d.client_code = '000001' AND d.vanished_at IS NULL AND d.excluded_reason IS NULL
             AND d.doc_type IN ('ПМ1', 'ПМ2', 'ПМ9') AND d.doc_date >= greatest(first.d, ${from}) AND d.doc_date < DATE '${today}'
        )
        SELECT i.doc_no, i.doc_date, i.object_to, i.units, r.doc_number, r.units AS received_units
          FROM inv i
          LEFT JOIN LATERAL (
            SELECT sd.doc_number, (SELECT coalesce(sum(x.qty_in - x.qty_out), 0) FROM public.shop_doc_lines x
                                    WHERE x.doc_number = sd.doc_number AND NOT x.is_point AND NOT x.is_correction) AS units
              FROM public.shop_docs sd
             WHERE sd.doc_type = '10042' AND sd.vanished_at IS NULL
               AND regexp_replace(sd.natura_doc_key, '^\\d+-', '') = regexp_replace(public.shops_natura_doc_key(i.doc_no), '^\\d+-', '')
               AND sd.doc_at >= (i.doc_date - 10)::timestamp AT TIME ZONE 'Europe/Skopje'
               AND sd.doc_at < (i.doc_date + 60)::timestamp AT TIME ZONE 'Europe/Skopje'
             ORDER BY sd.doc_at LIMIT 1) r ON true
         ORDER BY i.doc_date, i.doc_no`);
      if (!rows.length) c.skip('no Sigma invoice to the shops since the first 10042 read');
      let matched = 0;
      for (const r of rows) {
        const age = (Date.parse(today) - Date.parse(String(r.doc_date).slice(0, 10))) / 86_400_000;
        if (!r.doc_number) { if (age > 3) c.warn('not received', `${r.doc_no} (${String(r.doc_date).slice(0, 10)}, object ${r.object_to}, ${n(r.units)} units)`); continue; }
        matched++;
        if (Math.abs(n(r.units) - n(r.received_units)) > 0.0005) c.warn('units differ', `${r.doc_no}: Sigma ${n(r.units)} · collabBox ${r.doc_number} ${n(r.received_units)}`);
      }
      if (rows.length) c.info('invoices · received', `${rows.length} · ${matched}`);
    }
  }

  // ── H4 no money for managers ──────────────────────────────────────────────
  {
    const c = check('H4', 'every report with p_money = false holds no *_mkd key');
    const [r] = await runSql(`
      SELECT public.shops_day(DATE '${today}', false)::text ~ '_mkd"' AS day,
             public.shops_period(DATE '${today}' - 6, DATE '${today}', false)::text ~ '_mkd"' AS period,
             coalesce(public.shop_detail('003', DATE '${today}' - 6, DATE '${today}', NULL, false)::text ~ '_mkd"', false) AS detail,
             public.shops_stock_matrix(NULL, NULL, NULL, false)::text ~ '_mkd"' AS matrix,
             public.shops_deliveries(DATE '${today}' - 29, DATE '${today}', NULL, false)::text ~ '_mkd"' AS deliveries,
             public.shops_health(false)::text ~ '_mkd"' AS health`);
    for (const [k, v] of Object.entries(r)) if (v) c.fail(k, 'a *_mkd key in the managers\' payload');
  }

  // ── H5 never added up ─────────────────────────────────────────────────────
  {
    const c = check('H5', '10018 / 10016 / 10066 / 10008 never among sales or goods; ПОЕН flagged');
    const [r] = await runSql(`
      SELECT (SELECT count(*) FROM public.shop_sales_lines WHERE doc_type NOT IN ('10022', '10010')) AS bad_sales,
             (SELECT count(*) FROM public.shop_docs WHERE doc_type IN ('10018', '10016', '10066', '10008', '10009')) AS bad_docs,
             (SELECT count(*) FROM public.shop_sales_lines WHERE public.shops_is_point(article_code, article_name) <> is_point) AS point_flag_off,
             (SELECT count(*) FROM public.shop_doc_lines WHERE public.shops_is_point(article_code, article_name) <> is_point) AS doc_point_flag_off,
             (SELECT count(*) FROM public.shop_doc_lines WHERE is_correction) AS corrections,
             (SELECT string_agg(doc_number || ' ' || article_name || ' ' || round(sale_value_mkd), '; ') FROM
                (SELECT doc_number, article_name, sale_value_mkd FROM public.shop_doc_lines WHERE is_correction ORDER BY doc_at DESC LIMIT 5) x) AS corrections_sample`);
    if (n(r.bad_sales)) c.fail('sales lines of another type', n(r.bad_sales));
    if (n(r.bad_docs)) c.fail('goods documents of a never-read type', n(r.bad_docs));
    if (n(r.point_flag_off) || n(r.doc_point_flag_off)) c.fail('ПОЕН flag out of step', `${r.point_flag_off} sales · ${r.doc_point_flag_off} goods`);
    c.info('trade-book corrections (never goods)', n(r.corrections) ? `${r.corrections}: ${r.corrections_sample}` : 0);
  }

  // ── H6 no customer data ───────────────────────────────────────────────────
  {
    const c = check('H6', 'no customer data stored');
    const cols = await runSql(`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('shop_sales_lines', 'shop_docs', 'shop_doc_lines')
         AND column_name ~ '(komitent|customer_name|phone|address|email)'`);
    for (const x of cols) c.fail('a customer column', `${x.table_name}.${x.column_name}`);
    const [r] = await runSql(`SELECT count(DISTINCT doc_number) AS n FROM public.shop_sales_lines WHERE named_customer`);
    c.info('receipts with a named komitent (only counted)', n(r.n));
  }

  // ── H7 freshness ──────────────────────────────────────────────────────────
  {
    const c = check('H7', 'freshness while the reader is on');
    const on = have.setting?.enabled === true;
    const [f] = await runSql(`
      SELECT extract(epoch FROM now() - (public.shops_freshness()->>'last_sales_at')::timestamptz) / 60 AS sales_min,
             extract(epoch FROM now() - (public.shops_freshness()->>'last_docs_at')::timestamptz) / 60 AS docs_min,
             extract(epoch FROM now() - (public.shops_freshness()->>'last_stock_snapshot_at')::timestamptz) / 3600 AS stock_h,
             (SELECT count(*) FROM public.shops_reader_runs WHERE started_at > now() - interval '24 hours' AND status = 'failed') AS failed_24h`);
    c.info('reader', on ? 'on' : 'off (app_settings.shops_reader.enabled = false)');
    c.info('last receipts read · goods · stock', `${f.sales_min == null ? '–' : Math.round(n(f.sales_min)) + ' min'} · ${f.docs_min == null ? '–' : Math.round(n(f.docs_min)) + ' min'} · ${f.stock_h == null ? '–' : n(f.stock_h).toFixed(1) + ' h'}`);
    if (n(f.failed_24h)) c.warn('failed runs in 24 h', n(f.failed_24h));
    if (on && have.now_hm >= '07:30' && have.now_hm <= '23:00') {
      if (f.sales_min == null || n(f.sales_min) > 35) c.fail('receipts', `last read ${f.sales_min == null ? 'never' : Math.round(n(f.sales_min)) + ' min ago'}`);
      if (f.docs_min == null || n(f.docs_min) > 75) c.fail('goods documents', `last read ${f.docs_min == null ? 'never' : Math.round(n(f.docs_min)) + ' min ago'}`);
      if (f.stock_h == null || n(f.stock_h) > 26) c.fail('stock', `last take ${f.stock_h == null ? 'never' : n(f.stock_h).toFixed(1) + ' h ago'}`);
    }
  }

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-shops', read_only: true, generated_at: new Date().toISOString(), days: DAYS, status: fail ? 'FAIL' : 'PASS', results }, null, 2));
  } else {
    console.log(`verify-shops · read-only · Macedonia · last ${DAYS} days`);
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}${l.got === '' ? '' : ': ' + (typeof l.got === 'object' ? JSON.stringify(l.got) : l.got)}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else console.log(`        ✗ ${l.label}: ${l.got}`);
      }
    }
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-shops error: ${e?.message ?? e}`); process.exit(2); });
