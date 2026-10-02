// Bonuses — prediction (Out) milestones (owner 02.10.2026, migration 20260947001100). Pure helpers of
//   GET  /api/settings/bonus          owners: the targets in force + every version
//   PUT  /api/settings/bonus          owners: a target + the € of its three milestones from a day (bonus_prediction_target_set)
//   GET  /api/leaderboard?v=2         the TV board carries bonus_prediction_day(day) as `bonus` (everyone sees the €)
// The SQL decides everything (bonus_prediction_day); this file validates the writer's body and shapes the board's part.

export const BONUS_DEPARTMENTS = ["teleshop_out", "elyon_crm"] as const;
export type BonusDepartment = (typeof BONUS_DEPARTMENTS)[number];

export interface BonusTargetBody {
  department: BonusDepartment;
  valid_from: string;          // YYYY-MM-DD (Skopje day)
  target_mkd: number;          // > 0, whole денари
  m1_eur: number;              // ≥ 0 — unlocked at 1/3 of the target
  m2_eur: number;              // ≥ 0 — at 2/3
  m3_eur: number;              // ≥ 0 — at 3/3
  note: string | null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isRealYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** The PUT body → a validated target, or the error code the api answers with (400). */
export function parseBonusTargetBody(body: unknown): { ok: true; value: BonusTargetBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  const department = String(b.department ?? "");
  if (!(BONUS_DEPARTMENTS as readonly string[]).includes(department)) return { ok: false, error: "bad_department" };
  const validFrom = String(b.valid_from ?? "");
  if (!isRealYmd(validFrom)) return { ok: false, error: "bad_valid_from" };
  const target = num(b.target_mkd);
  if (target == null || target <= 0 || target > 100_000_000) return { ok: false, error: "bad_target" };
  const ms = [num(b.m1_eur), num(b.m2_eur), num(b.m3_eur)];
  if (ms.some((m) => m == null || m < 0 || m > 100_000)) return { ok: false, error: "bad_milestones" };
  const noteRaw = b.note == null ? "" : String(b.note);
  if (noteRaw.length > 500) return { ok: false, error: "note_too_long" };
  return {
    ok: true,
    value: {
      department: department as BonusDepartment,
      valid_from: validFrom,
      target_mkd: Math.round(target),
      m1_eur: Math.round(ms[0]! * 100) / 100,
      m2_eur: Math.round(ms[1]! * 100) / 100,
      m3_eur: Math.round(ms[2]! * 100) / 100,
      note: noteRaw.trim() || null,
    },
  };
}

export interface BonusTargetRow {
  id: string;
  department: string;
  valid_from: string;
  daily_target_mkd: number | string;
  m1_eur: number | string;
  m2_eur: number | string;
  m3_eur: number | string;
  note: string | null;
  created_at: string;
}

/** The versions → { current per department (in force on `today`), history newest first }. */
export function shapeBonusTargets(rows: readonly BonusTargetRow[], today: string) {
  const norm = rows.map((r) => ({
    id: r.id, department: r.department, valid_from: r.valid_from,
    target_mkd: Number(r.daily_target_mkd), m1_eur: Number(r.m1_eur), m2_eur: Number(r.m2_eur), m3_eur: Number(r.m3_eur),
    note: r.note, created_at: r.created_at,
  }));
  const history = [...norm].sort((a, b) => (a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : 0));
  const current: Record<string, (typeof norm)[number] | null> = {};
  for (const d of BONUS_DEPARTMENTS) {
    current[d] = history.find((r) => r.department === d && r.valid_from <= today) ?? null;
  }
  const upcoming = history.filter((r) => r.valid_from > today);
  return { current, upcoming, history };
}

export interface BoardBonusPerson {
  person_id: string | null;
  value_mkd: number;
  share: number | null;
  bonus_eur: number;
  paid_value_mkd: number;
  paid_bonus_eur: number;
}
export interface BoardBonusDept {
  department: BonusDepartment;
  valid_from: string;
  target_mkd: number;
  thresholds_mkd: number[];
  milestones_eur: number[];
  value_mkd: number;
  reached: number;
  pool_eur: number;
  paid_value_mkd: number;
  paid_reached: number;
  paid_pool_eur: number;
  people: BoardBonusPerson[];
}
export interface BoardBonus { day: string; departments: BoardBonusDept[] }

/** bonus_prediction_day's answer → the board's `bonus` (numbers coerced; null when no department has a target). */
export function shapeBoardBonus(rpc: unknown): BoardBonus | null {
  if (!rpc || typeof rpc !== "object") return null;
  const r = rpc as { day?: string; departments?: unknown[] };
  const deps = Array.isArray(r.departments) ? r.departments : [];
  if (!deps.length) return null;
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return {
    day: String(r.day ?? ""),
    departments: deps.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        department: String(x.department) as BonusDepartment,
        valid_from: String(x.valid_from ?? ""),
        target_mkd: n(x.target_mkd),
        thresholds_mkd: (Array.isArray(x.thresholds_mkd) ? x.thresholds_mkd : []).map(n),
        milestones_eur: (Array.isArray(x.milestones_eur) ? x.milestones_eur : []).map(n),
        value_mkd: n(x.value_mkd),
        reached: n(x.reached),
        pool_eur: n(x.pool_eur),
        paid_value_mkd: n(x.paid_value_mkd),
        paid_reached: n(x.paid_reached),
        paid_pool_eur: n(x.paid_pool_eur),
        people: (Array.isArray(x.people) ? x.people : []).map((p) => {
          const y = p as Record<string, unknown>;
          return {
            person_id: y.person_id == null ? null : String(y.person_id),
            value_mkd: n(y.value_mkd),
            share: y.share == null ? null : n(y.share),
            bonus_eur: n(y.bonus_eur),
            paid_value_mkd: n(y.paid_value_mkd),
            paid_bonus_eur: n(y.paid_bonus_eur),
          };
        }),
      };
    }),
  };
}

