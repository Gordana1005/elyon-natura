import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { WebmasterView } from '@/lib/altercpaGuaranteeApi';
import { OpenLeadsList } from './OpenLeadsList';
import { RateBar, StateBadge, useSay } from './bits';
import { SENTENCE_TONE_CLASS, cohortSentence, rateToneClass } from './guaranteeText';

/**
 * One webmaster's cohort for the day: name, the rate against the target (a bar with the target
 * marker), the counts, and ONE sentence that says what to do — confirm N more, how many may still
 * be cancelled, or that the target is out of reach today. The open leads fold out under it.
 */
export function WebmasterCohortCard({ v, name, minCohort, f, defaultOpen = false }: {
  v: WebmasterView;
  name: string;
  minCohort: number;
  f: InsightsFormat;
  defaultOpen?: boolean;
}) {
  const { t } = f;
  const say = useSay();
  const [open, setOpen] = useState(defaultOpen);
  const s = cohortSentence(v, minCohort, (x) => f.pct(x));
  const leads = v.open_leads ?? [];
  return (
    <li className={cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm',
      v.state !== 'too_few' && !v.math.reachable && 'border-red-300 dark:border-red-900')}
      data-testid="wm-card" data-wm={v.webmaster}>
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-0">
          <div className="break-words text-sm font-semibold leading-tight" title={`#${v.webmaster}`}>{name}</div>
          <div className="text-[11px] text-muted-foreground tabular-nums">
            {t('altercpaGuarantee.card.counts', { counted: f.int(v.counted), leads: f.int(v.leads), open: f.int(v.open) })}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={cn('text-2xl font-semibold leading-none tabular-nums', rateToneClass(v.state, v.math))}>{f.pct(v.math.rate)}</span>
          <StateBadge state={v.state} />
        </div>
      </div>
      <RateBar math={v.math} />
      <p className={cn('text-sm font-medium leading-snug', SENTENCE_TONE_CLASS[s.tone])} data-testid="wm-sentence">{say(s)}</p>
      {v.open_leads && v.open > 0 && (
        <div>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            className="inline-flex min-h-9 items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline">
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
            {open ? t('altercpaGuarantee.card.hideOpen') : t('altercpaGuarantee.card.showOpen', { n: f.int(v.open) })}
          </button>
          {open && <div className="mt-1"><OpenLeadsList leads={leads} /></div>}
        </div>
      )}
    </li>
  );
}
