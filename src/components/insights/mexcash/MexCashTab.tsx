import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Banknote, CalendarRange, FlaskConical, Info, PackageCheck, Truck, Undo2 } from 'lucide-react';
import { apiGetInsightsMexCash, MEX_ACCOUNTS, type MexAccount, type MexCashDay, type MexCashResponse } from '@/lib/insightsApi/mexCash';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { dm } from '../overview/useOverviewFormat';
import { DayColumns, Section, Tile } from '../returns/RsBits';
import { useInsightsFormat, type InsightsFormat } from '../shared/useInsightsFormat';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';

/**
 * The two MEX accounts — a part-to-whole of ONE measure (what MEX collected),
 * so an ordinal slate pair, never a department hue (blue / orange ARE Тим
 * Маџари In / Out elsewhere: colour follows the entity). The same validated pair
 * as Sales → buyers (salesPalette BUYER_*); every mark carries the account's name
 * in the legend, the tooltip and the table.
 */
const ACCOUNT_TONE: Record<MexAccount, string> = {
  natura: 'bg-[#334155] dark:bg-[#cbd5e1]',
  bio_natural: 'bg-[#94a3b8] dark:bg-[#64748b]',
};

/** Long periods read by month (a year of daily columns is a comb). */
const MONTH_FROM_DAYS = 62;

type Row = { d: string } & Record<MexAccount, { parcels: number; cod: number | null; returned: number }>;

/** Days → rows (by month on a long period), newest first for the table. */
function rowsOf(days: MexCashDay[], byMonth: boolean): Row[] {
  const out = new Map<string, Row>();
  for (const day of days) {
    const k = byMonth ? `${day.d.slice(0, 7)}-01` : day.d;
    const r = out.get(k) ?? {
      d: k,
      natura: { parcels: 0, cod: null, returned: 0 },
      bio_natural: { parcels: 0, cod: null, returned: 0 },
    };
    for (const a of MEX_ACCOUNTS) {
      const x = day[a];
      r[a].parcels += x?.parcels ?? 0;
      r[a].returned += x?.returned ?? 0;
      if (x?.cod_mkd != null) r[a].cod = (r[a].cod ?? 0) + x.cod_mkd;
    }
    out.set(k, r);
  }
  return [...out.values()];
}

/**
 * Insights → Наплата (MEX) (owner 02.10.2026): what MEX collected from the
 * buyers — on the day MEX delivered the parcel, per MEX account — the parcels it
 * returned, MEX's settlement periods (half-months 1–15 / 16–end, the periods its
 * fee invoices bill) and what it holds right now. It is NOT money in our bank:
 * MEX pays it out later, in lumps; no payout date is in any data the CRM holds
 * yet. Owners see денари (meta.money); admins/managers the same page counted.
 *
 * Data: GET /insights/mex-cash (insights_mex_cash, migration 20260947001300).
 * In a DEV build `?mcFixture=1` renders the synthetic fixture instead.
 */
