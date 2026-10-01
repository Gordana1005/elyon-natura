/**
 * sigma-ingest-file — sends one SigmaBatch JSON (docs/stock/build_sigma_stock.py → exports/stock/
 * sigma-batch-since-2209.json, or a file the office connector wrote with --out) to the Macedonian CRM.
 * No shebang (repo convention).
 *
 *   node scripts/stock/sigma-ingest-file.mjs [file]                 # DRY: validate + chunk, print what would go
 *   node scripts/stock/sigma-ingest-file.mjs [file] --send          # POST /api/stock/sigma/ingest, HMAC (like the connector)
 *   node scripts/stock/sigma-ingest-file.mjs [file] --direct        # stock_sigma_ingest() through the Management API,
 *                                                                   #   every chunk in ONE transaction, ROLLED BACK
 *   node scripts/stock/sigma-ingest-file.mjs [file] --direct --apply   # … committed (the lead)
 *   options: --url <ingest url>   default https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api/stock/sigma/ingest
 *            --max-docs 500 --max-bytes 1000000   the chunk limits (tools/sigma-connector/sigma-fields.json)
 *
 * --send signs every request: x-elyon-ts (unix seconds) and x-elyon-signature = hex(HMAC_SHA256(secret, ts + '.' +
 * rawBody)); the secret comes from the environment variable SIGMA_CONNECTOR_SECRET and is never printed.
 * The batch keeps its batch_id (a chunk adds -c001…), so sending the same file twice is a no-op (duplicate).
 * A CSV batch is staged even while app_settings.stock_v2.sigma.ingest is off (staging moves no stock); a
 * connector batch then answers "disabled".
 *
 * Safety: Macedonia only — the URL must be the MK project, --direct goes through the repair-kit guards; nothing
 * is written without --send or --direct --apply.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MK_REF, bold, die, ok, warn, yellow } from '../lib/repair-kit.mjs';
import { FIELDS, chunkBatch, postBatch } from '../../tools/sigma-connector/lib/batch.mjs';
import { STOCK_DIR, args, guard, jlit, read, txRun } from './sigma-common.mjs';

const DEFAULT_URL = `https://${MK_REF}.supabase.co/functions/v1/api/stock/sigma/ingest`;

/** Contract checks before anything leaves (pure). */
export function validate(batch) {
  const errs = [];
  if (!batch || typeof batch !== 'object') return ['not an object'];
  for (const k of Object.keys(batch)) if (!FIELDS.batch_fields.includes(k)) errs.push(`unknown batch key ${k}`);
  if (!batch.batch_id) errs.push('batch_id missing');
  if (!['csv', 'connector'].includes(batch.source)) errs.push('source must be csv or connector');
  if (!['delta', 'snapshot', 'items', 'balances'].includes(batch.mode)) errs.push('mode');
  if (!batch.exported_at) errs.push('exported_at missing');
  for (const d of [...(batch.docs ?? []), ...(batch.drafts ?? [])]) {
    const extra = Object.keys(d).filter((k) => !FIELDS.doc_fields.includes(k));
    if (extra.length) errs.push(`${d.doc_key}: fields outside the whitelist: ${extra.join(', ')}`);
    if (d.doc_key !== `${d.wyear}|${d.doc_type}|${d.doc_no}`) errs.push(`${d.doc_key}: doc_key ≠ wyear|doc_type|doc_no`);
    for (const l of d.lines ?? []) {
      if (!['in', 'out'].includes(l.side) || typeof l.qty !== 'number') { errs.push(`${d.doc_key}: bad line ${JSON.stringify(l)}`); break; }
    }
  }
  return errs;
}

