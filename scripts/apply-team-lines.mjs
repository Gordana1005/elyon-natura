/**
 * apply-team-lines — teams = BUSINESS LINES (owner ruling 30.09.2026, plan "Фаза 3"; migrations
 * 20260943000900 / 20260943000950). Reads sales_team_line_proposal() — each person's credited
 * sales by department → a proposed line (teleshop | affiliate | management) + lane (in | out |
 * social) + confidence — and, on request, re-keys the "sure" people's memberships IN PLACE through
 * sales_team_lines_apply() (the whole history relabelled; one audit_log row). The department of a
 * sale is never touched (collabBox folder + MEX profile decide it). No shebang (repair-kit convention).
 *
 *   node scripts/apply-team-lines.mjs                          # dry run (default): the proposal, per person
 *   node scripts/apply-team-lines.mjs --json                   # the same, as JSON
 *   node scripts/apply-team-lines.mjs --apply --only-sure [--actor mile@elyon.com] [--days 60]
 *
 * --apply needs --only-sure: "likely" and "decide" rows are the owner's call, in Settings → Teams →
 * Предлог (one row at a time, with a team / lane picker). A re-run is idempotent (an applied row
 * comes back "unchanged"). Rollback: the audit_log row (action 'sales_team.lines_apply') holds every
 * membership's before / after — re-key them back with sales_team_lines_apply.
 * 🛑 Macedonia only (repair-kit guards: config.toml + .env pinned to bmfxhgznttcnnlqloqzp, +389 remote).
 */
import { bold, die, mkGuard, ok, parseArgs, printTable, q, resolveActor, sql, sqlRead, assertRemoteIsMk, yellow } from './lib/repair-kit.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'only-sure', 'json', 'dry-run'], values: ['actor', 'days'] });
const days = args.days ? Number(args.days) : 60;
if (!Number.isInteger(days) || days < 7 || days > 365) die('--days: 7–365');
if (args.apply && !args['only-sure']) die('--apply applies only the "sure" rows: add --only-sure (the rest is decided in Settings → Teams → Предлог).');
if (args.apply && args['dry-run']) die('--apply and --dry-run together make no sense.');

mkGuard();
await assertRemoteIsMk();

const [have] = await sqlRead(`
  SELECT to_regprocedure('public.sales_team_line_proposal(integer)') IS NOT NULL AS proposal,
         to_regprocedure('public.sales_team_lines_apply(jsonb,uuid)') IS NOT NULL AS apply`);
if (!have?.proposal || !have?.apply) die('not applied yet: apply 20260943000900_teams_business_lines.sql (and …000950) first.');

const readProposal = async () => {
  const [r] = await sqlRead(`SELECT public.sales_team_line_proposal(${days}) AS doc`);
  return typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc;
};
const tl = (team, lane) => (team ? `${team}${lane ? `:${lane}` : ''}` : '—');
const pct = (v) => (v == null ? '' : `${Math.round(Number(v) * 100)}%`);
const counts = (c) => ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social']
  .filter((d) => Number(c?.[d]) > 0).map((d) => `${d} ${c[d]}`).join(' · ');

const doc = await readProposal();
const rows = doc.rows ?? [];
const sure = rows.filter((r) => r.confidence === 'sure' && !r.unchanged && r.proposed?.team_key);

if (args.json && !args.apply) {
  console.log(JSON.stringify({ tool: 'apply-team-lines', dry_run: true, days, summary: doc.summary, would_apply: sure.length, rows }, null, 2));
  process.exit(0);
}

console.log(bold(`\nTeams = business lines — proposal over the last ${days} days (fewer than 5 sales → whole history)`));
console.log(`summary: ${JSON.stringify(doc.summary)}`);
for (const conf of ['sure', 'likely', 'decide']) {
  const part = rows.filter((r) => r.confidence === conf);
  if (!part.length) continue;
  console.log(bold(`\n${conf.toUpperCase()} (${part.length})`));
  printTable(part.map((r) => ({
    person: r.display_name + (r.is_active ? '' : ' (inactive)'),
    now: tl(r.current?.team_key, r.current?.lane) + (r.current?.legacy ? ' [legacy]' : ''),
    proposed: tl(r.proposed?.team_key, r.proposed?.lane),
    share: pct(r.share),
    basis: r.basis,
    sales: counts(r.counts) || '—',
    change: r.unchanged ? 'no' : 'yes',
  })));
}

if (!args.apply) {
  console.log(yellow(`\nDRY RUN — nothing written. --apply --only-sure would re-key ${sure.length} people (all their memberships).`));
  console.log('Likely / decide rows: Settings → Teams → Предлог (owner).');
  process.exit(0);
}

// ── apply: the sure rows only ────────────────────────────────────────────────
if (!sure.length) { ok('nothing sure left to apply.'); process.exit(0); }
const actor = await resolveActor(args.actor || 'mile@elyon.com');
const payload = sure.map((r) => ({ person_id: r.person_id, team_key: r.proposed.team_key, lane: r.proposed.lane ?? null }));
console.log(bold(`\nAPPLY — ${payload.length} people, as ${actor.email}`));
const [res] = await sql(`SELECT public.sales_team_lines_apply(${q(JSON.stringify(payload))}::jsonb, ${q(actor.id)}::uuid) AS r`);
const out = typeof res?.r === 'string' ? JSON.parse(res.r) : res?.r;
if (!out?.ok) die(`refused: ${JSON.stringify(out)}`);
ok(`re-keyed: ${out.changed} membership rows changed, ${out.inserted} created (people with no team), ${out.unchanged} already right · audit ${out.audit_id}`);

const after = await readProposal();
const left = (after.rows ?? []).filter((r) => r.confidence === 'sure' && !r.unchanged && r.proposed?.team_key);
console.log(`after: ${JSON.stringify(after.summary)} · sure rows still to apply: ${left.length}`);
console.log('Next: node scripts/verify-teams.mjs (T1 lists whoever still waits for the owner).');
