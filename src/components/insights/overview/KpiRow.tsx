import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, CheckCircle2, Minus, OctagonAlert, Sparkles } from 'lucide-react';
import type { OverviewSparkPoint } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrillLink } from './DrillLink';
import { Sparkline } from './Sparkline';
import { TONE_TEXT } from './palette';
import { delta, primaryOf, TILE_GOOD_WHEN, type Delta, type MeasureSet, type TileKey } from './model';
import type { OverviewFormat } from './useOverviewFormat';

const TILES: TileKey[] = ['placed', 'confirmed', 'at_courier', 'to_collect', 'lost', 'unproven_paid'];

export interface KpiRowProps {
  cur: MeasureSet;
  prev: MeasureSet | null;
  money: boolean;
  sparks: Partial<Record<TileKey, OverviewSparkPoint[] | null>>;
  hrefs: Partial<Record<TileKey, string | null>>;
  /** "vs 15.09 – 21.09", or null when compare is off. */
  prevLabel: string | null;
  /** A source filter is active: values are the selected sources only. */
  filtered: boolean;
  f: OverviewFormat;
}

/** Hero (MEX-proven cash) + six stat tiles, each with its delta and sparkline. */
export function KpiRow({ cur, prev, money, sparks, hrefs, prevLabel, filtered, f }: KpiRowProps) {
  const { t } = f;
  const fmtPrimary = (k: TileKey, v: number | null) => {
    if (v == null) return '—';
    if (money && k === 'delivered') return f.den(v);
    if (money && (k === 'placed' || k === 'to_collect' || k === 'lost')) return f.eur(v);
    return f.int(v);
  };
  const secondary = (k: TileKey): string | null => {
    const m = cur[k];
    if (!m) return null;
    if (k === 'delivered') {
      if (!money) return null;              // the hero already IS the parcel count
      const n = m.proven_count ?? m.count;
      return n != null ? t('overview.kpi.parcelsN', { n: f.int(n) }) : null;
    }
    if (!money) return null;
    if (k === 'unproven_paid') return m.cod_mkd != null ? f.den(m.cod_mkd) : m.value_eur != null ? f.eur(m.value_eur) : null;
    if (k === 'placed' || k === 'to_collect' || k === 'lost') {
      return m.count != null ? t('overview.kpi.ordersN', { n: f.int(m.count) }) : t('overview.kpi.notSplit');
    }
    return m.value_eur != null ? f.eur(m.value_eur) : null;
  };
  const deltaOf = (k: TileKey): Delta | null =>
    prev ? delta(primaryOf(k, cur[k], money), primaryOf(k, prev[k], money), TILE_GOOD_WHEN[k]) : null;

  const hero = cur.delivered;
  const heroValue = primaryOf('delivered', hero, money);

  return (
    <section aria-labelledby="ov-kpi-title" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="ov-kpi-title" className="sr-only">{t('overview.kpi.title')}</h2>
        {filtered && (
          <span className="text-[11px] font-medium text-muted-foreground">{t('overview.kpi.filtered')}</span>
        )}
        {prevLabel && <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{prevLabel}</span>}
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,9fr)]">
        {/* Hero — the one number this page leads with. */}
        <div className="flex flex-col justify-between rounded-xl border bg-card p-4 shadow-sm sm:p-5" title={t('overview.kpiHint.delivered')}>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              {money ? t('overview.kpi.heroLabel') : t('overview.kpi.heroLabelNoMoney')}
            </p>
            <DrillLink
              href={hrefs.delivered}
              className="mt-1 block break-words text-[clamp(2.25rem,8vw,3.5rem)] font-semibold leading-[1.05] tracking-tight text-card-foreground"
            >
              {fmtPrimary('delivered', heroValue)}
            </DrillLink>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {secondary('delivered') && <span className="text-muted-foreground">{secondary('delivered')}</span>}
              <DeltaBadge d={deltaOf('delivered')} f={f} />
            </div>
            {(hero?.mex_only_count ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {money && hero?.mex_only_cod_mkd != null
                  ? t('overview.kpi.mexOnlyPartMoney', { n: f.int(hero.mex_only_count), value: f.den(hero.mex_only_cod_mkd) })
                  : t('overview.kpi.mexOnlyPart', { n: f.int(hero?.mex_only_count) })}
              </p>
            )}
          </div>
          <Sparkline className="mt-4 h-16" points={sparks.delivered} accentClass="bg-[#059669] dark:bg-[#10b981]" />
        </div>

        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {TILES.map((k) => (
            <Tile
              key={k}
              label={t(`overview.kpi.${k}`)}
              hint={t(`overview.kpiHint.${k}`)}
              value={fmtPrimary(k, primaryOf(k, cur[k], money))}
              href={hrefs[k]}
              sub={secondary(k)}
              d={deltaOf(k)}
              spark={sparks[k]}
              status={k === 'unproven_paid' ? <UnprovenStatus count={cur.unproven_paid?.count ?? null} f={f} /> : null}
              alert={k === 'unproven_paid' && (cur.unproven_paid?.count ?? 0) > 0}
              f={f}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function Tile({ label, hint, value, href, sub, d, spark, status, alert, f }: {
  label: string; hint: string; value: string; href?: string | null; sub: string | null;
  d: Delta | null; spark?: OverviewSparkPoint[] | null; status: ReactNode; alert?: boolean; f: OverviewFormat;
}) {
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4',
        alert && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
      )}
      title={hint}
    >
      <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
      <DrillLink href={href} className="mt-1 block truncate text-xl font-semibold text-card-foreground sm:text-2xl">
        {value}
      </DrillLink>
      {sub && <span className="truncate text-xs tabular-nums text-muted-foreground">{sub}</span>}
      <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-2">
        {status}
        <DeltaBadge d={d} f={f} />
      </div>
      <Sparkline className="mt-auto pt-2" points={spark} />
    </li>
  );
}

/** Signed change vs the previous period: arrow + number + tone; never colour alone. */
export function DeltaBadge({ d, f }: { d: Delta | null; f: OverviewFormat }) {
  const { t } = f;
  if (!d || d.dir === 'none') return null;
  const tone = d.tone === 'good' ? TONE_TEXT.good : d.tone === 'bad' ? TONE_TEXT.critical : TONE_TEXT.neutral;
  if (d.dir === 'flat') {
    return (
      <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', TONE_TEXT.neutral)}>
        <Minus className="h-3.5 w-3.5" aria-hidden />{t('overview.delta.flat')}
      </span>
    );
  }
  if (d.dir === 'new') {
    return (
      <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', tone)}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden />{t('overview.delta.new')}
      </span>
    );
  }
  const Icon = d.dir === 'up' ? ArrowUpRight : ArrowDownRight;
  const pct = f.pct(Math.abs(d.pct ?? 0));
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', tone)}
      aria-label={t(d.dir === 'up' ? 'overview.delta.upAria' : 'overview.delta.downAria', { pct })}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {d.dir === 'up' ? '+' : '−'}{pct}
    </span>
  );
}

/** "Unproven paid" must read 0 — say so in words and an icon, not just colour. */
function UnprovenStatus({ count, f }: { count: number | null; f: OverviewFormat }) {
  const { t } = f;
  if (count == null) return null;
  if (count === 0) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', TONE_TEXT.good)}>
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />{t('overview.kpi.unprovenOk')}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', TONE_TEXT.critical)}>
      <OctagonAlert className="h-3.5 w-3.5" aria-hidden />{t('overview.kpi.unprovenBad')}
    </span>
  );
}
