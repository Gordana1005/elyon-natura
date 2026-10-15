/**
 * verify-hr — READ-ONLY health check of HR (Човечки ресурси, owner 15.10.2026; migration
 * 20261016120000_hr_core.sql).
 *
 *   node scripts/verify-hr.mjs            (text report)
 *   node scripts/verify-hr.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   H1  no shift on an approved absence: an approved request's days hold no shift assignment of
 *       the employee's login (approval removes them, the trigger + shifts_set_cells refuse new ones)
 *   H2  no two open / approved requests of one employee overlap
 *   H3  every active staff login has a dossier row (affiliate-only logins and "ТЕСТ…" excepted) — WARN
 *   H4  holidays: this year and next each hold the state days (≥ 11 with scope all); unverified
 *       (computed / lunar) dates are listed — WARN until HR confirms them
 *   H5  the stages are whole: approved / rejected carry decided_by + decided_at, cancelled carries
 *       cancelled_at, a working-day request has days > 0
 *   H6  balances compute for every active employee this year (info: who has ≤ 0 left, open requests)
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia
 * (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single SELECT /
 * WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const n = (v) => Number(v ?? 0) || 0;
const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    fail(label, detail) { c.lines.push({ label, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, got: detail, ok: true, info: true }); },
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regclass('public.hr_employees') IS NOT NULL AS hr,
           (now() AT TIME ZONE 'Europe/Skopje')::date AS today`);
  if (!have.hr) {
    console.error('verify-hr: hr_employees missing — apply 20261016120000_hr_core.sql first');
    process.exit(2);
  }
  const today = String(have.today).slice(0, 10);
  const year = Number(today.slice(0, 4));

  // H1
  {
    const c = check('H1', 'no shift on an approved absence');
    const rows = await runSql(`
      SELECT e.full_name, sa.shift_date::text AS day, r.type
        FROM hr_leave_requests r
        JOIN hr_employees e ON e.id = r.employee_id AND e.user_id IS NOT NULL
        JOIN shift_assignments sa ON sa.user_id = e.user_id AND sa.shift_date BETWEEN r.date_from AND r.date_to
       WHERE r.status = 'approved'
       ORDER BY 2, 1 LIMIT 50`);
    if (rows.length) c.fail('shifts on approved-absence days', rows.map((r) => `${r.full_name} ${r.day} (${r.type})`).join(', '));
    else c.info('shifts on approved-absence days', 0);
  }
  // H2
  {
    const c = check('H2', 'no overlapping open / approved requests');
    const rows = await runSql(`
      SELECT e.full_name, a.date_from::text AS a_from, a.date_to::text AS a_to, b.date_from::text AS b_from, b.date_to::text AS b_to
        FROM hr_leave_requests a
        JOIN hr_leave_requests b ON b.employee_id = a.employee_id AND b.id > a.id
                                AND b.date_from <= a.date_to AND b.date_to >= a.date_from
        JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.status IN ('pending_team', 'pending_manager', 'approved')
         AND b.status IN ('pending_team', 'pending_manager', 'approved')
       LIMIT 50`);
    if (rows.length) c.fail('overlaps', rows.map((r) => `${r.full_name} ${r.a_from}–${r.a_to} × ${r.b_from}–${r.b_to}`).join(', '));
    else c.info('overlaps', 0);
  }
  // H3
  {
    const c = check('H3', 'every active staff login has a dossier row');
    const rows = await runSql(`
      SELECT p.full_name
        FROM profiles p
       WHERE p.is_active AND p.user_id IS NOT NULL
         AND coalesce(p.full_name, '') NOT ILIKE 'ТЕСТ%'
         AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role <> 'affiliate')
         AND NOT EXISTS (SELECT 1 FROM hr_employees e WHERE e.user_id = p.user_id)
       ORDER BY 1`);
    const [cnt] = await runSql(`
      SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'left') AS left_,
             count(*) FILTER (WHERE status = 'active' AND user_id IS NULL) AS no_login,
             count(*) FILTER (WHERE status = 'active' AND workplace = 'shop') AS shop
        FROM hr_employees`);
    c.info('dossier rows', `${n(cnt.active)} active (${n(cnt.no_login)} without a login, ${n(cnt.shop)} in shops) · ${n(cnt.left_)} left`);
    if (rows.length) c.warn('logins without a dossier row', rows.map((r) => r.full_name).join(', '));
  }
  // H4
  {
    const c = check('H4', 'holidays for this year and next');
    const rows = await runSql(`
      SELECT extract(year FROM date)::int AS y, count(*) FILTER (WHERE scope = 'all') AS state, count(*) AS all_,
             string_agg(CASE WHEN NOT verified THEN to_char(date, 'DD.MM.YYYY') || ' ' || name END, '; ' ORDER BY date) AS unverified
        FROM hr_holidays WHERE extract(year FROM date) IN (${year}, ${year + 1}) GROUP BY 1 ORDER BY 1`);
    for (const y of [year, year + 1]) {
      const r = rows.find((x) => n(x.y) === y);
      if (!r || n(r.state) < 11) c.fail(`${y} state holidays`, r ? n(r.state) : 0);
      else c.info(`${y}`, `${n(r.state)} state · ${n(r.all_)} in all`);
      if (r?.unverified) c.warn(`${y} dates to confirm`, r.unverified);
    }
  }
  // H5
  {
    const c = check('H5', 'the stages are whole');
    const [r] = await runSql(`
      SELECT count(*) FILTER (WHERE status IN ('approved', 'rejected') AND (decided_by IS NULL OR decided_at IS NULL)) AS undecided,
             count(*) FILTER (WHERE status = 'cancelled' AND cancelled_at IS NULL) AS uncancelled,
             count(*) FILTER (WHERE t.day_basis = 'working' AND r.days <= 0) AS zero_days,
             count(*) AS total,
             count(*) FILTER (WHERE status IN ('pending_team', 'pending_manager')) AS open
        FROM hr_leave_requests r JOIN hr_leave_types t ON t.key = r.type`);
    if (n(r.undecided)) c.fail('approved / rejected without a decider', n(r.undecided));
    if (n(r.uncancelled)) c.fail('cancelled without a time', n(r.uncancelled));
    if (n(r.zero_days)) c.fail('working-day requests with 0 days', n(r.zero_days));
    c.info('requests', `${n(r.total)} (${n(r.open)} open)`);
  }
  // H6
  {
    const c = check('H6', `balances ${year}`);
    const rows = await runSql(`
      SELECT b ->> 'employee_id' AS id, (b ->> 'remaining')::numeric AS remaining, (b ->> 'pending')::numeric AS pending
        FROM jsonb_array_elements(hr_balances(${year}, NULL)) b`);
    const [act] = await runSql(`SELECT count(*) AS n FROM hr_employees WHERE status = 'active'`);
    if (rows.length < n(act.n)) c.fail('balances computed', `${rows.length} of ${n(act.n)} active`);
    else c.info('balances computed', rows.length);
    const neg = rows.filter((r) => n(r.remaining) < 0).length;
    if (neg) c.warn('people with a negative balance', neg);
  }

  if (json) { console.log(JSON.stringify({ today, results }, null, 2)); }
  else {
    for (const r of results) {
      console.log(`${r.status.padEnd(5)} ${r.id}  ${r.title}`);
      for (const l of r.lines) console.log(`        ${l.info ? '·' : l.warn ? '!' : '✗'} ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
      console.log('');
    }
  }
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((e) => { console.error('verify-hr:', e.message); process.exit(2); });
