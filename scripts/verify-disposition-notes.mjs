/**
 * verify-disposition-notes — READ-ONLY proof that the written note behind every cancel / trash a
 * PERSON makes holds on the live data (owner 01.10.2026, plan "Фаза 2": "опис од најмалку 5 знаци
 * при откажување или корпа, секаде каде тоа го прави човек"; supabase/functions/api/dispositionNote.ts,
 * app_settings.disposition_note_min — migration 20260944000100).
 *
 *   node scripts/verify-disposition-notes.mjs                       (text report)
 *   node scripts/verify-disposition-notes.mjs --since 2026-10-01T19:00:00Z
 *   node scripts/verify-disposition-notes.mjs --json
 *
 * --since defaults to the moment the setting was switched on (app_settings.updated_at once its value
 * is ≥ 1), else the start of today (Skopje). While the setting is 0 — the rollout window — or for the
 * part of the window before it was switched on, a short note is the BASELINE (WARN), not a FAIL.
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / DB unreachable / bad arguments.
 *
 *   D1  every order now cancelled / trashed whose LAST move into that status since --since was made by
 *       a PERSON carries a note of ≥ min characters (trimmed, whitespace collapsed, Unicode characters
 *       — the api's own count): (a) the move in order_history (changed_by set, not a 'System …'
 *       actor — PATCH status, POST /orders, /calls/outcome, bulk-disposition); (b) a cancel / trash /
 *       wrong-number call log (POST /call-logs, which writes no history row) on an order now in that
 *       status, with no person move in (a)
 *   D2  the system writers keep working WITHOUT a note (they never pass the api): the no-parcel rule's
 *       cancels (no_parcel_7d) and the 9-no-answers auto-trash (not_reachable + the "Auto-trash:" order
 *       note) — counts in the window and in the last 7 days; none in 7 days = WARN (rule silent?)
 *   D3  every /calls outcome row (call_logs source 'handset') for a cancel / trash since --since has
 *       a note of ≥ min characters (the outcome IS the call log; its note = the order's note)
 *   D4  no cancel went through POST /orders/bulk-status-update since --since (audit_log
 *       order.bulk_status_update with new_status 'cancelled' — the path that wrote no reason)
 *   T   timings
 *
 * Note texts are never printed — only lengths, order numbers and who decided.
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) — pinned to
 * Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single
 * SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const CODE_DEFAULT_MIN = 5;

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

/** The api's count: trim, collapse whitespace runs, count characters (dispositionNote.ts). */
const LEN = (col) => `char_length(btrim(regexp_replace(coalesce(${col}, ''), '\\s+', ' ', 'g')))`;

/**
 * A short note found in the window: a FAIL when it was written while the rule was in force
 * (setting ≥ 1 and at / after the switch), else the baseline — a WARN.
 */
function judge(c, label, rows, ctx) {
  const enforced = rows.filter((r) => ctx.enforcedFrom && new Date(r.at) >= ctx.enforcedFrom);
  const baseline = rows.length - enforced.length;
  const sample = (list) => list.slice(0, 15).map((r) => `${r.display_id ?? r.id} ${r.status ?? r.outcome}${r.reason ? `/${r.reason}` : ''} · ${r.who ?? '?'} · ${n(r.len)} chars`);
  c.tie(`${label}: short notes while the rule was in force (min ${ctx.min})`, [], sample(enforced));
  if (baseline > 0) c.warn(`${label}: baseline before the switch (min ${ctx.min}) — ${baseline} short`, sample(rows.filter((r) => !enforced.includes(r))).join(' | '));
}

