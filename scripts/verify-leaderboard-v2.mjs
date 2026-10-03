/**
 * verify-leaderboard-v2 — READ-ONLY proof that the TV leaderboard v2
 * (public.leaderboard_day_v2, migration 20260942001200, GET /api/leaderboard?v=2)
 * shows every agent exactly what she made that day, in which department.
 *
 *   node scripts/verify-leaderboard-v2.mjs                        (the 7 Skopje days ending today)
 *   node scripts/verify-leaderboard-v2.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-leaderboard-v2.mjs --inline               (run the migration FILE's body even when deployed)
 *   node scripts/verify-leaderboard-v2.mjs --filters-day 2026-09-28   (the day the filter checks run on; default --to)
 *   node scripts/verify-leaderboard-v2.mjs --no-filters --json
 *
 * Before the migration is applied it runs the function's body straight out of the
 * migration file (a plain read-only SELECT, parameters inlined), so the file itself
 * is what is proven ("mode: inline"); afterwards it calls the RPC ("mode: rpc").
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB unreachable.
 *
 * What it proves, per Skopje day:
 *   L1  every person × department (sales, денари, cancelled after the sale, live-credited,
 *       collabBox bookings counted / not counted, decisions, sale decisions) = the truth
 *       computed here STRAIGHT from orders (the cohort's sale clock, bucket and value rules,
 *       the sold_* stamp, an unstamped sale → the day's first v_sales_work sale decision),
 *       v_sales_work, and for the bookings (20260942001900): counted = THE cohort's booking
 *       rows (insights_sale_rows kind 'booking' — scripts/verify-insights-ties.mjs D1 proves
 *       those rows), not counted = the rest of collabbox_booked_today's documents; and the
 *       no-seller cells (sales, денари, bookings, unmapped decisions)
 *   L2  Σ board = THE cohort (public.insights_cohort) of the day, per department: credited
 *       + no seller = the cohort's orders, денари = its order splits, web / MEX-only parts,
 *       the collabBox bookings (count and денари) = its booked part, cancelled / trashed after
 *       the sale — so nothing is missed, nothing is extra, and no booking is counted twice
 *   L3  once and only once: a person is one row; Σ rows' departments = the department's
 *       credited sales; a row = Σ its departments; total = sales + counted bookings;
 *       the summary = Σ the rows
 *   L4  rank: only non-managers with a total, rank() by денари then count, managers
 *       never ranked and listed last; is_manager = sales_people.is_manager or an
 *       admin / manager role
 *   L5  roster: every team member valid that day (active, or a closed membership), everyone
 *       with CRM presence minutes or a login record, everyone credited — on the board
 *   L6  safety counters: no department = 0 everywhere, the bookings filter copy = 0 drift
 *   L7  filters (one day): a department shows exactly the people with anything in it and
 *       that department's cell; a team shows exactly its badge holders, numbers unchanged
 *   T   timings (server round trip per board)
 *
 * Safety: the same guard as scripts/verify-insights-ties.mjs (imported, not copied) —
 * pinned to Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every
 * statement a single SELECT/WITH sent with read_only: true. The token is never printed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// the file holding the LATEST body of leaderboard_day_v2 (--inline runs it): 20260942001900 counts
// the day's collabBox bookings from THE cohort's booking rows (1200 wrote the board, 1800 passed the
// department override through it)
// the newest leaderboard_day_v2 body (teams = business lines: team:lane filter, lanes, 20260943000950;
// bookings on their BOOKING day + a department's own decisions, 20260944000600)
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260944000600_booking_day_readers.sql');
const SIG = 'public.leaderboard_day_v2(date,text,text)';
export const DEPARTMENTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const r0 = (v) => Math.round(n(v));
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const tie = (label, want, got) => ({ label, want, got, ok: want === got });

function validYmd(s) {
  if (!YMD.test(s ?? '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const addDays = (ymd, k) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10); };
const skopjeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
const dayRange = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

// ── the board ────────────────────────────────────────────────────────────────

/** The function's EXECUTE body out of the migration file, parameters inlined — a
 *  single read-only SELECT. */
