import { supabase } from '@/integrations/supabase/client';
import i18n from '@/i18n';
import { apiErrorText } from '@/i18n/apiErrors';

// Личен дневник (plan Фаза 6–7, 01.10.2026). Server: supabase/functions/api/personalNotes.ts
// + the thin personal-notes/* routes in index.ts. Not apiFetch: a 409 carries the current
// note (the conflict dialog needs it), errors carry a stable `code`, and the autosave's last
// flush goes out with `keepalive` when the tab is hidden or closed.

export const NOTEBOOK_COLORS = ['slate', 'sky', 'emerald', 'amber', 'rose', 'violet'] as const;
export type NotebookColor = (typeof NOTEBOOK_COLORS)[number];

export const PN_LIMITS = { notebooks: 50, notes: 500, notebookTitle: 80, noteTitle: 120, body: 20_000, restoreDays: 30 } as const;

export interface Notebook {
  id: string;
  title: string;
  color: NotebookColor | null;
  position: number;
  note_count: number;
  created_at: string;
  updated_at: string;
  last_updated: string;
}

export interface NotebooksResponse {
  owner: { id: string; name: string | null; is_active: boolean };
  read_only: boolean;
  notebooks: Notebook[];
  limits: { notebooks: number; notes: number; body: number };
}

export interface NoteListItem {
  id: string;
  notebook_id: string;
  title: string;
  snippet: string;
  pinned: boolean;
  updated_at: string;
  version: number;
  chars: number;
}

export interface NotesResponse {
  notebook: Notebook;
  read_only: boolean;
  q: string | null;
  notes: NoteListItem[];
}

export interface Note {
  id: string;
  notebook_id: string;
  owner_id: string;
  title: string;
  body: string;
  pinned: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface NoteResponse {
  note: Note;
  notebook: { id: string; title: string; color: NotebookColor | null };
  read_only: boolean;
}

export interface SavedNote {
  id: string;
  notebook_id: string;
  title: string;
  pinned: boolean;
  version: number;
  updated_at: string;
}

export interface NotePatch {
  title?: string;
  body?: string;
  pinned?: boolean;
  notebook_id?: string;
}

export interface SearchResult extends NoteListItem {
  notebook_title: string;
  notebook_color: NotebookColor | null;
}

export interface SearchResponse {
  q: string | null;
  truncated: boolean;
  results: SearchResult[];
}

export interface DeletedNotebook extends Notebook {
  deleted_at: string;
  days_left: number;
}

export interface DeletedNote {
  id: string;
  notebook_id: string;
  notebook_title: string;
  title: string;
  snippet: string;
  deleted_at: string;
  days_left: number;
}

export interface DeletedResponse {
  restore_days: number;
  notebooks: DeletedNotebook[];
  notes: DeletedNote[];
}

export interface NotesAuthor {
  owner_id: string;
  name: string;
  is_active: boolean;
  is_admin: boolean;
  notebook_count: number;
  note_count: number;
  last_updated: string | null;
}

export type PersonalNotesErrorCode =
  | 'bad_id' | 'bad_title' | 'bad_color' | 'bad_body' | 'bad_version' | 'bad_ids' | 'bad_query'
  | 'bad_pinned' | 'nothing_to_change' | 'notebook_limit' | 'note_limit' | 'not_found'
  | 'forbidden' | 'version_conflict' | 'notebook_deleted' | 'restore_expired' | 'rate_limited';

/** A refused request: `code` from the server (null for a network / non-JSON failure). */
export class PersonalNotesError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly current: Note | null = null) {
    super(message);
    this.name = 'PersonalNotesError';
  }
}

export const isVersionConflict = (e: unknown): e is PersonalNotesError =>
  e instanceof PersonalNotesError && e.code === 'version_conflict';

const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`;

async function pnFetch<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE}/personal-notes/${path}`, {
    method: init.method ?? 'GET',
    keepalive: !!init.keepalive,
    signal: init.keepalive ? undefined : AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text().catch(() => '');
  let parsed: (Record<string, unknown> & { error?: string; code?: string; current?: Note }) | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* a non-JSON 546 / 504 */ }
  if (!res.ok) {
    throw new PersonalNotesError(parsed?.error || `HTTP ${res.status}`, res.status, parsed?.code ?? null, parsed?.current ?? null);
  }
  return parsed as T;
}

