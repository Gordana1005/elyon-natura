import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '@/i18n';
import type { Note, NoteListItem, Notebook } from '@/lib/personalNotesApi';

// Личен дневник: a reader (admin / manager on an operator's notebooks) gets NO control that
// writes — no new / rename / delete / pin / move, no editable title or text; the operator's
// own workspace drills down notebooks → notes → the note through the URL, and ← walks back.
const h = vi.hoisted(() => ({
  notebooks: vi.fn(), notes: vi.fn(), note: vi.fn(), search: vi.fn(), save: vi.fn(), toast: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('@/lib/personalNotesApi', async (orig) => {
  const m = await orig<typeof import('@/lib/personalNotesApi')>();
  return {
    ...m,
    apiGetNotebooks: (owner?: string | null) => h.notebooks(owner),
    apiGetNotes: (nb: string, q?: string | null) => h.notes(nb, q),
    apiGetNote: (id: string) => h.note(id),
    apiSearchNotes: (q: string, owner?: string | null) => h.search(q, owner),
    apiSaveNote: (...a: unknown[]) => h.save(...a),
  };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { NotesWorkspace } = await import('./NotesWorkspace');

const OWNER = '44444444-4444-4444-8444-444444444444';
const NB1 = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';
const N1 = '33333333-3333-4333-8333-333333333333';

const nb = (id: string, title: string, note_count: number): Notebook => ({
  id, title, color: 'sky', position: 0, note_count,
  created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', last_updated: '2026-10-01T08:00:00Z',
});
const item: NoteListItem = {
  id: N1, notebook_id: NB1, title: 'Повик кај Ана', snippet: 'Да се јави во петок', pinned: true,
  updated_at: '2026-10-01T09:00:00Z', version: 3, chars: 19,
};
const note: Note = {
  id: N1, notebook_id: NB1, owner_id: OWNER, title: 'Повик кај Ана', body: 'Да се јави во петок',
  pinned: true, version: 3, created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T09:00:00Z',
};

function Probe() {
  const loc = useLocation();
  return <output data-testid="search">{loc.search}</output>;
}

function renderAt(url: string, props: { ownerId: string | null; readOnly: boolean; ownerName?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/personal-list" element={<><NotesWorkspace {...props} /><Probe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const step = (c: HTMLElement) => c.querySelector('[data-step]')?.getAttribute('data-step');
const pane = (c: HTMLElement, name: string) => c.querySelector(`[data-pane="${name}"]`) as HTMLElement;
const search = () => new URLSearchParams(screen.getByTestId('search').textContent ?? '');

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.notebooks.mockResolvedValue({
    owner: { id: OWNER, name: 'Ана Петровска', is_active: true }, read_only: false,
    notebooks: [nb(NB1, 'Клиенти', 1), nb(NB2, 'Производи', 0)], limits: { notebooks: 50, notes: 500, body: 20000 },
  });
  h.notes.mockImplementation(async (id: string) => ({
    notebook: nb(id, id === NB1 ? 'Клиенти' : 'Производи', id === NB1 ? 1 : 0), read_only: false, q: null,
    notes: id === NB1 ? [item] : [],
  }));
  h.note.mockResolvedValue({ note, notebook: { id: NB1, title: 'Клиенти', color: 'sky' }, read_only: false });
});

describe('NotesWorkspace — read only', { timeout: 30_000 }, () => {
  it('shows the note with the banner and renders no control that writes', async () => {
    const { container } = renderAt(`/personal-list?tab=agent-notes&owner=${OWNER}&nb=${NB1}&note=${N1}`,
      { ownerId: OWNER, readOnly: true, ownerName: 'Ана Петровска' });

    expect(await screen.findByText(i18n.t('personalNotes.reader.banner', { name: 'Ана Петровска' }))).toBeInTheDocument();
    expect(h.notebooks).toHaveBeenCalledWith(OWNER);
    expect(within(pane(container, 'editor')).getByText('Да се јави во петок')).toBeInTheDocument();

    // no create / rename / reorder / delete / pin / move / restore — anywhere
    for (const name of [
      'personalNotes.notebooks.new', 'personalNotes.notes.new', 'personalNotes.notebooks.menu',
      'personalNotes.editor.pin', 'personalNotes.editor.unpin', 'personalNotes.editor.delete',
      'personalNotes.editor.move', 'personalNotes.deleted.open',
    ]) {
      expect(screen.queryByRole('button', { name: i18n.t(name) }), name).toBeNull();
      expect(screen.queryByRole('combobox', { name: i18n.t(name) }), name).toBeNull();
    }
    // the only text field is the search box — no title / text editing
    const boxes = screen.getAllByRole('textbox');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAttribute('aria-label', i18n.t('personalNotes.notes.search'));
    expect(container.querySelector('textarea')).toBeNull();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('an empty notebook says so without offering a new note', async () => {
    renderAt(`/personal-list?tab=agent-notes&owner=${OWNER}&nb=${NB2}`, { ownerId: OWNER, readOnly: true });
    expect(await screen.findByText(i18n.t('personalNotes.notes.emptyReadOnly'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('personalNotes.notes.new') })).toBeNull();
  });
});

describe('NotesWorkspace — drill-down (phone: one pane at a time)', { timeout: 30_000 }, () => {
  it('notebooks → notes → the note via the URL, and ← walks back up', async () => {
    const { container } = renderAt('/personal-list?tab=notes', { ownerId: null, readOnly: false });

    const notebookButton = await screen.findByRole('button', { name: /Клиенти/ });
    expect(step(container)).toBe('notebooks');
    expect(pane(container, 'notes')).toHaveClass('hidden');
    expect(pane(container, 'editor')).toHaveClass('hidden');
    expect(h.notebooks).toHaveBeenCalledWith(null);

    fireEvent.click(notebookButton);
    await waitFor(() => expect(step(container)).toBe('notes'));
    expect(search().get('nb')).toBe(NB1);
    expect(search().get('tab')).toBe('notes');
    expect(pane(container, 'notebooks')).toHaveClass('hidden');
    expect(pane(container, 'notes')).not.toHaveClass('hidden');

    fireEvent.click(await within(pane(container, 'notes')).findByRole('button', { name: /Повик кај Ана/ }));
    await waitFor(() => expect(step(container)).toBe('editor'));
    expect(search().get('note')).toBe(N1);
    // the operator's own note opens in the editor
    expect(await screen.findByDisplayValue('Повик кај Ана')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Да се јави во петок').tagName).toBe('TEXTAREA');
    expect(screen.getByText('19 / 20.000')).toBeInTheDocument();

    // ← from the note (the drill-down pushed history: back = the notes list)
    fireEvent.click(within(pane(container, 'editor')).getByRole('button', { name: i18n.t('personalNotes.back') }));
    await waitFor(() => expect(step(container)).toBe('notes'));
    expect(search().get('note')).toBeNull();
    expect(search().get('nb')).toBe(NB1);

    // ← from the notes list
    fireEvent.click(within(pane(container, 'notes')).getByRole('button', { name: i18n.t('personalNotes.back') }));
    await waitFor(() => expect(step(container)).toBe('notebooks'));
    expect(search().get('nb')).toBeNull();
  });

  it('a deep link opens straight on the note; ← without history goes one level up', async () => {
    const { container } = renderAt(`/personal-list?tab=notes&nb=${NB1}&note=${N1}`, { ownerId: null, readOnly: false });
    expect(await screen.findByDisplayValue('Повик кај Ана')).toBeInTheDocument();
    expect(step(container)).toBe('editor');
    fireEvent.click(within(pane(container, 'editor')).getByRole('button', { name: i18n.t('personalNotes.back') }));
    await waitFor(() => expect(step(container)).toBe('notes'));
    expect(search().get('nb')).toBe(NB1);
    expect(search().get('tab')).toBe('notes');
  });
});
