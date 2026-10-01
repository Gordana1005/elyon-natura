import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { History, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Chip, LABEL } from '@/components/assigner/parts';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { addDays, isYmd, skopjeToday } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { apiStockV2Movements } from '@/lib/stockV2Api';
import type { StockMovementsPage } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { MoveBadges, MoveCard, kindLabel, moment, qtyTone, sourceLabel, sourceRef } from './moves';
import {
  Empty, Failed, Loading, Pager, WarehousePicker, patchParams, readPageOffset, useStockAccess, useStockHealthLite,
  useWarehouseOptions, warehouseName,
} from './shared';
import { ARTICLE_CODE_RE, MOVE_KINDS, MOVE_SOURCES, fmtQty, fmtSigned } from './stockV2Model';

const LIMIT = 100;
const QUICK = [1, 7, 30] as const;

/**
 * Магацин → Движења (stock v2): the ledger, one row per move — the day it happened (event) and,
 * when it was entered later, by how many days; a Sigma document that was re-dated; a correction of
 * an already applied group; a provisional move. One article + one warehouse → a running balance.
 * Period and filters live in the URL: from · to · wh · art (a code) or q (text) · kind · source ·
 * corr · page.
 */
export function MovementsV2Tab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const access = useStockAccess();
  const [sp, setSp] = useSearchParams();
  const today = skopjeToday();
  let from = isYmd(sp.get('from')) ? sp.get('from')! : today;
  let to = isYmd(sp.get('to')) ? sp.get('to')! : from;
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  const wh = sp.get('wh') || '';
  const art = sp.get('art');
  const text = sp.get('q');
  const kind = sp.get('kind');
  const source = sp.get('source');
  const corr = sp.get('corr') === '1';
  const offset = readPageOffset(sp.get('page'), LIMIT);
  const set = (patch: Record<string, string | null>) => setSp((p) => patchParams(p, patch), { replace: true });
  const setRange = (a: string, b: string) => set({ from: a === today && b === today ? null : a, to: a === b ? null : b });

  // one search box: a Sigma code filters the article exactly, anything else searches names
  const [search, setSearch] = useState(art ?? text ?? '');
  useEffect(() => { setSearch(art ?? text ?? ''); }, [art, text]);
  useEffect(() => {
    const s = search.trim();
    if (s === (art ?? text ?? '')) return;
    const id = window.setTimeout(() => {
      const code = s.toUpperCase();
      set(ARTICLE_CODE_RE.test(code) ? { art: code, q: null } : { art: null, q: s || null });
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const health = useStockHealthLite();
  const options = useWarehouseOptions(f, { isOwner: access.isOwner, health: health.data });
  const q = useQuery<StockMovementsPage>({
    queryKey: ['stock2', 'movements', from, to, wh, art, text, kind, source, corr, offset],
    queryFn: () => apiStockV2Movements({ from, to, warehouse: wh || null, article: art, q: text, kind, source, corrections: corr, limit: LIMIT, offset }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const balance = !!d && d.rows.some((r) => r.balance_after != null);
  const wide = useMinWidth(1024);
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

  return (
    <div className="space-y-4" data-testid="stock2-movements-tab">
      <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="flex flex-col gap-1">
            <span className={LABEL}>{t('stock2.common.period')}</span>
            <PeriodStepper range={{ from, to }} today={today} onStep={(n) => setRange(n.range.from, n.range.to)} testId="stock2-mv-period" />
          </div>
          <DmyDateInput value={from} onChange={(v) => { if (v) setRange(v, v > to ? v : to); }} label={t('stock2.common.from')} max={today} />
          <DmyDateInput value={to} onChange={(v) => { if (v) setRange(v < from ? v : from, v); }} label={t('stock2.common.to')} max={today} />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('stock2.common.quickPeriod')}>
            {QUICK.map((n) => (
              <Chip key={n} on={to === today && span === n} onClick={() => setRange(addDays(today, -(n - 1)), today)}>
                {n === 1 ? t('stock2.common.today') : t('stock2.common.lastDays', { n })}
              </Chip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="relative flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <span className={LABEL}>{t('stock2.moves.article')}</span>
            <span className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('stock2.moves.articlePlaceholder')} className="h-8 pl-9" />
            </span>
          </label>
          <WarehousePicker value={wh} onChange={(v) => set({ wh: v || null })} options={options} allowAll f={f} />
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>{t('stock2.moves.kind')}</span>
            <select className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm" value={kind ?? ''} onChange={(e) => set({ kind: e.target.value || null })}>
              <option value="">{t('stock2.common.all')}</option>
              {MOVE_KINDS.map((k) => <option key={k} value={k}>{kindLabel(f, k)}</option>)}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>{t('stock2.moves.source')}</span>
            <select className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm" value={source ?? ''} onChange={(e) => set({ source: e.target.value || null })}>
              <option value="">{t('stock2.common.all')}</option>
              {MOVE_SOURCES.map((s) => <option key={s} value={s}>{sourceLabel(f, s)}</option>)}
            </select>
          </label>
          <Chip on={corr} onClick={() => set({ corr: corr ? null : '1' })}>{t('stock2.moves.onlyCorrections')}</Chip>
        </div>
        {art && !wh && <p className="text-[11px] text-muted-foreground">{t('stock2.moves.balanceHint')}</p>}
      </section>

      {q.isLoading ? <Loading /> : q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : !d ? null : d.rows.length === 0 ? (
        <Empty icon={<History className="h-5 w-5" />} title={t('stock2.moves.empty')} description={t('stock2.moves.emptyDesc')} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('stock2.moves.total', { n: f.int(d.total) })}</p>
          {wide ? (
            <div className="rounded-xl border bg-card shadow-sm" data-testid="stock2-moves-table">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-[11px] leading-tight text-muted-foreground">
                    <th scope="col" className="w-[6.5rem] px-3 py-2 font-medium">{t('stock2.moves.colWhen')}</th>
                    <th scope="col" className="min-w-[11rem] px-1.5 py-2 font-medium">{t('stock2.moves.article')}</th>
                    <th scope="col" className="px-1.5 py-2 font-medium">{t('stock2.moves.kind')}</th>
                    <th scope="col" className="px-1.5 py-2 font-medium">{t('stock2.moves.colRef')}</th>
                    <th scope="col" className="px-1.5 py-2 text-right font-medium">{t('stock2.moves.colQty')}</th>
                    {balance && <th scope="col" className="px-1.5 py-2 text-right font-medium">{t('stock2.moves.colBalance')}</th>}
                    <th scope="col" className="min-w-[7.5rem] px-1.5 py-2 pr-3 font-medium">{t('stock2.moves.colFlags')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((m) => (
                    <tr key={m.id} className={cn('border-b align-top last:border-0', m.correction && 'bg-red-50/50 dark:bg-red-950/20')}>
                      <td className="px-3 py-1.5 tabular-nums">{moment(m.event_at)}</td>
                      <th scope="row" className="px-1.5 py-1.5 text-left font-normal">
                        <span className="block break-words font-medium">{m.article_name}</span>
                        <span className="text-[11px] text-muted-foreground">{m.article_code}{!wh ? ` · ${warehouseName(f, m.warehouse_code)}` : ''}</span>
                      </th>
                      <td className="px-1.5 py-1.5">{kindLabel(f, m.kind)}</td>
                      <td className="px-1.5 py-1.5 text-muted-foreground"><span className="break-words">{sourceRef(f, m)}</span></td>
                      <td className={cn('whitespace-nowrap px-1.5 py-1.5 text-right font-semibold tabular-nums', qtyTone(m.qty))}>{fmtSigned(m.qty, f.lang)}</td>
                      {balance && <td className="whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums">{m.balance_after != null ? fmtQty(m.balance_after, f.lang) : '—'}</td>}
                      <td className="px-1.5 py-1.5 pr-3"><MoveBadges m={m} f={f} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="space-y-2" data-testid="stock2-moves-cards">
              {d.rows.map((m) => <MoveCard key={m.id} m={m} f={f} showWarehouse={!wh} />)}
            </ul>
          )}
          <Pager offset={offset} limit={LIMIT} rows={d.rows.length} total={d.total} f={f}
            onOffset={(o) => setSp((p) => patchParams(p, { page: o > 0 ? String(o / LIMIT + 1) : null }), { replace: true })} />
        </>
      )}
    </div>
  );
}
