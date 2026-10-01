import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDayDmy } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { priorDecisions, type HistoryOrderLike, type PriorDecision } from '@/lib/callsWork/priorDecisions';

/**
 * "Претходни одлуки" — the strip above the /calls toolbar (plan 01.10.2026, Фаза 1): the
 * customer's latest cancel and latest trash, so the next operator knows what happened
 * before dialling. Up to two lines, each with its status dot:
 *   ● Откажа · 28.09.2026 · Марија · Нема пари — „ќе плати по 15-ти“
 *   ● Корпа · 12.08.2026 · автоматски · Недостапен
 * A long note clamps to two lines and opens on tap. Nothing renders without a decision.
 */
export function PriorDecisions({ orders, className }: { orders: HistoryOrderLike[] | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const { cancel, trash } = priorDecisions(orders);
  const rows = [cancel, trash].filter((d): d is PriorDecision => !!d);
  if (rows.length === 0) return null;
  return (
    <section
      aria-label={t('priorDecisions.title')}
      data-testid="prior-decisions"
      className="min-w-0 space-y-1 rounded-xl border border-border/60 bg-card px-3 py-2 shadow-sm"
    >
      {rows.map((d) => <DecisionLine key={d.kind} d={d} />)}
    </section>
  );
}

function DecisionLine({ d }: { d: PriorDecision }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const who = d.auto ? t('priorDecisions.auto') : d.by;
  const head = [
    t(d.kind === 'cancel' ? 'priorDecisions.cancel' : 'priorDecisions.trash'),
    d.at ? formatDayDmy(d.at) : null,
    who,
  ].filter(Boolean).join(' · ');
  const why = [d.reasonLabel, d.note ? t('priorDecisions.quoted', { note: d.note }) : null].filter(Boolean).join(' — ');
  const body = (
    <>
      <span
        aria-hidden
        className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', d.kind === 'cancel' ? 'bg-rose-500' : 'bg-zinc-400 dark:bg-zinc-500')}
      />
      <span className={cn('min-w-0 break-words', d.note && !open && 'line-clamp-2')}>
        <span className="font-semibold text-foreground">{head}</span>
        {why && <span className="text-muted-foreground"> · {why}</span>}
      </span>
    </>
  );
  const cls = 'flex w-full min-w-0 items-start gap-2 text-left text-xs leading-snug';
  const title = d.displayId ? t('priorDecisions.order', { id: d.displayId }) : undefined;
  if (!d.note) {
    return <div className={cls} title={title} data-testid={`prior-${d.kind}`}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      title={title}
      data-testid={`prior-${d.kind}`}
      className={cn(cls, 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
      <span className="sr-only">{t(open ? 'priorDecisions.showLess' : 'priorDecisions.showMore')}</span>
    </button>
  );
}
