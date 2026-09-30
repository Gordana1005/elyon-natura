// Settings → Teams: pure helpers (unit-tested in teamsModel.test.ts).
// Dates are Skopje calendar days as YYYY-MM-DD; valid_to is INCLUSIVE and
// NULL means "still a member" (sales_team_members, migration 20260935000100).
import type { SalesIdentityKind, SalesMembership, SalesPerson, SalesTeam } from '@/lib/api';
import { isLegacyTeam, isLineKey } from '@/lib/teamLines';

/** Today as YYYY-MM-DD in Europe/Skopje. */
export function skopjeTodayYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** YYYY-MM-DD shifted by n days (pure calendar arithmetic, no timezone). */
export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** dd.MM.yyyy straight off a YYYY-MM-DD. */
export const dmy = (ymd: string | null | undefined) =>
  ymd && ymd.length >= 10 ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : '';

const covers = (m: SalesMembership, day: string) => m.valid_from <= day && (m.valid_to == null || m.valid_to >= day);

/** The PRIMARY membership that covers `day` (at most one — the EXCLUDE constraint). */
export function currentPrimary(memberships: SalesMembership[], day: string): SalesMembership | null {
  return memberships.find((m) => m.is_primary && covers(m, day)) ?? null;
}

/** The next primary membership that starts after `day` (a planned move). */
export function nextPrimary(memberships: SalesMembership[], day: string): SalesMembership | null {
  return memberships
    .filter((m) => m.is_primary && m.valid_from > day)
    .sort((a, b) => a.valid_from.localeCompare(b.valid_from))[0] ?? null;
}

/** Secondary memberships that cover `day`. */
export function currentSecondary(memberships: SalesMembership[], day: string): SalesMembership[] {
  return memberships.filter((m) => !m.is_primary && covers(m, day));
}

export const NO_TEAM = '__none__';

export interface TeamColumnEntry { person: SalesPerson; membership: SalesMembership | null; secondary: boolean }
export interface TeamColumn { key: string; team: SalesTeam | null; entries: TeamColumnEntry[] }

/**
 * One column per team (in the order the API sends them) listing who is in it
 * on `day` — primary members first, then secondary ones — plus a trailing
 * "no team" column for everyone with no primary team that day (only when
 * non-empty). Names sort within a column.
 */
export function teamColumns(people: SalesPerson[], teams: SalesTeam[], day: string): TeamColumn[] {
  const byName = (a: TeamColumnEntry, b: TeamColumnEntry) =>
    Number(a.secondary) - Number(b.secondary) || a.person.display_name.localeCompare(b.person.display_name);
  const cols: TeamColumn[] = teams.map((t) => ({ key: t.key, team: t, entries: [] }));
  const col = new Map(cols.map((c) => [c.key, c]));
  const none: TeamColumnEntry[] = [];
  for (const p of people) {
    const prim = currentPrimary(p.memberships, day);
    if (prim && col.has(prim.team_key)) col.get(prim.team_key)!.entries.push({ person: p, membership: prim, secondary: false });
    else none.push({ person: p, membership: null, secondary: false });
    for (const s of currentSecondary(p.memberships, day)) {
      if (col.has(s.team_key) && s.team_key !== prim?.team_key) col.get(s.team_key)!.entries.push({ person: p, membership: s, secondary: true });
    }
  }
  for (const c of cols) c.entries.sort(byName);
  if (none.length) cols.push({ key: NO_TEAM, team: null, entries: none.sort(byName) });
  return cols;
}

/** Teams = business lines (30.09.2026): a legacy team column (crm_prediction / altercpa_leads)
 *  is shown only while someone is still in it. */
export function visibleColumns(cols: TeamColumn[]): TeamColumn[] {
  return cols.filter((c) => !(c.team && (c.team.kind === 'legacy' || isLegacyTeam(c.team.key)) && c.entries.length === 0));
}

/** An active person who still waits for a business line today: no team, a legacy team, or a
 *  line membership without its lane. Opens Settings → Teams → Предлог by itself. */
export function needsLineDecision(p: SalesPerson, day: string): boolean {
  if (!p.is_active) return false;
  const cur = currentPrimary(p.memberships, day);
  if (!cur) return true;
  if (isLegacyTeam(cur.team_key)) return true;
  return isLineKey(cur.team_key) && !cur.lane;
}

/** AlterCPA ids of a person, as "#4222" labels. */
export const altercpaIds = (p: SalesPerson) =>
  p.identities.filter((i) => i.kind === 'altercpa_user').map((i) => `#${i.value}`);

/** Case- and script-insensitive-enough search over name, login and handles. */
export function personMatches(p: SalesPerson, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [p.display_name, p.login_name ?? '', p.login_email ?? '', ...p.identities.map((i) => i.value)]
    .join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w.replace(/^#/, '')));
}

/** Which identity kind names the decider of an unmapped order group. */
export function identityKindForVia(soldVia: string | null | undefined): SalesIdentityKind | null {
  switch (soldVia) {
    case 'altercpa': return 'altercpa_user';
    case 'collabbox': return 'collabbox_author';
    case 'crm': case 'crm_push': case 'import': return 'order_name';
    default: return null;
  }
}

/**
 * What "Move to team T from X" will do to the membership that covers X, for
 * the confirm line: close it at X−1, replace it (it starts on X), or nothing.
 */
export function movePreview(
  memberships: SalesMembership[], from: string, teamKey: string | null, role: 'member' | 'lead',
): { kind: 'close' | 'replace' | 'none' | 'same' | 'blocked'; current: SalesMembership | null; closeOn: string | null } {
  if (memberships.some((m) => m.is_primary && m.valid_from > from)) return { kind: 'blocked', current: null, closeOn: null };
  const cur = currentPrimary(memberships, from);
  if (!cur) return { kind: 'none', current: null, closeOn: null };
  if (cur.team_key === teamKey && cur.role === role) return { kind: 'same', current: cur, closeOn: null };
  if (cur.valid_from === from) return { kind: 'replace', current: cur, closeOn: null };
  return { kind: 'close', current: cur, closeOn: addDaysYmd(from, -1) };
}
