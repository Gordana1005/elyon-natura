/**
 * Brand lines — set the SURE rows of the brand-line proposal (plan 30.09.2026, "Фаза 4 — Мапа на
 * производите по линија"; migration 20260943001300). No shebang (repair-kit convention).
 *
 * Owner ruling 30.09.2026: when the CRM ships an order via MEX the product line decides the MEX
 * profile — Bio Natural and Dr.Becker via BIO NATURAL, Natura Therapy and Ad Astra via NATURA. The
 * owner asked for a map of ALL products by line. public.product_brand_line_proposal(days) suggests a
 * line per product from the MEX parcels (and the Bio Natural anchor names); this script sets ONLY
 * the rows the proposal marks `auto`:
 *   • an undecided product (brand_line IS NULL — an owner's choice is never overwritten), and
 *   • a Bio Natural ANCHOR name the parcels do not contradict, or ≥ 90 % of its parcels on ONE MEX
 *     account (BIO NATURAL → bio_natural, NATURA → natura_therapy).
 * Never a mixed row, a conflict (e.g. ALPHA MALE 60 cps: a Bio Natural name, 94 % NATURA parcels), an
 * Ad Astra / Dr.Becker name hint, or a product without parcels — those stay for the owner on
 * /products → Предлог.
 *
 *   node scripts/apply-brand-lines.mjs                          # dry run (default): what would be set
 *   node scripts/apply-brand-lines.mjs --days 180 --min-parcels 10
 *   node scripts/apply-brand-lines.mjs --from-json proposal.json  # dry run from a saved proposal (offline)
 *   node scripts/apply-brand-lines.mjs --apply --actor <admin auth uuid>
 *
 * --min-parcels N   a ≥ 90 % row needs at least N parcels (default 1 = the proposal's rule; anchors
 *                   are not affected). The dry run lists the rows under 10 parcels either way.
 * The dry run also writes the whole map (every product in the proposal, its parcels, suggestion,
 * confidence and reason) to exports/repairs/brand-lines-<stamp>.csv (gitignored) for the owner.
 * --apply writes through public.products_set_brand_line(ids, line, actor): one call per line
 * (≤ 1.000 ids), one audit_log row per call, and only for ids still undecided at write time.
 * 🛑 Macedonia only (repair-kit guards). Touches products.brand_line* only — no order, no money.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  bold, yellow, die, ok, mkGuard, sql, assertRemoteIsMk, parseArgs, printTable, q, qUuid, qUuidArray,
  isUuid, writeCsv, fileStamp,
} from './lib/repair-kit.mjs';

export const LINES = ['natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker'];
export const PROFILE = { bio_natural: 'bio_natural', dr_becker: 'bio_natural', natura_therapy: 'natura', ad_astra: 'natura' };
export const FEW_PARCELS = 10;
const CHUNK = 1000;

/**
 * The rows to set: the proposal's `auto` rows (undecided, anchor or high confidence), a high row only
 * with at least `minParcels` parcels. Returns {plan: [{line, rows}], skipped: {...}} in LINES order.
 */
export function planBrandLines(rows, { minParcels = 1 } = {}) {
  const by = new Map(LINES.map((l) => [l, []]));
  const skipped = { decided: 0, conflict: 0, hint: 0, mixed: 0, none: 0, tie: 0, few: 0 };
  for (const r of rows) {
    if (r.brand_line) { skipped.decided++; continue; }
    if (r.confidence === 'conflict') { skipped.conflict++; continue; }
    if (r.confidence === 'hint') { skipped.hint++; continue; }
    if (r.confidence === 'low') { skipped.mixed++; continue; }
    if (r.reason === 'parcels_tie') { skipped.tie++; continue; }
    if (!r.auto || !r.suggested || !LINES.includes(r.suggested)) { skipped.none++; continue; }
    if (r.confidence === 'high' && Number(r.parcels) < minParcels) { skipped.few++; continue; }
    by.get(r.suggested).push(r);
  }
  return { plan: LINES.map((line) => ({ line, rows: by.get(line) })).filter((c) => c.rows.length), skipped };
}

