import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import sample from './__fixtures__/cohort.sample.json';
import type { Cohort } from './cohortTypes';

// The shared cohort bar, table, quality rail and leads/cash cards against the
// contract fixture (22–28.09.2026 in insights_cohort()'s shape): owners see
// денари, a non-owner the same parts counted, the parts always add up, and a
// number links to /orders only when the list holds exactly it — a number that
// is only partly orders offers "N во Нарачки" for its order part instead.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const { CohortBar } = await import('./CohortBar');
const { SourceTable } = await import('./SourceTable');
const { QualityRail } = await import('./QualityRail');
const { LeadsInCard, CashFlowCard } = await import('./CohortSecondary');
const { useInsightsFormat } = await import('./useInsightsFormat');
const { cohortView, stripCohortMoney } = await import('./cohortModel');

const range = { from: '2026-09-22', to: '2026-09-28' };
const WIN = 'sold_from=2026-09-22&sold_to=2026-09-28';
const owner = () => structuredClone(sample) as unknown as Cohort;
// Any amount in denars: a digit, a space, "ден" as a whole word.
const DENARS = /\d ден(?![а-яѓќљњџѕ])/;

function Harness({ c, sources }: { c: Cohort; sources?: string[] }) {
  const f = useInsightsFormat();
  const v = cohortView(c, (sources ?? []) as never);
  const money = c.meta.money;
  return (
    <div>
      <CohortBar total={v.total} buckets={v.buckets} outside={v.outside} money={money} rows={v.rows} range={range}
        prev={v.filtered ? null : c.prev?.total} f={f} />
      <LeadsInCard leads={v.leads_in} f={f} />
      <CashFlowCard cash={c.cash_flow} money={money} f={f} />
      <SourceTable rows={v.rows} total={v.total} leadsTotal={v.leads_in} money={money} range={range} f={f} />
      <QualityRail items={c.quality} money={money} f={f} />
    </div>
  );
}
const renderWith = (c: Cohort, sources?: string[]) =>
  render(<MemoryRouter><Harness c={c} sources={sources} /></MemoryRouter>);
/** A bar tile, found by its label (the label span carries it as its title). */
const tileOf = (bar: HTMLElement, k: string) => within(bar).getByTitle(i18n.t(`insights.common.bucket.${k}`)).closest('li')!;
const partLink = (n: string) => i18n.t('insights.common.cohort.ordersPart', { n });

