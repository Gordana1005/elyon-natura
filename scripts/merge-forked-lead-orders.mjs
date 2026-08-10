#!/usr/bin/env node
/**
 * Merge a forked order back into ONE order per customer.
 *
 * The fork bug (fixed 2026-08-11) meant that reaching a customer on the second
 * call created a NEW order instead of completing the lead. The result is two
 * rows per customer: the AlterCPA lead, still open and carrying the ledger
 * sidecar, and a `manual` order carrying the real sale — address, packages,
 * price, the confirming agent.
 *
 * This merges each pair down to ONE order, and the LEAD is always the survivor
 * (operator decision, 2026-08-10). Everything moves onto it: customer, address,
 * delivery method, MEX city, products, quantities, price, the confirming agent
 * and the status — including `shipped` and its shipped_at/waybill. The `manual`
 * copy is then trashed as `duplicate_order`.
 *
 * Call recordings live in `call_logs`; the order-context ones are re-pointed to
 * the lead so the conversation is audible from it. The Calls panel also matches
 * by phone, so nothing is lost either way.
 *
 * Stock is untouched on purpose, and that is correct: stock moves on SHIPPING,
 * which already happened once under the manual order. Re-stamping the same
 * shipped state onto the lead via SQL fires no stock hook, and trashing the
 * copy returns nothing — so the units stay deducted exactly once.
 *
 * `duplicate_order` is HOUSEKEEPING in this market (engine v3.7-mk): it never
 * removes the customer from a calling band and never enters the Trash List. That
 * is exactly what we want for the retired copy.
 *
 * ⚠ ONE THING TO WATCH — a pair that already shipped. The parcel left the
 * warehouse labelled with the MANUAL order's number, and the courier settlement
 * import matches on display_id AND only accepts orders currently
 * `shipped`/`delivered`. After the merge that number belongs to a trashed row,
 * so its line comes back in the sync's `skipped` list — visible, never silently
 * mis-applied. When that happens, mark the LEAD paid instead. Both orders carry
 * a note naming the other so the trail is obvious.
 *
 *   node scripts/merge-forked-lead-orders.mjs                          # find candidates (dry run)
 *   node scripts/merge-forked-lead-orders.mjs --pairs LEAD:ORDER,...   # review a specific plan
 *   node scripts/merge-forked-lead-orders.mjs --pairs LEAD:ORDER --apply
 *
 * ── MACEDONIA NOTES ─────────────────────────────────────────────────────────
 *  1. NO POSTBACK. BG's original ends by saying postbacks are queued. This
 *     project mirrors AlterCPA ONE-WAY — we poll them, nothing goes back
 *     (.grok/skills/elyon-altercpa-bridge, decision #3). Do not add one.
 *  2. The sidecar is `altercpa_leads`, NOT `affiliate_leads` (which is empty).
 *  3. `mex_city_id` / `mex_city_name` are copied too — MK-only address columns
 *     that do not exist in the Bulgarian original.
 *  4. BG hardcoded its five known fork pairs so each merge was reviewable in the
 *     diff. This fork has no known pairs, so the script DISCOVERS candidates and
 *     prints them — but still refuses to write anything without an explicit
 *     --pairs list. Auto-merging orders on a heuristic is not something this
 *     script will ever do.
 *
 * Expected result on this database TODAY: no candidates. That is the point.
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
const cfgRef = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (cfgRef !== EXPECTED_REF) fail(`config.toml project_id = "${cfgRef}", expected "${EXPECTED_REF}"`);

// --pairs LEAD:ORDER,LEAD:ORDER — explicit, reviewable, never inferred at write time.
const pairsArgIdx = process.argv.indexOf('--pairs');
const PAIRS = pairsArgIdx === -1 ? [] : (process.argv[pairsArgIdx + 1] || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => {
    const [lead, order] = s.split(':').map(x => x.trim());
    if (!lead || !order) fail(`bad --pairs entry "${s}", expected LEAD:ORDER`);
    return { lead, order };
  });

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* .env optional */ }
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
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 900)}`);
  return res.json();
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// The parcel is already out under the manual number for these; the merge still
// runs, but the courier settlement will need pointing at the lead by hand.
const SHIPPED_OR_LATER = ['shipped', 'delivered', 'paid', 'returned'];

// ── discovery ──────────────────────────────────────────────────────────────
// An open lead whose customer has a LATER non-lead order that is a real sale.
// Exactly the shape the fork bug produced.
if (PAIRS.length === 0) {
  const found = await q(`
    with open_lead as (
      select id, display_id, customer_name, created_at,
             right(regexp_replace(customer_phone,'\\D','','g'),8) k
      from orders
      where public.is_lead_source(source_type)
        and status in ('pending','take','call_again')
        and duplicated_from is null
    )
    select l.display_id lead, l.customer_name, o.display_id fork, o.status fork_status,
           o.source_type fork_source, o.price::numeric(10,2) fork_price
    from open_lead l
    join orders o
      on right(regexp_replace(o.customer_phone,'\\D','','g'),8) = l.k
     and o.id <> l.id and o.created_at > l.created_at and o.duplicated_from is null
     and o.status in ('confirmed','shipped','delivered','paid','returned')
     and not public.is_lead_source(o.source_type)
    order by l.created_at`);

  console.log(`\nForked lead orders — DISCOVERY  (${EXPECTED_REF})\n`);
  if (found.length === 0) {
    console.log('  No forked pairs found. Nothing to merge.\n');
    console.log('  (This is the expected result — the anti-fork guard means new ones');
    console.log('   cannot be created, and none accumulated here before it shipped.)\n');
    process.exit(0);
  }
  console.log(`  ${found.length} candidate pair(s):\n`);
  for (const r of found) {
    console.log(`  ${r.lead}  ->  ${r.fork} [${r.fork_status} / ${r.fork_source}] ${r.fork_price} · ${r.customer_name}`);
  }
  console.log('\n  Review each one, then re-run with an explicit plan, e.g.:');
  console.log(`    node scripts/merge-forked-lead-orders.mjs --pairs ${found.map(r => `${r.lead}:${r.fork}`).join(',')}\n`);
  process.exit(0);
}

// ── inspect the explicit plan ──────────────────────────────────────────────
const ids = PAIRS.flatMap(p => [p.lead, p.order]).map(lit).join(',');
const rows = await q(`
  select display_id, id, status, source_type, customer_name, quantity,
         price::numeric(10,2) price, assigned_agent_name, confirmed_by_name,
         (select count(*) from order_items i where i.order_id = o.id) items,
         (select count(*) from call_logs c where c.context_id = o.id) calls,
         (select count(*) from altercpa_leads a where a.order_id = o.id) sidecar
  from orders o where display_id in (${ids})`);
const by = Object.fromEntries(rows.map(r => [r.display_id, r]));

const plan = [];
for (const p of PAIRS) {
  const L = by[p.lead], O = by[p.order];
  if (!L || !O) fail(`MISSING ROW for ${p.lead}/${p.order} — aborting.`);
  // The lead always survives. `alreadyShipped` only drives the warning.
  plan.push({ ...p, L, O, alreadyShipped: SHIPPED_OR_LATER.includes(O.status) });
}

console.log(`\nMerge forked lead orders — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${EXPECTED_REF})\n`);
for (const p of plan) {
  console.log(`  ${p.L.customer_name}`);
  console.log(`    lead  ${p.L.display_id} [${p.L.status}] ${p.L.quantity}x €${p.L.price} · sidecar=${p.L.sidecar} · calls=${p.L.calls}`);
  console.log(`    order ${p.O.display_id} [${p.O.status}] ${p.O.quantity}x €${p.O.price} · ${p.O.confirmed_by_name} · items=${p.O.items}`);
  console.log(`    -> everything onto ${p.L.display_id} (status ${p.O.status}); ${p.O.display_id} trashed as duplicate_order`);
  if (p.alreadyShipped) {
    console.log(`    !! ${p.O.display_id} is ${p.O.status}: the parcel left under THAT number. The courier`);
    console.log(`       settlement line for it will land in the sync's "skipped" list — mark`);
    console.log(`       ${p.L.display_id} paid instead when it does.`);
  }
  console.log('');
}

