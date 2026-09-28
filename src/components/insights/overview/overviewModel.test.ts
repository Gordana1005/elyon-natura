import { describe, expect, it } from 'vitest';
import type { OverviewResponse, OverviewTeamMember } from '@/lib/api';
import sample from './__fixtures__/overview.sample.json';
import pivotSample from './__fixtures__/pivot.sample.json';
import cohortSample from './__fixtures__/cohort.sample.json';
import {
  agoParts, compactParts, delta, deriveKpis, groupPivotRows, measureSetOf, ordersHref, parseDrillParams,
  parseOverviewParams, placedOf, preparingOf, presetRange, previousRange, primaryOf, seriesFromTrend, shareText,
  sortMembers, sourceDrill, splitDrill, stripMoney, writeOverviewParams, MAX_SPAN_DAYS, OUTCOME,
} from './model';

const fixture = () => structuredClone(sample) as unknown as OverviewResponse;

describe('ranges (Skopje days — the shared /insights period, ../shared/period)', () => {
  const today = '2026-09-28'; // a Monday
  it('calendar presets: today, this week from Monday, this month from the 1st, this year from 1 January', () => {
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('week', today)).toEqual({ from: '2026-09-28', to: today });
    expect(presetRange('week', '2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(presetRange('month', today)).toEqual({ from: '2026-09-01', to: today });
    expect(presetRange('year', today)).toEqual({ from: '2026-01-01', to: today });
  });
  it('custom: swaps a reversed pair and caps the span', () => {
    expect(presetRange('custom', today, { from: '2026-09-20', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-20' });
    const wide = presetRange('custom', today, { from: '2020-01-01', to: '2026-09-28' });
    expect(wide.to).toBe('2026-09-28');
    expect(wide.from).toBe('2025-08-24'); // 400 days back
    expect(MAX_SPAN_DAYS).toBe(400);
  });
  it('custom: an unreadable day falls back (to this week) instead of widening the range', () => {
    expect(presetRange('custom', today, { from: 'garbage', to: '2026-13-45' })).toEqual({ from: '2026-09-28', to: today });
  });
  it('compares against the equal-length span right before', () => {
    expect(previousRange({ from: '2026-09-22', to: '2026-09-28' })).toEqual({ from: '2026-09-15', to: '2026-09-21' });
    expect(previousRange({ from: '2026-09-28', to: '2026-09-28' })).toEqual({ from: '2026-09-27', to: '2026-09-27' });
    // across a month end and the DST change (25.10 → 26.10) — pure calendar math
    expect(previousRange({ from: '2026-10-25', to: '2026-10-31' })).toEqual({ from: '2026-10-18', to: '2026-10-24' });
  });
  it('the /insights URL round-trips and keeps the tab', () => {
    const sp = new URLSearchParams('tab=overview');
    const written = writeOverviewParams(sp, {
      preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' }, compare: false,
      sources: ['altercpa', 'web'], teams: ['crm_prediction'],
    });
    expect(written.get('tab')).toBe('overview');
    expect(parseOverviewParams(written, today)).toEqual({
      preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' }, compare: false,
      sources: ['altercpa', 'web'], teams: ['crm_prediction'],
    });
    // defaults stay out of the URL
    const reset = writeOverviewParams(written, { preset: 'week', range: presetRange('week', today), compare: true, sources: [], teams: [] });
    expect(reset.toString()).toBe('tab=overview');
    expect(parseOverviewParams(reset, today)).toMatchObject({ preset: 'week', compare: true, sources: [], teams: [] });
  });
  it('ignores unknown sources in the URL', () => {
    expect(parseOverviewParams(new URLSearchParams('src=altercpa,bogus'), today).sources).toEqual(['altercpa']);
  });
});

describe('drill-down links: bucket → /orders', () => {
  const range = { from: '2026-09-22', to: '2026-09-28' };
  const d = fixture();
  const byKey = (k: string) => d.sources.find((s) => s.key === k)!;

  it('a bucket opens exactly that source, outcome and created window', () => {
    expect(ordersHref(sourceDrill(byKey('altercpa'), range, { outcome: 'delivered' })))
      .toBe('/orders?sale_source=altercpa%2Caffiliate&outcome=delivered&created_from=2026-09-22&created_to=2026-09-28');
    expect(ordersHref(sourceDrill(byKey('teleshop_other'), range, { outcome: 'courier' })))
      .toBe('/orders?sale_source=collabbox%2Clegacy&outcome=courier&created_from=2026-09-22&created_to=2026-09-28');
    // the shop panel's "being prepared" = to pack + packed
    expect(ordersHref(sourceDrill(byKey('elyon_crm'), range, { outcome: OUTCOME.preparingAll })))
      .toBe('/orders?sale_source=elyon_crm&outcome=preparing%2Cpacked&created_from=2026-09-22&created_to=2026-09-28');
    expect(OUTCOME.toCollect).toBe('preparing,packed,courier');
  });
  it('a row counted from the web-shop mirror (web_block) or with no drill gets no link at all', () => {
    expect(byKey('web').drill.sale_source).toEqual(['web']);
    expect(sourceDrill(byKey('web'), range)).toBeNull();
    expect(sourceDrill({ drill: { sale_source: [] } }, range)).toBeNull();
    expect(sourceDrill({ drill: { sale_source: ['web'] }, web_block: false }, range)).not.toBeNull();
  });
  it('a split follows the drill the server sends with it (null = not an orders filter)', () => {
    const elyon = byKey('elyon_crm');
    expect(ordersHref(splitDrill(elyon, elyon.splits.find((x) => x.key === 'prediction_list')!, range)))
      .toBe('/orders?sale_source=elyon_crm&sale_source_detail=prediction_list&created_from=2026-09-22&created_to=2026-09-28');
    const tele = byKey('teleshop_other');
    expect(ordersHref(splitDrill(tele, tele.splits.find((x) => x.key === 'social')!, range)))
      .toBe('/orders?sale_source=collabbox&sale_source_detail=social&created_from=2026-09-22&created_to=2026-09-28');
    expect(splitDrill(byKey('altercpa'), byKey('altercpa').splits[0], range)).toBeNull();            // new vs returning
    expect(splitDrill(tele, tele.splits.find((x) => x.key === 'mex_only_unlinked')!, range)).toBeNull(); // parcels, no order
    // an older payload without per-split drills: only a detail the row lists links
    expect(splitDrill({ ...elyon, drill: { sale_source: ['elyon_crm'], detail: ['direct'] } }, 'direct', range)).not.toBeNull();
    expect(splitDrill({ ...elyon, drill: { sale_source: ['elyon_crm'] } }, 'direct', range)).toBeNull();
  });
  it('round-trips through the Orders page parser, label kept out of the filter', () => {
    const href = ordersHref({ sale_source: 'altercpa', sold_by_person_id: 'p-001', sold_from: '2026-09-22', sold_to: '2026-09-28' }, 'Ана')!;
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(sp.get('lbl')).toBe('Ана');
    expect(parseDrillParams(sp)).toEqual({ sale_source: 'altercpa', sold_by_person_id: 'p-001', sold_from: '2026-09-22', sold_to: '2026-09-28' });
    const cash = new URLSearchParams(ordersHref({ cash_from: '2026-09-22', cash_to: '2026-09-28', proof: 'unproven' })!.split('?')[1]);
    expect(parseDrillParams(cash)).toEqual({ cash_from: '2026-09-22', cash_to: '2026-09-28', proof: 'unproven' });
  });
  it('the parser drops malformed days and returns null when nothing is left', () => {
    expect(parseDrillParams(new URLSearchParams('created_from=yesterday&outcome=lost'))).toEqual({ outcome: 'lost' });
    expect(parseDrillParams(new URLSearchParams('tab=x&page=2'))).toBeNull();
    expect(ordersHref({})).toBeNull();
  });
});

describe('delta math', () => {
  it('signs, tones and the no-base cases', () => {
    expect(delta(106, 100, 'up')).toEqual({ dir: 'up', pct: 0.06, tone: 'good' });
    expect(delta(90, 100, 'up')).toMatchObject({ dir: 'down', tone: 'bad' });
    expect(delta(120, 100, 'down')).toMatchObject({ dir: 'up', tone: 'bad' });        // more lost = bad
    expect(delta(0, 4, 'down')).toMatchObject({ dir: 'down', pct: -1, tone: 'good' }); // unproven fell to 0
    expect(delta(120, 100, 'neutral')).toMatchObject({ dir: 'up', tone: 'neutral' });
    expect(delta(5, 0, 'up')).toEqual({ dir: 'new', pct: null, tone: 'good' });
    expect(delta(7, 7, 'up')).toEqual({ dir: 'flat', pct: 0, tone: 'neutral' });
    expect(delta(null, 7, 'up').dir).toBe('none');
    expect(delta(7, undefined, 'up').dir).toBe('none');
  });
  it('money tiles lead with money for owners, counts otherwise; the hero is PROVEN cash', () => {
    const k = measureSetOf(fixture().kpis);
    expect(primaryOf('delivered', k.delivered, true)).toBe(3036660);   // MEX-proven cash, denars
    expect(k.delivered.cod_mkd).toBe(3062500);                         // …not the claims incl. unproven
    expect(primaryOf('delivered', k.delivered, false)).toBe(1285);     // proven parcels
    expect(primaryOf('delivered', { count: 5, cod_mkd: 900 }, true)).toBe(900); // a payload without the proven split
    expect(primaryOf('placed', k.placed, true)).toBe(94614.87);        // EUR (rendered as денари)
    expect(primaryOf('confirmed', k.confirmed, true)).toBe(1051);      // a count even for owners
    expect(primaryOf('lost', { count: null, value_eur: null }, false)).toBeNull();
  });
});

describe('numbers', () => {
  it('shares never lie by rounding', () => {
    expect(shareText(0, 957, 'mk')).toBe('0%');
    expect(shareText(957, 957, 'mk')).toBe('100%');
    expect(shareText(4, 957, 'mk')).toBe('0,4%');
    expect(shareText(953, 957, 'mk')).toBe('99,5%');
    expect(shareText(4, 957, 'en')).toBe('0.4%');
    expect(shareText(1, 0, 'mk')).toBe('—');
  });
  it('placed = every bucket once; "being prepared" = to pack + packed; MEX-only is not an order', () => {
    const a = fixture().sources[0];
    expect(placedOf(a)).toEqual({ count: 1262, value_eur: 51488.87 });
    const noPlaced = { ...a, placed: null };
    expect(placedOf(noPlaced)).toEqual({ count: 1262, value_eur: expect.closeTo(51488.87, 2) }); // Σ buckets
    expect(preparingOf(a)).toEqual({ count: 173, value_eur: expect.closeTo(7066.05, 2), packed: 64, toPack: 109 });
    const tele = fixture().sources[3];
    expect(tele.buckets.mex_only?.count).toBe(86);
    expect(placedOf(tele).count).toBe(598);
    expect(placedOf({ ...tele, placed: null }).count).toBe(598);
  });
  it('Σ sources = the KPI tiles, each on its own clock (C1)', () => {
    const d = fixture();
    const derived = deriveKpis(d.sources, d.kpis);
    expect(derived.placed.count).toBe(d.kpis.placed.count);
    expect(derived.placed.value_eur).toBeCloseTo(d.kpis.placed.value_eur!, 2);
    expect(derived.confirmed.count).toBe(d.kpis.confirmed.count);
    expect(derived.confirmed.value_eur).toBeCloseTo(d.kpis.confirmed.value_eur!, 2);
    expect(derived.at_courier.count).toBe(d.kpis.at_courier.count);
    expect(derived.delivered.count).toBe(d.kpis.delivered.count);
    expect(derived.delivered.cod_mkd).toBe(d.kpis.delivered.cod_mkd);
    expect(derived.delivered.proven_cod_mkd).toBe(d.kpis.delivered.proven_cod_mkd);
    expect(derived.delivered.mex_only_count).toBe(d.kpis.delivered.mex_only_count);
    expect(derived.to_collect.count).toBe(d.kpis.to_collect.count);
    expect(derived.to_collect.value_eur).toBeCloseTo(d.kpis.to_collect.value_eur!, 2);
    expect(derived.lost.value_eur).toBeCloseTo(d.kpis.lost.value_eur!, 2);
    expect(derived.lost.count).toBeNull();                 // not split by source
    expect(derived.unproven_paid.count).toBe(d.kpis.unproven_paid.count);
    expect(derived.unproven_paid.cod_mkd).toBe(d.kpis.unproven_paid.cod_mkd);
    const cash = seriesFromTrend(d.trend.points, ['altercpa', 'elyon_crm', 'web', 'teleshop_other'], 'delivered_cash_mkd');
    expect(cash.reduce((a, p) => a + p.v, 0)).toBe(d.kpis.delivered.cod_mkd);
    expect(cash.map((p) => p.v)).toEqual(d.kpis.spark!.delivered_cash_mkd!.map((p) => p.v));
  });
  it('a subset of sources sums only those rows', () => {
    const d = fixture();
    const only = deriveKpis(d.sources.filter((s) => s.key === 'elyon_crm'), d.kpis);
    expect(only.placed.count).toBe(412);
    expect(only.confirmed.count).toBe(371);
    expect(only.delivered.proven_cod_mkd).toBe(605530);   // cash clock, this source only
    expect(only.unproven_paid.count).toBe(3);
    expect(only.to_collect.count).toBe(55 + 41 + 147);
  });
  it('axis compaction and relative time', () => {
    expect(compactParts(950)).toEqual({ n: '950', unit: '' });
    expect(compactParts(12_400)).toEqual({ n: '12', unit: 'k' });
    expect(compactParts(1_500)).toEqual({ n: '1.5', unit: 'k' });
    expect(compactParts(1_979_400)).toEqual({ n: '2', unit: 'm' });
    expect(compactParts(2_000_000)).toEqual({ n: '2', unit: 'm' });
    const now = Date.parse('2026-09-28T08:45:00Z');
    expect(agoParts('2026-09-28T08:45:30Z', now)).toEqual({ unit: 'now', n: 0 });
    expect(agoParts('2026-09-28T08:43:00Z', now)).toEqual({ unit: 'min', n: 2 });
    expect(agoParts('2026-09-28T05:40:00Z', now)).toEqual({ unit: 'hour', n: 3 });
    expect(agoParts('2026-09-11T07:12:00Z', now)).toEqual({ unit: 'day', n: 17 });
    expect(agoParts(null, now)).toBeNull();
  });
});

describe('owners-only money', () => {
  it('the non-owner payload carries no money key anywhere, counts intact', () => {
    const d = stripMoney(fixture());
    const walk = (v: unknown, path: string, bad: string[]) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, bad));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
        if (/(_eur|_mkd)$/.test(k) || k === 'placed_value') bad.push(`${path}.${k}`);
        walk(x, `${path}.${k}`, bad);
      }
      return bad;
    };
    expect(walk(d, '', [])).toEqual([]);
    expect(d.meta.money).toBe(false);
    expect(d.kpis.spark).toBeUndefined();          // the api drops spark for a non-owner
    expect(d.kpis.placed.count).toBe(2447);
    expect(d.kpis.delivered.proven_count).toBe(1285);
    expect(d.sources.every((s) => s.money == null)).toBe(true);
    expect(d.teams[0].members[0].worked).toBeGreaterThan(0);
  });
  it('the embedded sales cohort is stripped too: counts and lead outcomes kept, not one denar', () => {
    const d = stripMoney({ ...fixture(), cohort: structuredClone(cohortSample) } as unknown as OverviewResponse) as OverviewResponse & {
      cohort: { meta: { money: boolean }; total: Record<string, number>; by_source: { leads_in: { cancelled: number } }[]; cash_flow: Record<string, number> };
    };
    expect(JSON.stringify(d.cohort)).not.toMatch(/_mkd"/);
    expect(d.cohort.meta.money).toBe(false);
    expect(d.cohort.total).toEqual({ count: 1337 });
    expect(d.cohort.by_source[0].leads_in.cancelled).toBe(301);
    expect(d.cohort.cash_flow).toEqual({ parcels: 1302 });
  });
});

describe('teams and pivot', () => {
  const m = (name: string, sold: number, worked: number, online: number, confirmed = 0): OverviewTeamMember => ({
    person_id: name, name, user_id: null, online_state: 'online', online_min: online, active_min: online, idle_min: 0, break_min: 0,
    first_active: null, last_active: null, idle_alerts: 0, worked, confirmed, conversion: null, sold_value_eur: sold,
    delivered_cash_mkd: 0, last_decision_at: null,
  });
  it('default order is sold, then worked, then time online — zero-sale people still listed', () => {
    const rows = [m('C', 0, 0, 120), m('A', 500, 10, 10), m('B', 0, 40, 5), m('D', 0, 0, 0)];
    expect(sortMembers(rows, null, true).map((x) => x.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(sortMembers(rows, { key: 'online', dir: 'desc' }, true).map((x) => x.name)).toEqual(['C', 'A', 'B', 'D']);
    expect(sortMembers(rows, { key: 'name', dir: 'asc' }, true).map((x) => x.name)).toEqual(['A', 'B', 'C', 'D']);
  });
  it('pivot rows group to any depth and keep the totals', () => {
    const rows = (pivotSample as unknown as { rows: never[] }).rows;
    const bySource = groupPivotRows(rows, ['source']);
    const d = fixture();
    for (const s of d.sources.filter((x) => !x.web_block)) {   // the web mirror is not in the pivot
      expect(bySource.find((r) => r.source === s.key)?.count).toBe(placedOf(s).count);
    }
    expect(bySource.find((r) => r.source === 'web')).toBeUndefined();
    const alter = bySource.find((r) => r.source === 'altercpa')!;
    expect(alter.sold).toBe(d.sources[0].cohort_sold);
    expect(alter.delivered_cash_mkd).toBe(d.sources[0].money!.collected_mkd);
    const byTeam = groupPivotRows(rows, ['source', 'team']);
    expect(byTeam.map((r) => r.team)).toContain('Pending — AlterCPA');   // teams come by NAME
    const byPerson = groupPivotRows(rows, ['source', 'team', 'person']);
    expect(byPerson.every((r) => 'person_id' in r)).toBe(true);           // a person keeps its id for the drill
  });
});
