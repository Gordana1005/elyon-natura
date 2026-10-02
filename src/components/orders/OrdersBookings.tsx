import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDenari } from '@/lib/currency';
import { sourceColorVar } from '@/components/insights/overview/palette';
import { departmentLabel } from '@/lib/orderSource';
import { fmtCount, skopjeDayTime } from '@/lib/ordersList/rowModel';
import { BOOKINGS_PREVIEW_ROWS, ddMm } from '@/lib/ordersList/bookings';
import { skopjeYmd } from '@/lib/skopjeTime';
import type { OrderBooking, OrderBookingsResponse } from '@/lib/api';
import { DeptLine } from './OrdersList';

/** The section's anchor (the "+N во collabBox" chip jumps here). */
export const BOOKINGS_SECTION_ID = 'orders-bookings';

/**
 * "Внесено во collabBox — чека MEX пратка" (owner, Mile, 02.10.2026: "Треба да се гледат да").
 *
 * The collabBox bookings for the list's period / department / seller / search: sales the
 * operators booked in collabBox whose MEX parcel does not exist yet. The Overview and the TV
 * board already count them; /orders lists only real order rows, so without this a filter like
 * "Телешоп – Lead out · today" read 0 while the board showed the sales. Read-only — a booking
 * has no order to open; it becomes one when MEX creates the parcel.
 *
 * A compact table from md (columns join as the screen widens: the seller at lg, the folder and
 * the document at xl — before that they sit under the customer / the department), cards below
 * md; the first BOOKINGS_PREVIEW_ROWS, then "Прикажи ги сите". Nothing at all when there are none.
 */