if (!APPLY) { console.log('Dry run — nothing written. Re-run with --apply.\n'); process.exit(0); }

// ── write ──────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
for (const p of plan) {
  const L = lit(p.L.display_id), O = lit(p.O.display_id);
  const sql = `
BEGIN;
-- 1) every customer-facing field, the money and the agent, copied onto the lead
UPDATE public.orders l SET
  customer_name = s.customer_name, customer_phone = s.customer_phone,
  customer_city = s.customer_city, customer_address = s.customer_address,
  street = s.street, street_number = s.street_number, quarter = s.quarter,
  block = s.block, entry = s.entry, floor = s.floor, apartment = s.apartment,
  postal_code = s.postal_code, delivery_type = s.delivery_type,
  home_courier = s.home_courier, courier_office_code = s.courier_office_code,
  courier_office_name = s.courier_office_name, courier_office_city = s.courier_office_city,
  -- MK-only: the resolved MEX Poshta zone travels with the address
  mex_city_id = s.mex_city_id, mex_city_name = s.mex_city_name,
  delivery_instructions = s.delivery_instructions, gift_note = s.gift_note,
  birthday = s.birthday, ship_after_date = s.ship_after_date,
  product_id = s.product_id, product_name = s.product_name,
  quantity = s.quantity, price = s.price,
  status = s.status,
  assigned_agent_id = s.assigned_agent_id, assigned_agent_name = s.assigned_agent_name,
  assigned_at = coalesce(l.assigned_at, s.assigned_at), assigned_by = s.assigned_by,
  confirmed_by_agent_id = s.confirmed_by_agent_id, confirmed_by_name = s.confirmed_by_name,
  confirmed_at = s.confirmed_at,
  -- carry the fulfilment state too, so a lead that was already shipped under the
  -- copy's number reads as shipped here (stock already moved once — see header)
  shipped_at = s.shipped_at, waybill = s.waybill, fulfillment_order_id = s.fulfillment_order_id,
  cancellation_reason = NULL, cancellation_reason_notes = NULL,
  trash_reason = NULL, trash_reason_notes = NULL,
  next_call_after = NULL, call_again_since = NULL,
  updated_at = now()
FROM public.orders s
WHERE l.display_id = ${L} AND s.display_id = ${O};

-- 2) the packages: replace the raw single-unit lead line with the real basket
DELETE FROM public.order_items
 WHERE order_id = (SELECT id FROM public.orders WHERE display_id = ${L});
INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price)
SELECT (SELECT id FROM public.orders WHERE display_id = ${L}),
       i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price
FROM public.order_items i
WHERE i.order_id = (SELECT id FROM public.orders WHERE display_id = ${O});

-- 3) recordings + notes follow the surviving order
UPDATE public.call_logs SET context_id = (SELECT id FROM public.orders WHERE display_id = ${L})
 WHERE context_id = (SELECT id FROM public.orders WHERE display_id = ${O});
UPDATE public.order_notes SET order_id = (SELECT id FROM public.orders WHERE display_id = ${L})
 WHERE order_id = (SELECT id FROM public.orders WHERE display_id = ${O});

INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
SELECT l.id, 'call_again', l.status, l.confirmed_by_agent_id,
       coalesce(l.confirmed_by_name,'System') || ' — order merged in from ' || ${O}
FROM public.orders l WHERE l.display_id = ${L};

INSERT INTO public.order_notes (order_id, text, author_id, author_name)
SELECT l.id, 'Merged from the duplicate order ' || ${O} ||
       ' — address, packages, price and agent copied verbatim. The duplicate was trashed as duplicate_order.',
       l.confirmed_by_agent_id, 'System'
FROM public.orders l WHERE l.display_id = ${L};

-- 4) retire the copy. duplicate_order is housekeeping in engine v3.7-mk: it does
--    not park the customer and does not enter the Trash List.
UPDATE public.orders SET
  status = 'trashed', trash_reason = 'duplicate_order',
  trash_reason_notes = 'Duplicate of ' || ${L} || ' — merged into it on ' || ${lit(today)} || '.',
  assigned_agent_id = NULL, assigned_agent_name = NULL, assigned_at = NULL,
  next_call_after = NULL, call_again_since = NULL, updated_at = now()
WHERE display_id = ${O};

INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
SELECT o.id, ${lit(p.O.status)}, 'trashed', o.confirmed_by_agent_id,
       'System — duplicate merged into ' || ${L}
FROM public.orders o WHERE o.display_id = ${O};

SELECT l.display_id, l.status, l.customer_name, l.customer_city, l.quantity,
       l.price::numeric(10,2) price, l.confirmed_by_name,
       (SELECT count(*) FROM order_items i WHERE i.order_id = l.id) items,
       (SELECT count(*) FROM call_logs c WHERE c.context_id = l.id) calls,
       (SELECT count(*) FROM altercpa_leads a WHERE a.order_id = l.id) sidecar
FROM public.orders l WHERE l.display_id = ${L};
COMMIT;`;

  const res = await q(sql);
  const r = res[res.length - 1] || {};
  console.log(`  merged ${p.L.customer_name}: ${r.display_id} [${r.status}] ${r.quantity}x €${r.price} · ${r.customer_city} · ${r.confirmed_by_name} · items=${r.items} calls=${r.calls} sidecar=${r.sidecar}`);
}
// No postback line here on purpose — see the MACEDONIA NOTES at the top.
console.log('\nDone.\n');
