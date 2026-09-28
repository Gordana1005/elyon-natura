import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { InsightsFilterBar } from './InsightsFilterBar';
import { useInsightsPeriod } from './useInsightsPeriod';

// The ONE period of /insights: calendar presets, dd.mm.yyyy custom days (never
// a native date input), compare, all in the URL next to the tab.
// Only Date is faked: 28.09.2026 10:00 in Skopje, a Monday.
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T08:00:00Z'));
  await i18n.changeLanguage('mk');
});
afterAll(() => { vi.useRealTimers(); });

function Probe() {
  const loc = useLocation();
  const p = useInsightsPeriod();
  return (
    <>
      <output data-testid="search">{loc.search}</output>
      <output data-testid="period">{`${p.from}|${p.to}|${p.compare ? 'cmp' : 'no-cmp'}|${p.prev ? `${p.prev.from}|${p.prev.to}` : ''}`}</output>
    </>
  );
}

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <InsightsFilterBar />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');
const period = () => screen.getByTestId('period').textContent;
const preset = (k: string) => screen.getByRole('button', { name: i18n.t(`insights.common.period.${k}`) });

describe('InsightsFilterBar', () => {
  it('defaults to the last 7 days with compare on, and keeps the tab', () => {
    renderAt('/insights?tab=sales');
    expect(preset('week')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('insights-period')).toHaveTextContent('22.09 – 28.09.2026');
    expect(period()).toBe('2026-09-22|2026-09-28|cmp|2026-09-15|2026-09-21');
  });

  it('presets are calendar periods and live in the URL beside the other params', () => {
    renderAt('/insights?tab=sales&x=1');
    fireEvent.click(preset('month'));
    expect(search().get('range')).toBe('month');
    expect(search().get('tab')).toBe('sales');
    expect(search().get('x')).toBe('1');
    expect(screen.getByTestId('insights-period')).toHaveTextContent('01.09 – 28.09.2026');
    fireEvent.click(preset('year'));
    expect(period()).toBe('2026-01-01|2026-09-28|cmp|2025-04-05|2025-12-31'); // 271 days before
    fireEvent.click(preset('week'));
    expect(search().has('range')).toBe(false); // the default stays out of the URL
  });

  it('custom days are typed dd.mm.yyyy — never a native date input — and applied together', () => {
    const { container } = renderAt('/insights?tab=returns');
    fireEvent.click(preset('custom'));
    expect(container.querySelector('input[type="date"]')).toBeNull();
    const from = screen.getByLabelText(i18n.t('insights.common.period.from'));
    const to = screen.getByLabelText(i18n.t('insights.common.period.to'));
    expect(from).toHaveAttribute('placeholder', i18n.t('insights.common.period.placeholder'));
    fireEvent.change(from, { target: { value: '1.9.2026' } });
    fireEvent.change(to, { target: { value: '10.09.2026' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('insights.common.period.apply') }));
    expect(Object.fromEntries(search())).toMatchObject({ tab: 'returns', range: 'custom', from: '2026-09-01', to: '2026-09-10' });
    expect(screen.getByTestId('insights-period')).toHaveTextContent('01.09 – 10.09.2026');
    expect(period()).toBe('2026-09-01|2026-09-10|cmp|2026-08-22|2026-08-31');
  });

  it('a reversed pair or a day that does not exist cannot be applied', () => {
    renderAt('/insights?tab=returns&range=custom&from=2026-09-01&to=2026-09-10');
    const from = screen.getByLabelText(i18n.t('insights.common.period.from'));
    const apply = screen.getByRole('button', { name: i18n.t('insights.common.period.apply') });
    // 20.09 is after the 'to' day (10.09): a reversed pair.
    fireEvent.change(from, { target: { value: '20.09.2026' } });
    expect(apply).toBeDisabled();
    expect(screen.getByText(i18n.t('insights.common.period.reversed'))).toBeInTheDocument();
    fireEvent.change(from, { target: { value: '31.02.2026' } });
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(apply).toBeDisabled();
    // A US-style month-first date is not a day here.
    fireEvent.change(from, { target: { value: '09/28/2026' } });
    expect(apply).toBeDisabled();
    expect(search().get('from')).toBe('2026-09-01');
  });

  it('compare off is remembered in the URL', () => {
    renderAt('/insights?tab=overview');
    fireEvent.click(screen.getByRole('switch', { name: i18n.t('insights.common.period.compare') }));
    expect(search().get('compare')).toBe('0');
    expect(period()).toBe('2026-09-22|2026-09-28|no-cmp|');
  });
});
