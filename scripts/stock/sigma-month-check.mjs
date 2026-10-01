/**
 * sigma-month-check — READ-ONLY: per month and article, what Sigma's monthly MEX COD invoice booked (client
 * 000217 МЕКС ПОШТА; Ф00001 = MEX account NATURA, Ф00003 АД Астра = BIO NATURAL) against the MEX parcels as the
 * collabBox document goods lines describe them: created / delivered / returned in that month (Skopje months).
 * The owner's question (01.10.2026): can Sigma's invoice be the stock truth for what leaves? — this is the proof
 * that it cannot (and, once the bookkeeping changes, the check that it can). No shebang (repo convention).
 *
 *   node scripts/stock/sigma-month-check.mjs                  # every month since 2026-01, both accounts
 *   node scripts/stock/sigma-month-check.mjs --month 2026-08  # + the articles of that month, biggest gaps first
 *   options: --from 2026-01  --account natura|bio_natural  --top 25  --csv (exports/stock/sigma-month-check-*.csv)
 *            --dir exports/stock   (sigma-mex-invoices.json from docs/stock/build_sigma_stock.py)
 *
 * Reading the numbers: Sigma books the NET month (refused parcels are netted in, never booked as returns), months
 * late, and NATURA's is typed by hand; gifts (0-value lines) are almost never on it. "delivered" counts the units
 * of parcels delivered (MEX 2) in the month, "returned" those returned (MEX 7) in the month, "created" those
 * created. collabBox documents exist from 03.2026; a parcel without one is counted in `no_lines`.
 *
 * Safety: Macedonia only (repair-kit guards); every statement is a SELECT sent with read_only: true.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bold, die, ok, printTable } from '../lib/repair-kit.mjs';
import { STOCK_DIR, args, guard, lit, loadJson, read } from './sigma-common.mjs';

const ACCOUNT_OF = { 'Ф00001': 'natura', 'Ф00003': 'bio_natural' };

/** Join the Sigma invoice lines and the parcel aggregates (pure — unit-testable). */
export function compare({ sigmaLines, parcels, coverage, account = null, names = null }) {
  const key = (m, acc, code) => `${m}|${acc}|${code}`;
  const rows = new Map();
  const get = (m, acc, code) => {
    const k = key(m, acc, code);
    if (!rows.has(k)) rows.set(k, { month: m, account: acc, code, name: null, sigma: 0, created: 0, delivered: 0, returned: 0, gifts_delivered: 0 });
    return rows.get(k);
  };
  for (const l of sigmaLines) {
    const acc = ACCOUNT_OF[l.company];
    if (!acc || (account && acc !== account)) continue;
    const r = get(l.month, acc, l.code);
    r.sigma += Number(l.units);
    r.name ??= l.name;
  }
  for (const p of parcels) {
    if (!p.month || (account && p.account !== account)) continue;
    const r = get(p.month, p.account, p.code);
    r[p.what] += Number(p.units);
    if (p.what === 'delivered') r.gifts_delivered += Number(p.gift_units ?? 0);
  }
  const months = new Map();
  for (const r of rows.values()) {
    r.name ??= names?.get(r.code) ?? null;
    const k = `${r.month}|${r.account}`;
    if (!months.has(k)) months.set(k, { month: r.month, account: r.account, sigma: 0, created: 0, delivered: 0, returned: 0, gifts_delivered: 0, articles_off: 0 });
    const m = months.get(k);
    for (const f of ['sigma', 'created', 'delivered', 'returned', 'gifts_delivered']) m[f] += r[f];
    if (Math.abs(r.sigma - r.delivered) >= 10) m.articles_off++;
  }
  for (const c of coverage) {
    const k = `${c.month}|${c.account}`;
    if (account && c.account !== account) continue;
    if (!months.has(k)) months.set(k, { month: c.month, account: c.account, sigma: 0, created: 0, delivered: 0, returned: 0, gifts_delivered: 0, articles_off: 0 });
    Object.assign(months.get(k), { parcels: c.parcels, no_lines: c.parcels - c.with_lines });
  }
  return { articles: [...rows.values()], months: [...months.values()].sort((a, b) => (a.month + a.account < b.month + b.account ? -1 : 1)) };
}

const pct = (a, b) => (b ? `${(((a - b) / b) * 100).toFixed(1)} %` : '—');
const n = (x) => Math.round(Number(x) || 0).toLocaleString('de-DE');

