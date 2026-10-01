import { useState, useMemo } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDate, formatDistanceToNow } from '@/i18n/dates';
import {
  Lock, AlertTriangle, ArrowRight, Phone, Loader2, Plus, Users, UserSearch, NotebookPen, BookOpen, Eye,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiGetMyPersonalHolds, apiGetExpiringHolds, apiGetAllPersonalHolds, apiGetAgents,
  apiReleasePersonalHold, apiExtendPersonalHold, apiGetAppSettings,
  type PersonalHold,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';
import { cn } from '@/lib/utils';
import { personalListTab, type PersonalListTab } from '@/lib/personalNotes/model';
import { NotesWorkspace } from '@/components/personalNotes/NotesWorkspace';
import { AgentNotesBrowser } from '@/components/personalNotes/AgentNotesBrowser';

export default function PersonalListPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdminOrManager = !!(user?.isAdmin || user?.isManager);
  // ?tab= (Фаза 7): mine · notes (Личен дневник) · expiring · agents · agent-notes; ?expiring=1 still works.
  const [params, setParams] = useSearchParams();
  const tab = personalListTab(params, isAdminOrManager);
  // A tab switch starts clean: the notebook / note / owner of another tab do not follow.
  const setTab = (v: string) => setParams(() => new URLSearchParams({ tab: v }), { replace: true });
  const notesTab = tab === 'notes' || tab === 'agent-notes';
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: apiGetAppSettings,
    staleTime: 5 * 60_000,
  });
  const cap = appSettings?.personal_list_max_holds ?? 50;
  const trigger = (key: PersonalListTab, Icon: typeof Users, label: string) => (
    <TabsTrigger key={key} value={key} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{label}
    </TabsTrigger>
  );
  return (
    <AppLayout title={notesTab ? t('nav.personalNotes') : t('nav.personalList')}>
      <div className="mx-auto w-full min-w-0 max-w-6xl space-y-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            {notesTab ? <NotebookPen className="h-6 w-6 shrink-0" aria-hidden /> : <Lock className="h-6 w-6 shrink-0" aria-hidden />}
            <span className="min-w-0">{notesTab ? t('personalNotes.title') : t('nav.personalList')}</span>
          </h1>
          <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
            {tab === 'notes' ? (
              <><Eye className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>{t('personalNotes.privacy')}</span></>
            ) : tab === 'agent-notes' ? (
              <span>{t('personalNotes.authors.desc')}</span>
            ) : (
              <span>{t('personalListPage.intro', { count: cap })}</span>
            )}
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          {/* Wraps instead of scrolling sideways on a phone (the WarehousePage pattern). */}
          <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
            {trigger('mine', Users, t('personalListPage.myHolds'))}
            {trigger('notes', NotebookPen, t('personalNotes.tabs.notes'))}
            {isAdminOrManager && trigger('expiring', AlertTriangle, t('personalListPage.expiringReview'))}
            {isAdminOrManager && trigger('agents', UserSearch, t('personalListPage.agentsLists'))}
            {isAdminOrManager && trigger('agent-notes', BookOpen, t('personalNotes.tabs.agentNotes'))}
          </TabsList>

          <TabsContent value="mine"><MyHoldsTab /></TabsContent>
          <TabsContent value="notes"><NotesWorkspace ownerId={null} readOnly={false} /></TabsContent>
          {isAdminOrManager && <TabsContent value="expiring"><ExpiringTab /></TabsContent>}
          {isAdminOrManager && <TabsContent value="agents"><AgentsListsTab /></TabsContent>}
          {isAdminOrManager && <TabsContent value="agent-notes"><AgentNotesBrowser /></TabsContent>}
        </Tabs>
      </div>
    </AppLayout>
  );
}

function MyHoldsTab() {
  const { t } = useTranslation();
  const { data: holds, isLoading } = useQuery({
    queryKey: ['my-personal-holds'],
    queryFn: apiGetMyPersonalHolds,
  });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t('personalListPage.yourList')}</CardTitle></CardHeader>
      <CardContent className="px-3 sm:px-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">{t('common.loading')}</div>
        ) : !holds?.length ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            <Plus className="h-6 w-6 mx-auto mb-2 opacity-40" />
            {t('personalListPage.noneClaimed')}
          </div>
        ) : (
          <HoldsTable holds={holds} mode="mine" />
        )}
      </CardContent>
    </Card>
  );
}

function ExpiringTab() {
  const { t } = useTranslation();
  const { data: holds, isLoading } = useQuery({
    queryKey: ['expiring-personal-holds'],
    queryFn: apiGetExpiringHolds,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          {t('personalListPage.expiredAwaiting')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">{t('common.loading')}</div>
        ) : !holds?.length ? (
          <EmptyState
            title={t('personalListPage.noExpired')}
            description={t('personalListPage.noExpiredDesc')}
            size="sm"
          />
        ) : (
          <HoldsTable holds={holds} mode="admin" />
        )}
      </CardContent>
    </Card>
  );
}

