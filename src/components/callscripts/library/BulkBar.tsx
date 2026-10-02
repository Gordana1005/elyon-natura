import { useState } from 'react';
import { Archive, FileEdit, Link2, Loader2, Send, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import type { ScriptStatus } from '@/lib/callScriptsTypes';
import { useQueryClient } from '@tanstack/react-query';
import { CALL_SCRIPTS_QUERY_KEYS, apiDeleteTargetedScript } from '@/lib/callScriptsApi';
import { useScriptsWrites } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { useScriptLabels } from '../parts';

/**
 * The selection bar (sticky at the bottom, the /products pattern): "Избрани: N" · Закачи на… ·
 * Објави · Во нацрт · Архивирај · Избриши (admins). Status moves go through POST /call-scripts/bulk
 * (one version per script, one audit row); deleting goes one by one through the admin route.
 */
export function BulkBar({ ids, canDelete, onAttach, onClear }: {
  ids: readonly string[];
  canDelete: boolean;
  onAttach: () => void;
  onClear: () => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const qc = useQueryClient();
  const writes = useScriptsWrites();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState('');
  const [deleting, setDeleting] = useState(false);
  if (ids.length === 0) return null;
  const busy = writes.bulk.isPending || deleting;

  const setStatus = async (status: ScriptStatus) => {
    try {
      const r = await writes.bulk.mutateAsync({ ids: [...ids], op: { status } });
      toast({
        title: t('callScripts.bulk.done', { n: r.updated.length }),
        description: r.skipped.length ? t('callScripts.bulk.skipped', { n: r.skipped.length }) : undefined,
      });
      onClear();
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };

  const remove = async () => {
    setDeleting(true);
    let ok = 0;
    let failed: unknown = null;
    for (const id of ids) {
      try { await apiDeleteTargetedScript(id, note.trim() || undefined); ok += 1; } catch (e) { failed = e; }
    }
    setDeleting(false);
    setConfirmDelete(false);
    setNote('');
    await qc.invalidateQueries({ queryKey: CALL_SCRIPTS_QUERY_KEYS.all });
    if (failed) toast({ title: t('callScripts.bulk.deletedSome', { n: ok, total: ids.length }), description: scriptsErrorText(failed, t), variant: 'destructive' });
    else toast({ title: t('callScripts.bulk.deleted', { n: ok }) });
    onClear();
  };

  return (
    <div role="region" aria-label={t('callScripts.bulk.region')} data-testid="bulk-bar"
      className="sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-lg">
      <span className="px-1 text-sm font-medium tabular-nums">{t('callScripts.bulk.selected', { n: ids.length })}</span>
      <Button size="sm" className="h-9" onClick={onAttach} disabled={busy} data-testid="bulk-attach">
        <Link2 className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.bulk.attach')}
      </Button>
      <Button size="sm" variant="outline" className="h-9" onClick={() => setStatus('published')} disabled={busy} data-testid="bulk-publish">
        {busy && writes.bulk.variables?.op.status === 'published' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Send className="mr-1.5 h-4 w-4" aria-hidden />}
        {t('callScripts.bulk.publish')}
      </Button>
      <Button size="sm" variant="outline" className="h-9" onClick={() => setStatus('draft')} disabled={busy} data-testid="bulk-draft">
        <FileEdit className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.bulk.toDraft')}
      </Button>
      <Button size="sm" variant="outline" className="h-9" onClick={() => setStatus('archived')} disabled={busy} data-testid="bulk-archive">
        <Archive className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.bulk.archive')}
      </Button>
      {canDelete && (
        <Button size="sm" variant="outline" className="h-9 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy} data-testid="bulk-delete">
          <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.bulk.delete')}
        </Button>
      )}
      <Button variant="ghost" size="sm" className="ml-auto h-9" onClick={onClear} disabled={busy}>
        <X className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.bulk.clear')}
      </Button>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => { if (!deleting) setConfirmDelete(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('callScripts.bulk.deleteTitle', { n: ids.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t('callScripts.bulk.deleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('callScripts.editor.notePlaceholder')} aria-label={t('callScripts.editor.note')} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void remove(); }} disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="bulk-delete-confirm">
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}{t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
