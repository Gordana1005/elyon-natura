import type { TFunction } from 'i18next';
import { apiErrorText } from '@/i18n/apiErrors';
import { STOCK_ERROR_CODES } from '@/lib/stockApi';
import { formatDate } from '@/i18n/dates';

/** The stock api's refusal codes in words (stockCount.err.*); anything else through apiErrorText. */
export function stockErrorText(t: TFunction, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (STOCK_ERROR_CODES as readonly string[]).includes(msg) ? t(`stockCount.err.${msg}`) : apiErrorText(err);
}

/** A moment people read: 28.09.2026 14:05 (Skopje day-first order, any UI language). */
export function stockMoment(iso: string | null | undefined): string {
  if (!iso) return '—';
  // the timestamp itself (not a Date): formatDate shows it on the Skopje clock
  return Number.isNaN(Date.parse(iso)) ? '—' : formatDate(iso, 'dd.MM.yyyy HH:mm');
}
