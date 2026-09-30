import type { TFunction } from 'i18next';
import { hoursMinutes } from './model';

const SKOPJE_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** An instant as Skopje wall-clock "HH:MM". */
export function skopjeHm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : SKOPJE_HM.format(d);
}

/** Minutes → "1 ч 05 мин" / "45 мин" in the reader's language. */
export function duration(t: TFunction, minutes: number): string {
  const { h, m } = hoursMinutes(minutes);
  if (h === 0) return t('shiftsPage.dur.m', { m });
  if (m === 0) return t('shiftsPage.dur.h', { h });
  return t('shiftsPage.dur.hm', { h, m: String(m).padStart(2, '0') });
}

/** "Пон 05.10" for a YYYY-MM-DD (weekday from the calendar, never a timezone). */
export function dayLabel(t: TFunction, ymd: string, dow: number): string {
  return `${t(`shiftsPage.dow.${dow}`)} ${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;
}

/** Team label: the business lanes by key (owner wording), else the server's name, else "Без тим". */
export function teamLabel(t: TFunction, key: string | null, name: string | null): string {
  if (!key) return t('shiftsPage.team.none');
  return t(`shiftsPage.team.${key}`, { defaultValue: name ?? key });
}
