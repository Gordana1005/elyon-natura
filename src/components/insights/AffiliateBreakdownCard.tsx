import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Users } from 'lucide-react';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import type { AffiliatePL } from '@/lib/api';

const pct1 = (x: number) => `${((x || 0) * 100).toFixed(1)}%`;

/**
 * Per-affiliator (AlterCPA webmaster) breakdown — which partner made us how
 * much in the selected range. The MK counterpart of Bulgaria's
 * AffiliatePayoutCard, minus every payout column: no per-webmaster lead rates
 * exist yet (operator, 2026-08-19 — they will be injected later). When they
 * are, the payout columns come back from the same by_affiliate rows; nothing
 * here needs recomputing.
 *
 * Names come from altercpa_webmasters and are operator-editable; an unnamed
 * partner shows as "WM <id>" so it stays identifiable.
 */
export default function AffiliateBreakdownCard({ byAffiliate }: { byAffiliate: AffiliatePL[] }) {
  const { t } = useTranslation();
  if (!byAffiliate?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="h-4 w-4" /> {t('insights.affiliateBreakdown')}
        </CardTitle>
        <div className="text-xs text-muted-foreground">{t('insights.affiliateBreakdownDesc')}</div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2">{t('insights.colPartner')}</th>
                <th className="text-right py-2">{t('insights.colLeads')}</th>
                <th className="text-right py-2">{t('insights.colRealOrders')}</th>
                <th className="text-right py-2">{t('insights.colPaidOrders')}</th>
                <th className="text-right py-2">{t('insights.colReturned')}</th>
                <th className="text-right py-2">{t('insights.colConfirmedValue')}</th>
                <th className="text-right py-2">{t('insights.colCashCollected')}</th>
                <th className="text-right py-2">{t('insights.colClearProfit')}</th>
                <th className="text-right py-2">{t('insights.colConfirmRate')}</th>
                <th className="text-right py-2">{t('insights.returnRate')}</th>
              </tr>
            </thead>
            <tbody>
              {byAffiliate.map(a => (
                <tr key={a.affiliate_id} className="border-b last:border-0">
                  <td className="py-2">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground font-mono">{a.code}</div>
                  </td>
                  <td className="text-right py-2 tabular-nums">{a.leads.toLocaleString()}</td>
                  <td className="text-right py-2 tabular-nums">{a.confirmed.toLocaleString()}</td>
                  <td className="text-right py-2 tabular-nums">{a.paid.toLocaleString()}</td>
                  <td className="text-right py-2 tabular-nums">{a.returned.toLocaleString()}</td>
                  {/* Order basis — what this partner MADE us; cash lags it. */}
                  <td className="text-right py-2 tabular-nums">{formatMoney(a.sold_revenue)}</td>
                  <td className="text-right py-2 tabular-nums">{formatMoney(a.cash_collected)}</td>
                  <td
                    className={cn(
                      'text-right py-2 tabular-nums font-semibold',
                      a.clear_profit < 0 && 'text-rose-600',
                    )}
                  >
                    {formatMoney(a.clear_profit)}
                  </td>
                  <td className="text-right py-2 tabular-nums">{pct1(a.confirm_rate)}</td>
                  <td className="text-right py-2 tabular-nums">{pct1(a.return_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('insights.channelLeadCostPendingNote')}</p>
      </CardContent>
    </Card>
  );
}