function AgentsListsTab() {
  const { t } = useTranslation();
  const [selectedAgent, setSelectedAgent] = useState('');

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    staleTime: 5 * 60_000,
  });
  const { data: allHolds, isLoading } = useQuery({
    queryKey: ['all-personal-holds'],
    queryFn: apiGetAllPersonalHolds,
  });

  // Group every active hold under the agent that owns it.
  const byAgent = useMemo(() => {
    const m = new Map<string, PersonalHold[]>();
    for (const h of allHolds ?? []) {
      const arr = m.get(h.agent_id);
      if (arr) arr.push(h); else m.set(h.agent_id, [h]);
    }
    return m;
  }, [allHolds]);

  // Full roster (with per-agent counts) + any agent that owns holds but is
  // missing from the roster (deactivated / other role) so no held customer is
  // ever hidden. Sorted most-held first, then by name.
  const roster = useMemo(() => {
    const rows: { user_id: string; name: string; count: number }[] = [];
    const seen = new Set<string>();
    for (const a of (agents ?? []) as Array<{ user_id: string; full_name: string }>) {
      rows.push({ user_id: a.user_id, name: a.full_name, count: byAgent.get(a.user_id)?.length ?? 0 });
      seen.add(a.user_id);
    }
    for (const [aid, hs] of byAgent) {
      if (!seen.has(aid)) rows.push({ user_id: aid, name: hs[0]?.agent_name ?? aid, count: hs.length });
    }
    return rows.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name));
  }, [agents, byAgent]);

  const totalCustomers = allHolds?.length ?? 0;
  const activeAgents = useMemo(() => roster.filter(r => r.count > 0).length, [roster]);
  const selectedHolds = selectedAgent ? (byAgent.get(selectedAgent) ?? []) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <UserSearch className="h-4 w-4" /> {t('personalListPage.agentsLists')}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 sm:px-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedAgent} onValueChange={setSelectedAgent}>
            <SelectTrigger className="w-64 h-9 text-sm rounded-lg">
              <SelectValue placeholder={t('personalListPage.selectAgent')} />
            </SelectTrigger>
            <SelectContent>
              {roster.map(a => (
                <SelectItem key={a.user_id} value={a.user_id}>
                  <span className="flex items-center gap-2">
                    {a.name}
                    <span className="text-[10px] text-muted-foreground">· {a.count}</span>
                  </span>
                </SelectItem>
              ))}
              {roster.length === 0 && <SelectItem value="__none" disabled>—</SelectItem>}
            </SelectContent>
          </Select>
          {totalCustomers > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('personalListPage.agentsSummary', { agents: activeAgents, customers: totalCustomers })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="text-sm text-muted-foreground py-4">{t('common.loading')}</div>
        ) : !selectedAgent ? (
          <EmptyState
            title={t('personalListPage.selectAgent')}
            description={t('personalListPage.pickAgentPrompt')}
            size="sm"
          />
        ) : selectedHolds.length === 0 ? (
          <EmptyState title={t('personalListPage.agentNoHolds')} size="sm" />
        ) : (
          <HoldsTable holds={selectedHolds} mode="admin" />
        )}
      </CardContent>
    </Card>
  );
}

