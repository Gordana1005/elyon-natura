/**
 * Apply ONE migration SQL file to remote Supabase via Management API.
 * Does NOT run other pending migrations.
 *
 * Usage: node scripts/_apply_one_migration.mjs supabase/migrations/20260716000000_agent_payouts.sql
 */
import fs from 'fs';
import path from 'path';

const PROJECT_REF = 'oufoazmnbwugtfldkwsn';
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/_apply_one_migration.mjs <path-to.sql>');
  process.exit(1);
}

const env = fs.readFileSync(path.resolve('.env'), 'utf8');
const token = (env.match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m) || [])[1]
  ?.trim()
  .replace(/^["']|["']$/g, '');
if (!token) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in .env');
  process.exit(1);
}

const sqlPath = path.resolve(file);
const sql = fs.readFileSync(sqlPath, 'utf8');
const version = path.basename(sqlPath).replace(/\.sql$/, '').split('_')[0];
const name = path.basename(sqlPath).replace(/\.sql$/, '').replace(/^\d+_/, '');

console.log('Applying migration:', path.basename(sqlPath));
console.log('Version:', version, 'name:', name);

const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  },
);
const text = await res.text();
console.log('HTTP', res.status);
if (!res.ok) {
  console.error(text.slice(0, 2000));
  process.exit(1);
}
console.log('Migration SQL applied OK');
if (text && text !== '[]' && text !== 'null') {
  console.log(text.slice(0, 500));
}

// Record in supabase_migrations so future `db push` won't try to re-apply.
// Version format used by CLI is the timestamp prefix (e.g. 20260716000000).
const markSql = `
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT '${version}', '${name.replace(/'/g, "''")}', ARRAY[]::text[]
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}'
);
`;

const markRes = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: markSql }),
  },
);
const markText = await markRes.text();
console.log('Mark migration HTTP', markRes.status);
if (!markRes.ok) {
  console.warn('Could not mark migration as applied (may still be fine):', markText.slice(0, 800));
} else {
  console.log('Marked as applied in schema_migrations');
}

// Quick verify tables exist
const verify = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('agent_payouts', 'agent_payout_items')
        ORDER BY table_name;
      `,
    }),
  },
);
console.log('Verify tables:', await verify.text());
