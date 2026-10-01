import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiGetPostbackLog, apiRetryPostback, apiProcessPostbacks, apiGetAffiliates,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Loader2, RefreshCw, RotateCcw, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';

const EVENTS = ['lead', 'hold', 'approve', 'cancel', 'trash', 'return', 'test'] as const;
const STATUSES = ['pending', 'delivered', 'failed', 'skipped'] as const;

const statusBadge: Record<string, string> = {
  delivered: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  pending: 'bg-amber-500/10 text-amber-600 border-amber-200',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
  skipped: 'bg-muted text-muted-foreground border-border',
};

export function PostbackLogTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const queryClient = useQueryClient();

  const [fAffiliate, setFAffiliate] = useState<string>('all');
  const [fStatus, setFStatus] = useState<string>('all');
  const [fEvent, setFEvent] = useState<string>('all');
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data: affiliates = [] } = useQuery({ queryKey: ['affiliates'], queryFn: apiGetAffiliates });
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['affiliate-postbacks', fAffiliate, fStatus, fEvent, page],
    queryFn: () => apiGetPostbackLog({
      affiliate_id: fAffiliate === 'all' ? undefined : fAffiliate,
      status: fStatus === 'all' ? undefined : fStatus,
      event: fEvent === 'all' ? undefined : fEvent,
      page, limit,
    }),
  });

  const onError = (err: any) =>
    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['affiliate-postbacks'] });

  const retryMutation = useMutation({
    mutationFn: (id: string) => apiRetryPostback(id),
    onSuccess: () => { invalidate(); toast({ title: t('affiliatesAdmin.pbRetryQueued') }); },
    onError,
  });

  const processMutation = useMutation({
    mutationFn: apiProcessPostbacks,
    onSuccess: (r) => {
      invalidate();
      toast({ title: t('affiliatesAdmin.pbProcessed', { delivered: r.delivered, failed: r.failed, skipped: r.skipped }) });
    },
    onError,
  });

  const rows = data?.rows || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast({ title: t('affiliatesAdmin.urlCopied') });
  };

  return (
    <div className="space-y-4">
      {/* Filters + actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={fAffiliate} onValueChange={(v) => { setFAffiliate(v); setPage(1); }}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('affiliatesAdmin.allAffiliatesFilter')}</SelectItem>
            {affiliates.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={fStatus} onValueChange={(v) => { setFStatus(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('affiliatesAdmin.allStatuses')}</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`affiliatesAdmin.pbStatus.${s}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={fEvent} onValueChange={(v) => { setFEvent(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('affiliatesAdmin.allEvents')}</SelectItem>
            {/* Raw event codes on purpose — they match the API/macro vocabulary. */}
            {EVENTS.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
        </Button>
        <div className="flex-1" />
        {isAdmin && (
          <Button variant="outline" className="gap-2" onClick={() => processMutation.mutate()} disabled={processMutation.isPending}>
            {processMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t('affiliatesAdmin.processNow')}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colTime')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colAffiliate')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colEvent')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colAttempts')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">HTTP</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colUrl')}</th>
                {isAdmin && <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colActions')}</th>}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={isAdmin ? 8 : 7} className="py-16 text-center"><Loader2 className="h-6 w-6 animate-spin text-primary inline-block" /></td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 8 : 7} className="p-0">
                    <EmptyState
                      icon={<Send className="h-5 w-5" />}
                      title={t('affiliatesAdmin.noPostbacks')}
                      description={t('affiliatesAdmin.noPostbacksDesc')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none py-8"
                    />
                  </td>
                </tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {formatSkopje(r.created_at, 'MMM d, HH:mm:ss')}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{r.affiliates?.code || '—'}</span>
                    {r.affiliate_leads?.ext_id && (
                      <p className="text-xs text-muted-foreground">{r.affiliate_leads.ext_id}</p>
                    )}
                  </td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-xs font-mono">{r.event}</Badge></td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={cn('text-xs', statusBadge[r.status])}>
                      {t(`affiliatesAdmin.pbStatus.${r.status}`)}
                    </Badge>
                    {r.last_error && <p className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[160px]" title={r.last_error}>{r.last_error}</p>}
                  </td>
                  <td className="px-4 py-3 text-center font-mono text-xs">{r.attempts}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {r.last_response_code ?? '—'}
                    {/* The partner's reply body decides success, not the HTTP
                        code — AlterCPA answers 200 with {"status":"error"}.
                        Showing it here is what makes a rejection visible
                        without going to the database. */}
                    {r.last_response_body && (
                      <p
                        className="text-[11px] text-muted-foreground mt-0.5 truncate max-w-[180px] font-normal"
                        title={r.last_response_body}
                      >
                        {r.last_response_body}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.rendered_url ? (
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono bg-muted px-2 py-1 rounded truncate max-w-[220px] block" title={r.rendered_url}>
                          {r.rendered_url}
                        </code>
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => copyUrl(r.rendered_url!)}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7" title={t('affiliatesAdmin.retry')}
                        onClick={() => retryMutation.mutate(r.id)}
                        disabled={retryMutation.isPending}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('affiliatesAdmin.pageOf', { page, pages, total })}</span>
          <SmartPagination page={page} totalPages={pages} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
