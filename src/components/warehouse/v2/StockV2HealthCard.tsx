import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, BookOpen, Calculator, CheckCircle2, ChevronDown, ChevronRight, Database, Loader2, PackageSearch, Power,
  ShieldAlert, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiStockV2Health, apiStockV2Run, apiStockV2Switch, type StockRunStats } from '@/lib/stockV2Api';
import type { StockHealth } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { moment } from './moves';
import { Failed, HEALTH_FULL_KEY, Loading, Pill, useNow, warehouseName } from './shared';
import { fmtQty } from './stockV2Model';

const NEG_ROWS = 8;

/**
 * Магацин → Попис: the stock v2 health card (owners and admins). The switch and when it last ran,
 * what waits to be written, the review queues (unmapped lines, parcels with no lines / no route,
 * stale labels, possible relabels, lines still coming), articles in minus, articles with no cost,
 * recipe coverage and Sigma's freshness. Owners flip the switch (with a confirm) and can run a dry
 * computation ("Пресметај сега"). No money.
 */
export function StockV2HealthCard({ f, isOwner }: { f: InsightsFormat; isOwner: boolean }) {
  const q = useQuery<StockHealth>({ queryKey: HEALTH_FULL_KEY, queryFn: () => apiStockV2Health(true), staleTime: 60_000, retry: 0 });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <Failed error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return null;
  return <HealthBody h={q.data} f={f} isOwner={isOwner} />;
}