// ── the month and the return cut (20260947001200) ───────────────────────────

export interface BonusRules { settle_after_days: number; return_tiers: { min_pct: number; cut_pct: number }[] }

/** PUT /settings/bonus/rules body → the rules, or an error code (the SQL writer re-checks). */
export function parseBonusRulesBody(body: unknown): { ok: true; value: BonusRules } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid_body" };
  const b = body as Record<string, unknown>;
  const days = num(b.settle_after_days);
  if (days == null || !Number.isInteger(days) || days < 0 || days > 31) return { ok: false, error: "bad_settle_days" };
  if (!Array.isArray(b.return_tiers) || b.return_tiers.length > 20) return { ok: false, error: "bad_tiers" };
  const tiers: { min_pct: number; cut_pct: number }[] = [];
  for (const t of b.return_tiers) {
    const x = (t ?? {}) as Record<string, unknown>;
    const min = num(x.min_pct);
    const cut = num(x.cut_pct);
    if (min == null || cut == null || min < 0 || min > 100 || cut < 0 || cut > 100) return { ok: false, error: "bad_tiers" };
    tiers.push({ min_pct: Math.round(min * 10) / 10, cut_pct: Math.round(cut * 10) / 10 });
  }
  tiers.sort((a, b) => a.min_pct - b.min_pct);
  for (let i = 1; i < tiers.length; i++) if (tiers[i].min_pct === tiers[i - 1].min_pct) return { ok: false, error: "bad_tiers" };
  return { ok: true, value: { settle_after_days: days, return_tiers: tiers } };
}

/** ?month=YYYY-MM → the month's first day (YYYY-MM-01), else null. */
export function parseMonthParam(raw: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(raw ?? ""));
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? `${m[1]}-${m[2]}-01` : null;
}

/** The cut a return % falls into (the highest tier whose min_pct ≤ return %) — the SQL's twin, for the UI preview. */
export function cutFor(returnPct: number | null, tiers: readonly { min_pct: number; cut_pct: number }[]): number {
  if (returnPct == null) return 0;
  let cut = 0;
  for (const t of tiers) if (returnPct >= t.min_pct) cut = Math.max(cut, t.cut_pct);
  return cut;
}
