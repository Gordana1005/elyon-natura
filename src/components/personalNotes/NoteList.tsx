import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Globe, Loader2, Pin, Plus, Search, StickyNote, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import {
  PN_KEYS, PN_LIMITS, apiCreateNote, apiGetNotes, apiSearchNotes, personalNotesErrorText,
  type NoteListItem, type SearchResult,
} from '@/lib/personalNotesApi';
import { sortNotes } from '@/lib/personalNotes/model';
import { dotClass } from './colors';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const h = setTimeout(() => setD(v), ms);
    return () => clearTimeout(h);
  }, [v, ms]);
  return d;
}

/**
 * The notes of one notebook: pinned first, then the newest. The search box searches this
 * notebook on the server (title + the whole text); "Барај насекаде" searches every notebook.
 */
export function NoteList({
  notebookId, ownerId, ownerKey, readOnly, activeNoteId, onOpen, onBack,
}: {
  notebookId: string;
  /** null = mine. */
  ownerId: string | null;
  ownerKey: string;
  readOnly: boolean;
  activeNoteId: string | null;
  onOpen: (noteId: string, notebookId: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [everywhere, setEverywhere] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 350);

  useEffect(() => { setSearch(''); setEverywhere(false); }, [notebookId]);

  const list = useQuery({
    queryKey: PN_KEYS.notes(notebookId, q),
    queryFn: () => apiGetNotes(notebookId, q || null),
    placeholderData: (prev) => (prev && prev.notebook.id === notebookId ? prev : undefined),
  });
  const global = useQuery({
    queryKey: PN_KEYS.search(ownerKey, q),
    queryFn: () => apiSearchNotes(q, ownerId),
    enabled: everywhere && q.length > 0,
  });

  const notes = sortNotes(list.data?.notes ?? []);
  const notebook = list.data?.notebook;
  const atLimit = (notebook?.note_count ?? notes.length) >= PN_LIMITS.notes;

  const create = async () => {
    setCreating(true);
    try {
      const r = await apiCreateNote(notebookId);
      void qc.invalidateQueries({ queryKey: PN_KEYS.notesOf(notebookId) });
      void qc.invalidateQueries({ queryKey: PN_KEYS.notebooks(ownerKey) });
      setSearch('');
      onOpen(r.note.id, notebookId);
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 lg:hidden" onClick={onBack} aria-label={t('personalNotes.back')}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">
          <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dotClass(notebook?.color))} aria-hidden />
          <span className="truncate">{notebook?.title ?? t('personalNotes.notes.heading')}</span>
        </h2>
        {!readOnly && (
          <Button
            size="sm" className="h-8 shrink-0 gap-1 px-2"
            disabled={creating || atLimit || !notebook}
            title={atLimit ? t('personalNotes.notes.limit', { max: PN_LIMITS.notes }) : t('personalNotes.notes.new')}
            onClick={() => void create()}
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
            {/* the lg pane is 15rem: an icon (+ the accessible name) leaves the notebook title room */}
            <span className="lg:sr-only">{t('personalNotes.notes.new')}</span>
          </Button>
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('personalNotes.notes.search')}
          aria-label={t('personalNotes.notes.search')}
          className="h-9 pl-8 pr-8 text-sm"
          maxLength={100}
        />
        {search && (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted"
            onClick={() => { setSearch(''); setEverywhere(false); }}
            aria-label={t('common.clear')}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {q && (
        everywhere ? (
          <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5" onClick={() => setEverywhere(false)}>
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('personalNotes.notes.closeSearch')}</span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5" onClick={() => setEverywhere(true)}>
            <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{t('personalNotes.notes.searchEverywhere')}</span>
          </Button>
        )
      )}

      <div className="min-w-0">
        {everywhere && q ? (
          <GlobalResults
            loading={global.isLoading}
            error={global.isError ? personalNotesErrorText(global.error) : null}
            onRetry={() => void global.refetch()}
            q={q}
            results={global.data?.results ?? []}
            truncated={!!global.data?.truncated}
            activeNoteId={activeNoteId}
            onOpen={onOpen}
          />
        ) : list.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
        ) : list.isError ? (
          <LoadError text={personalNotesErrorText(list.error)} onRetry={() => void list.refetch()} />
        ) : notes.length === 0 ? (
          q ? (
            <p className="px-1 py-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('personalNotes.notes.noMatch', { q })}</p>
          ) : (
            <EmptyState
              size="sm"
              icon={<StickyNote className="h-5 w-5" />}
              title={readOnly ? t('personalNotes.notes.emptyReadOnly') : t('personalNotes.notes.empty')}
              description={readOnly ? undefined : t('personalNotes.notes.emptyDesc')}
            />
          )
        ) : (
          <ul className="space-y-1.5" aria-label={t('personalNotes.notes.heading')}>
            {notes.map((n) => (
              <li key={n.id}><NoteRow note={n} active={n.id === activeNoteId} onOpen={() => onOpen(n.id, notebookId)} /></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NoteRow({ note, active, onOpen, notebook }: {
  note: NoteListItem;
  active: boolean;
  onOpen: () => void;
  notebook?: { title: string; color: SearchResult['notebook_color'] };
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'block w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors',
        active ? 'border-primary/50 bg-primary/5' : 'bg-card hover:bg-muted/60',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {note.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-label={t('personalNotes.notes.pinned')} />}
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', !note.title && 'italic text-muted-foreground')}>
          {note.title || t('personalNotes.notes.untitled')}
        </span>
      </span>
      {note.snippet && (
        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{note.snippet}</span>
      )}
      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
        {notebook && (
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass(notebook.color))} aria-hidden />
            <span className="truncate">{notebook.title}</span>
          </span>
        )}
        <span className="shrink-0">{formatDistanceToNow(new Date(note.updated_at), { addSuffix: true })}</span>
      </span>
    </button>
  );
}

function GlobalResults({ loading, error, onRetry, q, results, truncated, activeNoteId, onOpen }: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  q: string;
  results: SearchResult[];
  truncated: boolean;
  activeNoteId: string | null;
  onOpen: (noteId: string, notebookId: string) => void;
}) {
  const { t } = useTranslation();
  if (loading) return <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>;
  if (error) return <LoadError text={error} onRetry={onRetry} />;
  return (
    <div className="space-y-1.5">
      <p className="px-1 text-xs font-medium text-muted-foreground">{t('personalNotes.notes.everywhereTitle')}</p>
      {results.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('personalNotes.notes.everywhereEmpty', { q })}</p>
      ) : (
        <ul className="space-y-1.5">
          {results.map((r) => (
            <li key={r.id}>
              <NoteRow
                note={r}
                active={r.id === activeNoteId}
                notebook={{ title: r.notebook_title, color: r.notebook_color }}
                onOpen={() => onOpen(r.id, r.notebook_id)}
              />
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="px-1 text-xs text-muted-foreground">{t('personalNotes.notes.truncated')}</p>}
    </div>
  );
}
