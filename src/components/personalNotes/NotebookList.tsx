import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, MoreHorizontal, NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  PN_KEYS, PN_LIMITS, apiDeleteNotebook, apiReorderNotebooks, personalNotesErrorText,
  type Notebook, type NotebooksResponse,
} from '@/lib/personalNotesApi';
import { moveId } from '@/lib/personalNotes/model';
import { NotebookDialog } from './NotebookDialog';
import { dotClass } from './colors';

/**
 * The notebooks: a narrow list on lg+, cards below. The operator creates, renames / colours
 * (NotebookDialog), moves ↑ / ↓ and deletes (soft — "Избришани"); a reader only opens.
 */
export function NotebookList({
  notebooks, ownerKey, activeId, readOnly, onOpen, onDeleted, footer,
}: {
  notebooks: Notebook[];
  ownerKey: string;
  activeId: string | null;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ open: boolean; notebook: Notebook | null }>({ open: false, notebook: null });
  const [confirmDelete, setConfirmDelete] = useState<Notebook | null>(null);
  const atLimit = notebooks.length >= PN_LIMITS.notebooks;

  const refresh = () => qc.invalidateQueries({ queryKey: PN_KEYS.notebooks(ownerKey) });

  const move = async (id: string, dir: -1 | 1) => {
    const ids = notebooks.map((n) => n.id);
    const next = moveId(ids, id, dir);
    if (next === ids) return;
    // optimistic: the list moves at once, the server confirms
    qc.setQueryData<NotebooksResponse>(PN_KEYS.notebooks(ownerKey), (old) => old && ({
      ...old, notebooks: next.map((nid, position) => ({ ...old.notebooks.find((n) => n.id === nid)!, position })),
    }));
    try {
      await apiReorderNotebooks(next);
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    } finally {
      void refresh();
    }
  };

  const remove = async (nb: Notebook) => {
    try {
      await apiDeleteNotebook(nb.id);
      toast({ title: t('personalNotes.notebooks.deleted') });
      onDeleted(nb.id);
      void qc.invalidateQueries({ queryKey: PN_KEYS.all });
    } catch (e) {
      toast({ title: personalNotesErrorText(e), variant: 'destructive' });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <NotebookPen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{t('personalNotes.notebooks.heading')}</span>
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
            {t('personalNotes.notebooks.count', { n: notebooks.length, max: PN_LIMITS.notebooks })}
          </span>
        </h2>
        {!readOnly && (
          <Button
            size="sm" variant="outline" className="h-8 shrink-0 gap-1 px-2"
            disabled={atLimit}
            title={atLimit ? t('personalNotes.notebooks.limit', { max: PN_LIMITS.notebooks }) : undefined}
            onClick={() => setDialog({ open: true, notebook: null })}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <span className="lg:sr-only">{t('personalNotes.notebooks.new')}</span>
          </Button>
        )}
      </div>

      {notebooks.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<NotebookPen className="h-5 w-5" />}
          title={readOnly ? t('personalNotes.notebooks.emptyReadOnly') : t('personalNotes.notebooks.empty')}
          description={readOnly ? undefined : t('personalNotes.notebooks.emptyDesc')}
          action={readOnly ? undefined : (
            <Button size="sm" onClick={() => setDialog({ open: true, notebook: null })}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />{t('personalNotes.notebooks.new')}
            </Button>
          )}
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 lg:gap-0.5" aria-label={t('personalNotes.notebooks.heading')}>
          {notebooks.map((nb, i) => {
            const active = nb.id === activeId;
            return (
              <li key={nb.id} className="min-w-0">
                <div className={cn(
                  'group flex min-w-0 items-stretch rounded-xl border bg-card transition-colors lg:rounded-lg lg:border-transparent lg:bg-transparent',
                  active ? 'border-primary/50 bg-primary/5 lg:bg-primary/10' : 'hover:bg-muted/60',
                )}>
                  <button
                    type="button"
                    onClick={() => onOpen(nb.id)}
                    aria-current={active ? 'true' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 text-left lg:px-2 lg:py-1.5"
                  >
                    <span className={cn('h-8 w-1.5 shrink-0 rounded-full lg:h-2.5 lg:w-2.5', dotClass(nb.color))} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-sm', active && 'font-semibold')}>{nb.title}</span>
                      <span className="block text-xs text-muted-foreground lg:text-[11px]">
                        {t('personalNotes.notebooks.notes', { count: nb.note_count })}
                      </span>
                    </span>
                  </button>
                  {!readOnly && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost" size="icon"
                          className="h-auto w-10 shrink-0 rounded-l-none text-muted-foreground lg:w-7"
                          aria-label={t('personalNotes.notebooks.menu')}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ open: true, notebook: nb })}>
                          <Pencil className="mr-2 h-4 w-4" aria-hidden />{t('personalNotes.notebooks.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={i === 0} onSelect={() => void move(nb.id, -1)}>
                          <ArrowUp className="mr-2 h-4 w-4" aria-hidden />{t('personalNotes.notebooks.moveUp')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={i === notebooks.length - 1} onSelect={() => void move(nb.id, 1)}>
                          <ArrowDown className="mr-2 h-4 w-4" aria-hidden />{t('personalNotes.notebooks.moveDown')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmDelete(nb)}>
                          <Trash2 className="mr-2 h-4 w-4" aria-hidden />{t('personalNotes.notebooks.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {footer && <div className="mt-auto pt-2">{footer}</div>}

      {!readOnly && (
        <>
          <NotebookDialog
            open={dialog.open}
            notebook={dialog.notebook}
            onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
            onSaved={(nb) => {
              void refresh();
              if (!dialog.notebook) onOpen(nb.id);
            }}
          />
          <AlertDialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
            <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
              <AlertDialogHeader>
                <AlertDialogTitle className="[overflow-wrap:anywhere]">
                  {t('personalNotes.notebooks.deleteTitle', { title: confirmDelete?.title ?? '' })}
                </AlertDialogTitle>
                <AlertDialogDescription>{t('personalNotes.notebooks.deleteDesc')}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => { if (confirmDelete) void remove(confirmDelete); setConfirmDelete(null); }}
                >
                  {t('personalNotes.notebooks.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
