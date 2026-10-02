/**
 * stock-reset — stock_v2_reset() against the MACEDONIAN database: switches stock v2 OFF, then writes one
 * correction row negating every non-zero ledger group (the ledger is append-only — nothing is deleted),
 * clears stock_parcel_state and audits stock_v2.reset.
 *
 *   node scripts/stock/stock-reset.mjs                                   DRY (default): what would be negated
 *   node scripts/stock/stock-reset.mjs --apply --actor=mile@elyon.com --reason="…"
 *                                                                        the reset (actor = an auth user's
 *                                                                        e-mail or uuid; reason ≥ 5 chars)
 *   --json   the raw result
 *
 * Exit: 0 = ok · 1 = failed / refused by the function · 2 = guard refusal / not installed.
 *
 * Safety: the dry run is read-only (the guard of scripts/verify-insights-ties.mjs, read_only: true). --apply
 * runs scripts/assert-mk-target.mjs first and sends exactly one whitelisted statement through
 * scripts/stock/stock-run.mjs runWrite() — pinned to Macedonia, never Bulgaria. The LEAD runs --apply.
 */
import { runSql } from '../verify-insights-ties.mjs';
import { runWrite, Refusal } from './stock-run.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  const apply = process.argv.includes('--apply');
  const json = process.argv.includes('--json');

  const [have] = await runSql(`SELECT to_regprocedure('public.stock_v2_reset(uuid,text)') IS NOT NULL AS ok`).catch(() => [{ ok: false }]);
  if (!have?.ok) { console.error('stock-reset: stock_v2_reset() missing — apply 20260945000100…0500 first'); process.exit(2); }

  const [pre] = await runSql(`
    WITH g AS (SELECT m.source_key, m.kind, m.article_code, m.warehouse_id, m.event_at, sum(m.qty) AS q
                 FROM public.stock_moves m GROUP BY 1, 2, 3, 4, 5 HAVING sum(m.qty) <> 0)
    SELECT (SELECT count(*) FROM public.stock_moves) AS rows,
           (SELECT count(*) FROM g) AS groups, (SELECT coalesce(sum(abs(g.q)), 0) FROM g) AS units,
           (SELECT coalesce(jsonb_object_agg(k.kind, k.q), '{}'::jsonb)
              FROM (SELECT g.kind, sum(g.q) AS q FROM g GROUP BY 1) k) AS by_kind,
           public.stock_v2_enabled() AS enabled,
           (SELECT count(*) FROM public.stock_parcel_state) AS parcel_states`);

  if (!apply) {
    if (json) console.log(JSON.stringify({ dry: true, ...pre }, null, 2));
    else {
      console.log(`DRY — nothing written. stock_v2.enabled = ${pre.enabled}`);
      console.log(`ledger rows ${pre.rows} · non-zero groups a reset would negate ${pre.groups} (${pre.units} units)`);
      console.log(`parcel states it would clear ${pre.parcel_states}`);
      for (const [k, q] of Object.entries(pre.by_kind ?? {})) console.log(`  ${k.padEnd(15)} net ${q}`);
      console.log('\nTo reset: --apply --actor=<owner e-mail or uuid> --reason="why"');
    }
    process.exit(0);
  }

  const actorArg = arg('actor');
  const reason = arg('reason');
  if (!actorArg) throw new Refusal('--actor=<e-mail or uuid> is required with --apply');
  if (!reason || reason.trim().length < 5 || reason.length > 500 || /['\\]/.test(reason)) throw new Refusal('--reason="…" (5–500 chars, no quotes) is required with --apply');
  let actor = actorArg;
  if (!/^[0-9a-f-]{36}$/i.test(actorArg)) {
    if (!/^[^\s'"@]+@[^\s'"@]+$/.test(actorArg)) throw new Refusal('--actor must be an e-mail or a uuid');
    const rows = await runSql(`SELECT u.id FROM auth.users u WHERE lower(u.email) = lower('${actorArg}')`);
    if (rows.length !== 1) throw new Refusal(`no single auth user with e-mail ${actorArg}`);
    actor = rows[0].id;
  }
  const [{ r }] = await runWrite(`SELECT public.stock_v2_reset('${actor.toLowerCase()}'::uuid, '${reason.trim()}') AS r`);
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (r.ok) console.log(`reset ok · run ${r.run_id} · groups negated ${r.groups_negated} (${r.units_negated} units) · parcel states cleared ${r.parcel_states_cleared} · stock v2 is now OFF`);
  else console.log(`reset refused: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error(`stock-reset: ${e?.message ?? e}`); process.exit(e instanceof Refusal ? 2 : 1); });
