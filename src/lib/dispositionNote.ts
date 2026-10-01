// The written note behind every cancel / trash a person makes (owner 01.10.2026):
// "Опис од најмалку 5 знаци при откажување или корпа, секаде каде тоа го прави човек."
//
// Mirror of supabase/functions/api/dispositionNote.ts — same normalization, same count.
// The server reads its minimum from app_settings.disposition_note_min (0 during the
// rollout window, then 5); the frontend ALWAYS enforces 5, so a fresh bundle never sends
// a note the server would refuse once the setting is switched on.

export const DISPOSITION_NOTE_MIN = 5;
export const DISPOSITION_NOTE_MAX = 1000;

/** Trim and collapse every whitespace run to one space — what the server stores. */
export function normalizeNote(raw: string | null | undefined): string {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim();
}

/** Characters as a person counts them (Unicode code points): "нема" = 4, an emoji = 1. */
export function noteLength(raw: string | null | undefined): number {
  return Array.from(normalizeNote(raw)).length;
}

/** True when the note is long enough (and not too long) for a cancel / trash. */
export function isDispositionNoteValid(raw: string | null | undefined, min: number = DISPOSITION_NOTE_MIN): boolean {
  const n = noteLength(raw);
  return n >= min && n <= DISPOSITION_NOTE_MAX;
}

/** The minimum a server error names ("… at least 7 characters …"), else the default. */
export function noteMinFromMessage(message: string | null | undefined): number {
  const m = String(message ?? '').match(/at least (\d+) characters/);
  return m ? Number(m[1]) : DISPOSITION_NOTE_MIN;
}
