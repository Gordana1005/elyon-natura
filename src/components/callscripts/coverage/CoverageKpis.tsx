import { CheckCircle2, FileEdit, Grid3X3, Send } from 'lucide-react';
import { KpiCard } from '@/components/insights/KpiCard';
import type { CoverageResponse } from '@/lib/callScriptsTypes';
import { useScriptLabels } from '../parts';

/** Покриеност at a glance: the share of waiting clients a published script reaches, the empty cells, published, drafts. */
export function CoverageKpis({ totals }: { totals: CoverageResponse['totals'] }) {
  const L = useScriptLabels();
  const { t } = L;
  const pct = new Intl.NumberFormat('mk-MK', { maximumFractionDigits: 1 }).format(totals.covered_pct);
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4" data-testid="coverage-kpis">
      <KpiCard icon={CheckCircle2} tone="bg-emerald-100 text-emerald-700" label={t('callScripts.coverage.kpiCovered')}
        value={`${pct} %`} sub={t('callScripts.coverage.kpiCoveredSub', { covered: L.int(totals.covered), waiting: L.int(totals.waiting) })} />
      <KpiCard icon={Grid3X3} tone={totals.empty_cells_with_waiting > 0 ? 'bg-red-100 text-red-700' : 'bg-zinc-100 text-zinc-700'}
        label={t('callScripts.coverage.kpiEmpty')} value={L.int(totals.empty_cells_with_waiting)} sub={t('callScripts.coverage.kpiEmptySub')} />
      <KpiCard icon={Send} tone="bg-sky-100 text-sky-700" label={t('callScripts.coverage.kpiPublished')} value={L.int(totals.published)} />
      <KpiCard icon={FileEdit} tone="bg-amber-100 text-amber-700" label={t('callScripts.coverage.kpiDrafts')} value={L.int(totals.drafts)} />
    </div>
  );
}
