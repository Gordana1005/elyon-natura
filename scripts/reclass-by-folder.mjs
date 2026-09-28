/**
 * Reclass — every collabBox order to its department BY THE DOCUMENT TYPE (the collabBox folder), and
 * the AlterCPA-team rows back to Affiliate – Lead out (owner, 28.09.2026 ~23:55: "departments by
 * folder; affiliate lead in / affiliate lead out / teleshop lead in / teleshop lead out / social / web;
 * it doesn't matter in which system an order was made"). No shebang (repair-kit convention).
 *
 * Why by TYPE: the series in a DocNumber can lie (703 LEADS-OUT documents are numbered 9102, 286
 * "Нарачка out" are numbered 9100, 99 "Нарачка in" are numbered 9102 — folder map 28.09). The type
 * of every document comes from the local collabBox harvest (headers of every type, 2023 → 10.09) and
 * the fresh fetches in exports/collabbox/*.json.
 *
 * Stored values (the reporting functions of 20260942001000 read them):
 *   10111 Нарачка LEADS            → altercpa  / collabbox_leads      (Affiliate – Lead in)
 *   10114 LEADS-OUT                → elyon_crm / collabbox_leads_out  (Affiliate – Lead out)
 *   10050 Нарачка out              → collabbox / teleshop_out         (Телешоп – Lead out)
 *   10036 Нарачка in               → collabbox / teleshop             (Телешоп – Lead in)
 *   10106 / 10055 social           → collabbox / social
 *   altercpa/team_prediction (a CRM sale of an AlterCPA-team agent) → elyon_crm / its CRM detail
 * Only sale_source / sale_source_detail change (no status, money or date), under
 * SET LOCAL elyon.allow_source_change + keep_updated_at + bulk_repair; every move is logged in
 * sale_source_reclass (from = the source before the FIRST move ever; --rollback returns this
 * script's rows to that original arrival source).
 *
 *   node scripts/reclass-by-folder.mjs                 # dry run: from → to counts
 *   node scripts/reclass-by-folder.mjs --apply [--outside-quiet-window]
 *   node scripts/reclass-by-folder.mjs --rollback [--apply]
 * Then refresh the Pure Profit monthly cache and run the ties.
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, bold, yellow, die, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, printTable, q,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
} from './lib/repair-kit.mjs';

const TAG = 'departments by folder 28.09.2026 (reclass-by-folder.mjs)';
export const TARGET = Object.freeze({
  10111: ['altercpa', 'collabbox_leads'],
  10114: ['elyon_crm', 'collabbox_leads_out'],
  10050: ['collabbox', 'teleshop_out'],
  10036: ['collabbox', 'teleshop'],
  10106: ['collabbox', 'social'],
  10055: ['collabbox', 'social'],
});

/** DocNumber → collabBox type id, from the harvest CSV and every fetch JSON (the fetch wins). */
export function loadTypes(root = ROOT) {
  const types = new Map();
  const csv = join(root, 'exports', 'collabbox', 'merged-2026-09-28', 'orders', 'orders_combined.csv');
  for (const line of readFileSync(csv, 'utf8').split(/\r?\n/)) {
    const c = line.split(',');
    if (c.length > 3 && /^002-/.test(c[1]) && /^\d+$/.test(c[2])) types.set(c[1], c[2]);
  }
  const dir = join(root, 'exports', 'collabbox');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { for (const h of JSON.parse(readFileSync(join(dir, f), 'utf8')).headers || []) if (h.docNumber && h.typeId) types.set(h.docNumber, String(h.typeId)); } catch { /* not a fetch file */ }
  }
  return types;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'rollback', 'outside-quiet-window', 'help'], values: [] });
  if (args.help) { console.log('usage: see the header of scripts/reclass-by-folder.mjs'); return; }
  mkGuard();
  await assertRemoteIsMk();
  const APPLY = !!args.apply;

  if (args.rollback) {
    const [c] = await sqlRead(`select count(*)::int as n from public.sale_source_reclass where reason = ${q(TAG)}`);
    console.log(`${c.n} orders carry this script's tag`);
    if (!APPLY) { console.log(yellow('  dry run — add --apply to return them to their original source')); return; }
    await requireKeepUpdatedAt({ forApply: true });
    await sql(`set local elyon.keep_updated_at = 'on'; set local elyon.bulk_repair = 'on'; set local elyon.allow_source_change = 'on';
      set local statement_timeout = '600s';
      with b as (update public.orders o set sale_source = r.from_source, sale_source_detail = r.from_detail
                   from public.sale_source_reclass r where r.order_id = o.id and r.reason = ${q(TAG)} returning o.id)
      delete from public.sale_source_reclass r using b where r.order_id = b.id;`);
    ok('rolled back');
    return;
  }

  console.log(bold(`\nReclass — departments by folder — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  const types = loadTypes();
  ok(`${types.size} collabBox document types known locally`);
  const rows = await sqlRead(`select id, external_order_id as doc, sale_source as src, coalesce(sale_source_detail, '') as det
    from public.orders where external_source = 'collabbox' and external_order_id is not null`);
  const moves = [];
  const tally = {};
  let unknown = 0;
  for (const r of rows) {
    const t = types.get(r.doc);
    if (!t) { unknown++; continue; }
    const target = TARGET[t];
    if (!target || (target[0] === r.src && target[1] === r.det)) continue;
    if (!['altercpa', 'elyon_crm', 'collabbox'].includes(r.src)) continue;   // web / legacy never move
    moves.push({ id: r.id, to: target });
    const k = `${r.src}/${r.det} → ${target.join('/')} (type ${t})`;
    tally[k] = (tally[k] || 0) + 1;
  }
  const [team] = await sqlRead(`select count(*)::int as n from public.orders where sale_source = 'altercpa' and sale_source_detail = 'team_prediction'`);
  printTable(Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ move: k, orders: n })));
  console.log(`  collabBox orders ${rows.length} · type unknown ${unknown} · to move ${moves.length} · team_prediction back to Affiliate – Lead out ${team.n}`);
  if (!APPLY) { console.log(yellow('  dry run — nothing written. Add --apply.')); return; }

  await requireKeepUpdatedAt({ forApply: true });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the reclass');
  let done = 0;
  for (let i = 0; i < moves.length; i += 5000) {
    const part = moves.slice(i, i + 5000);
    const vals = part.map((m) => `('${m.id}'::uuid, ${q(m.to[0])}, ${q(m.to[1])})`).join(',');
    const [r] = await sql(`
      set local elyon.keep_updated_at = 'on'; set local elyon.bulk_repair = 'on'; set local elyon.allow_source_change = 'on';
      set local statement_timeout = '300s';
      create temp table _mv on commit drop as
      select o.id, o.sale_source as from_source, o.sale_source_detail as from_detail, v.src as to_source, v.det as to_detail
        from (values ${vals}) v(id, src, det) join public.orders o on o.id = v.id
       where (o.sale_source, coalesce(o.sale_source_detail, '')) is distinct from (v.src, v.det);
      insert into public.sale_source_reclass as r (order_id, from_source, from_detail, to_source, to_detail, reason)
      select id, from_source, from_detail, to_source, to_detail, ${q(TAG)} from _mv
      on conflict (order_id) do update set to_source = excluded.to_source, to_detail = excluded.to_detail, reason = excluded.reason, moved_at = now();
      update public.orders o set sale_source = m.to_source, sale_source_detail = m.to_detail from _mv m where m.id = o.id;
      select count(*)::int as n from _mv;`);
    done += r.n;
    console.log(`  moved ${r.n} (${done}/${moves.length})`);
    await requireNoSegmentRecompute('continue the reclass');
  }
  const [t2] = await sql(`
    set local elyon.keep_updated_at = 'on'; set local elyon.bulk_repair = 'on'; set local elyon.allow_source_change = 'on';
    create temp table _tp on commit drop as
    select o.id, o.sale_source as from_source, o.sale_source_detail as from_detail, 'elyon_crm'::text as to_source,
           public.elyon_crm_sale_detail(o.prediction_list_id, o.price, o.product_name) as to_detail
      from public.orders o where o.sale_source = 'altercpa' and o.sale_source_detail = 'team_prediction';
    insert into public.sale_source_reclass as r (order_id, from_source, from_detail, to_source, to_detail, reason)
    select id, from_source, from_detail, to_source, to_detail, ${q(TAG)} from _tp
    on conflict (order_id) do update set to_source = excluded.to_source, to_detail = excluded.to_detail, reason = excluded.reason, moved_at = now();
    update public.orders o set sale_source = t.to_source, sale_source_detail = t.to_detail from _tp t where t.id = o.id;
    select count(*)::int as n from _tp;`);
  ok(`moved ${done} collabBox orders by type; ${t2.n} team_prediction rows back to Affiliate – Lead out`);
  console.log(yellow('  Next: refresh insights_profit_monthly (24 months), then the ties.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
