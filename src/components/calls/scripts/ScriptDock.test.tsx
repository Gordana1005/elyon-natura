import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '@/i18n';
import type { CallScriptsForCall, ScriptsModeInfo } from '@/lib/callScriptsTypes';
import predictionFx from '@/components/callscripts/__fixtures__/forCall.prediction.sample.json';
import leadFx from '@/components/callscripts/__fixtures__/forCall.lead.sample.json';

const api = vi.hoisted(() => ({ mode: vi.fn(), forCall: vi.fn(), index: vi.fn(), item: vi.fn() }));
vi.mock('@/lib/callScriptsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callScriptsApi')>()),
  apiGetScriptsMode: (...a: unknown[]) => api.mode(...a),
  apiGetCallScriptsForCall: (...a: unknown[]) => api.forCall(...a),
  apiGetPublishedScriptsIndex: (...a: unknown[]) => api.index(...a),
  apiGetTargetedScript: (...a: unknown[]) => api.item(...a),
}));

const { ScriptDock } = await import('./ScriptDock');
const { SCRIPT_DOCK_OPEN_KEY } = await import('./scriptDockModel');
const { ScriptDockMobile } = await import('./ScriptDockMobile');

const P = predictionFx as unknown as CallScriptsForCall;
const L = leadFx as unknown as CallScriptsForCall;
const MODE_ON: ScriptsModeInfo = { mode: 'on', enabled_for_me: true, can_write: false, can_delete: false, can_switch: false };
const PHONE = '+38970123456';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  // cmdk / Radix need these in jsdom
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  await i18n.changeLanguage('mk');
});
beforeEach(() => {
  try { localStorage.clear(); } catch { /* */ }
  api.mode.mockResolvedValue(MODE_ON);
  api.forCall.mockResolvedValue(P);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>);
}
const dock = (ctx: Parameters<typeof ScriptDock>[0]['context'] = { source: 'prediction', listId: 'list-21' }) =>
  wrap(<ScriptDock phone={PHONE} context={ctx} />);
const body = () => screen.getByTestId('script-dock-body');
const section = (id: string) => body().querySelector(`[data-section="${id}"]`) as HTMLElement;

