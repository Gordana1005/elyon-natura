import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ChevronRight, Split, AlertTriangle } from 'lucide-react';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import type { ChannelPL, OrderChannel } from '@/lib/api';

const pct1 = (x: number) => `${((x || 0) * 100).toFixed(1)}%`;

const CHANNEL_LABEL: Record<string, string> = {
  affiliate: 'insights.channelAffiliate',
  prediction: 'insights.channelPrediction',
  inbound: 'insights.channelInbound',
  manual: 'insights.channelManual',
};
const CHANNEL_HINT: Record<string, string> = {
  affiliate: 'insights.channelAffiliateHint',
  prediction: 'insights.channelPredictionHint',
  inbound: 'insights.channelInboundHint',
  manual: 'insights.channelManualHint',
};
/** Only the paid-lead channel gets a colour — the point of the table is that
 *  one of these four will cost money to feed and the other three do not. */
const CHANNEL_TONE: Record<string, string> = {
  affiliate: 'bg-purple-500',
  prediction: 'bg-emerald-500',
  inbound: 'bg-sky-500',
  manual: 'bg-muted-foreground',
};

/**
 * Profit by channel — the Pure Profit waterfall split by where the lead came
 * from. Ported from Bulgaria; here `affiliate` means "arrived via the AlterCPA
 * bridge". Every line is exactly attributable to one order, so nothing is
 * allocated on a key; the only approximation is that each row rounds
 * independently, which is why the totals row comes from the raw sums.
 *
 * The Lead cost column renders "—" everywhere for now: no per-webmaster rates
 * exist yet. It stays visible on purpose — the day rates are injected, the
 * numbers appear here with no UI change.
 */
export default function ChannelPLCard({
  data,
  vatPct,
  rangeFrom,
}: {
  data: NonNullable<import('@/lib/api').InsightsResponse['channel_pl']>;
  vatPct: number;
  rangeFrom?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (c: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });

  const rows = data.channels || [];
  const totals = data.totals;

  // Warn only when the requested window actually reaches back before the point
  // where prediction attribution existed at all (2026-08-14 here). Older orders
  // carry no prediction_list_id and land in `manual`, so `prediction` reads low.
  const attrFrom = data.first_prediction_attr_at ? data.first_prediction_attr_at.slice(0, 10) : null;
  const showAttrWarning = !!attrFrom && (!rangeFrom || rangeFrom < attrFrom);

  const cells = (r: ChannelPL) => (
    <>
      <td className="text-right py-2 tabular-nums">{r.orders.toLocaleString()}</td>
      <td className="text-right py-2 tabular-nums">{r.real_orders.toLocaleString()}</td>
      <td className="text-right py-2 tabular-nums">{r.paid_orders.toLocaleString()}</td>
      <td className="text-right py-2 tabular-nums">{r.paid_packages.toLocaleString()}</td>
      {/* Order basis — what was confirmed; the cash column lags it. */}
      <td className="text-right py-2 tabular-nums">{formatMoney(r.sold_revenue)}</td>
      <td className="text-right py-2 tabular-nums">{formatMoney(r.cash_collected)}</td>
      <td className={cn('text-right py-2 tabular-nums', r.lead_cost > 0 && 'text-purple-600 font-medium')}>
        {r.lead_cost > 0 ? `−${formatMoney(r.lead_cost)}` : '—'}
      </td>
      <td className="text-right py-2 tabular-nums font-semibold">{formatMoney(r.clear_profit)}</td>
      <td className="text-right py-2 tabular-nums">{formatMoney(r.net_profit_per_order)}</td>
      <td className="text-right py-2 tabular-nums">{pct1(r.margin_pct)}</td>
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Split className="h-4 w-4" /> {t('insights.channelPl')}
        </CardTitle>
        <div className="text-xs text-muted-foreground">{t('insights.channelPlDesc')}</div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showAttrWarning && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <div>{t('insights.channelAttributionCutoff', { date: attrFrom })}</div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2">{t('insights.colChannel')}</th>
                <th className="text-right py-2">{t('insights.channelColWorked')}</th>
                <th className="text-right py-2">{t('insights.colRealOrders')}</th>
                <th className="text-right py-2">{t('insights.colPaidOrders')}</th>
                <th className="text-right py-2">{t('insights.colPackages')}</th>
                <th className="text-right py-2">{t('insights.colConfirmedValue')}</th>
                <th className="text-right py-2">{t('insights.colCashCollected')}</th>
                <th className="text-right py-2">{t('insights.colLeadCost')}</th>
                <th className="text-right py-2">{t('insights.colClearProfit')}</th>
                <th className="text-right py-2">{t('insights.colNetPerOrder')}</th>
                <th className="text-right py-2">{t('insights.colMargin')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = open.has(r.channel);
                const hint = CHANNEL_HINT[r.channel];
                return (
                  <Fragment key={r.channel}>
                  <tr
                    className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => toggle(r.channel)}
                  >
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <ChevronRight
                          className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
                          aria-hidden
                        />
                        <span className={cn('h-2 w-2 rounded-full shrink-0', CHANNEL_TONE[r.channel])} aria-hidden />
                        <div className="min-w-0">
                          <div className="font-medium">{t(CHANNEL_LABEL[r.channel] ?? r.channel)}</div>
                          {hint && <div className="text-[11px] text-muted-foreground">{t(hint)}</div>}
                        </div>
                      </div>
                    </td>
                    {cells(r)}
                  </tr>
                  {isOpen && (
                    <tr className="border-b last:border-0 bg-muted/20">
                      <td colSpan={11} className="py-3 px-2">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-1 text-xs max-w-sm">
                            <Line label={t('insights.cashCollected')} value={formatMoney(r.cash_collected)} tone="text-emerald-700" />
                            <Line label={t('insights.vatLine', { pct: vatPct })} value={`−${formatMoney(r.vat)}`} />
                            <Line label={t('insights.cogsLine')} value={`−${formatMoney(r.cogs)}`} />
                            <Line label={t('insights.deliveryLine')} value={`−${formatMoney(r.delivery_cost)}`} />
                            <Line label={t('insights.returnLossLine')} value={`−${formatMoney(r.return_loss)}`} />
                            <Line label={t('insights.commissionsLine')} value={`−${formatMoney(r.agent_commissions)}`} />
                            <Line
                              label={t('insights.leadCostLine')}
                              value={r.lead_cost > 0 ? `−${formatMoney(r.lead_cost)}` : formatMoney(0)}
                              tone={r.lead_cost > 0 ? 'text-purple-600' : 'text-muted-foreground'}
                            />
                            <div className="flex justify-between border-t pt-1 font-semibold">
                              <span>{t('insights.clearMoney')}</span>
                              <span className="tabular-nums">{formatMoney(r.clear_profit)}</span>
                            </div>
                          </div>
                          <div className="space-y-2 text-xs">
                            <Line label={t('insights.colConfirmRate')} value={pct1(r.confirm_rate)} />
                            <Line label={t('insights.colPaidRate')} value={pct1(r.paid_rate)} />
                            <Line label={t('insights.returnRate')} value={pct1(r.return_rate)} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{t('insights.total')}</td>
                  {cells(totals)}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground">{t('insights.channelTotalsNote')}</p>
        <p className="text-[11px] text-muted-foreground">{t('insights.channelLeadCostPendingNote')}</p>
      </CardContent>
    </Card>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={cn('flex justify-between gap-4', tone || 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

export type { OrderChannel };
