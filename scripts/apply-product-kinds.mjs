/**
 * Product kinds — set the SURE rows of the kind proposal (owner feedback 01.10.2026, "Производи 2.0",
 * point 1; migration 20260943001400). No shebang (repair-kit convention).
 *
 * /products shows the ordinary PRODUCTS first; bundles / promotions, gifts and objects get their own
 * chips. public.product_kind_proposal() suggests a kind per product from its NAME (1+1, 2x, сет, PACK,
 * подарок … → bundle; вага, блендер, тостер, шејкер … → other) and, for a single product, from its
 * order lines (mostly 0 ден beside a paid product → gift). This script sets ONLY the rows the proposal
 * marks `auto`: undecided (kind IS NULL — an owner's choice is never overwritten) and sure. The
 * uncertain gifts (60–90 % free, or fewer than 30 lines) stay for the owner on /products → Предлог → Вид.
 *
 *   node scripts/apply-product-kinds.mjs                          # dry run (default): what would be set + CSV
 *   node scripts/apply-product-kinds.mjs --only bundle,other       # limit the kinds
 *   node scripts/apply-product-kinds.mjs --from-json proposal.json # dry run from a saved proposal (offline)
 *   node scripts/apply-product-kinds.mjs --apply --actor <admin auth uuid>
 *
 * --apply writes through public.products_set_kind(ids, kind, actor): one call per kind (≤ 1.000 ids),
 * one audit_log row per call, only for ids still undecided at write time. 🛑 Macedonia only (repair-kit
 * guards). Touches products.kind* only — no order, no money, no stock.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  bold, yellow, die, ok, mkGuard, sql, assertRemoteIsMk, parseArgs, printTable, q, qUuid, qUuidArray, isUuid, writeCsv, fileStamp,
} from './lib/repair-kit.mjs';

export const KINDS = ['product', 'bundle', 'gift', 'other'];
const CHUNK = 1000;

/** The rows to set: `auto` rows (undecided + high confidence), per kind in KINDS order, optionally limited. */
export function planKinds(rows, { only = KINDS } = {}) {
  const by = new Map(KINDS.map((k) => [k, []]));
  const skipped = { decided: 0, low: 0, none: 0, filtered: 0 };
  for (const r of rows) {
    if (r.kind) { skipped.decided++; continue; }
    if (!r.suggested || !KINDS.includes(r.suggested)) { skipped.none++; continue; }
    if (r.confidence !== 'high' || !r.auto) { skipped.low++; continue; }
    if (!only.includes(r.suggested)) { skipped.filtered++; continue; }
    by.get(r.suggested).push(r);
  }
  return { plan: KINDS.map((kind) => ({ kind, rows: by.get(kind) })).filter((c) => c.rows.length), skipped };
}

const cut = (s, n = 50) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const brief = (r) => ({
  name: cut(r.name), reason: r.reason, hit: r.hit ?? '',
  free: r.lines ? `${Math.round((r.free_lines / r.lines) * 100)}% of ${r.lines}` : '', active: r.is_active ? 'yes' : 'no',
});

