/**
 * verify-shifts — READ-ONLY health check of the shift roster, which is the LOGIN GATE here
 * (GET /shifts/check-login refuses every non-admin/manager with no shift covering "now";
 * owner kept it 30.09.2026). Plan Фаза 8, migrations 20260943000100 / 1000 / 1100.
 *
 *   node scripts/verify-shifts.mjs                 (text report, the current Skopje month)
 *   node scripts/verify-shifts.mjs --month=2026-10
 *   node scripts/verify-shifts.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   S1  runway ≥ 5 days: shifts_runway(5) names nobody (every active gated agent who worked in
 *       the last 14 days has a shift at least 5 days ahead) — else they are locked out soon
 *   S2  one shift per person per day: no double-booked person-days, UNIQUE (user_id, shift_date)
 *       in place, shift_assignments.shift_date = shifts.date everywhere
 *   S3  no window ends before it starts (CHECK shifts_window_check present and validated)
 *   S4  login history survives deletes: shift_login_logs.shift_id is ON DELETE SET NULL (not
 *       CASCADE), no log points at a shift of another day
 *   S5  the month's roster is present: shifts on every day of the month, and every agent of the
 *       runway population has ≥ 20 days in it (Mon–Fri people get ~22) — fewer is a WARN
 *   S6  today: how many gated agents are inside / outside their window right now (info)
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia
 * (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single SELECT /
 * WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const n = (v) => Number(v ?? 0) || 0;

const results = [];
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

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regprocedure('public.shifts_runway(integer)') IS NOT NULL AS runway,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'shift_assignments' AND column_name = 'shift_date') AS shift_date,
           (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
           to_char(now() AT TIME ZONE 'Europe/Skopje', 'HH24:MI') AS now_hm`);
  if (!have.runway) {
    console.error('verify-shifts: shifts_runway() missing — apply 20260943000100 first');
    process.exit(2);
  }
  const today = String(have.today).slice(0, 10);
  const month = /^\d{4}-\d{2}$/.test(arg('month') ?? '') ? arg('month') : today.slice(0, 7);

  // S1 runway — shifts_runway(5)'s rule, recounted in plain SQL (the read-only role may not
  // execute the service-role function)
  {
    const c = check('S1', 'runway: nobody runs out of shifts within 5 days');
    const rows = await runSql(`
      WITH agents AS (
        SELECT DISTINCT p.user_id, p.full_name
          FROM profiles p
          JOIN shift_assignments sa ON sa.user_id = p.user_id
          JOIN shifts s ON s.id = sa.shift_id
         WHERE p.is_active
           AND s.date BETWEEN DATE '${today}' - 14 AND DATE '${today}'
           AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
      )
      SELECT a.full_name AS name,
             (SELECT max(s.date) FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
               WHERE sa.user_id = a.user_id AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')) AS last_date
        FROM agents a
       ORDER BY 2 NULLS FIRST, 1`);
    const warnBy = new Date(Date.parse(`${today}T00:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10);
    const out = rows.filter((r) => !r.last_date || String(r.last_date).slice(0, 10) < warnBy);
    c.info('agents (active, gated, worked in the last 14 days)', rows.length);
    c.info('earliest last shift of anyone', rows[0]?.last_date ? String(rows[0].last_date).slice(0, 10) : '—');
    if (out.length) c.fail('running out', out.map((p) => `${p.name} (${p.last_date ? String(p.last_date).slice(0, 10) : 'none'})`).join(', '));
    else c.tie('running out within 5 days', 0, 0);
  }

  // S2 one shift per person-day
  {
    const c = check('S2', 'one shift per person per day');
    const [row] = await runSql(`
      SELECT (SELECT count(*) FROM (SELECT sa.user_id, s.date FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
                                    GROUP BY 1, 2 HAVING count(*) > 1) z) AS doubles,
             EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shift_assignments_user_day_key') AS unique_key
             ${have.shift_date ? `, (SELECT count(*) FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id WHERE sa.shift_date <> s.date) AS date_mismatch` : ''}`);
    c.tie('double-booked person-days', 0, n(row.doubles));
    c.tie('UNIQUE (user_id, shift_date)', true, row.unique_key);
    if (have.shift_date) c.tie('shift_date ≠ shifts.date', 0, n(row.date_mismatch));
    else c.fail('shift_assignments.shift_date', 'missing — apply 20260943001000');
  }

  // S3 windows
  {
    const c = check('S3', 'no window ends before it starts');
    const [row] = await runSql(`
      SELECT (SELECT count(*) FROM shifts WHERE NOT (end_time > start_time OR (start_time = '00:00' AND end_time = '00:00'))) AS bad,
             (SELECT convalidated FROM pg_constraint WHERE conname = 'shifts_window_check') AS validated`);
    c.tie('shifts with end ≤ start', 0, n(row.bad));
    c.tie('CHECK shifts_window_check validated', true, row.validated === true);
  }

  // S4 login history
  {
    const c = check('S4', 'login history survives a deleted shift');
    const [row] = await runSql(`
      SELECT (SELECT confdeltype FROM pg_constraint WHERE conname = 'shift_login_logs_shift_id_fkey') AS on_delete,
             (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public'
                 AND table_name = 'shift_login_logs' AND column_name = 'shift_id') AS nullable,
             (SELECT count(*) FROM shift_login_logs) AS logs,
             (SELECT count(*) FROM shift_login_logs WHERE shift_id IS NULL) AS detached,
             (SELECT count(*) FROM shift_login_logs l JOIN shifts s ON s.id = l.shift_id WHERE s.date <> l.shift_date) AS wrong_day,
             (SELECT count(*) FROM shift_login_logs WHERE logout_time IS NOT NULL) AS with_logout`);
    c.tie('FK on delete (n = SET NULL, c = CASCADE)', 'n', row.on_delete);
    c.tie('shift_id nullable', 'YES', row.nullable);
    c.tie('logs pointing at a shift of another day', 0, n(row.wrong_day));
    c.info('login logs', n(row.logs));
    c.info('logs whose shift was deleted (kept, shift_id NULL)', n(row.detached));
    c.info('logs with a logout time (recorded since 01.10.2026)', n(row.with_logout));
  }

  // S5 the month's roster
  {
    const c = check('S5', `the ${month} roster is present`);
    const from = `${month}-01`;
    const rows = await runSql(`
      WITH m AS (SELECT DATE '${from}' AS f, (DATE '${from}' + interval '1 month' - interval '1 day')::date AS t),
      pop AS (
        SELECT DISTINCT p.user_id, p.full_name
          FROM profiles p
          JOIN shift_assignments sa ON sa.user_id = p.user_id
          JOIN shifts s ON s.id = sa.shift_id
         WHERE p.is_active
           AND s.date BETWEEN DATE '${today}' - 14 AND DATE '${today}'
           AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
      )
      SELECT 'days' AS k, NULL::text AS name,
             (SELECT count(DISTINCT s.date) FROM shifts s, m WHERE s.date BETWEEN m.f AND m.t
                 AND EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.shift_id = s.id)) AS n,
             (SELECT (m.t - m.f + 1) FROM m) AS of
      UNION ALL
      SELECT 'person', pop.full_name,
             (SELECT count(*) FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id, m
               WHERE sa.user_id = pop.user_id AND s.date BETWEEN m.f AND m.t
                 AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')),
             NULL
        FROM pop`);
    const days = rows.find((r) => r.k === 'days');
    c.tie('days of the month with shifts', n(days?.of), n(days?.n));
    const people = rows.filter((r) => r.k === 'person');
    c.info('agents in the runway population', people.length);
    c.info('person-days in the month', people.reduce((s, r) => s + n(r.n), 0));
    const thin = people.filter((r) => n(r.n) < 20).map((r) => `${r.name} (${n(r.n)})`);
    if (thin.length) c.warn('agents with < 20 days this month', thin.join(', '));
  }

  // S6 today
  {
    const c = check('S6', `today ${today} at ${have.now_hm} (Skopje)`);
    const [row] = await runSql(`
      WITH g AS (
        SELECT p.user_id,
               bool_or(NOT (s.start_time = '00:00' AND s.end_time = '00:00')
                       AND to_char(s.start_time, 'HH24:MI') <= '${have.now_hm}' AND to_char(s.end_time, 'HH24:MI') >= '${have.now_hm}') AS inside,
               count(s.id) AS n
          FROM profiles p
          LEFT JOIN shift_assignments sa ON sa.user_id = p.user_id
          LEFT JOIN shifts s ON s.id = sa.shift_id AND s.date = DATE '${today}'
         WHERE p.is_active
           AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
         GROUP BY 1)
      SELECT count(*) FILTER (WHERE inside) AS may_log_in,
             count(*) FILTER (WHERE n > 0 AND NOT COALESCE(inside, false)) AS outside_window,
             count(*) FILTER (WHERE n = 0) AS no_shift_today
        FROM g`);
    c.info('gated agents who may log in now', n(row.may_log_in));
    c.info('with a shift today, outside its window now', n(row.outside_window));
    c.info('with no shift today', n(row.no_shift_today));
  }

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-shifts', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results }, null, 2));
  } else {
    console.log('verify-shifts · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: ${l.want == null ? l.got : `want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`}`);
      }
    }
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-shifts error: ${e?.message ?? e}`); process.exit(2); });