describe('ScriptDock (md and up)', () => {
  it('asks GET /calls/scripts for the call and shows the best script: title, group, list, product, version', async () => {
    dock();
    expect(await screen.findByTestId('script-dock-title')).toHaveTextContent('Предикција 21 ден — Простатол');
    expect(api.forCall).toHaveBeenCalledWith({ phone: PHONE, source: 'prediction', order_id: null, list_id: 'list-21' }, expect.anything());
    expect(screen.getByTestId('group-chip')).toHaveTextContent('21–57 дена');
    // the list's DISPLAY label; the raw engine name only in the tooltip
    const list = screen.getByTestId('list-chip');
    expect(list).toHaveTextContent('21–57 дена · над 1.599 ден · 1–3 нарачки');
    expect(list).toHaveAttribute('title', '21d 26+ (1-3 orders)');
    expect(screen.getByTestId('product-chip')).toHaveTextContent('Prostatol Complex');
    expect(screen.getByTestId('script-version')).toHaveTextContent('Ажурирано 02.10.2026 · v3');
    // the body: section chips + the filled variables + the amber chip for the missing city
    expect(within(screen.getByTestId('section-chips')).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Отворање', 'Презентација', 'Приговори', 'Затворање', 'Подарок', 'Брзи одговори (2)']);
    expect(section('opening')).toHaveTextContent('Добар ден Марија, јас сум Ана од Натура Терапи.');
    expect(within(section('closing')).getByTestId('var-missing')).toHaveTextContent('Град');
    expect(screen.queryByTestId('preview-badge')).toBeNull();
  });

  it('"Зошто?" explains the tier, the reasons and where the group came from', async () => {
    dock();
    fireEvent.click(await screen.findByTestId('why-trigger'));
    const pop = await screen.findByTestId('why-popover');
    expect(pop).toHaveTextContent('Ниво 1 од 4 — група и производ');
    expect(pop).toHaveTextContent('Групата се совпаѓа: 21–57 дена');
    expect(pop).toHaveTextContent('Производот се совпаѓа: Prostatol Complex');
    expect(pop).toHaveTextContent('Групата е од листата: 21–57 дена · над 1.599 ден · 1–3 нарачки');
    expect(pop).toHaveTextContent('Предикција');
  });

  it('the alternatives are tabs: the best is starred, another tab shows that script and its own "why"', async () => {
    dock();
    const tabs = within(await screen.findByTestId('script-tabs')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Предикција 21 ден — Простатол', 'Предикција 21 ден — општо', 'Простатол — сите клиенти',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs[0]).getByLabelText('Препорачана')).toBeInTheDocument();
    fireEvent.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('script-dock-title')).toHaveTextContent('Предикција 21 ден — општо');
    expect(section('opening')).toHaveTextContent('да проверам дали сте задоволни со Prostatol Complex');
    expect(screen.queryByTestId('section-chips')?.textContent ?? '').not.toContain('Брзи одговори');
    fireEvent.click(screen.getByTestId('why-trigger'));
    const pop = await screen.findByTestId('why-popover');
    expect(pop).toHaveTextContent('Ниво 2 од 4 — група, сите производи');
    expect(pop).toHaveTextContent('Скриптата важи за сите производи');
  });

  it('mk / sq: the Albanian flag reads the sq text (Macedonian marked where sq is missing) and is remembered', async () => {
    dock();
    await screen.findByTestId('script-dock-title');
    fireEvent.click(screen.getByRole('button', { name: /Shqip/ }));
    expect(screen.getByTestId('script-dock-title')).toHaveTextContent('Parashikim 21 ditë — Prostatol');
    expect(section('opening')).toHaveTextContent('Mirëdita Марија, jam Ана nga Natura Therapy');
    expect(within(section('objections')).getByTestId('fallback-mk')).toBeInTheDocument();
    expect(localStorage.getItem('elyon.scriptLang')).toBe('sq');
  });

  it('collapses, and the choice is remembered on the device', async () => {
    const first = dock();
    await screen.findByTestId('script-dock-title');
    fireEvent.click(screen.getByTestId('script-dock-toggle'));
    expect(screen.queryByTestId('script-dock-body')).toBeNull();
    expect(screen.getByTestId('script-dock-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('script-dock-title')).toBeInTheDocument(); // the title stays in the header
    expect(localStorage.getItem(SCRIPT_DOCK_OPEN_KEY)).toBe('0');
    first.unmount();
    dock();
    await screen.findByTestId('script-dock-title');
    expect(screen.queryByTestId('script-dock-body')).toBeNull();
  });

  it('"Преглед" while the mode is preview', async () => {
    api.mode.mockResolvedValue({ ...MODE_ON, mode: 'preview' });
    api.forCall.mockResolvedValue({ ...P, mode: 'preview' });
    dock();
    expect(await screen.findByTestId('preview-badge')).toHaveTextContent('Преглед');
  });

  it('no script: says for which group · product; "Напиши ја" only for a writer, aimed at that cell', async () => {
    const empty = { ...L, best: null, alternatives: [] };
    api.forCall.mockResolvedValue(empty);
    const first = dock({ source: 'lead', orderId: 'o1' });
    const box = await screen.findByTestId('script-dock-empty');
    expect(box).toHaveTextContent('Нема скрипта за Нов лид · Neurofix');
    expect(within(box).queryByTestId('write-script')).toBeNull();
    first.unmount();

    api.mode.mockResolvedValue({ ...MODE_ON, can_write: true });
    dock({ source: 'lead', orderId: 'o1' });
    const link = await screen.findByTestId('write-script');
    expect(link).toHaveTextContent('Напиши ја');
    expect(link.getAttribute('href')).toBe('/call-scripts?tab=library&new=1&group=lead_new&product=a1000000-0000-4000-8000-000000000003');
  });

  it('the search opens any published script by title (Latin finds Cyrillic) as a hand-picked tab', async () => {
    api.index.mockResolvedValue({ scripts: [
      { id: 'x1', title: 'Артро Плус — сите', groups: [], product_ids: [], version: 1 },
      { id: 'x2', title: 'Корпа — враќање', groups: ['trash'], product_ids: [], version: 2 },
    ] });
    api.item.mockResolvedValue({ ...L.alternatives[0], id: 'x1', title: 'Артро Плус — сите', version: 7 });
    dock();
    await screen.findByTestId('script-dock-title');
    fireEvent.click(screen.getByTestId('script-search-trigger'));
    const pop = await screen.findByTestId('script-search');
    await within(pop).findByText('Артро Плус — сите');
    fireEvent.change(within(pop).getByRole('combobox'), { target: { value: 'artro' } });
    await waitFor(() => expect(within(pop).queryByText('Корпа — враќање')).toBeNull());
    fireEvent.click(within(pop).getByText('Артро Плус — сите'));
    await waitFor(() => expect(api.item).toHaveBeenCalledWith('x1'));
    const picked = await screen.findByRole('tab', { name: /Рачно избрана/ });
    expect(picked).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('script-dock-title')).toHaveTextContent('Артро Плус — сите'));
    fireEvent.click(screen.getByTestId('why-trigger'));
    expect(await screen.findByTestId('why-popover')).toHaveTextContent('избра рачно');
    // closing it goes back to the best script
    fireEvent.click(screen.getByRole('button', { name: 'Затвори ја рачно избраната скрипта' }));
    expect(screen.getByTestId('script-dock-title')).toHaveTextContent('Предикција 21 ден — Простатол');
  });
});

describe('ScriptDockMobile (below md)', () => {
  it('a compact "Скрипта · <title>" row; a tap opens the same script in a bottom sheet', async () => {
    api.forCall.mockResolvedValue(L);
    wrap(<ScriptDockMobile phone={PHONE} context={{ source: 'lead', orderId: 'c3000000-0000-4000-8000-000000000001' }} />);
    const trigger = await screen.findByTestId('script-dock-trigger');
    await waitFor(() => expect(trigger).toHaveTextContent('Скрипта · Лид — Неурофикс (нов и повторен повик)'));
    fireEvent.click(trigger);
    const sheet = await screen.findByTestId('script-dock-sheet');
    expect(within(sheet).getByTestId('script-dock-title')).toHaveTextContent('Лид — Неурофикс (нов и повторен повик)');
    expect(within(sheet).getByTestId('group-chip')).toHaveTextContent('Нов лид');
    const opening = sheet.querySelector('[data-section="opening"]') as HTMLElement;
    expect(opening).toHaveTextContent('Добар ден Петар, Ана од БиоНатурал. Се јавувам за Неурофикс — нарачка 104233.');
    expect(within(sheet).getAllByRole('tab')).toHaveLength(2);
  });

  it('says so when there is no script for the call', async () => {
    api.forCall.mockResolvedValue({ ...L, best: null, alternatives: [] });
    wrap(<ScriptDockMobile phone={PHONE} context={{ source: 'manual' }} />);
    const trigger = await screen.findByTestId('script-dock-trigger');
    await waitFor(() => expect(trigger).toHaveTextContent('Скрипта · нема за овој повик'));
  });
});