export function inlineBoardSql(migrationText, { day, department = null, team = null }) {
  if (!validYmd(day)) throw new Error(`bad day ${day}`);
  const m = migrationText.match(/EXECUTE \$lb2\$\r?\n([\s\S]*?)\r?\n\s*\$lb2\$/);
  if (!m) throw new Error(`the $lb2$ body is not in ${MIGRATION}`);
  const dayE = `'${day}'::date`;
  const body = m[1]
    .replaceAll('$1::timestamptz', `(${dayE}::timestamp AT TIME ZONE 'Europe/Skopje')`)
    .replaceAll('$2::timestamptz', `(((${dayE} + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond')`)
    .replaceAll('$3::date', dayE)
    .replaceAll('$4::text', `${lit(department)}::text`)
    .replaceAll('$5::text', `${lit(team)}::text`)
    .replaceAll('$6::boolean', `(${dayE} = (now() AT TIME ZONE 'Europe/Skopje')::date)`)
    .replaceAll('$7::text[]', 'public.report_excluded_phone8s()');
  if (/\$\d/.test(body.replace(/'(?:[^']|'')*'/g, ''))) throw new Error('an unsubstituted $n parameter is left in the body');
  return `SELECT (${body}) AS doc`;
}

async function board(ctx, day, department = null, team = null) {
  const t0 = Date.now();
  const q = ctx.live
    ? `SELECT public.leaderboard_day_v2('${day}'::date, ${lit(department)}::text, ${lit(team)}::text) AS doc`
    : inlineBoardSql(ctx.migration, { day, department, team });
  const [r] = await runSql(q);
  ctx.timings.push({ day, department, team, ms: Date.now() - t0 });
  return parseJson(r.doc);
}

// ── the truth, straight from the tables ──────────────────────────────────────

/** Person × department × day, computed without the function: the cohort's sale
 *  clock / bucket / value rules on orders, the sold_* stamp or (unstamped) the day's
 *  first v_sales_work sale decision, the day's decisions; the collabBox bookings the
 *  cohort counts (its kind 'booking' rows, 20260942001900) and the rest of
 *  collabbox_booked_today's documents as not counted. */
export function truthSql(from, to, { bookingDay = true } = {}) {
  if (!validYmd(from) || !validYmd(to)) throw new Error('bad window');
  // a booking's day: the day it was BOOKED (collabbox_sale_at, 20260944000500) — doc_at before it exists
  const saleAt = bookingDay ? 'public.collabbox_sale_at(d.doc_at, d.booked_at)' : 'd.doc_at';
  return `
WITH
dd AS (
  SELECT g::date AS day,
         (g::date::timestamp AT TIME ZONE 'Europe/Skopje') AS f,
         (((g::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond') AS t
  FROM generate_series('${from}'::date, '${to}'::date, interval '1 day') g
),
bnd AS (SELECT min(dd.f) AS f, max(dd.t) AS t FROM dd),
ex AS (SELECT public.report_excluded_phone8s() AS p8s),
tp AS MATERIALIZED (SELECT p.tracking_id AS tr FROM public.mex_parcels p, ex WHERE p.phone8 = ANY (ex.p8s)),
xo AS MATERIALIZED (
  SELECT x.id FROM public.orders x, ex WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY (ex.p8s)
  UNION SELECT x.id FROM public.orders x JOIN tp ON tp.tr = x.mex_tracking_id
),
wc AS MATERIALIZED (SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
                     WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL),
ap AS MATERIALIZED (
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL
  GROUP BY 1
),
o1 AS MATERIALIZED (
  SELECT x.id, x.status::text AS status, x.price, x.sold_at, x.sold_by_person_id, x.sale_source, x.sale_source_detail,
         x.mex_tracking_id, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at, x.paid_basis, x.source_type, x.dept_override,
         coalesce(x.sold_at, ap.decided_at, x.confirmed_at, x.created_at) AS sale_at,
         coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false) AS web_claimed
  FROM public.orders x
  LEFT JOIN ap ON ap.order_id = x.id
  CROSS JOIN bnd
  WHERE (x.sold_at BETWEEN bnd.f AND bnd.t
         OR (x.sold_at IS NULL AND x.confirmed_at BETWEEN bnd.f AND bnd.t)
         OR x.created_at BETWEEN bnd.f AND bnd.t
         OR x.id IN (SELECT ap.order_id FROM ap WHERE ap.decided_at BETWEEN bnd.f AND bnd.t))
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.id NOT IN (SELECT xo.id FROM xo)
),
o2 AS MATERIALIZED (
  SELECT o1.*, dd.day,
         public.cohort_order_bucket(o1.status, o1.price, o1.sold_at, o1.paid_basis, o1.source_type, o1.sale_source_detail,
                                    o1.mex_tracking_id, o1.mex_status_id, o1.mex_cod_mkd, o1.mex_delivered_at, o1.web_claimed) AS bucket,
         (o1.mex_tracking_id IS NOT NULL AND (o1.mex_status_id IS NOT NULL OR o1.mex_delivered_at IS NOT NULL)
          AND NOT o1.web_claimed) AS hp,
         public.cohort_order_source(o1.sale_source, o1.sale_source_detail, o1.mex_tracking_id, o1.dept_override) AS dept
  FROM o1 JOIN dd ON o1.sale_at BETWEEN dd.f AND dd.t
),
-- a parcel several real orders hold: each holder's share of the ONE COD, by price;
-- the first-created holder takes the rounding remainder (a single holder: the COD)
shr AS (
  SELECT s.id, CASE WHEN s.rn = 1 THEN s.cod - (sum(s.part) OVER (PARTITION BY s.tr) - s.part) ELSE s.part END AS cod_share
  FROM (SELECT t.*, round(t.cod * t.frac) AS part
          FROM (SELECT x.id, x.mex_tracking_id AS tr, (max(x.mex_cod_mkd) OVER w)::numeric AS cod,
                       row_number() OVER (PARTITION BY x.mex_tracking_id ORDER BY x.created_at, x.id) AS rn,
                       CASE WHEN sum(greatest(x.price, 0)) OVER w > 0 THEN greatest(x.price, 0) / sum(greatest(x.price, 0)) OVER w
                            ELSE 1.0 / count(*) OVER w END AS frac
                  FROM public.orders x
                 WHERE x.mex_tracking_id IN (SELECT o2.mex_tracking_id FROM o2 WHERE o2.hp)
                   AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                   AND x.id NOT IN (SELECT xo.id FROM xo)
                WINDOW w AS (PARTITION BY x.mex_tracking_id)) t) s
),
vw AS MATERIALIZED (
  SELECT v.at, dd.day, v.person_id, v.order_id, v.outcome, v.via
  FROM public.v_sales_work v JOIN dd ON v.at BETWEEN dd.f AND dd.t
  WHERE v.order_id IS NULL OR v.order_id NOT IN (SELECT xo.id FROM xo)
),
cr AS (
  SELECT o2.day, o2.dept, public.cohort_in_total(o2.bucket) AS in_total, (o2.sold_at IS NULL) AS unstamped,
         CASE WHEN o2.bucket = 'replacement' THEN 0
              WHEN o2.hp AND sh.cod_share IS NOT NULL THEN sh.cod_share
              WHEN o2.hp AND o2.mex_cod_mkd IS NOT NULL THEN o2.mex_cod_mkd
              ELSE round(coalesce(o2.price, 0) * 61.5) END AS value_mkd,
         CASE WHEN o2.sold_at IS NOT NULL THEN o2.sold_by_person_id
              ELSE (SELECT w.person_id FROM vw w WHERE w.day = o2.day AND w.order_id = o2.id AND w.outcome = 'sale'
                      AND w.person_id IS NOT NULL ORDER BY w.at LIMIT 1) END AS pid
  FROM o2 LEFT JOIN shr sh ON sh.id = o2.id
  WHERE o2.bucket IS NOT NULL
    AND (public.cohort_in_total(o2.bucket) OR o2.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
    -- 10 Skopje days after the sale day a sale MEX never took counts no more (20260947001850)
    AND NOT (o2.sale_at < (SELECT public.cohort_unshipped_since())
             AND (o2.bucket IN ('to_pack', 'label') OR (o2.bucket = 'courier' AND NOT o2.hp)))
),
-- the day's collabBox documents no order holds yet: collabbox_booked_today's filter, one
-- document at a time (the board's L6 drift check ties its own copy to the function)
bk AS MATERIALIZED (
  SELECT dd.day, d.doc_number, d.author_person_id AS person_id, d.amount_mkd,
         -- the author's team first (20260947000400), as the board's bkc
         coalesce(public.order_dept_by_team((public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at))[1],
                                            d.author_person_id, d.doc_at),
                  public.cohort_order_source((public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at))[1],
                                             (public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at))[2],
                                             d.doc_number)) AS dept
  FROM dd JOIN public.collabbox_documents d ON ${saleAt} BETWEEN dd.f AND dd.t AND d.doc_at >= dd.f
  WHERE d.outcome IN ('booked', 'awaiting_parcel') AND d.vanished_at IS NULL AND NOT d.is_storno AND d.amount_mkd > 0
    AND d.doc_type_id IN ('10036', '10050', '10111', '10114', '10106')
    AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.external_source = 'collabbox' AND o.external_order_id = d.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = d.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p WHERE p.tracking_id = d.doc_number AND p.order_id IS NOT NULL)
),
-- counted: THE cohort's booking rows (insights_sale_rows kind 'booking', 20260942001900) —
-- each once, in its folder's department, on its author; the rest of bk is not counted (the copy
-- of a CRM / AlterCPA sale, a 10111 LEADS document, a document whose parcel already exists …)
bkr AS MATERIALIZED (
  SELECT r.sale_day AS day, r.person_id, r.source AS dept, r.value_mkd, r.display_id
  FROM bnd CROSS JOIN LATERAL public.insights_sale_rows(bnd.f, bnd.t, false) r
  WHERE r.kind = 'booking'
)
SELECT 'o' AS part, cr.day::text AS day, cr.pid::text AS pid, cr.dept,
       count(*) FILTER (WHERE cr.in_total) AS sales, coalesce(sum(cr.value_mkd) FILTER (WHERE cr.in_total), 0) AS value_mkd,
       count(*) FILTER (WHERE NOT cr.in_total) AS cas, count(*) FILTER (WHERE cr.in_total AND cr.unstamped) AS live,
       0 AS booked, 0 AS booked_mkd, 0 AS twin, 0 AS worked, 0 AS sale_d
FROM cr GROUP BY 1, 2, 3, 4
UNION ALL
SELECT 'b', b.day::text, b.pid::text, b.dept, 0, 0, 0, 0, sum(b.booked), sum(b.booked_mkd), sum(b.twin), 0, 0
FROM (SELECT bkr.day, bkr.person_id AS pid, bkr.dept, 1 AS booked, bkr.value_mkd AS booked_mkd, 0 AS twin FROM bkr
      UNION ALL
      SELECT bk.day, bk.person_id, bk.dept, 0, 0, 1 FROM bk
       WHERE bk.doc_number NOT IN (SELECT bkr.display_id FROM bkr)) b
GROUP BY b.day, b.pid, b.dept
UNION ALL
SELECT 'w', vw.day::text, vw.person_id::text,
       CASE WHEN o.id IS NOT NULL THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
            WHEN vw.via = 'altercpa' THEN 'altercpa' END,
       0, 0, 0, 0, 0, 0, 0, count(*), count(*) FILTER (WHERE vw.outcome = 'sale')
FROM vw LEFT JOIN public.orders o ON o.id = vw.order_id
GROUP BY 1, 2, 3, 4`;
}

/** Who must be on the board, per day, and who is a manager. */
export function rosterSql(from, to) {
  if (!validYmd(from) || !validYmd(to)) throw new Error('bad window');
  return `
WITH dd AS (
  SELECT g::date AS day,
         (g::date::timestamp AT TIME ZONE 'Europe/Skopje') AS f,
         (((g::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond') AS t
  FROM generate_series('${from}'::date, '${to}'::date, interval '1 day') g
)
SELECT 'member' AS why, dd.day::text AS day, m.person_id::text AS pid
  FROM dd JOIN public.sales_team_members m ON m.valid_from <= dd.day AND coalesce(m.valid_to, 'infinity'::date) >= dd.day
  JOIN public.sales_people sp ON sp.id = m.person_id
 WHERE sp.is_active OR m.valid_to IS NOT NULL
UNION
SELECT 'presence', a.day::text, sp.id::text
  FROM public.agent_presence_days a JOIN public.sales_people sp ON sp.user_id = a.user_id
  JOIN dd ON dd.day = a.day
 WHERE a.online_minutes > 0
UNION
SELECT 'login', dd.day::text, sp.id::text
  FROM dd JOIN public.shift_login_logs s ON s.shift_date = dd.day JOIN public.sales_people sp ON sp.user_id = s.user_id
UNION
SELECT 'login', dd.day::text, sp.id::text
  FROM dd JOIN public.admin_login_logs a ON a.login_time BETWEEN dd.f AND dd.t JOIN public.sales_people sp ON sp.user_id = a.user_id
UNION
SELECT 'manager', NULL, sp.id::text
  FROM public.sales_people sp
 WHERE sp.is_manager OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))`;
}

const FIELDS = ['sales', 'value_mkd', 'cas', 'live', 'booked', 'booked_mkd', 'twin', 'worked', 'sale_d'];
const cellOfBoard = (x) => ({
  sales: n(x.sales), value_mkd: r0(x.value_mkd), cas: n(x.cancelled_after_sale), live: n(x.live_credited),
  booked: n(x.booked), booked_mkd: r0(x.booked_value_mkd), twin: n(x.booked_twin), worked: n(x.worked), sale_d: n(x.sale_decisions),
});

/** The truth rows → Map day|person|dept → cell. */
export function truthMap(rows) {
  const T = new Map();
  for (const r of rows) {
    const k = `${r.day}|${r.pid ?? '-'}|${r.dept}`;
    const e = T.get(k) ?? Object.fromEntries(FIELDS.map((f) => [f, 0]));
    for (const f of FIELDS) e[f] += n(r[f]);
    T.set(k, e);
  }
  for (const e of T.values()) { e.value_mkd = r0(e.value_mkd); e.booked_mkd = r0(e.booked_mkd); }
  return T;
}

/** L1: board vs truth for one day — the mismatching cells. */
export function compareCells(day, doc, T) {
  const B = new Map();
  for (const r of doc.rows ?? []) for (const [d, x] of Object.entries(r.departments ?? {})) B.set(`${day}|${r.person_id}|${d}`, cellOfBoard(x));
  const out = [];
  const keys = new Set([...B.keys(), ...[...T.keys()].filter((k) => k.startsWith(`${day}|`) && !k.includes('|-|'))]);
  for (const k of keys) {
    const b = B.get(k) ?? {};
    const t = T.get(k) ?? {};
    for (const f of FIELDS) if (n(b[f]) !== n(t[f])) out.push({ label: `${k} ${f}`, want: n(t[f]), got: n(b[f]), ok: false });
  }
  // the no-seller cells
  for (const d of DEPARTMENTS) {
    const x = doc.day_totals?.by_department?.[d] ?? {};
    const t = T.get(`${day}|-|${d}`) ?? {};
    const pairs = [['no_seller', n(t.sales), n(x.no_seller)], ['no_seller_value_mkd', n(t.value_mkd), r0(x.no_seller_value_mkd)],
      ['booked_no_person', n(t.booked), n(x.booked_no_person)], ['unmapped_decisions', n(t.worked), n(x.unmapped_decisions)]];
    for (const [f, want, got] of pairs) if (want !== got) out.push({ label: `${day}|no seller|${d} ${f}`, want, got, ok: false });
  }
  return out;
}

/** L3 + L4 on one board document (pure). */
export function structureChecks(doc, managers) {
  const rows = doc.rows ?? [];
  const lines = [];
  const once = new Set(rows.map((r) => r.person_id));
  lines.push(tie('every person is one row', rows.length, once.size));
  for (const d of DEPARTMENTS) {
    const x = doc.day_totals?.by_department?.[d] ?? {};
    lines.push(tie(`${d}: Σ rows' sales = credited`, n(x.credited), rows.reduce((a, r) => a + n(r.departments?.[d]?.sales), 0)));
    lines.push(tie(`${d}: Σ rows' денари = credited денари`, r0(x.credited_value_mkd), rows.reduce((a, r) => a + r0(r.departments?.[d]?.value_mkd), 0)));
    lines.push(tie(`${d}: credited + no seller = sales`, n(x.sales), n(x.credited) + n(x.no_seller)));
  }
  let rowBad = 0;
  for (const r of rows) {
    const cells = Object.values(r.departments ?? {});
    const s = (f) => cells.reduce((a, c) => a + r0(c[f]), 0);
    if (n(r.sales) !== s('sales') || n(r.booked) !== s('booked') || r0(r.value_mkd) !== s('value_mkd')
        || n(r.total_count) !== n(r.sales) + n(r.booked) || r0(r.total_value_mkd) !== r0(r.value_mkd) + r0(r.booked_value_mkd)) rowBad++;
  }
  lines.push(tie('rows whose total ≠ Σ their departments / sales + bookings', 0, rowBad));
  const sum = (f) => rows.reduce((a, r) => a + r0(r[f]), 0);
  for (const f of ['sales', 'booked', 'total_count', 'total_value_mkd', 'worked']) lines.push(tie(`summary.${f} = Σ rows`, r0(doc.summary?.[f]), sum(f)));
  lines.push(tie('summary.people = rows', n(doc.summary?.people), rows.length));

  // L4 rank
  const ranked = rows.filter((r) => r.rank != null);
  lines.push(tie('ranked = non-managers with a total', rows.filter((r) => !r.is_manager && n(r.total_count) > 0).length, ranked.length));
  lines.push(tie('managers ranked', 0, rows.filter((r) => r.is_manager && r.rank != null).length));
  let rankBad = 0;
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    const want = !prev ? 1 : (n(prev.total_value_mkd) === n(r.total_value_mkd) && n(prev.total_count) === n(r.total_count) ? prev.rank : i + 1);
    if (r.rank !== want) rankBad++;
    if (prev && (n(prev.total_value_mkd) < n(r.total_value_mkd)
        || (n(prev.total_value_mkd) === n(r.total_value_mkd) && n(prev.total_count) < n(r.total_count)))) rankBad++;
  });
  lines.push(tie('rank = rank() by денари then count, in order', 0, rankBad));
  const firstMgr = rows.findIndex((r) => r.is_manager);
  lines.push(tie('managers are listed last', true, firstMgr < 0 || rows.slice(firstMgr).every((r) => r.is_manager)));
  const firstUnranked = rows.findIndex((r) => r.rank == null);
  lines.push(tie('ranked people come first', true, firstUnranked < 0 || rows.slice(firstUnranked).every((r) => r.rank == null)));
  if (managers) {
    const wrong = rows.filter((r) => !!r.is_manager !== managers.has(r.person_id)).map((r) => r.name);
    lines.push(tie('is_manager = sales_people.is_manager or an admin / manager role', '', wrong.join(', ')));
  }
  return lines;
}

