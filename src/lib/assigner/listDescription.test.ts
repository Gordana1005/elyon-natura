import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { formatMoney } from '@/lib/currency';
import { listLabel } from '@/components/insights/lists/listModel';
import { listDescription, listGroupLabel, listGroupOf } from './listDescription';

// The Assigner shows every list in the reader's language: the label
// (listLabel) and a description generated from the NAME — the English DB text is
// only the fallback for a list nobody taught the parser.
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const den26 = formatMoney(26); // the engine's €26 band, in денари

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('listDescription — mk', () => {
  it('a band list: recency · last paid order band in денари · lifetime paid orders', () => {
    expect(listDescription(t, '21d 26+ (1-3 orders)', 'Last paid 21-57 days ago | last paid order over €26 | 1-2 lifetime paid orders'))
      .toBe(`Последно платиле пред 21–57 дена · последната платена нарачка над ${den26} · 1–2 платени нарачки вкупно`);
    expect(listDescription(t, '57d ≤26 (3+ orders)'))
      .toBe(`Последно платиле пред 57–120 дена (околу 2–4 месеци) · последната платена нарачка до ${den26} · 3–4 платени нарачки вкупно`);
    expect(listDescription(t, '2yr+ 26+ (7+ orders)'))
      .toBe(`Последно платиле пред повеќе од 2 години · последната платена нарачка над ${den26} · 7 или повеќе платени нарачки вкупно`);
    expect(den26).toBe('1.599 ден');
  });

  it('NEWCOMERS', () => {
    expect(listDescription(t, 'NEWCOMERS (1-3 orders)', 'Paid within the last 21 days | 1-2 lifetime paid orders'))
      .toBe('Платиле во последните 21 ден · 1–2 платени нарачки вкупно');
    expect(listDescription(t, 'NEWCOMERS (5+ orders)')).toBe('Платиле во последните 21 ден · 5–6 платени нарачки вкупно');
  });

  it('the pens: Current Cancels, Current Returns, Trash List', () => {
    const cancels = listDescription(t, 'Current Cancels', 'Most recent action was a cancellation within the last 14 days.');
    expect(cancels).toMatch(/^Последната активност е откажување во последните 14 дена/);
    expect(listDescription(t, 'Current Returns', 'Customers whose most recent order was a RETURN.')).toMatch(/^Клиенти чија последна нарачка е вратена/);
    expect(listDescription(t, 'Trash List', 'Every customer whose most recent order was TRASHED')).toMatch(/корпа/);
    expect(listDescription(t, 'Never-Converted Recent')).toMatch(/^Никогаш не купиле/);
  });

  it('an unknown list falls back to the DB text (or nothing)', () => {
    expect(listDescription(t, 'Кампања септември', 'Uploaded from Excel')).toBe('Uploaded from Excel');
    expect(listDescription(t, 'Кампања септември', null)).toBeNull();
    expect(listDescription(t, 'Кампања септември', '   ')).toBeNull();
  });

  it('no English leaks into a generated mk description', () => {
    for (const name of ['21d 26+ (1-3 orders)', '4-6m ≤26 (5+ orders)', 'NEWCOMERS (7+ orders)', 'Current Cancels', 'Due to Reorder', 'Cancelled Pendings']) {
      expect(listDescription(t, name, 'ENGLISH FALLBACK') ?? '').not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it('listLabel names the list in mk (display only — the key stays the name)', () => {
    expect(listLabel(t, '21d 26+ (1-3 orders)')).toBe(`21–57 дена · над ${den26} · 1–3 нарачки`);
    expect(listLabel(t, 'Trash List')).toBe('Корпа');
    expect(listLabel(t, 'Current Cancels')).toBe('Скорешни откажувања (14 дена)');
  });
});

describe('list groups', () => {
  it('group by recency, then cancels / returns / trash / other', () => {
    expect(listGroupOf('NEWCOMERS (1-3 orders)')).toBe('newcomers');
    expect(listGroupOf('21d 26+ (1-3 orders)')).toBe('d21');
    expect(listGroupOf('57d ≤26 (3+ orders)')).toBe('d57');
    expect(listGroupOf('1-2yr ≤26 (7+ orders)')).toBe('y1_2');
    expect(listGroupOf('Current Cancels')).toBe('cancels');
    expect(listGroupOf('Never-Converted Old')).toBe('cancels');
    expect(listGroupOf('Current Returns')).toBe('returns');
    expect(listGroupOf('Trash List')).toBe('trash');
    expect(listGroupOf('Due to Reorder')).toBe('other');
    expect(listGroupOf('Something new', 'cancel')).toBe('cancels');
    expect(listGroupOf('Something new', 'value')).toBe('other');
  });

  it('group headings are translated', () => {
    expect(listGroupLabel(t, 'd21')).toBe('21–57 дена од последната нарачка');
    expect(listGroupLabel(t, 'trash')).toBe('Корпа');
    expect(listGroupLabel(t, 'cancels')).toBe('Откажувања и никогаш не купиле');
  });
});
