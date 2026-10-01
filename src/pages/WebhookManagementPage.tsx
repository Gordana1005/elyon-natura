import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { apiGetWebhooks, apiCreateWebhook, apiUpdateWebhook, apiDeleteWebhook, apiGetAdsCampaigns, apiCreateAdsCampaign, apiUpdateAdsCampaign, apiDeleteAdsCampaign } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogTrigger, DialogClose,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus, Copy, Pencil, Trash2, Loader2, Webhook, CheckCircle2, XCircle, Globe,
  Megaphone, Play, Pause, Banknote, MousePointerClick, Target, Search,
  ChevronDown, ChevronRight, BarChart3,
} from 'lucide-react';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import { formatDayDmy } from '@/i18n/dates';
import { denToEur, formatMoney } from '@/lib/currency';
import { EmptyState } from '@/components/EmptyState';

/* ── Types ── */
interface WebhookItem {
  id: string;
  product_name: string;
  description: string;
  slug: string;
  status: string;
  created_at: string;
  total_leads: number;
}

interface Campaign {
  id: string;
  campaign_name: string;
  platform: string;
  status: string;
  budget: number;
  spent: number;
  impressions: number;
  clicks: number;
  conversions: number;
  assigned_products: string[];
  assigned_leads: string[];
  notes: string;
  created_at: string;
  updated_at: string;
}

/* ── Constants ── */
const PLATFORMS = ['meta', 'google', 'tiktok'] as const;
const STATUSES = ['active', 'paused', 'completed', 'draft'] as const;

const platformColors: Record<string, string> = {
  meta: 'bg-blue-500/10 text-blue-600 border-blue-200',
  google: 'bg-red-500/10 text-red-600 border-red-200',
  tiktok: 'bg-pink-500/10 text-pink-600 border-pink-200',
};
const statusColors: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
  paused: 'bg-amber-500/10 text-amber-600 border-amber-200',
  completed: 'bg-muted text-muted-foreground border-border',
  draft: 'bg-slate-500/10 text-slate-600 border-slate-200',
};

