import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Hourglass, Inbox, Loader2, Percent, Target, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Section, Tile } from '@/components/insights/returns/RsBits';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { LoadError } from '@/components/insights/shared/LoadError';
import { isYmd, skopjeToday } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { affiliateLabel } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { apiGetGuaranteeToday, type CohortView, type WebmasterView } from '@/lib/altercpaGuaranteeApi';
import { WebmasterCohortCard } from './WebmasterCohortCard';
import { StateBadge, useSay } from './bits';
import { SENTENCE_TONE_CLASS, cohortSentence, durationText, minutesBetween, rateToneClass, toTargetText } from './guaranteeText';

/** AlterCPA is mirrored until 20:55 Skopje; after that the numbers rest until morning. */
function skopjeHour(now: number) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Skopje', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now))) % 24;
}

/**
 * Денес — the default /altercpa tab (plan 01.10.2026, Фаза 4). One Skopje arrival day
 * (← / → like /insights), the guarantee tiles, a card per webmaster in risk order with its one
 * action sentence and its open leads, yesterday / the day before (late decisions still move
 * them — 508 of 1.777 September approvals landed on a later day) and the stuck open leads.
 * Refetches every minute while the tab is visible.
 */
export function TodayTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const say = useSay();
  const [params, setParams] = useSearchParams();
  const today = skopjeToday();
  const asked = params.get('day');
  const day = isYmd(asked) && asked <= today ? asked : today;
  const names = useWebmasterNames();
  const wmName = (wm: string) => (wm === '(none)' ? t('altercpaGuarantee.noWebmaster') : affiliateLabel(wm, names));

  const q = useQuery({
    queryKey: ['altercpa-guarantee-today', day],
    queryFn: () => apiGetGuaranteeToday({ day, back: 2 }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  const setDay = (d: string) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (d === today) n.delete('day'); else n.set('day', d);
    return n;
  }, { replace: true });

  const now = Date.now();
  const data = q.data;
  // Ages are counted here, against the reader's clock, so they keep moving between refetches.
  const webmasters = useMemo<WebmasterView[]>(() => (data?.webmasters ?? []).map((w) => ({
    ...w,
    open_leads: w.open_leads?.map((l) => ({ ...l, age_min: minutesBetween(l.arrived_at, new Date(now).toISOString()) ?? l.age_min })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [data, Math.floor(now / 60_000)]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodStepper range={{ from: day, to: day }} today={today} onStep={(n) => setDay(n.range.to)} testId="altercpa-day" />
        {day !== today && (
          <Button variant="outline" size="sm" className="h-8" onClick={() => setDay(today)}>{t('altercpaGuarantee.today.backToToday')}</Button>
        )}
      </div>
      {data && (
        <p className="text-xs text-muted-foreground" data-testid="freshness">
          {t('altercpaGuarantee.fresh.line', {
            leads: f.ago(data.freshness.leads_seen_at, now),
            decisions: f.ago(data.freshness.decisions_seen_at, now),
          })}
          {(skopjeHour(now) >= 21 || skopjeHour(now) < 7) && <span> · {t('altercpaGuarantee.fresh.quiet')}</span>}
        </p>
      )}
    </div>
  );

  if (q.isLoading) {
    return <div className="space-y-4">{header}<div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></div>;
  }
  if (q.isError || !data) {
    return <div className="space-y-4">{header}<LoadError text={t('altercpaGuarantee.loadError')} onRetry={() => q.refetch()} /></div>;
  }

  const tot = data.totals;
  const m = tot.math;
  const target = data.meta.target;
  const oldestAge = minutesBetween(tot.oldest_open_at, new Date(now).toISOString());
  const toTarget = toTargetText(m);

  return (
    <div className="space-y-4">
      {header}
      <p className="text-xs text-muted-foreground">{t('altercpaGuarantee.formula', { target })}</p>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6" aria-label={t('altercpaGuarantee.tabs.today')}>
        <Tile icon={Inbox} label={t('altercpaGuarantee.tile.leads')} value={f.int(tot.leads)}
          sub={tot.test_excluded > 0 ? t('altercpaGuarantee.tile.leadsTest', { n: f.int(tot.test_excluded) }) : undefined} />
        <Tile icon={CheckCircle2} label={t('altercpaGuarantee.tile.confirmed')} value={f.int(tot.counted)}
          sub={t('altercpaGuarantee.tile.confirmedSub', { approved: f.int(tot.approved), other: f.int(tot.cancel_other) })} />
        <Tile icon={Percent} label={t('altercpaGuarantee.tile.rate')} value={f.pct(m.rate)} tone={rateToneClass(tot.state, m)}
          sub={t('altercpaGuarantee.tile.rateSub', { target })} />
        <Tile icon={Hourglass} label={t('altercpaGuarantee.tile.open')} value={f.int(tot.open)}
          sub={tot.open > 0 && oldestAge != null ? t('altercpaGuarantee.tile.openOldest', { age: say(durationText(oldestAge)) }) : t('altercpaGuarantee.tile.openNone')} />
        <Tile icon={Target} label={t('altercpaGuarantee.tile.toTarget', { target })} value={say(toTarget)}
          tone={SENTENCE_TONE_CLASS[toTarget.tone]} alert={!m.reachable && tot.state !== 'too_few' ? 'critical' : null}
          sub={t('altercpaGuarantee.tile.toTargetSub', { per10: m.per10 })} />
        <Tile icon={Undo2} label={t('altercpaGuarantee.tile.cancellable')} value={f.int(m.cancellable)}
          sub={t('altercpaGuarantee.tile.cancellableSub', { open: f.int(tot.open) })} />
      </ul>

      {data.stuck.count > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <span className="min-w-0">
              <span className="font-medium">{t('altercpaGuarantee.stuck.title', { n: f.int(data.stuck.count) + (data.stuck.capped ? '+' : '') })}</span>
              <span className="block text-xs text-muted-foreground">
                {t('altercpaGuarantee.stuck.sub', { days: data.meta.settle_days, since: data.stuck.from ? f.period(data.stuck.from, data.stuck.from) : '—' })}
              </span>
            </span>
          </span>
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link to={`/altercpa?tab=leads&from=${data.stuck.from ?? data.stuck.to}&to=${data.stuck.to}&decision=open`}>{t('altercpaGuarantee.stuck.open')}</Link>
          </Button>
        </div>
      )}

      <Section title={t('altercpaGuarantee.today.byWebmaster')} sub={t('altercpaGuarantee.today.byWebmasterSub', { min: data.meta.min_cohort })}>
        {webmasters.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('altercpaGuarantee.today.empty')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {webmasters.map((w) => (
              <WebmasterCohortCard key={w.webmaster} v={w} name={wmName(w.webmaster)} minCohort={data.meta.min_cohort} f={f} />
            ))}
          </ul>
        )}
      </Section>

      {data.previous.length > 0 && (
        <Section title={t('altercpaGuarantee.today.previous')} sub={t('altercpaGuarantee.today.previousSub')}>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.previous.map((p, i) => (
              <PreviousDay key={p.day} label={day === today ? t(i === 0 ? 'altercpaGuarantee.today.yesterday' : i === 1 ? 'altercpaGuarantee.today.dayBefore' : 'altercpaGuarantee.today.earlier') : null}
                totals={p.totals} webmasters={p.webmasters} f={f} wmName={wmName} minCohort={data.meta.min_cohort} onOpen={() => setDay(p.day)} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function PreviousDay({ label, totals, webmasters, f, wmName, minCohort, onOpen }: {
  label: string | null;
  totals: CohortView;
  webmasters: WebmasterView[];
  f: InsightsFormat;
  wmName: (wm: string) => string;
  minCohort: number;
  onOpen: () => void;
}) {
  const { t } = f;
  const say = useSay();
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          <span className="block text-sm font-semibold">{label ? `${label} · ` : ''}{f.period(totals.day, totals.day)}</span>
          <span className="block text-[11px] text-muted-foreground tabular-nums">
            {t('altercpaGuarantee.card.counts', { counted: f.int(totals.counted), leads: f.int(totals.leads), open: f.int(totals.open) })}
          </span>
        </button>
        <span className="flex flex-col items-end gap-1">
          <span className={cn('text-xl font-semibold leading-none tabular-nums', rateToneClass(totals.state, totals.math))}>{f.pct(totals.math.rate)}</span>
          <StateBadge state={totals.state} />
        </span>
      </div>
      {webmasters.length > 0 && (
        <ul className="divide-y text-xs">
          {webmasters.map((w) => {
            const s = cohortSentence(w, minCohort, (x) => f.pct(x));
            return (
              <li key={w.webmaster} className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 py-1.5">
                <span className="min-w-0 break-words font-medium">{wmName(w.webmaster)}</span>
                <span className={cn('tabular-nums font-semibold', rateToneClass(w.state, w.math))}>{f.pct(w.math.rate)}</span>
                <span className={cn('basis-full leading-snug', SENTENCE_TONE_CLASS[s.tone])}>{say(s)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
