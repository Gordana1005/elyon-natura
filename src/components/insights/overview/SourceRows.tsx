import { Info } from 'lucide-react';
import type { OverviewSource } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrillLink } from './DrillLink';
import { BUCKET_ICON, OutcomeBar, OutcomeLegend, type BarBucket } from './OutcomeBar';
import { BAR_ORDER, BUCKET_TONE, TONE_TEXT, sourceColorVar } from './palette';
import { OUTCOME, ordersHref, placedOf, preparingOf, sourceDrill, splitDrill, type DayRange } from './model';
import type { OverviewFormat } from './useOverviewFormat';

const STATUS_TONE: Partial<Record<BarBucket, string>> = {
  delivered: TONE_TEXT.good, returned: TONE_TEXT.critical, cancelled: TONE_TEXT.warning,
};

/** A split chip's words: the Overview's own (new / returning, shop, …), else the
 *  shared cohort vocabulary (a department's sub-channels), else the key as sent.
 *  A key ending in `_other` is looked up camelCased there (i18next plural suffix). */
const splitLabel = (t: OverviewFormat['t'], key: string) =>
  t(`overview.split.${key}`, {
    defaultValue: t(`insights.common.split.${key.replace(/_other$/, 'Other')}`, { defaultValue: key }),
  });

/** "Од каде дојдоа парите" — one row per source, the shop panel's outcome card each. */
export function SourceRows({
  sources, range, money, f,
}: { sources: OverviewSource[]; range: DayRange; money: boolean; f: OverviewFormat }) {
  const { t } = f;
  return (
    <section aria-labelledby="ov-sources-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="ov-sources-title" className="text-base font-semibold">
            {money ? t('overview.sources.title') : t('overview.sources.titleNoMoney')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('overview.sources.subtitle')}</p>
        </div>
        <OutcomeLegend
          bucketLabel={f.bucketLabel}
          keys={BAR_ORDER.filter((b) => b !== 'no_record' || sources.some((s) => (s.buckets.no_record?.count ?? 0) > 0))}
        />
      </div>
      <details className="group rounded-lg text-xs text-muted-foreground">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <Info className="h-3.5 w-3.5" aria-hidden />{t('overview.sources.howCounted')}
        </summary>
        <p className="mt-1 max-w-3xl leading-relaxed">
          {t('overview.sources.howCountedText')} {money && t('overview.sources.howCountedMoney')}
        </p>
      </details>
      {sources.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('overview.sources.empty')}</p>
      ) : (
        sources.map((s) => <SourceRow key={s.key} s={s} range={range} money={money} f={f} />)
      )}
    </section>
  );
}

