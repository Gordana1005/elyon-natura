// Inbound Teleshop calls (05.11.2026): pure helpers behind /api/voip/inbound-ring* and the PBX's member pull
// GET /api/voip/inbound-members. The data model is migration 20261106100000_inbound_ring_settings.sql:
// one row per LOGIN — mode always | manual | off, plus the manual switch (the "Примам ТВ повици" button).
// No Deno / network imports, so vitest runs it (inboundRing.test.ts).

export type InboundRingMode = "always" | "manual" | "off";
export const MODES: readonly InboundRingMode[] = ["always", "manual", "off"] as const;

export interface RingSetting {
  user_id: string;
  mode: InboundRingMode;
  manual_on: boolean;
}

export interface ExtensionRow {
  extension: string;
  user_id: string;
}

/** The mode from a request body — null for anything that is not one of the three words. */
export function parseMode(v: unknown): InboundRingMode | null {
  return typeof v === "string" && (MODES as readonly string[]).includes(v) ? (v as InboundRingMode) : null;
}

/** The self-toggle body: { on: boolean } (strings "true"/"false" tolerated for a form post). */
export function parseSelfBody(body: unknown): { ok: true; on: boolean } | { ok: false; error: "bad_body" } {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).on : undefined;
  if (typeof raw === "boolean") return { ok: true, on: raw };
  if (raw === "true" || raw === "false") return { ok: true, on: raw === "true" };
  return { ok: false, error: "bad_body" };
}

/** Does this setting ring right now? always, or manual with the switch on. */
export function isEffective(s: Pick<RingSetting, "mode" | "manual_on"> | null | undefined): boolean {
  if (!s) return false;
  return s.mode === "always" || (s.mode === "manual" && s.manual_on === true);
}

/**
 * The queue's members right now: every assigned extension whose login is active and whose setting is effective.
 * Sorted by extension so two pulls with the same truth give the same list (the PBX script diffs it).
 */
export function effectiveMembers(
  exts: ExtensionRow[],
  settings: RingSetting[],
  activeUserIds: Set<string>,
): ExtensionRow[] {
  const byUser = new Map<string, RingSetting>();
  for (const s of settings) byUser.set(s.user_id, s);
  return exts
    .filter((e) => !!e.extension && !!e.user_id && activeUserIds.has(e.user_id) && isEffective(byUser.get(e.user_id)))
    .map((e) => ({ extension: String(e.extension), user_id: e.user_id }))
    .sort((a, b) => a.extension.localeCompare(b.extension));
}

/** Only a 'manual' person may flip their own switch; 'always' and 'off' are the admin's decision. */
export function selfToggleAllowed(s: Pick<RingSetting, "mode"> | null | undefined): { ok: true } | { ok: false; error: "not_manual" } {
  return s?.mode === "manual" ? { ok: true } : { ok: false, error: "not_manual" };
}

/** The HTTP status for a writer's error code. */
export function statusForCode(code?: string | null): number {
  switch (code) {
    case "bad_mode":
    case "bad_body":
      return 400;
    case "no_login":
    case "not_found":
      return 404;
    case "not_manual":
      return 409;
    default:
      return 400;
  }
}

/** "Online" = a presence beat within the window (the same 2 minutes as GET /api/agents/online). */
export function onlineAt(lastSeenAt: string | null | undefined, nowMs: number, windowMs = 2 * 60 * 1000): boolean {
  if (!lastSeenAt) return false;
  const t = new Date(lastSeenAt).getTime();
  return Number.isFinite(t) && nowMs - t <= windowMs;
}

/** "In a call" = the browser reported dialing / in_call / wrapping and that report is not stale (3 min, as agents/online). */
export function inCallAt(
  voipState: string | null | undefined,
  voipStateAt: string | null | undefined,
  nowMs: number,
  staleMs = 3 * 60 * 1000,
): boolean {
  if (!voipState || !["dialing", "in_call", "wrapping"].includes(voipState)) return false;
  if (!voipStateAt) return false;
  const t = new Date(voipStateAt).getTime();
  return Number.isFinite(t) && nowMs - t <= staleMs;
}

/** The PBX's signed pull: sig = HMAC_SHA256(key, "inbound|<exp>"), exp in the future. The message to sign. */
export function inboundMembersMessage(exp: number): string {
  return `inbound|${exp}`;
}
