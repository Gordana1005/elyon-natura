#!/usr/bin/env node
/**
 * scripts/history/gen_history_lead_links_migration.mjs — generate the migration that applies the owner's phone + date
 * law (public.link_lead_parcels_plan / link_lead_parcels, 01.10.2026) to the HISTORY parcels of mex_history_stage.
 *
 * The two history functions are the LIVE bodies with three surgical replacements, so the rules cannot drift:
 *   plan   the parcel source `pr`: a 9110 / 9103 parcel of the stage at MEX 2 / 7 that the register does not hold and
 *          no order names (neither mex_tracking_id nor a collabBox external_order_id) — instead of an unlinked
 *          mex_parcels row of the last N days. Everything after it (candidates −10 d … +1 d by the last 8 digits,
 *          rule 2b duplicates / after-booking, unique both ways, the product by name after 72 h, payout rows) is the
 *          live text. A pair more than 72 h apart whose document is not in collabbox_documents is therefore
 *          "product_unknown" → the manual list, exactly as the cron would rule.
 *   apply  the plan it calls, its ledger key / actor, and — once the order is proven untouched — the parcel row is
 *          inserted from the stage (history_run = the run) and then linked by the same mex_link_parcel(); a failure
 *          of one pair rolls its insert back with it (the per-pair sub-transaction of the live function).
 * Read-only: it reads the two live function bodies and writes the migration file. Apply the file with
 * scripts/apply-migration-mk.mjs.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { managementSql } from '../lib/target.mjs';
import { ROOT } from '../lib/repair-kit.mjs';

const OUT = join(ROOT, 'supabase', 'migrations', '20260948000220_mex_history_lead_links.sql');
const md5 = (s) => createHash('md5').update(String(s).replace(/\r/g, '')).digest('hex');
const def = async (sig) => (await managementSql(`select pg_get_functiondef('${sig}'::regprocedure) as d`, { readOnly: true }))[0].d.replace(/\r/g, '');
function swap(text, from, to, what) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${what}: expected exactly one occurrence, found ${n}`);
  return text.replace(from, () => to);   // a function: `$'` inside the SQL must not be read as a replacement pattern
}

let plan = await def('public.link_lead_parcels_plan(integer)');
let apply = await def('public.link_lead_parcels(boolean,integer,uuid,text)');
const livePlanMd5 = md5(plan), liveApplyMd5 = md5(apply);

// ── the plan ───────────────────────────────────────────────────────────────────────────────────────────────────
plan = swap(plan, 'CREATE OR REPLACE FUNCTION public.link_lead_parcels_plan(p_days integer DEFAULT 75)',
  'CREATE OR REPLACE FUNCTION public.mex_history_lead_plan()', 'plan signature');
plan = swap(plan, 'SELECT greatest(1, least(coalesce($1::integer, 75), 400)) AS days,', 'SELECT 0 AS days,                                   -- the whole history: no look-back window', 'plan days');
plan = swap(plan, `    FROM public.mex_parcels p, prm
   WHERE p.order_id IS NULL
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.phone8 ~ '^[0-9]{8}$'
     AND (p.series IN ('9110', '9103') OR (coalesce(p.series, '') = '' AND p.account = 'bio_natural'))
     AND p.created_at_mex >= prm.at - make_interval(days => prm.days)
     AND NOT (p.phone8 = ANY (prm.ex8))
     AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)`,
`    FROM (SELECT s.tracking_id, s.account,
                 CASE WHEN s.tracking_id ~ '^[0-9]{3}-[0-9]{4}-' THEN split_part(s.tracking_id, '-', 2) END AS series,
                 s.status_id, s.status_name, s.cod_mkd, s.phone8, s.created_at_mex,
                 CASE WHEN s.status_id = 2 THEN s.last_update_at END AS delivered_at,
                 CASE WHEN s.status_id = 7 THEN s.last_update_at END AS returned_at,
                 s.last_update_at
            FROM public.mex_history_stage s
           WHERE s.status_id IN (2, 7)                 -- a FINAL parcel only: delivered or returned
             AND s.created_at_mex IS NOT NULL AND s.last_update_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.tracking_id = s.tracking_id)
             AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.external_order_id = s.tracking_id)) p, prm
   WHERE coalesce(p.cod_mkd, 0) > 0
     AND p.phone8 ~ '^[0-9]{8}$'
     AND p.series IN ('9110', '9103')
     AND NOT (p.phone8 = ANY (prm.ex8))
     AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)`, 'plan parcel source');
// the plan's 'rule' label stays the live one: the rules ARE the live ones (the run's key names the source)

// ── the apply ──────────────────────────────────────────────────────────────────────────────────────────────────
apply = swap(apply, 'CREATE OR REPLACE FUNCTION public.link_lead_parcels(p_apply boolean DEFAULT false, p_days integer DEFAULT 75, p_run uuid DEFAULT NULL::uuid, p_expect_hash text DEFAULT NULL::text)',
  'CREATE OR REPLACE FUNCTION public.mex_history_lead_apply(p_apply boolean DEFAULT false, p_run uuid DEFAULT NULL::uuid, p_expect_hash text DEFAULT NULL::text)', 'apply signature');
apply = swap(apply, `c_key     CONSTANT text := 'link-lead-parcels';`, `c_key     CONSTANT text := 'mex-history-lead-links';`, 'apply key');
apply = swap(apply, `c_actor   CONSTANT text := 'System (link-lead-parcels)';`, `c_actor   CONSTANT text := 'System (mex-history-lead-links)';`, 'apply actor');
apply = swap(apply, '_plan := public.link_lead_parcels_plan(p_days);', '_plan := public.mex_history_lead_plan();', 'apply plan call');
apply = swap(apply, `IF NOT pg_try_advisory_xact_lock(hashtext('public.link_lead_parcels')) THEN`, `IF NOT pg_try_advisory_xact_lock(hashtext('public.link_lead_parcels')) THEN   -- the same lock as the live linker: never both at once`, 'apply lock');
apply = swap(apply, `      SELECT * INTO _o FROM public.orders WHERE id = _oid FOR UPDATE;
      SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _tr FOR UPDATE;
      IF _o.id IS NULL OR _p.tracking_id IS NULL
         OR _o.status::text IS DISTINCT FROM (_it ->> 'status')
         OR _o.mex_tracking_id IS NOT NULL
         OR _p.order_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = _tr) THEN`,
`      SELECT * INTO _o FROM public.orders WHERE id = _oid FOR UPDATE;
      IF _o.id IS NULL
         OR _o.status::text IS DISTINCT FROM (_it ->> 'status')
         OR _o.mex_tracking_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.mex_parcels x WHERE x.tracking_id = _tr)
         OR NOT EXISTS (SELECT 1 FROM public.mex_history_stage s WHERE s.tracking_id = _tr)
         OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = _tr) THEN`, 'apply guard');
apply = swap(apply, `      INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, evidence)
      VALUES (_run, _oid, 'LL_' || (_it ->> 'kind'), public.link_lead_parcels_snapshot(_oid, _tr),`,
`      -- the parcel enters the register from the stage only now that the order is proven untouched; mex_link_parcel
      -- links it a few statements below, and a failure of this pair rolls the insert back with it
      INSERT INTO public.mex_parcels (
        tracking_id, account, status_id, status_name, cod_mkd,
        receiver_name, receiver_city, receiver_phone_raw, phone8, sender_reference,
        created_at_mex, last_update_at, delivered_at, returned_at, first_seen_at, last_seen_at, history_run)
      SELECT s.tracking_id, s.account, s.status_id, s.status_name, s.cod_mkd,
             s.receiver_name, s.receiver_city, s.receiver_phone_raw, s.phone8, s.sender_reference,
             s.created_at_mex, s.last_update_at,
             CASE WHEN s.status_id = 2 THEN s.last_update_at END,
             CASE WHEN s.status_id = 7 THEN s.last_update_at END, s.dump_at, s.dump_at, _run
        FROM public.mex_history_stage s WHERE s.tracking_id = _tr;
      SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _tr FOR UPDATE;

      INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, evidence)
      VALUES (_run, _oid, 'LL_' || (_it ->> 'kind'), public.link_lead_parcels_snapshot(_oid, _tr),`, 'apply parcel insert');
apply = swap(apply, `VALUES (c_key, false, _hash, jsonb_build_object('trigger', _trigger, 'run_day', _today, 'days', _plan -> 'days',`,
  `VALUES (c_key, false, _hash, jsonb_build_object('trigger', _trigger, 'run_day', _today, 'days', _plan -> 'days', 'source', 'mex_history_stage',`, 'apply run summary');
apply = swap(apply, `'Run %s (undo: scripts/rollback-repair.mjs --run %s).',`, `'The parcel comes from the full MEX register of 03.10.2026. Run %s (undo: scripts/rollback-repair.mjs --run %s, then delete the run''s unlinked history rows).',`, 'apply note');

const sql = `-- 20260948000220_mex_history_lead_links.sql
-- The phone + date law on the HISTORY parcels (owner law 01.10.2026; owner 04.10.2026: "заврши сè, базата да е чиста").
--
-- The live linker (public.link_lead_parcels_plan / link_lead_parcels, cron 21:02) only sees the unlinked rows of
-- mex_parcels of the last 75 days, and the live register is incomplete: about 4.200 cancelled / trashed leads have a
-- delivered or returned 9110 parcel that exists only in the full MEX register (mex_history_stage). These two functions
-- are the LIVE bodies (md5 of the sources they were generated from: plan ${livePlanMd5}, apply ${liveApplyMd5}) with
-- the parcel source swapped for the stage — generated by scripts/history/gen_history_lead_links_migration.mjs, never
-- written by hand, so the rules are the cron's own:
--   a 9110 / 9103 parcel at MEX 2 / 7, COD > 0, that the register does not hold and no order names → the ONE order on
--   its last-8 phone created −10 d … +1 d that holds no parcel, is a real priced sale, not a disposition and not a
--   duplicate, and fits no other such parcel; more than 72 h apart the collabBox document must carry the product by
--   name (no document in the ledger → the manual list). The order then follows MEX: 2 → paid (basis mex), 7 → returned.
-- The parcel row is inserted from the stage (history_run = the run) only for a pair that is applied, and linked by
-- mex_link_parcel in the same sub-transaction — no unlinked history row is ever left behind.
-- One transaction for the whole apply (as the live function): run it through psql, the Management API gateway cuts a
-- request at ~100 s.   select public.mex_history_lead_apply(true, '<dry-run id>', '<hash>');
-- Undo: node scripts/rollback-repair.mjs --run <id> --apply, then
--       delete from public.mex_parcels where history_run = '<id>' and order_id is null;

${plan};

${apply};

REVOKE ALL ON FUNCTION public.mex_history_lead_plan()                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_history_lead_apply(boolean, uuid, text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_history_lead_plan()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_history_lead_apply(boolean, uuid, text) TO service_role;
`;
writeFileSync(OUT, sql.replace(/\r/g, ''), 'utf8');
console.log(`written ${OUT} (${sql.length} chars) — plan md5 ${livePlanMd5}, apply md5 ${liveApplyMd5}`);
