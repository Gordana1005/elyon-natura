import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Truck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { statusLabel } from '@/types';
import { MEX_TONE_CLASS, mexBadge } from '@/lib/ordersList/rowModel';
import type { CohortState, GuaranteeDecision, GuaranteeMath } from '@/lib/altercpaGuaranteeApi';
import { decisionKey } from '@/lib/altercpaGuaranteeApi';
import { durationText, type Sentence } from './guaranteeText';

/** A Sentence rendered through i18n. */
export function useSay() {
  const { t } = useTranslation();
  return (s: Sentence) => t(s.key, s.vars);
}

/** "2 ч 10 мин" from minutes. */
export function Dur({ min }: { min: number | null | undefined }) {
  const say = useSay();
  return <>{say(durationText(min))}</>;
}

const STATE_CLASS: Record<CohortState, string> = {
  met: 'border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  settling: 'border-sky-500/30 bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  below: 'border-red-500/40 bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  stuck: 'border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  too_few: 'border-dashed text-muted-foreground',
};

/** The cohort's state as a pill (a word, never colour alone). */
export function StateBadge({ state, className }: { state: CohortState; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight', STATE_CLASS[state], className)}>
      {t(`altercpaGuarantee.state.${state === 'too_few' ? 'tooFew' : state}`)}
    </span>
  );
}

/** The rate as a bar against the target marker. */
export function RateBar({ math, className }: { math: GuaranteeMath; className?: string }) {
  const { t } = useTranslation();
  const rate = math.rate ?? 0;
  // The scale tops out a bit over the target so the marker never sits at the edge.
  const top = Math.max(0.6, (math.target / 100) * 1.6, rate);
  const w = Math.min(1, rate / top);
  const mark = Math.min(1, math.target / 100 / top);
  const under = math.need > 0;
  return (
    <span className={cn('relative block h-2 w-full overflow-visible rounded-full bg-muted', className)}
      role="img" aria-label={t('altercpaGuarantee.card.barAria', { rate: (rate * 100).toFixed(1), target: math.target })}>
      <span className={cn('block h-full rounded-full', math.leads === 0 ? 'bg-muted' : under ? 'bg-red-500/80' : 'bg-emerald-500/80')}
        style={{ width: `${w * 100}%` }} />
      <span className="absolute -top-1 h-4 w-0.5 rounded bg-foreground/70" style={{ left: `calc(${mark * 100}% - 1px)` }} aria-hidden />
    </span>
  );
}

/** The CRM order: its number (→ /orders) and status. */
export function CrmChip({ displayId, status }: { displayId: string | null; status: string | null }) {
  const { t } = useTranslation();
  if (!displayId) return <span className="text-xs text-muted-foreground">{t('altercpaGuarantee.open.noOrder')}</span>;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Link to={`/orders?search=${encodeURIComponent(displayId)}&view=all`}
        className="font-mono text-xs text-primary underline-offset-2 hover:underline">{displayId}</Link>
      {status && <span className="text-[11px] text-muted-foreground">{statusLabel(status)}</span>}
    </span>
  );
}

/** The MEX parcel as MEX sees it (labels of /orders). */
export function MexChip({ statusId, trackingId }: { statusId: number | null; trackingId: string | null }) {
  const { t } = useTranslation();
  const b = mexBadge({ mex_status_id: statusId, mex_tracking_id: trackingId });
  if (b.group === 'no_parcel') {
    return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', MEX_TONE_CLASS.none)}>{t('ordersList.mex.noParcelShort')}</span>;
  }
  const name = b.statusId != null
    ? t(`customer360.mexStatus.${b.statusId}`, { defaultValue: t('ordersList.mex.unknown', { id: b.statusId }) })
    : t('ordersList.mex.unknown', { id: '?' });
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight', MEX_TONE_CLASS[b.tone])}>
      <Truck className="h-3 w-3 shrink-0" aria-hidden />
      <span className="break-words">{name}</span>
    </span>
  );
}

const DECISION_CLASS: Record<string, string> = {
  approved: 'border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  cancelOther: 'border-teal-600/30 bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
  cancelled: 'border-red-500/40 bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  trashed: 'border-slate-400/50 bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  open: 'border-sky-500/30 bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
};

/** AlterCPA's decision on a lead (Отворена when none yet). */
export function DecisionBadge({ decision }: { decision: GuaranteeDecision | null }) {
  const { t } = useTranslation();
  const k = decisionKey(decision);
  return (
    <span className={cn('inline-flex max-w-full items-center break-words rounded-full border px-2 py-0.5 text-left text-[11px] font-medium leading-tight', DECISION_CLASS[k])}>
      {t(`altercpaGuarantee.decision.${k}`)}
    </span>
  );
}

const SKOPJE = 'Europe/Skopje';
const hm = new Intl.DateTimeFormat('en-GB', { timeZone: SKOPJE, hour: '2-digit', minute: '2-digit', hour12: false });
const dmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SKOPJE, day: '2-digit', month: '2-digit' });

/** HH:mm in Skopje. */
export const skopjeHm = (iso: string | null | undefined) => (iso ? hm.format(new Date(iso)) : '—');
/** dd.MM HH:mm in Skopje. */
export const skopjeDmHm = (iso: string | null | undefined) =>
  iso ? `${dmFmt.format(new Date(iso)).replace(/\//g, '.')} ${hm.format(new Date(iso))}` : '—';