function HoldsTable({ holds, mode }: { holds: PersonalHold[]; mode: 'mine' | 'admin' }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['my-personal-holds'] });
    qc.invalidateQueries({ queryKey: ['expiring-personal-holds'] });
    qc.invalidateQueries({ queryKey: ['all-personal-holds'] });
    qc.invalidateQueries({ queryKey: ['expiring-holds-count'] });
    qc.invalidateQueries({ queryKey: ['personal-hold'] });
  };

  const release = async (id: string, label: string) => {
    setBusyId(id);
    try {
      await apiReleasePersonalHold(id);
      toast({ title: mode === 'admin' ? t('personalListPage.returnedToPool') : t('personalListPage.released'), description: label });
      refresh();
    } catch (err: any) {
      toast({ title: t('personalListPage.failed'), description: err?.message, variant: 'destructive' });
    } finally { setBusyId(null); }
  };

  const extend = async (id: string, days: number) => {
    setBusyId(id);
    try {
      await apiExtendPersonalHold(id, days);
      toast({ title: t('personalListPage.extendedBy', { days }) });
      refresh();
    } catch (err: any) {
      toast({ title: t('personalListPage.failed'), description: err?.message, variant: 'destructive' });
    } finally { setBusyId(null); }
  };

  return (
    <>
    {/* Desktop: table */}
    <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left py-2 font-medium">{t('personalListPage.colCustomer')}</th>
            {mode === 'admin' && <th className="text-left py-2 font-medium">{t('personalListPage.colAgent')}</th>}
            <th className="text-left py-2 font-medium">{t('personalListPage.colReason')}</th>
            <th className="text-left py-2 font-medium">{t('personalListPage.colClaimed')}</th>
            <th className="text-left py-2 font-medium">{t('personalListPage.colExpires')}</th>
            <th className="text-right py-2 font-medium pr-2">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {holds.map(h => {
            const expired = new Date(h.expires_at) < new Date();
            return (
              <tr key={h.id} className={cn('border-b last:border-0', expired && 'bg-red-50')}>
                <td className="py-2.5 align-top">
                  <button
                    onClick={() => navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`)}
                    className="text-left hover:underline"
                  >
                    <div className="font-medium">{h.customer_name || '—'}</div>
                    <div className="text-[11px] font-mono text-muted-foreground">{h.customer_phone}</div>
                  </button>
                </td>
                {mode === 'admin' && (
                  <td className="py-2.5 align-top">
                    <span className="text-sm">{h.agent_name}</span>
                  </td>
                )}
                <td className="py-2.5 max-w-[320px] align-top text-[12px] whitespace-pre-wrap">
                  {h.reason}
                  {h.follow_up_by && (
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {t('personalList.followUpBy', { date: formatDate(h.follow_up_by, 'd MMM yyyy') })}
                    </div>
                  )}
                </td>
                <td className="py-2.5 align-top text-[11px] text-muted-foreground whitespace-nowrap">
                  {formatDistanceToNow(new Date(h.claimed_at), { addSuffix: true })}
                </td>
                <td className={cn('py-2.5 align-top text-[11px] whitespace-nowrap',
                  expired ? 'text-red-700 font-semibold' : 'text-muted-foreground')}>
                  {expired ? t('personalListPage.expiredPrefix') : ''}{formatDistanceToNow(new Date(h.expires_at), { addSuffix: true })}
                </td>
                <td className="py-2.5 align-top text-right pr-2">
                  <div className="inline-flex gap-1.5">
                    <Button
                      size="sm" variant="outline" className="h-7 text-[11px] gap-1"
                      onClick={() => navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`)}
                    >
                      <Phone className="h-3 w-3" /> {t('personalListPage.open')}
                    </Button>
                    {mode === 'admin' && (
                      <Button
                        size="sm" variant="outline" className="h-7 text-[11px] gap-1"
                        disabled={busyId === h.id}
                        onClick={() => extend(h.id, 5)}
                      >
                        +5d
                      </Button>
                    )}
                    <Button
                      size="sm" variant="outline" className="h-7 text-[11px] gap-1 text-rose-700 hover:bg-rose-50"
                      disabled={busyId === h.id}
                      onClick={() => release(h.id, h.customer_name || h.customer_phone)}
                    >
                      {busyId === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                      {mode === 'admin' ? t('personalListPage.returnToPool') : t('personalListPage.release')}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile: cards */}
    <div className="md:hidden space-y-2">
      {holds.map(h => {
        const expired = new Date(h.expires_at) < new Date();
        return (
          <MobileCard key={h.id} className={cn(expired && 'bg-red-50')}>
            <MobileCardHeader
              title={
                <button
                  onClick={() => navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`)}
                  className="text-left hover:underline"
                >
                  {h.customer_name || '—'}
                </button>
              }
              subtitle={h.customer_phone}
              badge={expired
                ? <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-700 whitespace-nowrap">{t('personalListPage.expired')}</span>
                : undefined}
            />
            {mode === 'admin' && <MobileCardField label={t('personalListPage.colAgent')} value={h.agent_name} />}
            <MobileCardField
              label={t('personalListPage.colReason')}
              value={
                <span className="whitespace-pre-wrap">
                  {h.reason}
                  {h.follow_up_by && (
                    <span className="block text-[10px] text-muted-foreground mt-1">
                      {t('personalList.followUpBy', { date: formatDate(h.follow_up_by, 'd MMM yyyy') })}
                    </span>
                  )}
                </span>
              }
            />
            <MobileCardField label={t('personalListPage.colClaimed')} value={formatDistanceToNow(new Date(h.claimed_at), { addSuffix: true })} />
            <MobileCardField
              label={t('personalListPage.colExpires')}
              value={<span className={cn(expired && 'text-red-700 font-semibold')}>{formatDistanceToNow(new Date(h.expires_at), { addSuffix: true })}</span>}
            />
            <MobileCardActions>
              <Button
                size="sm" variant="outline" className="gap-1"
                onClick={() => navigate(`/calls?phone=${encodeURIComponent(h.customer_phone)}`)}
              >
                <Phone className="h-3.5 w-3.5" /> {t('personalListPage.open')}
              </Button>
              {mode === 'admin' && (
                <Button size="sm" variant="outline" disabled={busyId === h.id} onClick={() => extend(h.id, 5)}>
                  +5d
                </Button>
              )}
              <Button
                size="sm" variant="outline" className="gap-1 text-rose-700 hover:bg-rose-50"
                disabled={busyId === h.id}
                onClick={() => release(h.id, h.customer_name || h.customer_phone)}
              >
                {busyId === h.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                {mode === 'admin' ? t('personalListPage.returnShort') : t('personalListPage.release')}
              </Button>
            </MobileCardActions>
          </MobileCard>
        );
      })}
    </div>
    </>
  );
}
