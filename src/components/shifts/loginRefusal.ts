import type { TFunction } from 'i18next';
import { formatDmy } from '@/components/insights/shared/period';
import type { ShiftLoginCheck } from '@/lib/shiftsApi';

/**
 * The login gate's refusal in the reader's language. The api sends a `code` (plus today's
 * windows and the next shift) since 01.10.2026; an older api only sends its English `message`.
 */
export function shiftRefusalText(t: TFunction, check: ShiftLoginCheck): string {
  if (!check.code) return check.message || t('login.outsideShift');
  const base = t(`shiftsPage.login.${check.code}`, { windows: (check.windows ?? []).join(', ') });
  const next = check.next_shift
    ? ` ${t('shiftsPage.login.next', { date: formatDmy(check.next_shift.date).slice(0, 5), start: check.next_shift.start })}`
    : '';
  return base + next;
}
