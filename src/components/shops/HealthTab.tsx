import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRightLeft, CheckCircle2, CircleSlash, Clock, EqualNot, Flame, PackageX, Receipt, TrendingDown, Truck,
  XCircle, type LucideIcon,
} from 'lucide-react';
import type { ShopsAnomaly, ShopsHealth } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { TONE_TEXT } from '@/components/insights/overview/palette';
import { skopjeTodayYmd } from '@/lib/skopjeTime';
import { Loading, Section, ShopsLoadError, Stat } from './parts';
import { backfillShare, hasKey, numOrNull } from './shopsModel';
import { useShopsHealth } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

const ANOMALY: Record<ShopsAnomaly['kind'], { icon: LucideIcon; tone: string }> = {
  no_receipts_by_11: { icon: Receipt, tone: TONE_TEXT.warning },
  cost_above_sales: { icon: TrendingDown, tone: TONE_TEXT.critical },
  big_transfer: { icon: ArrowRightLeft, tone: TONE_TEXT.warning },
  big_return: { icon: PackageX, tone: TONE_TEXT.warning },
  zero_top_seller: { icon: Flame, tone: TONE_TEXT.critical },
  delivery_not_received: { icon: Truck, tone: TONE_TEXT.warning },
  control_mismatch: { icon: EqualNot, tone: TONE_TEXT.critical },
};

/**
 * Здравје (owners / admins): is the collabBox shops reader on and running, how far the receipt
 * backfill has come, how many daily controls matched, and the anomalies (kinds in shopsTypes).
 * The reader is switched on by the lead after review (app_settings.shops_reader) — off is said
 * plainly, never shown as an error.
 */
export function HealthTab({ f }: { f: ShopsFormat }) {
  const { t } = f;
  const q = useShopsHealth(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />;
  const h: ShopsHealth = q.data;
  const share = backfillShare(h.backfill.sales_from, h.backfill.sales_done_until, skopjeTodayYmd());
  const status = h.reader.last_status;
  const statusOk = !status || /^(ok|success|done)$/i.test(status);
  const anomalies = [...(h.anomalies ?? [])].sort((a, b) => b.day.localeCompare(a.day));
  const fresh = h.freshness;
  const feeds: { key: string; at: string | null | undefined }[] = [
    { key: 'sales', at: fresh?.last_sales_at }, { key: 'docs', at: fresh?.last_docs_at },
    { key: 'stock', at: fresh?.last_stock_snapshot_at }, { key: 'reader', at: fresh?.reader_last_run_at },
  ];

  return (
    <div className="space-y-6" data-testid="shops-health-tab">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card title={t('shops.health.reader')}>
          <div className="flex flex-wrap items-center gap-2">
            {h.reader.enabled ? (
              <span className={cn('inline-flex items-center gap-1 text-sm font-semibold', TONE_TEXT.good)}>
                <CheckCircle2 className="h-4 w-4" aria-hidden />{t('shops.health.enabled')}
              </span>
            ) : (
              <span className={cn('inline-flex items-center gap-1 text-sm font-semibold', TONE_TEXT.neutral)}>
                <CircleSlash className="h-4 w-4" aria-hidden />{t('shops.health.disabled')}
              </span>
            )}
          </div>
          {!h.reader.enabled && <p className="text-xs text-muted-foreground">{t('shops.health.offHint')}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat label={t('shops.health.lastRun')} value={f.ago(h.reader.last_run_at, now)} />
            <Stat label={t('shops.health.lastStatus')} value={(
              <span className={cn('inline-flex items-center gap-1', statusOk ? TONE_TEXT.good : TONE_TEXT.critical)}>
                {statusOk ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
                {status ? t(`shops.health.status.${status.toLowerCase()}`, { defaultValue: status }) : '—'}
              </span>
            )} />
            <Stat label={t('shops.health.runs24')} value={f.int(h.reader.runs_24h)} />
            <Stat label={t('shops.health.errors24')} value={(
              <span className={h.reader.errors_24h > 0 ? TONE_TEXT.critical : undefined}>{f.int(h.reader.errors_24h)}</span>
            )} />
          </dl>
        </Card>

        <Card title={t('shops.health.backfill')}>
          {share == null ? (
            <p className="text-sm text-muted-foreground">{t('shops.health.notStarted')}</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold tabular-nums">{t('shops.health.progress', { pct: f.pct(share, 0) })}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('shops.health.salesRange', { from: f.dm(h.backfill.sales_from!, true), until: f.dm(h.backfill.sales_done_until!, true) })}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={Math.round(share * 100)} aria-label={t('shops.health.backfill')}>
                <div className="h-full rounded-full bg-[var(--sh-bar)]" style={{ width: `${share * 100}%` }} />
              </div>
            </>
          )}
          <p className="text-xs text-muted-foreground">{t('shops.health.stockMonths', { count: h.backfill.stock_history_months, n: f.int(h.backfill.stock_history_months) })}</p>
        </Card>

        <Card title={t('shops.health.controls')}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat label={t('shops.health.daysChecked')} value={f.int(h.controls.days_checked)} />
            <Stat label={t('shops.health.mismatches')} value={(
              <span className={cn('inline-flex items-center gap-1', h.controls.mismatches > 0 ? TONE_TEXT.critical : TONE_TEXT.good)}>
                {h.controls.mismatches > 0 ? <EqualNot className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                {f.int(h.controls.mismatches)}
              </span>
            )} />
          </dl>
          <p className="text-xs text-muted-foreground">{t('shops.health.controlsHint')}</p>
        </Card>

        <Card title={t('shops.health.freshness')} className="md:col-span-2 xl:col-span-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
            {feeds.map((x) => (
              <Stat key={x.key} label={t(`shops.health.feed.${x.key}`)}
                value={<span title={x.at ? f.dayTime(x.at) : undefined}>{x.at ? `${f.ago(x.at, now)} · ${f.dayTime(x.at)}` : t('overview.ago.never')}</span>} />
            ))}
          </dl>
        </Card>
      </div>

      <Section id="shops-anomalies" title={t('shops.health.anomalies')} subtitle={t('shops.health.anomaliesSub')}>
        {anomalies.length === 0 ? (
          <p className={cn('flex items-center justify-center gap-2 rounded-xl border bg-card p-4 text-sm', TONE_TEXT.good)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />{t('shops.health.noAnomalies')}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="shops-anomalies">
            {anomalies.map((a, i) => {
              const k = ANOMALY[a.kind] ?? { icon: AlertTriangle, tone: TONE_TEXT.warning };
              const Icon = k.icon;
              const v = numOrNull(a.value_mkd);
              return (
                <li key={`${a.kind}-${a.day}-${a.shop?.code ?? 'all'}-${i}`} className="flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3 shadow-sm">
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', k.tone)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className={cn('text-sm font-semibold', k.tone)}>{t(`shops.anomaly.${a.kind}`, { defaultValue: a.kind })}</span>
                      <span className="text-xs text-muted-foreground">
                        {a.shop ? `${a.shop.code} ${a.shop.name}` : t('shops.health.allShops')} · {f.dm(a.day, true)}
                      </span>
                    </div>
                    {a.detail && <p className="break-words text-xs text-muted-foreground">{a.detail}</p>}
                  </div>
                  {hasKey(a, 'value_mkd') && v != null && (
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{v < 0 ? `−${f.den(Math.abs(v))}` : f.den(v)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Clock className="h-3 w-3" aria-hidden />{t('shops.health.schedule')}</p>
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
