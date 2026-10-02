import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, Clock, Equal, EqualNot, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiErrorText } from '@/i18n/apiErrors';
import { LoadError } from '@/components/insights/shared/LoadError';
import { TONE_TEXT } from '@/components/insights/overview/palette';
import { controlState, vsDir } from './shopsModel';
import type { ShopsFormat } from './useShopsFormat';

// The Insights card language, nothing new: rounded-xl cards, muted labels, tabular numbers,
// status = icon + word + tone (never colour alone).

/** CSS variables for the page's single-series charts: the reference theme's slot-1 blue,
 *  validated light #2a78d6 / dark #3987e5 (the Overview palette), plus its grid and axis. */
export const SHOPS_COLOR_VARS =
  '[--sh-bar:#2a78d6] dark:[--sh-bar:#3987e5] [--sh-bar-soft:#2a78d680] dark:[--sh-bar-soft:#3987e580] ' +
  '[--ov-grid:#e5e7eb] dark:[--ov-grid:#262c3b] [--ov-axis:#6b7280] dark:[--ov-axis:#8b93a7]';

export function Section({
  id, title, subtitle, actions, children, className,
}: { id: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A KPI tile (the Overview's Tile): label, the number, a line under it. */
export function Tile({
  label, value, sub, hint, alert, children, className,
}: { label: string; value: ReactNode; sub?: ReactNode; hint?: string; alert?: boolean; children?: ReactNode; className?: string }) {
  return (
    <li
      className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4', alert && 'border-amber-300 dark:border-amber-900', className)}
      title={hint}
    >
      <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
      <span className="mt-1 break-words text-lg font-semibold leading-tight tabular-nums text-card-foreground sm:text-xl 2xl:text-2xl">{value}</span>
      {sub && <span className="mt-0.5 text-xs tabular-nums text-muted-foreground">{sub}</span>}
      {children}
    </li>
  );
}

/** Signed change vs the average: arrow + number + tone; flat / none in words. */
export function VsAvgBadge({ pct, f, className }: { pct: number | null | undefined; f: ShopsFormat; className?: string }) {
  const { t } = f;
  const dir = vsDir(pct);
  if (dir === 'none') return <span className={cn('text-xs text-muted-foreground', className)}>{t('shops.vs.none')}</span>;
  if (dir === 'flat') {
    return (
      <span className={cn('inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium', TONE_TEXT.neutral, className)}>
        <Equal className="h-3.5 w-3.5" aria-hidden />{t('shops.vs.flat')}
      </span>
    );
  }
  const shown = f.pctUnits(Math.abs(pct as number));
  const Icon = dir === 'up' ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-semibold tabular-nums', dir === 'up' ? TONE_TEXT.good : TONE_TEXT.critical, className)}
      aria-label={t(dir === 'up' ? 'shops.vs.upAria' : 'shops.vs.downAria', { pct: shown })}
      title={t(dir === 'up' ? 'shops.vs.upAria' : 'shops.vs.downAria', { pct: shown })}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />{dir === 'up' ? '+' : '−'}{shown}
    </span>
  );
}

const CONTROL = {
  ok: { icon: Check, tone: TONE_TEXT.good, border: 'border-emerald-300 dark:border-emerald-900' },
  diff: { icon: EqualNot, tone: TONE_TEXT.critical, border: 'border-red-300 dark:border-red-900' },
  pending: { icon: Clock, tone: TONE_TEXT.neutral, border: '' },
} as const;

/** The daily control: receipt lines vs the shop's daily report — ✓ / ≠ / not yet. */
export function ControlBadge({ ok, f }: { ok: boolean | null | undefined; f: ShopsFormat }) {
  const { t } = f;
  const s = controlState(ok);
  const c = CONTROL[s];
  const Icon = c.icon;
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-card px-2 py-0.5 text-[11px] font-medium', c.border, c.tone)}
      title={t(`shops.control.${s}Hint`)}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />{t(`shops.control.${s}`)}
    </span>
  );
}

/** 0 in this shop but among the chain's top sellers. */
export function TopSellerZero({ f, className }: { f: ShopsFormat; className?: string }) {
  const { t } = f;
  return (
    <span
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-300', className)}
      title={t('shops.detail.zeroTopHint')}
    >
      <Flame className="h-3 w-3 shrink-0" aria-hidden />{t('shops.detail.zeroTop')}
    </span>
  );
}

/** A labelled value inside a card (label above, number below). */
export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** A small "loading / error / empty" frame for a tab body. */
export function Loading() {
  return (
    <div className="flex justify-center py-12" role="status">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
    </div>
  );
}

/** A failed fetch, with a retry — `forbidden` (the api's answer for a login without access) in words. */
export function ShopsLoadError({ error, onRetry, f }: { error: unknown; onRetry: () => void; f: ShopsFormat }) {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const text = /^(forbidden|owners_only)$/i.test(msg.trim()) ? f.t('shops.forbidden') : apiErrorText(error);
  return <LoadError text={text} onRetry={onRetry} />;
}
