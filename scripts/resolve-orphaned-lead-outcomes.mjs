#!/usr/bin/env node
/**
 * Move a lead's real outcome back onto the lead.
 *
 * Before the 2026-08-11 hardening, the Calls page could not see a lead once it
 * left `pending` (a no-answer moves it to `call_again`), so pressing Confirm /
 * Cancel / Trash created a SECOND order beside it. The lead stayed open forever
 * and the customer looked untouched while they had actually been dealt with.
 *
 * The code fix stops new forks. This script repairs any already out there:
 * every inbound lead still sitting in pending/take/call_again whose customer has
 * a LATER cancelled/trashed order gets that outcome moved onto the lead itself.
 *
 * Everything is copied from the shadow row — reason, note, the agent who
 * decided, and the moment they decided. Nothing is retyped or invented.
 *
 * SOLD leads are never touched: if any later order for that customer is
 * confirmed/shipped/delivered/paid, the lead is listed and skipped, because
 * moving a sale means moving commission (operator decision, 2026-08-10 — those
 * are handled by hand).
 *
 *   node scripts/resolve-orphaned-lead-outcomes.mjs           # dry run (default)
 *   node scripts/resolve-orphaned-lead-outcomes.mjs --apply   # write
 *
 * ── MACEDONIA NOTES ─────────────────────────────────────────────────────────
 * This is a port of the Bulgarian script with two deliberate differences:
 *
 *  1. NO POSTBACK STEP. The BG original ends by reporting the partner stage each
 *     flip queues for delivery. This project mirrors AlterCPA ONE-WAY — we poll
 *     them, nothing goes back (.grok/skills/elyon-altercpa-bridge, decision #3).
 *     `affiliates`, `affiliate_leads` and `affiliate_postbacks` are all empty
 *     and tg_enqueue_affiliate_postback reads affiliate_leads, so no postback is
 *     queued and none should be. Do not add one.
 *  2. Hardcoded MK ref + config.toml tripwire, matching the other MK scripts.
 *     The token in .env can write to Bulgaria too; nothing but this guard stops
 *     it. Europe/Skopje, not Europe/Sofia.
 *
 * Expected result on this database TODAY: nothing to resolve. That is the point
 * — it proves the fork bug never accumulated here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

// Guard: never let this run against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* .env optional when vars are already exported */ }
  return env;
}

const env = loadEnv();
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) fail('SUPABASE_ACCESS_TOKEN missing (set it in .env)');

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 800)}`);
  return res.json();
}

// Candidates + the shadow order that decided each one. `has_win` marks the
// leads a sale is attached to, which we report but never touch.
const CANDIDATES = `
with open_lead as (
  select id, display_id, status, source_type, customer_name, assigned_agent_name, created_at,
         right(regexp_replace(customer_phone,'\\D','','g'),8) k
  from orders
  where public.is_lead_source(source_type)
    and status in ('pending','take','call_again')
    and duplicated_from is null
),
sib as (
  select l.id,
    bool_or(o.status in ('confirmed','shipped','delivered','paid')) as has_win,
    count(*) filter (where o.status in ('cancelled','trashed')) as n_lost
  from open_lead l
  join orders o on right(regexp_replace(o.customer_phone,'\\D','','g'),8) = l.k
   and o.id <> l.id and o.created_at > l.created_at and o.duplicated_from is null
  group by l.id
),
pick as (
  -- the most recent decision wins if the customer was recorded more than once
  select distinct on (l.id) l.id, o.display_id shadow_display, o.status shadow_status,
         coalesce(o.cancellation_reason, o.trash_reason) reason
  from open_lead l
  join orders o on right(regexp_replace(o.customer_phone,'\\D','','g'),8) = l.k
   and o.id <> l.id and o.created_at > l.created_at and o.duplicated_from is null
   and o.status in ('cancelled','trashed')
  order by l.id, o.created_at desc
)
select l.display_id lead, l.status lead_status, l.source_type, l.customer_name,
       coalesce(l.assigned_agent_name,'-') agent,
       to_char(l.created_at at time zone 'Europe/Skopje','DD.MM.YY') lead_created,
       p.shadow_display, p.shadow_status, p.reason, s.has_win
from open_lead l
join sib s on s.id = l.id
left join pick p on p.id = l.id
-- has_win rows are listed even with no lost sibling: the operator must see every
-- lead whose sale landed elsewhere, not just the ones this script could repair.
where s.n_lost > 0 or s.has_win
order by s.has_win, l.created_at`;

// Same selection, then the write. Kept as one transaction so a lead can never
// end up flipped without its history row.
const FLIP = `
BEGIN;