export default function MexCashTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const period = useInsightsPeriod();
  const range = period.range;
  const fixture = import.meta.env.DEV && sp.get('mcFixture') === '1';

  const load = useCallback(async (signal?: AbortSignal): Promise<MexCashResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/mexcash.sample.json');
      return structuredClone(m.default) as unknown as MexCashResponse;
    }
    return apiGetInsightsMexCash({ from: range.from, to: range.to }, signal);
  }, [fixture, range.from, range.to]);

  const q = useQuery({
    queryKey: ['insights-mex-cash', user?.id, range.from, range.to, fixture],
    queryFn: ({ signal }) => load(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;

  return (
    <div className="space-y-5">
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}
      <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-snug text-muted-foreground">
        <Info className="mt-px h-4 w-4 shrink-0" aria-hidden />
        <span>{t('insights.mexCash.intro')}</span>
      </p>

      {!data ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={apiErrorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : (
          <MexCashSkeleton />
        )
      ) : (
        <div aria-busy={q.isFetching} className={cn('space-y-5 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          <MexCashBody data={data} f={f} />
        </div>
      )}
    </div>
  );
}

function MexCashBody({ data, f }: { data: MexCashResponse; f: InsightsFormat }) {
  const { t } = f;
  const money = data.meta.money === true;
  const acc = (a: MexAccount) => t(`insights.mexCash.account.${a}`);
  const val = (cod: number | null | undefined, parcels: number) => (money && cod != null ? f.den(cod) : f.int(parcels));

  const total = useMemo(() => {
    const parcels = MEX_ACCOUNTS.reduce((s, a) => s + (data.total?.[a]?.parcels ?? 0), 0);
    const cod = MEX_ACCOUNTS.reduce((s, a) => s + (data.total?.[a]?.cod_mkd ?? 0), 0);
    const returned = MEX_ACCOUNTS.reduce((s, a) => s + (data.total?.[a]?.returned ?? 0), 0);
    const returnedCod = MEX_ACCOUNTS.reduce((s, a) => s + (data.total?.[a]?.returned_cod_mkd ?? 0), 0);
    return { parcels, cod, returned, returnedCod };
  }, [data]);

  const byMonth = (data.days?.length ?? 0) > MONTH_FROM_DAYS;
  const rows = useMemo(() => rowsOf(data.days ?? [], byMonth), [data, byMonth]);
  const columns = useMemo(() => rows.map((r) => ({
    d: r.d,
    total: MEX_ACCOUNTS.reduce((s, a) => s + (money ? r[a].cod ?? 0 : r[a].parcels), 0),
    segs: MEX_ACCOUNTS.map((a) => ({ key: a, value: money ? r[a].cod ?? 0 : r[a].parcels })),
  })), [rows, money]);
  const rowLabel = (d: string) => (byMonth ? `${d.slice(5, 7)}.${d.slice(0, 4)}` : dm(d, true));
  const asOf = data.meta.data_through ? skopjeHm(data.meta.data_through) : '';

  return (
    <>
      {/* The period: collected on the delivery day, per account, and what came back. */}
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={Banknote} label={t(money ? 'insights.mexCash.kpi.collected' : 'insights.mexCash.kpi.delivered')}
          value={val(total.cod, total.parcels)}
          sub={money ? t('insights.mexCash.parcelsN', { n: f.int(total.parcels), count: total.parcels }) : t('insights.mexCash.kpi.deliveredSub')} />
        {MEX_ACCOUNTS.map((a) => (
          <Tile key={a} label={acc(a)} value={val(data.total?.[a]?.cod_mkd, data.total?.[a]?.parcels ?? 0)}
            sub={money ? t('insights.mexCash.parcelsN', { n: f.int(data.total?.[a]?.parcels ?? 0), count: data.total?.[a]?.parcels ?? 0 }) : t('insights.mexCash.kpi.deliveredSub')}>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn('h-2.5 w-2.5 rounded-full', ACCOUNT_TONE[a])} aria-hidden />{t(`insights.mexCash.account.${a}Hint`)}
            </span>
          </Tile>
        ))}
        <Tile icon={Undo2} label={t('insights.mexCash.kpi.returned')} value={f.int(total.returned)}
          sub={money ? t('insights.mexCash.kpi.returnedSub', { v: f.den(total.returnedCod) }) : t('insights.mexCash.kpi.returnedSubNoMoney')} />
      </ul>

      {/* Per day (per month on a long period). */}
      <Section
        title={t(byMonth ? 'insights.mexCash.daily.titleMonth' : 'insights.mexCash.daily.title')}
        clock="delivered"
        sub={asOf ? t('insights.mexCash.asOf', { time: asOf }) : undefined}
      >
        {columns.length > 1 && (
          <DayColumns
            columns={columns}
            parts={MEX_ACCOUNTS.map((a) => ({ key: a, label: acc(a), tone: ACCOUNT_TONE[a] }))}
            granularity={byMonth ? 'month' : 'day'}
            label={t('insights.mexCash.daily.title')}
            fmt={money ? (v) => f.den(v) : undefined}
            f={f}
          />
        )}
        <DayTable rows={[...rows].reverse()} money={money} rowLabel={rowLabel} f={f} />
      </Section>

      {/* MEX's settlement periods — independent of the period above. */}
      <Section
        title={<span className="inline-flex items-center gap-1.5"><CalendarRange className="h-3.5 w-3.5" aria-hidden />{t('insights.mexCash.halves.title')}</span>}
        sub={t('insights.mexCash.halves.sub')}
      >
        <HalvesTable data={data} money={money} f={f} />
        <p className="text-[11px] leading-snug text-muted-foreground">{t('insights.mexCash.halves.payouts')}</p>
      </Section>

      {/* What MEX holds right now (no clock). */}
      <Section title={t('insights.mexCash.now.title')} clock="now">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NowTile icon={Truck} label={t('insights.mexCash.now.courier')} hint={t('insights.mexCash.now.courierHint')}
            parts={MEX_ACCOUNTS.map((a) => ({ a, n: data.now?.[a]?.courier ?? 0, cod: data.now?.[a]?.courier_cod_mkd }))}
            money={money} acc={acc} f={f} />
          <NowTile icon={PackageCheck} label={t('insights.mexCash.now.label')} hint={t('insights.mexCash.now.labelHint')}
            parts={MEX_ACCOUNTS.map((a) => ({ a, n: data.now?.[a]?.label ?? 0, cod: data.now?.[a]?.label_cod_mkd }))}
            money={money} acc={acc} f={f} />
        </ul>
      </Section>
    </>
  );
}

/** Day rows: a table from md, cards below it (the UI law: no sideways scroll). */
function DayTable({ rows, money, rowLabel, f }: {
  rows: Row[]; money: boolean; rowLabel: (d: string) => string; f: InsightsFormat;
}) {
  const { t } = f;
  const cell = (x: Row[MexAccount]) => (
    <>
      <span className="block font-medium">{money && x.cod != null ? f.den(x.cod) : f.int(x.parcels)}</span>
      {money && <span className="block text-[11px] text-muted-foreground">{t('insights.mexCash.parcelsN', { n: f.int(x.parcels), count: x.parcels })}</span>}
    </>
  );
  const sum = (r: Row) => ({
    parcels: MEX_ACCOUNTS.reduce((s, a) => s + r[a].parcels, 0),
    cod: money ? MEX_ACCOUNTS.reduce((s, a) => s + (r[a].cod ?? 0), 0) : null,
    returned: MEX_ACCOUNTS.reduce((s, a) => s + r[a].returned, 0),
  });
  if (!rows.length) return <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.mexCash.empty')}</p>;
  return (
    <>
      <div className="hidden max-h-[28rem] overflow-auto md:block">
        <table className="w-full text-sm tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t('insights.mexCash.col.day')}</th>
              {MEX_ACCOUNTS.map((a) => <th key={a} scope="col" className="px-2 py-1.5 text-right font-medium">{t(`insights.mexCash.account.${a}`)}</th>)}
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.mexCash.col.total')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.mexCash.col.returned')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = sum(r);
              return (
                <tr key={r.d} className="border-b align-top last:border-0">
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">{rowLabel(r.d)}</th>
                  {MEX_ACCOUNTS.map((a) => <td key={a} className="px-2 py-1.5 text-right">{cell(r[a])}</td>)}
                  <td className="px-2 py-1.5 text-right">{cell({ parcels: s.parcels, cod: s.cod, returned: s.returned })}</td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{f.int(s.returned)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => {
          const s = sum(r);
          return (
            <li key={r.d} className="rounded-lg border p-3 text-sm tabular-nums">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{rowLabel(r.d)}</span>
                <span className="font-semibold">{money && s.cod != null ? f.den(s.cod) : f.int(s.parcels)}</span>
              </div>
              <dl className="mt-1 space-y-0.5 text-xs">
                {MEX_ACCOUNTS.map((a) => (
                  <div key={a} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t(`insights.mexCash.account.${a}`)}</dt>
                    <dd>{money && r[a].cod != null ? `${f.den(r[a].cod)} · ` : ''}{t('insights.mexCash.parcelsN', { n: f.int(r[a].parcels), count: r[a].parcels })}</dd>
                  </div>
                ))}
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{t('insights.mexCash.col.returned')}</dt>
                  <dd>{f.int(s.returned)}</dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The last 6 settlement periods, newest first; the running one is marked. */
function HalvesTable({ data, money, f }: { data: MexCashResponse; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const halves = data.halves ?? [];
  const label = (from: string, to: string) => `${dm(from)} – ${dm(to, true)}`;
  const figure = (parcels: number, cod: number | undefined) => (money && cod != null ? f.den(cod) : f.int(parcels));
  const tag = (complete: boolean) => (complete
    ? null
    : <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">{t('insights.mexCash.halves.running')}</span>);
  if (!halves.length) return <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.mexCash.empty')}</p>;
  return (
    <>
      <div className="hidden overflow-auto md:block">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-left font-medium">{t('insights.mexCash.col.period')}</th>
              {MEX_ACCOUNTS.map((a) => <th key={a} scope="col" className="px-2 py-1.5 text-right font-medium">{t(`insights.mexCash.account.${a}`)}</th>)}
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.mexCash.col.total')}</th>
            </tr>
          </thead>
          <tbody>
            {halves.map((h) => {
              const parcels = MEX_ACCOUNTS.reduce((s, a) => s + (h[a]?.parcels ?? 0), 0);
              const cod = money ? MEX_ACCOUNTS.reduce((s, a) => s + (h[a]?.cod_mkd ?? 0), 0) : undefined;
              return (
                <tr key={h.from} className={cn('border-b align-top last:border-0', !h.complete && 'bg-muted/30')}>
                  <th scope="row" className="px-2 py-1.5 text-left font-medium">{label(h.from, h.to)}{tag(h.complete)}</th>
                  {MEX_ACCOUNTS.map((a) => (
                    <td key={a} className="px-2 py-1.5 text-right">
                      <span className="block font-medium">{figure(h[a]?.parcels ?? 0, h[a]?.cod_mkd)}</span>
                      {money && <span className="block text-[11px] text-muted-foreground">{t('insights.mexCash.parcelsN', { n: f.int(h[a]?.parcels ?? 0), count: h[a]?.parcels ?? 0 })}</span>}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">
                    <span className="block font-semibold">{figure(parcels, cod)}</span>
                    {money && <span className="block text-[11px] text-muted-foreground">{t('insights.mexCash.parcelsN', { n: f.int(parcels), count: parcels })}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {halves.map((h) => {
          const parcels = MEX_ACCOUNTS.reduce((s, a) => s + (h[a]?.parcels ?? 0), 0);
          const cod = money ? MEX_ACCOUNTS.reduce((s, a) => s + (h[a]?.cod_mkd ?? 0), 0) : undefined;
          return (
            <li key={h.from} className={cn('rounded-lg border p-3 text-sm tabular-nums', !h.complete && 'bg-muted/30')}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{label(h.from, h.to)}{tag(h.complete)}</span>
                <span className="font-semibold">{figure(parcels, cod)}</span>
              </div>
              <dl className="mt-1 space-y-0.5 text-xs">
                {MEX_ACCOUNTS.map((a) => (
                  <div key={a} className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t(`insights.mexCash.account.${a}`)}</dt>
                    <dd>{money && h[a]?.cod_mkd != null ? `${f.den(h[a]!.cod_mkd)} · ` : ''}{t('insights.mexCash.parcelsN', { n: f.int(h[a]?.parcels ?? 0), count: h[a]?.parcels ?? 0 })}</dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function NowTile({ icon: Icon, label, hint, parts, money, acc, f }: {
  icon: typeof Truck; label: string; hint: string;
  parts: { a: MexAccount; n: number; cod: number | undefined }[];
  money: boolean; acc: (a: MexAccount) => string; f: InsightsFormat;
}) {
  const { t } = f;
  const n = parts.reduce((s, p) => s + p.n, 0);
  const cod = parts.reduce((s, p) => s + (p.cod ?? 0), 0);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden />{label}</span>
      <span className="text-xl font-semibold tabular-nums">{money ? f.den(cod) : f.int(n)}</span>
      {money && <span className="text-[11px] text-muted-foreground">{t('insights.mexCash.parcelsN', { n: f.int(n), count: n })}</span>}
      <dl className="space-y-0.5 text-xs tabular-nums">
        {parts.map((p) => (
          <div key={p.a} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{acc(p.a)}</dt>
            <dd>{money && p.cod != null ? `${f.den(p.cod)} · ` : ''}{t('insights.mexCash.parcelsN', { n: f.int(p.n), count: p.n })}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </li>
  );
}

function MexCashSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
      </div>
      <Skeleton variant="card" className="h-64" />
      <Skeleton variant="card" className="h-48" />
    </div>
  );
}
