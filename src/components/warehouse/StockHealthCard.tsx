import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ClipboardCheck, Loader2, PackageSearch, Power, ShieldAlert,
  Truck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { apiSetStockMexMovements, type StockHealth } from '@/lib/stockApi';
import { formatUnits } from '@/lib/stockCount';
import { formatDayDmy } from '@/i18n/dates';
import { stockErrorText, stockMoment } from './stockText';

/**
 * Warehouse → Попис: the stock health card. The last count, the MEX switch
 * (owners flip it), what the MEX stock ledger applied since the count, what
 * switching on would apply now, and what waits for review (lines with no
 * catalogue product, parcels with nothing to deduct). No money.
 */
export function StockHealthCard({ health }: { health: StockHealth }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<null | 'on' | 'off'>(null);
  const [switching, setSwitching] = useState(false);
  const [showNames, setShowNames] = useState(false);

  const h = health;
  const counted = h.counted;
  const mex = h.mex;
  const failed = h.last_run?.status === 'failed';

  const doSwitch = async (enabled: boolean) => {
    setSwitching(true);
    try {
      await apiSetStockMexMovements({ enabled });
      toast({ title: t(enabled ? 'stockCount.health.switchedOn' : 'stockCount.health.switchedOff') });
      await qc.invalidateQueries({ queryKey: ['stock-health'] });
      qc.invalidateQueries({ queryKey: ['stock-count-products'] });
    } catch (err) {
      toast({ title: t('common.error'), description: stockErrorText(t, err), variant: 'destructive' });
    } finally {
      setSwitching(false);
      setConfirm(null);
    }
  };

  return (
    <section aria-labelledby="stock-health-title" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="stock-health-title" className="text-sm font-semibold">{t('stockCount.health.title')}</h2>
        {h.trusted ? (
          <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3 w-3" aria-hidden /> {t('stockCount.health.trusted')}
          </Badge>
        ) : (
          <Badge className="gap-1 border-amber-500/30 bg-amber-500/15 text-amber-800 dark:text-amber-200">
            <ShieldAlert className="h-3 w-3" aria-hidden /> {t('stockCount.health.notTrusted')}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {/* 1. the last count */}
        <Block icon={ClipboardCheck} title={t('stockCount.health.lastCount')}>
          {counted ? (
            <>
              <p className="font-medium">{stockMoment(counted.at)}</p>
              <p className="text-muted-foreground">
                {t('stockCount.health.lastCountValue', { by: counted.by || '—', products: formatUnits(counted.products), changed: formatUnits(counted.changed) })}
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">{t('stockCount.health.never')}</p>
              <p className="text-muted-foreground">{t('stockCount.health.neverDesc')}</p>
            </>
          )}
          <p className="text-muted-foreground">
            {t('stockCount.health.catalogue', { counted: formatUnits(h.catalogue.counted), active: formatUnits(h.catalogue.active) })}
          </p>
        </Block>

        {/* 2. the MEX switch */}
        <Block icon={Truck} title={t('stockCount.health.mex')}>
          <p className={cn('font-medium', mex.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>
            {mex.enabled
              ? t('stockCount.health.mexOn', { date: stockMoment(mex.enabled_at) })
              : mex.from ? t('stockCount.health.mexOff') : t('stockCount.health.mexOffNoCount')}
          </p>
          {mex.from && <p className="text-muted-foreground">{t('stockCount.health.mexFrom', { date: stockMoment(mex.from) })}</p>}
          <p className="text-muted-foreground">
            {t('stockCount.health.freeUnits', { mode: t(`stockCount.health.freeMode.${mex.free_units === 'skip' ? 'skip' : 'deduct'}`) })}
          </p>
          {h.last_run && (
            <p className={cn(failed ? 'text-destructive' : 'text-muted-foreground')}>
              {failed
                ? t('stockCount.health.runFailed', { date: stockMoment(h.last_run.at), error: h.last_run.error || '—' })
                : t('stockCount.health.lastRun', { date: stockMoment(h.last_ok_run ?? h.last_run.at) })}
            </p>
          )}
          {h.can_switch ? (
            <Button
              size="sm"
              variant={mex.enabled ? 'outline' : 'default'}
              className="mt-1 h-7 text-xs"
              disabled={switching || (!mex.enabled && !mex.from)}
              onClick={() => setConfirm(mex.enabled ? 'off' : 'on')}
            >
              {switching ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Power className="mr-1 h-3 w-3" />}
              {t(mex.enabled ? 'stockCount.health.switchOff' : 'stockCount.health.switchOn')}
            </Button>
          ) : (
            !mex.enabled && <p className="text-xs text-muted-foreground">{t('stockCount.health.ownerOnly')}</p>
          )}
        </Block>

        {/* 3. applied since the count / waiting */}
        <Block icon={PackageSearch} title={mex.enabled ? t('stockCount.health.applied') : t('stockCount.health.pending')}>
          {mex.enabled && h.applied ? (
            <p>
              {t('stockCount.health.appliedValue', {
                parcels: formatUnits(h.applied.parcels_deducted), out: formatUnits(h.applied.units_out),
                in: formatUnits(h.applied.units_in), rev: formatUnits(h.applied.units_reversed),
              })}
            </p>
          ) : null}
          {h.pending && (h.pending.parcels > 0 || !mex.enabled) ? (
            <p className={cn(mex.enabled && 'text-muted-foreground')}>
              {t(mex.enabled ? 'stockCount.health.pendingNext' : 'stockCount.health.pendingValue', {
                parcels: formatUnits(h.pending.parcels), out: formatUnits(h.pending.units_out), in: formatUnits(h.pending.units_in),
              })}
            </p>
          ) : null}
          {!h.pending && !h.applied && <p className="text-muted-foreground">{t('stockCount.health.nothingYet')}</p>}
        </Block>

        {/* 4. review */}
        <Block icon={AlertTriangle} title={t('stockCount.health.review')}>
          {h.review ? (
            <>
              <p>
                {t('stockCount.health.unmappedValue', {
                  lines: formatUnits(h.review.unmapped.lines), units: formatUnits(h.review.unmapped.units), names: formatUnits(h.review.unmapped.names),
                })}
              </p>
              <p className="text-muted-foreground">
                {t('stockCount.health.skippedValue', {
                  noOwner: formatUnits(h.review.skipped.no_owner), unmapped: formatUnits(h.review.skipped.unmapped),
                  noLines: formatUnits(h.review.skipped.no_lines), parcels: formatUnits(h.review.deduct_events),
                })}
              </p>
              {h.review.unmapped.rows.length > 0 && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  aria-expanded={showNames}
                  onClick={() => setShowNames((v) => !v)}
                >
                  {showNames ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {t(showNames ? 'stockCount.health.hideNames' : 'stockCount.health.showNames')}
                </button>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">{t('stockCount.health.reviewAfterCount')}</p>
          )}
        </Block>
      </div>

      {showNames && h.review && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">{t('stockCount.health.colName')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stockCount.health.colSource')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stockCount.health.colWhy')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stockCount.health.colLines')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stockCount.health.colUnits')}</th>
              </tr>
            </thead>
            <tbody>
              {h.review.unmapped.rows.map((r) => (
                <tr key={`${r.src}|${r.name}|${r.why}`} className="border-b last:border-0">
                  <td className="px-3 py-1.5">{r.name || '—'}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{t(`stockCount.health.src.${r.src === 'web' || r.src === 'collabbox' ? r.src : 'crm'}`)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{t(`stockCount.health.why.${r.why === 'bad_quantity' ? 'bad_quantity' : 'product'}`)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatUnits(r.lines)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatUnits(r.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-xs text-muted-foreground">{t('stockCount.health.namesHint')}</p>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(confirm === 'off' ? 'stockCount.health.switchOffTitle' : 'stockCount.health.switchOnTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'off'
                ? t('stockCount.health.switchOffBody')
                : t('stockCount.health.switchOnBody', {
                    date: formatDayDmy(mex.from), parcels: formatUnits(h.pending?.parcels ?? 0),
                    out: formatUnits(h.pending?.units_out ?? 0), in: formatUnits(h.pending?.units_in ?? 0),
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={switching}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={switching}
              onClick={(e) => { e.preventDefault(); void doSwitch(confirm !== 'off'); }}
            >
              {switching && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t(confirm === 'off' ? 'stockCount.health.switchOff' : 'stockCount.health.switchOn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Block({ icon: Icon, title, children }: { icon: typeof Truck; title: string; children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg border bg-muted/20 p-3 text-xs">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </p>
      {children}
    </div>
  );
}
