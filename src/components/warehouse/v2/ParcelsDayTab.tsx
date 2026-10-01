import { useId, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Gift, Package, PackageX, Truck, X } from 'lucide-react';
import { Chip, LABEL } from '@/components/assigner/parts';
import { Section, Tile } from '@/components/insights/returns/RsBits';
import { isYmd, skopjeToday } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { departmentLabel } from '@/lib/orderSource';
import { apiStockV2Parcels } from '@/lib/stockV2Api';
import type { ParcelStatusGroup, StockCount, StockParcelRow, StockParcelsDay } from '@/lib/stockV2Types';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import {
  DayTimeStepper, Empty, Failed, Loading, Pager, Pill, WarehousePicker, patchParams, readPageOffset,
  useStockAccess, useStockHealthLite, useWarehouseOptions,
} from './shared';
import { HOURLY_COLOR_VARS, PARCEL_STATES, accountLabel, STATUS_GROUPS, STATUS_TONE, fmtQty, hasKey, s2Var } from './stockV2Model';

const LIMIT = 50;
const CITY_ROWS = 12;

const STATE_TONE: Record<string, 'emerald' | 'amber' | 'red' | 'slate' | 'blue'> = {
  moved: 'emerald', partial: 'amber', unmapped: 'red', no_lines: 'red', no_route: 'red',
  waiting_lines: 'blue', test_phone: 'slate', excluded: 'slate', pre_opening: 'slate',
};

/**
 * Магацин → Пратки: the parcels of one Skopje day as stock sees them — how many, how many units
 * (gifts apart), what came back; created vs picked up per hour; split by MEX account, department,
 * status and city; then the parcels themselves (cards below lg, a table from lg) with every time on the Skopje clock
 * and the stock state of each. COD only for owners (the key is absent for everyone else).
 * URL: day · wh · account · dept · status · city · state · page.
 */
