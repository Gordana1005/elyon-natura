import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import type { PLRow, ProfitQuality, ProfitResponse } from '@/lib/insightsApi/profit';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { CostSourceNote } from './CostSourceNote';
import { ProfitQualityRail } from './ProfitQualityRail';
import { Waterfall } from './Waterfall';

// Sigma purchase costs on Pure Profit (owner 01.10.2026): the source line says where the cost came
// from, the waterfall shows "Подароци и дополнително спакувано", the rail names the missing recipes
// or the old catalogue prices.
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;

const meta = (cost?: Partial<NonNullable<ProfitResponse['meta']['cost']>>) => ({
  from: '2026-09-01', to: '2026-09-30', days: 30, partial: false, prev_from: null, prev_to: null, prev_to_end: null,
  prev_skipped: false, prev_max_days: 93, generated_at: '2026-10-01T10:00:00Z', money: true, granularity: 'day',
  vat: { mode: 'per_product_sigma', default_rate: 0.05, rate: 0.05, confirmed: true },
  courier: { deliver_mkd: 150, return_mkd: 0, source: 'courier_rates' }, lead_cost: { configured: false },
  commission: { rule: 'per_package_paid_agents', agents: 3 }, mkd_per_eur: 61.5, cache: null,
  ...(cost ? {
    cost: {
      source: 'sigma', basis: 'sigma_calcbuyprice', as_of: '2026-09-29', extra_goods: true,
      coverage: { cohort: { packages: 0.962, revenue: 0.977 }, cash: { packages: 0.964, revenue: 0.981 } },
      uncosted_products: 67, partial_products: 0, ...cost,
    },
  } : {}),
}) as unknown as ProfitResponse['meta'];

const row: PLRow = {
  key: 'total', sales: 10, revenue_mkd: 30000, card_mkd: 0, vat_mkd: 1429, vat_costed_mkd: 1400,
  vat_split: [{ rate: 0.05, revenue_mkd: 30000, vat_mkd: 1429 }], vat_unclassified: { revenue_mkd: 0, vat_mkd: 0 },
  cogs_known_mkd: 3000, cogs_est_mkd: 100, cogs_extra_mkd: 250,
  cogs_extra_detail: { mex_only_mkd: 90, mex_only_revenue_mkd: 1000, negative_mkd: -30, sales: 9 },
  courier_mkd: 1500, returns_mkd: 0, commission_mkd: 0, lead_cost_mkd: 0, net_mkd: 23721, net_upper_mkd: 23821, margin: 0.79,
  costed: { revenue_mkd: 29000, net_mkd: 23000, margin: 0.79 }, revenue_costed_mkd: 29000, revenue_uncosted_mkd: 1000,
  revenue_other_mkd: 0, packages: 30, free_packages: 0, packages_costed: 29, packages_uncosted: 1, coverage_packages: 29 / 30,
  coverage_revenue: 29 / 30, parcels_delivered: 10, parcels_returned: 0, returned: 0, returned_mkd: 0, return_rate: 0,
  aov_mkd: 3000, cost_per_sale_mkd: 628, profit_per_sale_mkd: 2372, packages_per_sale: 3,
};

function Harness({ children }: { children: (f: ReturnType<typeof useInsightsFormat>) => React.ReactNode }) {
  const f = useInsightsFormat();
  return <MemoryRouter>{children(f)}</MemoryRouter>;
}

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('Pure Profit on Sigma costs', () => {
  it('the source line: Sigma (CalcBuyPrice, the snapshot date), coverage, the gifts; legacy is said in amber', () => {
    const { unmount } = render(<Harness>{(f) => <CostSourceNote meta={meta({})} clock="cohort" f={f} />}</Harness>);
    const line = screen.getByTestId('profit-cost-source');
    expect(line.textContent).toContain(t('profitCost.source.sigma', { date: '29.09.2026' }));
    expect(line.textContent).toContain(t('profitCost.source.extraOn'));
    unmount();
    render(<Harness>{(f) => <CostSourceNote meta={meta()} clock="cohort" f={f} />}</Harness>);
    expect(screen.getByTestId('profit-cost-source').textContent).toContain(t('profitCost.source.legacy'));
  });

  it('the waterfall has the gifts step and the Sigma chip on the product cost', () => {
    render(<Harness>{(f) => <Waterfall row={row} meta={meta({})} clockLabel="септември" f={f} />}</Harness>);
    const list = screen.getByRole('list', { name: t('insights.profit.waterfall.title') });
    expect(within(list).getByText(t('profitCost.step.extra'))).toBeTruthy();
    expect(within(list).getByText(t('profitCost.chip.sigma'))).toBeTruthy();
  });

  it('the rail: missing recipes link to the products; the old catalogue is a pending setting', () => {
    const items: ProfitQuality[] = [
      { kind: 'recipe_missing', severity: 'warning', count: 100, value_mkd: 40000, share: 0.04, top: [{ key: 'p:x', name: 'Veno Gel', packages: 10, revenue_mkd: 5000 }] },
      { kind: 'cost_legacy', severity: 'warning', count: 1 },
      { kind: 'extra_goods_negative', severity: 'info', count: 1, value_mkd: -2000 },
    ];
    render(<Harness>{(f) => <ProfitQualityRail items={items} f={f} />}</Harness>);
    expect(screen.getByText(t('profitCost.quality.kind.recipe_missing'))).toBeTruthy();
    expect(screen.getByText(t('profitCost.quality.kind.cost_legacy'))).toBeTruthy();
    expect(screen.getByText(t('profitCost.quality.kind.extra_goods_negative'))).toBeTruthy();
    const links = screen.getAllByRole('link', { name: t('profitCost.quality.link') });
    expect(links[0].getAttribute('href')).toBe('/products?recipe=none');
  });
});
