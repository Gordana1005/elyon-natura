// The TV board's WEB view (owner, 29.09.2026): the web shop has no agents, so
// with the Web filter the board shows the shop itself, live — the day's sales
// (= the Overview's web number, counted like the shop's own panel: "чека потврда"
// included, a failed card checkout and a cancelled order not), how many of them
// still wait for the shop's confirmation and how many it confirmed, every order
// of the day by the shop's own outcome, and the newest orders (time, number,
// city, the main product, source, payment, outcome, денари — no customer name or
// phone). Days the shop mirror has no orders for (30.07–03.09.2026) show the MEX
// web parcels (M… / NTMK…): tracking id, city, COD, "од MEX", no product.
// Data: leaderboard_web_live (migrations 20260942001940 / 1965 / 1967) via GET
// /api/leaderboard?v=2&department=web; the mirror refreshes every 5 minutes.
// Phone / tablet: rem sizes and cards; wall screen (lg): vh sizes and a table.
import { useTranslation } from 'react-i18next';
import { formatDenari } from '@/lib/currency';
import { webConfirmed, type WebLive } from '@/lib/leaderboardV2';
import { StatCard } from './TvBoardParts';
import { hhmm } from './tvBoardHelpers';

/** The shop's outcomes, in the order a web order moves (web_order_outcome). */
const OUTCOMES = ['awaiting', 'preparing', 'courier', 'delivered', 'no_record', 'returned', 'cancelled', 'card_unpaid'] as const;
const OUTCOME_KEY: Record<string, string> = {
  awaiting: 'awaiting', preparing: 'preparing', courier: 'courier', delivered: 'delivered',
  no_record: 'noRecord', returned: 'returned', cancelled: 'cancelled', card_unpaid: 'cardUnpaid',
};
const OUTCOME_TONE: Record<string, string> = {
  awaiting: 'bg-slate-400/15 text-slate-200 ring-slate-300/30',
  preparing: 'bg-indigo-400/15 text-indigo-100 ring-indigo-300/40',
  courier: 'bg-amber-400/15 text-amber-100 ring-amber-300/40',
  delivered: 'bg-emerald-400/15 text-emerald-100 ring-emerald-300/40',
  no_record: 'bg-slate-400/15 text-slate-300 ring-slate-300/30',
  returned: 'bg-pink-400/15 text-pink-100 ring-pink-300/40',
  cancelled: 'bg-rose-400/15 text-rose-100 ring-rose-300/40',
  card_unpaid: 'border border-dashed border-slate-400/60 bg-transparent text-slate-300 ring-transparent',
};
const tone = (k: string) => OUTCOME_TONE[k] ?? OUTCOME_TONE.awaiting;
/** Web table columns (wall screen): time · number · city · product · source · status · денари. */
const WEB_GRID = 'lg:grid-cols-[6%_11%_13%_34%_10%_14%_12%]';

