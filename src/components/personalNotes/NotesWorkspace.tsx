import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { NotebookPen, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { cn } from '@/lib/utils';
import { PN_KEYS, apiGetNote, apiGetNotebooks, personalNotesErrorText } from '@/lib/personalNotesApi';
import { mobileStep, parentState, readNotesUrl, writeNotesUrl, type NotesUrlState } from '@/lib/personalNotes/model';
import { NotebookList } from './NotebookList';
import { NoteList } from './NoteList';
import { NoteEditor } from './NoteEditor';
import { NoteReader } from './NoteReader';
import { DeletedItems } from './DeletedItems';

/**
 * Личен дневник — notebooks | notes | the note.
 *  - lg+: three panes side by side (notebooks w-48 | notes w-60 | the note), each scrolling on its own;
 *  - below lg: one pane at a time — notebook cards → note cards → the note full width, with ←.
 * The open notebook / note live in the URL (`nb`, `note`): a drill-down pushes a history entry,
 * so the phone's back button walks back up; ← does the same.
 * `readOnly` (an admin / manager reading an operator's) renders no control that writes.
 */
export function NotesWorkspace({ ownerId, readOnly, ownerName }: {
  /** null = mine. */
  ownerId: string | null;
  readOnly: boolean;
  ownerName?: string | null;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = readNotesUrl(params);
  const step = mobileStep(state);
  const ownerKey = ownerId ?? 'me';
  const [deletedOpen, setDeletedOpen] = useState(false);

  const go = (patch: Partial<NotesUrlState>, how: 'push' | 'replace' = 'push') =>
    setParams((p) => writeNotesUrl(p, patch), how === 'push' ? { state: { pnDrill: true } } : { replace: true });
  const back = () => {
    if ((location.state as { pnDrill?: boolean } | null)?.pnDrill) navigate(-1);
    else go(parentState(state), 'replace');
  };

  const books = useQuery({
    queryKey: PN_KEYS.notebooks(ownerKey),
    queryFn: () => apiGetNotebooks(ownerId),
  });
  const noteQ = useQuery({
    queryKey: PN_KEYS.note(state.note ?? ''),
    queryFn: () => apiGetNote(state.note!),
    enabled: !!state.note,
    refetchOnWindowFocus: false,
  });

  const notebooks = books.data?.notebooks ?? [];
  const name = ownerName || books.data?.owner.name || '';

  if (books.isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-[12rem_15rem_minmax(0,1fr)]">
        {[0, 1, 2].map((i) => <Skeleton key={i} className={cn('h-40 w-full rounded-xl', i > 0 && 'hidden lg:block')} />)}
      </div>
    );
  }
  if (books.isError) return <LoadError text={personalNotesErrorText(books.error)} onRetry={() => void books.refetch()} />;

  // The editor starts only from a fresh read (an older cached copy would meet a 409 at once).
  const noteReady = !!noteQ.data && noteQ.isFetchedAfterMount && noteQ.data.note.id === state.note;

  return (
    <div
      className="grid min-w-0 gap-3 lg:h-[calc(100dvh-15rem)] lg:min-h-[32rem] lg:grid-cols-[12rem_15rem_minmax(0,1fr)] lg:gap-4"
      data-step={step}
    >
      <section
        aria-label={t('personalNotes.notebooks.heading')}
        className={cn('min-w-0 lg:overflow-y-auto lg:pr-1', step !== 'notebooks' && 'hidden lg:block')}
        data-pane="notebooks"
      >
        <NotebookList
          notebooks={notebooks}
          ownerKey={ownerKey}
          activeId={state.nb}
          readOnly={readOnly}
          onOpen={(id) => go({ nb: id })}
          onDeleted={(id) => { if (state.nb === id) go({ nb: null }, 'replace'); }}
          footer={readOnly ? undefined : (
            <Button variant="ghost" size="sm" className="h-8 w-full justify-start gap-1.5 text-muted-foreground" onClick={() => setDeletedOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('personalNotes.deleted.open')}
            </Button>
          )}
        />
      </section>

      <section
        aria-label={t('personalNotes.notes.heading')}
        className={cn('min-w-0 lg:overflow-y-auto lg:border-l lg:pl-4 lg:pr-1', step !== 'notes' && 'hidden lg:block')}
        data-pane="notes"
      >
        {state.nb ? (
          <NoteList
            notebookId={state.nb}
            ownerId={ownerId}
            ownerKey={ownerKey}
            readOnly={readOnly}
            activeNoteId={state.note}
            onOpen={(noteId, nbId) => go({ nb: nbId, note: noteId })}
            onBack={back}
          />
        ) : (
          <EmptyState size="sm" icon={<NotebookPen className="h-5 w-5" />} title={t('personalNotes.notebooks.choose')} description={t('personalNotes.notebooks.chooseDesc')} />
        )}
      </section>

      <section
        aria-label={t('personalNotes.title')}
        className={cn('min-w-0 lg:overflow-y-auto lg:border-l lg:pl-4 lg:pr-1', step !== 'editor' && 'hidden lg:block')}
        data-pane="editor"
      >
        {!state.note ? (
          <EmptyState size="sm" icon={<StickyNote className="h-5 w-5" />} title={t('personalNotes.notes.choose')} description={t('personalNotes.notes.chooseDesc')} />
        ) : noteQ.isError ? (
          <LoadError text={personalNotesErrorText(noteQ.error)} onRetry={() => void noteQ.refetch()} />
        ) : !noteReady ? (
          <div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-64 w-full" /></div>
        ) : readOnly ? (
          <NoteReader note={noteQ.data!.note} ownerName={name} onBack={back} />
        ) : (
          <NoteEditor
            key={noteQ.data!.note.id}
            note={noteQ.data!.note}
            notebooks={notebooks}
            ownerKey={ownerKey}
            onBack={back}
            onMoved={(nbId) => go({ nb: nbId, note: noteQ.data!.note.id }, 'replace')}
            onDeleted={() => go({ note: null }, 'replace')}
          />
        )}
      </section>

      {!readOnly && (
        <Sheet open={deletedOpen} onOpenChange={setDeletedOpen}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader className="text-left">
              <SheetTitle>{t('personalNotes.deleted.title')}</SheetTitle>
              <SheetDescription className="sr-only">{t('personalNotes.deleted.desc')}</SheetDescription>
            </SheetHeader>
            <div className="mt-4">{deletedOpen && <DeletedItems />}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
