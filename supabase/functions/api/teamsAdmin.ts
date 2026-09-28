// Settings → Teams (2026-09-28): pure helpers behind the /api/sales-people/*
// routes — body parsing, the error-code → HTTP map, and the "maybe this is …"
// suggestions of the unmapped queue. No Deno / network imports, so vitest
// runs it (teamsAdmin.test.ts). The SQL side is migration
// 20260939000200_teams_admin_integrations.sql; every write there returns
// {ok:false, error:<code>} for a business-rule refusal.

export const TEAM_ROLES = ["member", "lead"] as const;
export const IDENTITY_KINDS = ["altercpa_user", "collabbox_author", "order_name"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** A real calendar day as YYYY-MM-DD (rejects 2026-02-30). */
export function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !YMD_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * HTTP status for a refusal code from the sales_person_* functions. Unknown
 * codes are 400: the UI shows its own words for the known ones.
 */
export function statusForCode(code: string | null | undefined): number {
  switch (code) {
    case "person_not_found":
    case "identity_not_found":
    case "membership_not_found":
    case "team_not_found":
    case "account_not_found":
    case "login_not_found":
      return 404;
    case "identity_taken":
    case "identity_exists":
    case "login_already_linked":
    case "already_in_team":
    case "later_membership_exists":
      return 409;
    case "login_not_staff":
    case "no_membership_to_end":
      return 422;
    default:
      return 400;
  }
}

/**
 * sales_person_create raises `sales_person_create:<code>` when one of the
 * identities cannot be added (all-or-nothing). Pull the code out of the
 * PostgREST error message.
 */
export function codeFromRaise(message: string | null | undefined): string | null {
  const m = /sales_person_create:([a-z_]+)/.exec(String(message ?? ""));
  return m ? m[1] : null;
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
};

export interface IdentityInput { kind: IdentityKind; account_id: string | null; value: string; note: string | null }

/** One identity from a request body. Values keep their inner spacing — they are matched EXACTLY. */
export function parseIdentity(raw: unknown): { ok: true; value: IdentityInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_identity" };
  const b = raw as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== "string" || !(IDENTITY_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "bad_kind" };
  if (typeof b.value !== "string" || !b.value.trim() || b.value.trim().length > 200) return { ok: false, error: "bad_value" };
  if (b.account_id != null && !isUuid(b.account_id)) return { ok: false, error: "account_not_found" };
  if (kind === "altercpa_user" && !/^#?\s*\d{1,9}$/.test(b.value.trim())) return { ok: false, error: "bad_altercpa_id" };
  return {
    ok: true,
    value: {
      kind: kind as IdentityKind,
      account_id: (b.account_id as string | null | undefined) ?? null,
      value: kind === "altercpa_user" ? b.value.trim().replace(/^#\s*/, "") : b.value,
      note: str(b.note, 300),
    },
  };
}

export interface CreateInput {
  display_name: string;
  user_id: string | null;
  is_manager: boolean;
  notes: string | null;
  team_key: string | null;
  team_from: string | null;
  team_role: string;
  identities: IdentityInput[];
}

export function parseCreate(body: unknown): { ok: true; value: CreateInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const b = body as Record<string, unknown>;
  const name = str(b.display_name, 120);
  if (!name) return { ok: false, error: "bad_name" };
  if (b.user_id != null && !isUuid(b.user_id)) return { ok: false, error: "login_not_found" };
  const teamKey = b.team_key == null || b.team_key === "" ? null : b.team_key;
  if (teamKey !== null && (typeof teamKey !== "string" || !/^[a-z][a-z0-9_]*$/.test(teamKey))) return { ok: false, error: "team_not_found" };
  if (teamKey !== null && !isYmd(b.team_from)) return { ok: false, error: "bad_date" };
  const role = b.team_role == null ? "member" : b.team_role;
  if (typeof role !== "string" || !(TEAM_ROLES as readonly string[]).includes(role)) return { ok: false, error: "bad_role" };
  const rawIds = b.identities == null ? [] : b.identities;
  if (!Array.isArray(rawIds) || rawIds.length > 20) return { ok: false, error: "bad_identities" };
  const identities: IdentityInput[] = [];
  for (const r of rawIds) {
    const p = parseIdentity(r);
    if (!p.ok) return { ok: false, error: p.error };
    identities.push(p.value);
  }
  return {
    ok: true,
    value: {
      display_name: name,
      user_id: (b.user_id as string | null | undefined) ?? null,
      is_manager: b.is_manager === true,
      notes: str(b.notes, 1000),
      team_key: teamKey as string | null,
      team_from: teamKey !== null ? (b.team_from as string) : null,
      team_role: role,
      identities,
    },
  };
}

/**
 * The PATCH body → the jsonb patch sales_person_update takes. Only the keys
 * present are sent; `user_id: null` unlinks the login.
 */
export function parsePatch(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_patch" };
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("display_name" in b) {
    const n = str(b.display_name, 120);
    if (!n) return { ok: false, error: "bad_name" };
    out.display_name = n;
  }
  for (const k of ["is_active", "is_manager"] as const) {
    if (k in b) {
      if (typeof b[k] !== "boolean") return { ok: false, error: "bad_patch" };
      out[k] = b[k];
    }
  }
  if ("notes" in b) {
    if (b.notes !== null && typeof b.notes !== "string") return { ok: false, error: "bad_patch" };
    const n = typeof b.notes === "string" ? b.notes.trim() : "";
    if (n.length > 1000) return { ok: false, error: "bad_patch" };
    out.notes = n || null;
  }
  if ("user_id" in b) {
    if (b.user_id !== null && !isUuid(b.user_id)) return { ok: false, error: "login_not_found" };
    out.user_id = b.user_id;
  }
  if (Object.keys(out).length === 0) return { ok: false, error: "bad_patch" };
  return { ok: true, value: out };
}

export interface MoveInput { team_key: string | null; from: string; role: string; note: string | null }

export function parseMove(body: unknown): { ok: true; value: MoveInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const b = body as Record<string, unknown>;
  const teamKey = b.team_key == null || b.team_key === "" ? null : b.team_key;
  if (teamKey !== null && (typeof teamKey !== "string" || !/^[a-z][a-z0-9_]*$/.test(teamKey))) return { ok: false, error: "team_not_found" };
  if (!isYmd(b.from)) return { ok: false, error: "bad_date" };
  const role = b.role == null ? "member" : b.role;
  if (typeof role !== "string" || !(TEAM_ROLES as readonly string[]).includes(role)) return { ok: false, error: "bad_role" };
  return { ok: true, value: { team_key: teamKey as string | null, from: b.from as string, role, note: str(b.note, 300) } };
}

/** ?days= for the unmapped queue: 1–400, default 90. */
export function parseDays(raw: string | null): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 400) : 90;
}

// ── suggestions ────────────────────────────────────────────────────────────
// HINTS for the unmapped queue — the owner confirms one by adding the
// identity; nothing here is ever applied automatically (operator ruling
// 2026-08-14: merge the same name across scripts, and ONLY that).
//   same  the spelling's script-folded key (the api's agentIdentityKey)
//         equals exactly ONE person's display name or name handle
//   near  no `same` hit, and exactly one person matches loosely: the same
//         first name, and surnames sharing a long prefix once one-letter
//         initials are dropped — the near-misses scripts/seed-sales-people.mjs
//         prints as PROPOSED links (-ич vs -ikj, "Соња Т Тасева", -ова vs
//         -ovska). Shown as "possible match — check".
export interface SuggestPerson {
  id: string;
  display_name: string;
  login_name?: string | null;
  identities?: { kind: string; value: string }[];
}
export interface Suggestion { person_id: string; display_name: string; match: "same" | "near" }

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Loose match of two FOLDED names (see above). Exported for the tests. */
export function isNearName(a: string, b: string): boolean {
  const ta = a.split(" ").filter((t) => t.length > 1);
  const tb = b.split(" ").filter((t) => t.length > 1);
  if (ta.length < 2 || tb.length < 2 || ta[0] !== tb[0]) return false;
  const sa = ta[ta.length - 1], sb = tb[tb.length - 1];
  if (sa === sb) return true;
  return commonPrefix(sa, sb) >= Math.max(5, Math.min(sa.length, sb.length) - 3);
}

export function suggestPerson(
  ext: string | null | undefined,
  people: SuggestPerson[],
  fold: (s: string) => string,
): Suggestion | null {
  if (!ext) return null;
  const key = fold(ext);
  if (!key) return null;
  const same = new Map<string, string>();
  const near = new Map<string, string>();
  for (const p of people) {
    const names = [p.display_name, p.login_name ?? "", ...(p.identities ?? [])
      .filter((i) => i.kind === "order_name" || i.kind === "collabbox_author").map((i) => i.value)]
      .filter(Boolean).map(fold).filter(Boolean);
    if (names.some((n) => n === key)) same.set(p.id, p.display_name);
    else if (names.some((n) => isNearName(key, n))) near.set(p.id, p.display_name);
  }
  if (same.size === 1) {
    const [[person_id, display_name]] = [...same.entries()];
    return { person_id, display_name, match: "same" };
  }
  if (same.size === 0 && near.size === 1) {
    const [[person_id, display_name]] = [...near.entries()];
    return { person_id, display_name, match: "near" };
  }
  return null;
}

/** Adds `suggestion` to each order group of the unmapped payload. */
export function withSuggestions<T extends { ext?: string | null }>(
  groups: T[],
  people: SuggestPerson[],
  fold: (s: string) => string,
): (T & { suggestion: Suggestion | null })[] {
  return groups.map((g) => ({ ...g, suggestion: suggestPerson(g.ext ?? null, people, fold) }));
}
