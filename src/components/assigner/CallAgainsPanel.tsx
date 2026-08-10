import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Clock, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SmartPagination } from '@/components/SmartPagination';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardHeader, MobileCardField } from '@/components/ui/mobile-card';
import { apiGetCallAgains, apiAssignCallAgains, type CallAgainMember } from '@/lib/api';
import { apiErrorText } from '@/i18n/apiErrors';
import { toast } from '@/hooks/use-toast';
// MKD only — prices are stored in EUR and the denar is derived at display time
// from the frozen peg. No dual display in this market (see elyon-currency).
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;

/** Whole days a customer has been waiting in the Call-Again window. */
function daysWaiting(since: string | null): number | null {
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  return ms < 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** Only what the picker needs — AssignerPage owns the full OnlineAgent shape. */
type AgentOption = { user_id: string; full_name: string };

/**
 * The Call Agains tab of the Assigner.
 *
 * PREDICTION-LIST call agains only, and that boundary is the point. A lead
 * (AlterCPA / webhook / site) that didn't answer stays in its own agent's
 * Pendings queue — fresh leads first, the call agains behind them — until that
 * agent reaches the customer. It is never redistributed from here.
 *
 * Prediction call agains are the opposite: they belong to nobody's day, so the
 * operator hands them out, and hands them out again, until somebody gets
 * through. Sorted oldest-waiting-first for exactly that reason.
 */
export function CallAgainsPanel({ agents }: { agents: AgentOption[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [agentFilter, setAgentFilter] = useState('all');
  const [selected, setSelected] = useState<Map<string, CallAgainMember>>(new Map());
  const [targetAgent, setTargetAgent] = useState('');

  // A member is identified by (list_id, customer_phone) — it has no id of its
  // own, and the same phone can legitimately appear under a different list.
  const key = (m: { list_id: string; customer_phone: string }) => `${m.list_id}|${m.customer_phone}`;

  const { data, isLoading } = useQuery({
    queryKey: ['assigner-call-agains', page, agentFilter],
    queryFn: () => apiGetCallAgains({ page, limit: PAGE_SIZE, agent_id: agentFilter }),
    refetchInterval: 30_000,
  });
  const members = data?.members ?? [];
  const total = data?.total ?? 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['assigner-call-agains'] });
    qc.invalidateQueries({ queryKey: ['assignment-summary'] });
    qc.invalidateQueries({ queryKey: ['online-agents'] });
    qc.invalidateQueries({ queryKey: ['my-queue-summary'] });
  };

  const assign = useMutation({
    mutationFn: (agentId: string | null) =>
      apiAssignCallAgains(
        [...selected.values()].map(m => ({ list_id: m.list_id, customer_phone: m.customer_phone })),
        agentId,
      ),
    onSuccess: (res, agentId) => {
      toast({
        title: agentId
          ? t('assigner.callAgainsAssigned', { count: res.assigned })
          : t('assigner.callAgainsFreed', { count: res.assigned }),
      });
      setSelected(new Map());
      setTargetAgent('');
      invalidate();
    },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const allOnPageSelected = members.length > 0 && members.every(m => selected.has(key(m)));
  const toggleAll = () => setSelected(prev => {
    const next = new Map(prev);
    if (allOnPageSelected) members.forEach(m => next.delete(key(m)));
    else members.forEach(m => next.set(key(m), m));
    return next;
  });
  const toggleOne = (m: CallAgainMember) => setSelected(prev => {
    const next = new Map(prev);
    if (next.has(key(m))) next.delete(key(m)); else next.set(key(m), m);
    return next;
  });

  const agentOptions = useMemo(
    () => [...agents].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [agents],
  );

  return (
    <div className="space-y-3">
      {/* Filter + bulk bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={agentFilter} onValueChange={v => { setAgentFilter(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[220px] text-sm">
            <SelectValue placeholder={t('assigner.filterByAgent')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('assigner.allAgents')}</SelectItem>
            <SelectItem value="unassigned">{t('assigner.unassignedOnly')}</SelectItem>
            {agentOptions.map(a => (
              <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">
          {t('assigner.callAgainsWaiting', { count: total })}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium">
              {t('assigner.nSelected', { count: selected.size })}
            </span>
          )}
          <Select value={targetAgent} onValueChange={setTargetAgent}>
            <SelectTrigger className="h-9 w-[200px] text-sm">
              <SelectValue placeholder={t('assigner.selectAgent')} />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map(a => (
                <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={selected.size === 0 || !targetAgent || assign.isPending}
            onClick={() => assign.mutate(targetAgent)}
          >
            {assign.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {t('assigner.assignCount', { count: selected.size })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={selected.size === 0 || assign.isPending}
            onClick={() => assign.mutate(null)}
          >
            <UserX className="h-3.5 w-3.5" />
            {t('assigner.freeSelected')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : members.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-5 w-5" />}
          title={t('assigner.noCallAgains')}
          description={t('assigner.noCallAgainsDesc')}
          size="md"
        />
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden md:block overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2.5 w-10">
                    <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAll} aria-label={t('assigner.selectAll')} />
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colCustomer')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colSourceList')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colAgent')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.waitingSince')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colLastCalled')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t('callAgainPage.colAvgPkg')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => {
                  const days = daysWaiting(m.call_again_since);
                  return (
                    <tr
                      key={key(m)}
                      className={cn('border-b last:border-0 hover:bg-muted/20 cursor-pointer transition-colors',
                        selected.has(key(m)) && 'bg-primary/5')}
                      onClick={() => toggleOne(m)}
                    >
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selected.has(key(m))} onCheckedChange={() => toggleOne(m)} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium">{m.customer_name || '—'}</div>
                        <div className="text-[11px] font-mono text-muted-foreground">{m.customer_phone}</div>
                      </td>
                      <td className="px-3 py-2.5 text-[12px] text-muted-foreground">
                        {m.prediction_segment_lists?.name || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-[12px]">
                        {m.assigned_agent_name
                          ? m.assigned_agent_name
                          : <span className="text-muted-foreground/60">{t('assigner.unassignedLabel')}</span>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {m.call_again_since ? (
                          <>
                            <div className="text-[12px]">{formatDate(new Date(m.call_again_since), 'dd MMM')}</div>
                            {days != null && (
                              <div className={cn('text-[10px]', days >= 3 ? 'text-destructive font-medium' : 'text-muted-foreground')}>
                                {t('assigner.daysWaiting', { count: days })}
                              </div>
                            )}
                          </>
                        ) : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">
                        {m.last_call_at ? formatDate(new Date(m.last_call_at), 'dd MMM HH:mm') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-xs">
                        {m.avg_package_price != null
                          ? <div className="font-semibold">{formatMoney(m.avg_package_price)}</div>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <div className="md:hidden space-y-2">
            {members.map(m => {
              const days = daysWaiting(m.call_again_since);
              return (
                <MobileCard
                  key={key(m)}
                  className={cn(selected.has(key(m)) && 'ring-1 ring-primary')}
                  onClick={() => toggleOne(m)}
                >
                  <div className="flex items-start gap-2">
                    <Checkbox
                      className="mt-1 shrink-0"
                      checked={selected.has(key(m))}
                      onCheckedChange={() => toggleOne(m)}
                      onClick={e => e.stopPropagation()}
                    />
                    <div className="flex-1 min-w-0">
                      <MobileCardHeader title={m.customer_name || m.customer_phone} subtitle={m.customer_phone} />
                      <MobileCardField label={t('callAgainPage.colSourceList')} value={m.prediction_segment_lists?.name || '—'} />
                      <MobileCardField label={t('callAgainPage.colAgent')} value={m.assigned_agent_name || t('assigner.unassignedLabel')} />
                      <MobileCardField
                        label={t('assigner.waitingSince')}
                        value={m.call_again_since
                          ? `${formatDate(new Date(m.call_again_since), 'dd MMM')}${days != null ? ` · ${t('assigner.daysWaiting', { count: days })}` : ''}`
                          : '—'}
                      />
                    </div>
                  </div>
                </MobileCard>
              );
            })}
          </div>

          <SmartPagination
            page={page}
            totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
