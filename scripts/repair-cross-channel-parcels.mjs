/**
 * Repair — AlterCPA leads that the pre-fix MEX reconcile revived on a NATURA teleshop / social
 * parcel (series 9102 · 9100 · 9108 · 1300) — the generalisation of repair-revived-cross-channel.mjs
 * (3 cases, 28.09) to the whole class, found 29.09.2026 ~05:05.
 *
 * Owner law 28–29.09: the department is decided by the collabBox FOLDER / MEX profile, never by the
 * system an order was made in. A NATURA "Нарачка out" (10050) / "Нарачка in" (10036) / social
 * (10106 / 10055) parcel is a teleshop / social sale; attached to a dead AlterCPA lead by the old
 * phone+price fallback, it counts as Affiliate – Lead in, credited to nobody or to the operator who
 * cancelled the lead, while its collabBox document stands as a 'conflict' (never an order).
 *
 * The case set is computed LIVE (no hand list):
 *   · an order with sale_source 'altercpa', status paid / returned / shipped, holding a NATURA
 *     parcel of series 9102 / 9100 / 9108 / 1300;
 *   · its paid/returned/shipped came from the MEX reconcile flipping a CANCEL or a TRASH (the
 *     classifier re-checks the history and the MEX note — mexFlipRevert);
 *   · the parcel is NOT the lead's own dispatch: created more than 2 days after the lead, or more
 *     than 2 days before it (a same-day parcel is left alone — it may be the lead's own sale booked
 *     in a teleshop folder: listed for the owner, never touched here).
 * Action = repair-ghost-manual's 'unlink' (its classifier is reused): the lead loses the parcel and
 * goes back to the status it had before the flip (cancelled → cancelled/other + note; trashed →
 * not_reachable park), the register row is unlinked, the parcel counts as a MEX-only sale of its
 * series' department until its collabBox document becomes its order (re-apply the ledger rows —
 * printed at the end). Orders in agent_payout_items are excluded (payouts deferred by the owner).
 *
 *   node scripts/repair-cross-channel-parcels.mjs                    # dry run → CSV + run id
 *   node scripts/repair-cross-channel-parcels.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards).
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, die, ok, mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  parseArgs, fileStamp, writeCsv, loadPayoutOrderIds, loadHistory, loadMexNotes,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable,
} from './lib/repair-kit.mjs';
import { classifyGhostManual, loadOrdersByDisplay, loadParcels, loadNamers, loadOwnParcels } from './repair-ghost-manual.mjs';

export const KEY = 'cross-channel-parcels';
const DAY_MS = 86_400_000;
const SAME_EVENT_DAYS = 2;
const TYPE_WORD = { 10050: 'Нарачка out (teleshop out)', 10036: 'Нарачка in (teleshop in)', 10106: 'Социјални мрежи', 10055: 'С. Мрежи-Продавница', 10114: 'LEADS-OUT', 10111: 'Нарачка LEADS' };
const SERIES_WORD = { 9102: 'teleshop out', 9100: 'teleshop in', 9108: 'social', 1300: 'social' };

/** The live candidates: AlterCPA orders holding a NATURA teleshop / social parcel, with the document. */
export async function loadCandidates() {
  return sqlRead(`
    select o.display_id, o.mex_tracking_id as tracking, o.status::text as status, o.created_at as lead_at,
           p.series, p.cod_mkd, p.created_at_mex as parcel_at, p.status_name,
           coalesce(d.doc_type_id::text, t.doc_type_id::text) as doc_type,
           coalesce(d.author, t.author) as author,
           coalesce(d.doc_at, t.doc_at) as doc_at,
           coalesce(d.amount_mkd, t.amount_mkd) as amount_mkd,
           case when d.doc_number is not null then 'collabbox_documents' when t.doc_number is not null then 'teleshop_import_documents' end as ledger
      from public.orders o
      join public.mex_parcels p on p.tracking_id = o.mex_tracking_id
      left join public.collabbox_documents d on d.doc_number = p.tracking_id
      left join public.teleshop_import_documents t on t.doc_number = p.tracking_id
     where o.sale_source = 'altercpa'
       and o.status in ('paid', 'returned', 'shipped')
       and p.account = 'natura'
       and p.series in ('9102', '9100', '9108', '1300')
     order by o.display_id`);
}

