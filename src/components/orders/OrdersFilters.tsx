import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Banknote, Check, ChevronDown, Package, Search, User, Users, Waypoints, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { addDays, periodText } from '@/components/insights/shared/period';
import { sourceColorVar } from '@/components/insights/overview/palette';
import { departmentLabel, affiliateLabel, sourceLabel, type WebmasterNames } from '@/lib/orderSource';
import type { CpaAttributionDimensions, OrderViewCounts } from '@/lib/api';
import { fmtCount } from '@/lib/ordersList/rowModel';
import {
  effectiveRange, LIST_DEPARTMENTS, LIST_RANGES, LIST_SOURCES, LIST_VIEWS, MEX_GROUP_KEYS,
  type ListPatch, type ListRange, type ListView, type OrdersListState,
} from '@/lib/ordersList/listParams';

// The Insights chip language (users/UserFilters, insights/overview/FilterBar):
// a single choice is a filled chip, a multi-select chip is muted + a check.
// 36 px tall below lg (touch), 32 px from lg.
const CHIP = 'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8';
const CHIP_ONE = 'border-foreground/80 bg-foreground text-background';
const CHIP_MANY = 'border-foreground/60 bg-muted text-foreground';
const CHIP_OFF = 'bg-card text-foreground hover:bg-muted';
const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

const toggleIn = <T extends string>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);


// ── the status chips ────────────────────────────────────────────────────────

const VIEW_DOT: Partial<Record<ListView, string>> = {
  // owner rule: Откажани = red dot, Во корпа = grey dot
  cancelled: 'bg-[#dc2626] dark:bg-[#ff5a4f]',
  trashed: 'bg-[#cbd5e1] dark:bg-[#64748b]',
};

