import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiGetAffiliates, apiCreateAffiliate, apiUpdateAffiliate, apiRotateAffiliateKey,
  apiGetAffiliateStats, apiGetAffiliateOffers, apiGetOffers,
  apiApproveAffiliateOffer, apiUpdateAffiliateOffer, apiDeleteAffiliateOffer,
  AffiliateAdmin,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { formatEurExact } from '@/lib/currency';
import { approveRatePct, buyoutRatePct } from './affiliateStage';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Plus, Copy, Pencil, Loader2, Handshake, KeyRound, BarChart3, PackageCheck,
  CheckCircle2, Banknote,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';

const statusBadge: Record<string, string> = {
  active: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  paused: 'bg-amber-500/10 text-amber-600 border-amber-200',
  banned: 'bg-destructive/10 text-destructive border-destructive/30',
};

const maskKey = (key?: string) => (key ? `${key.slice(0, 8)}…${key.slice(-6)}` : '');

export function AffiliatesTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editAff, setEditAff] = useState<AffiliateAdmin | null>(null);
  const [offersAff, setOffersAff] = useState<AffiliateAdmin | null>(null);
  const [statsAff, setStatsAff] = useState<AffiliateAdmin | null>(null);
  const [rotateAff, setRotateAff] = useState<AffiliateAdmin | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  // Create form
  const [fName, setFName] = useState('');
  const [fCode, setFCode] = useState('');
  const [fContact, setFContact] = useState('');
  const [fNotes, setFNotes] = useState('');
  const [fWithLogin, setFWithLogin] = useState(false);
  const [fEmail, setFEmail] = useState('');
  const [fPassword, setFPassword] = useState('');
  // Edit form
  const [eName, setEName] = useState('');
  const [eContact, setEContact] = useState('');
  const [eNotes, setENotes] = useState('');
  const [eStatus, setEStatus] = useState('active');

  const { data: affiliates = [], isLoading } = useQuery<AffiliateAdmin[]>({
    queryKey: ['affiliates'],
    queryFn: apiGetAffiliates,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['affiliates'] });
  const onError = (err: any) =>
    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });

  const createMutation = useMutation({
    mutationFn: () => apiCreateAffiliate({
      name: fName.trim(),
      code: fCode.trim().toLowerCase(),
      contact: fContact.trim(),
      notes: fNotes.trim(),
      ...(fWithLogin ? { create_login: { email: fEmail.trim(), password: fPassword } } : {}),
    }),
    onSuccess: () => {
      invalidate(); setCreateOpen(false);
      setFName(''); setFCode(''); setFContact(''); setFNotes('');
      setFWithLogin(false); setFEmail(''); setFPassword('');
      toast({ title: t('affiliatesAdmin.created') });
    },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: () => apiUpdateAffiliate(editAff!.id, {
      name: eName.trim(), contact: eContact.trim(), notes: eNotes.trim(), status: eStatus,
    }),
    onSuccess: () => { invalidate(); setEditAff(null); toast({ title: t('affiliatesAdmin.updated') }); },
    onError,
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => apiRotateAffiliateKey(id),
    onSuccess: (res) => { invalidate(); setRotatedKey(res.api_key); },
    onError,
  });

  const copy = (text: string, msg: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: msg });
  };

  const openEdit = (a: AffiliateAdmin) => {
    setEditAff(a); setEName(a.name); setEContact(a.contact || '');
    setENotes(a.notes || ''); setEStatus(a.status);
  };

  const totals = affiliates.reduce(
    (s, a) => ({
      sent: s.sent + a.stats.sent,
      paid: s.paid + a.stats.paid,
      earned: s.earned + a.stats.payout_earned,
      failed: s.failed + a.postbacks.failed,
    }),
    { sent: 0, paid: 0, earned: 0, failed: 0 },
  );

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary"><Handshake className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.totalAffiliates')}</p><p className="text-xl font-bold">{affiliates.length}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--info))]"><PackageCheck className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.leadsSent')}</p><p className="text-xl font-bold">{totals.sent}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--success))]"><CheckCircle2 className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.paidBuyout')}</p><p className="text-xl font-bold">{totals.paid}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--warning))]"><Banknote className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.payoutEarned')}</p><p className="text-lg font-bold">{formatEurExact(totals.earned)}</p></div></CardContent></Card>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('affiliatesAdmin.allAffiliates')}</h2>
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> {t('affiliatesAdmin.createNew')}
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colAffiliate')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colLeads')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colPayout')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colPostbacks')}</th>
                {isAdmin && <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colApiKey')}</th>}
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {affiliates.map((a) => (
                <tr key={a.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <span className="font-medium">{a.name}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <code className="font-mono">{a.code}</code>
                        {a.contact ? ` · ${a.contact}` : ''}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={cn('text-xs', statusBadge[a.status])}>
                      {t(`affiliatesAdmin.status.${a.status}`)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold">{a.stats.sent}</span>
                    <span className="text-xs text-muted-foreground ml-1.5">
                      {t('affiliatesAdmin.leadsBreakdown', { approved: a.stats.approved, paid: a.stats.paid })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {/* EUR, not денари — affiliate payout is a euro obligation
                        to the webmaster (see the note in AffiliateDashboardPage). */}
                    <span className="font-semibold">{formatEurExact(a.stats.payout_earned)}</span>
                  </td>
                  <td className="px-4 py-3">
                    {a.postbacks.failed > 0 ? (
                      <Badge variant="outline" className="text-xs bg-destructive/10 text-destructive border-destructive/30">
                        {t('affiliatesAdmin.pbFailed', { count: a.postbacks.failed })}
                      </Badge>
                    ) : a.postbacks.pending > 0 ? (
                      <Badge variant="outline" className="text-xs bg-amber-500/10 text-amber-600 border-amber-200">
                        {t('affiliatesAdmin.pbPending', { count: a.postbacks.pending })}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('affiliatesAdmin.pbOk')}</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono bg-muted px-2 py-1 rounded">{maskKey(a.api_key)}</code>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copy(a.api_key || '', t('affiliatesAdmin.keyCopied'))}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" title={t('affiliatesAdmin.rotateKey')} onClick={() => { setRotatedKey(null); setRotateAff(a); }}>
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title={t('affiliatesAdmin.stats')} onClick={() => setStatsAff(a)}>
                        <BarChart3 className="h-3.5 w-3.5" />
                      </Button>
                      {isAdmin && (
                        <>
                          <Button variant="ghost" size="icon" className="h-7 w-7" title={t('affiliatesAdmin.offers')} onClick={() => setOffersAff(a)}>
                            <PackageCheck className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(a)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {affiliates.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="p-0">
                    <EmptyState
                      icon={<Handshake className="h-5 w-5" />}
                      title={t('affiliatesAdmin.noAffiliates')}
                      description={t('affiliatesAdmin.noAffiliatesDesc')}
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

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('affiliatesAdmin.createTitle')}</DialogTitle>
            <DialogDescription>{t('affiliatesAdmin.createDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldName')}</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Ivan Petrov / MediaBuy Ltd" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldCode')}</Label>
              <Input value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="ivan1" />
              <p className="text-xs text-muted-foreground">{t('affiliatesAdmin.fieldCodeHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldContact')}</Label>
              <Input value={fContact} onChange={(e) => setFContact(e.target.value)} placeholder="@telegram / email" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldNotes')}</Label>
              <Textarea value={fNotes} onChange={(e) => setFNotes(e.target.value)} rows={2} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">{t('affiliatesAdmin.withLogin')}</p>
                <p className="text-xs text-muted-foreground">{t('affiliatesAdmin.withLoginDesc')}</p>
              </div>
              <Switch checked={fWithLogin} onCheckedChange={setFWithLogin} />
            </div>
            {fWithLogin && (
              <>
                <div className="space-y-1.5">
                  <Label>{t('affiliatesAdmin.fieldEmail')}</Label>
                  <Input type="email" value={fEmail} onChange={(e) => setFEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('affiliatesAdmin.fieldPassword')}</Label>
                  <Input type="text" value={fPassword} onChange={(e) => setFPassword(e.target.value)} />
                  <p className="text-xs text-muted-foreground">{t('affiliatesAdmin.fieldPasswordHint')}</p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!fName.trim() || !fCode.trim() || (fWithLogin && (!fEmail.trim() || fPassword.length < 8)) || createMutation.isPending}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editAff} onOpenChange={(o) => !o && setEditAff(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('affiliatesAdmin.editTitle', { name: editAff?.name })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldName')}</Label>
              <Input value={eName} onChange={(e) => setEName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldContact')}</Label>
              <Input value={eContact} onChange={(e) => setEContact(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldNotes')}</Label>
              <Textarea value={eNotes} onChange={(e) => setENotes(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.colStatus')}</Label>
              <Select value={eStatus} onValueChange={setEStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('affiliatesAdmin.status.active')}</SelectItem>
                  <SelectItem value="paused">{t('affiliatesAdmin.status.paused')}</SelectItem>
                  <SelectItem value="banned">{t('affiliatesAdmin.status.banned')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditAff(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => updateMutation.mutate()} disabled={!eName.trim() || updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate key confirm + result */}
      <AlertDialog open={!!rotateAff} onOpenChange={(o) => { if (!o) { setRotateAff(null); setRotatedKey(null); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('affiliatesAdmin.rotateTitle', { name: rotateAff?.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {rotatedKey ? t('affiliatesAdmin.rotateDone') : t('affiliatesAdmin.rotateWarning')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rotatedKey && (
            <div className="flex items-center gap-2">
              <code className="text-xs font-mono bg-muted px-2 py-1.5 rounded flex-1 break-all">{rotatedKey}</code>
              <Button variant="outline" size="icon" className="shrink-0" onClick={() => copy(rotatedKey, t('affiliatesAdmin.keyCopied'))}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
          <AlertDialogFooter>
            {rotatedKey ? (
              <AlertDialogAction onClick={() => { setRotateAff(null); setRotatedKey(null); }}>
                {t('common.close')}
              </AlertDialogAction>
            ) : (
              <>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); rotateMutation.mutate(rotateAff!.id); }}
                  disabled={rotateMutation.isPending}
                >
                  {rotateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  {t('affiliatesAdmin.rotateConfirm')}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {offersAff && <OffersApprovalDialog affiliate={offersAff} onClose={() => setOffersAff(null)} />}
      {statsAff && <StatsDialog affiliate={statsAff} onClose={() => setStatsAff(null)} />}
    </div>
  );
}

/* ── Per-affiliate offer approvals ── */
function OffersApprovalDialog({ affiliate, onClose }: { affiliate: AffiliateAdmin; onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const { data: approvals = [], isLoading: loadingApprovals } = useQuery({
    queryKey: ['affiliate-offers', affiliate.id],
    queryFn: () => apiGetAffiliateOffers(affiliate.id),
  });
  const { data: offers = [], isLoading: loadingOffers } = useQuery({
    queryKey: ['offers'],
    queryFn: apiGetOffers,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['affiliate-offers', affiliate.id] });
  const onError = (err: any) =>
    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });

  const approveMutation = useMutation({
    mutationFn: ({ offerId, override }: { offerId: string; override: number | null }) =>
      apiApproveAffiliateOffer(affiliate.id, { offer_id: offerId, payout_override_eur: override }),
    onSuccess: () => { invalidate(); toast({ title: t('affiliatesAdmin.offerApproved') }); },
    onError,
  });
  const revokeMutation = useMutation({
    mutationFn: (approvalId: string) => apiDeleteAffiliateOffer(approvalId),
    onSuccess: () => { invalidate(); toast({ title: t('affiliatesAdmin.offerRevoked') }); },
    onError,
  });
  const pauseMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'paused' }) =>
      apiUpdateAffiliateOffer(id, { status }),
    onSuccess: () => invalidate(),
    onError,
  });

  const approvalByOffer = new Map(approvals.map((ap) => [ap.offer_id, ap]));
  const loading = loadingApprovals || loadingOffers;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('affiliatesAdmin.offersTitle', { name: affiliate.name })}</DialogTitle>
          <DialogDescription>{t('affiliatesAdmin.offersDesc')}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto space-y-2 pr-1">
            {offers.filter((o) => o.is_active || approvalByOffer.has(o.id)).map((o) => {
              const ap = approvalByOffer.get(o.id);
              const overrideValue = overrides[o.id] ?? (ap?.payout_override_eur != null ? String(ap.payout_override_eur) : '');
              return (
                <div key={o.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{o.name} <span className="text-xs text-muted-foreground">[{o.geo}]</span></p>
                    <p className="text-xs text-muted-foreground">{t('affiliatesAdmin.basePayout')}: {formatEurExact(o.payout_eur)}</p>
                    {ap?.status === 'paused' && (
                      <Badge variant="outline" className="mt-1 text-xs bg-amber-500/10 text-amber-600 border-amber-200">
                        {t('affiliatesAdmin.approvalPaused')}
                      </Badge>
                    )}
                  </div>
                  {ap && (
                    <div className="w-32">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder={String(o.payout_eur)}
                        value={overrideValue}
                        onChange={(e) => setOverrides((prev) => ({ ...prev, [o.id]: e.target.value }))}
                        onBlur={() => {
                          const raw = overrides[o.id];
                          if (raw === undefined) return;
                          const num = raw === '' ? null : Number(raw);
                          if (num !== null && (!Number.isFinite(num) || num < 0)) return;
                          approveMutation.mutate({ offerId: o.id, override: num });
                        }}
                        className="h-8 text-sm"
                      />
                      <p className="text-[10px] text-muted-foreground mt-0.5">{t('affiliatesAdmin.overrideHint')}</p>
                    </div>
                  )}
                  {ap ? (
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" className="h-8 text-xs"
                        onClick={() => pauseMutation.mutate({ id: ap.id, status: ap.status === 'paused' ? 'approved' : 'paused' })}>
                        {ap.status === 'paused' ? t('affiliatesAdmin.resume') : t('affiliatesAdmin.pause')}
                      </Button>
                      <Button variant="outline" size="sm" className="h-8 text-xs text-destructive hover:bg-destructive/10"
                        onClick={() => revokeMutation.mutate(ap.id)}>
                        {t('affiliatesAdmin.revoke')}
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" className="h-8 text-xs"
                      disabled={approveMutation.isPending}
                      onClick={() => approveMutation.mutate({ offerId: o.id, override: null })}>
                      {t('affiliatesAdmin.approve')}
                    </Button>
                  )}
                </div>
              );
            })}
            {offers.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">{t('affiliatesAdmin.noOffersYet')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Per-affiliate stats (last 30 days) ── */
function StatsDialog({ affiliate, onClose }: { affiliate: AffiliateAdmin; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['affiliate-stats', affiliate.id],
    queryFn: () => apiGetAffiliateStats(affiliate.id),
  });

  const totals = data?.totals;
  const approveRate = approveRatePct(totals);
  const buyoutRate = buyoutRatePct(totals);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('affiliatesAdmin.statsTitle', { name: affiliate.name })}</DialogTitle>
          <DialogDescription>{t('affiliatesAdmin.statsDesc')}</DialogDescription>
        </DialogHeader>
        {isLoading || !totals ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
              {[
                { label: t('affiliatesAdmin.stSent'), value: totals.sent },
                { label: t('affiliatesAdmin.stHold'), value: totals.approved },
                { label: t('affiliatesAdmin.stPaid'), value: totals.paid },
                { label: t('affiliatesAdmin.stCancelled'), value: totals.cancelled + totals.trashed },
                { label: t('affiliatesAdmin.stApproveRate'), value: `${approveRate}%` },
                { label: t('affiliatesAdmin.stBuyoutRate'), value: `${buyoutRate}%` },
              ].map((s, i) => (
                <div key={i} className="rounded-lg border bg-muted/20 px-2 py-3">
                  <p className="text-lg font-bold">{s.value}</p>
                  <p className="text-[11px] text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            {/* "Payout on hold" is gone by design: earned-at-confirmation
                leaves nothing on hold. */}
            <div className="flex items-center justify-between rounded-lg border p-3 text-sm">
              <span className="text-muted-foreground">{t('affiliatesAdmin.payoutEarned')}</span>
              <span className="font-semibold">{formatEurExact(totals.payout_earned)}</span>
            </div>
            {(data?.days || []).length > 0 && (
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t('affiliatesAdmin.colDay')}</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">{t('affiliatesAdmin.stSent')}</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">{t('affiliatesAdmin.stHold')}</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">{t('affiliatesAdmin.stPaid')}</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">{t('affiliatesAdmin.stCancelled')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(data?.days || [])].reverse().map((d) => (
                      <tr key={d.date} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{format(new Date(d.date), 'MMM d')}</td>
                        <td className="px-3 py-1.5 text-right font-medium">{d.sent}</td>
                        <td className="px-3 py-1.5 text-right">{d.approved}</td>
                        <td className="px-3 py-1.5 text-right">{d.paid}</td>
                        <td className="px-3 py-1.5 text-right">{d.cancelled + d.trashed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
