import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Truck } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Chip } from '@/components/assigner/parts';
import { TONE_TEXT } from '@/components/insights/overview/palette';
import { periodText } from '@/components/insights/shared/period';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { isShopCode } from '@/lib/shopsApi';
import type { ShopRef, ShopsDeliveryRow } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { Loading, Section, ShopsLoadError, Tile } from './parts';
import { hasKey, numOrNull, withParam } from './shopsModel';
import { useShopsDeliveries, useShopsSummary } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

/**
 * Испорачано од Натура: every Sigma invoice of Natura DOO to a shop in the period, matched to its
 * collabBox 10042 receipt in 001 Централен by Natura's invoice number — received (with the lag in
 * days) or still in transit. The shop filter and "only in transit" live in the URL (shop / transit).
 */
export function DeliveriesTab({ period, f }: { period: InsightsPeriod; f: ShopsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const rawShop = sp.get('shop');
  const shop = isShopCode(rawShop) ? rawShop : null;
  const transitOnly = sp.get('transit') === '1';
  const q = useShopsDeliveries(period.range, shop);
  const summary = useShopsSummary(period.range, period.today);
  const shops: ShopRef[] = useMemo(() => {
    const map = new Map<string, ShopRef>();
    for (const r of summary.data?.shops ?? []) map.set(r.shop.code, r.shop);
    for (const r of q.data?.rows ?? []) if (!map.has(r.shop.code)) map.set(r.shop.code, r.shop);
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [summary.data, q.data]);
  const rows = useMemo(() => {
    const all = (q.data?.rows ?? []).filter((r) => !transitOnly || r.in_transit);
    // in transit first, then the newest invoice
    return [...all].sort((a, b) => Number(b.in_transit) - Number(a.in_transit) || b.day.localeCompare(a.day) || a.shop.code.localeCompare(b.shop.code));
  }, [q.data, transitOnly]);
  const set = (k: string, v: string | boolean | null) => setSp(withParam(sp, k, v), { replace: true });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />;
  const d = q.data;
  const money = hasKey(d.totals, 'value_ex_vat_mkd') || d.rows.some((r) => hasKey(r, 'value_ex_vat_mkd'));

  return (
    <div className="space-y-5" data-testid="shops-deliveries-tab">
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label={t('shops.deliveries.title')}>
        <Tile label={t('shops.deliveries.invoices')} value={f.int(d.totals.invoices)} />
        <Tile label={t('shops.deliveries.units')} value={f.int(d.totals.units)} />
        <Tile label={t('shops.deliveries.inTransit')} value={f.int(d.totals.in_transit)} alert={d.totals.in_transit > 0}
          sub={d.totals.in_transit > 0 ? t('shops.deliveries.inTransitSub') : undefined} />
        {money && <Tile label={t('shops.deliveries.value')} value={numOrNull(d.totals.value_ex_vat_mkd) != null ? f.den(d.totals.value_ex_vat_mkd) : '—'} />}
      </ul>

      <Section
        id="shops-deliveries" title={t('shops.deliveries.title')}
        subtitle={t('shops.deliveries.subtitle', { period: periodText(period.range) })}
        actions={(
          <>
            <select
              className="min-h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm"
              value={shop ?? ''} aria-label={t('shops.deliveries.shop')}
              onChange={(e) => set('shop', e.target.value || null)}
            >
              <option value="">{t('shops.deliveries.allShops')}</option>
              {shops.map((s) => <option key={s.code} value={s.code}>{`${s.code} ${s.name}`}</option>)}
            </select>
            <Chip on={transitOnly} onClick={() => set('transit', !transitOnly)}>{t('shops.deliveries.onlyTransit')}</Chip>
          </>
        )}
      >
        {rows.length === 0 ? (
          <EmptyState icon={<Truck className="h-5 w-5" />} title={t('shops.deliveries.empty')} size="sm" />
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm lg:block">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('shops.deliveries.title')}</caption>
                <thead>
                  <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">{t('shops.deliveries.colDay')}</th>
                    <th scope="col" className="px-2 py-2 font-medium">{t('shops.deliveries.colShop')}</th>
                    <th scope="col" className="px-2 py-2 font-medium">{t('shops.deliveries.colSigma')}</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.deliveries.units')}</th>
                    {money && <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.deliveries.value')}</th>}
                    <th scope="col" className="px-2 py-2 font-medium">{t('shops.deliveries.colState')}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t('shops.deliveries.colLag')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.sigma_doc}-${r.shop.code}`} className={cn('border-b last:border-0', r.in_transit && 'bg-amber-50/60 dark:bg-amber-950/20')}>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{f.dm(r.day, true)}</td>
                      <td className="px-2 py-2"><span className="mr-1.5 font-mono text-xs text-muted-foreground">{r.shop.code}</span>{r.shop.name}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{r.sigma_doc}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{f.int(r.units)}</td>
                      {money && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{numOrNull(r.value_ex_vat_mkd) != null ? f.den(r.value_ex_vat_mkd) : '—'}</td>}
                      <td className="px-2 py-2"><StateBadge r={r} f={f} /></td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground">{lag(r, f)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="grid gap-2 md:grid-cols-2 lg:hidden">
              {rows.map((r) => (
                <li key={`${r.sigma_doc}-${r.shop.code}`} className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-sm', r.in_transit && 'border-amber-300 dark:border-amber-900')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium"><span className="mr-1.5 font-mono text-xs text-muted-foreground">{r.shop.code}</span>{r.shop.name}</div>
                      <div className="text-xs text-muted-foreground"><span className="tabular-nums">{f.dm(r.day, true)}</span> · <span className="font-mono">{r.sigma_doc}</span></div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-base font-semibold tabular-nums">{t('shops.detail.unitsN', { n: f.int(r.units) })}</div>
                      {money && <div className="text-xs tabular-nums text-muted-foreground">{numOrNull(r.value_ex_vat_mkd) != null ? f.den(r.value_ex_vat_mkd) : '—'}</div>}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <StateBadge r={r} f={f} />
                    {!r.in_transit && <span className="tabular-nums text-muted-foreground">{lag(r, f)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </div>
  );
}

const lag = (r: ShopsDeliveryRow, f: ShopsFormat) =>
  r.lag_days == null ? '—' : f.t('shops.deliveries.lagDays', { count: r.lag_days, n: f.int(r.lag_days) });

function StateBadge({ r, f }: { r: ShopsDeliveryRow; f: ShopsFormat }) {
  const { t } = f;
  if (r.in_transit) {
    return (
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold', TONE_TEXT.warning)}>
        <Truck className="h-3.5 w-3.5 shrink-0" aria-hidden />{t('shops.deliveries.transit')}
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
      <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', TONE_TEXT.good)} aria-hidden />
      <span className={cn('font-medium', TONE_TEXT.good)}>{t('shops.deliveries.received')}</span>
      {(r.received_doc || r.received_at) && (
        <span className="break-all text-muted-foreground">
          {t('shops.deliveries.receivedAs', { doc: r.received_doc ?? '—', at: r.received_at ? f.dayTime(r.received_at) : '—' })}
        </span>
      )}
    </span>
  );
}
