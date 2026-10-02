import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, Boxes, CircleCheck, ClipboardList, Flag, Package, PackageOpen,
  RotateCcw, Search, SlidersHorizontal, Truck, Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Chip, LABEL } from '@/components/assigner/parts';
import { isYmd, skopjeToday } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { apiStockV2Day } from '@/lib/stockV2Api';
import type { StockDay, StockDayArticle } from '@/lib/stockV2Types';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import { ArticleDrawer } from './ArticleDrawer';
import {
  DayTimeStepper, Empty, Failed, FreshnessLine, Loading, PreviewBanner, StatTile as Tile, WarehousePicker, patchParams,
  useStockHealthLite, usePreviewFlag, useWarehouseOptions,
} from './shared';
import { ARTICLE_SORTS, fmtCover, fmtQty, fmtSigned, filterArticles, hasKey, parseHm, type ArticleSort } from './stockV2Model';

const FIRST_ROWS = 100;

/**
 * Магацин → Залихи (stock v2): the stock of one warehouse on one Skopje day (optionally at a time
 * of day) — what it opened with, what left in parcels, came back, came in from Sigma, other ways
 * out, corrections, and what it closed with; then what of it sits in parcels to pack / with the
 * courier, is reserved, and is free. Per article: a table from lg (compact columns until xl),
 * cards below; a drawer per article with its daily line and moves. URL: day · at · wh · q · neg ·
 * sort · art.
 */
export function StockDayTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const today = skopjeToday();
  const dayParam = sp.get('day');
  const day = isYmd(dayParam) && dayParam <= today ? dayParam : today;
  const at = parseHm(sp.get('at'));
  const wh = sp.get('wh') || 'main';
  const q = sp.get('q') ?? '';
  const neg = sp.get('neg') === '1';
  const sortParam = sp.get('sort') as ArticleSort | null;
  const art = sp.get('art');
  const set = (patch: Record<string, string | null>) => setSp((p) => patchParams(p, patch), { replace: true });

  const health = useStockHealthLite();
  const preview = usePreviewFlag();
  const data = useQuery<StockDay>({
    queryKey: ['stock2', 'day', day, wh, at, preview],
    queryFn: () => apiStockV2Day({ day, warehouse: wh, at, preview }),
    enabled: preview !== undefined,
    staleTime: 60_000,
    refetchInterval: day === today ? 5 * 60_000 : false,
  });
  const d = data.data;
  const options = useWarehouseOptions(f, { health: health.data, seen: d?.warehouse });
  const money = !!d && (hasKey(d.totals, 'value_mkd') || d.articles.some((a) => hasKey(a, 'value_mkd')));
  const sort: ArticleSort = sortParam && ARTICLE_SORTS.includes(sortParam) && (sortParam !== 'value' || money) ? sortParam : 'out';
  const rows = useMemo(() => filterArticles(d?.articles ?? [], { q, negative: neg, sort }, f.lang), [d, q, neg, sort, f.lang]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);
  const wide = useMinWidth(1024);
  const full = useMinWidth(1280);
  const openingDay = d?.opening?.counted_at ? formatSkopje(d.opening.counted_at, 'yyyy-MM-dd') : null;

  return (
    <div className="space-y-4" data-testid="stock2-day-tab">
      {d?.preview && <PreviewBanner f={f} />}

      <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <DayTimeStepper day={day} today={today} onDay={(v) => set({ day: v === today ? null : v })}
            at={at} onAt={(hm) => set({ at: hm })} min={openingDay ?? undefined} f={f} />
          <WarehousePicker value={wh} onChange={(v) => set({ wh: v === 'main' ? null : v, art: null })} options={options} f={f} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <FreshnessLine freshness={d?.freshness} f={f} showRun={d?.enabled} />
          {d && (d.opening ? (
            <p className="text-[11px] text-muted-foreground">
              {t('stock2.day.openingLine', { at: formatSkopje(d.opening.counted_at, 'dd.MM.yyyy HH:mm'), status: t(`stock2.countStatus.${d.opening.status}`, { defaultValue: d.opening.status }) })}
            </p>
          ) : (
            <p className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('stock2.day.noOpening')}
            </p>
          ))}
        </div>
      </section>

      {data.isLoading || preview === undefined ? <Loading /> : data.isError ? <Failed error={data.error} onRetry={() => void data.refetch()} /> : !d ? null : (
        <>
          <Totals d={d} f={f} money={money} today={day === today} />

          <div className="flex flex-wrap items-end gap-2">
            <label className="relative min-w-0 flex-1 basis-56">
              <span className="sr-only">{t('stock2.day.search')}</span>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => set({ q: e.target.value || null })} placeholder={t('stock2.day.search')} className="h-9 pl-9" />
            </label>
            <Chip on={neg} onClick={() => set({ neg: neg ? null : '1' })}>
              {t('stock2.day.onlyNegative', { n: f.int(d.totals.negatives) })}
            </Chip>
            <label className="flex items-center gap-1.5">
              <span className={LABEL}>{t('stock2.day.sort')}</span>
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={sort} onChange={(e) => set({ sort: e.target.value === 'out' ? null : e.target.value })}>
                {ARTICLE_SORTS.filter((s) => s !== 'value' || money).map((s) => <option key={s} value={s}>{t(`stock2.day.sortBy.${s}`)}</option>)}
              </select>
            </label>
            <span className="ml-auto text-xs text-muted-foreground">{t('stock2.day.shown', { n: f.int(rows.length), total: f.int(d.articles.length) })}</span>
          </div>

          {rows.length === 0 ? (
            <Empty icon={<Package className="h-5 w-5" />} title={d.articles.length ? t('stock2.day.noMatch') : t('stock2.day.empty')} />
          ) : wide ? (
            <ArticleTable rows={shown} f={f} money={money} full={full} onOpen={(c) => set({ art: c })} />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" aria-label={t('stock2.day.articles')}>
              {shown.map((a) => <ArticleCard key={a.code} a={a} f={f} money={money} onOpen={() => set({ art: a.code })} />)}
            </ul>
          )}
          {!showAll && rows.length > FIRST_ROWS && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>{t('stock2.day.showAll', { n: f.int(rows.length) })}</Button>
            </div>
          )}
        </>
      )}

      <ArticleDrawer code={art} warehouse={wh} day={day} preview={preview} f={f} opening={openingDay} onClose={() => set({ art: null })} />
    </div>
  );
}