export function OrdersBookings({ data, error }: { data: OrderBookingsResponse | undefined; error?: boolean }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  if (error) {
    return <p className="px-1 text-[11px] text-muted-foreground" data-testid="bookings-error">{t('ordersList.bookings.loadError')}</p>;
  }
  if (!data || data.total === 0) return null;
  const rows = all ? data.rows : data.rows.slice(0, BOOKINGS_PREVIEW_ROWS);
  const more = data.rows.length > BOOKINGS_PREVIEW_ROWS;
  return (
    <section id={BOOKINGS_SECTION_ID} aria-labelledby={`${BOOKINGS_SECTION_ID}-title`} data-testid="bookings-section"
      className="min-w-0 scroll-mt-3 overflow-hidden rounded-xl border border-amber-600/25 bg-card shadow-sm">
      <header className="space-y-2 border-b bg-amber-50/60 px-3 py-2.5 dark:bg-amber-500/10 md:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ClipboardList className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
          <h2 id={`${BOOKINGS_SECTION_ID}-title`} className="min-w-0 break-words text-sm font-semibold leading-snug">
            {t('ordersList.bookings.title')}
          </h2>
          <span className="rounded-full bg-amber-600/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-900 dark:text-amber-300" data-testid="bookings-total">
            {fmtCount(data.total)}
          </span>
        </div>
        <ul className="flex flex-wrap gap-1.5" aria-label={t('ordersList.bookings.col.department')}>
          {Object.entries(data.by_department).map(([dept, n]) => (
            <li key={dept} className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs">
              <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(dept) }} aria-hidden />
              <span className="min-w-0 break-words leading-tight">{departmentLabel(t, dept) ?? dept}</span>
              <span className="font-semibold tabular-nums">{fmtCount(n)}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {t('ordersList.bookings.hint')}
          {data.clamped && <> {t('ordersList.bookings.clamped', { days: data.lookback_days })}</>}
        </p>
      </header>

      <BookingsTable rows={rows} />
      <ul className="divide-y md:hidden" aria-label={t('ordersList.bookings.title')}>
        {rows.map((b) => <BookingCard key={b.doc_number} b={b} />)}
      </ul>

      {more && (
        <div className="border-t px-3 py-2 text-center">
          <button type="button" onClick={() => setAll((v) => !v)} data-testid="bookings-more"
            className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-medium text-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8">
            {all ? t('ordersList.bookings.showLess') : t('ordersList.bookings.showAll', { count: data.rows.length })}
          </button>
        </div>
      )}
    </section>
  );
}

/** "се испраќа dd.MM" when collabBox dates the document (the dispatch day) after the booking day. */
function ShipsLine({ b, className }: { b: OrderBooking; className?: string }) {
  const { t } = useTranslation();
  const bookedYmd = b.booked_at ? skopjeYmd(b.booked_at) : '';
  if (!b.dispatch_day || !bookedYmd || b.dispatch_day <= bookedYmd) return null;
  return (
    <span className={cn('text-[11px] text-muted-foreground', className)} title={t('ordersList.bookings.shipsTitle')}>
      {t('ordersList.bookings.ships', { day: ddMm(b.dispatch_day) })}
    </span>
  );
}

function BookingsTable({ rows }: { rows: OrderBooking[] }) {
  const { t } = useTranslation();
  const th = 'px-2 py-2 text-left align-bottom font-medium';
  return (
    <div className="hidden min-w-0 md:block">
      <table className="w-full table-fixed text-[13px]">
        <caption className="sr-only">{t('ordersList.bookings.title')}</caption>
        <thead className="bg-muted/40 text-[11px] text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className={cn(th, 'w-[92px] pl-3 md:pl-4')}>{t('ordersList.bookings.col.booked')}</th>
            <th scope="col" className={th}>{t('ordersList.bookings.col.customer')}</th>
            <th scope="col" className={cn(th, 'hidden w-[150px] xl:table-cell')}>{t('ordersList.bookings.col.folder')}</th>
            <th scope="col" className={cn(th, 'w-[140px] lg:w-[156px]')}>{t('ordersList.bookings.col.department')}</th>
            <th scope="col" className={cn(th, 'hidden w-[140px] lg:table-cell')}>{t('ordersList.bookings.col.seller')}</th>
            <th scope="col" className={cn(th, 'w-[88px] text-right')}>{t('ordersList.bookings.col.value')}</th>
            <th scope="col" className={cn(th, 'hidden w-[172px] pr-3 xl:table-cell md:pr-4')}>{t('ordersList.bookings.col.doc')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const when = skopjeDayTime(b.booked_at);
            return (
              <tr key={b.doc_number} className="border-b align-top last:border-0" data-testid="booking-row">
                <td className="py-2 pl-3 pr-2 md:pl-4">
                  <div className="font-semibold tabular-nums">{when.time || '—'}</div>
                  <div className="text-[11px] tabular-nums text-muted-foreground">{when.day}</div>
                </td>
                <td className="min-w-0 px-2 py-2">
                  <div className="break-words font-medium leading-snug">{b.customer_name || '—'}</div>
                  {b.phone8 && <div className="break-all font-mono text-[11px] text-muted-foreground">{b.phone8}</div>}
                  {/* md–lg: no seller column yet; md–xl: no document column yet */}
                  <div className="break-words text-xs text-muted-foreground lg:hidden">
                    {t('ordersList.bookings.col.seller')}: <span className="text-foreground">{b.seller_name || '—'}</span>
                  </div>
                  <div className="break-all font-mono text-[10px] leading-tight text-muted-foreground xl:hidden">{b.doc_number}</div>
                </td>
                <td className="hidden px-2 py-2 xl:table-cell">
                  <div className="break-words leading-snug">{b.folder || '—'}</div>
                  <ShipsLine b={b} className="block" />
                </td>
                <td className="px-2 py-2">
                  <DeptLine o={{ department: b.department }} />
                  <div className="break-words text-[11px] leading-snug text-muted-foreground xl:hidden">{b.folder}</div>
                  <ShipsLine b={b} className="block xl:hidden" />
                </td>
                <td className="hidden break-words px-2 py-2 lg:table-cell">{b.seller_name || '—'}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums">{formatDenari(b.value_mkd)}</td>
                <td className="hidden break-all px-2 py-2 pr-3 font-mono text-[11px] text-muted-foreground xl:table-cell md:pr-4">{b.doc_number}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BookingCard({ b }: { b: OrderBooking }) {
  const { t } = useTranslation();
  const when = skopjeDayTime(b.booked_at);
  return (
    <li className="min-w-0 space-y-1 px-3 py-2.5" data-testid="booking-card">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <DeptLine o={{ department: b.department }} compact />
          {b.folder && <span className="min-w-0 break-words text-[11px] text-muted-foreground">{b.folder}</span>}
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{formatDenari(b.value_mkd)}</span>
      </div>
      <div className="break-words text-sm font-semibold leading-snug">{b.customer_name || '—'}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {b.phone8 && <><span className="font-mono">{b.phone8}</span><span aria-hidden>·</span></>}
        <span className="break-all font-mono">{b.doc_number}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{when.day.slice(0, 5)} {when.time}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="break-words">{t('ordersList.bookings.col.seller')}: <span className="text-foreground">{b.seller_name || '—'}</span></span>
        <ShipsLine b={b} />
      </div>
    </li>
  );
}
