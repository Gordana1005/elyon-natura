import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { isPast } from 'date-fns';
import { formatDistanceToNow, formatDate } from '@/i18n/dates';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Clock, Phone, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetCallAgainQueue, type CallAgainEntry } from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';
import { cn } from '@/lib/utils';

export default function CallAgainPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdminOrManager = user?.isAdmin || user?.isManager;
  return (
    <AppLayout title={t('nav.callAgain')}>
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Clock className="h-6 w-6 text-purple-700" /> {t('nav.callAgain')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('callAgainPage.intro')}
          </p>
        </div>

        <Tabs defaultValue="mine" className="space-y-4">
          <TabsList>
            <TabsTrigger value="mine" className="gap-1.5">
              <Users className="h-3.5 w-3.5" /> {t('callAgainPage.myQueue')}
            </TabsTrigger>
            {isAdminOrManager && (
              <TabsTrigger value="all" className="gap-1.5">
                <Users className="h-3.5 w-3.5" /> {t('callAgainPage.everyonesQueue')}
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="mine"><QueueTab mine /></TabsContent>
          {isAdminOrManager && <TabsContent value="all"><QueueTab mine={false} /></TabsContent>}
        </Tabs>
      </div>
    </AppLayout>
  );
}

function QueueTab({ mine }: { mine: boolean }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['call-again-queue', mine],
    queryFn: () => apiGetCallAgainQueue(mine),
    refetchInterval: 60_000,
  });

  // Everyone's queue mixes two very different motions — leads the agent must
  // chase to the end, and prediction customers who can be redistributed. The
  // source was only visible by reading the list column row by row, so the two
  // filters below are what make the page usable without hunting for it.
  const [agentFilter, setAgentFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'order' | 'prediction'>('all');

  const rows = data ?? [];

  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.assigned_agent_id && r.assigned_agent_name) seen.set(r.assigned_agent_id, r.assigned_agent_name);
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const hasUnassigned = useMemo(() => rows.some(r => !r.assigned_agent_id), [rows]);

  const filtered = useMemo(() => rows.filter(r => {
    // Rows with no source_kind are pre-deploy payloads; treat them as prediction
    // (the only source that existed on this page before leads were split out).
    const kind = r.source_kind ?? 'prediction';
    if (sourceFilter !== 'all' && kind !== sourceFilter) return false;
    if (agentFilter === 'all') return true;
    if (agentFilter === 'unassigned') return !r.assigned_agent_id;
    return r.assigned_agent_id === agentFilter;
  }), [rows, agentFilter, sourceFilter]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <Clock className="h-4 w-4" />
          {mine ? t('callAgainPage.yourFollowUps') : t('callAgainPage.allAgentsPending')}
          <span className="text-muted-foreground font-normal text-sm">
            ({filtered.length}{filtered.length !== rows.length ? ` / ${rows.length}` : ''})
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={sourceFilter} onValueChange={v => setSourceFilter(v as typeof sourceFilter)}>
              <SelectTrigger className="h-8 w-[170px] text-xs font-normal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('callAgainPage.sourceAll')}</SelectItem>
                <SelectItem value="order">{t('callAgainPage.sourcePendings')}</SelectItem>
                <SelectItem value="prediction">{t('callAgainPage.sourcePrediction')}</SelectItem>
              </SelectContent>
            </Select>

            {!mine && (
              <Select value={agentFilter} onValueChange={setAgentFilter}>
                <SelectTrigger className="h-8 w-[180px] text-xs font-normal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('callAgainPage.allAgents')}</SelectItem>
                  {hasUnassigned && (
                    <SelectItem value="unassigned">{t('callAgainPage.unassignedOnly')}</SelectItem>
                  )}
                  {agentOptions.map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">{t('common.loading')}</div>
        ) : !rows.length ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            <Clock className="h-6 w-6 mx-auto mb-2 opacity-40" />
            {mine
              ? t('callAgainPage.noCallbacksMine')
              : t('callAgainPage.noCallbacksTeam')}
          </div>
        ) : !filtered.length ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            <Clock className="h-6 w-6 mx-auto mb-2 opacity-40" />
            {t('callAgainPage.noneMatchFilter')}
          </div>
        ) : (
          <QueueTable rows={filtered} showAgent={!mine} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Which motion this row belongs to. Everyone's queue mixes leads (chase to the
 * end, never redistributed) with prediction customers (hand out again), and
 * before this the only clue was the list name buried in another column.
 */
function SourceBadge({ kind }: { kind?: 'order' | 'prediction' }) {
  const { t } = useTranslation();
  const isLead = kind === 'order';
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border whitespace-nowrap',
      isLead
        ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30'
        : 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
    )}>
      {isLead ? t('callAgainPage.sourcePendings') : t('callAgainPage.sourcePrediction')}
    </span>
  );
}

/** How long the customer has been waiting for their call back. */
function WaitingSince({ since }: { since?: string | null }) {
  const { t } = useTranslation();
  if (!since) return <span className="text-muted-foreground/50 text-[11px]">—</span>;
  const days = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
  return (
    <>
      <div className="text-[12px]">{formatDate(new Date(since), 'dd MMM')}</div>
      <div className={cn('text-[10px]', days >= 3 ? 'text-destructive font-medium' : 'text-muted-foreground')}>
        {t('callAgainPage.daysWaiting', { count: days })}
      </div>
    </>
  );
}

