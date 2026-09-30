// ============================================================================
// Teams = business lines (owner ruling 30.09.2026, plan "Фаза 3") — the pure
// half of the API: the team-filter grammar the boards accept, the team order,
// the Settings → Teams proposal payload and the apply body.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// teamLines.test.ts against this file in Node, and index.ts imports it.
//
// The SQL side is migrations 20260943000900 (sales_teams.kind / sort_order,
// sales_team_members.lane, sales_team_line_proposal, sales_team_lines_apply)
// and 20260943000950 (sales_team_filter_matches + the readers). A team NEVER
// decides a sale's department — the collabBox folder + the MEX profile do.
//   Телешоп   teleshop   lanes in (phone-ins) · out (prediction) · social
//   Affiliate affiliate  lanes in (AlterCPA pending leads) · out (prediction)
//   Management           no lane, never ranked
// Legacy keys (the teams before 30.09): altercpa_leads → affiliate lane in,
// crm_prediction → lane out on every line — old TV links keep working.
// ============================================================================

export const LANES = ["in", "out", "social"] as const;
export type Lane = typeof LANES[number];
export const isLane = (v: unknown): v is Lane => (LANES as readonly unknown[]).includes(v);

/** The lanes each line takes (sales_team_lines_apply enforces the same). */
export const LINE_LANES: Readonly<Record<string, readonly Lane[]>> = {
  teleshop: ["in", "out", "social"],
  affiliate: ["in", "out"],
};
export const LINE_KEYS = Object.keys(LINE_LANES);
export const MANAGEMENT_KEY = "management";
/** The pre-30.09.2026 team keys, kept as filter aliases (never a target). */
export const LEGACY_TEAM_KEYS = ["altercpa_leads", "crm_prediction"] as const;
export const isLegacyTeam = (k: unknown) => (LEGACY_TEAM_KEYS as readonly unknown[]).includes(k);

/** sales_teams.sort_order as seeded (20260943000900) + the groups outside a
 *  team — the order when a payload carries no sort_order (an older api). */
export const TEAM_SORT_FALLBACK: Readonly<Record<string, number>> = {
  teleshop: 10, affiliate: 20, altercpa_leads: 40, crm_prediction: 41,
  teleshop_unassigned: 60, social_unassigned: 61, management: 90, unassigned: 99, none: 99,
};

/** A team's place on every board: its sort_order, else the fallback, else after the known ones. */
export function teamSortOrder(key: string | null | undefined, sortOrder?: number | null): number {
  if (typeof sortOrder === "number" && Number.isFinite(sortOrder)) return sortOrder;
  return TEAM_SORT_FALLBACK[key ?? "none"] ?? 70;
}

// ── the board's team filter: 'team' | 'team:lane' | 'none' ─────────────────

const TEAM_FILTER_RE = /^[a-z][a-z0-9_]{0,39}(?::(?:in|out|social))?$/;

export interface TeamFilter { raw: string; team: string; lane: Lane | null }

/**
 * ?team= → the RPC's p_team, or an error. Accepts a team key, 'team:lane'
 * (lane in | out | social) and 'none'. Whether the key exists — and whether
 * that team has lanes — is the SQL's call (22023 → 400).
 */
export function parseTeamFilter(raw: string | null | undefined):
  { ok: true; value: TeamFilter | null } | { ok: false; error: string } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: true, value: null };
  if (!TEAM_FILTER_RE.test(v)) return { ok: false, error: "invalid team" };
  const [team, lane] = v.split(":");
  if (lane && (team === "none" || team === MANAGEMENT_KEY || isLegacyTeam(team))) return { ok: false, error: "invalid team" };
  return { ok: true, value: { raw: v, team, lane: (lane as Lane | undefined) ?? null } };
}

/** The twin of public.sales_team_filter_matches (20260943000950) — used by tests and the client. */
export function teamFilterMatches(filter: string | null | undefined, team: string | null, lane: string | null): boolean {
  if (!filter || !filter.trim()) return true;
  if (filter === "none") return team == null;
  if (filter === "altercpa_leads") return team === "altercpa_leads" || (team === "affiliate" && lane === "in");
  if (filter === "crm_prediction") return team === "crm_prediction" || lane === "out";
  if (filter.includes(":")) {
    const [t, l] = filter.split(":");
    return team === t && lane === l;
  }
  return team === filter;
}

