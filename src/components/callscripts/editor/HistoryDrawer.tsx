import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { ScriptVersion, TargetedScript } from '@/lib/callScriptsTypes';
import { ScriptBody } from '../ScriptBody';
import { GroupBadges, ProductNames, StatusBadge, useScriptLabels } from '../parts';
import { useScriptVersions, useScriptsWrites } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';

/**
 * Историја — every version of the script (≤ 100, newest first: who, when, what, the note), a
 * version's snapshot as /calls would show it, and "Врати": its content and targeting come back as
 * a NEW version (the current status stays). Nothing is ever overwritten.
 */
export function HistoryDrawer({ open, onOpenChange, script, productName, onRestored }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  script: TargetedScript;
  productName: (id: string) => string | undefined;
  onRestored: (s: TargetedScript) => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const q = useScriptVersions(script.id, open);
  const writes = useScriptsWrites();
  const versions = [...(q.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const [pick, setPick] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ScriptVersion | null>(null);
  useEffect(() => { if (!open) { setPick(null); setConfirm(null); } }, [open]);
  const sel = versions.find((v) => v.version === pick) ?? null;

  const restore = async (v: ScriptVersion) => {
    try {
      const r = await writes.restore.mutateAsync({ id: script.id, version: v.version });
      toast({ title: t('callScripts.history.restored', { version: v.version, now: r.script.version }) });
      setConfirm(null);
      onRestored(r.script);
      onOpenChange(false);
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-3 overflow-y-auto p-4 sm:max-w-xl" data-testid="history-drawer">
        <SheetHeader className="pr-8 text-left">
          <SheetTitle>{t('callScripts.history.title')}</SheetTitle>
          <SheetDescription className="break-words">{t('callScripts.history.hint', { title: script.title })}</SheetDescription>
        </SheetHeader>
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" aria-hidden /></div>
        ) : q.error ? (
          <p className="text-sm text-destructive">{scriptsErrorText(q.error, t)}</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('callScripts.history.empty')}</p>
        ) : (
          <ol className="space-y-1.5" data-testid="history-list">
            {versions.map((v) => {
              const current = v.version === script.version;
              return (
                <li key={v.id}>
                  <div className={cn('rounded-lg border p-2.5', pick === v.version && 'border-primary/50 bg-primary/5')}>
                    <button type="button" onClick={() => setPick(pick === v.version ? null : v.version)} aria-expanded={pick === v.version}
                      className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className="font-mono text-xs font-semibold">v{v.version}</span>
                      <span className="text-sm font-medium">{t(`callScripts.history.action.${v.action}`)}</span>
                      {current && <span className="rounded bg-muted px-1.5 text-[10px] font-medium">{t('callScripts.history.current')}</span>}
                      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{L.date(v.created_at)}</span>
                      <span className="basis-full text-[11px] text-muted-foreground">{v.actor_name ?? t('callScripts.history.system')}{v.note ? ` · ${v.note}` : ''}</span>
                    </button>
                    {pick === v.version && (
                      <div className="mt-2 space-y-2 border-t pt-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge script={v.snapshot} />
                          <span className="min-w-0 break-words text-sm font-semibold">{v.snapshot.title}</span>
                        </div>
                        {v.snapshot.context_type === 'targeted' && (
                          <div className="space-y-1 text-xs">
                            <GroupBadges groups={v.snapshot.groups ?? []} max={6} />
                            <ProductNames ids={v.snapshot.product_ids ?? []} name={productName} />
                          </div>
                        )}
                        <div className="max-h-80 overflow-y-auto rounded-md border bg-card p-2">
                          {v.snapshot.context_type === 'targeted'
                            ? <ScriptBody script={v.snapshot} vars={null} lang="mk" compact hideQuickAnswers={false} />
                            : <p className="whitespace-pre-wrap break-words text-sm">{v.snapshot.script_text}</p>}
                        </div>
                        {!current && v.action !== 'delete' && (
                          <Button size="sm" variant="outline" className="h-9" onClick={() => setConfirm(v)} data-testid={`restore-v${v.version}`}>
                            <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.history.restoreThis', { version: v.version })}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {sel === null && versions.length > 0 && <p className="text-[11px] text-muted-foreground">{t('callScripts.history.pickHint')}</p>}

        <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('callScripts.history.confirmTitle', { version: confirm?.version ?? '' })}</AlertDialogTitle>
              <AlertDialogDescription>{t('callScripts.history.confirmDesc')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={writes.restore.isPending}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={(e) => { e.preventDefault(); if (confirm) void restore(confirm); }} disabled={writes.restore.isPending}
                data-testid="restore-confirm">
                {writes.restore.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}{t('callScripts.history.restore')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
