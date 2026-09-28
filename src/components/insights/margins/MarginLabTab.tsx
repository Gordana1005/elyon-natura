import { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, Beaker, CheckCircle2, CircleSlash, FlaskConical, Search, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import { PROFIT_SOURCES, type ProfitProduct, type ProfitResponse } from '@/lib/insightsApi/profit';
import { OVERVIEW_COLOR_VARS, sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { useInsightsFormat, type InsightsFormat } from '../shared/useInsightsFormat';
import {
  floorPrice, floorStatus, isRealProduct, productUnit, simPriceFor, simulate, type FloorStatus,
} from '../profit/profitModel';
import { useProfitQuery } from '../profit/useProfitQuery';

/** Net profit per package the floor prices must clear — €7 by the old default, in денари. */
const DEFAULT_TARGET_MKD = 430;
const TOP = 25;

/**
 * Insights → Маржи (Margin Lab), owners only — on EXACTLY the Pure Profit
 * basis (the same GET /insights/profit answer): the period's collected sales
 * (cohort clock), all five sources, VAT, known product cost, the MEX courier
 * share, today's commission as the P&L charges it. What a package really
 * sells for, what each product nets per package, the price that would clear
 * the target, and a bundle simulator in денари (price, cost, return rate). A
 * product without a catalogue cost says "no cost" — it never "clears".
 */
export default function MarginLabTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { q } = useProfitQuery();
  const data = q.data;
  const errorText = (err: unknown) =>
    err instanceof Error && err.message === 'owners_only' ? t('insights.ownersOnly') : apiErrorText(err);

  if (!data) {
    return q.isError ? (
      <EmptyState icon={<AlertTriangle className="h-5 w-5" />} title={t('insights.loadFailed')} description={errorText(q.error)} size="sm"
        action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>} />
    ) : (
      <div className="space-y-4" aria-hidden>
        <Skeleton variant="card" className="h-20" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}</div>
        <Skeleton variant="card" className="h-80" />
      </div>
    );
  }
  return (
    <div className={cn('space-y-6 transition-opacity duration-200', OVERVIEW_COLOR_VARS, q.isPlaceholderData && 'opacity-60')} aria-busy={q.isFetching}>
      <MarginLabBody data={data} f={f} />
    </div>
  );
}

function MarginLabBody({ data, f }: { data: ProfitResponse; f: InsightsFormat }) {
  const { t } = f;
  const [target, setTarget] = useState(DEFAULT_TARGET_MKD);
  const vat = data.meta.vat.rate;
  const products = useMemo(() => data.products.filter((p) => isRealProduct(p) && p.packages > 0), [data.products]);

  // Net per package over the costed products — the same rows as the table below.
  const costed = products.filter((p) => p.cost_known);
  const costedPkgs = costed.reduce((s, p) => s + p.packages, 0);
  const costedNet = costed.reduce((s, p) => s + p.net_mkd, 0);
  const all = data.realized.all;
  const tot = data.cohort.total;
  const freeShare = tot.packages > 0 ? tot.free_packages / tot.packages : null;

  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-2xl space-y-1">
          <p className="text-sm text-muted-foreground">{t('insights.margins.intro')}</p>
          <ClockCaption clock="sale" />
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
          {t('insights.margins.target')}
          <Input type="number" min={0} step={10} value={target}
            onChange={(e) => setTarget(Math.max(0, Number(e.target.value) || 0))}
            className="h-9 w-24 text-right tabular-nums" aria-label={t('insights.margins.target')} />
          <span className="text-muted-foreground">{t('insights.margins.perPackage')}</span>
        </label>
      </section>

      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Kpi label={t('insights.margins.kpi.avg')} value={all.avg_mkd != null ? f.den(all.avg_mkd) : '—'}
          sub={t('insights.margins.kpi.paidPackages', { n: f.int(all.packages) })} />
        <Kpi label={t('insights.margins.kpi.median')} value={all.median_mkd != null ? f.den(all.median_mkd) : '—'}
          sub={all.p25_mkd != null && all.p75_mkd != null ? t('insights.margins.kpi.iqr', { lo: f.den(all.p25_mkd), hi: f.den(all.p75_mkd) }) : null} />
        <Kpi label={t('insights.margins.kpi.range')} value={all.min_mkd != null && all.max_mkd != null ? `${f.den(all.min_mkd)} – ${f.den(all.max_mkd)}` : '—'} small />
        <Kpi label={t('insights.margins.kpi.free')} value={f.pct(freeShare)}
          sub={t('insights.margins.kpi.freeSub', { n: f.int(tot.free_packages), of: f.int(tot.packages) })} />
        <Kpi label={t('insights.margins.kpi.netPerPkg')} value={costedPkgs > 0 ? f.den(Math.round(costedNet / costedPkgs)) : '—'}
          sub={t('insights.margins.kpi.netPerPkgSub', { n: f.int(costedPkgs) })}
          tone={costedPkgs > 0 ? (costedNet / costedPkgs >= target ? 'good' : 'bad') : undefined} />
        <Kpi label={t('insights.margins.kpi.coverage')} value={f.pct(tot.coverage_packages, 0)}
          sub={t('insights.margins.kpi.coverageSub', { n: f.int(tot.packages_uncosted) })}
          tone={tot.coverage_packages != null && tot.coverage_packages < 0.9 ? 'warn' : undefined} />
      </ul>

      <BySource data={data} f={f} />
      <FloorTable products={products} target={target} vat={vat} f={f} />
      <Simulator products={products} data={data} target={target} f={f} />
    </>
  );
}

