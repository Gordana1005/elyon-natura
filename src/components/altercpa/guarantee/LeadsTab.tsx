import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SmartPagination } from '@/components/SmartPagination';
import { ResponsivePager } from '@/components/assigner/parts';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { LoadError } from '@/components/insights/shared/LoadError';
import { addDays, daysBetween, isYmd, skopjeToday, type DayRange } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { affiliateLabel } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import {
  GUARANTEE_DECISIONS, apiGetGuaranteeLeads, apiGetGuaranteeRates, decisionKey,
  type GuaranteeDecision, type JournalRow,
} from '@/lib/altercpaGuaranteeApi';
import { CrmChip, DecisionBadge, Dur, MexChip, skopjeDmHm } from './bits';
import { minutesBetween } from './guaranteeText';

const LIMIT = 50;
const MAX_DAYS = 92;
const ALL = '__all__';
const PRESETS = ['today', '7', '30'] as const;

function leadsRange(params: URLSearchParams, today: string): DayRange {
  const f = params.get('from');
  const t = params.get('to');
  let r: DayRange = isYmd(f) && isYmd(t) ? { from: f, to: t } : { from: today, to: today };
  if (r.from > r.to) r = { from: r.to, to: r.from };
  if (r.to > today) r = { ...r, to: today };
  if (r.from > r.to) r = { ...r, from: r.to };
  if (daysBetween(r.from, r.to) > MAX_DAYS - 1) r = { ...r, from: addDays(r.to, -(MAX_DAYS - 1)) };
  return r;
}

/**
 * Лидови (plan 01.10.2026, Фаза 4) — every Macedonian AlterCPA lead: when it arrived, from which
 * webmaster / stream / offer, AlterCPA's decision and when (how long after arrival), the AlterCPA
 * operator, the CRM order, its MEX parcel and the reason. Filters live in the URL; test leads are
 * hidden unless asked for. Customer names and phones arrive masked for a viewer without the PII
 * privilege. A table from xl, cards below; 50 a page.
 */
