import { describe, expect, it } from 'vitest';
import { resolveAlterCpaTab, tabParams } from './tabs';

const sp = (s: string) => new URLSearchParams(s);

describe('resolveAlterCpaTab', () => {
  it('opens on Денес by default and for an unknown key', () => {
    expect(resolveAlterCpaTab(sp(''))).toMatchObject({ tab: 'today', sub: 'mirror', canonical: null });
    expect(resolveAlterCpaTab(sp('tab=nope'))).toMatchObject({ tab: 'today', canonical: null });
  });

  it('keeps the four new tabs as they are', () => {
    for (const t of ['today', 'rates', 'leads', 'setup']) expect(resolveAlterCpaTab(sp(`tab=${t}`)).tab).toBe(t);
    expect(resolveAlterCpaTab(sp('tab=setup&sub=runs'))).toMatchObject({ tab: 'setup', sub: 'runs', canonical: null });
  });

  it('keeps the notification links on Стапки with their cell', () => {
    const r = resolveAlterCpaTab(sp('tab=rates&wm=3221&date=2026-09-28'));
    expect(r).toMatchObject({ tab: 'rates', canonical: null });
  });

  it('sends every old key to Поставки with that inner tab, keeping the other params', () => {
    for (const old of ['mirror', 'offers', 'affiliates', 'sources', 'accounts', 'runs']) {
      const r = resolveAlterCpaTab(sp(`tab=${old}&x=1`));
      expect(r.tab).toBe('setup');
      expect(r.sub).toBe(old);
      expect(r.canonical?.toString()).toBe(`tab=setup&x=1&sub=${old}`);
    }
  });

  it('tabParams drops the other tabs’ filters', () => {
    expect(tabParams(sp('tab=leads&wm=3221&decision=open'), 'rates').toString()).toBe('tab=rates');
    expect(tabParams(sp('tab=setup&sub=runs'), 'setup').toString()).toBe('tab=setup&sub=runs');
    expect(tabParams(sp('tab=today'), 'setup', 'offers').toString()).toBe('tab=setup&sub=offers');
  });
});
