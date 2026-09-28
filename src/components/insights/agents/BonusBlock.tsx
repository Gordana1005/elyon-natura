import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronRight, Info } from 'lucide-react';
import { apiGetAgentPerformance, type AgentPerformanceRow } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Skeleton } from '@/components/ui/skeleton';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { LoadError } from '../shared/LoadError';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { skopjeDayEndIso, skopjeDayStartIso } from './model';

/**
 * The bonus figures AS THEY ARE TODAY — fed unchanged from GET
 * /agent-performance (its own attribution: the confirmer / operator name, the
 * exact-name bonus gate, CRM paid_at), shown apart and never joined to the
 * people above: the payout / bonus / commission math is deferred by the owner.
 * Only the window is the page's Skopje days now. The server strips the payout
 * for a non-owner admin / manager and keeps an agent's own (as before);
 * payout and the per-package average are stored EUR → shown in денари.
 */
export function BonusBlock({ range, self, f }: { range: DayRange; self: boolean; f: InsightsFormat }) {
  const { t } = f;
  const { user } = useAuth();
  const q = useQuery<AgentPerformanceRow[]>({
    queryKey: ['insights-agents-bonus', user?.id, range.from, range.to],
    queryFn: ({ signal }) => apiGetAgentPerformance({ from: skopjeDayStartIso(range.from), to: skopjeDayEndIso(range.to) }, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const rows = (q.data ?? []).filter((r) => (r.packages_sold ?? 0) > 0 || (r.packages_awaiting ?? 0) > 0 || (r.payout_earned ?? 0) > 0);
  const hasPayout = rows.some((r) => typeof r.payout_earned === 'number');
  const hasAvg = rows.some((r) => typeof r.avg_per_package === 'number');
  const total = rows.reduce((a, r) => a + (r.payout_earned ?? 0), 0);

  return (
    <details className="group rounded-xl border bg-card shadow-sm" open={self}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden />
        <span className="text-base font-semibold">{t('insights.agents.bonus.title')}</span>
        {hasPayout && rows.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{t('insights.agents.bonus.totalLine', { v: formatMoney(total) })}</span>
        )}
      </summary>
      <div className="space-y-3 border-t px-4 pb-4 pt-3">
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{t('insights.agents.bonus.note')}
        </p>
        <ClockCaption clock={['created', 'delivered']} />
        {q.isError && !q.data ? (
          <LoadError text={apiErrorText(q.error)} onRetry={() => { void q.refetch(); }} />
        ) : !q.data ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('insights.agents.bonus.empty')}</p>
        ) : (
          <div className={cn('relative overflow-x-auto transition-opacity', q.isPlaceholderData && 'opacity-60')}>
            <table className="w-full min-w-[480px] text-[13px]">
              <thead className="text-[11px] text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1.5 pr-2 text-left font-medium">{t('insights.agents.bonus.col.name')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium" title={t('insights.agents.bonus.col.packagesHint')}>{t('insights.agents.bonus.col.packages')}</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium" title={t('insights.agents.bonus.col.awaitingHint')}>{t('insights.agents.bonus.col.awaiting')}</th>
                  {hasAvg && <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.agents.bonus.col.avg')}</th>}
                  {hasPayout && <th scope="col" className="py-1.5 pl-2 text-right font-medium">{t('insights.agents.bonus.col.payout')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.user_id} className="border-t">
                    <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                      {r.full_name}
                      {r.is_virtual && <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t('insights.agents.bonus.historic')}</span>}
                    </th>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(r.packages_sold ?? 0)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{f.int(r.packages_awaiting ?? 0)}</td>
                    {hasAvg && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.avg_per_package ? formatMoney(r.avg_per_package) : '—'}</td>}
                    {hasPayout && <td className="whitespace-nowrap py-1.5 pl-2 text-right font-semibold tabular-nums">{r.payout_earned ? formatMoney(r.payout_earned) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
