import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGetOffers, apiCreateOffer, apiUpdateOffer, apiGetProducts, OfferAdmin } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { formatMoney, formatEurExact, eurToDen, denInputToEur } from '@/lib/currency';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Plus, Pencil, Loader2, Tag, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { ProductCombobox } from '@/components/ProductCombobox';

export function OffersTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOffer, setEditOffer] = useState<OfferAdmin | null>(null);
  const [fName, setFName] = useState('');
  const [fProductId, setFProductId] = useState<string | null>(null);
  // MK: this deployment is Macedonia. It used to default to the upstream 'BG',
  // which silently stamped every offer created here as Bulgarian.
  const [fGeo, setFGeo] = useState('MK');
  const [fPayout, setFPayout] = useState('');
  // Customer price per package for THIS offer, TYPED IN ДЕНАРИ (a Macedonian
  // selling price, owner 2026-09-28) and saved as EUR in offers.price_eur via
  // denInputToEur — an untouched field saves the stored EUR exactly. Empty =
  // inherit the product's own price, so other channels are never repriced by an
  // affiliate deal. (The payout beside it stays EUR: a debt to a foreign
  // webmaster — the documented exception.)
  const [fPrice, setFPrice] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fTerms, setFTerms] = useState('');
  const [fActive, setFActive] = useState(true);

  const { data: offers = [], isLoading } = useQuery<OfferAdmin[]>({
    queryKey: ['offers'],
    queryFn: apiGetOffers,
  });
  const { data: products = [] } = useQuery<any[]>({
    queryKey: ['products'],
    queryFn: apiGetProducts,
  });

  const onError = (err: any) =>
    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['offers'] });

  const resetForm = () => {
    setFName(''); setFProductId(null); setFGeo('MK'); setFPayout(''); setFPrice('');
    setFDesc(''); setFTerms(''); setFActive(true); setEditOffer(null);
  };

  const openCreate = () => { resetForm(); setDialogOpen(true); };
  const openEdit = (o: OfferAdmin) => {
    setEditOffer(o); setFName(o.name); setFProductId(o.product_id);
    setFGeo(o.geo); setFPayout(String(o.payout_eur));
    setFPrice(o.price_eur == null ? '' : String(eurToDen(o.price_eur)));
    setFDesc(o.description || ''); setFTerms(o.terms || ''); setFActive(o.is_active);
    setDialogOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name: fName.trim(),
        product_id: fProductId,
        geo: (fGeo.trim() || 'MK').toUpperCase(),
        payout_eur: Number(fPayout),
        price_eur: denInputToEur(fPrice, editOffer?.price_eur),
        description: fDesc.trim(),
        terms: fTerms.trim(),
        is_active: fActive,
      };
      return editOffer ? apiUpdateOffer(editOffer.id, body) : apiCreateOffer(body);
    },
    onSuccess: () => {
      invalidate(); setDialogOpen(false); resetForm();
      toast({ title: t(editOffer ? 'affiliatesAdmin.offerUpdated' : 'affiliatesAdmin.offerCreated') });
    },
    onError,
  });

  const payoutNum = Number(fPayout);
  const payoutValid = Number.isFinite(payoutNum) && payoutNum >= 0;
  const priceNum = Number(fPrice);  // денари
  const priceValid = fPrice.trim() === '' || (Number.isFinite(priceNum) && priceNum >= 0);
  // Shown as the placeholder so it is obvious what "leave empty" inherits.
  const selectedProductPrice = products.find((p: any) => p.id === fProductId)?.price ?? null;
  const activeCount = offers.filter((o) => o.is_active).length;

  if (isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:max-w-md">
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary"><Tag className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.totalOffers')}</p><p className="text-xl font-bold">{offers.length}</p></div></CardContent></Card>
        <Card className="border-none shadow-sm"><CardContent className="p-4 flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--success))]"><CheckCircle2 className="h-5 w-5 text-primary-foreground" /></div><div><p className="text-xs text-muted-foreground">{t('affiliatesAdmin.activeOffers')}</p><p className="text-xl font-bold">{activeCount}</p></div></CardContent></Card>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('affiliatesAdmin.allOffers')}</h2>
        {isAdmin && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> {t('affiliatesAdmin.createOffer')}
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colOffer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colProduct')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">GEO</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colPayoutOffer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colStatus')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colCreated')}</th>
                {isAdmin && <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colActions')}</th>}
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <span className="font-medium">{o.name}</span>
                      {o.description && <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[240px]">{o.description}</p>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{o.products?.name || '—'}</td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-xs">{o.geo}</Badge></td>
                  <td className="px-4 py-3 font-semibold">{formatEurExact(o.payout_eur)}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={cn('text-xs', o.is_active
                      ? 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30'
                      : 'bg-muted text-muted-foreground')}>
                      {o.is_active ? t('affiliatesAdmin.offerActive') : t('affiliatesAdmin.offerRetired')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{format(new Date(o.created_at), 'dd.MM.yyyy')}</td>
                  {isAdmin && (
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(o)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {offers.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="p-0">
                    <EmptyState
                      icon={<Tag className="h-5 w-5" />}
                      title={t('affiliatesAdmin.noOffers')}
                      description={t('affiliatesAdmin.noOffersDesc')}
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

      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) { setDialogOpen(false); resetForm(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editOffer ? t('affiliatesAdmin.editOffer') : t('affiliatesAdmin.createOffer')}</DialogTitle>
            <DialogDescription>{t('affiliatesAdmin.offerDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldOfferName')}</Label>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Testoy BG — 1 pack" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldProduct')}</Label>
              <ProductCombobox
                products={products}
                value={fProductId}
                onChange={(id) => setFProductId(id)}
              />
              <p className="text-xs text-muted-foreground">{t('affiliatesAdmin.fieldProductHint')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>GEO</Label>
                <Input value={fGeo} onChange={(e) => setFGeo(e.target.value)} placeholder="BG" />
              </div>
              <div className="space-y-1.5">
                <Label>{t('affiliatesAdmin.fieldPayout')}</Label>
                <Input type="number" step="0.01" min="0" value={fPayout} onChange={(e) => setFPayout(e.target.value)} placeholder="7.50" />
                {payoutValid && fPayout !== '' && (
                  <p className="text-xs text-muted-foreground">&asymp; {formatMoney(payoutNum)}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>{t('affiliatesAdmin.fieldSellPrice')}</Label>
                <div className="relative">
                  <Input
                    type="number" step="1" min="0" value={fPrice}
                    onChange={(e) => setFPrice(e.target.value)}
                    placeholder={selectedProductPrice != null ? String(eurToDen(selectedProductPrice)) : '2146'}
                    className="pr-10"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">ден</span>
                </div>
                {fPrice.trim() === '' && (
                  <p className="text-xs text-muted-foreground">
                    {t('affiliatesAdmin.sellPriceHint')}
                    {selectedProductPrice != null && ` (${formatMoney(selectedProductPrice)})`}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldDescription')}</Label>
              <Textarea value={fDesc} onChange={(e) => setFDesc(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('affiliatesAdmin.fieldTerms')}</Label>
              <Textarea value={fTerms} onChange={(e) => setFTerms(e.target.value)} rows={2} placeholder={t('affiliatesAdmin.fieldTermsHint')} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <p className="text-sm font-medium">{t('affiliatesAdmin.offerActive')}</p>
              <Switch checked={fActive} onCheckedChange={setFActive} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }}>{t('common.cancel')}</Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!fName.trim() || !payoutValid || fPayout === '' || !priceValid || saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {editOffer ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