async function main() {
  const a = args(process.argv.slice(2), { flags: ['csv', 'help'], values: ['month', 'from', 'account', 'top', 'dir'] });
  if (a.help) { console.log('see the header of scripts/stock/sigma-month-check.mjs'); return; }
  const from = (a.month ?? a.from ?? '2026-01').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(from)) die('--month / --from must be YYYY-MM');
  if (a.account && !['natura', 'bio_natural'].includes(a.account)) die('--account must be natura or bio_natural');
  const inv = loadJson(a.dir ?? STOCK_DIR, 'sigma-mex-invoices.json');
  const names = new Map((loadJson(a.dir ?? STOCK_DIR, 'articles.json', { optional: true }) ?? []).map((x) => [x.code, x.name]));
  await guard();
  const since = `${from}-01 00:00:00+02`;
  const parcels = await read(`
    WITH pl AS (
      SELECT p.account, p.status_id, p.created_at_mex, p.delivered_at, p.returned_at,
             l->>'code' AS code, (l->>'qty')::numeric AS qty, coalesce((l->>'value_mkd')::numeric, 0) = 0 AS gift
        FROM public.mex_parcels p
        JOIN public.collabbox_documents d ON d.doc_number = p.tracking_id AND NOT coalesce(d.is_storno, false)
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.payload->'lines', '[]'::jsonb)) l
       WHERE l->>'role' = 'goods' AND coalesce((l->>'qty')::numeric, 0) > 0
         AND (p.created_at_mex >= ${lit(since)} OR p.delivered_at >= ${lit(since)} OR p.returned_at >= ${lit(since)}))
    SELECT 'created' AS what, to_char(created_at_mex AT TIME ZONE 'Europe/Skopje', 'YYYY-MM') AS month, account, code,
           sum(qty) AS units, sum(qty) FILTER (WHERE gift) AS gift_units FROM pl GROUP BY 2, 3, 4
    UNION ALL
    SELECT 'delivered', to_char(delivered_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM'), account, code, sum(qty), sum(qty) FILTER (WHERE gift)
      FROM pl WHERE status_id = 2 AND delivered_at IS NOT NULL GROUP BY 2, 3, 4
    UNION ALL
    SELECT 'returned', to_char(returned_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM'), account, code, sum(qty), sum(qty) FILTER (WHERE gift)
      FROM pl WHERE status_id = 7 AND returned_at IS NOT NULL GROUP BY 2, 3, 4`);
  const coverage = await read(`
    SELECT to_char(p.created_at_mex AT TIME ZONE 'Europe/Skopje', 'YYYY-MM') AS month, p.account, count(*)::int AS parcels,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.collabbox_documents d WHERE d.doc_number = p.tracking_id))::int AS with_lines
      FROM public.mex_parcels p WHERE p.created_at_mex >= ${lit(since)} GROUP BY 1, 2`);
  const sigmaLines = inv.lines.filter((l) => l.month >= from && (!a.month || l.month === a.month));
  const { articles, months } = compare({ sigmaLines, parcels: parcels.filter((p) => p.month >= from && (!a.month || p.month === a.month)),
    coverage: coverage.filter((c) => c.month >= from && (!a.month || c.month === a.month)), account: a.account ?? null, names });

  console.log(bold(`\nSigma MEX invoice (000217) vs MEX parcels — collabBox goods lines, units (Sigma export ${inv.sigma_export})`));
  printTable(months.map((m) => ({
    month: m.month, account: m.account, sigma: n(m.sigma), created: n(m.created), delivered: n(m.delivered), returned: n(m.returned),
    'sigma vs delivered': pct(m.sigma, m.delivered), 'gifts in delivered': n(m.gifts_delivered), 'articles ±10+': m.articles_off,
    parcels: m.parcels ?? '', 'no lines': m.no_lines ?? '',
  })));
  if (a.month) {
    const top = Number(a.top ?? 25);
    const rows = articles.filter((r) => r.sigma || r.delivered).sort((x, y) => Math.abs(y.sigma - y.delivered) - Math.abs(x.sigma - x.delivered));
    console.log(bold(`\n${a.month}: the ${top} biggest article gaps (Sigma − delivered)`));
    printTable(rows.slice(0, top).map((r) => ({ account: r.account, code: r.code, name: String(r.name ?? '').slice(0, 34), sigma: n(r.sigma),
      delivered: n(r.delivered), gifts: n(r.gifts_delivered), returned: n(r.returned), gap: n(r.sigma - r.delivered) })));
  }
  if (a.csv) {
    const outDir = a.dir ?? STOCK_DIR;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `sigma-month-check-${a.month ?? `from-${from}`}.csv`);
    const cols = ['month', 'account', 'code', 'name', 'sigma', 'created', 'delivered', 'gifts_delivered', 'returned'];
    const esc = (v) => (/[",\n;]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    writeFileSync(file, '﻿' + [cols.join(','), ...articles.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
    ok(`→ ${file}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
