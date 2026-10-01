/**
 * link-lead-parcels — the pure half of scripts/repair-link-lead-parcels.mjs, scripts/collabbox-recredit.mjs and
 * scripts/verify-parcel-link-rules.mjs (owner, Mile, 01.10.2026). No I/O here.
 *
 * THE RULES LIVE IN SQL, ONCE: public.link_lead_parcels_plan(days) (migration 20260944000950) and the two
 * no-parcel exemptions inside public.apply_no_parcel_rule() (migration 20260944000960). Nothing here re-implements
 * them: before a migration is applied the scripts run the migration FILE's own SQL (the repo's "inline" mode —
 * cf. scripts/verify-leaderboard-v2.mjs inlineBoardSql), afterwards the live function. So the nightly cron and the
 * one-off backfill cannot disagree: they are the same SELECT.
 *
 * The one JS twin is the postponement regex (postponedTextJs) — built FROM the migration's own constants, so the
 * vitest suite can prove the owner's examples; verify-parcel-link-rules.mjs runs the same fixtures in PostgreSQL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateHash, fmtSkopje, fmtMkd } from './repair-kit.mjs';

export const KEY = 'link-lead-parcels';
export const RECREDIT_KEY = 'collabbox-recredit';
export const PLAN_MIGRATION = '20260944000950_link_lead_parcels.sql';
export const EXEMPT_MIGRATION = '20260944000960_no_parcel_exemptions.sql';
export const PLAN_SIG = 'public.link_lead_parcels_plan(integer)';
export const DEFAULT_DAYS = 75;
/** Read-only 01.10.2026 ~20:00 Skopje (the owner's own count: 98 link / 46 manual of 397 parcels). */
export const EXPECTED = Object.freeze({ parcels: 397, link: 98, manual: 46 });

export const readMigration = (root, file) => readFileSync(join(root, 'supabase', 'migrations', file), 'utf8');

/** The text between `AS $tag$` (after `fnHead`) and the closing `$tag$`, CR-stripped — what pg stores as prosrc. */
export function functionBody(text, fnHead, tag = '$function$') {
  const t = String(text).replace(/\r/g, '');
  const at = t.indexOf(fnHead);
  if (at < 0) throw new Error(`${fnHead} is not in the migration`);
  const open = t.indexOf(`AS ${tag}`, at);
  if (open < 0) throw new Error(`no AS ${tag} after ${fnHead}`);
  const start = open + `AS ${tag}`.length;
  const end = t.indexOf(tag, start);
  if (end < 0) throw new Error(`unterminated ${tag} body of ${fnHead}`);
  return t.slice(start, end);
}

/** The plan function's body, $1::integer inlined — ONE read-only SELECT returning `plan`. */
export function inlinePlanSql(migrationText, days = DEFAULT_DAYS) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 400) throw new Error(`days must be an integer 1…400 (got ${days})`);
  const body = functionBody(migrationText, 'FUNCTION public.link_lead_parcels_plan(', '$plan$');
  const uses = body.split('$1::integer').length - 1;
  if (uses !== 1) throw new Error(`the plan body must use $1::integer exactly once (found ${uses})`);
  const sql = body.replace('$1::integer', `${d}::integer`);
  if (/\$\d/.test(sql.replace(/'(?:[^']|'')*'/g, ''))) throw new Error('an unsubstituted $n parameter is left in the plan body');
  return `SELECT (${sql.trim()}) AS plan`;
}

export const rpcPlanSql = (days = DEFAULT_DAYS) => `SELECT public.link_lead_parcels_plan(${Number(days)}::integer) AS plan`;

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export const planOf = (row) => parseJson(row?.plan);

/** The hash the plan carries must be the repair-kit's own (sha256 of the sorted lines) — the ledger's contract. */
export function planHashParity(plan) {
  const lines = (plan?.link ?? []).map((l) => l.line);
  const js = candidateHash(lines);
  return { ok: js === plan?.hash, js, sql: plan?.hash, lines };
}

/** A plan line is order:LL_kind:status>target:tracking — lineOrderId() of the kit must read the order id. */
export const PLAN_LINE_RE = /^[0-9a-f-]{36}:LL_(phone_date|phone_date_product):[a-z_]+>([a-z]+|=):.+$/;

