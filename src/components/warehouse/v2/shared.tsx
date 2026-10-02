import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Eye, Loader2, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { LABEL } from '@/components/assigner/parts';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiStockV2Health } from '@/lib/stockV2Api';
import type { StockFreshness, StockHealth, StockWarehouseCode, StockWarehouseRef } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { parseHm } from './stockV2Model';

export { readPageOffset } from './stockV2Model';

/** Who sees what on the v2 tabs — the api decides; this only hides what it would refuse. */
export function useStockAccess() {
  const { user } = useAuth();
  // The Stock v2 switch, a run, approving a count / the opening: stock-v2 writes are margin-class
  // (403 owners_only unless can_see_margins — access levels, 20260947001600).
  const { canSeeMargins } = usePermissions();
  const isOwner = !!canSeeMargins;
  const isAdmin = !!user?.isAdmin;
  return {
    isOwner,
    canSee: isOwner || isAdmin || !!user?.isManager || !!user?.isWarehouse,
    canCount: isOwner || isAdmin || !!user?.isWarehouse,
    canHealth: isOwner || isAdmin,
  };
}

export const HEALTH_LITE_KEY = ['stock2', 'health', 'lite'] as const;
export const HEALTH_FULL_KEY = ['stock2', 'health', 'full'] as const;

/** The light health read every tab needs: is v2 on (→ the ledger) or off (→ preview=1)? */
export function useStockHealthLite(enabled = true) {
  return useQuery<StockHealth>({
    queryKey: HEALTH_LITE_KEY, queryFn: () => apiStockV2Health(false), enabled, staleTime: 60_000, retry: 0,
  });
}

/**
 * preview=1 while the switch is off (nothing is written yet, the api computes from the parcels);
 * undefined while the health read is still on its way. A failed health read previews — the
 * computed figure is never worse than an empty ledger.
 */
export function usePreviewFlag(): boolean | undefined {
  const h = useStockHealthLite();
  if (h.isSuccess) return !h.data.enabled;
  if (h.isError) return true;
  return undefined;
}

export interface WarehouseOption { code: StockWarehouseCode; name: string }

/** A warehouse's name: the api's, else the seeded names in the reader's language, else its code. */
export function warehouseName(f: InsightsFormat, code: string, known?: string | null): string {
  return known || f.t(`stock2.wh.${code}`, { defaultValue: code });
}

/**
 * The warehouses to pick from, the same for every stock role: the active, TRACKED warehouses the
 * health read lists (`StockHealth.warehouses`, in their sort order). `main` is always offered, and so
 * is each warehouse with an opening count (an api older than 02.10.2026 sends no list — then that is
 * all there is), named from what the api sent.
 */
export function useWarehouseOptions(f: InsightsFormat, opts: { health?: StockHealth; seen?: StockWarehouseRef | null }): WarehouseOption[] {
  const seenCode = opts.seen?.code;
  const seenName = opts.seen?.name;
  const health = opts.health;
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const w of health?.warehouses ?? []) if (w.tracked) out.set(w.code, w.name);
    if (!out.has('main')) out.set('main', '');
    for (const o of health?.openings ?? []) if (!out.has(o.warehouse)) out.set(o.warehouse, '');
    if (seenCode) out.set(seenCode, seenName || out.get(seenCode) || '');
    return [...out].map(([code, name]) => ({ code, name: warehouseName(f, code, name) }));
  }, [health, seenCode, seenName, f]);
}

/** A warehouse select. With `allowAll` an empty value means every warehouse. */
export function WarehousePicker({ value, onChange, options, allowAll, f, className }: {
  value: string; onChange: (code: string) => void; options: WarehouseOption[]; allowAll?: boolean; f: InsightsFormat; className?: string;
}) {
  const { t } = f;
  if (!allowAll && options.length <= 1) {
    return (
      <div className={cn('flex flex-col gap-1', className)}>
        <span className={LABEL}>{t('stock2.common.warehouse')}</span>
        <span className="min-h-8 py-1 text-sm font-medium">{options[0]?.name ?? warehouseName(f, value)}</span>
      </div>
    );
  }
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className={LABEL}>{t('stock2.common.warehouse')}</span>
      <select
        className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowAll && <option value="">{t('stock2.common.allWarehouses')}</option>}
        {options.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
      </select>
    </label>
  );
}

/**
 * ← day → (→ stops at today) + a dd.mm.yyyy field + an optional time of day (HH:MM, 24 h — not
 * <input type="time">, which an English Windows shows as AM/PM).
 */
