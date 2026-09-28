import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, PhoneForwarded } from 'lucide-react';
import type { WorkCallbackQueue, WorkResponse } from '@/lib/insightsApi/work';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { formatDmy } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';

type Severity = 'critical' | 'warning' | 'info';
const SEVERITY_ICON = { critical: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const SEVERITY_TEXT: Record<Severity, string> = { critical: STATUS_TEXT.critical, warning: STATUS_TEXT.warning, info: STATUS_TEXT.neutral };
const SEVERITY_BORDER: Record<Severity, string> = {
  critical: 'border-red-300 dark:border-red-900', warning: 'border-amber-300 dark:border-amber-900', info: '',
};

/**
 * The call-again queues NOW (the Call Agains pool — lead callbacks and
 * prediction members, released after 6 days) and the data-quality rail:
 * what the numbers above cannot vouch for yet.
 */
export function WorkQueues({ data, f }: { data: WorkResponse; f: InsightsFormat }) {
  const { t } = f;
  const [now] = useState(() => Date.now());
  const cb = data.callbacks;
  const q = data.quality;

  const items: { key: string; sev: Severity; n: number; hint: string; extra?: string }[] = [];
  if (q) {
    if (q.no_person > 0) {
      items.push({
        key: 'noPerson', sev: 'critical', n: q.no_person, hint: t('insights.calls.quality.hint.noPerson'),
        extra: q.no_person_top.map((x) => `${x.ext ?? '?'} (${x.via === 'altercpa' ? 'AlterCPA' : 'CRM'}) ${f.int(x.n)}`).join(' · '),
      });
    }
    if (q.unmapped_calls > 0) {
      items.push({ key: 'unmappedCalls', sev: 'warning', n: q.unmapped_calls, hint: t('insights.calls.quality.hint.unmappedCalls', { n: f.int(q.unmapped_callers) }) });
    }
    if ((q.no_seller ?? 0) > 0) {
      items.push({ key: 'noSeller', sev: 'warning', n: q.no_seller ?? 0, hint: t('insights.calls.quality.hint.noSeller') });
    }
    if (q.credited_unlisted > 0) {
      items.push({ key: 'creditedUnlisted', sev: 'warning', n: q.credited_unlisted, hint: t('insights.calls.quality.hint.creditedUnlisted') });
    }
    if (q.presence_gap_days > 0) {
      items.push({ key: 'presenceGap', sev: 'warning', n: q.presence_gap_days, hint: t('insights.calls.quality.hint.presenceGap') });
    }
    if (q.days_before_presence > 0) {
      items.push({
        key: 'beforePresence', sev: 'info', n: q.days_before_presence,
        hint: data.meta.presence_since
          ? t('insights.calls.quality.hint.beforePresence', { date: formatDmy(data.meta.presence_since) })
          : t('insights.calls.caveat.presenceNone'),
      });
    }
    if (q.people_no_login > 0) {
      items.push({ key: 'noLogin', sev: 'info', n: q.people_no_login, hint: t('insights.calls.quality.hint.noLogin') });
    }
  }

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {cb && (
        <section aria-labelledby="wk-cb-title" className="space-y-3">
          <div>
            <h3 id="wk-cb-title" className="text-base font-semibold">{t('insights.calls.callbacks.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('insights.calls.callbacks.subtitle', { n: cb.window_days })}</p>
            <ClockCaption clock="now" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Queue title={t('insights.calls.callbacks.leads')} q={cb.leads} now={now} f={f} />
            <Queue title={t('insights.calls.callbacks.prediction')} q={cb.prediction} now={now} f={f} />
          </div>
          {!data.meta.self && (
            <Link to="/assigner" className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <PhoneForwarded className="h-3.5 w-3.5" aria-hidden />{t('insights.calls.callbacks.open')}
            </Link>
          )}
        </section>
      )}

      {q && (
        <section aria-labelledby="wk-q-title" className="space-y-3">
          <h3 id="wk-q-title" className="text-base font-semibold">{t('insights.calls.quality.title')}</h3>
          {items.length === 0 ? (
            <p className={cn('flex items-center gap-2 rounded-xl border bg-card p-4 text-sm', STATUS_TEXT.good)}>
              <CheckCircle2 className="h-4 w-4" aria-hidden />{t('insights.calls.quality.allClear')}
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {items.map((it) => {
                const Icon = SEVERITY_ICON[it.sev];
                return (
                  <li key={it.key} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', SEVERITY_BORDER[it.sev])}>
                    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', SEVERITY_TEXT[it.sev])}>
                      <Icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.common.quality.severity.${it.sev}`)}
                    </span>
                    <h4 className="mt-1 text-sm font-medium leading-snug">{t(`insights.calls.quality.kind.${it.key}`)}</h4>
                    <span className="mt-1 text-2xl font-semibold tabular-nums">{f.int(it.n)}</span>
                    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{it.hint}</p>
                    {it.extra && <p className="mt-1 break-words text-[11px] tabular-nums text-muted-foreground">{it.extra}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function Queue({ title, q, now, f }: { title: string; q: WorkCallbackQueue; now: number; f: InsightsFormat }) {
  const { t } = f;
  const rows: { k: string; v: number; warn?: boolean }[] = [
    { k: t('insights.calls.callbacks.unassigned'), v: q.unassigned, warn: q.unassigned > 0 },
    { k: t('insights.calls.callbacks.over24'), v: q.over_24h, warn: q.over_24h > 0 },
    { k: t('insights.calls.callbacks.expiring'), v: q.expiring_24h, warn: q.expiring_24h > 0 },
  ];
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-semibold">{f.int(q.total)}</p>
      <p className="text-[11px] text-muted-foreground">
        {q.oldest_since ? t('insights.calls.callbacks.oldest', { ago: f.ago(q.oldest_since, now) }) : t('insights.calls.callbacks.none')}
      </p>
      <dl className="mt-3 space-y-1 text-xs">
        {rows.map((r) => (
          <div key={r.k} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{r.k}</dt>
            <dd className={cn('font-semibold tabular-nums', r.warn && 'text-amber-700 dark:text-amber-400')}>{f.int(r.v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