const qs = (o: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const apiGetNotebooks = (owner?: string | null) => pnFetch<NotebooksResponse>(`notebooks${qs({ owner })}`);
export const apiCreateNotebook = (body: { title: string; color?: NotebookColor | null }) =>
  pnFetch<{ notebook: Notebook }>('notebooks', { method: 'POST', body });
export const apiUpdateNotebook = (id: string, body: { title?: string; color?: NotebookColor | null }) =>
  pnFetch<{ notebook: Notebook }>(`notebooks/${id}`, { method: 'PATCH', body });
export const apiReorderNotebooks = (ids: string[]) =>
  pnFetch<{ ok: true; order: string[] }>('notebooks/order', { method: 'PUT', body: { ids } });
export const apiDeleteNotebook = (id: string) => pnFetch<{ ok: true }>(`notebooks/${id}`, { method: 'DELETE' });
export const apiRestoreNotebook = (id: string) =>
  pnFetch<{ notebook: Notebook }>(`notebooks/${id}/restore`, { method: 'POST' });

export const apiGetNotes = (notebookId: string, q?: string | null) =>
  pnFetch<NotesResponse>(`notebooks/${notebookId}/notes${qs({ q })}`);
export const apiCreateNote = (notebookId: string, body: { title?: string; body?: string; pinned?: boolean } = {}) =>
  pnFetch<{ note: Note }>(`notebooks/${notebookId}/notes`, { method: 'POST', body });
export const apiGetNote = (id: string) => pnFetch<NoteResponse>(`notes/${id}`);
export const apiSaveNote = (id: string, patch: NotePatch, baseVersion: number, opts?: { keepalive?: boolean }) =>
  pnFetch<{ saved: SavedNote }>(`notes/${id}`, { method: 'PATCH', body: { ...patch, base_version: baseVersion }, keepalive: opts?.keepalive });
export const apiDeleteNote = (id: string) => pnFetch<{ ok: true }>(`notes/${id}`, { method: 'DELETE' });
export const apiRestoreNote = (id: string) =>
  pnFetch<{ ok: true; notebook_id: string }>(`notes/${id}/restore`, { method: 'POST' });

export const apiSearchNotes = (q: string, owner?: string | null) => pnFetch<SearchResponse>(`search${qs({ q, owner })}`);
export const apiGetDeletedNotes = () => pnFetch<DeletedResponse>('deleted');
export const apiGetNotesAuthors = () => pnFetch<{ authors: NotesAuthor[] }>('authors');

/** Query keys — every personal-notes cache lives under ['pn', …] so one invalidation reaches all. */
export const PN_KEYS = {
  all: ['pn'] as const,
  notebooks: (owner: string) => ['pn', 'notebooks', owner] as const,
  notes: (notebookId: string, q: string) => ['pn', 'notes', notebookId, q] as const,
  notesOf: (notebookId: string) => ['pn', 'notes', notebookId] as const,
  note: (id: string) => ['pn', 'note', id] as const,
  search: (owner: string, q: string) => ['pn', 'search', owner, q] as const,
  deleted: ['pn', 'deleted'] as const,
  authors: ['pn', 'authors'] as const,
};

const CODES = new Set<string>([
  'bad_title', 'bad_color', 'bad_body', 'bad_ids', 'bad_query', 'notebook_limit', 'note_limit', 'not_found',
  'forbidden', 'version_conflict', 'notebook_deleted', 'restore_expired', 'rate_limited',
]);

/** The reader's-language text of a failure: the server's code first, then the shared api mapping. */
export function personalNotesErrorText(err: unknown): string {
  if (err instanceof PersonalNotesError && err.code && CODES.has(err.code)) {
    return i18n.t(`personalNotes.errors.${err.code}`);
  }
  return apiErrorText(err);
}