export function DayTimeStepper({ day, today, onDay, at, onAt, min, f }: {
  day: string; today: string; onDay: (d: string) => void;
  at?: string | null; onAt?: (hm: string | null) => void; min?: string; f: InsightsFormat;
}) {
  const { t } = f;
  const [text, setText] = useState(at ?? '');
  useEffect(() => { setText(at ?? ''); }, [at]);
  const bad = text.trim() !== '' && !parseHm(text);
  const commit = () => {
    if (!onAt) return;
    const hm = parseHm(text);
    if (text.trim() === '') onAt(null);
    else if (hm) { setText(hm); onAt(hm); }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
      <div className="flex flex-col gap-1">
        <span className={LABEL}>{t('stock2.common.day')}</span>
        <PeriodStepper range={{ from: day, to: day }} today={today} onStep={(n) => onDay(n.range.from)} testId="stock2-day" />
      </div>
      <DmyDateInput value={day} onChange={(d) => { if (d) onDay(d); }} label={t('stock2.common.pickDay')} min={min} max={today} />
      {onAt && (
        <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          <label htmlFor="stock2-at">{t('stock2.common.atTime')}</label>
          <div className="flex items-center gap-1">
            <div className="relative">
              <Clock className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="stock2-at"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('stock2.common.hmPlaceholder')}
                aria-invalid={bad || undefined}
                className={cn('h-8 w-[92px] pl-7 text-xs tabular-nums', bad && 'border-red-500 focus-visible:ring-red-500')}
              />
            </div>
            {at && (
              <button type="button" onClick={() => { setText(''); onAt(null); }} aria-label={t('stock2.common.clearTime')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}
      {day !== today && (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => onDay(today)}>{t('stock2.common.today')}</Button>
      )}
    </div>
  );
}

/** While the switch is off: everything is computed from the parcels, nothing is written. */
export function PreviewBanner({ f }: { f: InsightsFormat }) {
  const { t } = f;
  return (
    <div role="status" data-testid="stock2-preview" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <Eye className="mt-px h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="font-semibold">{t('stock2.preview.title')}</p>
        <p>{t('stock2.preview.body')}</p>
      </div>
    </div>
  );
}

/** A clock that re-renders once a minute (the "пред N мин" lines). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "пратки пред 4 мин · Сигма пред 2 ч · пресметано пред 6 мин". */
export function FreshnessLine({ freshness, f, showRun }: { freshness: StockFreshness | null | undefined; f: InsightsFormat; showRun?: boolean }) {
  const now = useNow();
  if (!freshness) return null;
  const { t } = f;
  const parts = [
    t('stock2.fresh.mex', { ago: f.ago(freshness.last_mex_at, now) }),
    t('stock2.fresh.sigma', { ago: f.ago(freshness.last_sigma_at, now) }),
    ...(showRun ? [t('stock2.fresh.run', { ago: f.ago(freshness.last_run_at, now) })] : []),
  ];
  return <p className="text-[11px] leading-snug text-muted-foreground" data-testid="stock2-fresh">{parts.join(' · ')}</p>;
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex justify-center py-12" role="status" aria-live="polite">
      <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
}

export function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <LoadError text={apiErrorText(error)} onRetry={onRetry} />;
}

export function Empty({ icon, title, description }: { icon?: ReactNode; title: string; description?: string }) {
  return <EmptyState icon={icon} title={title} description={description} size="sm" />;
}

const PILL_TONE = {
  amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  red: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  blue: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  emerald: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  slate: 'border-border bg-muted/60 text-muted-foreground',
} as const;

/** A small word badge (always a word, never colour alone). */
export function Pill({ tone = 'slate', children, title, className }: { tone?: keyof typeof PILL_TONE; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn('inline-flex max-w-full items-center rounded-full border px-1.5 py-px text-[11px] font-medium leading-tight', PILL_TONE[tone], className)}>
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** "1–100 од 1.234" with ← / →. */
export function Pager({ offset, limit, rows, total, onOffset, f }: {
  offset: number; limit: number; rows: number; total: number; onOffset: (o: number) => void; f: InsightsFormat;
}) {
  const { t } = f;
  if (total <= limit && offset === 0) return null;
  const from = rows ? offset + 1 : 0;
  const to = offset + rows;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2" aria-label={t('stock2.common.pages')}>
      <span className="text-xs tabular-nums text-muted-foreground">{t('stock2.common.pageSpan', { from: f.int(from), to: f.int(to), total: f.int(total) })}</span>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="h-8" disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - limit))}>
          <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden />{t('stock2.common.prevPage')}
        </Button>
        <Button variant="outline" size="sm" className="h-8" disabled={to >= total} onClick={() => onOffset(offset + limit)}>
          {t('stock2.common.nextPage')}<ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** URL helpers: set or delete one param, keep the rest, reset the page. */
export function patchParams(sp: URLSearchParams, patch: Record<string, string | null | undefined>, keepPage = false): URLSearchParams {
  const n = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') n.delete(k);
    else n.set(k, v);
  }
  if (!keepPage && !('page' in patch)) n.delete('page');
  return n;
}

/** The Insights KPI tile (returns/RsBits Tile) with a grid className — so an odd tile can span a row. */
export function StatTile({ icon: Icon, label, value, sub, tone, alert, className }: {
  icon?: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: string; alert?: 'warning' | null; className?: string;
}) {
  return (
    <li className={cn('flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-sm', alert === 'warning' && 'border-amber-300 dark:border-amber-900', className)}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span className="min-w-0">{label}</span>
      </span>
      <span className={cn('break-words text-2xl font-semibold leading-tight tabular-nums', tone ?? 'text-card-foreground')}>{value}</span>
      {sub && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </li>
  );
}