// ── D1: a person's cancel / trash carries the note ─────────────────────────────
async function verifyPersonMoves(ctx) {
  const c = check('D1', `every cancel / trash a PERSON made since ${ctx.since} carries a note of ≥ ${ctx.min} characters`);
  const rows = await timed('D1 order_history', `
    WITH s AS (SELECT ${lit(ctx.since)}::timestamptz AS t),
    moves AS (
      SELECT DISTINCT ON (o.id)
             o.id, o.display_id, o.status::text AS status, h.changed_at AS at, h.changed_by, h.changed_by_name,
             CASE WHEN o.status::text = 'cancelled' THEN o.cancellation_reason ELSE o.trash_reason END AS reason,
             ${LEN(`CASE WHEN o.status::text = 'cancelled' THEN o.cancellation_reason_notes ELSE o.trash_reason_notes END`)} AS len
        FROM public.order_history h
        JOIN public.orders o ON o.id = h.order_id
       WHERE h.changed_at >= (SELECT t FROM s)
         AND h.to_status::text IN ('cancelled', 'trashed')
         AND h.from_status IS DISTINCT FROM h.to_status
         AND o.status::text = h.to_status::text
       ORDER BY o.id, h.changed_at DESC, h.id DESC
    )
    SELECT id, display_id, status, reason, at, len,
           coalesce(changed_by_name, '') AS who,
           (changed_by IS NOT NULL AND coalesce(changed_by_name, '') NOT LIKE 'System%') AS person
      FROM moves
     ORDER BY at`);
  const person = rows.filter((r) => r.person === true);
  const system = rows.length - person.length;
  const short = person.filter((r) => n(r.len) < ctx.min);
  c.info('(a) moves into cancelled / trashed (order_history, current status)', { total: rows.length, by_person: person.length, by_system: system });
  c.info('(a) by a person — by status', {
    cancelled: person.filter((r) => r.status === 'cancelled').length,
    trashed: person.filter((r) => r.status === 'trashed').length,
    with_note_ok: person.length - short.length,
  });
  judge(c, '(a)', short, ctx);

  const calls = await timed('D1 call_logs', `
    WITH s AS (SELECT ${lit(ctx.since)}::timestamptz AS t)
    SELECT DISTINCT ON (o.id)
           o.id, o.display_id, o.status::text AS status, l.outcome, l.created_at AS at,
           CASE WHEN o.status::text = 'cancelled' THEN o.cancellation_reason ELSE o.trash_reason END AS reason,
           ${LEN(`CASE WHEN o.status::text = 'cancelled' THEN o.cancellation_reason_notes ELSE o.trash_reason_notes END`)} AS len,
           coalesce(p.full_name, l.agent_id::text) AS who
      FROM public.call_logs l
      JOIN public.orders o ON o.id = l.context_id
      LEFT JOIN public.profiles p ON p.user_id = l.agent_id
     WHERE l.created_at >= (SELECT t FROM s)
       AND l.context_type = 'order'
       AND l.source IS DISTINCT FROM 'handset'
       AND l.outcome IN ('cancelled', 'trash', 'wrong_number')
       AND o.status::text = CASE WHEN l.outcome = 'cancelled' THEN 'cancelled' ELSE 'trashed' END
       AND NOT EXISTS (
         SELECT 1 FROM public.order_history h
          WHERE h.order_id = o.id AND h.changed_at >= (SELECT t FROM s)
            AND h.to_status::text = o.status::text AND h.from_status IS DISTINCT FROM h.to_status
            AND h.changed_by IS NOT NULL AND coalesce(h.changed_by_name, '') NOT LIKE 'System%')
     ORDER BY o.id, l.created_at DESC`);
  const shortCalls = calls.filter((r) => n(r.len) < ctx.min);
  c.info('(b) moves by an in-call log (POST /call-logs, no history row)', { total: calls.length, with_note_ok: calls.length - shortCalls.length });
  judge(c, '(b)', shortCalls, ctx);
}