function Totals({ d, f, money, today }: { d: StockDay; f: InsightsFormat; money: boolean; today: boolean }) {
  const { t } = f;
  const x = d.totals;
  const q = (v: number) => fmtQty(v, f.lang);
  return (
    <div className="space-y-3">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7" aria-label={t('stock2.day.flowTitle')}>
        <Tile icon={Flag} label={t('stock2.tile.opening')} value={q(x.opening)} sub={t('stock2.tile.openingSub')} />
        <Tile icon={ArrowUpRight} label={t('stock2.tile.out')} value={q(x.out)} sub={t('stock2.tile.outSub')} />
        <Tile icon={Undo2} label={t('stock2.tile.back')} value={q(x.back)} sub={t('stock2.tile.backSub')} />
        <Tile icon={ArrowDownRight} label={t('stock2.tile.in')} value={q(x.in)} sub={t('stock2.tile.inSub')} />
        <Tile icon={RotateCcw} label={t('stock2.tile.otherOut')} value={q(x.other_out)} sub={t('stock2.tile.otherOutSub')} />
        <Tile icon={SlidersHorizontal} label={t('stock2.tile.adjust')} value={fmtSigned(x.adjust, f.lang)} sub={t('stock2.tile.adjustSub')} />
        <Tile icon={Boxes} label={t('stock2.tile.closing')} value={q(x.closing)} className="col-span-2 sm:col-span-3 lg:col-span-2 2xl:col-span-1"
          alert={x.negatives > 0 ? 'warning' : null}
          sub={x.negatives > 0 ? t('stock2.tile.closingNeg', { count: x.negatives, n: f.int(x.negatives) }) : t('stock2.tile.closingSub', { count: x.articles, n: f.int(x.articles) })} />
      </ul>
      <ul className={cn('grid grid-cols-2 gap-3', money ? 'sm:grid-cols-3 lg:grid-cols-5' : 'lg:grid-cols-4')} aria-label={t('stock2.day.positionTitle')}>
        <Tile icon={PackageOpen} label={t('stock2.tile.toPack')} value={q(x.to_pack)} sub={t('stock2.tile.toPackSub')} />
        <Tile icon={Truck} label={t('stock2.tile.withCourier')} value={q(x.with_courier)} sub={t('stock2.tile.withCourierSub')} />
        <Tile icon={ClipboardList} label={t('stock2.tile.reserved')} value={q(x.reserved)} sub={today ? t('stock2.tile.reservedSub') : t('stock2.tile.reservedPast')} />
        <Tile icon={CircleCheck} label={t('stock2.tile.available')} value={q(x.available)} tone={x.available < 0 ? 'text-red-700 dark:text-red-400' : undefined} sub={t('stock2.tile.availableSub')} />
        {money && <Tile icon={Banknote} className="col-span-2 sm:col-span-1" label={t('stock2.tile.value')} value={x.value_mkd != null ? f.den(x.value_mkd) : '—'} sub={t('stock2.tile.valueSub')} />}
      </ul>
    </div>
  );
}

