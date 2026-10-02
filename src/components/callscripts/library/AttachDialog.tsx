import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { normalizeForSearch } from '@/lib/transliterate';
import type { BulkOp, CoverageResponse, ProductIndexRow, ScriptGroup, TargetedScript } from '@/lib/callScriptsTypes';
import { GroupChips } from '../editor/GroupChips';
import { PickedProducts, ProductPicker } from '../editor/ProductPicker';
import { isLegacy } from '../scriptsModel';
import { StatusBadge, chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';
import { useScriptsWrites } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';

/**
 * "Закачи на…" — add (or take away) groups and products on several scripts at once (POST
 * /call-scripts/bulk: one version per script, one audit row). From a coverage cell it opens with
 * the cell's group / product already chosen and asks WHICH scripts to attach ("Закачи постоечка…").
 */
export function AttachDialog({
  open, onOpenChange, ids, library, products, twins, productName, coverage, presetGroups, presetProducts, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The scripts to change; absent = the dialog lets the user pick them. */
  ids?: readonly string[];
  library: readonly TargetedScript[];
  products: readonly ProductIndexRow[];
  twins: Readonly<Record<string, readonly string[]>>;
  productName: (id: string) => string | undefined;
  coverage?: CoverageResponse | null;
  presetGroups?: readonly ScriptGroup[];
  presetProducts?: readonly string[];
  onDone?: () => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const writes = useScriptsWrites();
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [groups, setGroups] = useState<ScriptGroup[]>([]);
  const [prods, setProds] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('add');
    setGroups([...(presetGroups ?? [])]);
    setProds([...(presetProducts ?? [])]);
    setPicked([]);
    setQ('');
    setNote('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickScripts = !ids;
  const candidates = useMemo(() => {
    const words = normalizeForSearch(q.trim()).split(/\s+/).filter(Boolean);
    return library
      .filter((s) => !isLegacy(s) && s.status !== 'archived')
      .filter((s) => { const n = normalizeForSearch(s.title); return words.every((w) => n.includes(w)); })
      .slice(0, 100);
  }, [library, q]);
  const targetIds = ids ? [...ids] : picked;
  const nothing = groups.length === 0 && prods.length === 0;
  const busy = writes.bulk.isPending;

  const submit = async () => {
    const op: BulkOp = mode === 'add'
      ? { add_groups: groups, add_products: prods }
      : { remove_groups: groups, remove_products: prods };
    try {
      const r = await writes.bulk.mutateAsync({ ids: targetIds, op, note: note.trim() || undefined });
      toast({
        title: t('callScripts.bulk.done', { n: r.updated.length }),
        description: r.skipped.length ? t('callScripts.bulk.skipped', { n: r.skipped.length }) : undefined,
      });
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('callScripts.bulk.attachTitle')}</DialogTitle>
          <DialogDescription>
            {pickScripts ? t('callScripts.bulk.attachPickHint') : t('callScripts.bulk.attachHint', { n: targetIds.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div role="group" aria-label={t('callScripts.bulk.mode')} className="flex flex-wrap gap-1.5">
            {(['add', 'remove'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn(chip, mode === m ? chipOn : chipOff)}>
                {t(`callScripts.bulk.mode_${m}`)}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            <p className={groupLabelCls}>{t('callScripts.editor.groups')}</p>
            <GroupChips value={groups} onChange={setGroups} coverage={coverage} allowEvery={false} idPrefix="attach" />
          </div>

          <div className="space-y-2">
            <p className={groupLabelCls}>{t('callScripts.editor.products')}</p>
            <ProductPicker products={products} value={prods} onChange={setProds} twins={twins} className="w-full sm:w-72" />
            {prods.length > 0 && <PickedProducts value={prods} onChange={setProds} twins={twins} name={productName} />}
          </div>

          {pickScripts && (
            <div className="space-y-2">
              <p className={groupLabelCls}>{t('callScripts.bulk.whichScripts')}</p>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('callScripts.library.search')} className="h-9" />
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1" data-testid="attach-scripts">
                {candidates.map((s) => (
                  <li key={s.id}>
                    <label className="flex min-h-9 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                      <Checkbox className="mt-0.5" checked={picked.includes(s.id)}
                        onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, s.id] : p.filter((x) => x !== s.id)))} />
                      <span className="min-w-0 flex-1 break-words text-sm">{s.title}</span>
                      <StatusBadge script={s} />
                    </label>
                  </li>
                ))}
                {candidates.length === 0 && <li className="px-2 py-3 text-center text-xs text-muted-foreground">{t('callScripts.library.empty')}</li>}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="attach-note" className={groupLabelCls}>{t('callScripts.editor.note')}</label>
            <Input id="attach-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('callScripts.editor.notePlaceholder')} className="h-9" />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button onClick={submit} disabled={busy || nothing || targetIds.length === 0} data-testid="attach-submit">
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
            {mode === 'add' ? t('callScripts.bulk.attachSubmit', { n: targetIds.length }) : t('callScripts.bulk.detachSubmit', { n: targetIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
