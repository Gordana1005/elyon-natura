import { useTranslation } from 'react-i18next';
import { Clock, Phone, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { formatDistanceToNow } from '@/i18n/dates';
import { skopjeClock, skopjeParts } from '@/lib/callsWork/callbacks';
import { formatLocalDisplay, toLocalDial } from '@/lib/callsWork/dial';
import { predictionListLabel } from '@/lib/predictionListLabel';
import type { CallbackDueState, MyCallback, MyCallbacks } from '@/lib/callsWorkApi';
import { cn } from '@/lib/utils';

const SECTION_ORDER: CallbackDueState[] = ['due', 'soon', 'later'];
const SECTION_TONE: Record<CallbackDueState, string> = {
  due: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-200',
  soon: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  later: 'bg-muted text-muted-foreground',
};

function daysWaiting(since: string | null, now: number): number | null {
  if (!since) return null;
  const t = new Date(since).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000));
}

function CallbackCard({ item, now, onOpen }: { item: MyCallback; now: number; onOpen: (item: MyCallback) => void }) {
  const { t } = useTranslation();
  const days = daysWaiting(item.call_again_since, now);
  const due = item.due_at ? new Date(item.due_at) : null;
  const today = skopjeParts(new Date(now)).day;
  const dueText = item.due_state === 'due' || !due
    ? t('callsWork.callbacks.dueNow')
    : skopjeParts(due).day === today
      ? t('callsWork.callbacks.dueAt', { time: skopjeClock(due) })
      : t('callsWork.callbacks.dueOn', { date: skopjeParts(due).day.split('-').reverse().slice(0, 2).join('.'), time: skopjeClock(due) });
  const local = formatLocalDisplay(toLocalDial(item.customer_phone)) || item.customer_phone;
  const where = item.kind === 'order'
    ? [t('callsWork.callbacks.lead'), item.product_name].filter(Boolean).join(' · ')
    : [t('callsWork.callbacks.list'), item.list_name ? predictionListLabel(item.list_name) : null].filter(Boolean).join(' · ');
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm" data-testid="callback-card">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{item.customer_name || t('clientProfile.unknownCustomer')}</div>
          <div className="truncate font-mono text-xs text-muted-foreground tabular-nums">{local}</div>
        </div>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', SECTION_TONE[item.due_state])}>
          {dueText}
        </span>
      </div>
      <div className="min-w-0 space-y-0.5 text-xs text-muted-foreground">
        <div className="truncate" title={where}>{where}</div>
        <div className="break-words">
          {item.last_call_at
            ? t('callsWork.callbacks.lastCall', {
              when: formatDistanceToNow(new Date(item.last_call_at), { addSuffix: true }),
              outcome: item.last_call_outcome ? t(`outcome.${item.last_call_outcome}`, { defaultValue: item.last_call_outcome }) : '—',
            })
            : t('callsWork.callbacks.noCall')}
        </div>
        {days != null && days > 0 && (
          <div className={cn(days >= 3 && 'font-medium text-destructive')}>{t('callsWork.callbacks.waiting', { count: days })}</div>
        )}
      </div>
      <Button size="sm" className="mt-auto w-full gap-1.5" onClick={() => onOpen(item)}>
        <Phone className="h-3.5 w-3.5" /> {t('callsWork.callbacks.open')}
      </Button>
    </li>
  );
}

/**
 * "Повторни повици · Мои" inside /calls (plan Фаза 11 — /call-again merged here). The
 * agent's own callbacks, due now first (longest waiting first), then by due time.
 * Cards on every width — no table, nothing scrolls sideways. Opening one takes the
 * customer to the call screen (a hand-opened client: it claims the callback and owes
 * an answer). Everyone's callbacks are the Assigner's call-agains tab.
 */
export function CallAgainQueue({ data, isLoading, isError, onRetry, onOpen, now = Date.now() }: {
  data: MyCallbacks | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpen: (item: MyCallback) => void;
  now?: number;
}) {
  const { t } = useTranslation();
  if (isLoading && !data) {
    return (
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-busy>
        {Array.from({ length: 3 }, (_, i) => <li key={i}><Skeleton className="h-[132px] rounded-xl" /></li>)}
      </ul>
    );
  }
  if (isError && !data) {
    return (
      <div className="rounded-xl border bg-card p-4 text-sm">
        <p className="text-muted-foreground">{t('callsWork.callbacks.loadFailed')}</p>
        <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" /> {t('callsWork.callbacks.retry')}
        </Button>
      </div>
    );
  }
  const items = data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Clock className="h-6 w-6" />}
        title={t('callsWork.callbacks.emptyTitle')}
        description={t('callsWork.callbacks.emptyDesc')}
        size="lg"
      />
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('callsWork.callbacks.intro')}</p>
      {SECTION_ORDER.map((s) => {
        const rows = items.filter((i) => i.due_state === s);
        if (rows.length === 0) return null;
        return (
          <section key={s} aria-label={t(`callsWork.callbacks.section.${s}`)} className="space-y-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t(`callsWork.callbacks.section.${s}`)}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground">{rows.length}</span>
            </h2>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((item) => <CallbackCard key={item.key} item={item} now={now} onOpen={onOpen} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
