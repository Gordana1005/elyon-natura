import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ListChecks, PhoneCall } from 'lucide-react';
import { useOverviewFormat } from '@/components/insights/overview/useOverviewFormat';
import { cn } from '@/lib/utils';

function Stat({ icon: Icon, label, value, sub, tone }: {
  icon: ComponentType<{ className?: string }>; label: string; value: ReactNode; sub?: ReactNode; tone?: string;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-2.5 py-2 shadow-sm sm:px-3">
      {/* Labels wrap (two lines on a phone) — never cut. */}
      <span className="flex min-w-0 items-start gap-1 text-[11px] font-medium leading-tight text-muted-foreground">
        <Icon className="mt-px hidden h-3.5 w-3.5 shrink-0 sm:block" />
        <span className="min-w-0 break-words">{label}</span>
      </span>
      <span className={cn('mt-auto text-xl font-semibold leading-tight tabular-nums sm:text-2xl', tone ?? 'text-card-foreground')}>{value}</span>
      {sub && <span className="hidden break-words text-[11px] leading-snug text-muted-foreground sm:block">{sub}</span>}
    </li>
  );
}

/**
 * The /calls progress row, the Insights tile look (plan Фаза 11): what is left in the
 * queue on screen · my outcomes today (every outcome writes one call row) · my sales
 * today as the TV board counts them (leaderboard_day_v2 — one calculation everywhere).
 */
export function CallsProgress({ left, leftSub, callsToday, salesToday }: {
  left: number | null;
  leftSub?: string | null;
  callsToday: number | null;
  salesToday: number | null;
}) {
  const { t } = useTranslation();
  const f = useOverviewFormat();
  const n = (v: number | null) => (v == null ? '—' : f.int(v));
  return (
    <section aria-label={t('callsWork.progress.title')}>
      <ul className="grid grid-cols-3 gap-2">
        <Stat icon={ListChecks} label={t('callsWork.progress.left')} value={n(left)} sub={leftSub || t('callsWork.progress.leftSub')} />
        <Stat icon={PhoneCall} label={t('callsWork.progress.calls')} value={n(callsToday)} sub={t('callsWork.progress.callsSub')} />
        <Stat
          icon={CheckCircle2}
          label={t('callsWork.progress.sales')}
          value={n(salesToday)}
          sub={t('callsWork.progress.salesSub')}
          tone={salesToday ? 'text-emerald-600 dark:text-emerald-400' : undefined}
        />
      </ul>
    </section>
  );
}