function Kpi({ label, value, sub, tone, small }: {
  label: string; value: string; sub?: string | null; tone?: 'good' | 'bad' | 'warn'; small?: boolean;
}) {
  return (
    <li className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4',
      tone === 'warn' && 'border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30')}>
      <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
      <span className={cn('mt-1 block truncate font-semibold tabular-nums', small ? 'text-base sm:text-lg' : 'text-xl sm:text-2xl',
        tone === 'good' ? STATUS_TEXT.good : tone === 'bad' ? STATUS_TEXT.critical : 'text-card-foreground')}>{value}</span>
      {sub && <span className="text-xs tabular-nums text-muted-foreground">{sub}</span>}
    </li>
  );
}

function BySource({ data, f }: { data: ProfitResponse; f: InsightsFormat }) {
  const { t } = f;
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className="text-base font-semibold">{t('insights.margins.bySource.title')}</h2>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.profit.table.line')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.bySource.avg')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.bySource.median')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.bySource.packages')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.bySource.free')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.profitPerSale')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.margin')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.returnRate')}</th>
            </tr>
          </thead>
          <tbody>
            {PROFIT_SOURCES.map((s) => {
              const d = data.realized[s];
              const r = data.cohort.by_source.find((x) => x.key === s);
              if (!r) return null;
              return (
                <tr key={s} className="border-b last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-[3px] w-4 rounded-full" style={{ background: sourceColorVar(s) }} aria-hidden />{f.sourceLabel(s)}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{d?.avg_mkd != null ? f.den(d.avg_mkd) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{d?.median_mkd != null ? f.den(d.median_mkd) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.int(r.packages)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.pct(r.packages > 0 ? r.free_packages / r.packages : null)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', (r.profit_per_sale_mkd ?? 0) < 0 && STATUS_TEXT.critical)}>{r.profit_per_sale_mkd != null ? f.den(r.profit_per_sale_mkd) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.pct(r.margin)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.pct(r.return_rate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('insights.margins.bySource.note')}</p>
    </section>
  );
}

const STATUS_ICON: Record<FloorStatus, typeof CheckCircle2> = { clears: CheckCircle2, below: XCircle, no_cost: CircleSlash };
const STATUS_CLS: Record<FloorStatus, string> = {
  clears: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
  below: 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300',
  no_cost: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
};

function FloorTable({ products, target, vat, f }: { products: ProfitProduct[]; target: number; vat: number; f: InsightsFormat }) {
  const { t } = f;
  const titleId = useId();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const ql = q.trim().toLocaleLowerCase();
    return products
      .filter((p) => !ql || (p.name ?? '').toLocaleLowerCase().includes(ql))
      .sort((a, b) => b.packages - a.packages || b.revenue_mkd - a.revenue_mkd)
      .map((p) => {
        const u = productUnit(p);
        const status = floorStatus(u, target);
        const floor = u ? floorPrice(u.cost, u.courier, target, vat, p.commission_share ?? 0) : null;
        return { p, u, status, floor, uplift: floor != null && u && u.price > 0 ? floor / u.price - 1 : null };
      });
  }, [products, q, target, vat]);
  const visible = all || q ? rows : rows.slice(0, TOP);
  const counts = { clears: 0, below: 0, no_cost: 0 } as Record<FloorStatus, number>;
  for (const r of rows) counts[r.status]++;

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
            <FlaskConical className="h-4 w-4 text-muted-foreground" aria-hidden />{t('insights.margins.floor.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('insights.margins.floor.help', { gross: f.pct(1 + vat, 0), target: f.den(target) })}</p>
          <p className="mt-1 flex flex-wrap gap-2 text-[11px]">
            {(['clears', 'below', 'no_cost'] as const).map((s) => {
              const Icon = STATUS_ICON[s];
              return (
                <span key={s} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium', STATUS_CLS[s])}>
                  <Icon className="h-3 w-3" aria-hidden />{t(`insights.margins.status.${s}`)} · {f.int(counts[s])}
                </span>
              );
            })}
          </p>
        </div>
        <label className="relative">
          <span className="sr-only">{t('insights.profit.prod.search')}</span>
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('insights.profit.prod.search')} className="h-9 w-48 pl-8" />
        </label>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.profit.prod.product')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.packages')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.realized')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.vat')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.unitCost')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.courier')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.commission')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.net')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.floor')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.uplift')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.margins.floor.status')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">{t('insights.profit.prod.none')}</td></tr>
            ) : visible.map(({ p, u, status, floor, uplift }) => {
              const Icon = STATUS_ICON[status];
              return (
                <tr key={p.key} className="border-b last:border-0">
                  <th scope="row" className="max-w-[16rem] px-3 py-2 text-left font-medium">
                    <span className="block truncate" title={p.name ?? p.key}>{p.name ?? p.key}</span>
                    {p.free_packages > 0 && <span className="text-[11px] font-normal text-muted-foreground">{t('insights.profit.prod.freeN', { n: f.int(p.free_packages) })}</span>}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums">{f.int(p.packages)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{u ? f.den(Math.round(u.price)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{u ? f.den(Math.round(u.vat)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{u?.cost != null ? f.den(Math.round(u.cost)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{u ? f.den(Math.round(u.courier)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{u ? f.den(Math.round(u.commission)) : '—'}</td>
                  <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', u?.net != null && (u.net >= target ? STATUS_TEXT.good : u.net < 0 ? STATUS_TEXT.critical : STATUS_TEXT.warning))}>
                    {u?.net != null ? f.den(Math.round(u.net)) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{floor != null ? f.den(Math.round(floor)) : '—'}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', uplift != null && (uplift > 0 ? STATUS_TEXT.critical : STATUS_TEXT.good))}>
                    {uplift == null ? '—' : `${uplift > 0 ? '+' : ''}${f.pct(uplift, 0)}`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', STATUS_CLS[status])}>
                      <Icon className="h-3 w-3" aria-hidden />{t(`insights.margins.status.${status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{t('insights.margins.floor.note')}</span>
        {!q && rows.length > TOP && (
          <button type="button" onClick={() => setAll((v) => !v)} className="rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
            {all ? t('insights.profit.prod.showTop', { n: TOP }) : t('insights.profit.prod.showAll', { n: f.int(rows.length) })}
          </button>
        )}
      </div>
    </section>
  );
}

function Simulator({ products, data, target, f }: { products: ProfitProduct[]; data: ProfitResponse; target: number; f: InsightsFormat }) {
  const { t } = f;
  const titleId = useId();
  const sorted = useMemo(() => [...products].sort((a, b) => b.packages - a.packages), [products]);
  const [key, setKey] = useState<string>('');
  const sel = sorted.find((p) => p.key === key) ?? sorted[0];
  const unit = sel ? productUnit(sel) : null;
  const [paid, setPaid] = useState(3);
  const [bonus, setBonus] = useState(0);
  const [price, setPrice] = useState(0);
  const [cost, setCost] = useState<string>('');
  const [returnPct, setReturnPct] = useState(10);
  const [commPct, setCommPct] = useState(0);
  const [lead, setLead] = useState(0);
  const [deliver, setDeliver] = useState(data.meta.courier.deliver_mkd);

  // A new product resets the scenario to what that product really did.
  useEffect(() => {
    if (!sel) return;
    const u = productUnit(sel);
    setPrice(Math.round((u?.price ?? 0) * Math.max(1, paid + bonus)));
    setCost(u?.cost != null ? String(Math.round(u.cost)) : '');
    setReturnPct(Math.round((sel.return_rate ?? data.cohort.total.return_rate ?? 0) * 100));
    setCommPct(Math.round((sel.commission_share ?? 0) * 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.key]);

  if (!sel) return null;
  const input = {
    price, paidPackages: paid, bonusPackages: bonus,
    costPerPackage: cost.trim() === '' ? null : Math.max(0, Number(cost) || 0),
    deliverMkd: Math.max(0, deliver), returnMkd: data.meta.courier.return_mkd,
    returnRate: returnPct / 100, vatRate: data.meta.vat.rate, commissionShare: commPct / 100, leadCostMkd: lead,
  };
  const r = simulate(input);
  const need = simPriceFor(input, target);
  const pass = r.netPerPackage != null && r.netPerPackage >= target;

  const num = (label: string, value: number, set: (v: number) => void, opts: { min?: number; step?: number; suffix?: string } = {}) => (
    <label className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <Input type="number" min={opts.min ?? 0} step={opts.step ?? 1} value={value}
          onChange={(e) => set(Math.max(opts.min ?? 0, Number(e.target.value) || 0))} className="h-9 tabular-nums" />
        {opts.suffix && <span className="text-xs text-muted-foreground">{opts.suffix}</span>}
      </span>
    </label>
  );

  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div>
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold"><Beaker className="h-4 w-4 text-muted-foreground" aria-hidden />{t('insights.margins.sim.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.margins.sim.help')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <label className="col-span-2 space-y-1">
          <span className="text-xs text-muted-foreground">{t('insights.margins.sim.product')}</span>
          <select value={sel.key} onChange={(e) => setKey(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {sorted.map((p) => <option key={p.key} value={p.key}>{p.name ?? p.key}{p.cost_known ? '' : ` — ${t('insights.profit.prod.noCost')}`}</option>)}
          </select>
        </label>
        {num(t('insights.margins.sim.paid'), paid, setPaid, { min: 1 })}
        {num(t('insights.margins.sim.bonus'), bonus, setBonus)}
        {num(t('insights.margins.sim.price'), price, setPrice, { step: 10, suffix: 'ден' })}
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t('insights.margins.sim.cost')}</span>
          <span className="flex items-center gap-1">
            <Input type="number" min={0} step={5} value={cost} placeholder={t('insights.profit.prod.noCost')}
              onChange={(e) => setCost(e.target.value)} className="h-9 tabular-nums" />
            <span className="text-xs text-muted-foreground">ден</span>
          </span>
        </label>
        {num(t('insights.margins.sim.returnRate'), returnPct, (v) => setReturnPct(Math.min(100, v)), { suffix: '%' })}
        {num(t('insights.margins.sim.delivery'), deliver, setDeliver, { step: 10, suffix: 'ден' })}
        {num(t('insights.margins.sim.commShare'), commPct, (v) => setCommPct(Math.min(100, v)), { suffix: '%' })}
        {num(t('insights.margins.sim.lead'), lead, setLead, { step: 10, suffix: 'ден' })}
      </div>
      {unit && (
        <p className="text-[11px] text-muted-foreground">
          {t('insights.margins.sim.actual', { price: f.den(Math.round(unit.price)), n: f.int(sel.packages), ret: f.pct(sel.return_rate) })}
        </p>
      )}

      {r.netExpected == null ? (
        <p className={cn('flex items-center gap-2 rounded-lg border p-3 text-sm', STATUS_CLS.no_cost)}>
          <CircleSlash className="h-4 w-4 shrink-0" aria-hidden />{t('insights.margins.sim.needCost')}
        </p>
      ) : (
        <div className={cn('rounded-lg border p-4', pass ? STATUS_CLS.clears : STATUS_CLS.below)}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-center gap-2 text-lg font-bold">
              {pass ? <CheckCircle2 className="h-5 w-5" aria-hidden /> : <XCircle className="h-5 w-5" aria-hidden />}
              {pass ? t('insights.margins.sim.pass') : t('insights.margins.sim.fail')}
            </div>
            <div className="text-sm tabular-nums">
              {t('insights.margins.sim.perPackage', { n: f.int(r.packages), price: f.den(Math.round(r.perPackagePrice)) })}
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <SimLine label={t('insights.margins.sim.price')} v={price} f={f} />
            <SimLine label={t('insights.profit.step.vat', { pct: f.pct(data.meta.vat.rate, 0) })} v={-r.vat} f={f} />
            <SimLine label={t('insights.profit.step.cogs_known')} v={-(r.cogs ?? 0)} f={f} />
            <SimLine label={t('insights.margins.sim.delivery')} v={-r.courier} f={f} />
            <SimLine label={t('insights.profit.step.commission')} v={-r.commission} f={f} />
            <SimLine label={t('insights.profit.step.lead')} v={-r.lead} f={f} />
            <SimLine label={t('insights.margins.sim.netDelivered')} v={r.netDelivered ?? 0} f={f} strong />
            <SimLine label={t('insights.margins.sim.netExpected', { pct: f.int(returnPct) })} v={r.netExpected} f={f} strong />
          </dl>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span>{t('insights.margins.sim.netPerPkg')}: <b className="tabular-nums">{f.den(Math.round(r.netPerPackage ?? 0))}</b> · {t('insights.margins.sim.targetIs', { v: f.den(target) })}</span>
            {!pass && need != null && (
              <span>{t('insights.margins.sim.needPrice', { price: f.den(Math.ceil(need / 10) * 10), per: f.den(Math.round(need / r.packages)) })}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SimLine({ label, v, f, strong }: { label: string; v: number; f: InsightsFormat; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'border-t pt-1 font-semibold')}>
      <dt className={cn(!strong && 'text-muted-foreground')}>{label}</dt>
      <dd className={cn('tabular-nums', v < 0 && strong && STATUS_TEXT.critical)}>{v < 0 ? `−${f.den(Math.round(-v))}` : f.den(Math.round(v))}</dd>
    </div>
  );
}