export function ParcelsDayTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const access = useStockAccess();
  const [sp, setSp] = useSearchParams();
  const today = skopjeToday();
  const dayParam = sp.get('day');
  const day = isYmd(dayParam) && dayParam <= today ? dayParam : today;
  const wh = sp.get('wh') || '';
  const account = sp.get('account');
  const dept = sp.get('dept');
  const status = sp.get('status');
  const city = sp.get('city');
  const state = sp.get('state');
  const offset = readPageOffset(sp.get('page'), LIMIT);
  const set = (patch: Record<string, string | null>) => setSp((p) => patchParams(p, patch), { replace: true });

  const health = useStockHealthLite();
  const options = useWarehouseOptions(f, { isOwner: access.isOwner, health: health.data });
  const q = useQuery<StockParcelsDay>({
    queryKey: ['stock2', 'parcels', day, wh, account, dept, status, city, state, offset],
    queryFn: () => apiStockV2Parcels({ day, warehouse: wh || null, account, department: dept, status, city, state, limit: LIMIT, offset }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchInterval: day === today ? 5 * 60_000 : false,
  });
  const d = q.data;
  const money = !!d && d.rows.some((r) => hasKey(r, 'cod_mkd'));
  const filters: { key: string; label: string }[] = [
    account ? { key: 'account', label: accountLabel(account) } : null,
    dept ? { key: 'dept', label: departmentLabel(t, dept) ?? dept } : null,
    status ? { key: 'status', label: t(`stock2.status.${status}`, { defaultValue: status }) } : null,
    city ? { key: 'city', label: city } : null,
    state ? { key: 'state', label: t(`stock2.state.${state}`, { defaultValue: state }) } : null,
  ].filter(Boolean) as { key: string; label: string }[];

  return (
    <div className={cn('space-y-4', HOURLY_COLOR_VARS)} data-testid="stock2-parcels-tab">
      <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <DayTimeStepper day={day} today={today} onDay={(v) => set({ day: v === today ? null : v })} f={f} />
          {options.length > 1 && <WarehousePicker value={wh} onChange={(v) => set({ wh: v || null })} options={options} allowAll f={f} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className={LABEL}>{t('stock2.parcels.state')}</span>
            <select className="h-8 max-w-full rounded-md border bg-background px-2 text-sm" value={state ?? ''} onChange={(e) => set({ state: e.target.value || null })}>
              <option value="">{t('stock2.common.all')}</option>
              {PARCEL_STATES.map((s) => <option key={s} value={s}>{t(`stock2.state.${s}`)}</option>)}
            </select>
          </label>
          {filters.map((x) => (
            <button key={x.key} type="button" onClick={() => set({ [x.key]: null })}
              className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-foreground/40 bg-muted px-2.5 text-xs font-medium"
              aria-label={t('stock2.common.removeFilter', { name: x.label })}>
              <span className="min-w-0 break-words text-left">{x.label}</span><X className="h-3 w-3 shrink-0" aria-hidden />
            </button>
          ))}
        </div>
      </section>

      {q.isLoading ? <Loading /> : q.isError ? <Failed error={q.error} onRetry={() => void q.refetch()} /> : !d ? null : (
        <>
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('stock2.parcels.totalsTitle')}>
            <Tile icon={Package} label={t('stock2.parcels.tParcels')} value={f.int(d.totals.parcels)} sub={t('stock2.parcels.tParcelsSub')} />
            <Tile icon={Truck} label={t('stock2.parcels.tUnits')} value={fmtQty(d.totals.units, f.lang)} sub={t('stock2.parcels.tUnitsSub')} />
            <Tile icon={Gift} label={t('stock2.parcels.tGifts')} value={fmtQty(d.totals.gift_units, f.lang)}
              sub={d.totals.units > 0 ? t('stock2.parcels.tGiftsSub', { pct: f.pct(d.totals.gift_units / d.totals.units) }) : undefined} />
            <Tile icon={PackageX} label={t('stock2.parcels.tReturned')} value={fmtQty(d.totals.returned_units, f.lang)} sub={t('stock2.parcels.tReturnedSub')} />
          </ul>

          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            <Section title={t('stock2.parcels.hourlyTitle')} sub={t('stock2.parcels.hourlySub')}>
              <Hourly hourly={d.hourly} f={f} />
            </Section>
            <Section title={t('stock2.parcels.byStatus')} sub={t('stock2.parcels.clickToFilter')}>
              <Breakdown rows={STATUS_GROUPS.map((g) => d.by_status.find((s) => s.key === g) ?? { key: g, parcels: 0, units: 0 })
                .concat(d.by_status.filter((s) => !STATUS_GROUPS.includes(s.key as ParcelStatusGroup)))}
                label={(k) => t(`stock2.status.${k}`, { defaultValue: k })} tone={(k) => STATUS_TONE[k as ParcelStatusGroup] ?? 'bg-muted-foreground'}
                active={status} onPick={(k) => set({ status: k === status ? null : k })} f={f} />
            </Section>
            <Section title={t('stock2.parcels.byAccount')} sub={t('stock2.parcels.clickToFilter')}>
              <Breakdown rows={d.by_account} label={accountLabel} tone={() => 'bg-[#4f46e5] dark:bg-[#818cf8]'}
                active={account} onPick={(k) => set({ account: k === account ? null : k })} f={f} />
            </Section>
            <Section title={t('stock2.parcels.byDepartment')} sub={t('stock2.parcels.clickToFilter')}>
              <Breakdown rows={d.by_department} label={(k) => departmentLabel(t, k) ?? (k || t('stock2.parcels.noDepartment'))}
                tone={() => 'bg-[#4f46e5] dark:bg-[#818cf8]'} dot={(k) => `var(--ov-src-${k})`}
                active={dept} onPick={(k) => set({ dept: k === dept ? null : k })} f={f} />
            </Section>
          </div>

          <Section title={t('stock2.parcels.byCity')} sub={t('stock2.parcels.clickToFilter')}>
            <Breakdown rows={d.by_city.slice(0, CITY_ROWS)} label={(k) => k || t('stock2.parcels.noCity')}
              sub={(r) => ('zone' in r && r.zone && r.zone !== r.key ? String(r.zone) : null)}
              tone={() => 'bg-[#4f46e5] dark:bg-[#818cf8]'} active={city} onPick={(k) => set({ city: k === city ? null : k })} f={f} columns />
            {d.by_city.length > CITY_ROWS && <p className="text-[11px] text-muted-foreground">{t('stock2.parcels.moreCities', { n: f.int(d.by_city.length - CITY_ROWS) })}</p>}
          </Section>

          <section className="space-y-2" aria-label={t('stock2.parcels.rowsTitle')}>
            <h3 className="text-sm font-medium text-muted-foreground">{t('stock2.parcels.rowsTitle')} · {f.int(d.total_rows)}</h3>
            {d.rows.length === 0 ? <Empty icon={<Package className="h-5 w-5" />} title={t('stock2.parcels.empty')} /> : (
              <ParcelRows rows={d.rows} f={f} money={money} />
            )}
            <Pager offset={offset} limit={LIMIT} rows={d.rows.length} total={d.total_rows} f={f}
              onOffset={(o) => setSp((p) => patchParams(p, { page: o > 0 ? String(o / LIMIT + 1) : null }), { replace: true })} />
          </section>
        </>
      )}
    </div>
  );
}

