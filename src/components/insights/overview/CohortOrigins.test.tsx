import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { Cohort, CohortSourceRow } from '../shared/cohortTypes';
import { stripCohortMoney } from '../shared/cohortModel';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import { CohortSources } from './CohortSources';
import { accountParts, originParts } from './cohortOverview';

// "Од каде се купувачите" (owner 15.10.2026): Teleshop Out's (and Affiliate Out's) sales by where
// each buyer FIRST came from — Bio Natural lead / Natura Therapy–Ad Astra / new — adding up to the
// card's total, and the MEX profile they went out on. Never on an In department; nothing at all
// before customer_origin's first fill (origins null) or from an older api.
beforeAll(async () => { await i18n.changeLanguage('mk'); });
const t = i18n.t.bind(i18n);

const rows = () => structuredClone((cohortSample as unknown as Cohort).by_source) as CohortSourceRow[];

function Cards({ rows: r, money = true }: { rows: CohortSourceRow[]; money?: boolean }) {
  const f = useInsightsFormat();
  const total = r.reduce((a, x) => ({ ...a, count: a.count + x.total.count }), { count: 0, value_mkd: null, cod_mkd: null });
  return <CohortSources rows={r} total={total} leadsTotal={null} money={money} range={{ from: '2026-09-22', to: '2026-09-28' }} f={f} />;
}
const card = (key: string) => screen.getByRole('article', { name: i18n.t(`insights.common.source.${key === 'teleshop_other' ? 'teleshopOther' : key}`) });

describe('the model', () => {
  it('Out departments only, zeros filled, in the display order', () => {
    const [alter, elyon, out] = rows();
    expect(originParts(alter)).toBeNull();
    expect(originParts(out)!.map((p) => [p.key, p.count])).toEqual([['bio_natural', 9], ['natura', 29], ['new', 2]]);
    expect(originParts({ key: 'teleshop_out', origins: [{ key: 'natura', count: 4 }] })!.map((p) => p.count)).toEqual([0, 4, 0]);
    expect(originParts({ key: 'teleshop_out', origins: null })).toBeNull();
    expect(originParts({ key: 'teleshop_out', origins: [{ key: 'new', count: 0 }] })).toBeNull();
    expect(accountParts(elyon)!.map((a) => a.key)).toEqual(['natura', 'bio_natural', 'none']);
    expect(accountParts(out)!.map((a) => a.key)).toEqual(['natura', 'bio_natural']);   // none = 0 is left out
    expect(accountParts({ accounts: undefined })).toBeNull();
  });
  it('the parts add up to the department total (the fixture mirrors the SQL self-check)', () => {
    for (const r of rows().filter((x) => Array.isArray(x.origins))) {
      expect(r.origins!.reduce((a, o) => a + o.count, 0)).toBe(r.total.count);
      expect(r.origins!.reduce((a, o) => a + (o.value_mkd ?? 0), 0)).toBe(r.total.value_mkd);
      expect(r.accounts!.reduce((a, o) => a + o.count, 0)).toBe(r.total.count);
    }
  });
});

describe('the card', () => {
  it('owner: Teleshop Out shows the three origins with денари and the post', () => {
    render(<MemoryRouter><Cards rows={rows()} /></MemoryRouter>);
    const block = within(card('teleshop_out')).getByTestId('origin-teleshop_out');
    const bio = within(block).getByTestId('origin-tile-bio_natural');
    const nat = within(block).getByTestId('origin-tile-natura');
    expect(within(bio).getByText(t('overview.cohort.origin.key.bio_natural'))).toBeInTheDocument();
    expect(within(bio).getByText('9')).toBeInTheDocument();
    expect(within(bio).getByText(formatDenari(21300))).toBeInTheDocument();
    expect(within(nat).getByText(t('overview.cohort.origin.key.natura'))).toBeInTheDocument();
    expect(within(nat).getByText('29')).toBeInTheDocument();
    expect(within(nat).getByText(formatDenari(64400))).toBeInTheDocument();
    expect(within(block).getByText(t('overview.cohort.origin.web', { n: '1', count: 1 }))).toBeInTheDocument();
    expect(within(block).getByTestId('accounts-teleshop_out').textContent).toBe(`${t('overview.cohort.origin.accountsTitle')}: NATURA 31 · BIO NATURAL 9`);
    // the block sits at the TOP of the card, before the parts
    const art = card('teleshop_out');
    expect(art.innerHTML.indexOf('origin-teleshop_out')).toBeLessThan(art.innerHTML.indexOf(t('insights.common.bucket.paid')));
    expect(within(block).getByText(t('overview.cohort.origin.mixed', { n: '7', count: 7 }))).toBeInTheDocument();
    // Affiliate Out is the mirror; an In department tells none
    expect(within(card('elyon_crm')).getByTestId('origin-elyon_crm')).toBeInTheDocument();
    expect(within(card('altercpa')).queryByTestId('origin-altercpa')).toBeNull();
    expect(within(card('teleshop_other')).queryByTestId('origin-teleshop_other')).toBeNull();
  });

  it('a manager: the same counts, not one denar', () => {
    const r = (stripCohortMoney(cohortSample as unknown as Cohort) as Cohort).by_source;
    render(<MemoryRouter><Cards rows={r} money={false} /></MemoryRouter>);
    const block = within(card('teleshop_out')).getByTestId('origin-teleshop_out');
    expect(within(block).getByText('29')).toBeInTheDocument();
    expect(block.textContent).not.toMatch(/\d ден(?![а-яѓќљњџѕ])/);
  });

  it('before the first fill (origins null) or from an older api: nothing', () => {
    const r = rows().map((x) => ({ ...x, origins: x.key === 'teleshop_out' ? null : undefined }));
    render(<MemoryRouter><Cards rows={r} /></MemoryRouter>);
    expect(screen.queryByTestId('origin-teleshop_out')).toBeNull();
    expect(screen.queryByTestId('origin-elyon_crm')).toBeNull();
  });
});
