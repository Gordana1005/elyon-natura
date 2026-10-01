import { useTranslation } from 'react-i18next';
import { ArrowLeft, Eye, Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import type { Note } from '@/lib/personalNotesApi';

/** Someone else's note, for an admin / manager: read only — no field, no button that writes. */
export function NoteReader({ note, ownerName, onBack }: { note: Note; ownerName: string; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 lg:hidden" onClick={onBack} aria-label={t('personalNotes.back')}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
          <Eye className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('personalNotes.reader.banner', { name: ownerName })}</span>
        </div>
      </div>
      <header className="min-w-0">
        <h3 className={cn('flex min-w-0 items-start gap-1.5 text-base font-semibold [overflow-wrap:anywhere]', !note.title && 'italic text-muted-foreground')}>
          {note.pinned && <Pin className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-600" aria-label={t('personalNotes.notes.pinned')} />}
          <span className="min-w-0">{note.title || t('personalNotes.notes.untitled')}</span>
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('personalNotes.reader.updated', { when: formatDistanceToNow(new Date(note.updated_at), { addSuffix: true }) })}
        </p>
      </header>
      <div className="min-w-0 whitespace-pre-wrap rounded-lg border bg-card p-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
        {note.body}
      </div>
    </article>
  );
}
