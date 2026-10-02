import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import type { CoverageResponse, DuplicateSplit, ProductIndexRow, ScriptGroup, TargetedScript } from '@/lib/callScriptsTypes';
import { DUPLICATE_SPLITS, MAX_DUPLICATES, duplicatePlan, editorHref } from '../scriptsModel';
import { chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';
import { useScriptsWrites } from '../useCallScriptsAdmin';
import { scriptsErrorText } from '../errors';
import { GroupChips } from './GroupChips';
import { PickedProducts, ProductPicker } from './ProductPicker';

/**
 * "Копирај на…" — copies of this script as DRAFTS for other groups / products (POST
 * /call-scripts/item/:id/duplicate, at most 50): one copy, one per product, one per group, or
 * one per group × product. The count is shown before anything is created.
 */
export function DuplicateDialog({ open, onOpenChange, script, products, twins, productName, coverage }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  script: TargetedScript;
  products: readonly ProductIndexRow[];
  twins: Readonly<Record<string, readonly string[]>>;
  productName: (id: string) => string | undefined;
  coverage?: CoverageResponse | null;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const { toast } = useToast();
  const writes = useScriptsWrites();
  const [groups, setGroups] = useState<ScriptGroup[]>([]);
  const [prods, setProds] = useState<string[]>([]);
  const [split, setSplit] = useState<DuplicateSplit>('none');
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<{ id: string; title: string }[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setGroups([...script.groups]);
    setProds([...script.product_ids]);
    setSplit('none');
    setNote('');
    setCreated(null);
  }, [open, script]);

  const plan = useMemo(() => duplicatePlan(groups, prods, split), [groups, prods, split]);
  const busy = writes.duplicate.isPending;

  const submit = async () => {
    try {
      const r = await writes.duplicate.mutateAsync({ id: script.id, groups, product_ids: prods, split, note: note.trim() || undefined });
      setCreated(r.created);
      toast({ title: t('callScripts.duplicate.done', { n: r.created.length }) });
    } catch (e) {
      toast({ title: t('common.error'), description: scriptsErrorText(e, t), variant: 'destructive' });
    }
  };

  const describe = (g: ScriptGroup[], p: string[]) => [
    g.length ? g.map(L.group).join(', ') : t('callScripts.library.allGroups'),
    p.length ? p.map((id) => productName(id) ?? '?').join(', ') : t('callScripts.library.allProducts'),
  ].join(' · ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto" data-testid="duplicate-dialog">
        <DialogHeader>
          <DialogTitle>{t('callScripts.duplicate.title')}</DialogTitle>
          <DialogDescription>{t('callScripts.duplicate.hint', { title: script.title })}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-2">
            <p className="text-sm">{t('callScripts.duplicate.done', { n: created.length })}</p>
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {created.map((c) => (
                <li key={c.id}>
                  <Link to={editorHref({ id: c.id })} onClick={() => onOpenChange(false)} className="break-words text-sm text-primary hover:underline">{c.title}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className={groupLabelCls}>{t('callScripts.editor.groups')}</p>
              <GroupChips value={groups} onChange={setGroups} coverage={coverage} idPrefix="dup" />
            </div>
            <div className="space-y-2">
              <p className={groupLabelCls}>{t('callScripts.editor.products')}</p>
              <ProductPicker products={products} value={prods} onChange={setProds} twins={twins} title={script.title} className="w-full sm:w-72" />
              <PickedProducts value={prods} onChange={setProds} twins={twins} name={productName} />
            </div>
            <div className="space-y-2">
              <p id="dup-split" className={groupLabelCls}>{t('callScripts.duplicate.split')}</p>
              <div role="radiogroup" aria-labelledby="dup-split" className="flex flex-wrap gap-1.5">
                {DUPLICATE_SPLITS.map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={split === s} onClick={() => setSplit(s)}
                    className={cn(chip, split === s ? chipOn : chipOff)} data-testid={`split-${s}`}>
                    {t(`callScripts.duplicate.splits.${s}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className={cn('space-y-1.5 rounded-lg border p-2.5', plan.tooMany && 'border-destructive/50 bg-destructive/5')} data-testid="duplicate-preview">
              <p className="text-sm font-medium">
                {plan.tooMany
                  ? t('callScripts.duplicate.tooMany', { n: plan.count, max: MAX_DUPLICATES })
                  : t('callScripts.duplicate.willCreate', { n: plan.count })}
              </p>
              {!plan.tooMany && (
                <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                  {plan.targets.slice(0, 12).map((x, i) => <li key={i} className="break-words">{describe(x.groups, x.product_ids)}</li>)}
                  {plan.targets.length > 12 && <li>{t('callScripts.duplicate.more', { n: plan.targets.length - 12 })}</li>}
                </ul>
              )}
            </div>
            <div className="space-y-1">
              <label htmlFor="dup-note" className={groupLabelCls}>{t('callScripts.editor.note')}</label>
              <Input id="dup-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('callScripts.editor.notePlaceholder')} className="h-9" />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{created ? t('common.close') : t('common.cancel')}</Button>
          {!created && (
            <Button onClick={submit} disabled={busy || plan.tooMany || plan.count === 0} data-testid="duplicate-submit">
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {t('callScripts.duplicate.submit', { n: plan.count })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
