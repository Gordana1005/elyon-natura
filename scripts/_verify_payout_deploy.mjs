import fs from 'fs';
const env = fs.readFileSync('.env', 'utf8');
const token = (env.match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m) || [])[1].trim().replace(/^["']|["']$/g, '');
const q = async (query) => {
  const r = await fetch('https://api.supabase.com/v1/projects/oufoazmnbwugtfldkwsn/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, body: await r.text() };
};
const a = await q(`select role, module_key, can_view from public.role_permissions where module_key='performance' and role in ('agent','pending_agent','prediction_agent') order by role`);
const b = await q(`select version, name from supabase_migrations.schema_migrations where version in ('20260716000000','20260903000000') order by version`);
const c = await q(`select count(*)::int as n from public.agent_payouts`);
// Mark our unique version as applied (SQL already ran; version was renamed after a collision)
const mark = await q(`
  INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
  SELECT '20260903000000', 'agent_payouts', ARRAY[]::text[]
  WHERE NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260903000000'
  );
`);
const b2 = await q(`select version, name from supabase_migrations.schema_migrations where version='20260903000000'`);
console.log('permissions', a.status, a.body);
console.log('migration before/after mark', b.status, b.body, mark.status, b2.body);
console.log('agent_payouts count', c.status, c.body);
