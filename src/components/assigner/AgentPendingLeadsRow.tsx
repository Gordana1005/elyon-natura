import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetOrders, apiBulkUnassignOrders } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Loader2, UserX } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface PendingLead {
  id: string;
  display_id: string;
  customer_name: string;
  customer_phone: string;
  product_name: string | null;
  created_at: string;
  assigned_at: string | null;
  status: string;
}

// A lead the agent has already engaged with. `take` = they are on the customer
// right now; `call_again` = they rang and nobody picked up. Both are still the
// agent's work — they are just not fresh.
const isWorked = (status: string) => status === 'take' || status === 'call_again';

interface Props {
  agentId: string;
  count: number;
  busy: boolean;
  /** Auto-open once (agent-card / chip navigation from the page). */
  defaultOpen?: boolean;
  onMutated: () => void;
}

/** Expandable "Pending leads" sub-row inside an agent's Unassign-tab card:
 *  lazy-loads the agent's assigned status=pending orders and offers a
 *  per-order unassign. Bulk freeing rides on the agent-level button. */
export function AgentPendingLeadsRow({ agentId, count, busy, defaultOpen, onMutated }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(!!defaultOpen);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  useEffect(() => { if (defaultOpen) setExpanded(true); }, [defaultOpen]);

  // The whole lead lifecycle, exactly what assigned_pending_counts() counts for
  // the chip above. Asking for 'pending' alone made the row say "nothing to
  // assign" while the chip said 2 — every one of that agent's leads had been
  // called once and moved to call_again, so the row could never see them.
  const { data, isLoading } = useQuery<{ orders: PendingLead[] }>({
    queryKey: ['assigner-agent-pendings', agentId],
    queryFn: () => apiGetOrders({ status: 'pending,take,call_again', agent_id: agentId, lead_only: true, limit: 200 }),
    enabled: expanded,
  });
  // Untouched leads first — they are the ones actually worth reassigning.
  const leads = [...(data?.orders ?? [])].sort((a, b) => {
    const w = Number(isWorked(a.status)) - Number(isWorked(b.status));
    if (w !== 0) return w;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  const toCall = leads.filter(l => !isWorked(l.status)).length;
  const called = leads.length - toCall;

  const unassignOne = async (orderId: string) => {
    setRowBusy(orderId);
    try {
      await apiBulkUnassignOrders([orderId]);
      toast({ title: t('assigner.pendingUnassigned') });
      onMutated();
    } catch (err) {
      toast({ title: t('assigner.unassignFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-3 px-4 py-2 pl-9 text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0', expanded && 'rotate-90')} />
        <div className="flex-1 min-w-0 text-sm truncate">{t('assigner.pendingLeadsRow')}</div>
        {/* Same read as a prediction list row: how many are still untouched vs
            already worked, so it is obvious at a glance what can be handed on. */}
        {expanded && leads.length > 0 && (
          <>
            <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[11px] font-medium shrink-0 dark:bg-amber-500/15 dark:text-amber-300">
              {t('assigner.nToCall', { count: toCall })}
            </span>
            {called > 0 && (
              <span className="rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px] font-medium shrink-0">
                {t('assigner.nCalled', { count: called })}
              </span>
            )}
          </>
        )}
        <span className="text-xs text-muted-foreground shrink-0">
          {t('assigner.nPendings', { count: count.toLocaleString() })}
        </span>
      </button>

      {expanded && (
        <div className="border-t bg-background/40">
          {isLoading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
          ) : leads.length === 0 ? (
            <div className="px-4 py-3 pl-16 text-xs text-muted-foreground">{t('assigner.noPendingToAssign')}</div>
          ) : leads.map(lead => (
            <div key={lead.id} className="flex items-center gap-3 px-4 py-1.5 pl-16 border-b last:border-0 border-border/50">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{lead.customer_name || '—'}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{lead.customer_phone}</span>
              </div>
              {/* The lead's real status, in the same words as everywhere else —
                  "Call Again" / "In progress". The twin of the "Done" badge on
                  prediction members, but a lead is never "done" until it is
                  confirmed, cancelled or trashed, so say what it actually is. */}
              {isWorked(lead.status) && (
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {t(`status.${lead.status}`)}
                </Badge>
              )}
              {lead.product_name && (
                <Badge variant="outline" className="text-[10px] shrink-0 hidden sm:inline-flex">{lead.product_name}</Badge>
              )}
              <span className="text-[11px] text-muted-foreground shrink-0 hidden md:inline">
                {format(new Date(lead.created_at), 'MMM d, HH:mm')}
              </span>
              <Button
                variant="ghost" size="icon"
                className="h-6 w-6 shrink-0 text-rose-600 hover:bg-rose-100 hover:text-rose-700"
                disabled={busy || rowBusy !== null}
                onClick={() => unassignOne(lead.id)}
                title={t('assigner.unassign')}
              >
                {rowBusy === lead.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