function Hourly({ hourly, f }: { hourly: StockParcelsDay['hourly']; f: InsightsFormat }) {
  const { t } = f;
  const [table, setTable] = useState(false);
  const titleId = useId();
  const created = t('stock2.parcels.created');
  const picked = t('stock2.parcels.pickedUp');
  const data = Array.from({ length: 24 }, (_, h) => hourly.find((x) => x.hour === h) ?? { hour: h, created: 0, picked_up: 0 });
  const sum = (k: 'created' | 'picked_up') => data.reduce((a, x) => a + x[k], 0);
  const hh = (h: number) => `${String(h).padStart(2, '0')}h`;
  return (
    <div className="space-y-2" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul id={titleId} className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <li className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s2Var('created') }} aria-hidden />{created} <b className="tabular-nums text-foreground">{f.int(sum('created'))}</b></li>
          <li className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s2Var('picked') }} aria-hidden />{picked} <b className="tabular-nums text-foreground">{f.int(sum('picked_up'))}</b></li>
        </ul>
        <Chip on={table} onClick={() => setTable((v) => !v)}>{t('stock2.common.asTable')}</Chip>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="border-b text-muted-foreground">
              <th scope="col" className="px-1 py-1 text-left font-medium">{t('stock2.parcels.hour')}</th>
              <th scope="col" className="px-1 py-1 text-right font-medium">{created}</th>
              <th scope="col" className="px-1 py-1 text-right font-medium">{picked}</th>
            </tr></thead>
            <tbody>
              {data.filter((x) => x.created || x.picked_up).map((x) => (
                <tr key={x.hour} className="border-b last:border-0">
                  <th scope="row" className="px-1 py-0.5 text-left font-normal">{String(x.hour).padStart(2, '0')}:00</th>
                  <td className="px-1 py-0.5 text-right">{f.int(x.created)}</td>
                  <td className="px-1 py-0.5 text-right">{f.int(x.picked_up)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-[200px] min-w-0" role="img" aria-label={`${t('stock2.parcels.hourlyTitle')}: ${created} ${f.int(sum('created'))} · ${picked} ${f.int(sum('picked_up'))}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barGap={2} barCategoryGap="18%">
              <CartesianGrid vertical={false} stroke={s2Var('grid')} />
              <XAxis dataKey="hour" tickFormatter={(h) => hh(Number(h))} interval={2} minTickGap={4}
                tick={{ fontSize: 10, fill: s2Var('axis') }} axisLine={{ stroke: s2Var('grid') }} tickLine={false} />
              <YAxis width={32} allowDecimals={false} tickCount={4} tickFormatter={(v) => f.int(Number(v))}
                tick={{ fontSize: 10, fill: s2Var('axis') }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as { hour: number; created: number; picked_up: number };
                  return (
                    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs tabular-nums text-popover-foreground shadow-md">
                      <div className="mb-0.5 text-muted-foreground">{String(p.hour).padStart(2, '0')}:00–{String(p.hour).padStart(2, '0')}:59</div>
                      <div>{created} <b>{f.int(p.created)}</b></div>
                      <div>{picked} <b>{f.int(p.picked_up)}</b></div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="created" fill={s2Var('created')} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="picked_up" fill={s2Var('picked')} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** A clickable bar list: name · bar · parcels (units). The picked one is marked. */
function Breakdown({ rows, label, tone, dot, sub, active, onPick, f, columns }: {
  rows: (StockCount & { zone?: string | null })[];
  label: (k: string) => string; tone: (k: string) => string; dot?: (k: string) => string;
  sub?: (r: StockCount & { zone?: string | null }) => string | null;
  active: string | null; onPick: (k: string) => void; f: InsightsFormat; columns?: boolean;
}) {
  const { t } = f;
  if (!rows.length) return <p className="py-3 text-center text-xs text-muted-foreground">{t('stock2.parcels.none')}</p>;
  const max = Math.max(1, ...rows.map((r) => r.parcels));
  return (
    <ul className={cn('grid gap-1', columns && 'md:grid-cols-2 md:gap-x-6')}>
      {rows.map((r) => {
        const on = active === r.key;
        const s = sub?.(r);
        return (
          <li key={r.key || '∅'}>
            <button type="button" aria-pressed={on} onClick={() => r.key && onPick(r.key)} disabled={!r.key}
              className={cn('grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,12rem)_1fr_auto]',
                on && 'bg-muted ring-1 ring-foreground/30')}>
              <span className="flex min-w-0 items-center gap-1.5">
                {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot(r.key) }} aria-hidden />}
                <span className="min-w-0">
                  <span className={cn('block break-words leading-tight', on ? 'font-semibold' : 'text-foreground')}>{label(r.key)}</span>
                  {s && <span className="block break-words text-[10px] leading-tight text-muted-foreground">{s}</span>}
                </span>
              </span>
              <span className="block h-2 overflow-hidden rounded-full bg-muted">
                <span className={cn('block h-full rounded-full', tone(r.key))} style={{ width: `${(r.parcels / max) * 100}%` }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums">
                <b>{f.int(r.parcels)}</b> <span className="text-muted-foreground">({fmtQty(r.units, f.lang)} {t('stock2.parcels.unitsShort')})</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const time = (iso: string | null) => formatSkopje(iso, 'dd.MM HH:mm');

function ParcelRows({ rows, f, money }: { rows: StockParcelRow[]; f: InsightsFormat; money: boolean }) {
  const { t } = f;
  const wide = useMinWidth(1024);
  const dept = (r: StockParcelRow) => departmentLabel(t, r.department) ?? t('stock2.parcels.noDepartment');
  const stateBadge = (r: StockParcelRow) => (
    <Pill tone={STATE_TONE[r.state] ?? 'slate'} className="whitespace-nowrap">{t(`stock2.state.${r.state}`, { defaultValue: r.state })}</Pill>
  );
  const statusText = (r: StockParcelRow) => (r.status_group ? t(`stock2.status.${r.status_group}`, { defaultValue: r.status_group }) : '—')
    + (r.status_id != null ? ` (${r.status_id})` : '');
  const linesText = (r: StockParcelRow) => (r.lines_source ? t(`stock2.lines.${r.lines_source}`, { defaultValue: r.lines_source }) : '—');

  if (!wide) {
    return (
      <ul className="space-y-2" data-testid="stock2-parcel-cards">
        {rows.map((r) => (
          <li key={r.tracking_id} className="space-y-1.5 rounded-xl border bg-card p-3 text-xs shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-all font-mono text-sm font-medium">{r.tracking_id}</p>
                <p className="text-muted-foreground">{accountLabel(r.account)} · {dept(r)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-semibold tabular-nums">{fmtQty(r.units, f.lang)}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('stock2.parcels.unitsShort')}{r.gift_units > 0 ? ` · ${t('stock2.parcels.giftsN', { count: r.gift_units, n: fmtQty(r.gift_units, f.lang) })}` : ''}</p>
              </div>
            </div>
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{statusText(r)}</span>{stateBadge(r)}
              <span className="text-muted-foreground">{linesText(r)}</span>
            </p>
            <p className="text-muted-foreground">{[r.city, r.zone && r.zone !== r.city ? r.zone : null].filter(Boolean).join(' · ') || '—'}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
              <div><dt className="inline">{t('stock2.parcels.colCreated')}: </dt><dd className="inline text-foreground">{time(r.created_at_mex)}</dd></div>
              <div><dt className="inline">{t('stock2.parcels.colPicked')}: </dt><dd className="inline text-foreground">{time(r.picked_up_at)}</dd></div>
              {r.delivered_at && <div><dt className="inline">{t('stock2.parcels.colDelivered')}: </dt><dd className="inline text-foreground">{time(r.delivered_at)}</dd></div>}
              {r.returned_at && <div><dt className="inline">{t('stock2.parcels.colReturned')}: </dt><dd className="inline text-foreground">{time(r.returned_at)}</dd></div>}
            </dl>
            {money && r.cod_mkd != null && <p className="tabular-nums">{t('stock2.parcels.cod')}: <b>{f.den(r.cod_mkd)}</b></p>}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="rounded-xl border bg-card shadow-sm" data-testid="stock2-parcel-table">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-[11px] leading-tight text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">{t('stock2.parcels.colTracking')}</th>
            <th scope="col" className="px-1.5 py-2 font-medium">{t('stock2.parcels.colDepartment')}</th>
            <th scope="col" className="px-1.5 py-2 font-medium">{t('stock2.parcels.colStatus')}</th>
            <th scope="col" className="px-1.5 py-2 font-medium">{t('stock2.parcels.colTimes')}</th>
            <th scope="col" className="hidden px-1.5 py-2 font-medium xl:table-cell">{t('stock2.parcels.colCity')}</th>
            <th scope="col" className="px-1.5 py-2 text-right font-medium">{t('stock2.parcels.colUnits')}</th>
            {money && <th scope="col" className="px-1.5 py-2 pr-3 text-right font-medium">{t('stock2.parcels.cod')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tracking_id} className="border-b align-top last:border-0">
              <th scope="row" className="px-3 py-1.5 text-left font-normal">
                <span className="block whitespace-nowrap font-mono text-[12px] font-medium">{r.tracking_id}</span>
                <span className="text-[11px] text-muted-foreground">{accountLabel(r.account)}</span>
              </th>
              <td className="px-1.5 py-1.5"><span className="break-words">{dept(r)}</span></td>
              <td className="space-y-0.5 px-1.5 py-1.5">
                <span className="block">{statusText(r)}</span>
                {stateBadge(r)}
                <span className="block text-[11px] text-muted-foreground">{linesText(r)}</span>
              </td>
              <td className="px-1.5 py-1.5 tabular-nums text-muted-foreground">
                <span className="block whitespace-nowrap">{t('stock2.parcels.colCreated')} <span className="text-foreground">{time(r.created_at_mex)}</span></span>
                <span className="block whitespace-nowrap">{t('stock2.parcels.colPicked')} <span className="text-foreground">{time(r.picked_up_at)}</span></span>
                {r.delivered_at && <span className="block whitespace-nowrap">{t('stock2.parcels.colDelivered')} <span className="text-foreground">{time(r.delivered_at)}</span></span>}
                {r.returned_at && <span className="block whitespace-nowrap">{t('stock2.parcels.colReturned')} <span className="text-foreground">{time(r.returned_at)}</span></span>}
                <span className="block xl:hidden">{[r.city, r.zone && r.zone !== r.city ? r.zone : null].filter(Boolean).join(' · ')}</span>
              </td>
              <td className="hidden px-1.5 py-1.5 xl:table-cell"><span className="break-words">{r.city ?? '—'}</span>{r.zone && r.zone !== r.city && <span className="block text-[11px] text-muted-foreground">{r.zone}</span>}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">
                <span className="font-medium">{fmtQty(r.units, f.lang)}</span>
                {r.gift_units > 0 && <span className="block whitespace-nowrap text-[11px] text-muted-foreground">{t('stock2.parcels.giftsN', { count: r.gift_units, n: fmtQty(r.gift_units, f.lang) })}</span>}
              </td>
              {money && <td className="whitespace-nowrap px-1.5 py-1.5 pr-3 text-right tabular-nums">{r.cod_mkd != null ? f.den(r.cod_mkd) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
