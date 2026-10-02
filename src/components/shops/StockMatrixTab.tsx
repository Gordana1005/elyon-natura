import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Flame, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';
import { Chip } from '@/components/assigner/parts';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { addDays, isYmd } from '@/components/insights/shared/period';
import type { ShopRef } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { Loading, ShopsLoadError } from './parts';
import {
  NO_BRAND, TOP_SELLERS_N, brandsOf, compactQty, filterMatrix, qtyIn, topSellerCodes, withParam, zeroShops,
  type MatrixArticle,
} from './shopsModel';
import { useStockMatrix } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

/** Articles shown before "show more". */
const MATRIX_PAGE = 40;

const zeroTop = 'bg-red-100 font-semibold text-red-800 dark:bg-red-950/60 dark:text-red-200';

/**
 * Залиха низ продавници: every article × every shop at `at` (now by default). On xl+ a matrix
 * (articles down, shops across, the article column sticky — it scrolls inside its own frame only
 * if the shops do not fit); below xl one card per article with its shops wrapped in a grid, so
 * the page never scrolls sideways. A zero of one of the chain's top sellers is red. Search,
 * brand and "only top sellers with a zero" live in the URL (q / brand / gaps / at).
 */
export function StockMatrixTab({ today, f }: { today: string; f: ShopsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const rawAt = sp.get('at');
  const atDay = isYmd(rawAt) && rawAt < today ? rawAt : null;
  const q = useStockMatrix(atDay, today);
  const m = q.data;
  const search = sp.get('q') ?? '';
  const brand = sp.get('brand');
  const gaps = sp.get('gaps') === '1';
  const set = (k: string, v: string | boolean | null) => setSp(withParam(sp, k, v), { replace: true });

  const top = useMemo(() => (m ? topSellerCodes(m.articles) : new Set<string>()), [m]);
  const brands = useMemo(() => (m ? brandsOf(m.articles) : []), [m]);
  const rows = useMemo(() => (m ? filterMatrix(m, { q: search, brand, gaps }, top) : []), [m, search, brand, gaps, top]);
  const shops = useMemo(() => (m ? [...m.shops].sort((a, b) => a.code.localeCompare(b.code)) : []), [m]);
  const [limit, setLimit] = useState(MATRIX_PAGE);
  const shown = rows.slice(0, limit);

  if (q.isLoading) return <Loading />;
  if (q.isError || !m) return <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />;

  const brandLabel = (b: string) => (b === NO_BRAND ? t('shops.matrix.noBrand') : b);

  return (
    <div className="space-y-4" data-testid="shops-matrix-tab">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('shops.matrix.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('shops.matrix.asOf', { at: f.dayTime(m.at) })} · {t('shops.matrix.legend', { n: TOP_SELLERS_N })}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card/80 p-3 shadow-sm">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-56">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => { setLimit(MATRIX_PAGE); set('q', e.target.value); }}
            placeholder={t('shops.matrix.search')} aria-label={t('shops.matrix.search')} className="pl-9" />
        </div>
        <select
          className="min-h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm"
          value={brand ?? ''} aria-label={t('shops.matrix.brand')}
          onChange={(e) => { setLimit(MATRIX_PAGE); set('brand', e.target.value || null); }}
        >
          <option value="">{t('shops.matrix.allBrands')}</option>
          {brands.map((b) => <option key={b} value={b}>{brandLabel(b)}</option>)}
        </select>
        <Chip on={gaps} onClick={() => { setLimit(MATRIX_PAGE); set('gaps', !gaps); }}>
          <Flame className="h-3 w-3 shrink-0" aria-hidden />{t('shops.matrix.gapsOnly')}
        </Chip>
        <DmyDateInput label={t('shops.matrix.at')} value={atDay} max={addDays(today, -1)} min={addDays(today, -730)}
          onChange={(v) => set('at', v)} />
        {atDay && <Button variant="ghost" size="sm" className="h-9" onClick={() => set('at', null)}>{t('shops.matrix.now')}</Button>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t('shops.matrix.count', { shown: f.int(rows.length), total: f.int(m.articles.length) })}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<Boxes className="h-5 w-5" />} title={t('shops.matrix.empty')} size="sm" />
      ) : (
        <>
          <MatrixTable rows={shown} shops={shops} top={top} f={f} />
          <ul className="space-y-2 xl:hidden" data-testid="shops-matrix-cards">
            {shown.map((a) => <ArticleCard key={a.code} a={a} shops={shops} top={top.has(a.code)} f={f} />)}
          </ul>
          {rows.length > limit && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + MATRIX_PAGE)}>
                {t('shops.more', { n: f.int(Math.min(MATRIX_PAGE, rows.length - limit)) })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MatrixTable({ rows, shops, top, f }: { rows: MatrixArticle[]; shops: ShopRef[]; top: Set<string>; f: ShopsFormat }) {
  const { t } = f;
  const shopTotals = shops.map((s) => rows.reduce((a, r) => a + qtyIn(r, s.code), 0));
  return (
    <div className="hidden max-h-[75vh] overflow-auto rounded-xl border bg-card shadow-sm xl:block" data-testid="shops-matrix-table">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <caption className="sr-only">{t('shops.matrix.title')}</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="sticky left-0 top-0 z-30 min-w-[10rem] max-w-[13rem] border-b bg-muted px-2 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide">
              {t('shops.matrix.colArticle')}
            </th>
            <th scope="col" className="sticky top-0 z-20 border-b bg-muted px-1 py-2 text-right align-bottom text-[11px] font-medium">{t('shops.matrix.colTotal')}</th>
            <th scope="col" className="sticky top-0 z-20 border-b border-r bg-muted px-1 py-2 text-right align-bottom text-[11px] font-medium" title={t('shops.matrix.colSold30Hint')}>
              {t('shops.matrix.colSold30')}
            </th>
            {shops.map((s) => (
              <th key={s.code} scope="col" title={`${s.code} ${s.name} · ${s.city}`}
                className="sticky top-0 z-20 w-8 border-b bg-muted px-0.5 py-2 align-bottom font-medium">
                <span className="mx-auto block max-h-[7.5rem] whitespace-nowrap text-left text-[11px] leading-none [writing-mode:vertical-rl] rotate-180">
                  <span className="font-mono">{s.code}</span> {s.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const isTop = top.has(a.code);
            return (
              <tr key={a.code} className="group">
                <th scope="row" className="sticky left-0 z-10 min-w-[10rem] max-w-[13rem] border-b bg-card px-2 py-1.5 text-left font-normal group-hover:bg-muted">
                  <span className="block break-words font-medium leading-tight">{a.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    <span className="font-mono">{a.code}</span>{a.brand ? ` · ${a.brand}` : ''}
                    {isTop && <span className="ml-1 text-red-700 dark:text-red-400">· {t('shops.matrix.top')}</span>}
                  </span>
                </th>
                <td className="border-b px-1 py-1.5 text-right font-semibold tabular-nums group-hover:bg-muted/50">{f.int(a.total)}</td>
                <td className="border-b border-r px-1 py-1.5 text-right tabular-nums text-muted-foreground group-hover:bg-muted/50">{f.int(a.sold_30d_total)}</td>
                {shops.map((s) => {
                  const v = qtyIn(a, s.code);
                  const z = v <= 0;
                  return (
                    <td key={s.code} title={`${s.name}: ${f.int(v)}`}
                      className={cn('border-b px-0.5 py-1.5 text-center tabular-nums group-hover:bg-muted/50',
                        z && isTop && s.active ? zeroTop : z ? 'text-muted-foreground/60' : '')}>
                      {compactQty(v, f.lang)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th scope="row" className="sticky bottom-0 left-0 z-20 border-t bg-muted px-2 py-1.5 text-left text-[11px] uppercase tracking-wide text-muted-foreground">{t('shops.matrix.shopTotal')}</th>
            <td className="sticky bottom-0 z-10 border-t bg-muted px-1 py-1.5 text-right tabular-nums">{f.int(rows.reduce((x, r) => x + r.total, 0))}</td>
            <td className="sticky bottom-0 z-10 border-r border-t bg-muted px-1 py-1.5" />
            {shops.map((s, i) => (
              <td key={s.code} title={`${s.name}: ${f.int(shopTotals[i])}`} className="sticky bottom-0 z-10 border-t bg-muted px-0.5 py-1.5 text-center tabular-nums">
                {compactQty(shopTotals[i], f.lang)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ArticleCard({ a, shops, top, f }: { a: MatrixArticle; shops: ShopRef[]; top: boolean; f: ShopsFormat }) {
  const { t } = f;
  const zeros = top ? zeroShops(a, shops).length : 0;
  return (
    <li className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-sm', zeros > 0 && 'border-red-300 dark:border-red-900')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words font-medium">{a.name}</div>
          <div className="text-xs text-muted-foreground"><span className="font-mono">{a.code}</span>{a.brand ? ` · ${a.brand}` : ''}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-semibold tabular-nums">{f.int(a.total)}</div>
          <div className="text-[11px] text-muted-foreground">{t('shops.matrix.sold30', { n: f.int(a.sold_30d_total) })}</div>
        </div>
      </div>
      {top && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-semibold text-red-700 dark:text-red-400">{t('shops.matrix.top')}</span>
          {zeros > 0 && <span className="text-red-700 dark:text-red-400">{t('shops.matrix.zeroShops', { count: zeros })}</span>}
        </div>
      )}
      <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-1" aria-label={t('shops.matrix.byShop', { name: a.name })}>
        {shops.map((s) => {
          const v = qtyIn(a, s.code);
          const z = v <= 0;
          return (
            <li key={s.code} title={`${s.code} ${s.name}: ${f.int(v)}`}
              className={cn('flex min-w-0 items-center justify-between gap-1 rounded-md border px-1.5 py-1',
                z && top && s.active ? cn('border-red-200 dark:border-red-900', zeroTop) : 'bg-muted/30')}>
              <span className="min-w-0 break-words text-[10px] leading-tight text-muted-foreground">{s.name}</span>
              <span className={cn('shrink-0 text-xs font-semibold tabular-nums', z && !top && 'text-muted-foreground/60')}>{compactQty(v, f.lang)}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
