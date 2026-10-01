import { useState } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { apiGetInboundLeads, apiUpdateInboundLead, apiDeleteInboundLead } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Search, User, Clock, Trash2, CheckCircle2, XCircle, ShoppingCart, Globe } from 'lucide-react';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';

const STATUS_OPTIONS = ['pending', 'contacted', 'converted', 'rejected'] as const;
type InboundStatus = typeof STATUS_OPTIONS[number];

const STATUS_STYLES: Record<InboundStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-200',
  contacted: 'bg-blue-100 text-blue-800 border-blue-200',
  converted: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  rejected: 'bg-rose-100 text-rose-800 border-rose-200',
};

interface InboundLead {
  id: string;
  name: string;
  phone: string;
  status: InboundStatus;
  source: string;
  created_at: string;
  updated_at: string;
}

export default function InboundLeadsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending');

  const { data: leads = [], isLoading } = useQuery<InboundLead[]>({
    queryKey: ['inbound-leads', statusFilter],
    queryFn: () => apiGetInboundLeads(statusFilter),
    refetchInterval: 15000,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => apiUpdateInboundLead(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbound-leads'] });
      toast({ title: t('inbound.leadUpdated') });
    },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDeleteInboundLead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbound-leads'] });
      toast({ title: t('inbound.leadDeleted') });
    },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const convertToOrder = async (lead: InboundLead) => {
    try {
      // Orders are auto-created on lead ingestion; just navigate to the linked order
      await apiUpdateInboundLead(lead.id, { status: 'converted' });
      queryClient.invalidateQueries({ queryKey: ['inbound-leads'] });
      toast({ title: t('inbound.leadConverted') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const filtered = search.trim()
    ? leads.filter(l =>
        l.name.toLowerCase().includes(search.toLowerCase()) ||
        l.phone.includes(search)
      )
    : leads;

  const pendingCount = leads.filter(l => l.status === 'pending').length;

  if (isLoading) {
    return (
      <AppLayout title={t('nav.inboundLeads')}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.inboundLeads')}>
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500">
              <Clock className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('inbound.status.pending')}</p>
              <p className="text-xl font-bold">{pendingCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary">
              <User className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('inbound.totalLabel')}</p>
              <p className="text-xl font-bold">{leads.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500">
              <CheckCircle2 className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('inbound.status.converted')}</p>
              <p className="text-xl font-bold">{leads.filter(l => l.status === 'converted').length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500">
              <XCircle className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('inbound.status.rejected')}</p>
              <p className="text-xl font-bold">{leads.filter(l => l.status === 'rejected').length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={t('inbound.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 pl-8 text-sm rounded-lg"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 h-9 text-sm rounded-lg">
            <SelectValue placeholder={t('inbound.allStatuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('inbound.allStatuses')}</SelectItem>
            {STATUS_OPTIONS.map(s => (
              <SelectItem key={s} value={s}>{t(`inbound.status.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{t('historyDialog.nLeads', { count: filtered.length })}</span>
      </div>

      {/* Table — desktop */}
      <div className="hidden md:block rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('search.name')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('search.phone')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('ordersPage.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('ordersPage.colSource')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('inbound.colReceived')}</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(lead => (
                <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{lead.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{lead.phone}</td>
                  <td className="px-4 py-3 text-xs">
                    {(lead as any).product_name ? (
                      <Badge variant="outline" className="text-xs">{(lead as any).product_name}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={lead.status}
                      onValueChange={val => updateMutation.mutate({ id: lead.id, body: { status: val } })}
                    >
                      <SelectTrigger className={cn('h-7 w-28 text-xs rounded-full border', STATUS_STYLES[lead.status])}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map(s => (
                          <SelectItem key={s} value={s} className="text-xs">{t(`inbound.status.${s}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{lead.source}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {formatDate(lead.created_at, 'MMM d, HH:mm')}
                  </td>
                  <td className="px-4 py-3 text-right flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-primary hover:bg-primary/10"
                      title={t('inbound.convertToOrder')}
                      onClick={() => convertToOrder(lead)}
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:bg-destructive/10"
                      onClick={() => deleteMutation.mutate(lead.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={<Globe className="h-5 w-5" />}
                      title={t('inbound.noLeads')}
                      description={t('inbound.noLeadsDesc')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none py-8"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cards — mobile */}
      <div className="md:hidden space-y-2">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Globe className="h-5 w-5" />}
            title={t('inbound.noLeads')}
            description={t('inbound.noLeadsDesc')}
            size="sm"
          />
        ) : filtered.map(lead => (
          <MobileCard key={lead.id}>
            <MobileCardHeader
              title={lead.name}
              subtitle={lead.phone}
              badge={(lead as any).product_name
                ? <Badge variant="outline" className="text-xs">{(lead as any).product_name}</Badge>
                : undefined}
            />
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground shrink-0">{t('ordersPage.colStatus')}</span>
              <Select value={lead.status} onValueChange={val => updateMutation.mutate({ id: lead.id, body: { status: val } })}>
                <SelectTrigger className={cn('h-7 w-32 text-xs rounded-full border', STATUS_STYLES[lead.status])}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map(s => (
                    <SelectItem key={s} value={s} className="text-xs">{t(`inbound.status.${s}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <MobileCardField label={t('ordersPage.colSource')} value={lead.source} />
            <MobileCardField label={t('inbound.colReceived')} value={formatDate(lead.created_at, 'MMM d, HH:mm')} />
            <MobileCardActions>
              <Button variant="outline" size="sm" className="gap-1.5 text-primary" onClick={() => convertToOrder(lead)}>
                <ShoppingCart className="h-3.5 w-3.5" /> {t('inbound.convert')}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 text-destructive" onClick={() => deleteMutation.mutate(lead.id)}>
                <Trash2 className="h-3.5 w-3.5" /> {t('inbound.delete')}
              </Button>
            </MobileCardActions>
          </MobileCard>
        ))}
      </div>

    </AppLayout>
  );
}