// ── D2: the system writers still work without a note ───────────────────────────
async function verifySystemWriters(ctx) {
  const c = check('D2', 'the system writers keep working without a note (no-parcel cancel, 9-no-answers auto-trash)');
  const [r] = await timed('D2', `
    WITH s AS (SELECT ${lit(ctx.since)}::timestamptz AS t, now() - interval '7 days' AS week)
    SELECT
      count(*) FILTER (WHERE o.status::text = 'cancelled' AND o.cancellation_reason = 'no_parcel_7d' AND o.cancelled_at >= s.t) AS np_window,
      count(*) FILTER (WHERE o.status::text = 'cancelled' AND o.cancellation_reason = 'no_parcel_7d' AND o.cancelled_at >= s.week) AS np_week,
      count(*) FILTER (WHERE o.status::text = 'cancelled' AND o.cancellation_reason = 'no_parcel_7d' AND o.cancelled_at >= s.week
                         AND ${LEN('o.cancellation_reason_notes')} > 0) AS np_week_with_note,
      count(*) FILTER (WHERE x.auto_trash AND o.trashed_at >= s.t) AS at_window,
      count(*) FILTER (WHERE x.auto_trash AND o.trashed_at >= s.week) AS at_week
      FROM public.orders o
      CROSS JOIN s
      -- The auto-trash writes no order_history row (index.ts applyNoAnswerLifecycle): a not_reachable
      -- trash with no PERSON move into trashed is the rule's.
      CROSS JOIN LATERAL (
        SELECT (o.status::text = 'trashed' AND o.trash_reason = 'not_reachable'
                AND NOT EXISTS (SELECT 1 FROM public.order_history h
                                 WHERE h.order_id = o.id AND h.to_status::text = 'trashed'
                                   AND h.changed_by IS NOT NULL AND coalesce(h.changed_by_name, '') NOT LIKE 'System%')) AS auto_trash
      ) x
     WHERE (o.cancelled_at >= s.week OR o.trashed_at >= s.week)`);
  c.info('no-parcel rule (no_parcel_7d) cancels', { since: n(r.np_window), last_7_days: n(r.np_week), last_7_days_with_a_note: n(r.np_week_with_note) });
  c.info('auto-trash (not_reachable, no person in the history)', { since: n(r.at_window), last_7_days: n(r.at_week) });
  if (n(r.np_week) === 0) c.warn('no-parcel rule', 'no cancel in the last 7 days — is the 21:10 cron running?');
  // Found 01.10.2026: applyNoAnswerLifecycle selects / writes orders.notes, a column the MK orders
  // table does not have, so its order write fails silently (0 such trashes in 30 days). Not a
  // regression of the note rule — the auto-trash never passes it. Reported to the owner.
  if (n(r.at_week) === 0) c.warn('auto-trash', 'no auto-trash order in the last 7 days — the 9-no-answers write targets orders.notes, which does not exist on MK (pre-existing, owner to decide)');
}

// ── D3: the /calls outcome rows ───────────────────────────────────────────────
async function verifyHandsetRows(ctx) {
  const c = check('D3', `every /calls cancel / trash row (call_logs source 'handset') since ${ctx.since} has a note of ≥ ${ctx.min} characters`);
  const rows = await timed('D3', `
    SELECT l.id, o.display_id, l.outcome, l.created_at AS at, ${LEN('l.notes')} AS len,
           coalesce(p.full_name, l.agent_id::text) AS who
      FROM public.call_logs l
      LEFT JOIN public.orders o ON o.id = l.context_id
      LEFT JOIN public.profiles p ON p.user_id = l.agent_id
     WHERE l.created_at >= ${lit(ctx.since)}::timestamptz
       AND l.source = 'handset'
       AND l.outcome IN ('cancelled', 'trash')
     ORDER BY l.created_at`);
  const short = rows.filter((r) => n(r.len) < ctx.min);
  c.info('rows', { total: rows.length, cancelled: rows.filter((r) => r.outcome === 'cancelled').length, trash: rows.filter((r) => r.outcome === 'trash').length, with_note_ok: rows.length - short.length });
  judge(c, 'handset rows', short, ctx);
}

