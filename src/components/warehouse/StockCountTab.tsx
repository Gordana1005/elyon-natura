import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ClipboardCheck, Eraser, Loader2, Search, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiGetProducts } from '@/lib/api';
import { apiGetStockHealth, apiPostStockCount, type StockCountResult } from '@/lib/stockApi';
import {
  clearDraft, fillEmptyWithSystem, formatUnits, loadDraft, parseCounted, saveDraft, summarizeCount,
  type CountDraft, type CountProduct,
} from '@/lib/stockCount';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { StockHealthCard } from './StockHealthCard';
import { stockErrorText } from './stockText';

/** How many changed lines the preview lists before "+N more". */
const PREVIEW_ROWS = 60;

/**
 * Warehouse → Попис (stock count). Per product the counted quantity; blank =
 * not counted (keeps its number). Preview asks the server for the difference
 * against the quantity at that moment; Save writes ONE count event (who / when)
 * that sets on-hand, logs a 'count' movement per difference and anchors the
 * MEX stock ledger. Owners / admins / the warehouse role (the server decides);
 * owners also see the value of the difference in денари.
 */
export default function StockCountTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { canSeeBusiness: showMoney } = usePermissions();

  const health = useQuery({ queryKey: ['stock-health'], queryFn: () => apiGetStockHealth(true), staleTime: 60_000, retry: 0 });
  const productsQ = useQuery<CountProduct[]>({
    queryKey: ['stock-count-products'],
    queryFn: () => apiGetProducts() as Promise<CountProduct[]>,
    staleTime: 30_000,
  });
  const products = useMemo(() => productsQ.data ?? [], [productsQ.data]);

  const [draft, setDraft] = useState<CountDraft>(() => loadDraft());
  useEffect(() => { saveDraft(draft); }, [draft]);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<StockCountResult | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'save'>(null);

  // Active products, plus an inactive one that still holds stock or has a typed count.
  const eligible = useMemo(() => products
    .filter((p) => showInactive || p.is_active !== false || Number(p.stock_quantity) !== 0 || String(draft[p.id] ?? '').trim() !== '')
    .sort((a, b) => a.name.localeCompare(b.name)), [products, showInactive, draft]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((p) => p.name.toLowerCase().includes(q) || String(p.sku ?? '').toLowerCase().includes(q));
  }, [eligible, search]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const summary = useMemo(() => summarizeCount(draft, eligible), [draft, eligible]);
  const activeTotal = useMemo(() => products.filter((p) => p.is_active !== false).length, [products]);

  const setOne = (id: string, v: string) => setDraft((d) => ({ ...d, [id]: v }));

  const runPreview = async () => {
    if (summary.invalid.length) return;
    if (!summary.lines.length) { toast({ title: t('stockCount.nothingToSave') }); return; }
    setBusy('preview');
    try {
      setPreview(await apiPostStockCount({ lines: summary.lines, dry: true }));
    } catch (err) {
      toast({ title: t('common.error'), description: stockErrorText(t, err), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save');
    try {
      const r = await apiPostStockCount({ lines: summary.lines, note: note.trim() || null, dry: false });
      toast({
        title: t('stockCount.saved'),
        description: t('stockCount.savedDesc', { products: formatUnits(r.products), changed: formatUnits(r.changed) })
          + (r.anchored ? ' ' + t('stockCount.savedAnchored') : ''),
      });
      clearDraft();
      setDraft({});
      setNote('');
      setPreview(null);
      qc.invalidateQueries({ queryKey: ['stock-health'] });
      qc.invalidateQueries({ queryKey: ['stock-count-products'] });
      qc.invalidateQueries({ queryKey: ['insights-stock'] });
    } catch (err) {
      toast({ title: t('common.error'), description: stockErrorText(t, err), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  // Owners: the value of the server's difference at cost (EUR → денари by formatMoney).
  const previewValueEur = useMemo(() => (preview?.lines ?? [])
    .reduce((s, l) => s + l.diff * Number(byId.get(l.product_id)?.cost_price || 0), 0), [preview, byId]);
  const changedLines = (preview?.lines ?? []).filter((l) => l.diff !== 0);

  return (
    <div className="space-y-4">
      {health.data ? <StockHealthCard health={health.data} />
        : health.isError ? (
          <p role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {stockErrorText(t, health.error)}
          </p>
        ) : (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        )}

      <div className="space-y-1 rounded-xl border bg-card p-4 text-sm shadow-sm">
        <h2 className="flex items-center gap-2 font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" aria-hidden /> {t('stockCount.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('stockCount.intro')}</p>
        {health.data && !health.data.mex.from && <p className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('stockCount.firstCountNote')}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input placeholder={t('stockCount.search')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label={t('stockCount.search')} />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={showInactive} onCheckedChange={(v) => setShowInactive(v === true)} /> {t('stockCount.showInactive')}
        </label>
        <Button variant="outline" size="sm" onClick={() => setDraft((d) => fillEmptyWithSystem(d, visible))} disabled={!visible.length}>
          <Wand2 className="mr-1 h-3.5 w-3.5" /> {t('stockCount.fillSystem')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { setDraft({}); clearDraft(); }} disabled={!summary.counted && !summary.invalid.length}>
          <Eraser className="mr-1 h-3.5 w-3.5" /> {t('stockCount.clear')}
        </Button>
      </div>

      {productsQ.isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : visible.length === 0 ? (
        <EmptyState title={t('wh.noProductsMatch')} description={t('wh.tryAdjusting')} size="sm" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 font-medium">{t('stockCount.colProduct')}</th>
                <th scope="col" className="px-4 py-2.5 font-medium">{t('stockCount.colSku')}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">{t('stockCount.colSystem')}</th>
                <th scope="col" className="px-4 py-2.5 font-medium">{t('stockCount.colCounted')}</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">{t('stockCount.colDiff')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => {
                const v = parseCounted(draft[p.id]);
                const diff = typeof v === 'number' ? v - Number(p.stock_quantity || 0) : null;
                return (
                  <tr key={p.id} className={cn('border-b last:border-0', v === 'invalid' && 'bg-destructive/5', p.is_active === false && 'opacity-70')}>
                    <td className="px-4 py-2">{p.name}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{p.sku || '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatUnits(p.stock_quantity)}</td>
                    <td className="px-4 py-1.5">
                      <Input
                        inputMode="numeric"
                        value={draft[p.id] ?? ''}
                        onChange={(e) => setOne(p.id, e.target.value)}
                        placeholder={t('stockCount.notCounted')}
                        aria-label={t('stockCount.countedFor', { name: p.name })}
                        aria-invalid={v === 'invalid'}
                        className={cn('h-8 w-28 tabular-nums', v === 'invalid' && 'border-destructive')}
                      />
                    </td>
                    <td className={cn('px-4 py-2 text-right font-medium tabular-nums',
                      diff == null || diff === 0 ? 'text-muted-foreground' : diff > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                      {diff == null ? '—' : diff > 0 ? `+${formatUnits(diff)}` : formatUnits(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
        <span className="text-sm">
          {t('stockCount.summary', {
            counted: formatUnits(summary.counted), total: formatUnits(activeTotal), changed: formatUnits(summary.changed),
            up: formatUnits(summary.up), down: formatUnits(summary.down),
          })}
        </span>
        {showMoney && summary.changed > 0 && (
          <span className="text-xs text-muted-foreground">{t('stockCount.valueEstimate', { value: formatMoney(summary.diffCostEur) })}</span>
        )}
        {summary.invalid.length > 0 && (
          <span role="alert" className="text-xs font-medium text-destructive">{t('stockCount.invalid', { count: summary.invalid.length })}</span>
        )}
        <Button className="ml-auto" size="sm" onClick={() => void runPreview()} disabled={busy !== null || summary.invalid.length > 0 || !summary.counted}>
          {busy === 'preview' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {t('stockCount.preview')}
        </Button>
      </div>

      <Dialog open={preview !== null} onOpenChange={(o) => { if (!o && busy === null) setPreview(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('stockCount.previewTitle')}</DialogTitle>
            <DialogDescription>{t('stockCount.previewBody')}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <p>{t('stockCount.previewProducts', { products: formatUnits(preview.products), changed: formatUnits(preview.changed) })}</p>
              <p>{t('stockCount.previewUnits', {
                before: formatUnits(preview.units_before), after: formatUnits(preview.units_after),
                up: formatUnits(preview.up), down: formatUnits(preview.down),
              })}</p>
              {showMoney && <p className="font-medium">{t('stockCount.previewValue', { value: formatMoney(previewValueEur) })}</p>}
              {preview.not_counted > 0 && <p className="text-muted-foreground">{t('stockCount.previewNotCounted', { n: formatUnits(preview.not_counted) })}</p>}
              {preview.anchors && <p className="font-medium text-amber-700 dark:text-amber-300">{t('stockCount.previewAnchors')}</p>}
              {changedLines.length > 0 ? (
                <div className="max-h-64 overflow-y-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr className="text-left text-muted-foreground">
                        <th scope="col" className="px-3 py-1.5 font-medium">{t('stockCount.colProduct')}</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">{t('stockCount.colSystem')}</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">{t('stockCount.colCounted')}</th>
                        <th scope="col" className="px-3 py-1.5 text-right font-medium">{t('stockCount.colDiff')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changedLines.slice(0, PREVIEW_ROWS).map((l) => (
                        <tr key={l.product_id} className="border-t">
                          <td className="px-3 py-1">{l.name}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{formatUnits(l.system)}</td>
                          <td className="px-3 py-1 text-right tabular-nums">{formatUnits(l.counted)}</td>
                          <td className={cn('px-3 py-1 text-right font-medium tabular-nums', l.diff > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                            {l.diff > 0 ? `+${formatUnits(l.diff)}` : formatUnits(l.diff)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {changedLines.length > PREVIEW_ROWS && (
                    <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">{t('stockCount.previewMore', { n: formatUnits(changedLines.length - PREVIEW_ROWS) })}</p>
                  )}
                </div>
              ) : <p className="text-muted-foreground">{t('stockCount.noChanges')}</p>}
              <div className="space-y-1">
                <label htmlFor="stock-count-note" className="text-xs text-muted-foreground">{t('stockCount.noteLabel')}</label>
                <Textarea id="stock-count-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)} disabled={busy !== null}>{t('common.cancel')}</Button>
            <Button onClick={() => void save()} disabled={busy !== null}>
              {busy === 'save' && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {busy === 'save' ? t('stockCount.saving') : t('stockCount.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