function HealthBody({ h, f, isOwner }: { h: StockHealth; f: InsightsFormat; isOwner: boolean }) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const now = useNow();
  const [confirm, setConfirm] = useState<null | 'on' | 'off'>(null);
  const [busy, setBusy] = useState<null | 'switch' | 'run'>(null);
  const [run, setRun] = useState<StockRunStats | null>(null);
  const [showUnmapped, setShowUnmapped] = useState(false);
  const [showNeg, setShowNeg] = useState(false);
  const approvedOpening = h.openings.some((o) => o.status === 'approved');
  const failed = h.last_run && h.last_run.status !== 'ok';
  const unmappedUnits = h.queues.unmapped.reduce((a, r) => a + r.units, 0);
  const qn = (v: number) => fmtQty(v, f.lang);

  const doSwitch = async (enabled: boolean) => {
    setBusy('switch');
    try {
      await apiStockV2Switch(enabled);
      toast({ title: t(enabled ? 'stock2.health.switchedOn' : 'stock2.health.switchedOff') });
      await qc.invalidateQueries({ queryKey: ['stock2'] });
    } catch (e) {
      toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setBusy(null); setConfirm(null); }
  };
  const doRun = async () => {
    setBusy('run');
    try {
      setRun(await apiStockV2Run(true));
    } catch (e) {
      toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  return (
    <section aria-labelledby="stock2-health-title" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm" data-testid="stock2-health">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="stock2-health-title" className="text-sm font-semibold">{t('stock2.health.title')}</h2>
        {h.enabled ? (
          <Pill tone="emerald"><CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden />{t('stock2.health.on')}</Pill>
        ) : (
          <Pill tone="amber"><ShieldAlert className="mr-1 inline h-3 w-3" aria-hidden />{t('stock2.health.off')}</Pill>
        )}
        {isOwner && (
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => void doRun()} disabled={busy !== null}>
              {busy === 'run' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Calculator className="mr-1 h-3.5 w-3.5" aria-hidden />}
              {t('stock2.health.runNow')}
            </Button>
            <Button size="sm" variant={h.enabled ? 'outline' : 'default'} className="h-8" disabled={busy !== null || (!h.enabled && !approvedOpening)}
              title={!h.enabled && !approvedOpening ? t('stock2.health.needOpening') : undefined}
              onClick={() => setConfirm(h.enabled ? 'off' : 'on')}>
              {busy === 'switch' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Power className="mr-1 h-3.5 w-3.5" aria-hidden />}
              {t(h.enabled ? 'stock2.health.switchOff' : 'stock2.health.switchOn')}
            </Button>
          </div>
        )}
      </div>
      {isOwner && !h.enabled && !approvedOpening && <p className="text-xs text-amber-700 dark:text-amber-400">{t('stock2.health.needOpening')}</p>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Block icon={BookOpen} title={t('stock2.health.ledger')}>
          {h.openings.length === 0 ? <p className="font-medium text-amber-700 dark:text-amber-400">{t('stock2.health.noOpening')}</p>
            : h.openings.map((o) => (
              <p key={o.count_id}>
                <span className="font-medium">{warehouseName(f, o.warehouse)}</span>{' '}
                {t('stock2.health.openingAt', { at: moment(o.counted_at) })}{' '}
                <Pill tone={o.status === 'approved' ? 'emerald' : o.status === 'void' ? 'slate' : 'amber'}>{t(`stock2.countStatus.${o.status}`, { defaultValue: o.status })}</Pill>
              </p>
            ))}
          {h.last_run ? (
            <p className={cn(failed ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
              {t('stock2.health.lastRun', { ago: f.ago(h.last_run.at, now), status: t(`stock2.health.runStatus.${h.last_run.status}`, { defaultValue: h.last_run.status }), trigger: h.last_run.trigger })}
            </p>
          ) : <p className="text-muted-foreground">{t('stock2.health.neverRun')}</p>}
          <p className={cn(h.pending.groups > 0 && h.enabled ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
            {t('stock2.health.pending', { groups: f.int(h.pending.groups), units: qn(h.pending.units) })}
          </p>
        </Block>

        <Block icon={PackageSearch} title={t('stock2.health.review')}>
          <Line label={t('stock2.health.q.unmapped')} n={h.queues.unmapped.length} f={f} sub={h.queues.unmapped.length ? t('stock2.health.unitsN', { n: qn(unmappedUnits) }) : undefined} />
          <Line label={t('stock2.health.q.no_lines')} n={h.queues.no_lines} f={f} />
          <Line label={t('stock2.health.q.no_route')} n={h.queues.no_route} f={f} />
          <Line label={t('stock2.health.q.waiting_lines')} n={h.queues.waiting_lines} f={f} quiet />
          <Line label={t('stock2.health.q.stale_labels')} n={h.queues.stale_labels} f={f} />
          <Line label={t('stock2.health.q.possible_relabels')} n={h.queues.possible_relabels} f={f} />
          <Line label={t('stock2.health.q.test_phone')} n={h.queues.test_phone} f={f} quiet />
          {h.queues.unmapped.length > 0 && (
            <button type="button" className="flex items-start gap-1 text-left text-xs font-medium text-primary hover:underline" aria-expanded={showUnmapped} onClick={() => setShowUnmapped((v) => !v)}>
              {showUnmapped ? <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
              {t(showUnmapped ? 'stock2.health.hideUnmapped' : 'stock2.health.showUnmapped')}
            </button>
          )}
        </Block>

        <Block icon={AlertTriangle} title={t('stock2.health.negatives', { n: f.int(h.negatives.length) })}>
          {h.negatives.length === 0 ? <p className="text-muted-foreground">{t('stock2.health.noNegatives')}</p> : (
            <ul className="space-y-0.5">
              {(showNeg ? h.negatives : h.negatives.slice(0, NEG_ROWS)).map((n) => (
                <li key={`${n.warehouse}|${n.code}`} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words">{n.name} <span className="text-muted-foreground">{n.code}</span></span>
                  <span className="shrink-0 font-semibold tabular-nums text-red-700 dark:text-red-400">{qn(n.qty)}</span>
                </li>
              ))}
            </ul>
          )}
          {h.negatives.length > NEG_ROWS && (
            <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setShowNeg((v) => !v)}>
              {showNeg ? t('stock2.health.less') : t('stock2.health.more', { n: f.int(h.negatives.length - NEG_ROWS) })}
            </button>
          )}
        </Block>

        <Block icon={Database} title={t('stock2.health.data')}>
          <p>{t('stock2.health.recipes', { with: f.int(h.recipes.with_approved_recipe), of: f.int(h.recipes.products_active) })}</p>
          {h.recipes.proposed > 0 && <p className="text-muted-foreground">{t('stock2.health.recipesProposed', { n: f.int(h.recipes.proposed) })}</p>}
          <p className={cn(h.uncosted_articles > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{t('stock2.health.uncosted', { n: f.int(h.uncosted_articles) })}</p>
          <p className="text-muted-foreground">{t('stock2.health.sigmaBatch', { ago: f.ago(h.sigma.last_batch_at, now) })}</p>
          <p className="text-muted-foreground">{t('stock2.health.sigmaConnector', { ago: f.ago(h.sigma.connector_last_seen, now) })}</p>
          <p className="text-muted-foreground">{t('stock2.health.sigmaDocs', { staged: f.int(h.sigma.docs_staged), excluded: f.int(h.sigma.docs_excluded), redated: f.int(h.sigma.docs_versions_gt1) })}</p>
        </Block>
      </div>

      {showUnmapped && (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">{t('stock2.health.colName')}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t('stock2.health.colSource')}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('stock2.health.colParcels')}</th>
                <th scope="col" className="px-2 py-2 pr-3 text-right font-medium">{t('stock2.health.colUnits')}</th>
              </tr>
            </thead>
            <tbody>
              {h.queues.unmapped.map((r) => (
                <tr key={`${r.source}|${r.code}|${r.name}`} className="border-b last:border-0">
                  <td className="px-3 py-1.5"><span className="break-words">{r.name || '—'}</span>{r.code && <span className="ml-1 text-muted-foreground">{r.code}</span>}</td>
                  <td className="px-2 py-1.5 text-muted-foreground"><span className="break-words">{t(`stock2.lines.${r.source}`, { defaultValue: r.source })}</span></td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{f.int(r.parcels)}</td>
                  <td className="px-2 py-1.5 pr-3 text-right tabular-nums">{qn(r.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {run && (
        <div className="space-y-1 rounded-lg border bg-muted/20 p-3 text-xs" data-testid="stock2-run-result">
          <p className="font-semibold">{t('stock2.health.runResult')}</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(run).map(([k, v]) => (
              <div key={k} className="flex min-w-0 justify-between gap-2">
                <dt className="min-w-0 break-all text-muted-foreground">{k}</dt>
                <dd className="shrink-0 tabular-nums">{typeof v === 'number' ? fmtQty(v, f.lang) : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent className="w-[calc(100%-1rem)] max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirm === 'off' ? 'stock2.health.switchOffTitle' : 'stock2.health.switchOnTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'off' ? t('stock2.health.switchOffBody')
                : t('stock2.health.switchOnBody', { groups: f.int(h.pending.groups), units: qn(h.pending.units) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy !== null} onClick={(e) => { e.preventDefault(); void doSwitch(confirm !== 'off'); }}>
              {busy === 'switch' && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
              {t(confirm === 'off' ? 'stock2.health.switchOff' : 'stock2.health.switchOn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Block({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border bg-muted/20 p-3 text-xs">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </p>
      {children}
    </div>
  );
}

function Line({ label, n, f, sub, quiet }: { label: string; n: number; f: InsightsFormat; sub?: string; quiet?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-2">
      <span className="min-w-0 text-muted-foreground">{label}{sub ? <span className="ml-1">({sub})</span> : null}</span>
      <span className={cn('shrink-0 tabular-nums', n > 0 && !quiet ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-foreground')}>{f.int(n)}</span>
    </p>
  );
}