async function loadProposal(fromJson) {
  if (fromJson) {
    const j = JSON.parse(readFileSync(fromJson, 'utf8'));
    return j.rows ? j : j.p ?? j;
  }
  const [fn] = await sql(`SET TRANSACTION READ ONLY;
    SELECT to_regprocedure('public.product_kind_proposal()') IS NOT NULL AS ok;`);
  if (!fn?.ok) die('public.product_kind_proposal() is missing — apply migration 20260943001400 first.');
  const [row] = await sql('SET TRANSACTION READ ONLY; SELECT public.product_kind_proposal() AS p;');
  const p = typeof row?.p === 'string' ? JSON.parse(row.p) : row?.p;
  if (!p?.rows) die('the proposal came back empty.');
  return p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'help'], values: ['actor', 'only', 'from-json'] });
  if (args.help) { console.log('usage: see the header of scripts/apply-product-kinds.mjs'); return; }
  const APPLY = !!args.apply;
  const only = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : KINDS;
  for (const k of only) if (!KINDS.includes(k)) die(`--only: unknown kind "${k}" (${KINDS.join(', ')})`);
  if (APPLY && args['from-json']) die('--apply always plans from the live proposal — drop --from-json.');
  if (APPLY && !isUuid(args.actor)) die('--apply needs --actor <auth user uuid of an active admin / owner> (audit_log.actor_id).');

  if (!args['from-json']) { mkGuard(); await assertRemoteIsMk(); }
  const proposal = await loadProposal(args['from-json']);
  const s = proposal.summary ?? {};
  const sg = s.suggested ?? {};
  console.log(bold(`\nKind proposal (${proposal.generated_at ?? 'offline'})`));
  console.log(`  products ${s.products} · suggested product ${sg.product} · bundle ${sg.bundle} · gift ${sg.gift} · other ${sg.other} · none ${sg.none}` +
    ` · sure & undecided ${s.auto} · uncertain ${s.low} · already decided ${s.decided} (differs ${s.differs})`);

  const { plan, skipped } = planKinds(proposal.rows, { only });
  const total = plan.reduce((n, c) => n + c.rows.length, 0);
  console.log(bold(`\nWould set ${total} kinds:`) + ` ${plan.map((c) => `${c.kind} ${c.rows.length}`).join(' · ')}`);
  console.log(`  skipped: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  for (const c of plan) {
    if (c.kind === 'product') continue;   // the long plain list — in the CSV
    console.log(bold(`\n${c.kind} (${c.rows.length})`));
    printTable(c.rows.map(brief));
  }
  const low = proposal.rows.filter((r) => !r.kind && r.confidence === 'low');
  if (low.length) {
    console.log(bold(`\nLeft for the owner on /products → Предлог → Вид (${low.length} uncertain):`));
    printTable(low.map(brief));
  }

  if (!APPLY) {
    const file = writeCsv(`product-kinds-${fileStamp()}.csv`, proposal.rows.map((r) => ({
      product_id: r.id, name: r.name, sku: r.sku ?? '', active: r.is_active, kind_now: r.kind ?? '', suggested: r.suggested ?? '',
      confidence: r.confidence, reason: r.reason, hit: r.hit ?? '', lines: r.lines, free_lines: r.free_lines, free_share: r.free_share ?? '',
      would_set: plan.some((c) => c.rows.includes(r)) ? 'yes' : '',
    })));
    ok(`the whole proposal → ${file}`);
    console.log(yellow('\n  dry run — nothing written. Review, then: --apply --actor <admin auth uuid>'));
    return;
  }

  const [actor] = await sql(`SET TRANSACTION READ ONLY;
    SELECT u.email, public.is_business_owner(u.id) AS owner FROM auth.users u WHERE u.id = ${qUuid(args.actor)};`);
  if (!actor) die(`--actor ${args.actor}: no such auth user.`);
  if (!actor.owner) die(`--actor ${actor.email}: not an active admin / owner (is_business_owner() = false).`);
  ok(`actor ${actor.email}`);
  let updated = 0;
  for (const c of plan) {
    for (let i = 0; i < c.rows.length; i += CHUNK) {
      const ids = c.rows.slice(i, i + CHUNK).map((r) => r.id);
      // Only ids STILL undecided at write time — a kind the owner set meanwhile is never overwritten.
      const [res] = await sql(`WITH ids AS (
          SELECT coalesce(array_agg(p.id), '{}') AS a FROM public.products p
           WHERE p.id = ANY (${qUuidArray(ids)}) AND p.kind IS NULL)
        SELECT CASE WHEN cardinality(ids.a) > 0
                    THEN public.products_set_kind(ids.a, ${q(c.kind)}, ${qUuid(args.actor)}) END AS r
          FROM ids;`);
      const r = typeof res?.r === 'string' ? JSON.parse(res.r) : res?.r;
      const n = Number(r?.updated ?? 0);
      updated += n;
      ok(`${c.kind}: ${n} set, ${ids.length - Number(r?.requested ?? 0)} decided meanwhile (skipped)`);
    }
  }
  ok(bold(`${updated} kinds set (audit_log action products.set_kind).`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
