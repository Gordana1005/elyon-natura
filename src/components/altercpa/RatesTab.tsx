import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiGetAlterCpaDailyRates, type AlterCpaRateRow } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { affiliateLabel } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { Loader2, Percent, ChevronRight, TriangleAlert } from 'lucide-react';

/**
 * The affiliate guarantee tracker on /altercpa.
 *
 * Every Macedonian lead an affiliate sent, bucketed by ARRIVAL day, against how
 * many ever got confirmed. A lead that arrives Tuesday and confirms Thursday
 * still counts to Tuesday, so a cohort keeps climbing for ~2-3 days after its
 * day ends — which is why today's row is marked as still settling rather than
 * judged. Judging an unfinished day would flag most mornings as a breach.
 */
export function RatesTab() {
  const webmasterNames = useWebmasterNames();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [days, setDays] = useState('14');
  const [expanded, setExpanded] = useState<string | null>(null);

  const highlightWm = searchParams.get('wm') || '';
  const highlightDate = searchParams.get('date') || '';

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (parseInt(days) - 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { from: iso(from), to: iso(to) };
  }, [days]);

  const { data, isLoading } = useQuery({
    queryKey: ['altercpa-daily-rates', range.from, range.to],
    queryFn: () => apiGetAlterCpaDailyRates(range.from, range.to),
    refetchInterval: 60_000,
  });

  const target = data?.target_pct ?? 30;
  const minCohort = data?.min_cohort ?? 20;
  const settleDays = data?.settle_days ?? 3;
  const todayIso = new Date().toISOString().slice(0, 10);

  // A cohort younger than settle_days is still gathering confirmations.
  const isSettling = (day: string) => {
    const age = (Date.parse(todayIso) - Date.parse(day)) / 86400000;
    return age < settleDays;
  };

  const offersFor = (day: string, wm: string): AlterCpaRateRow[] =>
    (data?.by_offer || [])
      .filter(r => r.day === day && r.webmaster === wm)
      .sort((a, b) => b.leads - a.leads);

  // Headline: the settled days only, so one unfinished morning cannot drag the
  // number an operator glances at.
  const settled = (data?.totals || []).filter(r => !isSettling(r.day));
  const settledLeads = settled.reduce((s, r) => s + r.leads, 0);
  const settledConf = settled.reduce((s, r) => s + r.confirmed, 0);
  const settledPct = settledLeads ? (settledConf * 100) / settledLeads : 0;
  const breaches = settled.filter(r => r.leads >= minCohort && (r.pct ?? 0) < target).length;

  if (isLoading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  const totals = data?.totals || [];

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border p-3">
          <div className="text-[11px] text-muted-foreground">{t('cpaRates.settledRate', { days: settleDays })}</div>
          <div className={cn('mt-1 text-2xl font-bold tabular-nums',
            settledPct >= target ? 'text-emerald-600' : 'text-destructive')}>
            {settledPct.toFixed(1)}%
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('cpaRates.ofLeads', { confirmed: settledConf, leads: settledLeads })}
          </div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="text-[11px] text-muted-foreground">{t('cpaRates.guarantee')}</div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{target}%</div>
          <div className="text-[10px] text-muted-foreground">{t('cpaRates.geoNote', { geo: data?.geo || 'MK' })}</div>
        </div>
        <div className={cn('rounded-xl border p-3', breaches > 0 && 'border-destructive/40 bg-destructive/5')}>
          <div className="text-[11px] text-muted-foreground">{t('cpaRates.breaches')}</div>
          <div className={cn('mt-1 text-2xl font-bold tabular-nums', breaches > 0 && 'text-destructive')}>{breaches}</div>
          <div className="text-[10px] text-muted-foreground">{t('cpaRates.breachesNote', { min: minCohort })}</div>
        </div>
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Percent className="h-4 w-4" /> {t('cpaRates.title')}
            </CardTitle>
            <CardDescription>{t('cpaRates.subtitle', { step: data?.milestone_step ?? 10 })}</CardDescription>
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t('cpaRates.lastNDays', { n: 7 })}</SelectItem>
              <SelectItem value="14">{t('cpaRates.lastNDays', { n: 14 })}</SelectItem>
              <SelectItem value="30">{t('cpaRates.lastNDays', { n: 30 })}</SelectItem>
              <SelectItem value="90">{t('cpaRates.lastNDays', { n: 90 })}</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {totals.length === 0 ? (
            <EmptyState icon={<Percent className="h-4 w-4" />} title={t('cpaRates.noData')} size="sm" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t('cpaRates.day')}</th>
                    <th className="py-2 pr-3 font-medium">{t('cpaRates.affiliate')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('cpaRates.leads')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('cpaRates.confirmed')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('cpaRates.rate')}</th>
                    <th className="py-2 font-medium">{t('cpaRates.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.map((r) => {
                    const key = `${r.day}|${r.webmaster}`;
                    const pct = r.pct ?? 0;
                    const settling = isSettling(r.day);
                    const tooSmall = r.leads < minCohort;
                    const under = pct < target;
                    const isOpen = expanded === key;
                    const highlighted = highlightWm === r.webmaster && highlightDate === r.day;
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => setExpanded(isOpen ? null : key)}
                          className={cn(
                            'cursor-pointer border-b transition-colors hover:bg-muted/40',
                            highlighted && 'bg-primary/5',
                          )}
                        >
                          <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{r.day}</td>
                          <td className="py-2 pr-3">
                            <span className="flex items-center gap-1 font-medium">
                              <ChevronRight className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-90')} />
                              {affiliateLabel(r.webmaster, webmasterNames)}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.leads}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.confirmed}</td>
                          <td className={cn('py-2 pr-3 text-right font-semibold tabular-nums',
                            settling || tooSmall ? 'text-muted-foreground'
                              : under ? 'text-destructive' : 'text-emerald-600')}>
                            {pct.toFixed(1)}%
                          </td>
                          <td className="py-2">
                            {settling ? (
                              <Badge variant="outline" className="text-[10px]">{t('cpaRates.settling')}</Badge>
                            ) : tooSmall ? (
                              <Badge variant="secondary" className="text-[10px]">{t('cpaRates.tooFew')}</Badge>
                            ) : under ? (
                              <Badge variant="destructive" className="gap-1 text-[10px]">
                                <TriangleAlert className="h-3 w-3" />{t('cpaRates.below')}
                              </Badge>
                            ) : (
                              <Badge className="bg-emerald-600 text-[10px]">{t('cpaRates.met')}</Badge>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b bg-muted/20">
                            <td colSpan={6} className="px-3 py-2">
                              <div className="mb-1 text-[10px] text-muted-foreground">{t('cpaRates.offerNote')}</div>
                              <div className="space-y-1">
                                {offersFor(r.day, r.webmaster).map((o) => (
                                  <div key={o.offer_name} className="flex items-center justify-between gap-3 text-xs">
                                    <span className="truncate">{o.offer_name}</span>
                                    <span className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                                      <span>{o.confirmed}/{o.leads}</span>
                                      <span className={cn('w-12 text-right font-medium',
                                        (o.pct ?? 0) < target ? 'text-amber-600' : 'text-emerald-600')}>
                                        {(o.pct ?? 0).toFixed(0)}%
                                      </span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
