import { Circle, CircleDashed, Clock, Coffee, Minus, type LucideIcon } from 'lucide-react';
import type { PeopleBuckets, PeopleMeasures, PeoplePerson, PeopleSourceKey, PresenceState } from '@/lib/insightsApi/agents';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { sourceColorVar } from '../overview/palette';
import { StackedBar, type StackSegment } from '../shared/StackedBar';
import { COHORT_HATCH, COHORT_TONE, OUTSIDE_TONE } from '../shared/cohortPalette';
import { COHORT_ICON } from '../shared/CohortBar';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { PEOPLE_SOURCES, type PartKey } from './model';

/** The Overview's presence vocabulary — a dot colour + a distinct shape + a word. */
export const PRESENCE: Record<PresenceState, { icon: LucideIcon; tone: string; key: string }> = {
  online: { icon: Circle, tone: 'fill-emerald-500 text-emerald-500', key: 'online' },
  idle: { icon: Clock, tone: 'text-amber-600 dark:text-amber-400', key: 'idle' },
  break: { icon: Coffee, tone: 'text-sky-600 dark:text-sky-400', key: 'break' },
  offline: { icon: CircleDashed, tone: 'text-muted-foreground', key: 'offline' },
  'n/a': { icon: Minus, tone: 'text-muted-foreground', key: 'na' },
};

export function PresenceIcon({ state, f }: { state: PresenceState; f: InsightsFormat }) {
  const p = PRESENCE[state] ?? PRESENCE['n/a'];
  const Icon = p.icon;
  return (
    <>
      <Icon className={cn('h-3 w-3 shrink-0', p.tone)} aria-hidden />
      <span className="sr-only">({f.t(`overview.teams.state.${p.key}`)})</span>
    </>
  );
}

/** The bar's order — the cohort's lifecycle, done first, returned last. */
const BAR_KEYS: (keyof PeopleBuckets)[] = [
  'paid', 'paid_legacy', 'paid_unproven', 'courier', 'courier_problem', 'label', 'to_pack', 'returned',
];

/**
 * Where a person's (or a team's) sales are now: the cohort's MEX-first parts,
 * weighted by count (the same bar for every viewer), each segment opening
 * exactly its orders when `href` can say so.
 */
export function BucketsBar({
  buckets, total, label, href, f, className,
}: {
  buckets: PeopleBuckets;
  total: number;
  label: string;
  href?: (k: PartKey | PartKey[], label: string) => string | null;
  f: InsightsFormat;
  className?: string;
}) {
  const segments: StackSegment[] = BAR_KEYS.map((k) => ({
    key: k,
    weight: buckets[k] ?? 0,
    tone: COHORT_TONE[k],
    pattern: COHORT_HATCH[k],
    text: `${f.bucketLabel(k)} · ${f.int(buckets[k] ?? 0)} (${f.share(buckets[k] ?? 0, total)})`,
    href: href ? href(k, f.bucketLabel(k)) : null,
  }));
  return <StackedBar segments={segments} label={label} className={cn('h-2.5', className)} />;
}

/** The parts under a bar as words: dot + icon + label + count (a link when exact). */
export function BucketLegend({
  buckets, total, cancelled, href, f, compact,
}: {
  buckets: PeopleBuckets;
  total: number;
  cancelled?: number;
  href?: (k: PartKey | PartKey[], label: string) => string | null;
  f: InsightsFormat;
  compact?: boolean;
}) {
  const courier = (buckets.courier ?? 0) + (buckets.courier_problem ?? 0);
  const items: { key: string; tone: string; icon: LucideIcon; label: string; n: number; keys: PartKey[] }[] = [
    { key: 'paid', tone: COHORT_TONE.paid, icon: COHORT_ICON.paid, label: f.bucketLabel('paid'), n: buckets.paid ?? 0, keys: ['paid'] },
    ...((buckets.paid_legacy ?? 0) > 0 ? [{ key: 'paid_legacy', tone: COHORT_TONE.paid_legacy, icon: COHORT_ICON.paid_legacy, label: f.bucketLabel('paid_legacy'), n: buckets.paid_legacy, keys: ['paid_legacy'] as PartKey[] }] : []),
    ...((buckets.paid_unproven ?? 0) > 0 ? [{ key: 'paid_unproven', tone: COHORT_TONE.paid_unproven, icon: COHORT_ICON.paid_unproven, label: f.bucketLabel('paid_unproven'), n: buckets.paid_unproven, keys: ['paid_unproven'] as PartKey[] }] : []),
    { key: 'courier', tone: COHORT_TONE.courier, icon: COHORT_ICON.courier, label: f.bucketLabel('courier'), n: courier, keys: ['courier', 'courier_problem'] },
    { key: 'label', tone: COHORT_TONE.label, icon: COHORT_ICON.label, label: f.bucketLabel('label'), n: buckets.label ?? 0, keys: ['label'] },
    { key: 'to_pack', tone: COHORT_TONE.to_pack, icon: COHORT_ICON.to_pack, label: f.bucketLabel('to_pack'), n: buckets.to_pack ?? 0, keys: ['to_pack'] },
    { key: 'returned', tone: COHORT_TONE.returned, icon: COHORT_ICON.returned, label: f.bucketLabel('returned'), n: buckets.returned ?? 0, keys: ['returned'] },
  ];
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground', compact && 'gap-x-2')}>
      {items.map((it) => {
        const Icon = it.icon;
        const h = href && it.n > 0 ? href(it.keys, it.label) : null;
        return (
          <li key={it.key} className={cn('inline-flex items-center gap-1', it.n === 0 && 'opacity-60')}>
            <span className={cn('h-2 w-2 shrink-0 rounded-full', it.tone)} aria-hidden />
            {!compact && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
            <span>{it.label}</span>
            <DrillLink href={h} ariaLabel={`${it.label}: ${f.int(it.n)}`} className="font-semibold tabular-nums text-foreground">{f.int(it.n)}</DrillLink>
            {!compact && <span className="tabular-nums">({f.share(it.n, total)})</span>}
          </li>
        );
      })}
      {cancelled != null && cancelled > 0 && (
        <li className="inline-flex items-center gap-1">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', OUTSIDE_TONE.cancelled_after_sale)} aria-hidden />
          <span>{f.outsideLabel('cancelled_after_sale')}</span>
          <DrillLink href={href ? href('cancelled_after_sale', f.outsideLabel('cancelled_after_sale')) : null}
            className="font-semibold tabular-nums text-foreground">{f.int(cancelled)}</DrillLink>
        </li>
      )}
    </ul>
  );
}