function SourceRow({ s, range, money, f }: { s: OverviewSource; range: DayRange; money: boolean; f: OverviewFormat }) {
  const { t } = f;
  const placed = placedOf(s);
  const linked = !!sourceDrill(s, range);
  const href = (outcome?: string) => ordersHref(sourceDrill(s, range, outcome ? { outcome } : {}));
  // The bar's "being prepared" is the shop panel's: to pack (`preparing`) + packed.
  const prep = preparingOf(s);
  const countOf = (b: BarBucket) => (b === 'preparing' ? prep.count : s.buckets[b]?.count ?? 0);
  // The core lifecycle always shows ("0 returned" is news); web history only when present.
  const tiles = BAR_ORDER.filter((b) => b !== 'no_record' || countOf(b) > 0);
  const outcomeOf = (b: BarBucket) => (b === 'preparing' ? OUTCOME.preparingAll : b);
  const moneyOf = (b: BarBucket): string | null => {
    if (!money) return null;
    if (b === 'preparing') return prep.value_eur != null ? f.eur(prep.value_eur) : null;
    const m = s.buckets[b];
    if (b === 'delivered' && m?.cod_mkd != null) return f.den(m.cod_mkd);
    return m?.value_eur != null ? f.eur(m.value_eur) : null;
  };
  const segments = BAR_ORDER.map((b) => ({ key: b, count: countOf(b), money: moneyOf(b), href: href(outcomeOf(b)) }));
  const finished = (s.buckets.delivered?.count ?? 0) + (s.buckets.returned?.count ?? 0);
  const mexOnly = s.buckets.mex_only;
  const unproven = money ? (s.money?.collected_unproven_mkd ?? 0) : 0;
  const shopPart = money ? (s.money?.collected_shop_mkd ?? 0) : 0;
  const unrecorded = money ? (s.money?.unrecorded_mkd ?? 0) : 0;
  const name = f.source(s.key);

  return (
    <article aria-labelledby={`ov-src-${s.key}`} className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      {/* Header: identity, placed, work */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="h-[3px] w-4 shrink-0 translate-y-[-3px] rounded-full" style={{ background: sourceColorVar(s.key) }} aria-hidden />
          <h3 id={`ov-src-${s.key}`} className="font-semibold">{name}</h3>
          <DrillLink href={href()} className="text-sm tabular-nums text-muted-foreground">
            {money && placed.value_eur != null
              ? t('overview.sources.placedLine', { n: f.int(placed.count), value: f.eur(placed.value_eur) })
              : t('overview.kpi.ordersN', { n: f.int(placed.count) })}
          </DrillLink>
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          {s.worked > 0 && <Stat label={t('overview.sources.worked')} value={f.int(s.worked)} />}
          {s.confirmed > 0 && <Stat label={t('overview.sources.confirmed')} value={f.int(s.confirmed)} />}
          {s.worked > 0 && s.conversion != null && <Stat label={t('overview.sources.conversion')} value={f.pct(s.conversion)} />}
          {money && s.aov_eur != null && <Stat label={t('overview.sources.aov')} value={f.eur(s.aov_eur)} />}
        </dl>
      </div>

      <OutcomeBar
        className="mt-3 h-3"
        segments={segments}
        label={`${name} — ${t('overview.sources.barLabel')}`}
        share={f.share}
        int={f.int}
        bucketLabel={f.bucketLabel}
      />
      {mexOnly && mexOnly.count > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {t('overview.sources.mexOnlyChip', { n: f.int(mexOnly.count) })}
          {money && mexOnly.cod_mkd != null && <> · <span className="tabular-nums">{f.den(mexOnly.cod_mkd)}</span></>}
        </p>
      )}

      {/* One tile per outcome — the core lifecycle always shows ("0 returned" is news). */}
      <ul className={cn('mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4', tiles.length > 7 ? '2xl:grid-cols-8' : 'xl:grid-cols-7')}>
        {tiles.map((b) => {
          const n = countOf(b);
          const Icon = BUCKET_ICON[b];
          return (
            <li key={b} className={cn('min-w-0 rounded-lg border px-2.5 py-2', n === 0 && 'opacity-50')}>
              <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', BUCKET_TONE[b])} aria-hidden />
                <span className="min-w-0 truncate" title={f.bucketLabel(b)}>{f.bucketLabel(b)}</span>
                <Icon className={cn('ml-auto h-3 w-3 shrink-0', STATUS_TONE[b] ?? 'text-muted-foreground')} aria-hidden />
              </span>
              <span className="mt-0.5 flex items-baseline justify-between gap-2">
                <DrillLink
                  href={n > 0 ? href(outcomeOf(b)) : null}
                  className="text-lg font-semibold tabular-nums text-card-foreground"
                  ariaLabel={`${name} · ${f.bucketLabel(b)}: ${f.int(n)}`}
                >
                  {f.int(n)}
                </DrillLink>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{f.share(n, placed.count)}</span>
              </span>
              {money && <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{moneyOf(b) ?? '—'}</span>}
              {b === 'preparing' && n > 0 && (
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  <DrillLink href={prep.packed > 0 ? href('packed') : null} className="tabular-nums">
                    {t('overview.sources.packedN', { n: f.int(prep.packed) })}
                  </DrillLink>
                  {' · '}
                  <DrillLink href={prep.toPack > 0 ? href('preparing') : null} className="tabular-nums">
                    {t('overview.sources.toPackN', { n: f.int(prep.toPack) })}
                  </DrillLink>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* Where the money stands (owners) — on the order-day clock, like the bar. */}
      {money && s.money && (
        <div className="mt-3 divide-y rounded-lg bg-muted/40 sm:grid sm:grid-cols-3 sm:gap-2 sm:divide-y-0 sm:bg-transparent" title={t('overview.clock.placed')}>
          <MoneyBlock dot={BUCKET_TONE.delivered} label={t('overview.money.collected')}
            hint={shopPart > 0
              ? t('overview.money.shopPart', { value: f.den(shopPart) })
              : unproven > 0 ? t('overview.money.unprovenPart', { value: f.den(unproven) }) : t('overview.money.collectedHint')}
            value={s.money.collected_mkd != null ? f.den(s.money.collected_mkd) : '—'} href={href('delivered')} />
          <MoneyBlock dot={BUCKET_TONE.courier} label={t('overview.money.to_collect')} hint={t('overview.money.toCollectHint')}
            value={s.money.to_collect_eur != null ? f.eur(s.money.to_collect_eur) : '—'} href={href(OUTCOME.toCollect)} />
          <MoneyBlock dot={BUCKET_TONE.returned} label={t('overview.money.lost')} hint={t('overview.money.lostHint')}
            value={s.money.lost_eur != null ? f.eur(s.money.lost_eur) : '—'} href={href(OUTCOME.lost)} />
        </div>
      )}
      {money && unrecorded > 0 && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t('overview.money.unrecorded', { value: f.den(unrecorded) })}</p>
      )}

      {/* Rates — for everyone; the no-money layout leans on these. */}
      <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 border-t pt-3">
        <Rate label={t('overview.rates.delivery')} value={f.share(s.buckets.delivered?.count ?? 0, finished)}
          hint={t('overview.rates.of', { a: f.int(s.buckets.delivered?.count ?? 0), b: f.int(finished) })} />
        <Rate label={t('overview.rates.returns')} value={f.share(s.buckets.returned?.count ?? 0, finished)}
          hint={t('overview.rates.of', { a: f.int(s.buckets.returned?.count ?? 0), b: f.int(finished) })} />
        <Rate label={t('overview.rates.cancel')} value={f.share(s.buckets.cancelled?.count ?? 0, placed.count)}
          hint={t('overview.rates.of', { a: f.int(s.buckets.cancelled?.count ?? 0), b: f.int(placed.count) })} />
      </dl>

      {s.splits.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('overview.sources.splits')}>
          {s.splits.map((sp) => {
            const h = sp.count > 0 ? ordersHref(splitDrill(s, sp, range)) : null;
            const splitMoney = sp.value_eur != null ? f.eur(sp.value_eur) : sp.cod_mkd != null ? f.den(sp.cod_mkd) : null;
            return (
              <li key={sp.key}>
                <DrillLink
                  href={h}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs no-underline',
                    h ? 'hover:border-foreground/30 hover:bg-muted hover:no-underline' : '',
                    sp.count === 0 && 'opacity-50',
                  )}
                >
                  <span className="text-muted-foreground">{splitLabel(t, sp.key)}</span>
                  <b className="font-semibold tabular-nums">{f.int(sp.count)}</b>
                  {money && splitMoney && <span className="tabular-nums text-muted-foreground">· {splitMoney}</span>}
                </DrillLink>
              </li>
            );
          })}
        </ul>
      )}

      {!linked && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {s.web_block ? t('overview.sources.noLinks') : t('overview.sources.noLinksOther')}
        </p>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt>{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function Rate({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-base font-semibold tabular-nums">{value}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{hint}</span>
      </dd>
    </div>
  );
}

function MoneyBlock({ dot, label, hint, value, href }: { dot: string; label: string; hint: string; value: string; href: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:block sm:rounded-lg sm:bg-muted/40">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />{label}
        </div>
        <div className="text-[11px] text-muted-foreground sm:hidden">{hint}</div>
      </div>
      <DrillLink href={href} className="shrink-0 text-base font-semibold tabular-nums sm:mt-0.5 sm:block sm:text-lg">{value}</DrillLink>
      <div className="hidden text-[11px] text-muted-foreground sm:block">{hint}</div>
    </div>
  );
}
