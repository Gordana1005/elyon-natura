import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, FlaskConical, History, Loader2, Percent } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tile } from '@/components/insights/returns/RsBits';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { LoadError } from '@/components/insights/shared/LoadError';
import { addDays, daysBetween, isYmd, skopjeToday, type DayRange } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { affiliateLabel } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { apiGetGuaranteeRates } from '@/lib/altercpaGuaranteeApi';
import { RatesMatrix } from './guarantee/RatesMatrix';
import { RatesDayCards } from './guarantee/RatesDayCards';
import { CohortDrillSheet } from './guarantee/CohortDrillSheet';

export const RATES_MAX_DAYS = 92;
const PRESETS = ['7', '14', '30', 'month'] as const;
type Preset = (typeof PRESETS)[number];

/** A preset's Skopje days, inclusive, ending today. */
export function ratesPresetRange(p: Preset, today: string): DayRange {
  if (p === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  return { from: addDays(today, -(Number(p) - 1)), to: today };
}

/**
 * The period of Стапки from the URL (Skopje days — never the browser's UTC date: at 00:30 in
 * Skopje the day is already the new one). Default the last 14 days; a notification's ?date=
 * older than the period stretches it back to that day; never past today, at most 92 days.
 */
export function ratesRange(params: URLSearchParams, today: string): DayRange {
  const f = params.get('from');
  const t = params.get('to');
  let r: DayRange = isYmd(f) && isYmd(t) ? { from: f, to: t } : ratesPresetRange('14', today);
  if (r.from > r.to) r = { from: r.to, to: r.from };
  if (r.to > today) r = { ...r, to: today };
  if (r.from > r.to) r = { ...r, from: r.to };
  const d = params.get('date');
  if (isYmd(d) && d < r.from) r = { ...r, from: d };
  if (isYmd(d) && d > r.to && d <= today) r = { ...r, to: d };
  if (daysBetween(r.from, r.to) > RATES_MAX_DAYS - 1) r = { ...r, from: addDays(r.to, -(RATES_MAX_DAYS - 1)) };
  return r;
}

/**
 * Стапки (plan 01.10.2026, Фаза 4) — the guarantee per Skopje ARRIVAL day and webmaster:
 * (approved + cancel_other) ÷ every MK lead, test leads apart. A matrix from xl, a card per day
 * below; a cell opens the cohort's sheet (?wm=&date= — the notification links land on it).
 * The old sticky-CRM number stays one release as the muted "Стар метод" tile.
 */
export function RatesTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const [params, setParams] = useSearchParams();
  const today = skopjeToday();
  const range = ratesRange(params, today);
  const names = useWebmasterNames();
  const wmName = (wm: string) => (wm === '(none)' ? t('altercpaGuarantee.noWebmaster') : affiliateLabel(wm, names));

  const q = useQuery({
    queryKey: ['altercpa-guarantee-rates', range.from, range.to],
    queryFn: () => apiGetGuaranteeRates(range.from, range.to),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  const patch = (fn: (n: URLSearchParams) => void) => setParams((p) => { const n = new URLSearchParams(p); fn(n); return n; }, { replace: true });
  const setRange = (r: DayRange) => patch((n) => { n.set('from', r.from); n.set('to', r.to); });
  const activePreset = PRESETS.find((p) => {
    const pr = ratesPresetRange(p, today);
    return pr.from === range.from && pr.to === range.to;
  });

  const selWm = params.get('wm');
  const selDate = params.get('date');
  const selected = selWm && isYmd(selDate) ? { day: selDate, wm: selWm } : null;
  const pick = (day: string, wm: string) => patch((n) => { n.set('wm', wm); n.set('date', day); });
  const close = () => patch((n) => { n.delete('wm'); n.delete('date'); });

  const data = q.data;
  const wmCols = useMemo(() => (data?.webmasters ?? []).map((w) => w.webmaster), [data]);
  const selDay = selected && data ? data.days.find((d) => d.day === selected.day) ?? null : null;

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <PeriodStepper range={range} today={today} onStep={(n) => setRange(n.range)} testId="rates-period" />
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('altercpaGuarantee.rates.period')}>
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => setRange(ratesPresetRange(p, today))} aria-pressed={activePreset === p}
            className={cn('min-h-8 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-muted',
              activePreset === p && 'border-primary bg-primary/10 text-primary')}>
            {p === 'month' ? t('altercpaGuarantee.rates.presetMonth') : t('altercpaGuarantee.rates.presetDays', { n: Number(p) })}
          </button>
        ))}
      </div>
    </div>
  );

  if (q.isLoading) {
    return <div className="space-y-4">{controls}<div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></div>;
  }
  if (q.isError || !data) {
    return <div className="space-y-4">{controls}<LoadError text={t('altercpaGuarantee.loadError')} onRetry={() => q.refetch()} /></div>;
  }

  const s = data.summary;
  const target = data.meta.target;
  const settledTone = s.settled.rate == null ? undefined
    : s.settled.rate * 100 >= target ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  const hasLeads = data.days.some((d) => d.totals.leads + d.totals.test_excluded > 0);

  return (
    <div className="space-y-4">
      {controls}
      <p className="text-xs text-muted-foreground">{t('altercpaGuarantee.rates.explainer', { target, days: data.meta.settle_days })}</p>

      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('altercpaGuarantee.tabs.rates')}>
        <Tile icon={Percent} label={t('altercpaGuarantee.rates.tileSettled')} value={f.pct(s.settled.rate)} tone={settledTone}
          sub={t('altercpaGuarantee.rates.tileSettledSub', { counted: f.int(s.settled.counted), leads: f.int(s.settled.leads), days: data.meta.settle_days })} />
        <Tile icon={CalendarX2} label={t('altercpaGuarantee.rates.tileUnder')} value={f.int(s.days_under)}
          alert={s.days_under > 0 ? 'warning' : null}
          sub={t('altercpaGuarantee.rates.tileUnderSub', { min: data.meta.min_cohort, n: f.int(s.cohorts_judged) })} />
        <Tile icon={FlaskConical} label={t('altercpaGuarantee.rates.tileTest')} value={f.int(s.test_excluded)}
          sub={t('altercpaGuarantee.rates.tileTestSub')} />
        <Tile icon={History} label={t('altercpaGuarantee.rates.tileOld')} value={f.pct(s.crm_sticky.rate)} tone="text-muted-foreground"
          sub={t('altercpaGuarantee.rates.tileOldSub')} />
      </ul>

      {!hasLeads ? (
        <p className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">{t('altercpaGuarantee.rates.empty')}</p>
      ) : (
        <>
          <div className="hidden rounded-xl border bg-card p-2 shadow-sm xl:block">
            <RatesMatrix days={data.days} webmasters={wmCols} wmName={wmName} f={f} onPick={pick} selected={selected} />
          </div>
          <div className="xl:hidden">
            <RatesDayCards days={data.days} wmName={wmName} f={f} onPick={pick} />
          </div>
        </>
      )}

      <CohortDrillSheet day={selDay} wm={selected?.wm ?? null} wmName={wmName} f={f} minCohort={data.meta.min_cohort} onClose={close} />
    </div>
  );
}