// ── GET /sales-people/line-proposal ─────────────────────────────────────────

/** ?days= for the proposal: 7–365, default 60. */
export function parseProposalDays(raw: string | null | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 7 ? Math.min(n, 365) : 60;
}

export type Confidence = "sure" | "likely" | "decide";
export const CONFIDENCES: readonly Confidence[] = ["sure", "likely", "decide"];
export type ProposalBasis = "window" | "history" | "management" | "altercpa_team" | "collabbox_author" | "none";

/** The SQL's rule, for the tests and the UI's explanations: sure ≥ 80 %, likely 60–80 %, else decide; < 5 sales → decide. */
export const THRESHOLDS = { sure: 0.8, likely: 0.6, min_sales: 5 } as const;
export function confidenceOf(share: number | null | undefined, sales: number): Confidence {
  if (share == null || !Number.isFinite(share) || sales < THRESHOLDS.min_sales) return "decide";
  if (share >= THRESHOLDS.sure) return "sure";
  if (share >= THRESHOLDS.likely) return "likely";
  return "decide";
}

export interface ProposalCounts {
  altercpa: number; elyon_crm: number; teleshop_other: number; teleshop_out: number; social: number;
  other: number; total: number;
}
export interface ProposalRow {
  person_id: string;
  display_name: string;
  has_login: boolean;
  is_active: boolean;
  is_manager: boolean;
  identity_kinds: string[];
  current: { team_key: string | null; lane: Lane | null; kind: string | null; memberships: number; lines: number; legacy: boolean };
  basis: ProposalBasis;
  span: "window" | "history";
  counts: ProposalCounts;
  window_sales: number;
  history_sales: number;
  first_sale_at: string | null;
  last_sale_at: string | null;
  line_share: number | null;
  lane_share: number | null;
  share: number | null;
  confidence: Confidence;
  proposed: { team_key: string | null; lane: Lane | null };
  unchanged: boolean;
}
export interface ProposalResponse {
  generated_at: string | null;
  days: number;
  since: string | null;
  thresholds: { sure: number; likely: number; min_sales: number };
  summary: { people: number; sure: number; likely: number; decide: number; unchanged: number; legacy: number; no_team: number };
  rows: ProposalRow[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const laneOrNull = (v: unknown): Lane | null => (isLane(v) ? v : null);
const BASES = new Set<ProposalBasis>(["window", "history", "management", "altercpa_team", "collabbox_author", "none"]);

/** sales_team_line_proposal's jsonb, typed and ordered (sure → likely → decide, then line, lane, sales). */
export function shapeLineProposal(raw: unknown): ProposalResponse {
  const r = obj(raw);
  const th = obj(r.thresholds);
  const rows: ProposalRow[] = (Array.isArray(r.rows) ? r.rows : []).map((x) => {
    const o = obj(x);
    const cur = obj(o.current);
    const c = obj(o.counts);
    const p = obj(o.proposed);
    const conf = CONFIDENCES.includes(o.confidence as Confidence) ? o.confidence as Confidence : "decide";
    return {
      person_id: String(o.person_id ?? ""),
      display_name: str(o.display_name) ?? "—",
      has_login: o.has_login === true,
      is_active: o.is_active !== false,
      is_manager: o.is_manager === true,
      identity_kinds: Array.isArray(o.identity_kinds) ? o.identity_kinds.map(String) : [],
      current: {
        team_key: str(cur.team_key), lane: laneOrNull(cur.lane), kind: str(cur.kind),
        memberships: num(cur.memberships), lines: num(cur.lines), legacy: cur.legacy === true,
      },
      basis: BASES.has(o.basis as ProposalBasis) ? o.basis as ProposalBasis : "none",
      span: (o.span === "history" ? "history" : "window") as ProposalRow["span"],
      counts: {
        altercpa: num(c.altercpa), elyon_crm: num(c.elyon_crm), teleshop_other: num(c.teleshop_other),
        teleshop_out: num(c.teleshop_out), social: num(c.social), other: num(c.other), total: num(c.total),
      },
      window_sales: num(o.window_sales),
      history_sales: num(o.history_sales),
      first_sale_at: str(o.first_sale_at),
      last_sale_at: str(o.last_sale_at),
      line_share: numOrNull(o.line_share),
      lane_share: numOrNull(o.lane_share),
      share: numOrNull(o.share),
      confidence: conf,
      proposed: { team_key: str(p.team_key), lane: laneOrNull(p.lane) },
      unchanged: o.unchanged === true,
    };
  }).filter((x) => x.person_id);
  const rank = (c: Confidence) => CONFIDENCES.indexOf(c);
  rows.sort((a, b) => rank(a.confidence) - rank(b.confidence)
    || teamSortOrder(a.proposed.team_key) - teamSortOrder(b.proposed.team_key)
    || (LANES.indexOf(a.proposed.lane ?? "social") - LANES.indexOf(b.proposed.lane ?? "social"))
    || b.counts.total - a.counts.total
    || a.display_name.localeCompare(b.display_name));
  const count = (f: (x: ProposalRow) => boolean) => rows.filter(f).length;
  return {
    generated_at: str(r.generated_at),
    days: num(r.days) || 60,
    since: str(r.since),
    thresholds: {
      sure: numOrNull(th.sure) ?? THRESHOLDS.sure,
      likely: numOrNull(th.likely) ?? THRESHOLDS.likely,
      min_sales: numOrNull(th.min_sales) ?? THRESHOLDS.min_sales,
    },
    summary: {
      people: rows.length,
      sure: count((x) => x.confidence === "sure"),
      likely: count((x) => x.confidence === "likely"),
      decide: count((x) => x.confidence === "decide"),
      unchanged: count((x) => x.unchanged),
      legacy: count((x) => x.current.legacy),
      no_team: count((x) => x.current.memberships === 0),
    },
    rows,
  };
}

// ── POST /sales-people/line-apply ───────────────────────────────────────────

export interface ApplyRow { person_id: string; team_key: string; lane: Lane | null; membership_id: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_APPLY_ROWS = 500;

/**
 * The body { rows: [{ person_id, team_key, lane?, membership_id? }] } → the
 * rows sales_team_lines_apply takes, or the FIRST refusal (the SQL re-checks
 * everything, all-or-nothing). Lane rules for the known keys: a line needs
 * one of its lanes, management takes none, a legacy key is never a target.
 */
export function parseLineApply(body: unknown): { ok: true; rows: ApplyRow[] } | { ok: false; error: string; index?: number } {
  const b = obj(body);
  const raw = Array.isArray(body) ? body : b.rows;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPLY_ROWS) return { ok: false, error: "bad_rows" };
  const rows: ApplyRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const o = obj(raw[i]);
    const person = o.person_id;
    if (typeof person !== "string" || !UUID_RE.test(person)) return { ok: false, error: "person_not_found", index: i };
    const team = typeof o.team_key === "string" ? o.team_key.trim() : "";
    if (!KEY_RE.test(team)) return { ok: false, error: "team_not_found", index: i };
    if (isLegacyTeam(team)) return { ok: false, error: "legacy_team", index: i };
    const laneRaw = o.lane == null || o.lane === "" ? null : o.lane;
    if (laneRaw !== null && !isLane(laneRaw)) return { ok: false, error: "bad_lane", index: i };
    const lane = laneRaw as Lane | null;
    if (team === MANAGEMENT_KEY && lane !== null) return { ok: false, error: "lane_not_allowed", index: i };
    const allowed = LINE_LANES[team];
    if (allowed && lane === null) return { ok: false, error: "lane_required", index: i };
    if (allowed && lane !== null && !allowed.includes(lane)) return { ok: false, error: "lane_not_allowed", index: i };
    const mid = o.membership_id == null || o.membership_id === "" ? null : o.membership_id;
    if (mid !== null && (typeof mid !== "string" || !UUID_RE.test(mid))) return { ok: false, error: "membership_not_found", index: i };
    const key = `${person.toLowerCase()}|${mid ?? "*"}`;
    if (seen.has(key)) return { ok: false, error: "duplicate_row", index: i };
    seen.add(key);
    rows.push({ person_id: person.toLowerCase(), team_key: team, lane, membership_id: mid ? (mid as string).toLowerCase() : null });
  }
  return { ok: true, rows };
}

/** HTTP status of a sales_team_lines_apply refusal. */
export function statusForLineCode(code: string | null | undefined): number {
  switch (code) {
    case "person_not_found": case "team_not_found": case "membership_not_found": case "actor_not_found":
      return 404;
    case "invalid_rows": case "multiple_lines": case "legacy_team": case "lane_required": case "lane_not_allowed":
      return 422;
    default:
      return 400;
  }
}