export function TvWebLive({ web, money, isToday, now }: {
  web: WebLive | null;
  money: boolean;
  isToday: boolean;
  now: Date;
}) {
  const { t } = useTranslation();
  if (!web) {
    return <div className="mt-10 text-center text-base text-slate-400 lg:mt-[18vh] lg:text-[2.6vh]">{t('tvBoard.web.unavailable')}</div>;
  }
  const den = (v: number | undefined) => formatDenari(v ?? 0);
  const outcomeLabel = (k: string) => t(`tvBoard.web.outcome.${OUTCOME_KEY[k] ?? 'awaiting'}`);
  const notCounted = Math.max(0, web.all_orders - web.orders);
  const awaiting = web.awaiting ?? 0;
  const confirmed = webConfirmed(web);
  const mexOnly = web.mex_only ?? 0;
  const hasMexRows = mexOnly > 0 || web.latest.some((o) => o.kind === 'mex');
  const lastMins = web.last_order_at ? Math.floor((now.getTime() - Date.parse(web.last_order_at)) / 60000) : null;
  const byOutcome = [...web.by_outcome].sort((a, b) =>
    OUTCOMES.indexOf(a.key as typeof OUTCOMES[number]) - OUTCOMES.indexOf(b.key as typeof OUTCOMES[number]));

  return (
    <section data-testid="tv-web-live" className="flex min-h-0 flex-1 flex-col">
      {/* Tiles — phone 2 per row, small tablet 3, wall screen 6 */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:mb-[1.6vh] lg:grid-cols-6 lg:gap-[1vw]">
        <StatCard testId="web-tile-sales" label={isToday ? t('tvBoard.web.sales') : t('tvBoard.web.salesDay')} value={String(web.orders)}
          sub={t('tvBoard.web.salesSub')} />
        <StatCard testId="web-tile-value" label={t('tvBoard.web.value')} value={money ? den(web.value_mkd) : '—'}
          sub={t('tvBoard.web.paymentSplit', { cod: web.cod, card: web.card })} />
        <StatCard testId="web-tile-awaiting" label={t('tvBoard.web.awaiting')} value={String(awaiting)}
          sub={awaiting > 0 ? (money ? den(web.awaiting_value_mkd) : t('tvBoard.web.awaitingSub')) : undefined} />
        <StatCard testId="web-tile-confirmed" label={t('tvBoard.web.confirmed')} value={String(confirmed)}
          sub={mexOnly > 0 ? t('tvBoard.web.confirmedMexSub', { n: mexOnly }) : t('tvBoard.web.confirmedSub')} />
        <StatCard testId="web-tile-all" label={isToday ? t('tvBoard.web.all') : t('tvBoard.web.allDay')} value={String(web.all_orders)}
          sub={notCounted > 0 ? t('tvBoard.web.allSub', { n: notCounted }) : undefined} />
        <StatCard label={t('tvBoard.web.last')}
          value={web.last_order_at ? hhmm(web.last_order_at) : '—'}
          sub={[
            isToday && lastMins != null && lastMins >= 0 && lastMins < 180 ? t('tvBoard.web.lastAgo', { n: lastMins }) : '',
            web.synced_at ? t('tvBoard.web.synced', { time: hhmm(web.synced_at) }) : '',
          ].filter(Boolean).join(' · ') || undefined} />
      </div>

      {/* A day the shop mirror has no orders for: its sales are the MEX web parcels (the cohort's rule) */}
      {hasMexRows && (
        <div data-testid="web-mex-note" className="mb-3 text-xs text-slate-400 lg:mb-[1.2vh] lg:text-[1.5vh]">
          {t('tvBoard.web.mexNote', { n: mexOnly })}
        </div>
      )}

      {/* The day by the shop's outcome */}
      {byOutcome.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5 text-xs lg:mb-[1.4vh] lg:gap-[0.5vw] lg:text-[1.6vh]">
          {byOutcome.map((o) => (
            <span key={o.key} data-testid={`web-outcome-${o.key}`}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 font-semibold ring-1 lg:px-[0.7vw] lg:py-[0.4vh] ${tone(o.key)}`}>
              {outcomeLabel(o.key)} <span className="tabular-nums">{o.count}</span>
              {money && <span className="font-medium opacity-80 tabular-nums">· {den(o.value_mkd)}</span>}
            </span>
          ))}
        </div>
      )}

      {/* The newest orders */}
      {web.latest.length === 0 ? (
        <div className="mt-8 text-center text-base text-slate-400 lg:mt-[12vh] lg:text-[2.6vh]">
          {isToday ? t('tvBoard.web.none') : t('tvBoard.web.noneDay')}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:overflow-hidden lg:rounded-2xl lg:border lg:border-white/10 lg:bg-white/[0.02]">
          <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 lg:mb-0 lg:px-[1.6vw] lg:py-[1.1vh] lg:text-[1.4vh]">
            {t('tvBoard.web.latest')}
          </div>
          <div className="flex flex-col gap-2 lg:gap-0">
            {web.latest.map((o, i) => {
              const mex = o.kind === 'mex';
              return (
              <div key={`${o.number ?? ''}-${i}`} data-testid="tv-web-order" data-kind={mex ? 'mex' : 'web'}
                className={`rounded-xl border border-white/10 bg-white/[0.03] p-3 lg:grid lg:items-center lg:rounded-none lg:border-0 lg:border-t lg:border-white/5 lg:bg-transparent lg:px-[1.6vw] lg:py-[0.9vh] lg:text-[1.8vh] ${WEB_GRID} ${i % 2 ? 'lg:bg-white/[0.015]' : ''} ${o.counted ? '' : 'opacity-60'}`}>
                {/* phone: time + number + денари on one line */}
                <div className="flex items-baseline justify-between gap-2 lg:contents">
                  <span className="font-semibold tabular-nums text-slate-100">{o.at ? hhmm(o.at) : '—'}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-400 lg:order-none lg:text-[1.5vh]">{o.number ?? ''}</span>
                  <span className="shrink-0 text-right font-bold tabular-nums text-slate-50 lg:order-last">{money ? den(o.total_mkd) : ''}</span>
                </div>
                <div className="mt-1 text-sm text-slate-300 lg:mt-0 lg:truncate lg:text-[1.7vh]">{o.city ?? '—'}</div>
                {/* a MEX parcel with no shop order: MEX does not say what was in it */}
                {mex ? (
                  <div className="mt-0.5 text-sm italic text-slate-400 lg:mt-0 lg:truncate">{t('tvBoard.web.fromMex')}</div>
                ) : (
                  <div className="mt-0.5 text-sm font-medium text-slate-100 lg:mt-0 lg:truncate">
                    {o.item ?? '—'}
                    {o.items > 1 && <span className="ml-1 text-xs font-normal text-slate-400 lg:text-[1.4vh]">{t('tvBoard.web.pieces', { n: o.items })}</span>}
                  </div>
                )}
                <div className="mt-1 text-xs text-slate-400 lg:mt-0 lg:truncate lg:text-[1.5vh]">
                  {[mex ? null : o.source, o.payment === 'card' ? t('tvBoard.web.payCard') : t('tvBoard.web.payCod')].filter(Boolean).join(' · ')}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 lg:mt-0">
                  <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ring-1 lg:px-[0.6vw] lg:py-[0.25vh] lg:text-[1.5vh] ${tone(o.outcome)}`}>
                    {outcomeLabel(o.outcome)}
                  </span>
                  {!o.counted && <span className="text-[11px] text-slate-500 lg:text-[1.3vh]">{t('tvBoard.web.notCounted')}</span>}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
