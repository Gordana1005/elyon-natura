#!/usr/bin/env node
/**
 * The password of natura_shop_reader (migration 20261022150000_shop_feed_social_daily.sql:
 * the naturatherapy.mk shop reads the social department's day totals) and the connection
 * URL the shop uses.
 *
 *   node scripts/set-shop-feed-password.mjs                    dry run: says what it would do
 *   node scripts/set-shop-feed-password.mjs --apply            keeps a recorded password, else generates one
 *   node scripts/set-shop-feed-password.mjs --apply --rotate   always a new one
 *
 * The password is generated here and reaches the server only as a SCRAM-SHA-256 verifier
 * (the plaintext never reaches the server or its logs). The URL is written to ONE place:
 * the marked block in D:\naturatherapy\vault.md ("every access in one place"; override with
 * SHOP_FEED_VAULT). The shop's scripts/set-crm-sales-feed.ts reads it from there, proves the
 * login and stores it encrypted on tenant 2. Nothing secret is printed.
 *
 * From a worktree (no .env of its own): ELYON_DOTENV=D:\Dev\archives\elyon-natura\.env
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { REF, NEW_MK_REF, managementSql } from './lib/target.mjs';

const READER = 'natura_shop_reader';
const POOLER = 'aws-0-eu-central-1.pooler.supabase.com:5432';
const VAULT_FILE = process.env.SHOP_FEED_VAULT || 'D:\\naturatherapy\\vault.md';
const BEGIN = '<!-- shop-feed:begin (written by elyon-natura scripts/set-shop-feed-password.mjs — do not hand-edit inside) -->';
const END = '<!-- shop-feed:end -->';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ROTATE = args.includes('--rotate');

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`· ${m}`);

if (REF !== NEW_MK_REF) fail(`target is ${REF}, expected the live MK CRM ${NEW_MK_REF}`);

/** Postgres SCRAM-SHA-256 verifier (the same as scripts/apply-shop-crm-export.mjs). The
 * password is ASCII (base64url), so SASLprep is identity. */
function scramVerifier(password, iterations = 4096) {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function readRecordedUrl() {
  if (!existsSync(VAULT_FILE)) return null;
  const text = readFileSync(VAULT_FILE, 'utf8');
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a < 0 || b < a) return null;
  return text.slice(a, b).match(/`(postgresql:\/\/natura_shop_reader\.[^`\s]+)`/)?.[1] ?? null;
}

function writeRecordedUrl(url, rotated) {
  if (!existsSync(VAULT_FILE)) fail(`${VAULT_FILE} not found`);
  const text = readFileSync(VAULT_FILE, 'utf8');
  const block = [
    BEGIN,
    '## naturall CRM → naturatherapy.mk shop: social day totals (22 Oct 2026)',
    `- Role \`${READER}\` on \`${REF}\`: USAGE on schema \`shop_feed\` + EXECUTE on \`shop_feed.social_daily(date, date)\` only`,
    '  (CRM migration `20261022150000_shop_feed_social_daily.sql`, rollback in its header). Read-only, 30 s, 3 connections.',
    '- The shop stores it encrypted on tenant 2 (Setting `crm.salesFeed`): `npx tsx scripts/set-crm-sales-feed.ts --tenant=2 --apply`',
    `- Last set: ${new Date().toISOString()} (password ${rotated ? 'generated' : 'kept'}). Session pooler URL:`,
    `  \`${url}\``,
    END,
  ].join('\n');
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  const next = a >= 0 && b > a
    ? text.slice(0, a) + block + text.slice(b + END.length)
    : text.replace(/\s*$/, '\n\n') + block + '\n';
  writeFileSync(VAULT_FILE, next, 'utf8');
}

const roles = await managementSql(`select rolcanlogin from pg_roles where rolname = '${READER}'`, { readOnly: true });
if (!roles.length) fail(`${READER} does not exist — apply 20261022150000_shop_feed_social_daily.sql first`);
if (!roles[0].rolcanlogin) fail(`${READER} cannot log in`);
ok(`${READER} exists on ${REF}`);

const recorded = readRecordedUrl();
const rotate = ROTATE || !recorded;
info(rotate ? `a new password will be generated` : `the recorded password is kept (pass --rotate for a new one)`);
if (!APPLY) { info('dry run — nothing changed. Re-run with --apply.'); process.exit(0); }

const password = rotate ? crypto.randomBytes(24).toString('base64url') : decodeURIComponent(new URL(recorded).password);
await managementSql(`ALTER ROLE ${READER} PASSWORD '${scramVerifier(password)}'`);
ok(`password set on ${READER} (as a SCRAM verifier)`);

const url = `postgresql://${READER}.${REF}:${encodeURIComponent(password)}@${POOLER}/postgres?sslmode=require&connection_limit=1`;
writeRecordedUrl(url, rotate);
ok(`URL recorded in ${VAULT_FILE} (not printed). Next, in the shop: npx tsx scripts/set-crm-sales-feed.ts --tenant=2 --apply`);
