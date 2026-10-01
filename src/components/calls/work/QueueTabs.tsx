import { useTranslation } from 'react-i18next';
import { Clock, PhoneCall } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CallsView = 'queue' | 'call-again';

/** /calls has two views: the queue (one customer at a time) and "Повторни повици" (?queue=call-again). */
export function QueueTabs({ view, onChange, dueCount }: { view: CallsView; onChange: (v: CallsView) => void; dueCount: number }) {
  const { t } = useTranslation();
  const tab = (v: CallsView, label: string, Icon: typeof Clock, badge?: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => onChange(v)}
      className={cn(
        'inline-flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors sm:flex-none sm:px-3',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {/* No icon on the narrowest phones — the label is never cut. */}
      <Icon className="hidden h-4 w-4 shrink-0 min-[400px]:block" />
      <span className="min-w-0 leading-tight">{label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 rounded-full bg-purple-600 px-1.5 text-[11px] font-semibold leading-5 text-white tabular-nums">{badge}</span>
      )}
    </button>
  );
  return (
    <div role="tablist" aria-label={t('callsWork.queue.label')} className="flex w-full rounded-lg bg-muted p-1 sm:inline-flex sm:w-auto">
      {tab('queue', t('callsWork.queue.main'), PhoneCall)}
      {tab('call-again', t('callsWork.queue.callAgain'), Clock, dueCount)}
    </div>
  );
}
