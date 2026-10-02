import { useState } from 'react';
import { Loader2, Power } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { ScriptsMode } from '@/lib/callScriptsTypes';
import { useScriptsCoverage, useScriptsWrites, type ScriptsPerms } from './useCallScriptsAdmin';
import { scriptsErrorText } from './errors';
import { useScriptLabels } from './parts';

export const MODES: readonly ScriptsMode[] = ['off', 'preview', 'on'];

const MODE_TONE: Record<ScriptsMode, string> = {
  off: 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100',
  preview: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200',
  on: 'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
};

/**
 * The switch for the /calls dock (app_settings.call_scripts.mode, audited): Исклучено (today's
 * panel) → Преглед (admins + managers see the new scripts) → Вклучено (everyone). Admins switch;
 * before "Вклучено" the dialog shows how many waiting clients a published script reaches and how
 * many cells with waiting clients are still empty. Managers see the state, read-only.
 */
export function ModeSwitch({ perms }: { perms: ScriptsPerms }) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const writes = useScriptsWrites();
  const [want, setWant] = useState<ScriptsMode | null>(null);
  const [note, setNote] = useState('');
  const cov = useScriptsCoverage({ families: true, assignedOnly: false }, want !== null && want !== 'off');
  const mode = perms.mode;
  if (!mode) return null;

  const confirm = async () => {
    if (!want) return;
    try {
      await writes.setMode.mutateAsync({ mode: want, note: note.trim() || undefined });
      toast({ title: t('callScripts.mode.switched', { mode: t(`callScripts.mode.${want}`) }) });
      setWant(null);
      setNote('');
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };

  const totals = cov.data?.totals;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="mode-switch">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Power className="h-3.5 w-3.5" aria-hidden />{t('callScripts.mode.title')}
      </span>
      {perms.canSwitch ? (
        <div role="radiogroup" aria-label={t('callScripts.mode.title')} className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-0.5">
          {MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { if (m !== mode) setWant(m); }}
              className={cn('min-h-8 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mode === m ? MODE_TONE[m] : 'border-transparent text-muted-foreground hover:bg-background hover:text-foreground')}
              data-testid={`mode-${m}`}>
              {t(`callScripts.mode.${m}`)}
            </button>
          ))}
        </div>
      ) : (
        <span className={cn('inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium', MODE_TONE[mode])} data-testid="mode-badge"
          title={t('callScripts.mode.readOnly')}>
          {t(`callScripts.mode.${mode}`)}
        </span>
      )}

      <AlertDialog open={want !== null} onOpenChange={(o) => { if (!o && !writes.setMode.isPending) setWant(null); }}>
        <AlertDialogContent data-testid="mode-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{want ? t('callScripts.mode.confirmTitle', { mode: t(`callScripts.mode.${want}`) }) : ''}</AlertDialogTitle>
            <AlertDialogDescription>{want ? t(`callScripts.mode.desc_${want}`) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          {want && want !== 'off' && (
            <div className="rounded-lg border p-3 text-sm" data-testid="mode-coverage">
              {cov.isLoading ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('common.loading')}</span>
              ) : totals ? (
                <ul className="space-y-1">
                  <li>{t('callScripts.mode.covered', { pct: L.pct(totals.covered_pct), covered: L.int(totals.covered), waiting: L.int(totals.waiting) })}</li>
                  <li className={cn(totals.empty_cells_with_waiting > 0 && 'font-medium text-red-700 dark:text-red-300')}>{t('callScripts.mode.emptyCells', { n: L.int(totals.empty_cells_with_waiting) })}</li>
                  <li className="text-muted-foreground">{t('callScripts.mode.counts', { published: L.int(totals.published), drafts: L.int(totals.drafts) })}</li>
                </ul>
              ) : <span className="text-muted-foreground">{t('callScripts.errors.loadCoverage')}</span>}
            </div>
          )}
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('callScripts.editor.notePlaceholder')} aria-label={t('callScripts.editor.note')} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={writes.setMode.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void confirm(); }} disabled={writes.setMode.isPending} data-testid="mode-confirm-ok">
              {writes.setMode.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {want ? t('callScripts.mode.confirmOk', { mode: t(`callScripts.mode.${want}`) }) : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