const fmtDay = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { timeZone: 'Europe/Skopje' }).replace(/\//g, '.') : '?');

/** Split the candidates: the parcel is another event (unlink) or possibly the lead's own (owner list). */
export function pickDecisions(cands) {
  const decisions = [], sameEvent = [];
  for (const c of cands) {
    const ref = c.doc_at || c.parcel_at;
    const gapDays = (new Date(ref).getTime() - new Date(c.lead_at).getTime()) / DAY_MS;
    if (Math.abs(gapDays) <= SAME_EVENT_DAYS) { sameEvent.push({ ...c, gap_days: gapDays.toFixed(1) }); continue; }
    const what = c.doc_type ? `collabBox "${TYPE_WORD[c.doc_type] || c.doc_type}" document` : `a NATURA ${SERIES_WORD[c.series] || c.series} parcel with no collabBox document on file`;
    decisions.push({
      x: c.display_id, t: c.tracking, action: 'unlink',
      evidence: `${what} ${c.tracking} (${fmtDay(ref)}, ${c.amount_mkd ?? c.cod_mkd} ден${c.author ? `, ${c.author}` : ''}) — ` +
        `a ${SERIES_WORD[c.series] || c.series} sale ${gapDays > 0 ? `${Math.round(gapDays)} days after` : `${Math.round(-gapDays)} days before`} this AlterCPA lead of ${fmtDay(c.lead_at)}; the pre-fix MEX reconcile attached it to the lead`,
    });
  }
  return { decisions, sameEvent };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'actor'] });
  if (args.help) { console.log('usage: node scripts/repair-cross-channel-parcels.mjs [--apply --run <id>]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id>.');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const cands = await loadCandidates();
  const { decisions, sameEvent } = pickDecisions(cands);
  const orders = await loadOrdersByDisplay(decisions.map((d) => d.x));
  const trackings = decisions.map((d) => d.t);
  const [parcels, namers, ownParcels] = await Promise.all([loadParcels(trackings), loadNamers(trackings), loadOwnParcels(orders.map((o) => o.id))]);
  const [history, notes] = await Promise.all([loadHistory(orders.map((o) => o.id)), loadMexNotes(orders.map((o) => o.id))]);
  const payout = await loadPayoutOrderIds(orders.map((o) => o.id));
  const plan = classifyGhostManual({ decisions, orders, parcels, namers, ownParcels, history, notes, payout, runTag: APPLY ? String(args.run).slice(0, 8) : 'dry-run' });

  // Only the rows the MEX reconcile flipped out of a cancel / trash are repaired; the rest is listed.
  const counts = { candidates: cands.length, same_event_listed: sameEvent.length, ...plan.counts };
  console.log(bold('Counts'));
  printTable(Object.entries(counts).map(([k, v]) => ({ bucket: k, n: v })));
  const manualWhy = new Map();
  for (const r of plan.csv.filter((r) => r.action === 'manual')) {
    const k = r.why.replace(/ORD-\d+/g, 'ORD-…').replace(/002-\d{4}-\d+\/\d{4}/g, '…').slice(0, 90);
    manualWhy.set(k, (manualWhy.get(k) || 0) + 1);
  }
  if (manualWhy.size) { console.log(bold('\nLeft alone (manual) — why')); printTable([...manualWhy].map(([why, n]) => ({ why, n }))); }
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, [
    ...plan.csv,
    ...sameEvent.map((c) => ({ case: c.display_id, action: 'owner_same_event', planned: '', why: `parcel ${c.gap_days} days from the lead — maybe the lead's own sale booked in a teleshop folder`, tracking: c.tracking, account: 'natura', parcel_status: c.status_name, cod_mkd: c.cod_mkd, parcel_created: c.parcel_at, receiver: '', holder_status: c.status, holder_source: 'altercpa', holder_price_mkd: '', holder_product: '', holder_created: c.lead_at, holder_back_to: '', to_order: '', to_status: '', to_price_mkd: '', to_created: '', to_target: '', cod_fit_to: '', evidence: `${c.doc_type || 'no doc'} ${c.author || ''}`, trash_effect: '' })),
  ]);
  ok(`CSV: ${csvPath}`);

  const unlinked = plan.csv.filter((r) => r.action === 'unlink').map((r) => r.tracking);
  if (!APPLY) {
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: { script: 'repair-cross-channel-parcels.mjs', counts } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n  node scripts/repair-cross-channel-parcels.mjs --apply --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap: await loadOrderColumnTypes() });
  const payload = { script: 'repair-cross-channel-parcels.mjs', counts, applied_orders: stats.applied };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders`);
  console.log(`\nParcels now free for their collabBox document (${unlinked.length}) — re-apply their ledger rows so each becomes its own order:\n  ${unlinked.slice(0, 20).join(' ')}${unlinked.length > 20 ? ' …' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
