import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Grid3X3, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { BRAND_LINES, LINE_NAMES, type BrandLine } from '@/lib/products/brandLines';
import type { ScriptsLibrary } from '@/lib/callScriptsTypes';
import {
  CELL_GLYPH, CELL_STATES, GRID_SORTS, gridLineCounts, gridRows, twinsOf, type GridOptions, type GridSort,
} from '../scriptsModel';
import { chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';
import { useScriptsCoverage } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { AttachDialog } from '../library/AttachDialog';
import { CoverageKpis } from './CoverageKpis';
import { CoverageGrid } from './CoverageGrid';
import { CoverageCards } from './CoverageCards';
import { CoverageCellPopover, type ActiveCell } from './CoverageCellPopover';
import { ALERT_TONE, CELL_TONES, DRAFT_OUTLINE } from './cellStyle';

type LineKey = BrandLine | 'none';
const LINE_KEYS: LineKey[] = [...BRAND_LINES, 'none'];

/** The toolbar lives in the URL (cq · cl · cs · ca · cm · ce) like every Insights filter. */
function readOpts(sp: URLSearchParams): GridOptions & { assigned: boolean; merge: boolean } {
  const lines = (sp.get('cl') ?? '').split(',').filter((x): x is LineKey => (LINE_KEYS as string[]).includes(x));
  const sort = sp.get('cs');
  return {
    q: sp.get('cq') ?? '',
    lines,
    sort: (GRID_SORTS as readonly string[]).includes(sort ?? '') ? sort as GridSort : 'waiting',
    showEmpty: sp.get('ce') === '1',
    assigned: sp.get('ca') === '1',
    merge: sp.get('cm') !== '0',
  };
}

/**
 * Покриеност — which script every waiting client would get, product × group: the KPIs, the grid
 * (cards on a phone), and per cell the way to fill it. Writers only (the api answers 403 to agents).
 */
export function CoverageTab({ library, canWrite }: { library: ScriptsLibrary | undefined; canWrite: boolean }) {
  const L = useScriptLabels();
  const { t } = L;
  const [sp, setSp] = useSearchParams();
  const wide = useMinWidth(768);
  const o = useMemo(() => readOpts(sp), [sp]);
  const q = useScriptsCoverage({ families: o.merge, assignedOnly: o.assigned });
  const set = useCallback((patch: Record<string, string | null>) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') n.delete(k); else n.set(k, v); }
    return n;
  }, { replace: true }), [setSp]);
  const [active, setActive] = useState<ActiveCell | null>(null);
  const [attach, setAttach] = useState<ActiveCell | null>(null);
  const close = useCallback(() => setActive(null), []);

  const rows = useMemo(() => (q.data ? gridRows(q.data.rows, o) : []), [q.data, o]);
  const lineCounts = useMemo(() => (q.data ? gridLineCounts(q.data.rows, o) : null), [q.data, o]);
  const products = library?.products ?? [];
  const twins = useMemo(() => twinsOf(products), [products]);
  const productName = useCallback((id: string) => products.find((p) => p.id === id)?.name, [products]);
  const toggleLine = (k: LineKey) => {
    const on = new Set(o.lines);
    if (on.has(k)) on.delete(k); else on.add(k);
    set({ cl: LINE_KEYS.filter((x) => on.has(x)).join(',') || null });
  };

  return (
    <section className="space-y-3" aria-labelledby="cs-coverage-title" data-testid="cs-coverage">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="cs-coverage-title" className="text-base font-semibold">{t('callScripts.coverage.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('callScripts.coverage.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" className="h-9" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn('mr-1.5 h-4 w-4', q.isFetching && 'animate-spin')} aria-hidden />{t('callScripts.coverage.refresh')}
        </Button>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label={t('common.loading')} /></div>
      ) : q.error || !q.data ? (
        <EmptyState icon={<Grid3X3 className="h-5 w-5" />} title={t('callScripts.errors.loadCoverage')} description={q.error ? scriptsErrorText(q.error, t) : undefined} />
      ) : (
        <>
          <CoverageKpis totals={q.data.totals} />

          <div role="search" aria-label={t('callScripts.coverage.search')} className="space-y-2.5 rounded-xl border bg-card/80 p-3 shadow-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 lg:max-w-md">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input type="search" value={o.q} onChange={(e) => set({ cq: e.target.value })} placeholder={t('callScripts.coverage.search')}
                  aria-label={t('callScripts.coverage.search')} autoComplete="off" spellCheck={false}
                  className={cn('h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden', o.q ? 'pr-9' : 'pr-3')} />
                {o.q && (
                  <button type="button" onClick={() => set({ cq: null })} aria-label={t('common.clear')}
                    className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="coverage-shown">
                {t('callScripts.coverage.shown', { shown: L.int(rows.length), total: L.int(q.data.rows.length) })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span id="cov-lines" className={cn(groupLabelCls, 'basis-full sm:basis-auto')}>{t('callScripts.coverage.lines')}</span>
              <div role="group" aria-labelledby="cov-lines" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {LINE_KEYS.map((k) => (
                  <button key={k} type="button" aria-pressed={o.lines.includes(k)} onClick={() => toggleLine(k)}
                    className={cn(chip, o.lines.includes(k) ? chipOn : chipOff)}>
                    {k === 'none' ? t('products.line.none') : LINE_NAMES[k]}
                    {lineCounts && <span className="tabular-nums opacity-70">{L.int(lineCounts[k])}</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              <div role="group" aria-label={t('callScripts.coverage.sort')} className="flex flex-wrap items-center gap-1.5">
                <span className={groupLabelCls}>{t('callScripts.coverage.sort')}</span>
                {GRID_SORTS.map((s) => (
                  <button key={s} type="button" aria-pressed={o.sort === s} onClick={() => set({ cs: s === 'waiting' ? null : s })}
                    className={cn(chip, o.sort === s ? chipOn : chipOff)}>{t(`callScripts.coverage.sortBy.${s}`)}</button>
                ))}
              </div>
              <label className="flex min-h-9 items-center gap-2"><Switch checked={o.assigned} onCheckedChange={(v) => set({ ca: v ? '1' : null })} />{t('callScripts.coverage.assignedOnly')}</label>
              <label className="flex min-h-9 items-center gap-2"><Switch checked={o.merge} onCheckedChange={(v) => set({ cm: v ? null : '0' })} />{t('callScripts.coverage.mergeTwins')}</label>
              <label className="flex min-h-9 items-center gap-2"><Switch checked={o.showEmpty} onCheckedChange={(v) => set({ ce: v ? '1' : null })} />{t('callScripts.coverage.showEmpty')}</label>
            </div>
          </div>

          <Legend />

          {wide
            ? <CoverageGrid coverage={q.data} rows={rows} onCell={setActive} active={active} />
            : <CoverageCards coverage={q.data} rows={rows} onCell={setActive} />}
          {rows.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{t('callScripts.coverage.noRows')}</p>}
          <p className="text-[11px] text-muted-foreground">{t('callScripts.coverage.generated', { at: L.date(q.data.generated_at) })}</p>

          <CoverageCellPopover active={active} onClose={close} library={library?.scripts ?? []} canWrite={canWrite}
            onAttach={(a) => { setActive(null); setAttach(a); }} />
          {canWrite && (
            <AttachDialog open={!!attach} onOpenChange={(v) => { if (!v) setAttach(null); }} library={library?.scripts ?? []}
              products={products} twins={twins} productName={productName} coverage={q.data}
              presetGroups={attach ? [attach.group] : []} presetProducts={attach?.row?.product_ids ?? []} />
          )}
        </>
      )}
    </section>
  );
}

function Legend() {
  const L = useScriptLabels();
  const { t } = L;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" aria-label={t('callScripts.coverage.legend')} data-testid="coverage-legend">
      {CELL_STATES.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={cn('flex h-5 w-6 items-center justify-center rounded border text-[11px] font-bold', s === 'none' ? 'border-border' : CELL_TONES[s])} aria-hidden>{CELL_GLYPH[s]}</span>
          {t(`callScripts.coverage.state.${s}`)}
        </li>
      ))}
      <li className="flex items-center gap-1.5"><span className={cn('h-5 w-6 rounded border', ALERT_TONE)} aria-hidden />{t('callScripts.coverage.legendAlert')}</li>
      <li className="flex items-center gap-1.5"><span className={cn('h-5 w-6 rounded border bg-card', DRAFT_OUTLINE)} aria-hidden />{t('callScripts.coverage.legendDraft')}</li>
      <li className="flex items-center gap-1.5"><span className="font-semibold" aria-hidden>×2</span>{t('callScripts.coverage.legendOverlap')}</li>
    </ul>
  );
}
