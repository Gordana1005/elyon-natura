import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { apiGetAffiliatePortalOffers } from '@/lib/api';
import { formatEurExact } from '@/lib/currency';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Copy, Loader2, Package } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';

/** Offers this affiliate is approved to run — payout shown is THEIR payout
 *  (override-aware), in EUR via formatEurExact: a euro debt to a foreign
 *  webmaster, the documented exception to the денари-only UI (elyon-currency,
 *  same as the portal dashboard). The offer_id is what they put in the API call. */
export default function AffiliateOffersCataloguePage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data: offers = [], isLoading } = useQuery({
    queryKey: ['affiliate-portal-offers'],
    queryFn: apiGetAffiliatePortalOffers,
  });

  const copyId = (id: string) => {
    navigator.clipboard.writeText(id);
    toast({ title: t('affiliate.offerIdCopied') });
  };

  return (
    <AppLayout title={t('affiliate.offersTitle')}>
      {isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      ) : offers.length === 0 ? (
        <EmptyState
          icon={<Package className="h-5 w-5" />}
          title={t('affiliate.noOffers')}
          description={t('affiliate.noOffersDesc')}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {offers.map((o) => (
            <Card key={o.offer_id} className="shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{o.name}</CardTitle>
                  <Badge variant="outline" className="text-xs shrink-0">{o.geo}</Badge>
                </div>
                {o.product_name && (
                  <p className="text-xs text-muted-foreground">{o.product_name}</p>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-2xl font-bold text-[hsl(var(--success))]">{formatEurExact(o.payout_eur)}</p>
                  <p className="text-xs text-muted-foreground">{t('affiliate.payoutPerBuyout')}</p>
                </div>
                {o.description && <p className="text-sm text-muted-foreground">{o.description}</p>}
                {o.terms && (
                  <div className="rounded-lg bg-muted/40 px-3 py-2">
                    <p className="text-[11px] font-semibold uppercase text-muted-foreground mb-0.5">{t('affiliate.terms')}</p>
                    <p className="text-xs text-muted-foreground">{o.terms}</p>
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <code className="text-[11px] font-mono bg-muted px-2 py-1 rounded truncate flex-1" title={o.offer_id}>
                    {o.offer_id}
                  </code>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => copyId(o.offer_id)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