// ── the run ──────────────────────────────────────────────────────────────────

async function cohortOf(day) {
  const f = `('${day}'::date::timestamp AT TIME ZONE 'Europe/Skopje')`;
  const t = `((('${day}'::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond')`;
  const [r] = await runSql(`SELECT public.insights_cohort(${f}, ${t}, NULL, NULL, NULL, true) AS j`);
  return parseJson(r.j);
}

async function verifyDay(ctx, day) {
  const doc = await board(ctx, day);
  const checks = [];
  const add = (id, title, lines) => checks.push({ id, title, lines, status: lines.every((l) => l.ok) ? 'PASS' : 'FAIL' });

  // L1
  const bad = compareCells(day, doc, ctx.truth);
  add('L1', 'person × department = the truth (orders + v_sales_work + the cohort\'s bookings + collabbox_booked_today)',
    bad.length ? bad : [tie('cells compared', 'all equal', 'all equal')]);

  // L2
  const c = await cohortOf(day);
  const l2 = [];
  for (const s of c.by_source ?? []) {
    const x = doc.day_totals?.by_department?.[s.key] ?? {};
    const ordersValue = (s.splits ?? []).filter((sp) => sp.kind === 'order').reduce((a, sp) => a + n(sp.value_mkd), 0);
    const outs = Object.fromEntries((s.outside ?? []).map((o) => [o.key, n(o.orders ?? o.count)]));
    l2.push(tie(`${s.key}: credited + no seller = cohort orders`, n(s.total?.orders), n(x.credited) + n(x.no_seller)));
    l2.push(tie(`${s.key}: денари = cohort order splits`, r0(ordersValue), r0(x.value_mkd)));
    l2.push(tie(`${s.key}: web shop part`, n(s.total?.web), n(x.web)));
    l2.push(tie(`${s.key}: MEX-only part`, n(s.total?.mex_only), n(x.mex_only)));
    // the collabBox bookings awaiting their parcel (20260942001900): the board counts exactly the
    // cohort's, once (absent on both sides before that migration)
    const bookedValue = (s.splits ?? []).filter((sp) => sp.kind === 'booking').reduce((a, sp) => a + n(sp.value_mkd), 0);
    l2.push(tie(`${s.key}: collabBox bookings = cohort booked part`, n(s.total?.booked), n(x.booked)));
    l2.push(tie(`${s.key}: bookings денари = cohort booking split`, r0(bookedValue), r0(x.booked_value_mkd)));
    l2.push(tie(`${s.key}: cancelled / trashed after the sale`, n(outs.cancelled_after_sale) + n(outs.trashed_after_sale), n(x.cancelled_after_sale)));
  }
  const allOrders = (c.by_source ?? []).reduce((a, s) => a + n(s.total?.orders), 0);
  l2.push(tie('Σ departments = the cohort total orders', n(c.total?.orders), allOrders));
  add('L2', 'Σ board = THE cohort (insights_cohort) per department', l2);

  // L3 + L4
  add('L3', 'once and only once; rank; managers last', structureChecks(doc, ctx.managers));

  // L5
  const onBoard = new Set((doc.rows ?? []).map((r) => r.person_id));
  const need = ctx.roster.filter((x) => x.day === day);
  const missing = need.filter((x) => !onBoard.has(x.pid));
  const credited = [...ctx.truth.keys()].filter((k) => k.startsWith(`${day}|`) && !k.includes('|-|')).map((k) => k.split('|')[1]);
  const missingCredited = [...new Set(credited)].filter((p) => !onBoard.has(p));
  add('L5', 'roster: members, presence / login, everyone credited', [
    tie('team members / presence / logins missing from the board', '', [...new Set(missing.map((x) => `${x.why}:${x.pid}`))].join(', ')),
    tie('people with a truth cell missing from the board', '', missingCredited.join(', ')),
  ]);

  // L6
  const nd = doc.day_totals?.no_department ?? {};
  add('L6', 'safety counters', [
    tie('no department — orders', 0, n(nd.orders)),
    tie('no department — bookings', 0, n(nd.bookings)),
    tie('no department — decisions', 0, n(nd.work)),
    tie('bookings filter drift (vs collabbox_booked_today)', 0, n(doc.day_totals?.checks?.bookings_filter_drift)),
  ]);

  // L7
  if (ctx.filtersDay === day) add('L7', 'filters: department and team views', await filterChecks(ctx, day, doc));

  const nsTot = doc.day_totals?.no_seller ?? {};
  return {
    day,
    headline: {
      people: n(doc.summary?.people), ranked: n(doc.summary?.ranked), managers: n(doc.summary?.managers),
      sales: n(doc.day_totals?.sales), credited: n(doc.day_totals?.credited), live_credited: n(doc.day_totals?.live_credited),
      no_seller: n(nsTot.sales), booked: n(doc.summary?.booked), booked_twin: n(doc.summary?.booked_twin),
      worked: n(doc.day_totals?.worked), value_mkd: r0(doc.day_totals?.value_mkd),
      no_seller_reasons: (nsTot.reasons ?? []).map((r) => `${r.department}/${r.reason}: ${r.count}`),
    },
    checks,
  };
}

