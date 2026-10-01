import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, History } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { dm } from '@/components/insights/overview/useOverviewFormat';
import { addDays } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiStockV2Article } from '@/lib/stockV2Api';
import type { StockArticleSeriesPoint } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { MoveCard } from './moves';
import { Empty, Failed, Loading } from './shared';
import { HOURLY_COLOR_VARS, fmtQty, fmtSigned, hasKey, s2Var } from './stockV2Model';

const SPANS = [14, 30, 90] as const;

/**
 * One article: the daily closing balance (a line, the zero line marked) over the last 14 / 30 / 90
 * days up to the viewed day, and its moves (newest first, capped at 200 by the api). The article
 * is in the URL (?art=), so the drawer can be linked.
 */
export function ArticleDrawer({ code, warehouse, day, preview, f, onClose, opening }: {
  code: string | null; warehouse: string; day: string; preview: boolean | undefined; f: InsightsFormat; onClose: () => void;
  /** the opening count's day — the series never starts before it */
  opening?: string | null;
}) {
  const { t } = f;
  const [span, setSpan] = useState<(typeof SPANS)[number]>(30);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  let from = addDays(day, -(span - 1));
  if (opening && from < opening) from = opening;
  const q = useQuery({
    queryKey: ['stock2', 'article', code, warehouse, from, day, preview],
    queryFn: () => apiStockV2Article({ code: code!, warehouse, from, to: day, preview }),
    enabled: !!code && preview !== undefined,
    staleTime: 60_000,
  });
  const a = q.data;
  const series = a?.series ?? [];
  const negative = series.some((p) => p.closing < 0);
  const moveHref = code
    ? `/warehouse?${new URLSearchParams({ tab: 'movements', art: code, wh: warehouse, from, to: day }).toString()}`
    : '#';

  return (
    <Sheet open={!!code} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }} className={cn('flex w-full flex-col gap-3 overflow-y-auto p-4 sm:max-w-xl sm:p-6', HOURLY_COLOR_VARS)} data-testid="stock2-article-drawer">
        <SheetHeader className="space-y-1 pr-6 text-left">
          <SheetTitle className="break-words text-base">{a?.article.name ?? code}</SheetTitle>
          <SheetDescription className="text-xs">
            {code}{a?.article.unit ? ` · ${a.article.unit}` : ''}{a ? ` · ${a.warehouse.name}` : ''}
            {a && hasKey(a.article, 'cost_mkd') && a.article.cost_mkd != null ? ` · ${t('stock2.day.costEach', { v: f.den(a.article.cost_mkd) })}` : ''}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label={t('stock2.drawer.span')} className="inline-flex rounded-lg border p-0.5">
            {SPANS.map((s) => (
              <button key={s} type="button" aria-pressed={span === s} onClick={() => setSpan(s)}
                className={cn('rounded-md px-2.5 py-1 text-xs', span === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {t('stock2.drawer.days', { n: s })}
              </button>
            ))}
          </div>
          <div role="group" aria-label={t('stock2.drawer.view')} className="inline-flex rounded-lg border p-0.5">
            {(['chart', 'table'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                className={cn('rounded-md px-2.5 py-1 text-xs', view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {t(`stock2.drawer.${v}`)}
              </button>
            ))}
          </div>
        </div>

        {q.isLoading || preview === undefined ? <Loading /> : q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : !a ? null : (
          <>
            <section aria-label={t('stock2.drawer.closingTitle')} className="min-w-0 rounded-xl border bg-card p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('stock2.drawer.closingTitle')}</p>
              {series.length === 0 ? <p className="py-6 text-center text-xs text-muted-foreground">{t('stock2.drawer.noSeries')}</p>
                : view === 'chart' ? <ClosingChart points={series} f={f} negative={negative} /> : <SeriesTable points={series} f={f} />}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-sm font-medium"><History className="h-4 w-4" aria-hidden />{t('stock2.drawer.moves', { n: f.int(a.moves.length) })}</h3>
                <Link to={moveHref} onClick={onClose} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {t('stock2.drawer.allMoves')}<ArrowRight className="h-3 w-3" aria-hidden />
                </Link>
              </div>
              {a.moves.length === 0 ? <Empty title={t('stock2.drawer.noMoves')} /> : (
                <ul className="space-y-2">
                  {a.moves.map((m) => <MoveCard key={m.id} m={m} f={f} showArticle={false} showWarehouse={false} />)}
                </ul>
              )}
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ClosingChart({ points, f, negative }: { points: StockArticleSeriesPoint[]; f: InsightsFormat; negative: boolean }) {
  const { t } = f;
  const last = points[points.length - 1];
  return (
    <figure className="min-w-0">
      <div className="h-[200px]" role="img" aria-label={t('stock2.drawer.chartAria', { n: fmtQty(last?.closing, f.lang), day: dm(last?.day ?? '', true) })}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={s2Var('grid')} />
            <XAxis dataKey="day" tickFormatter={(d) => dm(String(d))} minTickGap={18}
              tick={{ fontSize: 11, fill: s2Var('axis') }} axisLine={{ stroke: s2Var('grid') }} tickLine={false} />
            <YAxis width={52} tickFormatter={(v) => fmtQty(Number(v), f.lang)} tickCount={5} allowDecimals={false}
              tick={{ fontSize: 11, fill: s2Var('axis') }} axisLine={false} tickLine={false} />
            {negative && <ReferenceLine y={0} stroke={s2Var('neg')} strokeDasharray="4 3" />}
            <Tooltip
              cursor={{ stroke: s2Var('axis'), strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as StockArticleSeriesPoint;
                return (
                  <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                    <div className="mb-0.5 text-muted-foreground">{dm(p.day, true)}</div>
                    <div className="tabular-nums"><b>{fmtQty(p.closing, f.lang)}</b> {t('stock2.col.closing')}</div>
                    <div className="tabular-nums text-muted-foreground">
                      {t('stock2.col.out')} {fmtQty(p.out, f.lang)} · {t('stock2.col.back')} {fmtQty(p.back, f.lang)} · {t('stock2.col.in')} {fmtQty(p.in, f.lang)}
                    </div>
                  </div>
                );
              }}
            />
            <Line type="linear" dataKey="closing" stroke={s2Var('line')} strokeWidth={2} dot={points.length <= 31 ? { r: 2 } : false}
              activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function SeriesTable({ points, f }: { points: StockArticleSeriesPoint[]; f: InsightsFormat }) {
  const { t } = f;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-muted-foreground">
            <th scope="col" className="px-1 py-1 text-left font-medium">{t('stock2.common.day')}</th>
            <th scope="col" className="px-1 py-1 text-right font-medium">{t('stock2.col.out')}</th>
            <th scope="col" className="px-1 py-1 text-right font-medium">{t('stock2.col.back')}</th>
            <th scope="col" className="px-1 py-1 text-right font-medium">{t('stock2.col.otherNet')}</th>
            <th scope="col" className="px-1 py-1 text-right font-medium">{t('stock2.col.closing')}</th>
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.day} className="border-b last:border-0">
              <th scope="row" className="px-1 py-0.5 text-left font-normal">{dm(p.day, true)}</th>
              <td className="px-1 py-0.5 text-right">{fmtQty(p.out, f.lang)}</td>
              <td className="px-1 py-0.5 text-right">{fmtQty(p.back, f.lang)}</td>
              <td className="px-1 py-0.5 text-right">{fmtSigned(p.in - p.other_out + p.adjust, f.lang)}</td>
              <td className={cn('px-1 py-0.5 text-right font-medium', p.closing < 0 && 'text-red-700 dark:text-red-400')}>{fmtQty(p.closing, f.lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
