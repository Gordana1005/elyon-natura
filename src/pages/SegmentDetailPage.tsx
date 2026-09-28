import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatMoney } from '@/lib/currency';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetSegment, apiAssignSegmentMembers, apiGetAgents } from '@/lib/api';
import { ArrowLeft, Users, Loader2, UserPlus, UserX } from 'lucide-react';
import { SegmentMemberTable, type SegmentMember as Member } from '@/components/assigner/SegmentMemberTable';
import { predictionListLabel } from '@/lib/predictionListLabel';

interface SegmentList {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_event: string;
  recency_months_min: number | null;
  recency_months_max: number | null;
  single_price_min: number | null;
  single_price_max: number | null;
  min_paid_count: number | null;
  lifetime_min: number | null;
  is_active: boolean;
}

const PAGE_SIZE = 50;

export default function SegmentDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin || user?.isManager;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [assignedFilter, setAssignedFilter] = useState<string>('all');
  const [completedFilter, setCompletedFilter] = useState<string>('no');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAgent, setBulkAgent] = useState<string>('');

  const { data, isLoading } = useQuery<{ list: SegmentList; members: Member[]; total: number }>({
    queryKey: ['segment', id, page, assignedFilter, completedFilter],
    queryFn: () => apiGetSegment(id!, {
      page,
      limit: PAGE_SIZE,
      assigned: assignedFilter !== 'all' ? assignedFilter : undefined,
      completed: completedFilter !== 'all' ? completedFilter : undefined,
    }),
    enabled: !!isAdmin && !!id,
  });

  const { data: agents = [] } = useQuery<{ user_id: string; full_name: string }[]>({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    enabled: !!isAdmin,
  });

  const assignMutation = useMutation({
    mutationFn: (args: { phones: string[]; agentId: string | null }) =>
      apiAssignSegmentMembers(id!, args.phones, args.agentId),
    onSuccess: (resp: any, vars) => {
      toast({
        title: vars.agentId ? t('segmentDetail.assignedToast') : t('segmentDetail.unassignedToast'),
        description: vars.agentId ? t('segmentDetail.assignDesc', { count: resp.updated, name: resp.agent_name }) : t('segmentDetail.unassignDesc', { count: resp.updated }),
      });
      setSelected(new Set());
      setBulkAgent('');
      qc.invalidateQueries({ queryKey: ['segment', id] });
      qc.invalidateQueries({ queryKey: ['segments'] });
    },
    onError: (err: any) => toast({ title: t('segmentDetail.assignmentFailed'), description: err?.message, variant: 'destructive' }),
  });

  const list = data?.list;
  const members = data?.members ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const allOnPageSelected = members.length > 0 && members.every(m => selected.has(m.customer_phone));
  const toggleAll = () => {
    if (allOnPageSelected) {
      const next = new Set(selected);
      for (const m of members) next.delete(m.customer_phone);
      setSelected(next);
    } else {
      const next = new Set(selected);
      for (const m of members) next.add(m.customer_phone);
      setSelected(next);
    }
  };

  const ruleSummary = useMemo(() => {
    if (!list) return '';
    const parts: string[] = [];
    if (list.recency_months_min !== null || list.recency_months_max !== null) {
      const lo = list.recency_months_min ?? 0;
      const hi = list.recency_months_max == null ? '∞' : list.recency_months_max;
      parts.push(`${lo}-${hi}m since ${list.trigger_event.replace('last_', '')}`);
    }
    if (list.single_price_min !== null) {
      const lo = formatMoney(list.single_price_min);
      const hi = list.single_price_max == null ? '∞' : formatMoney(list.single_price_max);
      parts.push(`order ${lo}–${hi}`);
    }
    if (list.min_paid_count !== null) parts.push(`OR ${list.min_paid_count}+ paid`);
    if (list.lifetime_min !== null) parts.push(`lifetime ≥ ${formatMoney(list.lifetime_min)}`);
    return parts.join(' · ');
  }, [list]);

  if (!isAdmin) {
    return (
      <AppLayout title={t('titles.predictionList')}>
        <div className="text-sm text-muted-foreground">{t('segments.adminRequired')}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={list?.name ? predictionListLabel(list.name) : t('titles.predictionList')}>
      <div className="space-y-4">
        <div>
          <Link to="/segments" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> {t('nav.predictionLists')}
          </Link>
          <h1 className="text-2xl font-bold mt-1 flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            {list?.name || (isLoading ? t('segmentDetail.loading') : t('segmentDetail.notFound'))}
          </h1>
          {list && (
            <>
              <p className="text-sm text-muted-foreground mt-0.5">{list.description}</p>
              <p className="text-[11px] text-muted-foreground/80 mt-1">{ruleSummary}</p>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/60 p-3">
          <Select value={assignedFilter} onValueChange={(v) => { setAssignedFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[180px] h-9">
              <SelectValue placeholder={t('segmentDetail.assignment')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('segmentDetail.allMembers')}</SelectItem>
              <SelectItem value="none">{t('segmentDetail.unassignedOnly')}</SelectItem>
              {agents.map(a => (
                <SelectItem key={a.user_id} value={a.user_id}>{t('segmentDetail.assignedTo', { name: a.full_name })}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={completedFilter} onValueChange={(v) => { setCompletedFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder={t('segmentDetail.completion')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('segmentDetail.anyState')}</SelectItem>
              <SelectItem value="no">{t('segmentDetail.notYetCalled')}</SelectItem>
              <SelectItem value="yes">{t('segmentDetail.alreadyCalled')}</SelectItem>
            </SelectContent>
          </Select>
          <span className="ml-auto text-sm text-muted-foreground">{t('segmentDetail.matchingMembers', { count: total })}</span>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-3 rounded-lg border-2 border-primary/40 bg-primary/5 px-3 py-2 sticky top-16 z-10 backdrop-blur-sm">
            <span className="text-sm font-semibold">{t('segmentDetail.nSelected', { count: selected.size })}</span>
            <Select value={bulkAgent} onValueChange={setBulkAgent}>
              <SelectTrigger className="w-[200px] h-8 text-sm">
                <SelectValue placeholder={t('segmentDetail.assignTo')} />
              </SelectTrigger>
              <SelectContent>
                {agents.map(a => (
                  <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => bulkAgent && assignMutation.mutate({ phones: [...selected], agentId: bulkAgent })}
              disabled={!bulkAgent || assignMutation.isPending}
              className="gap-1.5"
            >
              {assignMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              {t('segmentDetail.assign')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => assignMutation.mutate({ phones: [...selected], agentId: null })}
              disabled={assignMutation.isPending}
              className="gap-1.5"
            >
              <UserX className="h-3.5 w-3.5" />
              {t('segmentDetail.unassignedToast')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{t('common.clear')}</Button>
          </div>
        )}

        <SegmentMemberTable
          members={members}
          isSelected={(phone) => selected.has(phone)}
          onToggle={(m) => {
            const next = new Set(selected);
            if (next.has(m.customer_phone)) next.delete(m.customer_phone); else next.add(m.customer_phone);
            setSelected(next);
          }}
          onToggleAll={toggleAll}
          allOnPageSelected={allOnPageSelected}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          loading={isLoading}
        />
      </div>
    </AppLayout>
  );
}
