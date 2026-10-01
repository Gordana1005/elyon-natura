import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, NotebookPen, RotateCcw, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  PN_KEYS, apiGetDeletedNotes, apiRestoreNote, apiRestoreNotebook, personalNotesErrorText,
} from '@/lib/personalNotesApi';
import { dotClass } from './colors';

/** "Избришани": my deleted notebooks and notes, restorable for 30 days, then purged (never "Корпа"). */
export function DeletedItems() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: PN_KEYS.deleted, queryFn: apiGetDeletedNotes });

  const restore = async (kind: 'notebook' | 'note', id: string) => {
    setBusy(id);
    try {
      if (kind === 'notebook') await apiRestoreNotebook(id); else await apiRestoreNote(id);
      toast({ title: t('personalNotes.deleted.restored') });
      await qc.invalidateQueries({ queryKey: PN_KEYS.all });
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const left = (days: number) => (days < 1 ? t('personalNotes.deleted.lastDay') : t('personalNotes.deleted.daysLeft', { count: days }));

  if (q.isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>;
  if (q.isError) return <LoadError text={personalNotesErrorText(q.error)} onRetry={() => void q.refetch()} />;
  const data = q.data!;
  if (!data.notebooks.length && !data.notes.length) {
    return <EmptyState size="sm" icon={<Trash2 className="h-5 w-5" />} title={t('personalNotes.deleted.empty')} description={t('personalNotes.deleted.desc')} />;
  }

  const restoreButton = (kind: 'notebook' | 'note', id: string) => (
    <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1" disabled={busy === id} onClick={() => void restore(kind, id)}>
      {busy === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
      {t('personalNotes.deleted.restore')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('personalNotes.deleted.desc')}</p>
      {data.notebooks.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <NotebookPen className="h-3.5 w-3.5" aria-hidden />{t('personalNotes.deleted.notebooks')}
          </h3>
          <ul className="space-y-1.5">
            {data.notebooks.map((nb) => (
              <li key={nb.id} className="flex min-w-0 items-center gap-2 rounded-xl border bg-card px-3 py-2">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dotClass(nb.color))} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{nb.title}</span>
                  <span className="block text-[11px] text-muted-foreground">{left(nb.days_left)}</span>
                </span>
                {restoreButton('notebook', nb.id)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.notes.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <StickyNote className="h-3.5 w-3.5" aria-hidden />{t('personalNotes.deleted.notes')}
          </h3>
          <ul className="space-y-1.5">
            {data.notes.map((n) => (
              <li key={n.id} className="flex min-w-0 items-center gap-2 rounded-xl border bg-card px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm font-medium', !n.title && 'italic text-muted-foreground')}>
                    {n.title || t('personalNotes.notes.untitled')}
                  </span>
                  {n.snippet && <span className="block truncate text-xs text-muted-foreground">{n.snippet}</span>}
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {t('personalNotes.deleted.inNotebook', { title: n.notebook_title })} · {left(n.days_left)}
                  </span>
                </span>
                {restoreButton('note', n.id)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
