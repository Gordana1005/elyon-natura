/**
 * Reclass — every collabBox order to its DEPARTMENT, for the whole history (owner, 28.09.2026 ~23:00:
 * "ElyonCRM → Телешоп – Lead out; Телешоп = only the lead-in orders; everything the AlterCPA agents
 * sell stays in AlterCPA" — and "Да, цела историја"). No shebang (repair-kit convention). Run with `node`.
 *
 * The rule is public.collabbox_department() (migration 20260942000700): 9102 "Нарачка out" / 9103
 * "LEADS-OUT" → elyon_crm (Телешоп – Lead out) collabbox_out / collabbox_leads_out, or AlterCPA
 * (team_…) when the author was in the AlterCPA team that day; 9110 "LEADS" → altercpa/collabbox_leads;
 * 9100 "Нарачка in" and 9108 social stay collabbox. New imports already classify this way at INSERT.
 *
 * Only orders.sale_source / sale_source_detail change — no status, no money, no date — under
 * SET LOCAL elyon.allow_source_change (the write-once lock's deliberate door), keep_updated_at (Call
 * Again's last_call_at must not move) and bulk_repair. Every move lands in sale_source_reclass
 * (from = the source before the FIRST move ever) with this script's reason tag, which --rollback uses.
 *
 *   node scripts/reclass-department-sources.mjs                 # dry run: what would move, by from → to
 *   node scripts/reclass-department-sources.mjs --apply [--chunk 20000] [--outside-quiet-window]
 *   node scripts/reclass-department-sources.mjs --rollback [--apply]
 *
 * After an apply: refresh the Pure Profit monthly cache (the cached months' per-source blocks move
 * but updated_at does not), then run the ties (verify-attribution, verify-tab-*).
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, printTable,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
} from './lib/repair-kit.mjs';

const TAG = 'departments 28.09.2026 (reclass-department-sources.mjs)';
const SCOPE = `o.sale_source = 'collabbox' and split_part(coalesce(o.external_order_id, ''), '-', 2) in ('9102', '9103', '9110')`;

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'rollback', 'outside-quiet-window', 'help'], values: ['chunk'] });
  if (args.help) { console.log('usage: see the header of scripts/reclass-department-sources.mjs'); return; }
  mkGuard();
  await assertRemoteIsMk();
  const [fn] = await sqlRead(`select to_regprocedure('public.collabbox_department(text,uuid,timestamptz)') is not null as ok`);
  if (!fn.ok) die('apply migration 20260942000700_department_sources.sql first.');
  const APPLY = !!args.apply;

  if (args.rollback) {
    const [c] = await sqlRead(`select count(*)::int as n from public.sale_source_reclass where reason = ${`'${TAG}'`}`);
    console.log(`${c.n} orders were moved by this script`);
    if (!APPLY) { console.log(yellow('  dry run — add --apply to move them back')); return; }
    await requireKeepUpdatedAt({ forApply: true });
    const [r] = await sql(`
      set local elyon.keep_updated_at = 'on'; set local elyon.bulk_repair = 'on'; set local elyon.allow_source_change = 'on';
      set local statement_timeout = '600s';
      with b as (update public.orders o set sale_source = r.from_source, sale_source_detail = r.from_detail
                   from public.sale_source_reclass r where r.order_id = o.id and r.reason = '${TAG}' returning o.id)
      delete from public.sale_source_reclass r using b where r.order_id = b.id returning r.order_id;`);
    ok(`rolled back (${r ? 'done' : 'nothing'})`);
    return;
  }

  console.log(bold(`\nReclass — departments — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  const plan = await sqlRead(`
    select o.sale_source || '/' || coalesce(o.sale_source_detail, '') as "from", d[1] || '/' || d[2] as "to", count(*)::int as orders
      from (select o.*, public.collabbox_department(o.external_order_id, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)) as d
              from public.orders o where ${SCOPE}) o
     where d is not null group by 1, 2 order by 3 desc`);
  printTable(plan);
  const total = plan.reduce((a, r) => a + r.orders, 0);
  console.log(`  ${total} orders to move`);
  if (!APPLY) { console.log(yellow('  dry run — nothing written. Add --apply.')); return; }

  await requireKeepUpdatedAt({ forApply: true });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the reclass');
  const chunk = Math.max(1000, Math.min(50000, Number(args.chunk) || 20000));
  let moved = 0;
  for (;;) {
    const t0 = Date.now();
    const [r] = await sql(`
      set local elyon.keep_updated_at = 'on';
      set local elyon.bulk_repair = 'on';
      set local elyon.allow_source_change = 'on';
      set local statement_timeout = '300s';
      create temp table _mv on commit drop as
      select x.id, x.sale_source as from_source, x.sale_source_detail as from_detail, x.d[1] as to_source, x.d[2] as to_detail
        from (select o.id, o.sale_source, o.sale_source_detail,
                     public.collabbox_department(o.external_order_id, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)) as d
                from public.orders o where ${SCOPE} order by o.id limit ${chunk}) x
       where x.d is not null;
      insert into public.sale_source_reclass as r (order_id, from_source, from_detail, to_source, to_detail, reason)
      select id, from_source, from_detail, to_source, to_detail, '${TAG}' from _mv
      on conflict (order_id) do update set to_source = excluded.to_source, to_detail = excluded.to_detail,
             reason = excluded.reason, moved_at = now();
      update public.orders o set sale_source = m.to_source, sale_source_detail = m.to_detail from _mv m where m.id = o.id;
      select count(*)::int as n from _mv;`);
    moved += r.n;
    console.log(`  moved ${r.n} (${moved}/${total}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!r.n) break;
    await requireNoSegmentRecompute('continue the reclass');
  }
  const left = await sqlRead(`select count(*)::int as n from public.orders o where ${SCOPE}`);
  ok(`moved ${moved} orders; collabBox 9102/9103/9110 rows left in collabbox: ${left[0].n}`);
  console.log(yellow('  Next: refresh insights_profit_monthly (24 months), node scripts/verify-attribution.mjs, the verify-tab scripts.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
