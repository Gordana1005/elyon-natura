/**
 * Clear the MACHINE texts from products (owner feedback 01.10.2026, "Производи 2.0", point 3). No
 * shebang (repair-kit convention).
 *
 * The catalogue scripts of 28.09.2026 (complete-catalogue, import-catalogue-products) wrote their own
 * notes into the products they created:
 *   products.description  "Креиран автоматски (complete-catalogue, run 324615d4-…): производ со продажби
 *                          што го немаше во каталогот — 5 имиња … Набавната цена ја внесува сопственикот."
 *   products.category     "Од продажби — collabBox/web (28.09.2026)", "Без каталог — од продажби",
 *                          "Без каталог — трета страна (веб)", "AlterCPA — нови понуди (28.09.2026)"
 * The owner: unprofessional. The UI no longer shows them; this clears them for good.
 *
 *   node scripts/clear-product-machine-text.mjs                         # dry run (default): counts, samples, CSV
 *   node scripts/clear-product-machine-text.mjs --include-import-notes  # + "Created for the AlterCPA history import …" (21)
 *   node scripts/clear-product-machine-text.mjs --no-categories         # descriptions only
 *   node scripts/clear-product-machine-text.mjs --apply --actor <admin auth uuid> [same flags]
 *   node scripts/clear-product-machine-text.mjs --restore --actor <admin auth uuid>
 *
 * Only rows whose description STARTS WITH the machine text are touched (a human note is never
 * cleared). --apply runs ONE transaction: back up (product_id, description, category) into
 * public.products_description_backup_20261001 (migration 20260943001410; the first backup of a row is
 * kept), set the machine description / category to '', one audit_log row
 * (products.clear_machine_text), `elyon.keep_updated_at` on. --restore puts the backed-up values back
 * where the product still carries '' (so the 28.09 scripts' rollbacks, which find their rows by the
 * run id in the description, keep working). 🛑 Macedonia only (repair-kit guards).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  bold, yellow, die, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, printTable, q, qUuid, isUuid, writeCsv, fileStamp,
} from './lib/repair-kit.mjs';

export const BACKUP = 'public.products_description_backup_20261001';
/** POSIX twins of MACHINE_DESCRIPTION_RE / MACHINE_CATEGORY_RE in supabase/functions/api/productsCatalog.ts. */
export const DESC_AUTO = String.raw`^\s*Креиран автоматски \(`;
export const DESC_IMPORT = String.raw`^\s*Created for the AlterCPA history import`;
export const CAT_AUTO = String.raw`^\s*(Од продажби — |Без каталог — |AlterCPA — нови понуди)`;

