import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, OctagonAlert, UserX } from 'lucide-react';
import type { PeopleResponse } from '@/lib/insightsApi/agents';
import { cn } from '@/lib/utils';
import { sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { noSellerBySource, reconcile } from './model';
import { BucketsBar } from './parts';

/**
 * "Продажби без продавач" — why part of the cohort is credited to nobody, per
 * source, so the people's sales + this card = the Overview's total (the check
 * line says so, or says it does not). Web-shop orders and MEX parcels with no
 * order have no seller by nature; an AlterCPA lead AlterCPA closed as cancelled
 * that MEX still shipped is a sale nobody decided; a handle nobody has named
 * yet waits in Settings → Teams. None of these is a list in Нарачки.
 */
export const NoSellerCard = forwardRef<HTMLElement, { data: PeopleResponse; money: boolean; f: InsightsFormat }>(
  function NoSellerCard({ data, money, f }, ref) {
    const { t } = f;
    const ns = data.no_seller;
    const rec = reconcile(data);
    if (!ns || !rec || !data.totals) return null;
    const groups = noSellerBySource(ns.reasons);
    const reasonLabel = (reason: string, detail: string | null) => {
      const base = t(`insights.agents.noSeller.reason.${reason}`);
      if (!detail) return base;
      const d = reason === 'unmapped' ? t(`insights.agents.noSeller.via.${detail}`, { defaultValue: detail }) : f.splitLabel(detail);
      return `${base} · ${d}`;
    };
    return (
      <section ref={ref} id="ag-no-seller" tabIndex={-1} aria-labelledby="ag-no-seller-title" className="space-y-3 focus:outline-none">
        <div>
          <h2 id="ag-no-seller-title" className="flex items-center gap-1.5 text-base font-semibold">
            <UserX className="h-4 w-4 text-muted-foreground" aria-hidden />{t('insights.agents.noSeller.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('insights.agents.noSeller.subtitle')}</p>
          <ClockCaption clock="sale" />
        </div>

        {/* The tie with the Overview: Σ people + no seller = the cohort total, per source. */}
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <p className={cn('flex flex-wrap items-center gap-1.5 text-sm font-medium', rec.ok ? STATUS_TEXT.good : STATUS_TEXT.critical)} role={rec.ok ? undefined : 'alert'}>
            {rec.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <OctagonAlert className="h-4 w-4" aria-hidden />}
            {t(rec.ok ? 'insights.agents.noSeller.tieOk' : 'insights.agents.noSeller.tieBad', {
              people: f.int(rec.people), none: f.int(rec.noSeller), total: f.int(rec.total),
            })}
          </p>
          <div className="relative mt-3 overflow-x-auto">
            <table className="w-full min-w-[320px] text-[13px]">
              <thead className="text-[11px] text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-2 text-left font-medium">{t('insights.agents.noSeller.col.source')}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t('insights.agents.noSeller.col.people')}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t('insights.agents.noSeller.col.none')}</th>
                  <th scope="col" className="px-2 py-1 text-right font-medium">{t('insights.agents.noSeller.col.total')}</th>
                  <th scope="col" className="py-1 pl-2 text-right font-medium">{t('insights.agents.noSeller.col.withSeller')}</th>
                </tr>
              </thead>
              <tbody>
                {rec.bySource.map((s) => (
                  <tr key={s.key} className="border-t">
                    <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-[3px] w-3 rounded-full" style={{ background: sourceColorVar(s.key) }} aria-hidden />
                        {f.sourceLabel(s.key)}
                        {!s.ok && <OctagonAlert className={cn('h-3.5 w-3.5', STATUS_TEXT.critical)} aria-label={t('insights.agents.noSeller.rowBad')} />}
                      </span>
                    </th>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.people)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.noSeller)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{f.int(s.total)}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums text-muted-foreground">{f.share(s.people, s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {groups.length === 0 ? (
          <p className={cn('flex items-center gap-2 rounded-xl border bg-card p-4 text-sm', STATUS_TEXT.good)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden />{t('insights.agents.noSeller.none')}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {groups.map((g) => (
              <article key={g.source} className="min-w-0 rounded-xl border bg-card p-4 shadow-sm">
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
                    <span className="h-[3px] w-3 rounded-full" style={{ background: sourceColorVar(g.source) }} aria-hidden />
                    {f.sourceLabel(g.source)}
                  </h3>
                  <span className="text-sm tabular-nums">
                    <span className="font-semibold">{f.int(g.count)}</span>
                    {money && g.value_mkd != null && <span className="text-muted-foreground"> · {f.den(g.value_mkd)}</span>}
                  </span>
                </header>
                <ul className="mt-2 space-y-3">
                  {g.rows.map((r) => (
                    <li key={`${r.reason}-${r.detail ?? ''}`} className="space-y-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[13px]">
                        <span className="font-medium" title={t('insights.agents.noSeller.noLink')}>{reasonLabel(r.reason, r.detail)}</span>
                        <span className="tabular-nums">
                          <span className="font-semibold">{f.int(r.count)}</span>
                          {money && r.value_mkd != null && <span className="text-muted-foreground"> · {f.den(r.value_mkd)}</span>}
                        </span>
                      </div>
                      <p className="text-[11px] leading-snug text-muted-foreground">{t(`insights.agents.noSeller.hint.${r.reason}`)}</p>
                      <BucketsBar buckets={r.buckets} total={r.count} label={reasonLabel(r.reason, r.detail)} f={f} className="h-1.5" />
                      <p className="text-[11px] tabular-nums text-muted-foreground">
                        {t('insights.agents.noSeller.paidLine', {
                          paid: f.int(r.buckets.paid), open: f.int(r.buckets.courier + r.buckets.courier_problem + r.buckets.label + r.buckets.to_pack),
                          returned: f.int(r.buckets.returned),
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}

        {(ns.cancelled_by.length > 0 || ns.handles.length > 0 || (data.unmapped_work?.count ?? 0) > 0) && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {ns.cancelled_by.length > 0 && (
              <article className="rounded-xl border bg-card p-4 shadow-sm">
                <h3 className="text-sm font-semibold">{t('insights.agents.noSeller.cancelledBy.title')}</h3>
                <p className="text-[11px] text-muted-foreground">{t('insights.agents.noSeller.cancelledBy.hint')}</p>
                <ol className="mt-2 space-y-1 text-[13px]">
                  {ns.cancelled_by.map((c) => (
                    <li key={`${c.person_id ?? ''}-${c.altercpa_user ?? ''}`} className="flex items-baseline justify-between gap-2">
                      <span className="truncate">{c.name ?? t('insights.agents.noSeller.cancelledBy.unnamed', { id: c.altercpa_user ?? '—' })}</span>
                      <span className="shrink-0 tabular-nums">
                        <span className="font-semibold">{f.int(c.count)}</span>
                        {money && c.value_mkd != null && <span className="text-muted-foreground"> · {f.den(c.value_mkd)}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              </article>
            )}
            {(ns.handles.length > 0 || (data.unmapped_work?.count ?? 0) > 0) && (
              <article className="rounded-xl border bg-card p-4 shadow-sm">
                <h3 className="text-sm font-semibold">{t('insights.agents.noSeller.handles.title')}</h3>
                <p className="text-[11px] text-muted-foreground">
                  {t('insights.agents.noSeller.handles.hint')}{' '}
                  <Link to="/settings" className="font-medium text-primary underline-offset-2 hover:underline">{t('insights.agents.noSeller.handles.settings')}</Link>
                </p>
                {ns.handles.length > 0 && (
                  <ol className="mt-2 space-y-1 text-[13px]">
                    {ns.handles.map((h) => (
                      <li key={`${h.via ?? ''}-${h.handle}`} className="flex items-baseline justify-between gap-2">
                        <span className="truncate">{h.handle} <span className="text-[11px] text-muted-foreground">· {t(`insights.agents.noSeller.via.${h.via ?? 'other'}`, { defaultValue: h.via ?? '—' })}</span></span>
                        <span className="shrink-0 font-semibold tabular-nums">{f.int(h.count)}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {(data.unmapped_work?.count ?? 0) > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t('insights.agents.noSeller.unmappedWork', { n: f.int(data.unmapped_work!.count) })}
                    {' '}{data.unmapped_work!.actors.slice(0, 5).map((a) => `${a.actor ?? '—'} (${f.int(a.count)})`).join(', ')}
                  </p>
                )}
              </article>
            )}
          </div>
        )}
      </section>
    );
  },
);
