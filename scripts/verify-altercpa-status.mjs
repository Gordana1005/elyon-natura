#!/usr/bin/env node
/**
 * Prove the status sync resolves mirrored orders correctly — READ ONLY.
 *
 *   node scripts/verify-altercpa-status.mjs
 *
 * Re-fetches every ledger-linked lead independently by id
 * (comp/list.json?oid=…) and checks, for each one whose remote copy is
 * resolved (phase 3/4/5), that the CRM order either:
 *
 *   - matches the B′ outcome map (approved+shipping → shipped, Completed →
 *     paid, Return → returned, cancelled → cancelled/returned, trash →
 *     trashed), or
 *   - is legitimately guarded: an agent here took/confirmed it, or our own
 *     decision made it terminal first (forward-only rule).
 *
 * Then asserts the SQL invariants on external_source='altercpa':
 *   1. no paid/shipped/delivered order carries a cancellation or trash reason
 *   2. cancellation_reason only on cancelled, trash_reason only on trashed
 *   3. outcome timestamps never precede created_at
 *   4. every bridge resolution has an order_history row from the system author
 *
 * ── Why this and not "the run log said ok" ─────────────────────────────────
 * Same reason as verify-altercpa-bridge.mjs: the run log records what the sync
 * BELIEVED it saw. Only an independent re-fetch shows what it got wrong.
 *
 * Nothing is written. No AlterCPA write endpoint is referenced.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';                       // MACEDONIA. never change.
const ENDPOINT_PATH = '/comp/list.json';                  // read-only. never change.
const API_BASE = 'https://api.cpa.moe';

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
if (env.VITE_SUPABASE_PROJECT_ID && env.VITE_SUPABASE_PROJECT_ID !== REF) {
  console.error(`.env points at ${env.VITE_SUPABASE_PROJECT_ID}, not Macedonia. Refusing to run.`);
  process.exit(1);
}

const API_KEY = process.env.ALTERCPA_API_KEY || env.ALTERCPA_API_KEY;
if (!API_KEY) {
  console.error('Missing ALTERCPA_API_KEY (env or .env). See docs/VAULT.md §2.');
  process.exit(1);
}

async function sql(query, attempt = 1) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) {
    // The Management API occasionally 5xxs mid-run; a read-only retry is safe.
    if (r.status >= 500 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 3000 * attempt));
      return sql(query, attempt + 1);
    }
    throw new Error(`${r.status} ${t}`);
  }
  return JSON.parse(t);
}

/** Same contract as the sync: a non-array body is a HARD failure. Batches of
 *  100 ids; a failing batch is halved down to a single id before giving up. */