const pct = (n, of) => (of > 0 ? `${Math.round((1000 * n) / of) / 10}%` : '');
const brief = (r) => ({
  name: r.name.length > 48 ? `${r.name.slice(0, 47)}…` : r.name,
  bio: r.bio_natural, natura: r.natura,
  share: pct(Math.max(r.bio_natural, r.natura), r.parcels),
  conf: r.confidence, active: r.is_active ? 'yes' : 'no',
});

async function loadProposal(days, fromJson) {
  if (fromJson) {
    const j = JSON.parse(readFileSync(fromJson, 'utf8'));
    return j.rows ? j : j.p ?? j;
  }
  const [fn] = await sql(`SET TRANSACTION READ ONLY;
    SELECT to_regprocedure('public.product_brand_line_proposal(integer)') IS NOT NULL AS ok;`);
  if (!fn?.ok) die('public.product_brand_line_proposal() is missing — apply migration 20260943001300 first.');
  // The function is service_role only, so it runs as the owner — in a READ ONLY transaction.
  const [row] = await sql(`SET TRANSACTION READ ONLY; SELECT public.product_brand_line_proposal(${days}) AS p;`);
  const p = typeof row?.p === 'string' ? JSON.parse(row.p) : row?.p;
  if (!p?.rows) die('the proposal came back empty.');
  return p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'help'], values: ['actor', 'days', 'min-parcels', 'from-json'] });
  if (args.help) { console.log('usage: see the header of scripts/apply-brand-lines.mjs'); return; }
  const APPLY = !!args.apply;
  const days = args.days ? Number(args.days) : 180;
  if (!Number.isInteger(days) || days < 1 || days > 3650) die('--days must be 1..3650');
  const minParcels = args['min-parcels'] ? Number(args['min-parcels']) : 1;
  if (!Number.isInteger(minParcels) || minParcels < 1) die('--min-parcels must be a whole number ≥ 1');
  if (APPLY && args['from-json']) die('--apply always plans from the live proposal — drop --from-json.');
  if (APPLY && !isUuid(args.actor)) die('--apply needs --actor <auth user uuid of an active admin / owner> (audit_log.actor_id).');

  if (!args['from-json']) {
    mkGuard();
    await assertRemoteIsMk();
  }
  const proposal = await loadProposal(days, args['from-json']);
  const s = proposal.summary ?? {};
  console.log(bold(`\nBrand-line proposal — parcels of the last ${proposal.days ?? days} days (${proposal.generated_at ?? 'offline'})`));
  console.log(`  products ${s.products} · sure (≥90%) ${s.sure} · mixed ${s.mixed} · no parcels ${s.none} · anchors ${s.anchors}` +
    ` · conflicts ${s.conflicts} · hints Ad Astra ${s.hints?.ad_astra ?? 0} / Dr.Becker ${s.hints?.dr_becker ?? 0} · already decided ${s.decided}`);

  const rows = proposal.rows;
  const { plan, skipped } = planBrandLines(rows, { minParcels });
  const total = plan.reduce((n, c) => n + c.rows.length, 0);

  console.log(bold(`\nWould set ${total} lines`) + ` (min parcels for a ≥90% row: ${minParcels}):`);
  for (const c of plan) console.log(`  ${c.line.padEnd(15)} → MEX ${PROFILE[c.line].padEnd(11)} ${c.rows.length}`);
  console.log(`  skipped: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  for (const c of plan) {
    const anchors = c.rows.filter((r) => r.confidence === 'anchor');
    const high = c.rows.filter((r) => r.confidence === 'high');
    if (anchors.length) { console.log(bold(`\n${c.line} — Bio Natural anchor names (${anchors.length})`)); printTable(anchors.map(brief)); }
    if (high.length) {
      console.log(bold(`\n${c.line} — ≥90% of the parcels on ${PROFILE[c.line]} (${high.length})`));
      printTable(high.map(brief));
      if (c.line === 'bio_natural') {
        console.log(yellow(`  ! ${high.length} bio_natural rows come from BIO NATURAL parcels, not a Bio Natural name — affiliate sales of a` +
          ' Natura Therapy product ship with BIO NATURAL too. Check the names before --apply (or tag them on /products).'));
      }
    }
  }
  const few = plan.flatMap((c) => c.rows).filter((r) => r.confidence === 'high' && r.parcels < FEW_PARCELS);
  if (few.length) console.log(yellow(`\n! ${few.length} of the rows above have fewer than ${FEW_PARCELS} parcels (--min-parcels ${FEW_PARCELS} leaves them out).`));

  const left = rows.filter((r) => !r.brand_line && !plan.some((c) => c.rows.includes(r)));
  const forOwner = left.filter((r) => ['conflict', 'hint', 'low'].includes(r.confidence) || r.reason === 'parcels_tie');
  if (forOwner.length) {
    console.log(bold(`\nLeft for the owner on /products → Предлог (${forOwner.length} conflicts / hints / mixed):`));
    printTable(forOwner.map((r) => ({ ...brief(r), suggested: r.suggested ?? '', reason: r.reason })));
  }
  console.log(`  + ${left.length - forOwner.length} undecided products without a usable suggestion (no parcels in the window).`);

  if (!APPLY) {
    const file = writeCsv(`brand-lines-${fileStamp()}.csv`, rows.map((r) => ({
      product_id: r.id, name: r.name, sku: r.sku, active: r.is_active, line_now: r.brand_line ?? '',
      bio_natural_parcels: r.bio_natural, natura_parcels: r.natura, majority_share: r.share ?? '',
      bucket: r.bucket, anchor: r.anchor ?? '', hint: r.hint ?? '', suggested: r.suggested ?? '',
      mex_profile: r.suggested_profile ?? '', confidence: r.confidence, conflict: r.conflict, reason: r.reason,
      would_set: plan.some((c) => c.rows.includes(r)) ? 'yes' : '',
    })));
    ok(`the whole map → ${file}`);
    console.log(yellow('\n  dry run — nothing written. Review, then: --apply --actor <admin auth uuid>'));
    return;
  }

  // ── apply ──
  const [actor] = await sql(`SET TRANSACTION READ ONLY;
    SELECT u.email, public.is_business_owner(u.id) AS owner FROM auth.users u WHERE u.id = ${qUuid(args.actor)};`);
  if (!actor) die(`--actor ${args.actor}: no such auth user.`);
  if (!actor.owner) die(`--actor ${actor.email}: not an active admin / owner (is_business_owner() = false).`);
  ok(`actor ${actor.email}`);

  let updated = 0;
  for (const c of plan) {
    for (let i = 0; i < c.rows.length; i += CHUNK) {
      const ids = c.rows.slice(i, i + CHUNK).map((r) => r.id);
      // Only ids STILL undecided at write time — a line the owner set meanwhile is never overwritten.
      const [res] = await sql(`WITH ids AS (
          SELECT coalesce(array_agg(p.id), '{}') AS a FROM public.products p
           WHERE p.id = ANY (${qUuidArray(ids)}) AND p.brand_line IS NULL)
        SELECT CASE WHEN cardinality(ids.a) > 0
                    THEN public.products_set_brand_line(ids.a, ${q(c.line)}, ${qUuid(args.actor)}) END AS r
          FROM ids;`);
      const r = typeof res?.r === 'string' ? JSON.parse(res.r) : res?.r;
      const n = Number(r?.updated ?? 0);
      updated += n;
      ok(`${c.line}: ${n} set, ${Number(r?.unchanged ?? 0)} unchanged, ${ids.length - Number(r?.requested ?? 0)} already decided meanwhile`);
    }
  }
  ok(bold(`${updated} lines set (audit_log action products.set_brand_line).`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