/** The CSV the owner reviews: one row per linked parcel, then one per manual parcel. */
export function planCsvRows(plan) {
  const rows = [];
  for (const l of plan?.link ?? []) {
    rows.push({
      action: 'link', kind: l.kind, tracking: l.tracking_id, series: l.series ?? '', mex_status: `${l.mex_status_id ?? '?'} ${l.mex_status_name ?? ''}`.trim(),
      cod_mkd: l.cod_mkd, parcel_created: fmtSkopje(l.created_at_mex), order: l.display_id, source: l.sale_source,
      status: l.status, target: l.target ?? '(unchanged)', hours: l.hours, product: l.product ?? '', why: '',
    });
  }
  for (const m of plan?.manual ?? []) {
    const os = Array.isArray(m.orders) ? m.orders : [];
    rows.push({
      action: 'manual', kind: '', tracking: m.tracking_id, series: m.series ?? '', mex_status: `${m.mex_status_id ?? '?'} ${m.mex_status_name ?? ''}`.trim(),
      cod_mkd: m.cod_mkd, parcel_created: fmtSkopje(m.created_at_mex), order: os.map((o) => `${o.display_id} (${o.status}, ${o.hours} h)`).join(' | '),
      source: [...new Set(os.map((o) => o.sale_source))].join('|'), status: '', target: '', hours: '', product: os.map((o) => o.product ?? '').join(' | '),
      why: m.reason,
    });
  }
  return rows;
}

/** One printable line per bucket: "cancelled → paid: 28 (… ден)". */
export function moveTable(plan) {
  const out = {};
  for (const l of plan?.link ?? []) {
    const k = `${l.status} → ${l.target ?? (Number(l.mex_status_id) === 8 ? 'unchanged (MEX 8)' : 'unchanged')}`;
    out[k] ??= { parcels: 0, mkd: 0 };
    out[k].parcels++;
    out[k].mkd += Number(l.cod_mkd) || 0;
  }
  return Object.entries(out).sort((a, b) => b[1].parcels - a[1].parcels)
    .map(([move, v]) => ({ move, parcels: v.parcels, 'COD (ден)': fmtMkd(v.mkd) }));
}

/**
 * The existing BIO NATURAL repair (scripts/repair-link-elyon-parcels.mjs, COD-based) next to this plan: which of
 * its links agree (same parcel → same order), which point a parcel elsewhere (conflict), and its re-ships — the
 * case this rule never covers (the order already holds its own dead parcel). Run it AFTER this backfill.
 */
export function compareWithElyonRepair(plan, elyonUnits) {
  const mine = new Map((plan?.link ?? []).map((l) => [l.tracking_id, l.order_id]));
  const out = { agree: 0, conflict: [], only_elyon: { reship: 0, no_parcel: 0, cancel_then_ship: 0 } };
  for (const u of elyonUnits ?? []) {
    for (const r of u.rows ?? []) {
      const tracking = r.link?.tracking;
      if (!tracking) continue;
      const kind = String(r.rule || '').replace(/^LE_/, '');
      if (!mine.has(tracking)) { out.only_elyon[kind] = (out.only_elyon[kind] || 0) + 1; continue; }
      if (mine.get(tracking) === r.order_id) out.agree++;
      else out.conflict.push({ tracking, elyon_order: r.evidence?.order ?? r.order_id, kind });
    }
  }
  return out;
}

// ─── the no-parcel rule's scan, inlined (verify + report, read-only) ───────────────────────────────────────

/** The plpgsql body of apply_no_parcel_rule (from the migration FILE, or pg_get_functiondef of the live one). */
export const noParcelBody = (text) => functionBody(text, 'FUNCTION public.apply_no_parcel_rule(');

/** The four regex constants c_rx_d / c_rx_l / c_rx_w / c_rx_c → their SQL string expressions. */
export function regexConstants(body) {
  const out = {};
  for (const name of ['c_rx_d', 'c_rx_l', 'c_rx_w', 'c_rx_c']) {
    const m = String(body).match(new RegExp(`\\b${name}\\s+constant\\s+text\\s*:=\\s*([\\s\\S]*?);\\s*\\n`, 'i'));
    if (!m) throw new Error(`${name} is not declared in apply_no_parcel_rule`);
    out[name] = m[1].trim();
  }
  return out;
}

