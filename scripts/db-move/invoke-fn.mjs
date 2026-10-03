#!/usr/bin/env node
/**
 * scripts/db-move/invoke-fn.mjs — call one sync edge function ON THE NEW PROJECT with its secret header,
 * the way pg_cron does (03.10.2026 — the chain test of the replica while its cron is inactive).
 *
 *   node scripts/db-move/invoke-fn.mjs web-sync '{}'
 *   node scripts/db-move/invoke-fn.mjs mex-reconcile '{}'
 *   node scripts/db-move/invoke-fn.mjs altercpa-sync '{"kind":"rolling"}'
 *   node scripts/db-move/invoke-fn.mjs collabbox-sync '{"mode":"frequent"}'
 *   node scripts/db-move/invoke-fn.mjs collabbox-shops '{"mode":"sales","trigger":"manual"}'
 *
 * The functions only READ their sources (AlterCPA GET, MEX list, collabBox search, the shop as elyon_crm_reader)
 * and write to the NEW database only. Secrets come from exports/db-move/<date>/secrets.env; never printed.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
if (TARGET_REF === BG_REF) throw new Error('refusing Bulgaria');
const [fn, bodyText = '{}', date = '2026-10-03'] = process.argv.slice(2);
const HEADERS = {
  'web-sync': ['x-web-sync-secret', 'WEB_SYNC_SECRET'],
  'mex-reconcile': ['x-mex-sync-secret', 'MEX_SYNC_SECRET'],
  'altercpa-sync': ['x-altercpa-sync-secret', 'ALTERCPA_SYNC_SECRET'],
  'collabbox-sync': ['x-collabbox-sync-secret', 'COLLABBOX_SYNC_SECRET'],
  'collabbox-shops': ['x-collabbox-sync-secret', 'COLLABBOX_SYNC_SECRET'],
};
if (!HEADERS[fn]) { console.error(`usage: invoke-fn.mjs <${Object.keys(HEADERS).join('|')}> '<json body>'`); process.exit(2); }
const secrets = Object.fromEntries(readFileSync(join(ROOT, 'exports', 'db-move', date, 'secrets.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const [header, name] = HEADERS[fn];
if (!secrets[name]) throw new Error(`${name} missing in secrets.env`);
const t0 = Date.now();
const r = await fetch(`https://${TARGET_REF}.supabase.co/functions/v1/${fn}`, {
  method: 'POST', headers: { [header]: secrets[name], 'Content-Type': 'application/json' }, body: bodyText,
});
const text = await r.text();
console.log(`${fn} → HTTP ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(text.slice(0, 1500));
process.exit(r.ok ? 0 : 1);
