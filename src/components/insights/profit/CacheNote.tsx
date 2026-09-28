import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Database, Loader2, RefreshCw } from 'lucide-react';
import { skopjeHm } from '@/lib/presence/state';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiRefreshInsightsProfit, type ProfitResponse } from '@/lib/insightsApi/profit';
import type { InsightsFormat } from '../shared/useInsightsFormat';

/** dd.mm of an instant, on the Skopje calendar. */
const skopjeDm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', day: '2-digit', month: '2-digit' })
    .format(new Date(iso)).replace('/', '.');

/**
 * A quiet line for windows over 62 days: which closed months came from the
 * monthly cache and how old the oldest one is ("cached until dd.mm HH:mm"),
 * with a refresh for the window's closed months. The current month and a
 * partial first month are always live. Nothing for shorter windows.
 */
export function CacheNote({ meta, f }: { meta: ProfitResponse['meta']; f: InsightsFormat }) {
  const { t } = f;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = meta.cache;
  if (!c) return null;
  const used = Math.min(c.months.cohort, c.months.cash);
  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      for (let round = 0; round < 6; round++) {
        const r = await apiRefreshInsightsProfit({ from: meta.from, to: meta.to });
        if (!r.remaining.length) break;
      }
      await qc.invalidateQueries({ queryKey: ['insights-profit'] });
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      <Database className="h-3 w-3 shrink-0" aria-hidden />
      <span>
        {c.refreshed_min
          ? t('insights.profit.cache.until', {
            date: skopjeDm(c.refreshed_min), time: skopjeHm(c.refreshed_min), n: f.int(used), of: f.int(c.closed_months),
          })
          : t('insights.profit.cache.none', { of: f.int(c.closed_months) })}
      </span>
      <button type="button" onClick={() => { void refresh(); }} disabled={busy}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
        {busy ? t('insights.profit.cache.refreshing') : t('insights.profit.cache.refresh')}
      </button>
      {err && <span role="alert" className="text-red-700 dark:text-red-400">{err}</span>}
    </p>
  );
}