/** The SQL string literal(s) of a constant → the JS string (concatenated, '' unescaped). */
export function sqlStringValue(expr) {
  const parts = [...String(expr).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  if (!parts.length) throw new Error(`not a string expression: ${String(expr).slice(0, 60)}`);
  return parts.join('');
}

/**
 * The function's `_np` scan as ONE read-only SELECT: the CREATE TEMP TABLE … AS query with the plpgsql
 * variables replaced by literals (`params` = what the function would read: days, sources, fromDate, today,
 * postponeDays) and the regex constants by their string expressions. Returns rows of _np (plan_action …).
 */
export function inlineNoParcelScanSql(body, { days, sources, fromDate, today, postponeDays }) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!Number.isInteger(days) || !Number.isInteger(postponeDays)) throw new Error('days / postponeDays must be integers');
  if (!ymd.test(fromDate) || !ymd.test(today)) throw new Error('fromDate / today must be YYYY-MM-DD');
  if (!Array.isArray(sources) || !sources.length || sources.some((s) => !/^[a-z_]+$/.test(s))) throw new Error('bad sources');
  const b = String(body).replace(/\r/g, '');
  const m = b.match(/CREATE TEMP TABLE _np ON COMMIT DROP AS\n([\s\S]*?\n\s*FROM anp a\) s);/);
  if (!m) throw new Error('the _np scan (… FROM anp a) s;) is not in apply_no_parcel_rule — is 20260944000960 the body?');
  const rx = regexConstants(b);
  let q = m[1];
  for (const [k, v] of Object.entries(rx)) q = q.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${v})`);
  const lit = {
    _postpone_days: String(postponeDays), _days: String(days), _from_date: `DATE '${fromDate}'`, _today: `DATE '${today}'`,
    _sources: `ARRAY[${sources.map((s) => `'${s}'`).join(', ')}]::text[]`,
  };
  for (const [k, v] of Object.entries(lit)) q = q.replace(new RegExp(`(?<![\\w.])${k}\\b`, 'g'), v);
  const left = q.replace(/'(?:[^']|'')*'/g, '').match(/(?<![\w.])_[a-z_]+\b/g);
  if (left) throw new Error(`plpgsql variables left in the scan: ${[...new Set(left)].join(', ')}`);
  return q.trim();
}

/**
 * JS twin of the postponement test (PostgreSQL ARE → JS): \m / \M (word start / end) become Unicode-aware
 * look-arounds; the rest (\s \S \d, classes, {m,n}) means the same. Built from the migration's own constants.
 */
export function postponedTextJs(body) {
  const rx = regexConstants(body);
  const js = (s) => sqlStringValue(s).replace(/\\m/g, '(?<![\\p{L}\\p{N}_])').replace(/\\M/g, '(?![\\p{L}\\p{N}_])');
  const D = js(rx.c_rx_d), L = js(rx.c_rx_l), W = js(rx.c_rx_w), C = js(rx.c_rx_c);
  const s1 = new RegExp(`${D}[\\s\\S]{0,40}${L}|${L}[\\s\\S]{0,40}${D}`, 'u');
  const w = new RegExp(W, 'u'), c = new RegExp(C, 'u');
  return (text) => {
    const t = String(text ?? '').toLowerCase();
    return s1.test(t) || (w.test(t) && !c.test(t));
  };
}

/** The owner's examples and the calibration's traps — proven in vitest (JS twin) and in PostgreSQL (verify). */
export const POSTPONE_FIXTURES = Object.freeze([
  ['достава после 1ви', true],
  ['сопругот има трнење во нозете, достава после 17.09', true],
  ['после први да и стигне да земе пензија', true],
  ['да стигне пратката после вторник', true],
  ['доставата да биде на после 08.10.2026.', true],
  ['dostava posle 1vi', true],
  ['da se pratat na 24 ti', true],
  ['одложено за покасно да стигне', true],
  ['да се одложи испораката, posle plata', true],
  ['следниот месец да се прати', true],
  ['posle penzija', true],
  ['подоцна да го бараме', false],
  ['ќе се јави подоцна', false],
  ['на 15ти зимал плата, тогаш да му се јавиме', false],
  ['после 16ч. да го бараме', false],
  ['достава после 16ч', false],
  ['3/3 пратки вратено, лаже за адреса', false],
  ['упорен дека за 750 ден една кутија да му пратиме', false],
  ['naredniot mesec planira da naraca', false],
  ['sledniot mesec ke se javi', false],
  ['ke se javi posle penzija', false],
  ['да размисли па ќе се јави', false],
]);

// ─── collabBox credit re-run ───────────────────────────────────────────────────────────────────────────────

/** Skopje days → the doc_at range literal pair (inclusive days). */
export function skopjeDayRange(from, to) {
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to) || from > to) throw new Error(`bad range ${from} … ${to}`);
  return {
    fromSql: `('${from}'::date::timestamp AT TIME ZONE 'Europe/Skopje')`,
    toSql: `(('${to}'::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje')`,
  };
}

/** How one live-path result reads: credited / still pending / recorded (with the credit word). */
export function recreditBucket(r) {
  const o = r?.outcome ?? 'error';
  if (o === 'credited') return `credited (${r.credit ?? '?'})`;
  if (o === 'credit_pending') return `still pending (${r.reason ?? '?'})`;
  if (o === 'recorded') return `recorded (${r.credit ?? r.reason ?? '?'})`;
  return `${o}${r?.reason ? ` (${String(r.reason).slice(0, 60)})` : ''}`;
}

export const recreditLine = (doc) => `${doc.related_order_id ?? doc.holder ?? 'none'}:recredit:${doc.doc_number}:`;
