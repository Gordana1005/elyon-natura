import { forwardRef, useEffect, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, Filter, Package, Search, User, Users, Waypoints, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StatusBadge } from '@/components/StatusBadge';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { addDays, periodText, stepRange } from '@/components/insights/shared/period';
import { OVERVIEW_COLOR_VARS, sourceColorVar } from '@/components/insights/overview/palette';
import { departmentLabel, affiliateLabel, sourceLabel, type WebmasterNames } from '@/lib/orderSource';
import type { CpaAttributionDimensions, OrderStateCounts } from '@/lib/api';
import type { OrderStatus } from '@/types';
import { fmtCount } from '@/lib/ordersList/rowModel';
import {
  customStatePick, effectiveRange, LIST_DEPARTMENTS, LIST_SOURCES, MENU_RANGES, PANEL_RESET,
  type ListPatch, type ListRange, type OrdersListState,
} from '@/lib/ordersList/listParams';
import {
  isPicked, quickViewOf, QUICK_VIEW_STATES, QUICK_VIEWS, stateLabel, subPartOf, toggleState, visibleStatusRows,
  type QuickView, type StateKey,
} from '@/lib/ordersList/statusModel';

/**
 * /orders — the filters (owner, Mile, 15.10.2026, after his screenshot): a quick-view strip, the
 * period with ‹ ›, and ONE "Филтри" panel (status · department · source · seller · agent · price ·
 * CPA) instead of five rows of pills. The panel is a popover from md and the bottom sheet on a phone
 * (Orders.tsx); FiltersPanelFields is the same in both.
 */

const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
/** One row of a list inside the panel (a checkbox, a radio or a pick). 36 px tall below lg (touch). */
const ROW = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8';

