// Settings → Integrations health (2026-09-28): pure helpers behind
// GET /api/integrations/health and the 7-day no-parcel rule switch. No Deno /
// network imports, so vitest runs it (integrationsHealth.test.ts). The data
// comes from public.integrations_health() (migration 20260939000200).

export const NO_PARCEL_MODES = ["report", "apply"] as const;
export type NoParcelMode = (typeof NO_PARCEL_MODES)[number];

/** POST /integrations/no-parcel-rule/mode body → the new mode, or an error code. */
export function parseModeBody(body: unknown): { ok: true; mode: NoParcelMode } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const mode = (body as Record<string, unknown>).mode;
  if (typeof mode !== "string" || !(NO_PARCEL_MODES as readonly string[]).includes(mode)) return { ok: false, error: "bad_mode" };
  return { ok: true, mode: mode as NoParcelMode };
}

/**
 * apply_no_parcel_rule(_force := false, _dry_run := true) → the numbers the
 * confirm dialog states. Tolerates a missing / malformed payload (the rule's
 * migration not applied yet) by returning null.
 */
export interface NoParcelPreview { candidates: number; to_cancel: number; needs_linking: number; value_eur: number; mode: string; days: number }

export function normalizePreview(raw: unknown): NoParcelPreview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    candidates: n(r.candidates),
    to_cancel: n(r.to_cancel),
    needs_linking: n(r.needs_linking),
    value_eur: n(r.value_eur),
    mode: typeof r.mode === "string" ? r.mode : "report",
    days: n(r.days) || 7,
  };
}

/** ?run_id= for the report: a uuid, or null for "the latest run". */
export function parseRunId(raw: string | null): { ok: true; value: string | null } | { ok: false } {
  if (raw == null || raw === "") return { ok: true, value: null };
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? { ok: true, value: raw } : { ok: false };
}
