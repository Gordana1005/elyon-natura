import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FolderInput, Loader2, Pin, PinOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAutosave } from '@/hooks/useAutosave';
import { cn } from '@/lib/utils';
import {
  PN_KEYS, PN_LIMITS, PersonalNotesError, apiDeleteNote, apiGetNote, apiSaveNote, isVersionConflict,
  personalNotesErrorText,
  type Note, type NotePatch, type NoteResponse, type Notebook, type NotesResponse, type SavedNote,
} from '@/lib/personalNotesApi';
import { charCount, counterText, hhmm, saveStatusKey, snippet } from '@/lib/personalNotes/model';
import { dotClass } from './colors';

/**
 * The operator's own note: title + text, saved by itself (useAutosave — 1,2 s after typing
 * stops, at once on blur / pin / move / switching notes / hiding the tab). A save that meets
 * a newer version from another window opens "Сменета во друг прозорец".
 */
export function NoteEditor({
  note, notebooks, ownerKey, onBack, onMoved, onDeleted,
}: {
  note: Note;
  notebooks: Notebook[];
  ownerKey: string;
  onBack: () => void;
  /** The note now lives in another notebook (moved here, or by the other window). */
  onMoved: (notebookId: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [pinned, setPinned] = useState(note.pinned);
  const [notebookId, setNotebookId] = useState(note.notebook_id);
  const [conflict, setConflict] = useState<Note | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /** The notebook whose list holds this note right now. */
  const listNb = useRef(note.notebook_id);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const moveInCaches = (to: string) => {
    const from = listNb.current;
    if (to === from) return;
    qc.setQueriesData<NotesResponse>({ queryKey: PN_KEYS.notesOf(from) },
      (old) => old && { ...old, notes: old.notes.filter((n) => n.id !== note.id) });
    void qc.invalidateQueries({ queryKey: PN_KEYS.notesOf(to) });
    void qc.invalidateQueries({ queryKey: PN_KEYS.notebooks(ownerKey) });
    listNb.current = to;
    if (mounted.current) {
      onMoved(to);
      const nb = notebooks.find((n) => n.id === to);
      if (nb) toast({ title: t('personalNotes.editor.moved', { title: nb.title }) });
    }
  };

  const applySaved = (saved: SavedNote, patch: NotePatch) => {
    qc.setQueryData<NoteResponse>(PN_KEYS.note(note.id), (old) => old && {
      ...old,
      note: { ...old.note, ...patch, version: saved.version, updated_at: saved.updated_at, notebook_id: saved.notebook_id },
    });
    if (saved.notebook_id !== listNb.current) { moveInCaches(saved.notebook_id); return; }
    qc.setQueriesData<NotesResponse>({ queryKey: PN_KEYS.notesOf(listNb.current) }, (old) => old && {
      ...old,
      notes: old.notes.map((n) => (n.id !== note.id ? n : {
        ...n,
        title: saved.title,
        pinned: saved.pinned,
        version: saved.version,
        updated_at: saved.updated_at,
        ...(patch.body !== undefined ? { snippet: snippet(patch.body, old.q), chars: charCount(patch.body) } : {}),
      })),
    });
  };

  const autosave = useAutosave<NotePatch, SavedNote>({
    version: note.version,
    save: (patch, base, o) => apiSaveNote(note.id, patch, base, o).then((r) => r.saved),
    isConflict: isVersionConflict,
    onSaved: applySaved,
    onConflict: (e) => {
      const current = e instanceof PersonalNotesError ? e.current : null;
      if (current) { setConflict(current); return; }
      apiGetNote(note.id).then((r) => setConflict(r.note), () => setConflict({ ...note, version: note.version + 1 }));
    },
  });

  // the text area grows with the text (the pane / page scrolls, never the box)
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [body]);

  const edit = (patch: NotePatch) => autosave.schedule(patch);

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    edit({ pinned: next });
    void autosave.flush();
  };

  const moveTo = (to: string) => {
    if (to === notebookId) return;
    setNotebookId(to);
    edit({ notebook_id: to });
    void autosave.flush();
  };

  const takeTheirs = () => {
    if (!conflict) return;
    const c = conflict;
    setTitle(c.title);
    setBody(c.body);
    setPinned(c.pinned);
    setNotebookId(c.notebook_id);
    autosave.takeTheirs(c.version);
    qc.setQueryData<NoteResponse>(PN_KEYS.note(note.id), (old) => old && { ...old, note: c });
    void qc.invalidateQueries({ queryKey: PN_KEYS.notesOf(listNb.current) });
    if (c.notebook_id !== listNb.current) moveInCaches(c.notebook_id);
    setConflict(null);
  };

  const keepMine = () => {
    if (!conflict) return;
    const draft: NotePatch = { title, body, pinned, ...(notebookId !== conflict.notebook_id ? { notebook_id: notebookId } : {}) };
    void autosave.keepMine(conflict.version, draft);
    setConflict(null);
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await autosave.flush();
      await apiDeleteNote(note.id);
      toast({ title: t('personalNotes.editor.deleted') });
      qc.setQueriesData<NotesResponse>({ queryKey: PN_KEYS.notesOf(listNb.current) },
        (old) => old && { ...old, notes: old.notes.filter((n) => n.id !== note.id) });
      void qc.invalidateQueries({ queryKey: PN_KEYS.notebooks(ownerKey) });
      void qc.invalidateQueries({ queryKey: PN_KEYS.deleted });
      qc.removeQueries({ queryKey: PN_KEYS.note(note.id) });
      onDeleted();
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    } finally {
      if (mounted.current) setDeleting(false);
    }
  };

  const statusKey = saveStatusKey(autosave.status);
  const statusText = statusKey ? t(statusKey, { time: autosave.savedAt ? hhmm(autosave.savedAt) : '' }) : '';

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void autosave.flush(); }
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 lg:hidden" onClick={onBack} aria-label={t('personalNotes.back')}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1 text-xs" role="status" aria-live="polite">
          {autosave.status === 'error' ? (
            <button type="button" className="max-w-full truncate text-left font-medium text-destructive underline-offset-2 hover:underline"
              onClick={() => void autosave.retry()}>
              {statusText}
            </button>
          ) : (
            <span className={cn('block truncate text-muted-foreground', autosave.status === 'conflict' && 'font-medium text-amber-700')}>
              {autosave.status === 'saving' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin align-[-2px]" aria-hidden />}
              {statusText}
            </span>
          )}
        </div>
        <Button
          variant={pinned ? 'secondary' : 'ghost'} size="icon" className="h-9 w-9 shrink-0"
          onClick={togglePin}
          aria-pressed={pinned}
          aria-label={pinned ? t('personalNotes.editor.unpin') : t('personalNotes.editor.pin')}
          title={pinned ? t('personalNotes.editor.unpin') : t('personalNotes.editor.pin')}
        >
          {pinned ? <PinOff className="h-4 w-4" aria-hidden /> : <Pin className="h-4 w-4" aria-hidden />}
        </Button>
        <Button
          variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          disabled={deleting}
          aria-label={t('personalNotes.editor.delete')}
          title={t('personalNotes.editor.delete')}
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
        </Button>
      </div>

      {notebooks.length > 1 && (
        <div className="flex min-w-0 items-center gap-2">
          <FolderInput className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <Select value={notebookId} onValueChange={moveTo}>
            <SelectTrigger className="h-8 w-full min-w-0 text-xs sm:w-64" aria-label={t('personalNotes.editor.move')} title={t('personalNotes.editor.move')}>
              <SelectValue placeholder={t('personalNotes.editor.move')} />
            </SelectTrigger>
            <SelectContent>
              {notebooks.map((nb) => (
                <SelectItem key={nb.id} value={nb.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass(nb.color))} aria-hidden />
                    <span className="truncate">{nb.title}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Input
        value={title}
        maxLength={PN_LIMITS.noteTitle}
        placeholder={t('personalNotes.editor.titlePlaceholder')}
        aria-label={t('personalNotes.editor.titlePlaceholder')}
        className="h-11 text-base font-semibold"
        onChange={(e) => { setTitle(e.target.value); edit({ title: e.target.value }); }}
        onBlur={() => void autosave.flush()}
      />
      <Textarea
        ref={bodyRef}
        value={body}
        maxLength={PN_LIMITS.body}
        placeholder={t('personalNotes.editor.bodyPlaceholder')}
        aria-label={t('personalNotes.editor.bodyPlaceholder')}
        className="min-h-[16rem] resize-none overflow-hidden text-sm leading-relaxed [overflow-wrap:anywhere]"
        onChange={(e) => { setBody(e.target.value); edit({ body: e.target.value }); }}
        onBlur={() => void autosave.flush()}
      />
      <div className="flex justify-end">
        <span className="text-[11px] tabular-nums text-muted-foreground" aria-label={t('personalNotes.editor.chars')}>
          {counterText(charCount(body), PN_LIMITS.body)}
        </span>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('personalNotes.editor.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('personalNotes.editor.deleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setConfirmDelete(false); void remove(); }}
            >
              {t('personalNotes.editor.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!conflict}>
        <AlertDialogContent className="max-h-[90dvh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('personalNotes.conflict.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('personalNotes.conflict.desc')}</AlertDialogDescription>
          </AlertDialogHeader>
          {conflict && (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <VersionBox label={t('personalNotes.conflict.mine')} title={title} body={body} />
              <VersionBox label={t('personalNotes.conflict.theirs')} title={conflict.title} body={conflict.body} />
            </div>
          )}
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={takeTheirs}>{t('personalNotes.conflict.takeTheirs')}</Button>
            <Button onClick={keepMine}>{t('personalNotes.conflict.keepMine')}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VersionBox({ label, title, body }: { label: string; title: string; body: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('truncate text-sm font-semibold', !title && 'italic text-muted-foreground')}>
        {title || t('personalNotes.notes.untitled')}
      </div>
      <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{body}</div>
    </div>
  );
}
