import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, XCircle, type LucideIcon } from 'lucide-react';
import type { OverviewAttention, OverviewFeedStatus, OverviewFreshness } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TONE_TEXT } from './palette';
import type { OverviewFormat } from './useOverviewFormat';

const STATUS: Record<OverviewFeedStatus, { icon: LucideIcon; tone: string; key: string }> = {
  ok: { icon: CheckCircle2, tone: TONE_TEXT.good, key: 'ok' },
  stale: { icon: Clock, tone: TONE_TEXT.warning, key: 'stale' },
  failed: { icon: XCircle, tone: TONE_TEXT.critical, key: 'failed' },
  'n/a': { icon: CircleSlash, tone: TONE_TEXT.neutral, key: 'na' },
};

/** How old each feed is, re-read every 30 s so "N min ago" never goes stale. */
export function FreshnessStrip({
  feeds, attention, asOf, f,
}: { feeds: OverviewFreshness[]; attention: OverviewAttention[]; asOf: string | null; f: OverviewFormat }) {
  const { t } = f;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const needs = attention.reduce((a, x) => a + (x.count > 0 ? 1 : 0), 0);
  const critical = attention.some((x) => x.count > 0 && x.severity === 'critical');

  return (
    <section id="overview-freshness" aria-label={t('overview.fresh.title')} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.fresh.title')}</span>
      {feeds.map((fd) => {
        const s = STATUS[fd.status] ?? STATUS['n/a'];
        const Icon = s.icon;
        const when = fd.status === 'n/a' ? t('overview.fresh.status.na') : f.ago(fd.last_ok_at, now);
        return (
          <span
            key={fd.feed}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs',
              fd.status === 'failed' && 'border-red-300 dark:border-red-900',
              fd.status === 'stale' && 'border-amber-300 dark:border-amber-900',
            )}
            title={[t(`overview.fresh.status.${s.key}`), fd.detail].filter(Boolean).join(' · ')}
          >
            <Icon className={cn('h-3.5 w-3.5 shrink-0', s.tone)} aria-hidden />
            <span className="font-medium">{t(`overview.fresh.feed.${fd.feed}`)}</span>
            <span className="tabular-nums text-muted-foreground">{when}</span>
            {fd.status !== 'ok' && <span className={cn('font-medium', s.tone)}>· {t(`overview.fresh.status.${s.key}`)}</span>}
          </span>
        );
      })}
      <span className="ml-auto flex items-center gap-3">
        {needs > 0 && (
          <a
            href="#overview-attention"
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              critical ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            {t('overview.attention.jump', { n: needs })}
          </a>
        )}
        {asOf && <span className="text-[11px] tabular-nums text-muted-foreground">{t('overview.asOf', { time: asOf })}</span>}
      </span>
    </section>
  );
}