/** Нарачки · Отворени лидови · Откажани · Во корпа · Сите — each with its count. */
export function OrderViewChips({ view, counts, onChange, className }: {
  view: ListView;
  counts: OrderViewCounts | null | undefined;
  onChange: (v: ListView) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('ordersList.view.label')} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {LIST_VIEWS.map((v) => {
        const on = v === view;
        const n = counts?.[v];
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onChange(v)}
            title={t(`ordersList.view.${v}Hint`)}
            className={cn(CHIP, on ? CHIP_ONE : CHIP_OFF)}>
            {VIEW_DOT[v] && <span className={cn('h-2 w-2 shrink-0 rounded-full', VIEW_DOT[v])} aria-hidden />}
            <span>{t(`ordersList.view.${v}`)}</span>
            {n != null && (
              <span className={cn('tabular-nums', on ? 'text-background/80' : 'text-muted-foreground')} data-testid={`view-count-${v}`}>
                {fmtCount(n)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── a searchable single pick (seller, agent, CPA dimensions) ────────────────

export interface PickOption { value: string; label: string; hint?: string; muted?: boolean }

export function SearchPick({
  icon, label, allLabel, value, options, onChange, searchPlaceholder, emptyText, extra, className, full,
}: {
  icon: ReactNode;
  label: string;
  allLabel: string;
  value: string | null;
  options: PickOption[];
  onChange: (v: string | null) => void;
  searchPlaceholder: string;
  emptyText: string;
  /** Options shown above the list (e.g. "Недоделени"). */
  extra?: PickOption[];
  className?: string;
  /** Full width (the phone sheet). */
  full?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const all = useMemo(() => [...(extra ?? []), ...options], [extra, options]);
  const current = all.find((o) => o.value === value);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s) || (o.hint ?? '').toLowerCase().includes(s)) : options;
  }, [options, q]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const row = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label}
          className={cn(CHIP, value ? CHIP_MANY : CHIP_OFF, full && 'w-full justify-between', className)}>
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="shrink-0 text-muted-foreground">{label}:</span>
            <span className="min-w-0 truncate">{current?.label ?? allLabel}</span>
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-2" align="start">
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
            className="h-9 pl-8 text-base md:text-sm" autoComplete="off" />
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          <button type="button" onClick={() => { onChange(null); setOpen(false); }}
            className={cn(row, !value ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}>
            <span className="flex-1">{allLabel}</span>
            {!value && <Check className="h-3.5 w-3.5" aria-hidden />}
          </button>
          {(extra ?? []).map((o) => (
            <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(row, value === o.value ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}>
              <span className="flex-1">{o.label}</span>
              {value === o.value && <Check className="h-3.5 w-3.5" aria-hidden />}
            </button>
          ))}
          {shown.map((o) => (
            <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(row, value === o.value ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted', o.muted && 'text-muted-foreground')}>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{o.hint}</span>}
              {value === o.value && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            </button>
          ))}
          {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── price (денари) ──────────────────────────────────────────────────────────

const PRICE_PRESETS: { min: number | null }[] = [{ min: null }, { min: 500 }, { min: 1000 }, { min: 2000 }, { min: 5000 }];

function PricePick({ min, max, onChange, full }: { min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void; full?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dMin, setDMin] = useState(min != null ? String(min) : '');
  const [dMax, setDMax] = useState(max != null ? String(max) : '');
  useEffect(() => { setDMin(min != null ? String(min) : ''); setDMax(max != null ? String(max) : ''); }, [min, max]);
  const label = min != null && max != null ? `${fmtCount(min)}–${fmtCount(max)} ден`
    : min != null ? `${fmtCount(min)}+ ден` : max != null ? `≤ ${fmtCount(max)} ден` : null;
  const num = (s: string) => (s.trim() === '' || !/^\d{1,9}$/.test(s.trim()) ? null : Number(s));
  const applyCustom = () => { onChange(num(dMin), num(dMax)); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('ordersPage.price')} className={cn(CHIP, label ? CHIP_MANY : CHIP_OFF, full && 'w-full justify-between')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <Banknote className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="shrink-0 text-muted-foreground">{t('ordersPage.price')}:</span>
            <span className="truncate">{label ?? t('ordersPage.anyPrice')}</span>
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className={cn(LABEL, 'px-2 pb-1.5 pt-1')}>{t('ordersPage.quickFilters')}</div>
        <div className="space-y-0.5">
          {PRICE_PRESETS.map((p) => {
            const on = min === p.min && max == null;
            return (
              <button key={String(p.min)} type="button" onClick={() => { onChange(p.min, null); setOpen(false); }}
                className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm', on ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}>
                <span>{p.min == null ? t('ordersPage.anyPrice') : `${fmtCount(p.min)} ден +`}</span>
                {on && <Check className="h-3.5 w-3.5" aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="my-2 border-t" />
        <div className={cn(LABEL, 'px-2 pb-1.5')}>{t('ordersPage.customRange')}</div>
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <Input type="number" inputMode="numeric" placeholder={t('ordersPage.min')} aria-label={t('ordersPage.min')} value={dMin}
            onChange={(e) => setDMin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }} className="h-9 text-base md:h-8 md:text-sm" />
          <span className="text-xs text-muted-foreground">–</span>
          <Input type="number" inputMode="numeric" placeholder={t('ordersPage.max')} aria-label={t('ordersPage.max')} value={dMax}
            onChange={(e) => setDMax(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(); }} className="h-9 text-base md:h-8 md:text-sm" />
        </div>
        <Button size="sm" className="h-8 w-full text-xs" onClick={applyCustom}>{t('ordersPage.applyRange')}</Button>
      </PopoverContent>
    </Popover>
  );
}

// ── the period ──────────────────────────────────────────────────────────────

function PeriodGroup({ value, onChange, today, drill }: { value: OrdersListState; onChange: (p: ListPatch) => void; today: string; drill: boolean }) {
  const { t } = useTranslation();
  const eff = effectiveRange(value, today, { drill });
  const [custom, setCustom] = useState(eff.preset === 'custom');
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>({ from: value.from ?? eff.days?.from ?? null, to: value.to ?? eff.days?.to ?? null });
  useEffect(() => { if (eff.preset === 'custom') setCustom(true); }, [eff.preset]);
  useEffect(() => { setDraft({ from: value.from ?? eff.days?.from ?? null, to: value.to ?? eff.days?.to ?? null }); }, [value.from, value.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const reversed = !!draft.from && !!draft.to && draft.from > draft.to;
  const min = addDays(today, -3 * 365);
  const pick = (r: ListRange) => {
    if (r === 'custom') { setCustom(true); return; }
    setCustom(false);
    onChange({ range: r });
  };
  const label = (r: ListRange) => (r === 'all' ? t('ordersList.period.all') : t(`insights.common.period.${r}`));
  return (
    <div className="space-y-2">
      <div role="group" aria-label={t('ordersList.period.label')} className="flex flex-wrap items-center gap-1.5">
        <span className={cn(LABEL, 'mr-0.5')}>{t('ordersList.period.label')}</span>
        {LIST_RANGES.map((r) => {
          const on = r === 'custom' ? custom || eff.preset === 'custom' : eff.preset === r && !custom;
          return (
            <button key={r} type="button" aria-pressed={on} onClick={() => pick(r)} className={cn(CHIP, on ? CHIP_ONE : CHIP_OFF)}>
              {label(r)}
            </button>
          );
        })}
        {eff.days && (
          <span className="text-xs font-medium tabular-nums" data-testid="orders-period" title={t('ordersList.period.hint')}>
            {periodText(eff.days)}
          </span>
        )}
      </div>
      {custom && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reversed || (!draft.from && !draft.to)) return;
            onChange({ range: 'custom', from: draft.from, to: draft.to });
          }}
        >
          <DmyDateInput label={t('insights.common.period.from')} value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))} min={min} max={today} invalid={reversed} />
          <DmyDateInput label={t('insights.common.period.to')} value={draft.to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))} min={min} max={today} invalid={reversed} />
          <Button type="submit" size="sm" className="h-8" disabled={reversed || (!draft.from && !draft.to)}>{t('insights.common.period.apply')}</Button>
          <span className={cn('text-[11px]', reversed ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')} aria-live="polite">
            {reversed ? t('insights.common.period.reversed') : t('ordersList.period.hint')}
          </span>
        </form>
      )}
    </div>
  );
}

// ── every filter (inline on md+, inside the phone sheet) ────────────────────

export interface FilterSources {
  isAdmin: boolean;
  isAgent: boolean;
  sellers?: { id: string; name: string; active: boolean }[];
  agents?: { user_id: string; full_name: string }[];
  cpa?: CpaAttributionDimensions;
  webmasterNames?: WebmasterNames;
}

export function OrdersFilterFields({
  value, onChange, today, drill, src, layout,
}: {
  value: OrdersListState;
  onChange: (p: ListPatch) => void;
  today: string;
  drill: boolean;
  src: FilterSources;
  layout: 'inline' | 'sheet';
}) {
  const { t } = useTranslation();
  const sheet = layout === 'sheet';
  const group = cn('flex flex-wrap items-center gap-1.5', sheet && 'border-t pt-3');

  const sellerOptions: PickOption[] = useMemo(
    () => (src.sellers ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.active ? undefined : t('ordersList.seller.inactive'), muted: !s.active })),
    [src.sellers, t],
  );
  const agentOptions: PickOption[] = useMemo(
    () => (src.agents ?? []).map((a) => ({ value: a.user_id, label: a.full_name || a.user_id.slice(0, 8) })),
    [src.agents],
  );

  return (
    <div className={cn('space-y-2', sheet && 'space-y-3')}>
      <PeriodGroup value={value} onChange={onChange} today={today} drill={drill} />

      <div role="group" aria-label={t('ordersList.dept.label')} className={group}>
        <span className={cn(LABEL, 'mr-0.5', sheet && 'basis-full')}>{t('ordersList.dept.label')}</span>
        {LIST_DEPARTMENTS.map((d) => {
          const on = value.depts.includes(d);
          return (
            <button key={d} type="button" aria-pressed={on} onClick={() => onChange({ depts: toggleIn(value.depts, d) })}
              className={cn(CHIP, on ? CHIP_MANY : CHIP_OFF)}>
              <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(d) }} aria-hidden />
              {departmentLabel(t, d)}
              {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
            </button>
          );
        })}
        {value.depts.length > 0 && (
          <button type="button" onClick={() => onChange({ depts: [] })} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            {t('ordersList.dept.all')}
          </button>
        )}
      </div>

      {/* MEX and source share a row on a desktop (each wraps on its own). */}
      <div className={cn(!sheet && 'flex flex-wrap items-center gap-x-5 gap-y-2', sheet && 'space-y-3')}>
        <div role="group" aria-label={t('ordersList.mex.label')} className={group}>
          <span className={cn(LABEL, 'mr-0.5', sheet && 'basis-full')}>{t('ordersList.mex.label')}</span>
          {MEX_GROUP_KEYS.map((g) => {
            const on = value.mex.includes(g);
            return (
              <button key={g} type="button" aria-pressed={on} onClick={() => onChange({ mex: toggleIn(value.mex, g) })}
                className={cn(CHIP, on ? CHIP_MANY : CHIP_OFF)}>
                {t(`ordersList.mex.${g}`)}
                {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>

        <div role="group" aria-label={t('ordersList.source.label')} className={group}>
          <span className={cn(LABEL, 'mr-0.5', sheet && 'basis-full')}>{t('ordersList.source.label')}</span>
          {LIST_SOURCES.map((s) => {
            const on = value.sources.includes(s);
            return (
              <button key={s} type="button" aria-pressed={on} onClick={() => onChange({ sources: toggleIn(value.sources, s) })}
                className={cn(CHIP, on ? CHIP_MANY : CHIP_OFF)}>
                {sourceLabel(t, s)}
                {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn('flex flex-wrap items-center gap-1.5', sheet && 'flex-col items-stretch border-t pt-3')}>
        {src.isAdmin && src.sellers && (
          <SearchPick
            full={sheet}
            icon={<User className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            label={t('ordersList.seller.label')} allLabel={t('ordersList.seller.all')}
            value={value.seller} options={sellerOptions} onChange={(v) => onChange({ seller: v })}
            searchPlaceholder={t('ordersList.seller.search')} emptyText={t('ordersList.seller.empty')}
          />
        )}
        {src.isAdmin && (
          <SearchPick
            full={sheet}
            icon={<Users className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            label={t('ordersList.agent.label')} allLabel={t('ordersList.agent.all')}
            value={value.agent} options={agentOptions} onChange={(v) => onChange({ agent: v, ...(v ? { mine: false } : {}) })}
            extra={[{ value: 'none', label: t('ordersList.agent.none') }]}
            searchPlaceholder={t('ordersList.agent.search')} emptyText={t('ordersList.agent.empty')}
          />
        )}
        {src.isAdmin && (
          <button type="button" aria-pressed={value.mine === true}
            onClick={() => onChange({ mine: value.mine === true ? null : true, ...(value.mine === true ? {} : { agent: null }) })}
            className={cn(CHIP, value.mine === true ? CHIP_MANY : CHIP_OFF, sheet && 'w-full')}>
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('ordersList.mine')}
            {value.mine === true && <Check className="h-3 w-3 shrink-0" aria-hidden />}
          </button>
        )}
        <PricePick full={sheet} min={value.priceMin} max={value.priceMax} onChange={(min, max) => onChange({ priceMin: min, priceMax: max })} />
        {src.isAdmin && (src.cpa?.webmasters?.length ?? 0) > 0 && (
          <SearchPick
            full={sheet}
            icon={<Users className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            label={t('ordersPage.colAffiliate')} allLabel={t('ordersPage.allAffiliates')}
            value={value.wm} onChange={(v) => onChange({ wm: v })}
            options={(src.cpa?.webmasters ?? []).map((w) => ({ value: w.wm_id, label: w.name || `#${w.wm_id}`, hint: fmtCount(w.orders) }))}
            searchPlaceholder={t('ordersList.searchIn', { what: t('ordersPage.colAffiliate') })} emptyText={t('ordersList.nothingFound')}
          />
        )}
        {src.isAdmin && (src.cpa?.offers?.length ?? 0) > 0 && (
          <SearchPick
            full={sheet}
            icon={<Package className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            label={t('ordersPage.colOffer')} allLabel={t('ordersPage.allOffers')}
            value={value.offer} onChange={(v) => onChange({ offer: v })}
            options={(src.cpa?.offers ?? []).map((o) => ({ value: o.offer_id, label: o.name || `#${o.offer_id}`, hint: fmtCount(o.orders) }))}
            searchPlaceholder={t('ordersList.searchIn', { what: t('ordersPage.colOffer') })} emptyText={t('ordersList.nothingFound')}
          />
        )}
        {src.isAdmin && (src.cpa?.streams?.length ?? 0) > 0 && (
          <SearchPick
            full={sheet}
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
    </div>
  );
}

/** The phone summary of what is filtered, each removable (the sheet hides the controls). */
export function ActiveFilterChips({ value, onChange, src }: { value: OrdersListState; onChange: (p: ListPatch) => void; src: FilterSources }) {
  const { t } = useTranslation();
  const chips: { key: string; label: string; clear: ListPatch }[] = [];
  for (const d of value.depts) chips.push({ key: `d-${d}`, label: departmentLabel(t, d) ?? d, clear: { depts: value.depts.filter((x) => x !== d) } });
  for (const g of value.mex) chips.push({ key: `m-${g}`, label: `MEX: ${t(`ordersList.mex.${g}`)}`, clear: { mex: value.mex.filter((x) => x !== g) } });
  for (const s of value.sources) chips.push({ key: `s-${s}`, label: sourceLabel(t, s), clear: { sources: value.sources.filter((x) => x !== s) } });
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
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('ordersList.filters.active')}>
      {chips.map((c) => (
        <button key={c.key} type="button" onClick={() => onChange(c.clear)}
          className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs">
          <span className="min-w-0 truncate">{c.label}</span>
          <X className="h-3 w-3 shrink-0" aria-hidden />
          <span className="sr-only">{t('ordersList.filters.remove')}</span>
        </button>
      ))}
    </div>
  );
}