function QueueTable({ rows, showAgent }: { rows: CallAgainEntry[]; showAgent: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
    {/* Desktop: table */}
    <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left py-2 font-medium">{t('callAgainPage.colCustomer')}</th>
            {showAgent && <th className="text-left py-2 font-medium">{t('callAgainPage.colAgent')}</th>}
            <th className="text-left py-2 font-medium">{t('callAgainPage.colSource')}</th>
            <th className="text-left py-2 font-medium">{t('callAgainPage.colSourceList')}</th>
            <th className="text-left py-2 font-medium">{t('callAgainPage.colWaitingSince')}</th>
            <th className="text-right py-2 font-medium">{t('callAgainPage.colLifetime')}</th>
            <th className="text-right py-2 font-medium">{t('callAgainPage.colAvgPkg')}</th>
            <th className="text-left py-2 font-medium">{t('callAgainPage.colLastCalled')}</th>
            <th className="text-left py-2 font-medium">{t('callAgainPage.colDue')}</th>
            <th className="text-right py-2 font-medium pr-2">{t('callAgainPage.colAction')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const due = r.in_call_again_until ? new Date(r.in_call_again_until) : null;
            const ready = due ? isPast(due) : true;
            return (
              <tr key={`${r.list_id}-${r.customer_phone}`} className={cn('border-b last:border-0', ready && 'bg-purple-50/50')}>
                <td className="py-2.5 align-top">
                  <div className="font-medium">{r.customer_name || '—'}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">{r.customer_phone}</div>
                </td>
                {showAgent && (
                  <td className="py-2.5 align-top">{r.assigned_agent_name || '—'}</td>
                )}
                <td className="py-2.5 align-top"><SourceBadge kind={r.source_kind} /></td>
                <td className="py-2.5 align-top text-[12px] text-muted-foreground">
                  {r.prediction_segment_lists?.name || '—'}
                </td>
                <td className="py-2.5 align-top whitespace-nowrap">
                  <WaitingSince since={r.call_again_since} />
                </td>
                <td className="py-2.5 align-top text-right tabular-nums font-mono">
                  <div className="font-semibold">{formatMoney(r.lifetime_value)}</div>
                </td>
                <td className="py-2.5 align-top text-right tabular-nums font-mono text-xs">
                  {r.avg_package_price != null ? (
                    <>
                      <div className="font-semibold">{formatMoney(r.avg_package_price)}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-2.5 align-top text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.last_call_at
                    ? formatDistanceToNow(new Date(r.last_call_at), { addSuffix: true })
                    : '—'}
                </td>
                <td className={cn('py-2.5 align-top text-[11px] whitespace-nowrap',
                  ready ? 'text-purple-700 font-semibold' : 'text-muted-foreground')}>
                  {due
                    ? (ready ? t('callAgainPage.readyPrefix') : '') + formatDistanceToNow(due, { addSuffix: true })
                    : t('callAgainPage.noDate')}
                </td>
                <td className="py-2.5 align-top text-right pr-2">
                  <Button
                    size="sm" variant="outline" className="h-7 text-[11px] gap-1"
                    onClick={() => navigate(`/calls?phone=${encodeURIComponent(r.customer_phone)}`)}
                  >
                    <Phone className="h-3 w-3" /> {t('callAgainPage.callNow')}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile: cards (every field visible, no horizontal scroll) */}
    <div className="md:hidden space-y-2">
      {rows.map(r => {
        const due = r.in_call_again_until ? new Date(r.in_call_again_until) : null;
        const ready = due ? isPast(due) : true;
        return (
          <MobileCard key={`${r.list_id}-${r.customer_phone}`} className={cn(ready && 'bg-purple-50/50')}>
            <MobileCardHeader
              title={r.customer_name || '—'}
              subtitle={r.customer_phone}
              badge={
                <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap',
                  ready ? 'bg-purple-100 text-purple-700' : 'bg-muted text-muted-foreground')}>
                  {due ? (ready ? t('callAgainPage.ready') : formatDistanceToNow(due, { addSuffix: true })) : t('callAgainPage.noDate')}
                </span>
              }
            />
            {showAgent && <MobileCardField label={t('callAgainPage.colAgent')} value={r.assigned_agent_name || '—'} />}
            <MobileCardField
              label={t('callAgainPage.colSource')}
              value={r.source_kind === 'order' ? t('callAgainPage.sourcePendings') : t('callAgainPage.sourcePrediction')}
            />
            <MobileCardField label={t('callAgainPage.colSourceList')} value={r.prediction_segment_lists?.name || '—'} />
            <MobileCardField
              label={t('callAgainPage.colWaitingSince')}
              value={<WaitingSince since={r.call_again_since} />}
            />
            <MobileCardField
              label={t('callAgainPage.lifetimeShort')}
              value={<>{formatMoney(r.lifetime_value)}</>}
            />
            <MobileCardField
              label={t('callAgainPage.colAvgPkg')}
              value={r.avg_package_price != null
                ? <>{formatMoney(r.avg_package_price)}</>
                : '—'}
            />
            <MobileCardField
              label={t('callAgainPage.colLastCalled')}
              value={r.last_call_at ? formatDistanceToNow(new Date(r.last_call_at), { addSuffix: true }) : '—'}
            />
            <MobileCardActions>
              <Button
                size="sm" variant="outline" className="gap-1"
                onClick={() => navigate(`/calls?phone=${encodeURIComponent(r.customer_phone)}`)}
              >
                <Phone className="h-3.5 w-3.5" /> {t('callAgainPage.callNow')}
              </Button>
            </MobileCardActions>
          </MobileCard>
        );
      })}
    </div>
    </>
  );
}