/** The SQL predicates for the chosen scope. */
export function predicates({ importNotes = false, categories = true } = {}) {
  const desc = importNotes ? `(p.description ~ ${q(DESC_AUTO)} OR p.description ~ ${q(DESC_IMPORT)})` : `p.description ~ ${q(DESC_AUTO)}`;
  const cat = categories ? `p.category ~ ${q(CAT_AUTO)}` : 'false';
  return { desc, cat };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'restore', 'help', 'include-import-notes', 'no-categories'], values: ['actor'],
  });
  if (args.help) { console.log('usage: see the header of scripts/clear-product-machine-text.mjs'); return; }
  if (args.apply && args.restore) die('--apply and --restore are two different runs.');
  if ((args.apply || args.restore) && !isUuid(args.actor)) die('needs --actor <auth user uuid of an active admin / owner> (audit_log.actor_id).');
  mkGuard();
  await assertRemoteIsMk();

  const [tbl] = await sqlRead(`select to_regclass(${q(BACKUP)}) is not null as ok`);
  if (!tbl?.ok) {
    if (args.apply || args.restore) die(`${BACKUP} is missing — apply migration 20260943001410 first.`);
    console.log(yellow(`! ${BACKUP} does not exist yet (migration 20260943001410) — fine for a dry run, required for --apply.`));
  }

  if (args.restore) return restore(args.actor);

  const { desc, cat } = predicates({ importNotes: !!args['include-import-notes'], categories: !args['no-categories'] });
  const rows = await sqlRead(`
    select p.id, p.name, p.is_active, p.description, p.category,
           (${desc}) as desc_hit, (${cat}) as cat_hit
      from public.products p
     where (${desc}) or (${cat})
     order by lower(p.name), p.id`);
  const descRows = rows.filter((r) => r.desc_hit);
  const catRows = rows.filter((r) => r.cat_hit);
  const byRun = new Map();
  for (const r of descRows) {
    const k = String(r.description).match(/^\s*Креиран автоматски \(([^,]+), run/)?.[1] ?? 'AlterCPA history import note';
    byRun.set(k, (byRun.get(k) ?? 0) + 1);
  }
  const byCat = new Map();
  for (const r of catRows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
  const [others] = await sqlRead(`select count(*) filter (where coalesce(description, '') <> '')::int as with_desc,
      count(*) filter (where coalesce(category, '') <> '')::int as with_cat from public.products`);

  console.log(bold(`\nMachine texts on products`));
  console.log(`  products touched: ${rows.length} (of them active: ${rows.filter((r) => r.is_active).length})`);
  console.log(`  descriptions to clear: ${descRows.length} of ${others.with_desc} non-empty — ${[...byRun].map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  console.log(`  categories to clear:   ${catRows.length} of ${others.with_cat} non-empty — ${[...byCat].map(([k, n]) => `„${k}“ ${n}`).join(' · ') || 'none'}`);
  if (!args['include-import-notes']) {
    const [imp] = await sqlRead(`select count(*)::int as n from public.products p where p.description ~ ${q(DESC_IMPORT)}`);
    console.log(`  not in scope: ${imp.n} "Created for the AlterCPA history import" notes (add --include-import-notes)`);
  }
  printTable(rows.slice(0, 8).map((r) => ({ name: r.name.slice(0, 40), description: String(r.description ?? '').slice(0, 50), category: r.category })));

  if (!args.apply) {
    const file = writeCsv(`product-machine-text-${fileStamp()}.csv`, rows.map((r) => ({
      product_id: r.id, name: r.name, active: r.is_active, clear_description: r.desc_hit, clear_category: r.cat_hit,
      description: r.description, category: r.category,
    })));
    ok(`every row → ${file}`);
    console.log(yellow('\n  dry run — nothing written. Then: --apply --actor <admin auth uuid>'));
    return;
  }

  const actor = await checkActor(args.actor);
  const run = randomUUID();
  const [res] = await sql(`
    SET LOCAL elyon.keep_updated_at = 'on';
    SET LOCAL lock_timeout = '5s';
    WITH target AS (
      SELECT p.id, p.description, p.category, (${desc}) AS d, (${cat}) AS c
        FROM public.products p WHERE (${desc}) OR (${cat}) FOR UPDATE),
    backed AS (
      INSERT INTO ${BACKUP} (product_id, description, category, backed_up_by, run_id)
      SELECT t.id, t.description, t.category, ${qUuid(args.actor)}, ${qUuid(run)} FROM target t
      ON CONFLICT (product_id) DO NOTHING
      RETURNING product_id),
    cleared AS (
      UPDATE public.products p
         SET description = CASE WHEN t.d THEN '' ELSE p.description END,
             category    = CASE WHEN t.c THEN '' ELSE p.category END
        FROM target t WHERE p.id = t.id
      RETURNING p.id, t.d, t.c),
    n AS (SELECT count(*)::int AS rows, count(*) FILTER (WHERE d)::int AS descriptions, count(*) FILTER (WHERE c)::int AS categories,
                 (SELECT count(*)::int FROM backed) AS backed_up FROM cleared)
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    SELECT ${qUuid(args.actor)}, ${q(actor.email)}, 'products.clear_machine_text', 'data_repair_run', ${q(run)}, 'products',
           jsonb_build_object('run_id', ${q(run)}, 'rows', n.rows, 'descriptions', n.descriptions, 'categories', n.categories,
                              'backed_up', n.backed_up, 'backup_table', ${q(BACKUP)})
      FROM n
    RETURNING payload;`);
  const p = typeof res?.payload === 'string' ? JSON.parse(res.payload) : res?.payload;
  ok(bold(`cleared: ${p?.descriptions ?? '?'} descriptions · ${p?.categories ?? '?'} categories on ${p?.rows ?? '?'} products (backed up ${p?.backed_up ?? '?'}; run ${run})`));
}

async function checkActor(id) {
  const [actor] = await sql(`SET TRANSACTION READ ONLY;
    SELECT u.email, public.is_business_owner(u.id) AS owner FROM auth.users u WHERE u.id = ${qUuid(id)};`);
  if (!actor) die(`--actor ${id}: no such auth user.`);
  if (!actor.owner) die(`--actor ${actor.email}: not an active admin / owner (is_business_owner() = false).`);
  ok(`actor ${actor.email}`);
  return actor;
}

async function restore(actorId) {
  const actor = await checkActor(actorId);
  const [res] = await sql(`
    SET LOCAL elyon.keep_updated_at = 'on';
    WITH d AS (
      UPDATE public.products p SET description = b.description
        FROM ${BACKUP} b
       WHERE b.product_id = p.id AND coalesce(p.description, '') = '' AND coalesce(b.description, '') <> ''
      RETURNING p.id),
    c AS (
      UPDATE public.products p SET category = b.category
        FROM ${BACKUP} b
       WHERE b.product_id = p.id AND coalesce(p.category, '') = '' AND coalesce(b.category, '') <> ''
      RETURNING p.id)
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    SELECT ${qUuid(actorId)}, ${q(actor.email)}, 'products.restore_machine_text', 'products', NULL, 'products',
           jsonb_build_object('descriptions', (SELECT count(*) FROM d), 'categories', (SELECT count(*) FROM c), 'backup_table', ${q(BACKUP)})
    RETURNING payload;`);
  const p = typeof res?.payload === 'string' ? JSON.parse(res.payload) : res?.payload;
  ok(bold(`restored: ${p?.descriptions ?? '?'} descriptions · ${p?.categories ?? '?'} categories`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