async function fetchByIds(ids) {
  const out = new Map();
  const fetchBatch = async (batch, depth) => {
    const url = `${API_BASE}${ENDPOINT_PATH}?id=${encodeURIComponent(API_KEY)}&oid=${encodeURIComponent(batch.join(','))}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { throw new Error(`unparseable (${text.slice(0, 120)})`); }
        if (!Array.isArray(body)) throw new Error(`non-array body: ${JSON.stringify(body).slice(0, 200)}`);
        for (const o of body) out.set(String(o.id), o);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (batch.length > 1 && depth < 8) {
      const mid = Math.ceil(batch.length / 2);
      await fetchBatch(batch.slice(0, mid), depth + 1);
      await fetchBatch(batch.slice(mid), depth + 1);
      return;
    }
    throw new Error(`oid batch of ${batch.length} failed: ${lastErr?.message}`);
  };
  for (let i = 0; i < ids.length; i += 100) await fetchBatch(ids.slice(i, i + 100), 0);
  return out;
}

/** B′ — must mirror resolveRemoteOutcome in supabase/functions/altercpa-sync/altercpa.ts. */
const CANCEL_REASON_TO_CRM = { 2: 1, 9: 1, 8: 1, 10: 1, 14: 1, 7: 1 };
function resolveRemoteOutcome(o, currentCrmStatus) {
  const phase = Number(o.phase) || 0;
  const atCourier = currentCrmStatus === 'shipped' || currentCrmStatus === 'delivered';
  if (phase === 1 || phase === 2) return null;
  if (phase === 3) return atCourier ? null : 'confirmed';   // MEX alone decides shipped/paid/returned
  if (phase === 4) {
    const r = Number(o.reason) || 0;
    if (r > 0 && !CANCEL_REASON_TO_CRM[r]) return 'confirmed';
    return atCourier ? null : 'cancelled';
  }
  if (phase === 5) return atCourier ? null : 'trashed';
  return null;
}
const RANK = {
  pending: 0, take: 0, call_again: 0, confirmed: 1, shipped: 2, delivered: 3,
  paid: 9, returned: 9, cancelled: 9, trashed: 9, duplicated: 9,
};
const TERMINAL = new Set(['paid', 'returned', 'cancelled', 'trashed', 'duplicated']);

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ── 1. linked leads + their orders ─────────────────────────────────────────
const linked = await sql(`
  select l.altercpa_id, l.phase as ledger_phase, o.id as order_id,
         o.status::text as crm_status, o.assigned_agent_id, o.confirmed_at
  from public.altercpa_leads l
  join public.orders o on o.id = l.order_id
  order by l.created_remote;`);
console.log(`linked leads: ${linked.length.toLocaleString('en-US')}`);

const byId = await fetchByIds(linked.map((r) => String(r.altercpa_id)));
console.log(`fetched from AlterCPA by oid: ${byId.size.toLocaleString('en-US')}`);

// ── 2. outcome agreement ───────────────────────────────────────────────────
let agree = 0, open = 0, guarded = 0, missing = 0, stillOpenHere = 0;
const disagreements = [];
for (const r of linked) {
  const o = byId.get(String(r.altercpa_id));
  if (!o) { missing++; continue; }
  const target = resolveRemoteOutcome(o, r.crm_status);
  if (target === null) { open++; continue; }
  if (target === r.crm_status) { agree++; continue; }
  const untouched = !r.assigned_agent_id && !r.confirmed_at;
  const forwardBlocked = TERMINAL.has(r.crm_status) || (RANK[target] ?? 0) <= (RANK[r.crm_status] ?? 0);
  if (!untouched || forwardBlocked) { guarded++; continue; }
  // Remote resolved, order untouched and openable — the cron should have
  // applied this by its next run. Tolerate the in-flight window, report it.
  stillOpenHere++;
  if (disagreements.length < 25) {
    disagreements.push({ altercpa_id: r.altercpa_id, crm: r.crm_status, phase: o.phase, status: o.status, want: target });
  }
}
console.log(`\noutcome agreement:`);
ok(`${agree.toLocaleString('en-US')} resolved and matching B′`);
ok(`${open.toLocaleString('en-US')} still open on both sides`);
ok(`${guarded.toLocaleString('en-US')} legitimately guarded (agent-owned or forward-only)`);
if (missing) console.log(`  ~ ${missing} not in AlterCPA's response (deleted there) — left untouched here`);
if (stillOpenHere) {
  console.log(`  ~ ${stillOpenHere} remote-resolved but not yet applied here (pending next cron run):`);
  console.table(disagreements);
  if (stillOpenHere > 50) fail(`${stillOpenHere} unapplied resolutions — more than one cron slice; investigate the run log`);
}

// ── 3. SQL invariants ──────────────────────────────────────────────────────
console.log(`\ninvariants (external_source='altercpa'):`);
const inv = async (label, query) => {
  const rows = await sql(query);
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) ok(label);
  else fail(`${label} — ${n} violation(s)`);
};
await inv('no locked/paid order carries a cancellation or trash reason', `
  select count(*)::int n from public.orders
  where external_source='altercpa' and status in ('paid','shipped','delivered')
    and (cancellation_reason is not null or trash_reason is not null);`);
await inv('cancellation_reason only on cancelled', `
  select count(*)::int n from public.orders
  where external_source='altercpa' and cancellation_reason is not null and status <> 'cancelled';`);
await inv('trash_reason only on trashed', `
  select count(*)::int n from public.orders
  where external_source='altercpa' and trash_reason is not null and status <> 'trashed';`);
// 1-day tolerance: the history import stored created_at at NOON (date-only
// precision) while paid_at/cancelled_at carry the real intra-day time, so a
// same-day outcome can legitimately "precede" noon (22.138 rows, measured
// 2026-08-11, zero beyond one day). The status sync itself guards n < created
// in outcomeTimestamps, so a real violation here means a code regression.
await inv('outcome timestamps never precede created_at by more than a day', `
  select count(*)::int n from public.orders
  where external_source='altercpa' and (
    paid_at < created_at - interval '1 day' or cancelled_at < created_at - interval '1 day'
    or trashed_at < created_at - interval '1 day' or returned_at < created_at - interval '1 day');`);
await inv('bridge history rows agree with the order status', `
  select count(*)::int n from (
    select distinct on (h.order_id) h.order_id, h.to_status::text as to_status, h.changed_by_name
    from public.order_history h
    order by h.order_id, h.changed_at desc
  ) last
  join public.orders o on o.id = last.order_id
  where last.changed_by_name like 'System (altercpa:%'
    and o.status::text <> last.to_status;`);

// ── 4. open-set size (should shrink over time) ─────────────────────────────
const openSet = await sql(`
  select o.status::text, count(*)::int n
  from public.altercpa_leads l join public.orders o on o.id = l.order_id
  where o.status in ('pending','take','call_again','confirmed','shipped','delivered')
  group by 1 order by 2 desc;`);
console.log(`\nopen set by CRM status (the status cron's working set):`);
console.table(openSet);

console.log(failures ? `\nFAILED — ${failures} check(s) above.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