// Auto layout: every number column is as wide as its longest word / number (headers wrap only
// between words), the article column takes the rest and wraps — no clipped or touching headers.
const th = 'px-1.5 py-2 text-right font-medium align-bottom';
const td = 'whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums';

function ArticleTable({ rows, f, money, full, onOpen }: {
  rows: StockDayArticle[]; f: InsightsFormat; money: boolean; full: boolean; onOpen: (code: string) => void;
}) {
  const { t } = f;
  const q = (v: number) => fmtQty(v, f.lang);
  const zero = (v: number) => (v === 0 ? 'text-muted-foreground/60' : '');
  return (
    <div className="rounded-xl border bg-card shadow-sm" data-testid="stock2-article-table">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50 text-[11px] leading-tight text-muted-foreground">
            <th scope="col" className="w-full min-w-[9rem] px-3 py-2 text-left font-medium align-bottom">{t('stock2.col.article')}</th>
            <th scope="col" className={th}>{t('stock2.col.opening')}</th>
            <th scope="col" className={th}>{t('stock2.col.out')}</th>
            <th scope="col" className={th}>{t('stock2.col.back')}</th>
            {full ? (
              <>
                <th scope="col" className={th}>{t('stock2.col.in')}</th>
                <th scope="col" className={th}>{t('stock2.col.otherOut')}</th>
                <th scope="col" className={th}>{t('stock2.col.adjust')}</th>
              </>
            ) : <th scope="col" className={th} title={t('stock2.col.otherNetHint')}>{t('stock2.col.otherNet')}</th>}
            <th scope="col" className={th}>{t('stock2.col.closing')}</th>
            <th scope="col" className={th}>{t('stock2.col.toPack')}</th>
            <th scope="col" className={th}>{t('stock2.col.withCourier')}</th>
            {full && <th scope="col" className={th}>{t('stock2.col.reserved')}</th>}
            <th scope="col" className={th}>{t('stock2.col.available')}</th>
            {full && <th scope="col" className={th}>{t('stock2.col.cover')}</th>}
            {money && <th scope="col" className={cn(th, 'pr-3')}>{t('stock2.col.value')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const isNeg = a.negative || a.closing < 0;
            const cover = fmtCover(a.days_cover, f.lang);
            return (
              <tr key={a.code} className={cn('border-b last:border-0 hover:bg-muted/40', isNeg && 'bg-red-50/70 dark:bg-red-950/25')} data-negative={isNeg || undefined}>
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  <button type="button" onClick={() => onOpen(a.code)} className="block w-full min-w-0 text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="block break-words text-[13px] font-medium">{a.name}</span>
                    <span className="text-[11px] text-muted-foreground">{a.code}{a.unit && a.unit !== 'КОМ' ? ` · ${a.unit}` : ''}</span>
                  </button>
                </th>
                <td className={cn(td, zero(a.opening))}>{q(a.opening)}</td>
                <td className={cn(td, zero(a.out))}>{q(a.out)}</td>
                <td className={cn(td, zero(a.back))}>{q(a.back)}</td>
                {full ? (
                  <>
                    <td className={cn(td, zero(a.in))}>{q(a.in)}</td>
                    <td className={cn(td, zero(a.other_out))}>{q(a.other_out)}</td>
                    <td className={cn(td, zero(a.adjust))}>{fmtSigned(a.adjust, f.lang)}</td>
                  </>
                ) : <td className={cn(td, zero(a.in - a.other_out + a.adjust))}>{fmtSigned(a.in - a.other_out + a.adjust, f.lang)}</td>}
                <td className={cn(td, 'font-semibold', isNeg && 'text-red-700 dark:text-red-400')}>{q(a.closing)}</td>
                <td className={cn(td, zero(a.to_pack))}>{q(a.to_pack)}</td>
                <td className={cn(td, zero(a.with_courier))}>{q(a.with_courier)}</td>
                {full && <td className={cn(td, zero(a.reserved))}>{q(a.reserved)}</td>}
                <td className={cn(td, 'font-medium', a.available < 0 && 'text-red-700 dark:text-red-400')}>{q(a.available)}</td>
                {full && <td className={cn(td, 'text-muted-foreground')}>{cover != null ? t('stock2.day.coverDays', { n: cover }) : '—'}</td>}
                {money && <td className={cn(td, 'pr-3 text-muted-foreground')}>{a.value_mkd != null ? f.den(a.value_mkd) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ArticleCard({ a, f, money, onOpen }: { a: StockDayArticle; f: InsightsFormat; money: boolean; onOpen: () => void }) {
  const { t } = f;
  const q = (v: number) => fmtQty(v, f.lang);
  const isNeg = a.negative || a.closing < 0;
  const cover = fmtCover(a.days_cover, f.lang);
  const stat = (label: string, value: string, tone?: string) => (
    <div className="min-w-0">
      <dt className="break-words text-[10px] uppercase leading-tight tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('text-sm font-medium tabular-nums', tone)}>{value}</dd>
    </div>
  );
  return (
    <li className={cn('rounded-xl border bg-card shadow-sm', isNeg && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/25')} data-testid="stock2-article-card" data-negative={isNeg || undefined}>
      <button type="button" onClick={onOpen} className="block w-full space-y-2 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{a.name}</p>
            <p className="text-[11px] text-muted-foreground">{a.code}{a.unit && a.unit !== 'КОМ' ? ` · ${a.unit}` : ''}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className={cn('text-xl font-semibold leading-tight tabular-nums', isNeg && 'text-red-700 dark:text-red-400')}>{q(a.closing)}</p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('stock2.col.closing')}</p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-2 gap-y-1.5">
          {stat(t('stock2.col.out'), q(a.out))}
          {stat(t('stock2.col.back'), q(a.back))}
          {stat(t('stock2.col.otherNet'), fmtSigned(a.in - a.other_out + a.adjust, f.lang))}
          {stat(t('stock2.col.toPack'), q(a.to_pack))}
          {stat(t('stock2.col.withCourier'), q(a.with_courier))}
          {stat(t('stock2.col.available'), q(a.available), a.available < 0 ? 'text-red-700 dark:text-red-400' : undefined)}
        </dl>
        {(cover != null || (money && a.value_mkd != null) || a.reserved > 0) && (
          <p className="text-[11px] text-muted-foreground">
            {[
              a.reserved > 0 ? t('stock2.day.reservedN', { n: q(a.reserved) }) : null,
              cover != null ? t('stock2.day.coverLine', { n: cover }) : null,
              money && a.value_mkd != null ? f.den(a.value_mkd) : null,
            ].filter(Boolean).join(' · ')}
          </p>
        )}
      </button>
    </li>
  );
}