/** A person's sales by department as tiny identity dashes + counts (non-zero only),
 *  in the owner's order — the People table's "sources" column. */
export function SourceSplit({ m, f }: { m: Pick<PeopleMeasures, 'by_source'>; f: InsightsFormat }) {
  const n = (k: PeopleSourceKey) => m.by_source?.[k] ?? 0;
  const keys = PEOPLE_SOURCES.filter((k) => n(k) > 0);
  if (!keys.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5"
      title={keys.map((k) => `${f.sourceLabel(k)}: ${f.int(n(k))}`).join(' · ')}>
      {keys.map((k) => (
        <span key={k} className="inline-flex items-center gap-1 tabular-nums">
          <span className="h-[3px] w-2.5 rounded-full" style={{ background: sourceColorVar(k) }} aria-hidden />
          <span className="sr-only">{f.sourceLabel(k)}:</span>
          {f.int(n(k))}
        </span>
      ))}
    </span>
  );
}

/** Online time as text + a thin active / idle / break bar (the text is the value). */
export function TimeCell({ m, f }: { m: Pick<PeopleMeasures, 'presence'>; f: InsightsFormat }) {
  const { t } = f;
  const p = m.presence;
  if (!p || p.online_min == null) return <span className="text-xs text-muted-foreground">—</span>;
  const act = p.active_min ?? 0, idl = p.idle_min ?? 0, brk = p.break_min ?? 0;
  const total = Math.max(1, act + idl + brk);
  const title = t('overview.teams.timeTitle', {
    online: f.minutes(p.online_min), active: f.minutes(p.active_min), idle: f.minutes(p.idle_min), brk: f.minutes(p.break_min),
  });
  return (
    <span className="flex min-w-[88px] flex-col gap-1" title={title}>
      <span className="text-xs tabular-nums">{f.minutes(p.online_min)}</span>
      <span className="flex h-1.5 w-full max-w-[88px] gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="h-full bg-emerald-500" style={{ width: `${(act / total) * 100}%` }} />
        <span className="h-full bg-amber-400" style={{ width: `${(idl / total) * 100}%` }} />
        <span className="h-full bg-sky-500" style={{ width: `${(brk / total) * 100}%` }} />
      </span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** The person's badges: no CRM login (works only in the AlterCPA panel / collabBox author), manager, inactive. */
export function PersonBadges({ p, f }: { p: Pick<PeoplePerson, 'has_login' | 'is_manager' | 'is_active' | 'identity_kinds'>; f: InsightsFormat }) {
  const { t } = f;
  const badge = 'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none';
  const out: { key: string; text: string; cls: string; title?: string }[] = [];
  if (!p.has_login) {
    const kinds = p.identity_kinds ?? [];
    const key = kinds.includes('altercpa_user') ? 'altercpaOnly' : kinds.includes('collabbox_author') ? 'collabboxOnly' : 'noLogin';
    out.push({ key, text: t(`insights.agents.badge.${key}`), cls: 'bg-muted text-muted-foreground', title: t('insights.agents.badge.noLoginHint') });
  }
  if (p.is_manager) out.push({ key: 'manager', text: t('insights.agents.badge.manager'), cls: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200' });
  if (!p.is_active) out.push({ key: 'inactive', text: t('insights.agents.badge.inactive'), cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200' });
  if (!out.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {out.map((b) => <span key={b.key} className={cn(badge, b.cls)} title={b.title}>{b.text}</span>)}
    </span>
  );
}

/** A team key → its name in the reader's language (a team added later in
 *  Settings → Teams, with no translation yet, shows its own name). */
export function teamName(key: string, name: string | null | undefined, f: InsightsFormat): string {
  return f.t(`insights.agents.team.byKey.${key}`, { defaultValue: name || key });
}
