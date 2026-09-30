import i18n from '@/i18n';
import { apiErrorText } from '@/i18n/apiErrors';

/**
 * The shift routes answer `{error: "shifts.<code>[: detail]"}` (invalid | conflict | not_found);
 * the code is translated here, the detail (a validation reason, or the names already on another
 * shift that day) is shown as sent. Anything else goes through the shared apiErrorText.
 */
export function shiftErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = msg.match(/^shifts\.(invalid|conflict|not_found)(?::\s*([\s\S]*))?$/);
  if (!m) return apiErrorText(err);
  const detail = (m[2] ?? '').trim();
  const text = i18n.t(`shiftsPage.errors.${m[1]}`, { detail });
  return detail ? text : text.replace(/[:\s]+$/, '');
}