export function LeadsTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const [params, setParams] = useSearchParams();
  const today = skopjeToday();
  const range = leadsRange(params, today);
  const names = useWebmasterNames();
  const wmName = (wm: string) => (wm === '(none)' ? t('altercpaGuarantee.noWebmaster') : affiliateLabel(wm, names));

  const wm = params.get('wm') || null;
  const stream = params.get('stream') || null;
  const offer = params.get('offer') || null;
  const dRaw = params.get('decision');
  const decision = (GUARANTEE_DECISIONS as readonly string[]).includes(dRaw ?? '') ? (dRaw as GuaranteeDecision) : null;
  const qText = params.get('q') || '';
  const test = params.get('test') === '1';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const patch = (fn: (n: URLSearchParams) => void, keepPage = false) => setParams((p) => {
    const n = new URLSearchParams(p);
    fn(n);
    if (!keepPage) n.delete('page');
    return n;
  }, { replace: true });
  const setParam = (k: string, v: string | null) => patch((n) => { if (v) n.set(k, v); else n.delete(k); });

  // the search box writes the URL after a short pause
  const [draft, setDraft] = useState(qText);
  useEffect(() => { setDraft(qText); }, [qText]);
  useEffect(() => {
    if (draft.trim() === qText) return;
    const id = setTimeout(() => setParam('q', draft.trim() || null), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // the filter choices come from the counts of the same period (shared with Стапки's cache)
  const facets = useQuery({
    queryKey: ['altercpa-guarantee-rates', range.from, range.to],
    queryFn: () => apiGetGuaranteeRates(range.from, range.to),
    staleTime: 60_000,
  });
  const choices = useMemo(() => {
    const wms = (facets.data?.webmasters ?? []).map((w) => w.webmaster);
    const streams = new Map<string, number>();
    const offers = new Map<string, number>();
    for (const d of facets.data?.days ?? []) {
      for (const w of d.webmasters) {
        if (wm && w.webmaster !== wm) continue;
        for (const s of w.streams) streams.set(s.key, (streams.get(s.key) ?? 0) + s.leads + s.test_excluded);
        for (const o of w.offers) offers.set(o.key, (offers.get(o.key) ?? 0) + o.leads + o.test_excluded);
      }
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    return { wms, streams: sorted(streams), offers: sorted(offers) };
  }, [facets.data, wm]);

  const q = useQuery({
    queryKey: ['altercpa-guarantee-leads', range.from, range.to, wm, stream, offer, decision, qText, test, page],
    queryFn: () => apiGetGuaranteeLeads({ from: range.from, to: range.to, wm, stream, offer, decision, q: qText || null, test, page, limit: LIMIT }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const filtered = !!(wm || stream || offer || decision || qText || test);

  const presetRange = (p: (typeof PRESETS)[number]): DayRange =>
    p === 'today' ? { from: today, to: today } : { from: addDays(today, -(Number(p) - 1)), to: today };
  const activePreset = PRESETS.find((p) => { const r = presetRange(p); return r.from === range.from && r.to === range.to; });
  const setRange = (r: DayRange) => patch((n) => { n.set('from', r.from); n.set('to', r.to); });

  const sel = (id: string, label: string, value: string | null, all: string, opts: Array<{ v: string; l: string }>, k: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value ?? ALL} onValueChange={(v) => setParam(k, v === ALL ? null : v)}>
        <SelectTrigger id={id} className="h-9 w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{all}</SelectItem>
          {opts.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodStepper range={range} today={today} onStep={(n) => setRange(n.range)} testId="leads-period" />
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('altercpaGuarantee.rates.period')}>
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => setRange(presetRange(p))} aria-pressed={activePreset === p}
              className={cn('min-h-8 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-muted',
                activePreset === p && 'border-primary bg-primary/10 text-primary')}>
              {p === 'today' ? t('altercpaGuarantee.today.backToToday') : t('altercpaGuarantee.rates.presetDays', { n: Number(p) })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {sel('lf-wm', t('altercpaGuarantee.leads.webmaster'), wm, t('altercpaGuarantee.leads.allWebmasters'),
          (wm && !choices.wms.includes(wm) ? [wm, ...choices.wms] : choices.wms).map((w) => ({ v: w, l: wmName(w) })), 'wm')}
        {sel('lf-stream', t('altercpaGuarantee.leads.stream'), stream, t('altercpaGuarantee.leads.allStreams'),
          (stream && !choices.streams.includes(stream) ? [stream, ...choices.streams] : choices.streams).map((s) => ({ v: s, l: s })), 'stream')}
        {sel('lf-offer', t('altercpaGuarantee.leads.offer'), offer, t('altercpaGuarantee.leads.allOffers'),
          (offer && !choices.offers.includes(offer) ? [offer, ...choices.offers] : choices.offers).map((o) => ({ v: o, l: o })), 'offer')}
        {sel('lf-decision', t('altercpaGuarantee.leads.decision'), decision, t('altercpaGuarantee.leads.allDecisions'),
          GUARANTEE_DECISIONS.map((d) => ({ v: d, l: t(`altercpaGuarantee.decision.${decisionKey(d)}`) })), 'decision')}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input className="h-9 pl-8" value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={t('altercpaGuarantee.leads.search')} aria-label={t('altercpaGuarantee.leads.search')} />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="lf-test" checked={test} onCheckedChange={(v) => setParam('test', v ? '1' : null)} />
          <Label htmlFor="lf-test" className="text-xs">{t('altercpaGuarantee.leads.showTest')}</Label>
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" className="h-9 gap-1" onClick={() => patch((n) => {
            for (const k of ['wm', 'stream', 'offer', 'decision', 'q', 'test']) n.delete(k);
          })}>
            <X className="h-3.5 w-3.5" aria-hidden />{t('altercpaGuarantee.leads.reset')}
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="leads-total">
          {t('altercpaGuarantee.leads.total', { n: f.int(total) })}
        </span>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : q.isError ? (
        <LoadError text={t('altercpaGuarantee.loadError')} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">{t('altercpaGuarantee.leads.empty')}</p>
      ) : (
        <>
          <div className="hidden rounded-xl border bg-card shadow-sm xl:block">
            <table className="w-full table-fixed text-xs" data-testid="leads-table">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="w-[6.5rem] px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colArrived')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colPartner')}</th>
                  <th scope="col" className="hidden px-2 py-2 font-medium 2xl:table-cell">{t('altercpaGuarantee.leads.colStream')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colOffer')}</th>
                  <th scope="col" className="w-[8.5rem] px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colDecision')}</th>
                  <th scope="col" className="w-[6.5rem] px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colDecided')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colOperator')}</th>
                  <th scope="col" className="w-[7.5rem] px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colCrm')}</th>
                  <th scope="col" className="hidden w-[7.5rem] px-2 py-2 font-medium 2xl:table-cell">{t('altercpaGuarantee.leads.colMex')}</th>
                  <th scope="col" className="hidden px-2 py-2 font-medium 2xl:table-cell">{t('altercpaGuarantee.leads.colReason')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('altercpaGuarantee.leads.colCustomer')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lead_id} className="border-b align-top last:border-0">
                    <td className="px-2 py-1.5 tabular-nums">
                      {skopjeDmHm(r.arrived_at)}
                      {r.altercpa_id && <span className="block font-mono text-[10px] text-muted-foreground">#{r.altercpa_id}</span>}
                    </td>
                    {/* below 2xl the stream, the MEX parcel and the reason ride under their neighbours */}
                    <td className="break-words px-2 py-1.5">
                      {wmName(r.webmaster)}
                      <span className="block break-all font-mono text-[10px] text-muted-foreground 2xl:hidden">{r.stream}</span>
                    </td>
                    <td className="hidden break-all px-2 py-1.5 font-mono text-[11px] text-muted-foreground 2xl:table-cell">{r.stream}</td>
                    <td className="break-words px-2 py-1.5">{r.offer_name}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-col items-start gap-1">
                        <DecisionBadge decision={r.decision} />
                        {r.is_test && <TestBadge />}
                        {(r.reason ?? 0) > 0 && r.decision && r.decision !== 'approved' && (
                          <span className="text-[11px] leading-snug text-muted-foreground 2xl:hidden"><Reason r={r} /></span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 tabular-nums"><Decided r={r} /></td>
                    <td className="break-words px-2 py-1.5">{r.operator_name || (r.decided_by_altercpa_user ? `#${r.decided_by_altercpa_user}` : '—')}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex flex-col items-start gap-1">
                        <CrmChip displayId={r.display_id} status={r.crm_status} />
                        {r.display_id && <span className="2xl:hidden"><MexChip statusId={r.mex_status_id} trackingId={r.mex_tracking_id} /></span>}
                      </div>
                    </td>
                    <td className="hidden px-2 py-1.5 2xl:table-cell">{r.display_id ? <MexChip statusId={r.mex_status_id} trackingId={r.mex_tracking_id} /> : '—'}</td>
                    <td className="hidden break-words px-2 py-1.5 2xl:table-cell"><Reason r={r} /></td>
                    <td className="break-words px-2 py-1.5">{r.customer_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-2 xl:hidden" data-testid="leads-cards">
            {rows.map((r) => (
              <li key={r.lead_id} className="rounded-xl border bg-card p-3 text-xs shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold tabular-nums">{skopjeDmHm(r.arrived_at)}</div>
                    <div className="break-words text-muted-foreground">{wmName(r.webmaster)} · <span className="break-all font-mono text-[11px]">{r.stream}</span></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1"><DecisionBadge decision={r.decision} />{r.is_test && <TestBadge />}</div>
                </div>
                <div className="mt-1.5 break-words">{r.offer_name}</div>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted-foreground">{t('altercpaGuarantee.leads.colDecided')}</dt><dd className="min-w-0"><Decided r={r} /></dd>
                  <dt className="text-muted-foreground">{t('altercpaGuarantee.leads.colOperator')}</dt>
                  <dd className="min-w-0 break-words">{r.operator_name || (r.decided_by_altercpa_user ? `#${r.decided_by_altercpa_user}` : '—')}</dd>
                  <dt className="text-muted-foreground">{t('altercpaGuarantee.leads.colCrm')}</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1.5"><CrmChip displayId={r.display_id} status={r.crm_status} />{r.display_id && <MexChip statusId={r.mex_status_id} trackingId={r.mex_tracking_id} />}</dd>
                  {(r.reason ?? 0) > 0 && <><dt className="text-muted-foreground">{t('altercpaGuarantee.leads.colReason')}</dt><dd className="min-w-0 break-words"><Reason r={r} /></dd></>}
                  <dt className="text-muted-foreground">{t('altercpaGuarantee.leads.colCustomer')}</dt><dd className="min-w-0 break-words">{r.customer_name || '—'}</dd>
                </dl>
              </li>
            ))}
          </ul>

          <ResponsivePager page={page} totalPages={pages} t={t} onPageChange={(p) => patch((n) => n.set('page', String(p)), true)}
            desktop={<SmartPagination page={page} totalPages={pages} onPageChange={(p) => patch((n) => n.set('page', String(p)), true)} />} />
        </>
      )}
    </div>
  );
}

function TestBadge() {
  const { t } = useTranslation();
  return <span className="rounded-full border border-dashed px-2 py-0.5 text-[10px] text-muted-foreground">{t('altercpaGuarantee.leads.testBadge')}</span>;
}

function Decided({ r }: { r: JournalRow }) {
  const { t } = useTranslation();
  if (!r.decided_at) return <span className="text-muted-foreground">—</span>;
  const after = minutesBetween(r.arrived_at, r.decided_at);
  return (
    <span className="flex flex-col">
      <span>{skopjeDmHm(r.decided_at)}</span>
      {after != null && <span className="text-[11px] text-muted-foreground">{t('altercpaGuarantee.leads.after')} <Dur min={after} /></span>}
    </span>
  );
}

function Reason({ r }: { r: JournalRow }) {
  const { t } = useTranslation();
  const code = r.reason ?? 0;
  if (!code || !r.decision || r.decision === 'approved') return <span className="text-muted-foreground">—</span>;
  return <>{t(`altercpaGuarantee.reason.${code}`, { defaultValue: t('altercpaGuarantee.reasonCode', { n: code }) })}</>;
}