async function main() {
  const a = args(process.argv.slice(2), { flags: ['send', 'direct', 'apply', 'help'], values: ['url', 'max-docs', 'max-bytes'] });
  if (a.help) { console.log('see the header of scripts/stock/sigma-ingest-file.mjs'); return; }
  if (a.send && a.direct) die('choose --send (HTTP) or --direct (Management API), not both.');
  if (a.apply && !a.direct) die('--apply belongs to --direct (with --send the server always commits).');
  const file = a._[0] ?? join(STOCK_DIR, 'sigma-batch-since-2209.json');
  const batch = JSON.parse(readFileSync(file, 'utf8'));
  const errs = validate(batch);
  if (errs.length) die(`the batch breaks the contract:\n  ${errs.slice(0, 20).join('\n  ')}`);
  const parts = chunkBatch(batch, { maxDocs: Number(a['max-docs'] ?? FIELDS.limits.max_docs_per_batch),
    maxBytes: Number(a['max-bytes'] ?? FIELDS.limits.max_bytes_per_batch) });
  console.log(bold(`\n${file}`));
  console.log(`  ${batch.batch_id}: ${batch.source}/${batch.mode} · exported ${batch.exported_at} · window ${JSON.stringify(batch.window ?? null)}`);
  console.log(`  ${batch.docs?.length ?? 0} documents · ${batch.drafts?.length ?? 0} drafts · ${batch.items?.length ?? 0} items · ${batch.balances?.length ?? 0} balance rows`);
  console.log(`  → ${parts.length} request(s): ${parts.map((p) => `${p.batch_id} (${Buffer.byteLength(JSON.stringify(p))} B)`).join(', ')}`);

  if (a.send) {
    const url = a.url ?? DEFAULT_URL;
    if (!url.includes(MK_REF) || /sxymaloycddnoxudxaqp/.test(url)) die(`--url must be the Macedonian project (${MK_REF}).`);
    const secret = process.env.SIGMA_CONNECTOR_SECRET;
    if (!secret) die('SIGMA_CONNECTOR_SECRET is not set in the environment.');
    for (const p of parts) {
      const { status, body } = await postBatch(url, secret, p, { log: (m) => warn(m) });
      const st = body?.status;
      if (status !== 200 || !['ok', 'duplicate', 'disabled'].includes(st)) die(`${p.batch_id}: HTTP ${status} ${JSON.stringify(body).slice(0, 600)}`);
      ok(`${p.batch_id}: ${st} · docs ${JSON.stringify(body.docs ?? {})} · excluded ${JSON.stringify(body.excluded ?? {})}`);
    }
    return;
  }
  if (a.direct) {
    await guard();
    const [fn] = await read("select to_regprocedure('public.stock_sigma_ingest(jsonb)') is not null as ok");
    if (!fn?.ok) die('stock_sigma_ingest() is not on MK yet — apply supabase/migrations/20260945000650_stock_sigma_ingest.sql first.');
    const res = await txRun(parts.map((p) => ({ k: p.batch_id, sql: `public.stock_sigma_ingest(${jlit(p)})` })), { dry: !a.apply });
    for (const { k, v } of res) {
      console.log(`  ${k}: ${v.status} · docs ${JSON.stringify(v.docs ?? {})}`);
      if (v.excluded) console.log(`    excluded: ${JSON.stringify(v.excluded)}`);
      if (v.items) console.log(`    items ${JSON.stringify(v.items)} · balances ${JSON.stringify(v.balances)} · drafts ${JSON.stringify(v.drafts)}`);
      if (v.rejected?.length) warn(`    rejected: ${JSON.stringify(v.rejected).slice(0, 400)}`);
      if (v.dropped_fields?.length) warn(`    dropped fields: ${v.dropped_fields.join(', ')}`);
    }
    if (!a.apply) console.log(yellow('\n  DRY RUN — stock_sigma_ingest ran and the transaction was ROLLED BACK. Commit with --direct --apply.'));
    else ok(bold('staged (committed).'));
    return;
  }
  console.log(yellow('\n  DRY RUN — nothing sent. Use --send (HTTP, HMAC) or --direct [--apply] (Management API).'));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
