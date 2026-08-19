import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import type { ChannelPL } from '@/lib/api';

const CHANNEL_LABEL: Record<string, string> = {
  affiliate: 'insights.channelAffiliate',
  prediction: 'insights.channelPrediction',
  inbound: 'insights.channelInbound',
  manual: 'insights.channelManual',
};
const CHANNEL_TONE: Record<string, string> = {
  affiliate: 'bg-purple-500',
  prediction: 'bg-emerald-500',
  inbound: 'bg-sky-500',
  manual: 'bg-muted-foreground',
};

/**
 * "What did we do today, and where did it come from" — the Overview tab's
 * one-glance channel answer. Ported from Bulgaria (2026-08-19 order-basis
 * version, commit 414c4fb there) — NOT the original profit-led card, which
 * read 0 ден across the board on any day whose orders had not been collected
 * yet.
 *
 * ORDER BASIS, DELIBERATELY. Every figure counts orders on the day they were
 * MADE and ties, cent for cent, to the tiles above: Σ sold_revenue = Revenue
 * (sold), Σ sold = the Orders tile's sold count. Profit does not belong on
 * Overview at all — the waterfall and margins live on Pure Profit.
 */
export default function ChannelStrip({ channels }: { channels: ChannelPL[] }) {
  const { t } = useTranslation();
  const live = channels.filter(c => c.orders > 0);
  if (!live.length) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{t('insights.channelStrip')}</h3>
        <Link to="/insights?tab=pure-profit" className="text-xs text-primary hover:underline">
          {t('insights.channelStripLink')}
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {live.map(c => (
          <Card key={c.channel}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full shrink-0', CHANNEL_TONE[c.channel])} aria-hidden />
                <span className="text-xs font-medium">{t(CHANNEL_LABEL[c.channel] ?? c.channel)}</span>
              </div>
              <p className="mt-2 text-lg font-bold tabular-nums">{formatMoney(c.sold_revenue)}</p>
              <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                {t('insights.channelStripConfirmed', { value: c.sold.toLocaleString() })}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t('insights.channelStripOutcomes', {
                  cancelled: c.cancelled.toLocaleString(),
                  trashed: c.trashed.toLocaleString(),
                })}
                {/* A same-day return leaves `sold` while staying a confirm, so
                    show it or the outcomes silently stop adding up. */}
                {c.returned > 0 && ` · ${t('insights.channelStripReturned', { value: c.returned.toLocaleString() })}`}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t('insights.channelStripWorked', { value: c.orders.toLocaleString() })}
                {c.leads_pending > 0 && ` · ${t('insights.channelStripPending', { value: c.leads_pending.toLocaleString() })}`}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{t('insights.channelStripBasis')}</p>
    </div>
  );
}