describe('CohortBar — owner, the whole business', () => {
  it('one total, parts that add up, the courier tile with its problem part, the outside line apart', () => {
    const c = owner();
    const { container } = renderWith(c);
    const bar = screen.getByRole('region', { name: i18n.t('insights.common.cohort.title') });
    expect(within(bar).getByText(formatDenari(3239584))).toBeInTheDocument();
    expect(within(bar).getByText(i18n.t('insights.common.cohort.salesN', { n: '1.337' }))).toBeInTheDocument();
    expect(within(bar).getByText(i18n.t('insights.common.cohort.sumOk', { total: '1.337' }))).toBeInTheDocument();
    // What the total is made of — orders, the web mirror, MEX parcels with no order.
    expect(within(bar).getByText(i18n.t('insights.common.cohort.composition', { orders: '507', web: '90', mex: '740' }))).toBeInTheDocument();
    // "At the courier" = moving + problem (113 + 121), the problem shown as its part.
    expect(within(tileOf(bar, 'courier')).getByText('234')).toBeInTheDocument();
    expect(within(bar).getByText(i18n.t('insights.common.cohort.problemPart', { n: '121' }))).toBeInTheDocument();
    // Collected carries the MEX COD line.
    const paidCod = c.buckets.find((b) => b.key === 'paid')!.cod_mkd;
    expect(within(bar).getByText(i18n.t('insights.common.cohort.codLine', { value: formatDenari(paidCod) }))).toBeInTheDocument();
    // Cancelled (red) / trashed (grey) after the sale and replacements sit outside the total.
    for (const k of ['cancelled_after_sale', 'trashed_after_sale', 'replacement']) {
      expect(within(bar).getByText(i18n.t(`insights.common.outside.${k}`))).toBeInTheDocument();
    }
    // Unproven / legacy paid are 0 here → no tile.
    expect(within(bar).queryByText(i18n.t('insights.common.bucket.paid_unproven'))).toBeNull();
    expect(container.textContent).toMatch(DENARS);
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it('a number that is only partly orders has no link of its own; its order part opens exactly', () => {
    renderWith(owner());
    const bar = screen.getByRole('region', { name: i18n.t('insights.common.cohort.title') });
    const paid = tileOf(bar, 'paid');
    // 717 paid = 121 orders + 46 web + 550 MEX-only: no list holds the 717
    expect(within(paid).getByText('717')).toHaveAttribute('title', i18n.t('insights.common.cohort.noLinkMixed'));
    expect(within(paid).getByRole('link').getAttribute('href')).toBe(`/orders?cohort_bucket=paid&${WIN}`);
    expect(within(paid).getByRole('link')).toHaveTextContent(partLink('121'));
    // the total: "507 во Нарачки" = every order of the period, whatever its source
    const totalPart = within(bar).getAllByRole('link').find((a) => a.textContent === partLink('507'))!;
    expect(totalPart.getAttribute('href')).toBe(`/orders?cohort_bucket=total&${WIN}`);
    // The table twin: the web row and Teleshop/Other (parcels only) never link; AlterCPA does, exactly.
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('link', { name: /Веб-продавница/ })).toBeNull();
    expect(within(table).queryByRole('link', { name: /Телешоп/ })).toBeNull();
    const alterPaid = within(table).getByRole('link', { name: `AlterCPA · ${i18n.t('insights.common.bucket.paid')}: 70` });
    expect(alterPaid.getAttribute('href')).toBe(`/orders?cohort_bucket=paid%2Cpaid_legacy&sale_source=altercpa%2Caffiliate&${WIN}`);
    expect(alterPaid.getAttribute('title')).toBeNull();
  });

  it('leads, cash and quality are separate figures, each on its own clock', () => {
    const c = owner();
    renderWith(c);
    expect(screen.getByText(i18n.t('insights.common.leads.title'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.common.leads.worked', { n: '2.608' }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.common.leads.dispositionNote', { n: '1.638', count: 1638 }))).toBeInTheDocument();
    expect(screen.getByText(formatDenari(c.cash_flow.cod_mkd))).toBeInTheDocument();
    expect(screen.getByText(`+ ${formatDenari(c.cash_flow.card_mkd)}`)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.common.clock.counted', { clocks: i18n.t('insights.common.clock.sale') }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.common.clock.counted', { clocks: i18n.t('insights.common.clock.delivered') }))).toBeInTheDocument();
    // Quality: live items only (unproven_paid = 0 is not a card).
    expect(screen.getByText(i18n.t('insights.common.quality.kind.double_count_candidates'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('insights.common.quality.hint.unproven_paid'))).toBeNull();
  });
});

describe('CohortBar — a source filter', () => {
  it('re-sums the header from the rows and links the parts to exactly their orders', () => {
    renderWith(owner(), ['altercpa', 'elyon_crm']);
    const bar = screen.getByRole('region', { name: i18n.t('insights.common.cohort.title') });
    expect(within(bar).getByText(i18n.t('insights.common.cohort.sumOk', { total: '507' }))).toBeInTheDocument();
    const toPack = within(bar).getByRole('link', { name: `${i18n.t('insights.common.bucket.to_pack')}: 260` });
    expect(toPack.getAttribute('href')).toBe(`/orders?cohort_bucket=to_pack&sale_source=altercpa%2Caffiliate%2Celyon_crm&${WIN}`);
    // all orders: no "N во Нарачки" beside the numbers
    expect(within(bar).queryByText(partLink('260'))).toBeNull();
  });
});

describe('CohortBar — admin/manager without money', () => {
  it('the same parts counted: no denar anywhere', () => {
    const { container } = renderWith(stripCohortMoney(owner()));
    const bar = screen.getByRole('region', { name: i18n.t('insights.common.cohort.titleNoMoney') });
    expect(within(bar).getByText('1.337')).toBeInTheDocument();
    expect(within(tileOf(bar, 'paid')).getByText('717')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.common.cash.titleNoMoney'))).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: i18n.t('insights.common.table.value') })).toBeNull();
    expect(container.textContent).not.toMatch(DENARS);
  });
});

describe('CohortBar — parts that do not add up', () => {
  it('says so in red, never hides it', () => {
    const c = owner();
    c.total = { ...c.total, count: c.total.count + 5 };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWith(c);
    expect(screen.getByRole('alert')).toHaveTextContent(
      i18n.t('insights.common.cohort.sumBad', { parts: '1.337', total: '1.342' }),
    );
    err.mockRestore();
  });
});