// ── D4: no cancel through bulk-status-update ───────────────────────────────────
async function verifyNoBulkStatusCancel(ctx) {
  const c = check('D4', `no cancel through POST /orders/bulk-status-update since ${ctx.since}`);
  const [r] = await timed('D4', `
    SELECT count(*) FILTER (WHERE a.created_at >= ${lit(ctx.since)}::timestamptz) AS calls_window,
           coalesce(sum(n_orders) FILTER (WHERE a.created_at >= ${lit(ctx.since)}::timestamptz), 0) AS orders_window,
           count(*) AS calls_ever,
           coalesce(sum(n_orders), 0) AS orders_ever,
           max(a.created_at) AS last_at
      FROM (SELECT created_at, CASE WHEN payload->>'count' ~ '^[0-9]+$' THEN (payload->>'count')::int ELSE 0 END AS n_orders
              FROM public.audit_log
             WHERE action = 'order.bulk_status_update' AND payload->>'new_status' = 'cancelled') a`);
  c.tie('bulk-status-update cancels in the window (calls, orders)', [0, 0], [n(r.calls_window), n(r.orders_window)]);
  c.info('ever (before the route refused it)', { calls: n(r.calls_ever), orders: n(r.orders_ever), last: r.last_at ?? null });
}

async function main() {
  const json = process.argv.includes('--json');
  const si = process.argv.indexOf('--since');
  const sinceArg = si > 0 ? process.argv[si + 1] : null;
  if (si > 0 && (!sinceArg || Number.isNaN(new Date(sinceArg).getTime()))) {
    console.error('verify-disposition-notes: --since <ISO timestamp>, e.g. 2026-10-01T19:00:00Z');
    process.exit(2);
  }
  const [cfg] = await runSql(`
    SELECT (SELECT value FROM public.app_settings WHERE key = 'disposition_note_min') AS value,
           (SELECT updated_at FROM public.app_settings WHERE key = 'disposition_note_min') AS updated_at,
           (date_trunc('day', now() AT TIME ZONE 'Europe/Skopje') AT TIME ZONE 'Europe/Skopje') AS today_start`);
  const raw = cfg?.value;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : null;
  const setting = raw == null ? null : parsed;
  // What the api enforces: missing / invalid = 5 (dispositionNote.ts parseNoteMin).
  const inForce = setting == null || setting > 50 ? CODE_DEFAULT_MIN : setting;
  const enforcedFrom = inForce >= 1
    ? (raw == null ? new Date(0) : new Date(cfg.updated_at))
    : null;
  const since = sinceArg ? new Date(sinceArg).toISOString()
    : enforcedFrom && raw != null ? enforcedFrom.toISOString()
      : new Date(cfg.today_start).toISOString();
  // The bar every check measures against: the rule's minimum (5), even during the window.
  const ctx = { since, min: inForce >= 1 ? inForce : CODE_DEFAULT_MIN, enforcedFrom };

  await verifyPersonMoves(ctx);
  await verifySystemWriters(ctx);
  await verifyHandsetRows(ctx);
  await verifyNoBulkStatusCancel(ctx);

  const fail = results.some((c) => c.status === 'FAIL');
  const settingLine = raw == null
    ? 'app_settings.disposition_note_min missing — the api enforces 5'
    : `app_settings.disposition_note_min = ${JSON.stringify(raw)}${inForce >= 1 ? ` (in force since ${enforcedFrom.toISOString()})` : ' (ROLLOUT WINDOW — notes not enforced yet; short notes are the baseline)'}`;
  if (json) {
    console.log(JSON.stringify({
      tool: 'verify-disposition-notes', read_only: true, generated_at: new Date().toISOString(),
      since, setting: raw ?? null, min: ctx.min, enforced_from: enforcedFrom?.toISOString() ?? null,
      status: fail ? 'FAIL' : 'PASS', results, timings,
    }, null, 2));
  } else {
    console.log(`verify-disposition-notes · read-only · Macedonia · since ${since}`);
    console.log(settingLine);
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-disposition-notes error: ${e?.message ?? e}`); process.exit(2); });
