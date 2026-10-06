#!/usr/bin/env node
/**
 * Mark the loyalty phones that also have a naturatherapy.mk profile.
 *
 * Reads Customer on storefront tenant 2 (last 8 digits) and writes ONLY
 * public.loyalty_shop_phone on the Macedonian CRM. It never writes the shop
 * ledger, never creates a customer, and never updates an order.
 *
 *   node scripts/loyalty-mark-shop.mjs
 *   node scripts/loyalty-mark-shop.mjs --dry-run
 *
 * Refuses Bulgaria, the retired CRM, and a shop URL that points at either.
 * Prints counts only — never a phone, a token or a connection string.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BG_REF, NEW_MK_REF, OLD_MK_REF, managementSql } from './lib/target.mjs';

const dryRun = process.argv.includes('--dry-run');
const shopRoot = process.env.LOYALTY_SHOP_ROOT || 'D:/naturatherapy/storefront';
const TENANT_MK = 2;

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

function safe(err) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***')
    .replace(/\b\d{8}\b/g, '********')
    .slice(0, 500);
}

function readEnvFile(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { fail(`cannot read the shop env (${file})`); }
  if (text.includes(BG_REF) || text.includes('elyoncall.com')) fail('shop env mentions Bulgaria — refusing');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const shopEnv = readEnvFile(join(shopRoot, '.env'));
const shopUrl = shopEnv.DATABASE_URL || '';
if (!shopUrl.startsWith('postgres')) fail('shop DATABASE_URL is missing');
for (const ref of [BG_REF, NEW_MK_REF, OLD_MK_REF]) {
  if (shopUrl.includes(ref)) fail('shop database is a CRM project — refusing');
}

process.env.DATABASE_URL = shopUrl;
if (shopEnv.DIRECT_URL) process.env.DIRECT_URL = shopEnv.DIRECT_URL;

const require = createRequire(pathToFileURL(join(shopRoot, 'package.json')));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let shopKeys = 0;
const shop = new Map();
try {
  const rows = await prisma.$queryRaw`
    SELECT right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 8) AS phone8,
           count(*)::int AS profiles
      FROM "Customer"
     WHERE "tenantId" = ${TENANT_MK}
       AND phone IS NOT NULL
     GROUP BY 1
  `;
  for (const row of rows) {
    const phone8 = String(row.phone8 ?? '');
    const profiles = Number(row.profiles);
    if (!/^[0-9]{8}$/.test(phone8)) continue;
    if (!Number.isInteger(profiles) || profiles < 1 || profiles > 30) fail('a shop phone has an unexpected profile count — refusing');
    shop.set(phone8, profiles);
  }
  shopKeys = shop.size;
} catch (err) {
  fail(`shop read failed: ${safe(err)}`);
} finally {
  await prisma.$disconnect().catch(() => {});
}

if (shopKeys < 1000) fail(`shop phone keys ${shopKeys} — refusing (expected the MK customer book)`);

let totals;
try {
  totals = (await managementSql(
    `select count(*)::int as orders,
            count(distinct phone8)::int as phones,
            coalesce(sum(points), 0)::bigint as points
       from public.loyalty_grants`,
    { readOnly: true },
  ))[0];
} catch (err) {
  fail(`grant read failed: ${safe(err)}`);
}

const orders = Number(totals?.orders);
const phones = Number(totals?.phones);
const points = Number(totals?.points);
console.log(`grants: ${orders} orders, ${phones} phones, ${points} points`);
if (!(orders >= 20000 && orders <= 40000 && points >= 4500000 && points <= 8000000)) {
  fail('grant total is outside the sure band — refusing to mark');
}

let grantPhones;
try {
  grantPhones = await managementSql(
    `select distinct phone8 from public.loyalty_grants where phone8 ~ '^[0-9]{8}$'`,
    { readOnly: true },
  );
} catch (err) {
  fail(`grant phones failed: ${safe(err)}`);
}

const matches = [];
for (const row of grantPhones) {
  const phone8 = String(row.phone8 ?? '');
  const profiles = shop.get(phone8);
  if (profiles) matches.push({ phone8, profiles });
}
matches.sort((a, b) => a.phone8 < b.phone8 ? -1 : 1);

console.log(`shop keys ${shopKeys}, grant phones ${grantPhones.length}, overlap ${matches.length}`);
if (matches.length < 50 || matches.length > 5000) {
  fail(`overlap ${matches.length} is outside 50–5000 — refusing`);
}
if (dryRun) {
  console.log('dry run — nothing written');
  process.exit(0);
}

const values = matches.map((m) => `('${m.phone8}'::text, ${m.profiles}::int)`).join(',');
const sql = `
WITH hit(phone8, shop_profiles) AS (
  VALUES ${values}
),
up AS (
  INSERT INTO public.loyalty_shop_phone (phone8, shop_profiles, noted_at)
  SELECT h.phone8, h.shop_profiles, now()
    FROM hit h
   WHERE EXISTS (SELECT 1 FROM public.loyalty_grants g WHERE g.phone8 = h.phone8)
  ON CONFLICT (phone8) DO UPDATE
    SET shop_profiles = EXCLUDED.shop_profiles,
        noted_at = now()
  RETURNING phone8
),
del AS (
  DELETE FROM public.loyalty_shop_phone s
   WHERE NOT EXISTS (SELECT 1 FROM hit h WHERE h.phone8 = s.phone8)
  RETURNING phone8
)
SELECT (SELECT count(*)::int FROM up) AS marked,
       (SELECT count(*)::int FROM del) AS removed
`;

try {
  const done = (await managementSql(sql))[0];
  console.log(`marked ${Number(done?.marked)}, removed ${Number(done?.removed)}`);
} catch (err) {
  fail(`shop mark failed: ${safe(err)}`);
}