const toggleIn = <T extends string>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** A checkbox / radio look for a ROW (the row itself is the control). */
function Tick({ on, round }: { on: boolean; round?: boolean }) {
  return (
    <span aria-hidden className={cn(
      'flex h-4 w-4 shrink-0 items-center justify-center border transition-colors',
      round ? 'rounded-full' : 'rounded',
      on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/45 bg-card',
    )}>
      {on && (round ? <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" /> : <Check className="h-3 w-3" />)}
    </span>
  );
}

// ── the quick-view strip ────────────────────────────────────────────────────

const QUICK_DOT: Partial<Record<QuickView, string>> = {
  // owner rule: Откажани = red dot, Во корпа = grey dot, Вратени = pink dot
  cancelled: 'bg-[#dc2626] dark:bg-[#ff5a4f]',
  trashed: 'bg-[#cbd5e1] dark:bg-[#64748b]',
  returned: 'bg-pink-500',
};

/** Сите · Нарачки · Отворени лидови · Откажани · Корпа · Вратени — one segmented control. */
export function QuickViews({ states, onChange, className }: {
  states: readonly StateKey[];
  onChange: (states: StateKey[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const current = quickViewOf(states);
  return (
    <div role="group" aria-label={t('ordersList.quick.label')} data-testid="quick-views"
      className={cn('grid min-w-0 max-w-full grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5 sm:flex sm:items-center sm:overflow-x-auto sm:scrollbar-thin', className)}>
      {QUICK_VIEWS.map((v) => {
        const on = v === current;
        return (
          <button key={v} type="button" aria-pressed={on} title={t(`ordersList.quick.${v}Hint`)}
            onClick={() => onChange([...QUICK_VIEW_STATES[v]])}
            className={cn(
              'inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-center text-xs font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:shrink-0 sm:justify-start sm:whitespace-nowrap sm:px-3',
              on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}>
            {QUICK_DOT[v] && <span className={cn('h-2 w-2 shrink-0 rounded-full', QUICK_DOT[v])} aria-hidden />}
            {t(`ordersList.quick.${v}`)}
          </button>
        );
      })}
    </div>
  );
}

// ── the period ──────────────────────────────────────────────────────────────

const ARROW = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

/** The period button's words: Сите датуми · Денес · Вчера · 14.10.2026 · Последни 7 дена (+ its days). */
function periodButtonLabel(t: TFunction, value: OrdersListState, today: string): { main: string; days: string | null } {
  const eff = effectiveRange(value, today);
  if (!eff.days) return { main: t('ordersList.period.all'), days: null };
  const single = eff.days.from === eff.days.to;
  if (single && eff.days.from === today) return { main: t('insights.common.period.today'), days: null };
  if (single && eff.days.from === addDays(today, -1)) return { main: t('ordersList.period.yesterday'), days: periodText(eff.days) };
  if (eff.preset === 'custom') return { main: periodText(eff.days), days: null };
  return { main: t(`insights.common.period.${eff.preset}`), days: periodText(eff.days) };
}

/** ‹ [📅 Денес ▾] › — Сите датуми (the default) · Денес · Последни 7 дена · Овој месец · Прилагодено. */
export function PeriodPick({ value, onChange, today, className }: {
  value: OrdersListState;
  onChange: (p: ListPatch) => void;
  today: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const eff = effectiveRange(value, today);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  useEffect(() => {
    if (!open) return;
    setCustom(eff.preset === 'custom');
    setDraft({ from: eff.days?.from ?? null, to: eff.days?.to ?? null });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const reversed = !!draft.from && !!draft.to && draft.from > draft.to;
  const label = periodButtonLabel(t, value, today);
  const pick = (r: ListRange) => {
    if (r === 'custom') { setCustom(true); return; }
    onChange({ range: r === 'all' ? null : r });
    setOpen(false);
  };
  // ‹ › move the period by its own length (a day for Денес); → stops at today.
  const step = (dir: -1 | 1) => {
    const next = eff.days ? stepRange(eff.days, dir, today) : null;
    if (!next) return;
    onChange(next.preset === 'today' ? { range: 'today' } : { range: 'custom', from: next.range.from, to: next.range.to });
  };
  const oneDay = !!eff.days && eff.days.from === eff.days.to;
  const prevLabel = t(oneDay ? 'insights.common.period.prevDay' : 'insights.common.period.prevPeriod');
  const nextLabel = t(oneDay ? 'insights.common.period.nextDay' : 'insights.common.period.nextPeriod');
  const current: ListRange = eff.preset === 'year' ? 'custom' : eff.preset;
  return (
    <div className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      {eff.days && (
        <button type="button" className={ARROW} disabled={!stepRange(eff.days, -1, today)} onClick={() => step(-1)} aria-label={prevLabel} title={prevLabel}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${t('ordersList.period.label')}: ${label.main}`} data-testid="period-pick"
            className={cn('inline-flex h-9 min-w-0 items-center gap-1.5 rounded-lg border bg-background px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              eff.days && 'border-foreground/40')}>
            <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate font-medium">{label.main}</span>
            {label.days && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">· {label.days}</span>}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(19rem,calc(100vw-2rem))] p-2">
          <div role="radiogroup" aria-label={t('ordersList.period.label')} className="space-y-0.5">
            {MENU_RANGES.map((r) => {
              const on = r === 'custom' ? custom || current === 'custom' : current === r && !custom;
              return (
                <button key={r} type="button" role="radio" aria-checked={on} onClick={() => pick(r)} className={cn(ROW, on && 'bg-primary/10 font-medium text-primary')}>
                  <Tick on={on} round />
                  <span className="flex-1">{r === 'all' ? t('ordersList.period.all') : t(`insights.common.period.${r}`)}</span>
                </button>
              );
            })}
          </div>
          {custom && (
            <form className="mt-2 space-y-2 border-t px-1 pt-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (reversed || (!draft.from && !draft.to)) return;
                onChange({ range: 'custom', from: draft.from, to: draft.to });
                setOpen(false);
              }}>
              <div className="grid grid-cols-2 gap-2">
                <DmyDateInput label={t('insights.common.period.from')} value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))} min={addDays(today, -3 * 365)} max={today} invalid={reversed} />
                <DmyDateInput label={t('insights.common.period.to')} value={draft.to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))} min={addDays(today, -3 * 365)} max={today} invalid={reversed} />
              </div>
              {reversed && <p className="text-[11px] text-red-700 dark:text-red-400" aria-live="polite">{t('insights.common.period.reversed')}</p>}
              <Button type="submit" size="sm" className="h-8 w-full" disabled={reversed || (!draft.from && !draft.to)}>{t('insights.common.period.apply')}</Button>
            </form>
          )}
          <p className="mt-2 border-t px-2 pt-2 text-[11px] leading-snug text-muted-foreground">{t('ordersList.period.hint')}</p>
        </PopoverContent>
      </Popover>
      {eff.days && (
        <button type="button" className={ARROW} disabled={!stepRange(eff.days, 1, today)} onClick={() => step(1)} aria-label={nextLabel} title={nextLabel}>
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

// ── a searchable single pick (the CPA dimensions) ───────────────────────────

export interface PickOption { value: string; label: string; hint?: string; muted?: boolean }

/** A search box + a scrollable list (inline in the panel). */
function PickList({
  value, options, onChange, allLabel, extra, searchPlaceholder, emptyText, initials, testId,
}: {
  value: string | null;
  options: PickOption[];
  onChange: (v: string | null) => void;
  allLabel: string;
  /** Options shown above the list (e.g. "Недоделени"). */
  extra?: PickOption[];
  searchPlaceholder: string;
  emptyText: string;
  /** A round initial before each name (people). */
  initials?: boolean;
  testId?: string;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? options.filter((o) => o.label.toLowerCase().includes(s) || (o.hint ?? '').toLowerCase().includes(s)) : options;
    // the picked one stays in view even when the search would hide it
    const picked = value ? options.find((o) => o.value === value) : undefined;
    return picked && !list.includes(picked) ? [picked, ...list] : list;
  }, [options, q, value]);
  const row = (o: PickOption | null) => {
    const v = o?.value ?? null;
    const on = value === v;
    return (
      <button key={v ?? '__all'} type="button" role="radio" aria-checked={on} onClick={() => onChange(v)}
        className={cn(ROW, on && 'bg-primary/10 font-medium text-primary', o?.muted && !on && 'text-muted-foreground')}>
        {initials && o && !extra?.includes(o) && (
          <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase text-foreground">
            {o.label.trim().charAt(0) || '?'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{o?.label ?? allLabel}</span>
        {o?.hint && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{o.hint}</span>}
        {on && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      </button>
    );
  };
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
          className="h-9 pl-8 text-base md:h-8 md:text-sm" autoComplete="off" />
      </div>
      <div role="radiogroup" aria-label={allLabel} className="max-h-44 space-y-0.5 overflow-y-auto overscroll-contain pr-1">
        {row(null)}
        {(extra ?? []).map((o) => row(o))}
        {shown.map((o) => row(o))}
        {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</p>}
      </div>
    </div>
  );
}

/** A full-width button that opens a PickList (the CPA dimensions — few people use them). */
export function SearchPick({
  icon, label, allLabel, value, options, onChange, searchPlaceholder, emptyText, extra,
}: {
  icon: ReactNode;
  label: string;
  allLabel: string;
  value: string | null;
  options: PickOption[];
  onChange: (v: string | null) => void;
  searchPlaceholder: string;
  emptyText: string;
  extra?: PickOption[];
}) {
  const [open, setOpen] = useState(false);
  const current = [...(extra ?? []), ...options].find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label}
          className={cn(ROW, 'justify-between border bg-background', value && 'border-foreground/50')}>
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="shrink-0 text-muted-foreground">{label}:</span>
            <span className="min-w-0 truncate">{current?.label ?? allLabel}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-2" align="start">
        <PickList value={value} options={options} extra={extra} allLabel={allLabel}
          onChange={(v) => { onChange(v); setOpen(false); }} searchPlaceholder={searchPlaceholder} emptyText={emptyText} />
      </PopoverContent>
    </Popover>
  );
}

// ── price (денари) ──────────────────────────────────────────────────────────

const PRICE_PRESETS: (number | null)[] = [null, 500, 1000, 2000, 5000];

function PriceFields({ min, max, onChange }: { min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void }) {
  const { t } = useTranslation();
  const [dMin, setDMin] = useState(min != null ? String(min) : '');
  const [dMax, setDMax] = useState(max != null ? String(max) : '');
  useEffect(() => { setDMin(min != null ? String(min) : ''); setDMax(max != null ? String(max) : ''); }, [min, max]);
  const num = (s: string) => (s.trim() === '' || !/^\d{1,9}$/.test(s.trim()) ? null : Number(s));
  const applyCustom = () => onChange(num(dMin), num(dMax));
  const chip = 'inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={t('ordersPage.price')} className="flex flex-wrap gap-1.5">
        {PRICE_PRESETS.map((p) => {
          const on = min === p && max == null;
          return (
            <button key={String(p)} type="button" role="radio" aria-checked={on} onClick={() => onChange(p, null)}
              className={cn(chip, on ? 'border-foreground bg-foreground text-background' : 'bg-card hover:bg-muted')}>
              {p == null ? t('ordersPage.anyPrice') : `${fmtCount(p)}+ ден`}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <Input type="number" inputMode="numeric" placeholder={t('ordersPage.min')} aria-label={t('ordersPage.min')} value={dMin}
          onChange={(e) => setDMin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }} className="h-9 min-w-0 text-base md:h-8 md:text-sm" />
        <span className="text-xs text-muted-foreground">–</span>
        <Input type="number" inputMode="numeric" placeholder={t('ordersPage.max')} aria-label={t('ordersPage.max')} value={dMax}
          onChange={(e) => setDMax(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }} className="h-9 min-w-0 text-base md:h-8 md:text-sm" />
        <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 text-xs md:h-8" onClick={applyCustom}>{t('ordersPage.applyRange')}</Button>
      </div>
    </div>
  );
}

// ── the "Филтри" panel ──────────────────────────────────────────────────────

export interface FilterSources {
  isAdmin: boolean;
  isAgent: boolean;
  sellers?: { id: string; name: string; active: boolean }[];
  agents?: { user_id: string; full_name: string }[];
  cpa?: CpaAttributionDimensions;
  webmasterNames?: WebmasterNames;
}

function Section({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-1.5 border-t pt-3 first:border-t-0 first:pt-0" aria-label={title} data-testid={testId}>
      <div className="flex min-h-6 items-center justify-between gap-2 px-1">
        <h3 className={LABEL}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const sectionReset = 'text-[11px] font-medium text-primary underline-offset-2 hover:underline';

/** Every panel filter — inside the md+ popover (live) and the phone sheet (a draft). */
export function FiltersPanelFields({ value, onChange, src, counts, countsLoading }: {
  value: OrdersListState;
  onChange: (p: ListPatch) => void;
  src: FilterSources;
  /** One count per status key (GET /orders/state-counts), loaded when the panel opens. */
  counts?: OrderStateCounts;
  countsLoading?: boolean;
}) {
  const { t } = useTranslation();
  const sellerOptions: PickOption[] = useMemo(
    () => (src.sellers ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.active ? undefined : t('ordersList.seller.inactive'), muted: !s.active })),
    [src.sellers, t],
  );
  const agentOptions: PickOption[] = useMemo(
    () => (src.agents ?? []).map((a) => ({ value: a.user_id, label: a.full_name || a.user_id.slice(0, 8) })),
    [src.agents],
  );
  const stateCounts = counts as Partial<Record<StateKey, number | null>> | undefined;
  const rows = visibleStatusRows(value.states, stateCounts);
  const source = value.sources.length === 1 ? value.sources[0] : null;

  return (
    <div className="space-y-3">
      <Section title={t('ordersList.status.label')} testId="filter-status"
        action={value.states.length > 0 && <button type="button" className={sectionReset} onClick={() => onChange({ states: [] })}>{t('ordersList.status.all')}</button>}>
        <div role="group" aria-label={t('ordersList.status.label')} className="max-h-64 space-y-0.5 overflow-y-auto overscroll-contain pr-1">
          {rows.map((r) => {
            const on = isPicked(value.states, r.key);
            const n = stateCounts?.[r.key];
            const part = subPartOf(r.key);
            return (
              <button key={r.key} type="button" role="checkbox" aria-checked={on} data-testid={`state-${r.key}`}
                onClick={() => onChange({ states: toggleState(value.states, r.key) })}
                title={part ? t(`ordersList.status.sub.${part}Hint`) : undefined}
                className={cn(ROW, r.depth === 1 && 'pl-7')}>
                <Tick on={on} />
                {r.depth === 0
                  ? <StatusBadge status={r.key as OrderStatus} />
                  : (
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-[13px]">
                      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate">{t(`ordersList.status.sub.${part}`)}</span>
                    </span>
                  )}
                <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted-foreground">
                  {n != null ? fmtCount(n) : countsLoading ? '…' : ''}
                </span>
              </button>
            );
          })}
        </div>
        <p className="px-1 text-[11px] leading-snug text-muted-foreground">{t('ordersList.status.hint')}</p>
      </Section>

      <Section title={t('ordersList.dept.label')} testId="filter-dept"
        action={value.depts.length > 0 && <button type="button" className={sectionReset} onClick={() => onChange({ depts: [] })}>{t('ordersList.dept.all')}</button>}>
        <div role="group" aria-label={t('ordersList.dept.label')} className="space-y-0.5">
          {LIST_DEPARTMENTS.map((d) => {
            const on = value.depts.includes(d);
            return (
              <button key={d} type="button" role="checkbox" aria-checked={on} onClick={() => onChange({ depts: toggleIn(value.depts, d) })} className={ROW}>
                <Tick on={on} />
                <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(d) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{departmentLabel(t, d)}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t('ordersList.source.label')} testId="filter-source">
        <div role="radiogroup" aria-label={t('ordersList.source.label')} className="space-y-0.5">
          {[null, ...LIST_SOURCES].map((s) => {
            const on = s === source && (s != null || value.sources.length === 0);
            return (
              <button key={s ?? 'all'} type="button" role="radio" aria-checked={on} onClick={() => onChange({ sources: s ? [s] : [] })} className={ROW}>
                <Tick on={on} round />
                <span className="flex-1">{s ? sourceLabel(t, s) : t('ordersPage.allSources')}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {src.isAdmin && src.sellers && (
        <Section title={t('ordersList.seller.label')} testId="filter-seller">
          <PickList value={value.seller} options={sellerOptions} onChange={(v) => onChange({ seller: v })} allLabel={t('ordersList.seller.all')}
            searchPlaceholder={t('ordersList.seller.search')} emptyText={t('ordersList.seller.empty')} initials />
        </Section>
      )}

      {src.isAdmin && (
        <Section title={t('ordersList.agent.label')} testId="filter-agent">
          <PickList value={value.agent} options={agentOptions} onChange={(v) => onChange({ agent: v, ...(v ? { mine: false } : {}) })}
            allLabel={t('ordersList.agent.all')} extra={[{ value: 'none', label: t('ordersList.agent.none') }]}
            searchPlaceholder={t('ordersList.agent.search')} emptyText={t('ordersList.agent.empty')} initials />
          <button type="button" role="switch" aria-checked={value.mine === true}
            onClick={() => onChange({ mine: value.mine === true ? null : true, ...(value.mine === true ? {} : { agent: null }) })}
            className={cn(ROW, 'border', value.mine === true ? 'border-primary/50 bg-primary/10 font-medium text-primary' : 'bg-background')}>
            <User className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">{t('ordersList.mine')}</span>
            {value.mine === true && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          </button>
        </Section>
      )}

      <Section title={t('ordersPage.price')} testId="filter-price">
        <PriceFields min={value.priceMin} max={value.priceMax} onChange={(min, max) => onChange({ priceMin: min, priceMax: max })} />
      </Section>

      {src.isAdmin && ((src.cpa?.webmasters?.length ?? 0) > 0 || (src.cpa?.offers?.length ?? 0) > 0 || (src.cpa?.streams?.length ?? 0) > 0) && (
        <Section title={t('ordersList.filters.cpa')} testId="filter-cpa">
          <div className="space-y-1.5">
            {(src.cpa?.webmasters?.length ?? 0) > 0 && (
              <SearchPick
                icon={<Users className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                label={t('ordersPage.colAffiliate')} allLabel={t('ordersPage.allAffiliates')}
                value={value.wm} onChange={(v) => onChange({ wm: v })}
                options={(src.cpa?.webmasters ?? []).map((w) => ({ value: w.wm_id, label: w.name || `#${w.wm_id}`, hint: fmtCount(w.orders) }))}
                searchPlaceholder={t('ordersList.searchIn', { what: t('ordersPage.colAffiliate') })} emptyText={t('ordersList.nothingFound')}
              />
            )}
            {(src.cpa?.offers?.length ?? 0) > 0 && (
              <SearchPick
                icon={<Package className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                label={t('ordersPage.colOffer')} allLabel={t('ordersPage.allOffers')}
                value={value.offer} onChange={(v) => onChange({ offer: v })}
                options={(src.cpa?.offers ?? []).map((o) => ({ value: o.offer_id, label: o.name || `#${o.offer_id}`, hint: fmtCount(o.orders) }))}
                searchPlaceholder={t('ordersList.searchIn', { what: t('ordersPage.colOffer') })} emptyText={t('ordersList.nothingFound')}
              />
            )}
            {(src.cpa?.streams?.length ?? 0) > 0 && (
              <SearchPick
                icon={<Waypoints className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                label={t('ordersPage.colPublisher')} allLabel={t('ordersPage.allPublishers')}
                value={value.stream} onChange={(v) => onChange({ stream: v })}
                options={[...new Map((src.cpa?.streams ?? []).map((s) => [s.stream_id, {
                  value: s.stream_id, label: s.stream_id, hint: `${affiliateLabel(s.wm_id, src.webmasterNames)} · ${fmtCount(s.orders)}`,
                }])).values()]}
                searchPlaceholder={t('ordersList.searchIn', { what: t('ordersPage.colPublisher') })} emptyText={t('ordersList.nothingFound')}
              />
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/** "Филтри (n)" + the md+ popover. */
export function FiltersPanel({ value, onChange, src, counts, countsLoading, count, open, onOpenChange }: {
  value: OrdersListState;
  onChange: (p: ListPatch) => void;
  src: FilterSources;
  counts?: OrderStateCounts;
  countsLoading?: boolean;
  /** How many panel filters are set (the badge). */
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <FiltersButton count={count} />
      </PopoverTrigger>
      <PopoverContent align="end" data-testid="filters-panel"
        className={cn('flex w-[min(23rem,calc(100vw-2rem))] flex-col p-0', OVERVIEW_COLOR_VARS)}
        style={{ maxHeight: 'min(46rem, var(--radix-popover-content-available-height, 80vh))' }}>
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">{t('ordersList.filters.title')}</span>
          <button type="button" onClick={() => onOpenChange(false)} aria-label={t('common.close')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
          <FiltersPanelFields value={value} onChange={onChange} src={src} counts={counts} countsLoading={countsLoading} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onChange(PANEL_RESET)} disabled={count === 0 && value.states.length === 0}>
            {t('ordersList.filters.clear')}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>{t('common.done')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The "Филтри" button (the popover's trigger on md+, the sheet's on a phone). */
export const FiltersButton = forwardRef<HTMLButtonElement, { count: number } & ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ count, className, ...props }, ref) => {
    const { t } = useTranslation();
    return (
      <Button ref={ref} variant="outline" size="sm" type="button" data-testid="filters-button" {...props}
        className={cn('h-9 gap-1.5 rounded-lg px-3 text-sm', count > 0 && 'border-primary/50', className)}>
        <Filter className="h-3.5 w-3.5" aria-hidden />
        {t('ordersList.filters.open')}
        {count > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{count}</span>}
      </Button>
    );
  },
);
FiltersButton.displayName = 'FiltersButton';

// ── what is filtered (under the bar), each removable ────────────────────────

export function FilterTokens({ value, onChange, src }: { value: OrdersListState; onChange: (p: ListPatch) => void; src: FilterSources }) {
  const { t } = useTranslation();
  const chips: { key: string; label: string; clear: ListPatch }[] = [];
  if (customStatePick(value)) {
    for (const k of value.states) chips.push({ key: `st-${k}`, label: stateLabel(t, k), clear: { states: value.states.filter((x) => x !== k) } });
  }
  for (const d of value.depts) chips.push({ key: `d-${d}`, label: departmentLabel(t, d) ?? d, clear: { depts: value.depts.filter((x) => x !== d) } });
  for (const g of value.mex) chips.push({ key: `m-${g}`, label: `MEX: ${t(`ordersList.mex.${g}`)}`, clear: { mex: value.mex.filter((x) => x !== g) } });
  for (const s of value.sources) chips.push({ key: `s-${s}`, label: `${t('ordersList.source.label')}: ${sourceLabel(t, s)}`, clear: { sources: value.sources.filter((x) => x !== s) } });
  if (value.seller) {
    const name = src.sellers?.find((s) => s.id === value.seller)?.name ?? '…';
    chips.push({ key: 'seller', label: t('ordersList.seller.chip', { name }), clear: { seller: null } });
  }
  if (value.agent) {
    const name = value.agent === 'none' ? t('ordersList.agent.none') : src.agents?.find((a) => a.user_id === value.agent)?.full_name ?? '…';
    chips.push({ key: 'agent', label: t('ordersList.agent.chip', { name }), clear: { agent: null } });
  }
  if (!src.isAgent && value.mine === true) chips.push({ key: 'mine', label: t('ordersList.mine'), clear: { mine: null } });
  if (value.priceMin != null || value.priceMax != null) {
    const label = value.priceMin != null && value.priceMax != null ? `${fmtCount(value.priceMin)}–${fmtCount(value.priceMax)} ден`
      : value.priceMin != null ? `${fmtCount(value.priceMin)}+ ден` : `≤ ${fmtCount(value.priceMax)} ден`;
    chips.push({ key: 'price', label: t('ordersPage.priceChip', { label }), clear: { priceMin: null, priceMax: null } });
  }
  if (value.wm) chips.push({ key: 'wm', label: affiliateLabel(value.wm, src.webmasterNames), clear: { wm: null } });
  if (value.offer) chips.push({ key: 'offer', label: `${t('ordersPage.colOffer')}: ${value.offer}`, clear: { offer: null } });
  if (value.stream) chips.push({ key: 'stream', label: `${t('ordersPage.colPublisher')}: ${value.stream}`, clear: { stream: null } });
  if (!chips.length) return null;
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label={t('ordersList.filters.active')} data-testid="filter-tokens">
      {chips.map((c) => (
        <li key={c.key} className="min-w-0 max-w-full">
          <button type="button" onClick={() => onChange(c.clear)}
            className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs hover:bg-muted/70">
            <span className="min-w-0 truncate">{c.label}</span>
            <X className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">{t('ordersList.filters.remove')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
