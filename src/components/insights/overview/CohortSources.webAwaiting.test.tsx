import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import type { Cohort, CohortSourceRow } from '../shared/cohortTypes';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import { CohortSources } from './CohortSources';

// The web card of "Од каде дојдоа парите" (20260942001965): the shop's "чека потврда" is a sale,
// "to pack", and the card says how many of its to-pack sales still wait for the shop.
beforeAll(async () => { await i18n.changeLanguage('mk'); });

function Card({ rows }: { rows: CohortSourceRow[] }) {
  const f = useInsightsFormat();
  const total = rows.reduce((a, r) => ({ ...a, count: a.count + r.total.count }), { count: 0, value_mkd: null, cod_mkd: null });
  return <CohortSources rows={rows} total={total} leadsTotal={null} money range={{ from: '2026-09-22', to: '2026-09-28' }} f={f} />;
}

const webRow = (awaiting?: number): CohortSourceRow => {
  const r = structuredClone((cohortSample as unknown as Cohort).by_source.find((x) => x.key === 'web')!) as CohortSourceRow;
  if (awaiting != null) r.buckets = r.buckets.map((b) => (b.key === 'to_pack' ? { ...b, awaiting } as typeof b : b));
  return r;
};

describe('the web card — orders waiting for the shop', () => {
  it('says "од нив N чекаат потврда" under Во магацин за пакување', () => {
    render(<MemoryRouter><Card rows={[webRow(3)]} /></MemoryRouter>);
    const line = screen.getByTestId('web-awaiting-line');
    expect(line.textContent).toBe(i18n.t('overview.cohort.sources.webAwaitingLine', { n: '3', count: 3 }));
    expect(within(line.closest('li')!).getByText(i18n.t('insights.common.bucket.to_pack'))).toBeInTheDocument();
  });
  it('says nothing when none wait (or the payload has no count)', () => {
    for (const r of [webRow(0), webRow()]) {
      const { unmount } = render(<MemoryRouter><Card rows={[r]} /></MemoryRouter>);
      expect(screen.queryByTestId('web-awaiting-line')).toBeNull();
      unmount();
    }
  });
});