/** JS twin of public.sales_team_filter_matches (20260943000950): a key, 'none', or a legacy alias —
 *  altercpa_leads = the old team + affiliate lane in; crm_prediction = the old team + lane out anywhere. */
export function teamFilterMatches(filter, team, lane) {
  if (filter === 'none') return team == null;
  if (filter === 'altercpa_leads') return team === 'altercpa_leads' || (team === 'affiliate' && lane === 'in');
  if (filter === 'crm_prediction') return team === 'crm_prediction' || lane === 'out';
  if (filter.includes(':')) return team === filter.split(':')[0] && lane === filter.split(':')[1];
  return team === filter;
}

async function filterChecks(ctx, day, all) {
  const lines = [];
  const rows = all.rows ?? [];
  for (const d of DEPARTMENTS) {
    const f = await board(ctx, day, d, null);
    const want = rows.filter((r) => {
      const c = r.departments?.[d];
      return c && (n(c.sales) + n(c.cancelled_after_sale) + n(c.booked) + n(c.booked_twin) + n(c.worked)) > 0;
    });
    lines.push(tie(`${d}: the same people`, want.map((r) => r.person_id).sort().join(','), (f.rows ?? []).map((r) => r.person_id).sort().join(',')));
    let diff = 0;
    let work = 0;
    for (const r of f.rows ?? []) {
      const c = rows.find((x) => x.person_id === r.person_id)?.departments?.[d] ?? {};
      if (n(r.sales) !== n(c.sales) || r0(r.value_mkd) !== r0(c.value_mkd) || n(r.booked) !== n(c.booked)) diff++;
      if (Object.keys(r.departments ?? {}).some((k) => k !== d)) diff++;
      // 20260944000600: worked / sale decisions / conversion are that department's too
      if (ctx.deptWork && (n(r.worked) !== n(c.worked) || n(r.sale_decisions) !== n(c.sale_decisions)
          || (n(r.worked) === 0 ? r.conversion != null : Math.abs(n(r.conversion) - n(c.sale_decisions) / n(c.worked)) > 1e-4))) work++;
    }
    lines.push(tie(`${d}: every row = that department's cell`, 0, diff));
    if (ctx.deptWork) lines.push(tie(`${d}: worked / decisions / conversion = that department's`, 0, work));
    lines.push(...structureChecks(f, ctx.managers).filter((l) => /^rank|ranked|managers/.test(l.label)).map((l) => ({ ...l, label: `${d}: ${l.label}` })));
  }
  const teams = [...new Set([...(all.teams ?? []).map((t) => t.key), 'none'])];
  for (const tk of teams) {
    const f = await board(ctx, day, null, tk);
    const want = rows.filter((r) => teamFilterMatches(tk, r.team_key ?? null, r.team_lane ?? null));
    lines.push(tie(`team ${tk}: its badge holders`, want.map((r) => r.person_id).sort().join(','), (f.rows ?? []).map((r) => r.person_id).sort().join(',')));
    let diff = 0;
    for (const r of f.rows ?? []) {
      const u = rows.find((x) => x.person_id === r.person_id) ?? {};
      if (n(r.total_count) !== n(u.total_count) || r0(r.total_value_mkd) !== r0(u.total_value_mkd) || n(r.worked) !== n(u.worked)) diff++;
    }
    lines.push(tie(`team ${tk}: numbers unchanged`, 0, diff));
  }
  return lines;
}

