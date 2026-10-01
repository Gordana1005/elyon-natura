/**
 * /altercpa tabs (plan 01.10.2026, Фаза 4): Денес · Стапки · Лидови · Поставки.
 *
 * ?tab=today (the default) | rates | leads | setup&sub=<inner tab>. The old
 * tab keys still arrive from bookmarks and history — mirror, offers,
 * affiliates, sources, accounts, runs — and land on Поставки with that inner
 * tab. `rates` keeps its key so the notification links
 * /altercpa?tab=rates&wm=&date= keep opening the right cell.
 *
 * Pure (tabs.test.ts).
 */
export const ALTERCPA_TABS = ['today', 'rates', 'leads', 'setup'] as const;
export type AlterCpaTab = (typeof ALTERCPA_TABS)[number];

export const SETUP_SUBS = ['mirror', 'offers', 'affiliates', 'sources', 'accounts', 'runs'] as const;
export type SetupSub = (typeof SETUP_SUBS)[number];

export interface ResolvedTab {
  tab: AlterCpaTab;
  sub: SetupSub;
  /** The params to replace the URL with when an old key was used; null = the URL is already canonical. */
  canonical: URLSearchParams | null;
}

const isTab = (v: string | null): v is AlterCpaTab => !!v && (ALTERCPA_TABS as readonly string[]).includes(v);
const isSub = (v: string | null): v is SetupSub => !!v && (SETUP_SUBS as readonly string[]).includes(v);

export function resolveAlterCpaTab(sp: URLSearchParams): ResolvedTab {
  const raw = sp.get('tab');
  const rawSub = sp.get('sub');
  if (isSub(raw)) {
    const next = new URLSearchParams(sp);
    next.set('tab', 'setup');
    next.set('sub', raw);
    return { tab: 'setup', sub: raw, canonical: next };
  }
  const tab: AlterCpaTab = isTab(raw) ? raw : 'today';
  return { tab, sub: isSub(rawSub) ? rawSub : 'mirror', canonical: null };
}

/** The params after choosing a tab: inner-tab and filter params of the other tabs are dropped. */
export function tabParams(sp: URLSearchParams, tab: AlterCpaTab, sub?: SetupSub): URLSearchParams {
  const next = new URLSearchParams();
  next.set('tab', tab);
  if (tab === 'setup') next.set('sub', sub ?? (isSub(sp.get('sub')) ? (sp.get('sub') as SetupSub) : 'mirror'));
  return next;
}
