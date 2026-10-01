import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { BreakdownRow, CohortView, RatesDay } from '@/lib/altercpaGuaranteeApi';
import { RateBar, StateBadge, useSay } from './bits';
import { SENTENCE_TONE_CLASS, cohortSentence, rateToneClass } from './guaranteeText';

const TOP = 15;

/**
 * One cohort (a webmaster's day, or the MK total of the day) opened from Стапки: what it takes
 * to reach the target, the buckets, "Реално испратени (MEX)", the old metric for comparison,
 * the split by stream and by offer (diagnosis only — the deal is judged per webmaster), and the
 * link to its leads. A bottom sheet on a phone, a right sheet from md.
 */
export function CohortDrillSheet({ day, wm, wmName, f, minCohort, onClose }: {
  day: RatesDay | null;
  /** '*' = the MK total of the day. */
  wm: string | null;
  wmName: (wm: string) => string;
  f: InsightsFormat;
  minCohort: number;
  onClose: () => void;
}) {
  const { t } = f;
  const isMobile = useIsMobile();
  const say = useSay();
  const v: (CohortView & { streams?: BreakdownRow[]; offers?: BreakdownRow[] }) | null =
    !day || !wm ? null : wm === '*' ? day.totals : day.webmasters.find((w) => w.webmaster === wm) ?? null;
  const open = !!v;
  const name = wm === '*' ? t('altercpaGuarantee.rates.totalMk') : wm ? wmName(wm) : '';
  const s = v ? cohortSentence(v, minCohort, (x) => f.pct(x)) : null;
  const leadsLink = day ? `/altercpa?tab=leads&from=${day.day}&to=${day.day}${wm && wm !== '*' ? `&wm=${encodeURIComponent(wm)}` : ''}` : '';

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side={isMobile ? 'bottom' : 'right'}
        className={cn('flex flex-col gap-0 p-0', isMobile ? 'max-h-[90dvh]' : 'w-full sm:max-w-md', OVERVIEW_COLOR_VARS)}>
        {v && day && s && (
          <>
            <SheetHeader className="border-b px-4 py-3 pr-10 text-left">
              <SheetTitle className="break-words text-base">{name} · {f.period(day.day, day.day)}</SheetTitle>
              <SheetDescription asChild>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <StateBadge state={v.state} />
                  <span className={cn('font-medium', SENTENCE_TONE_CLASS[s.tone])}>{say(s)}</span>
                </div>
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
              <section className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn('text-3xl font-semibold tabular-nums', rateToneClass(v.state, v.math))}>{f.pct(v.math.rate)}</span>
                  <span className="text-xs text-muted-foreground">{t('altercpaGuarantee.tile.rateSub', { target: v.math.target })}</span>
                </div>
                <RateBar math={v.math} />
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-xs">
                  <Pair k={t('altercpaGuarantee.drill.required', { target: v.math.target })} v={f.int(v.math.required)} />
                  <Pair k={t('altercpaGuarantee.drill.counted')} v={f.int(v.counted)} />
                  <Pair k={v.math.need > 0 ? t('altercpaGuarantee.drill.need') : t('altercpaGuarantee.drill.margin')}
                    v={v.math.need > 0 ? f.int(v.math.need) : `+${f.int(v.math.margin ?? 0)}`} />
                  <Pair k={t('altercpaGuarantee.drill.cancellable')} v={f.int(v.math.cancellable)} />
                  <Pair k={t('altercpaGuarantee.drill.max')} v={f.pct(v.math.maxRate)} />
                  <Pair k={t('altercpaGuarantee.drill.per10')} v={String(v.math.per10).replace('.', ',')} />
                </dl>
              </section>

              <section className="space-y-1.5">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('altercpaGuarantee.drill.buckets')}</h4>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <Pair k={t('altercpaGuarantee.decision.approved')} v={f.int(v.approved)} />
                  <Pair k={t('altercpaGuarantee.decision.cancelOther')} v={f.int(v.cancel_other)} />
                  <Pair k={t('altercpaGuarantee.decision.cancelled')} v={f.int(v.cancelled)} />
                  <Pair k={t('altercpaGuarantee.decision.trashed')} v={f.int(v.trashed)} />
                  <Pair k={t('altercpaGuarantee.decision.open')} v={f.int(v.open)} />
                  <Pair k={t('altercpaGuarantee.drill.test')} v={f.int(v.test_excluded)} />
                </dl>
              </section>

              <section className="space-y-1 rounded-lg border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h4 className="text-sm font-medium">{t('altercpaGuarantee.drill.mex')}</h4>
                  <span className="font-semibold tabular-nums">{f.int(v.mex_shipped)} · {f.share(v.mex_shipped, v.leads)}</span>
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">{t('altercpaGuarantee.drill.mexSub')}</p>
                <div className="flex items-baseline justify-between gap-2 pt-1 text-muted-foreground">
                  <span className="text-xs">{t('altercpaGuarantee.drill.old')}</span>
                  <span className="text-xs tabular-nums">{f.int(v.crm_sticky)} · {f.share(v.crm_sticky, v.leads)}</span>
                </div>
              </section>

              {wm === '*' ? (
                <Breakdown title={t('altercpaGuarantee.drill.byWebmaster')} f={f}
                  rows={day.webmasters.map((w) => ({ ...w, key: wmName(w.webmaster), rate: w.math.rate }))} />
              ) : (
                <>
                  <Breakdown title={t('altercpaGuarantee.drill.byStream')} f={f} rows={v.streams ?? []} mono />
                  <Breakdown title={t('altercpaGuarantee.drill.byOffer')} f={f} rows={v.offers ?? []} />
                </>
              )}
            </div>
            <div className="border-t px-4 py-3">
              <Button asChild className="h-11 w-full gap-1.5">
                <Link to={leadsLink}>{t('altercpaGuarantee.drill.toLeads')}<ArrowRight className="h-4 w-4" aria-hidden /></Link>
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium tabular-nums">{v}</dd>
    </>
  );
}

function Breakdown({ title, rows, f, mono }: {
  title: string;
  rows: Array<{ key: string; leads: number; counted: number; open: number; rate: number | null }>;
  f: InsightsFormat;
  mono?: boolean;
}) {
  const { t } = f;
  if (!rows.length) return null;
  const shown = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-1 text-left font-medium"><span className="sr-only">{title}</span></th>
            <th scope="col" className="w-16 py-1 pl-2 text-right font-medium">{t('altercpaGuarantee.drill.colLeads')}</th>
            <th scope="col" className="w-20 py-1 pl-2 text-right font-medium">{t('altercpaGuarantee.drill.colCounted')}</th>
            <th scope="col" className="w-16 py-1 pl-2 text-right font-medium">{t('altercpaGuarantee.drill.colRate')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className="border-b last:border-0">
              <td className={cn('break-words py-1 pr-2', mono && 'break-all font-mono text-[11px]')}>{r.key}</td>
              <td className="py-1 text-right tabular-nums">{f.int(r.leads)}</td>
              <td className="py-1 text-right tabular-nums">{f.int(r.counted)}</td>
              <td className="py-1 text-right tabular-nums">{f.pct(r.rate, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rest.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t('altercpaGuarantee.drill.more', { n: f.int(rest.length), leads: f.int(rest.reduce((a, r) => a + r.leads, 0)) })}
        </p>
      )}
    </section>
  );
}