/* ================================================================ */
/*  WEBHOOKS TAB                                                     */
/* ================================================================ */
function WebhooksTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editWebhook, setEditWebhook] = useState<WebhookItem | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStatus, setFormStatus] = useState('active');

  const { data: webhooks = [], isLoading } = useQuery<WebhookItem[]>({
    queryKey: ['webhooks'],
    queryFn: apiGetWebhooks,
  });

  const createMutation = useMutation({
    mutationFn: (body: { product_name: string; description?: string }) => apiCreateWebhook(body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['webhooks'] }); setCreateOpen(false); setFormName(''); setFormDesc(''); toast({ title: t('webhooks.created') }); },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => apiUpdateWebhook(id, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['webhooks'] }); setEditWebhook(null); toast({ title: t('webhooks.updated') }); },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDeleteWebhook(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['webhooks'] }); setDeleteId(null); toast({ title: t('webhooks.deleted') }); },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  const getWebhookUrl = (slug: string) =>
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api/webhook/${slug}`;

  const copyUrl = (slug: string) => {
    navigator.clipboard.writeText(getWebhookUrl(slug));
    toast({ title: t('webhooks.urlCopied') });
  };

  const openEdit = (wh: WebhookItem) => {
    setEditWebhook(wh); setFormName(wh.product_name); setFormDesc(wh.description || ''); setFormStatus(wh.status);
  };

  const handleCreate = () => { if (!formName.trim()) return; createMutation.mutate({ product_name: formName.trim(), description: formDesc.trim() }); };
  const handleUpdate = () => { if (!editWebhook || !formName.trim()) return; updateMutation.mutate({ id: editWebhook.id, body: { product_name: formName.trim(), description: formDesc.trim(), status: formStatus } }); };

  const activeCount = webhooks.filter(w => w.status === 'active').length;
  const totalLeads = webhooks.reduce((s, w) => s + (w.total_leads || 0), 0);

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary"><Webhook className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('webhooks.total')}</p><p className="text-xl font-bold">{webhooks.length}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--success))]"><CheckCircle2 className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('webhooks.summaryActive')}</p><p className="text-xl font-bold">{activeCount}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--warning))]"><XCircle className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('webhooks.disabled')}</p><p className="text-xl font-bold">{webhooks.length - activeCount}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--info))]"><Globe className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('webhooks.totalLeads')}</p><p className="text-xl font-bold">{totalLeads}</p></div></CardContent></Card>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('webhooks.allWebhooks')}</h2>
        <Button onClick={() => { setFormName(''); setFormDesc(''); setCreateOpen(true); }} className="gap-2"><Plus className="h-4 w-4" /> {t('webhooks.createNew')}</Button>
      </div>

      {/* Webhooks table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colProductName')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colUrl')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colLeads')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colCreated')}</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t('webhooks.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map(wh => (
                <tr key={wh.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3"><div><span className="font-medium">{wh.product_name}</span>{wh.description && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">{wh.description}</p>}</div></td>
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><code className="text-xs font-mono bg-muted px-2 py-1 rounded truncate max-w-[280px] block">{getWebhookUrl(wh.slug)}</code><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copyUrl(wh.slug)}><Copy className="h-3.5 w-3.5" /></Button></div></td>
                  <td className="px-4 py-3"><Badge variant={wh.status === 'active' ? 'default' : 'secondary'} className={cn('text-xs', wh.status === 'active' ? 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30' : 'bg-muted text-muted-foreground')}>{wh.status === 'active' ? t('webhooks.statusActive') : t('webhooks.statusDisabled')}</Badge></td>
                  <td className="px-4 py-3 font-semibold">{wh.total_leads || 0}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{formatSkopje(wh.created_at, 'MMM d, yyyy')}</td>
                  <td className="px-4 py-3 text-right"><div className="flex items-center justify-end gap-1"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(wh)}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:bg-destructive/10" onClick={() => setDeleteId(wh.id)}><Trash2 className="h-3.5 w-3.5" /></Button></div></td>
                </tr>
              ))}
              {webhooks.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-0">
                    <EmptyState
                      icon={<Webhook className="h-5 w-5" />}
                      title={t('webhooks.noWebhooks')}
                      description={t('webhooks.noWebhooksDesc')}
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

      {/* Usage info */}
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">{t('webhooks.howToUse')}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('webhooks.sendPost')}</p>
          <pre className="rounded-lg bg-muted p-3 text-xs font-mono">{`{\n  "name": "John Doe",\n  "phone": "+1234567890"\n}`}</pre>
          <p className="text-xs text-muted-foreground">
            {t('webhooks.headersLabel')} <code className="bg-muted px-1 rounded">Content-Type: application/json</code>,{' '}
            <code className="bg-muted px-1 rounded">apikey: {import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}</code>
          </p>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('webhooks.createNew')}</DialogTitle><DialogDescription>{t('webhooks.createDesc')}</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div><Label>{t('webhooks.colProductName')}</Label><Input value={formName} onChange={e => setFormName(e.target.value)} placeholder={t('webhooks.namePlaceholder')} className="mt-1" /></div>
            <div><Label>{t('webhooks.descOptional')}</Label><Textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder={t('webhooks.descPlaceholder')} className="mt-1" rows={3} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleCreate} disabled={!formName.trim() || createMutation.isPending}>{createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{t('webhooks.createWebhookBtn')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editWebhook} onOpenChange={() => setEditWebhook(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('webhooks.editWebhook')}</DialogTitle><DialogDescription>{t('webhooks.editDesc')}</DialogDescription></DialogHeader>
          <div className="space-y-4">
            <div><Label>{t('webhooks.colProductName')}</Label><Input value={formName} onChange={e => setFormName(e.target.value)} className="mt-1" /></div>
            <div><Label>{t('webhooks.description')}</Label><Textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} className="mt-1" rows={3} /></div>
            <div className="flex items-center justify-between"><Label>{t('webhooks.switchActive')}</Label><Switch checked={formStatus === 'active'} onCheckedChange={v => setFormStatus(v ? 'active' : 'disabled')} /></div>
            {editWebhook && <div><Label className="text-xs text-muted-foreground">{t('webhooks.colUrl')}</Label><div className="flex items-center gap-2 mt-1"><code className="text-xs font-mono bg-muted px-2 py-1.5 rounded flex-1 truncate">{getWebhookUrl(editWebhook.slug)}</code><Button variant="outline" size="sm" onClick={() => copyUrl(editWebhook.slug)}><Copy className="h-3.5 w-3.5" /></Button></div></div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditWebhook(null)}>{t('common.cancel')}</Button>
            <Button onClick={handleUpdate} disabled={!formName.trim() || updateMutation.isPending}>{updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}{t('webhooks.saveChanges')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{t('webhooks.deleteTitle')}</AlertDialogTitle><AlertDialogDescription>{t('webhooks.deleteDesc')}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteId && deleteMutation.mutate(deleteId)}>{t('common.delete')}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ================================================================ */
/*  ADS TAB                                                          */
/* ================================================================ */
function AdsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ campaign_name: '', platform: 'meta', budget: '', notes: '' });

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['ads-campaigns', platformFilter, statusFilter, search],
    queryFn: () => apiGetAdsCampaigns({ platform: platformFilter !== 'all' ? platformFilter : undefined, status: statusFilter !== 'all' ? statusFilter : undefined, search: search || undefined }),
  });

  const createMutation = useMutation({
    mutationFn: apiCreateAdsCampaign,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ads-campaigns'] }); setCreateOpen(false); setForm({ campaign_name: '', platform: 'meta', budget: '', notes: '' }); toast({ title: t('webhooks.campaignCreated') }); },
    onError: (e: any) => toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: any) => apiUpdateAdsCampaign(id, body),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ads-campaigns'] }); toast({ title: t('webhooks.campaignUpdated') }); },
  });

  const deleteMutation = useMutation({
    mutationFn: apiDeleteAdsCampaign,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ads-campaigns'] }); toast({ title: t('webhooks.campaignDeleted') }); },
  });

  const toggleStatus = (c: Campaign) => {
    updateMutation.mutate({ id: c.id, status: c.status === 'active' ? 'paused' : 'active' });
  };

  const totalCampaigns = campaigns.length;
  const activeCampaigns = campaigns.filter((c: Campaign) => c.status === 'active').length;
  const pausedCampaigns = campaigns.filter((c: Campaign) => c.status === 'paused').length;
  const totalSpend = campaigns.reduce((s: number, c: Campaign) => s + Number(c.spent || 0), 0);
  const totalClicks = campaigns.reduce((s: number, c: Campaign) => s + (c.clicks || 0), 0);
  const totalConversions = campaigns.reduce((s: number, c: Campaign) => s + (c.conversions || 0), 0);

  const statsCards = [
    { labelKey: 'webhooks.totalCampaigns', value: totalCampaigns, icon: Megaphone, color: 'text-primary' },
    { labelKey: 'webhooks.summaryActive', value: activeCampaigns, icon: Play, color: 'text-emerald-500' },
    { labelKey: 'webhooks.paused', value: pausedCampaigns, icon: Pause, color: 'text-amber-500' },
    { labelKey: 'webhooks.totalSpend', value: formatMoney(totalSpend), icon: Banknote, color: 'text-blue-500' },
    { labelKey: 'webhooks.totalClicks', value: totalClicks.toLocaleString(), icon: MousePointerClick, color: 'text-violet-500' },
    { labelKey: 'webhooks.conversions', value: totalConversions.toLocaleString(), icon: Target, color: 'text-rose-500' },
  ];

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{t('webhooks.manageAds')}</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> {t('webhooks.newCampaign')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('webhooks.createCampaign')}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div><Label>{t('webhooks.campaignName')}</Label><Input value={form.campaign_name} onChange={e => setForm(f => ({ ...f, campaign_name: e.target.value }))} placeholder="Spring Sale 2026" /></div>
              <div><Label>{t('webhooks.platform')}</Label><Select value={form.platform} onValueChange={v => setForm(f => ({ ...f, platform: v }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>)}</SelectContent></Select></div>
              <div><Label>{t('webhooks.budgetUsd')}</Label><Input type="number" min={0} step="1" value={form.budget} onChange={e => setForm(f => ({ ...f, budget: e.target.value }))} placeholder="60000" /></div>
              <div><Label>{t('webhooks.notes')}</Label><Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder={t('webhooks.notesPh')} /></div>
            </div>
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">{t('common.cancel')}</Button></DialogClose>
              <Button onClick={() => createMutation.mutate({ campaign_name: form.campaign_name, platform: form.platform, budget: denToEur(Number(form.budget) || 0), notes: form.notes })} disabled={!form.campaign_name || createMutation.isPending}>{t('webhooks.create')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {statsCards.map(s => (
          <Card key={s.labelKey} className="border-border/50 shadow-sm">
            <CardContent className="flex items-center gap-3 p-4">
              <div className={`rounded-lg bg-muted p-2 ${s.color}`}><s.icon className="h-4 w-4" /></div>
              <div><p className="text-xs text-muted-foreground">{t(s.labelKey)}</p><p className="text-lg font-bold text-foreground">{s.value}</p></div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder={t('webhooks.searchCampaigns')} value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="w-[140px]"><SelectValue placeholder={t('webhooks.platform')} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('webhooks.allPlatforms')}</SelectItem>{PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p.charAt(0).toUpperCase() + p.slice(1)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px]"><SelectValue placeholder={t('webhooks.colStatus')} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t('webhooks.allStatus')}</SelectItem>{STATUSES.map(s => <SelectItem key={s} value={s}>{t('webhooks.cs.' + s)}</SelectItem>)}</SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Campaigns Table */}
      <Card className="border-border/50 shadow-sm overflow-hidden">
        <ScrollArea className="max-h-[calc(100vh-420px)]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/50 backdrop-blur-sm border-b border-border">
              <tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <th className="p-3 w-8"><span className="sr-only">{t('webhooks.expand')}</span></th>
                <th className="p-3">{t('webhooks.colCampaign')}</th>
                <th className="p-3">{t('webhooks.colPlatform')}</th>
                <th className="p-3">{t('webhooks.colStatus')}</th>
                <th className="p-3 text-right">{t('webhooks.colBudget')}</th>
                <th className="p-3 text-right">{t('webhooks.colSpent')}</th>
                <th className="p-3 text-right">{t('webhooks.colClicks')}</th>
                <th className="p-3 text-right">{t('webhooks.colConv')}</th>
                <th className="p-3 text-right">{t('webhooks.colCtr')}</th>
                <th className="p-3 text-center">{t('webhooks.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-0">
                    <EmptyState
                      icon={<Megaphone className="h-5 w-5" />}
                      title={t('webhooks.noCampaigns')}
                      description={t('webhooks.noCampaignsDesc')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none py-6"
                    />
                  </td>
                </tr>
              ) : (
                campaigns.map((c: Campaign) => {
                  const ctr = c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) : '0.00';
                  const isExpanded = expandedRow === c.id;
                  return (
                    <> 
                      <tr key={c.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setExpandedRow(isExpanded ? null : c.id)}>
                        <td className="p-3">{isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}</td>
                        <td className="p-3 font-medium text-foreground">{c.campaign_name}</td>
                        <td className="p-3"><Badge variant="outline" className={`capitalize text-[11px] ${platformColors[c.platform] || ''}`}>{c.platform}</Badge></td>
                        <td className="p-3"><Badge variant="outline" className={`capitalize text-[11px] ${statusColors[c.status] || ''}`}>{t('webhooks.cs.' + c.status)}</Badge></td>
                        <td className="p-3 text-right font-mono">{formatMoney(c.budget)}</td>
                        <td className="p-3 text-right font-mono">{formatMoney(c.spent)}</td>
                        <td className="p-3 text-right font-mono">{c.clicks.toLocaleString()}</td>
                        <td className="p-3 text-right font-mono">{c.conversions.toLocaleString()}</td>
                        <td className="p-3 text-right font-mono">{ctr}%</td>
                        <td className="p-3 text-center" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => toggleStatus(c)} title={c.status === 'active' ? t('webhooks.pause') : t('webhooks.resume')}>
                              {c.status === 'active' ? <Pause className="h-3.5 w-3.5 text-amber-500" /> : <Play className="h-3.5 w-3.5 text-emerald-500" />}
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => { if (confirm(t('webhooks.deleteCampaignConfirm'))) deleteMutation.mutate(c.id); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${c.id}-detail`} className="bg-muted/20">
                          <td colSpan={10} className="p-4">
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('webhooks.performance')}</h4>
                                <div className="space-y-1 text-sm">
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.impressions')}</span><span className="font-mono">{c.impressions.toLocaleString()}</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.clicks')}</span><span className="font-mono">{c.clicks.toLocaleString()}</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.conversions')}</span><span className="font-mono">{c.conversions.toLocaleString()}</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.colCtr')}</span><span className="font-mono">{ctr}%</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.cpc')}</span><span className="font-mono">{formatMoney(c.clicks > 0 ? Number(c.spent) / c.clicks : 0)}</span></div>
                                </div>
                              </div>
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('webhooks.budget')}</h4>
                                <div className="space-y-1 text-sm">
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.totalBudget')}</span><span className="font-mono">{formatMoney(c.budget)}</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.spent')}</span><span className="font-mono">{formatMoney(c.spent)}</span></div>
                                  <div className="flex justify-between"><span className="text-muted-foreground">{t('webhooks.remaining')}</span><span className="font-mono">{formatMoney(Number(c.budget) - Number(c.spent))}</span></div>
                                </div>
                                <div className="mt-2">
                                  <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min((Number(c.spent) / Math.max(Number(c.budget), 1)) * 100, 100)}%` }} /></div>
                                  <p className="mt-1 text-xs text-muted-foreground">{t('webhooks.utilized', { pct: ((Number(c.spent) / Math.max(Number(c.budget), 1)) * 100).toFixed(1) })}</p>
                                </div>
                              </div>
                              <div className="space-y-2">
                                <h4 className="text-xs font-semibold uppercase text-muted-foreground">{t('webhooks.notes')}</h4>
                                <p className="text-sm text-muted-foreground">{c.notes || t('webhooks.noNotes')}</p>
                                <p className="text-xs text-muted-foreground mt-2">{t('webhooks.createdAt', { date: formatDayDmy(c.created_at) })}</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </ScrollArea>
      </Card>
    </div>
  );
}

/* ================================================================ */
/*  MAIN PAGE                                                        */
/* ================================================================ */
export default function WebhookManagementPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canSeeAds = user?.isAdsAdmin || user?.isAdmin;

  return (
    <AppLayout title={t('nav.webhooksAds')}>
      <Tabs defaultValue="webhooks" className="space-y-6">
        <TabsList>
          <TabsTrigger value="webhooks" className="gap-2">
            <Webhook className="h-4 w-4" /> {t('webhooks.tabWebhooks')}
          </TabsTrigger>
          {canSeeAds && (
            <TabsTrigger value="ads" className="gap-2">
              <BarChart3 className="h-4 w-4" /> {t('webhooks.tabAds')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="webhooks">
          <WebhooksTab />
        </TabsContent>

        {canSeeAds && (
          <TabsContent value="ads">
            <AdsTab />
          </TabsContent>
        )}
      </Tabs>
    </AppLayout>
  );
}
