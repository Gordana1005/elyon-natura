import { useTranslation } from 'react-i18next';
import { CalendarHeart, CalendarPlus, OctagonAlert, Stethoscope } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatDmy } from '@/components/insights/shared/period';
import type { HrBalance, HrHoliday, HrMe } from '@/lib/hrApi';
import { RequestList } from './RequestList';
import { daysText } from './labels';

/**
 * "Мое" — one's own leave: the year's balance (right · used · planned · waiting · left), the
 * warnings (carry-over expiring on 30.06, the first part of ≥ 12 days not taken yet, personal paid
 * leave over 7), sick days (employer / ФЗОМ), the next holidays and one's own requests.
 */
export function MyLeave({ me, onRequest, onChanged }: { me: HrMe; onRequest: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const b = me.balance;
  if (!me.employee) {
    return (
      <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground shadow-sm">{t('hrPage.my.noEmployee')}</div>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <div className="min-w-0 space-y-4">
        <section className="rounded-xl border bg-card p-4 shadow-sm" aria-labelledby="hr-balance">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="hr-balance" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('hrPage.my.balanceTitle', { year: me.year })}
              </h3>
              <p className="mt-1 text-3xl font-semibold tabular-nums" data-testid="hr-remaining">
                {b ? daysText(b.remaining) : '—'}
                <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">{t('hrPage.my.daysLeft')}</span>
              </p>
            </div>
            <Button type="button" onClick={onRequest} className="h-10">
              <CalendarPlus className="h-4 w-4" aria-hidden /> {t('hrPage.my.request')}
            </Button>
          </div>
          {b && <BalanceTiles b={b} />}
          {b && <Warnings b={b} today={me.today} />}
        </section>

        <section aria-labelledby="hr-my-requests" className="space-y-2">
          <h3 id="hr-my-requests" className="text-sm font-semibold">{t('hrPage.my.requests')}</h3>
          <RequestList requests={me.requests} showName={false} emptyText={t('hrPage.my.noRequests')} onChanged={onChanged} />
        </section>
      </div>

      <div className="min-w-0 space-y-4">
        {b && (b.sick_employer_days > 0 || b.sick_fzom_days > 0) && (
          <section className="rounded-xl border bg-card p-3 shadow-sm">
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><Stethoscope className="h-4 w-4" aria-hidden />{t('hrPage.my.sickTitle')}</h3>
            <p className="text-sm tabular-nums">{t('hrPage.my.sickSplit', { er: b.sick_employer_days, fz: b.sick_fzom_days })}</p>
          </section>
        )}
        <UpcomingHolidays holidays={me.holidays} today={me.today} calendars={me.employee.holiday_calendars} />
      </div>
    </div>
  );
}

export function BalanceTiles({ b }: { b: HrBalance }) {
  const { t } = useTranslation();
  const tiles: [string, number, string?][] = [
    ['entitled', b.entitled],
    ['used', b.used],
    ['planned', b.planned],
    ['pending', b.pending, b.pending > 0 ? 'text-amber-700 dark:text-amber-400' : undefined],
  ];
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map(([k, v, tone]) => (
        <div key={k} className="rounded-lg border bg-muted/30 px-3 py-2">
          <dt className="text-[11px] text-muted-foreground">{t(`hrPage.balance.${k}`)}</dt>
          <dd className={cn('text-lg font-semibold tabular-nums', tone)}>{daysText(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Warnings({ b, today }: { b: HrBalance; today: string }) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (b.carry_expiring > 0) lines.push(t('hrPage.warn.carryExpiring', { n: daysText(b.carry_expiring), date: formatDmy(b.carry_until) }));
  if (!b.first_part_ok && today.slice(5, 7) >= '09' && b.remaining >= 12) lines.push(t('hrPage.warn.firstPart'));
  if (b.personal_paid_over) lines.push(t('hrPage.warn.personalOver', { n: daysText(b.personal_paid_days) }));
  if (b.carry_days > 0) lines.push(t('hrPage.warn.carryInfo', { n: daysText(b.carry_days), date: formatDmy(b.carry_until) }));
  if (!lines.length) return null;
  return (
    <ul className="mt-3 space-y-1">
      {lines.map((l) => (
        <li key={l} className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300">
          <OctagonAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{l}
        </li>
      ))}
    </ul>
  );
}

function UpcomingHolidays({ holidays, today, calendars }: { holidays: HrHoliday[]; today: string; calendars: string[] }) {
  const { t } = useTranslation();
  const next = holidays.filter((h) => h.date >= today && (h.scope === 'all' || calendars.includes(h.scope))).slice(0, 6);
  return (
    <section className="rounded-xl border bg-card p-3 shadow-sm" aria-labelledby="hr-next-holidays">
      <h3 id="hr-next-holidays" className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <CalendarHeart className="h-4 w-4" aria-hidden />{t('hrPage.my.nextHolidays')}
      </h3>
      {next.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('hrPage.my.noHolidays')}</p>
      ) : (
        <ul className="divide-y">
          {next.map((h) => (
            <li key={h.id} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="min-w-0 break-words">{h.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatDmy(h.date).slice(0, 5)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