export function parseArgs(argv) {
  const out = { from: null, to: null, json: false, inline: false, filters: true, filtersDay: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--inline') out.inline = true;
    else if (a === '--no-filters') out.filters = false;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--filters-day') out.filtersDay = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  out.to = out.to ?? skopjeToday();
  out.from = out.from ?? addDays(out.to, -6);
  for (const d of [out.from, out.to, out.filtersDay].filter(Boolean)) if (!validYmd(d)) throw new Error(`bad date ${d}`);
  if (out.from > out.to) throw new Error('--from is after --to');
  if (dayRange(out.from, out.to).length > 31) throw new Error('at most 31 days per run');
  out.filtersDay = out.filters ? (out.filtersDay ?? out.to) : null;
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const [live] = await runSql(`SELECT to_regprocedure('${SIG}') IS NOT NULL AS ok,
      to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NOT NULL AS booking_day,
      coalesce((SELECT position('pa.sale_d' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('${SIG}')), false) AS dept_work`);
  const ctx = {
    live: live.ok === true && !args.inline,
    bookingDay: live.booking_day === true,
    deptWork: live.dept_work === true || args.inline,
    migration: readFileSync(MIGRATION, 'utf8'),
    filtersDay: args.filtersDay,
    timings: [],
  };
  const t0 = Date.now();
  ctx.truth = truthMap(await runSql(truthSql(args.from, args.to, { bookingDay: ctx.bookingDay })));
  const rosterRows = await runSql(rosterSql(args.from, args.to));
  ctx.roster = rosterRows.filter((r) => r.why !== 'manager');
  ctx.managers = new Set(rosterRows.filter((r) => r.why === 'manager').map((r) => r.pid));
  const truthMs = Date.now() - t0;
  const results = [];
  for (const day of dayRange(args.from, args.to)) results.push(await verifyDay(ctx, day));
  const fail = results.some((r) => r.checks.some((c) => c.status === 'FAIL'));
  const doc = { mode: ctx.live ? 'rpc' : 'inline', from: args.from, to: args.to, results, timings: ctx.timings, truth_ms: truthMs, status: fail ? 'FAIL' : 'PASS' };
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(`verify-leaderboard-v2 · mode: ${doc.mode} · ${args.from} … ${args.to}`);
    for (const r of results) {
      const h = r.headline;
      console.log(`\n== ${r.day}  people ${h.people} (ranked ${h.ranked}, managers ${h.managers}) · sales ${h.sales} = credited ${h.credited} (live ${h.live_credited}) + no seller ${h.no_seller} · ${h.value_mkd} ден · bookings counted ${h.booked}, not counted ${h.booked_twin} · decisions ${h.worked}`);
      if (h.no_seller_reasons.length) console.log(`   no seller: ${h.no_seller_reasons.join(' · ')}`);
      for (const c of r.checks) {
        console.log(`   ${c.status}  ${c.id}  ${c.title}`);
        for (const l of c.lines.filter((x) => !x.ok).slice(0, 25)) console.log(`          ✗ ${l.label}: want ${l.want}, got ${l.got}`);
      }
    }
    const ms = ctx.timings.map((x) => x.ms);
    console.log(`\ntimings: truth ${truthMs} ms · boards ${ms.length}, median ${ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)] ?? 0} ms, max ${Math.max(0, ...ms)} ms (server round trip)`);
    console.log(`\n${doc.status}`);
  }
  process.exit(fail ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
}