CREATE TEMP TABLE flip_src ON COMMIT DROP AS
with open_lead as (
  select id, display_id, created_at,
         right(regexp_replace(customer_phone,'\\D','','g'),8) k
  from orders
  where public.is_lead_source(source_type)
    and status in ('pending','take','call_again')
    and duplicated_from is null
),
sib as (
  select l.id,
    bool_or(o.status in ('confirmed','shipped','delivered','paid')) as has_win
  from open_lead l
  join orders o on right(regexp_replace(o.customer_phone,'\\D','','g'),8) = l.k
   and o.id <> l.id and o.created_at > l.created_at and o.duplicated_from is null
  group by l.id
)
select distinct on (l.id)
  l.id                       as lead_id,
  s.display_id               as shadow_display,
  s.status                   as new_status,
  s.cancellation_reason,
  s.cancellation_reason_notes,
  s.trash_reason,
  s.trash_reason_notes,
  s.cancelled_at             as shadow_cancelled_at,
  s.trashed_at               as shadow_trashed_at,
  s.cancelled_by_agent_id,
  h.changed_by               as actor_id,
  h.changed_by_name          as actor_name
from open_lead l
join sib sb on sb.id = l.id and sb.has_win = false
join orders s on right(regexp_replace(s.customer_phone,'\\D','','g'),8) = l.k
 and s.id <> l.id and s.created_at > l.created_at and s.duplicated_from is null
 and s.status in ('cancelled','trashed')
join lateral (
  select hh.changed_by, hh.changed_by_name
  from order_history hh where hh.order_id = s.id
  order by hh.changed_at desc limit 1
) h on true
order by l.id, s.created_at desc;

UPDATE public.orders o
   SET status                    = f.new_status,
       cancellation_reason       = f.cancellation_reason,
       cancellation_reason_notes = f.cancellation_reason_notes,
       trash_reason              = f.trash_reason,
       trash_reason_notes        = f.trash_reason_notes,
       cancelled_at              = f.shadow_cancelled_at,
       trashed_at                = f.shadow_trashed_at,
       cancelled_by_agent_id     = f.cancelled_by_agent_id,
       next_call_after           = NULL,
       call_again_since          = NULL,
       updated_at                = now()
  FROM flip_src f
 WHERE o.id = f.lead_id
   AND o.status IN ('pending','take','call_again');

INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
SELECT f.lead_id, 'call_again', f.new_status, f.actor_id,
       f.actor_name || ' — outcome moved back from ' || f.shadow_display
FROM flip_src f;

INSERT INTO public.order_notes (order_id, text, author_id, author_name)
SELECT f.lead_id,
       'Outcome was recorded on the duplicate order ' || f.shadow_display ||
       ' and moved back onto this lead (reason and note copied verbatim).',
       f.actor_id, 'System'
FROM flip_src f;

SELECT o.display_id, o.status, coalesce(o.cancellation_reason, o.trash_reason) reason,
       f.shadow_display
FROM public.orders o JOIN flip_src f ON f.lead_id = o.id
ORDER BY o.display_id;

COMMIT;`;

const rows = await q(CANDIDATES);
const todo = rows.filter(r => !r.has_win);
const skipped = rows.filter(r => r.has_win);

console.log(`\nOrphaned lead outcomes — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${EXPECTED_REF})\n`);
console.log(`  to resolve: ${todo.length}`);
console.log(`  skipped (a sale is attached — handle by hand): ${skipped.length}\n`);

for (const r of todo) {
  console.log(`  ${r.lead} [${r.lead_status}] ${r.lead_created} ${r.source_type} · ${r.agent} · ${r.customer_name}`);
  console.log(`      -> ${r.shadow_display} [${r.shadow_status} / ${r.reason}]`);
}
if (skipped.length) {
  console.log('\n  SKIPPED — the sale is on another order, move it by hand:');
  for (const r of skipped) {
    console.log(`  ${r.lead} [${r.lead_status}] ${r.lead_created} · ${r.agent} · ${r.customer_name}`);
  }
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to resolve them.\n');
  process.exit(0);
}
if (todo.length === 0) {
  console.log('\nNothing to do.\n');
  process.exit(0);
}

const applied = await q(FLIP);
console.log('\nResolved:');
for (const r of applied) {
  console.log(`  ${r.display_id} -> ${r.status} (${r.reason}) from ${r.shadow_display}`);
}
// No postback line here on purpose — see the MACEDONIA NOTES at the top.
console.log('');
