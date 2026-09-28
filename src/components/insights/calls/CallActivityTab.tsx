import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Phone, Users } from 'lucide-react';
import type { InsightsCallsResponse } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { fmtDuration as fmtDur } from '@/lib/design-utils';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import CallActivityTimeline from '@/components/insights/CallActivityTimeline';
import { ListCard } from '@/components/insights/shared/ListCard';
import { LoadError } from '@/components/insights/shared/LoadError';
import { cap, pct } from '@/components/insights/shared/tabFormat';

/**
 * Insights → Call activity: the KPI block (when this login gets one — the
 * owners' full aggregate or the admin/manager ?scope=calls slice) and the
 * per-agent timeline. Moved out of ManagementInsightsPage (WP0) so the Work &
 * calls package edits its own file; the KPI block below is verbatim.
 */
export default function CallActivityTab({ calls, error, errorText, onRetry }: {
  calls: InsightsCallsResponse['calls'] | undefined;
  error: unknown;
  errorText: (err: unknown) => string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-5">
      {calls ? <Calls c={calls} /> : error ? (
        <LoadError text={errorText(error)} onRetry={onRetry} />
      ) : null}
      <CallActivityTimeline />
    </div>
  );
}

// The Call Activity KPI block. Takes the calls block alone, because a
// non-owner's response (?scope=calls) carries nothing else.
function Calls({ c }: { c: InsightsCallsResponse['calls'] }) {
  if (!c.total) return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={<Phone className="h-5 w-5" />}
          title={i18n.t('insights.noCalls')}
          description={i18n.t('insights.noCallsDesc')}
          size="sm"
        />
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={Phone} label={i18n.t('insights.calls')} value={c.total.toLocaleString()} tone="bg-blue-100 text-blue-700" />
        <Kpi icon={Phone} label={i18n.t('insights.answerRate')} value={pct(c.answer_rate)} sub={i18n.t('insights.answeredSub', { count: c.answered.toLocaleString() })} tone="bg-emerald-100 text-emerald-700" />
        <Kpi icon={Phone} label={i18n.t('insights.talkTime')} value={fmtDur(c.talk_seconds)} tone="bg-amber-100 text-amber-700" />
        <Kpi icon={Phone} label={i18n.t('insights.avgPerCall')} value={fmtDur(c.total ? Math.round(c.talk_seconds / c.total) : 0)} tone="bg-indigo-100 text-indigo-700" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard title={i18n.t('insights.byOutcome')} icon={Phone} rows={c.by_outcome} nameKey="outcome" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cap} />
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Calls by agent</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('search.colAgent')}</th><th className="text-right py-2 px-2">{i18n.t('insights.colCalls')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colAnswerPct')}</th><th className="text-right py-2 px-2">{i18n.t('insights.colTalk')}</th>
              </tr></thead>
              <tbody>
                {c.per_agent.map(a => (
                  <tr key={a.name} className="border-b last:border-0">
                    <td className="py-2 px-2 font-medium">{a.name}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{a.calls}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{pct(a.answer_rate)}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{fmtDur(a.talk_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
