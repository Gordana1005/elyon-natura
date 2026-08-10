import { cn } from '@/lib/utils';
import type { AffiliateStats } from '@/lib/api';
import { approveRatePct, buyoutRatePct } from './affiliateStage';

interface AffiliateKpiCardsProps {
  totals: AffiliateStats;
  /**
   * MK: pass formatEurExact on both the portal and the staff tab. Affiliate
   * payout is a EUR obligation to the webmaster (payout_eur_snapshot IS euro),
   * so it is the one deliberate exception to this market's denari-only UI.
   */
  fmtMoney: (eur: number) => string;
  labels: {
    sent: string;
    approveRate: string;
    buyoutRate: string;
    approved: string;
    payoutEarned: string;
  };
}

// The 5 KPI tiles shared by the partner portal and the staff Dashboard tab.
// "Payout on hold" is gone by design: earned-at-confirmation leaves nothing
// on hold.
export function AffiliateKpiCards({ totals, fmtMoney, labels }: AffiliateKpiCardsProps) {
  const tiles: { label: string; value: string | number; highlight?: boolean }[] = [
    { label: labels.sent, value: totals.sent },
    { label: labels.approveRate, value: `${approveRatePct(totals)}%` },
    { label: labels.buyoutRate, value: `${buyoutRatePct(totals)}%` },
    { label: labels.approved, value: totals.approved },
    { label: labels.payoutEarned, value: fmtMoney(totals.payout_earned), highlight: true },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {tiles.map((s, i) => (
        <div
          key={i}
          className={cn(
            'rounded-xl border bg-card shadow-sm px-4 py-4',
            s.highlight && 'border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/5',
          )}
        >
          <p className="text-xl font-bold">{s.value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
