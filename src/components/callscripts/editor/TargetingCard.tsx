import { Target } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { CoverageResponse, ProductIndexRow, ScriptGroup } from '@/lib/callScriptsTypes';
import { PRIORITY_MAX, PRIORITY_MIN, clampPriority } from '../scriptsModel';
import { card, groupLabelCls, useScriptLabels } from '../parts';
import { GroupChips } from './GroupChips';
import { PickedProducts, ProductPicker } from './ProductPicker';

/**
 * Насока — who gets the script: the groups (with the clients waiting in each), the products (by
 * brand line, "Предлог од насловот", twins added on their own) and the priority that breaks a
 * tie between two scripts on the same level.
 */
export function TargetingCard({
  groups, onGroups, productIds, onProducts, priority, onPriority, products, twins, productName, coverage, title, disabled,
}: {
  groups: ScriptGroup[];
  onGroups: (g: ScriptGroup[]) => void;
  productIds: string[];
  onProducts: (ids: string[]) => void;
  priority: number;
  onPriority: (n: number) => void;
  products: readonly ProductIndexRow[];
  twins: Readonly<Record<string, readonly string[]>>;
  productName: (id: string) => string | undefined;
  coverage?: CoverageResponse | null;
  title: string;
  disabled?: boolean;
}) {
  const L = useScriptLabels();
  const { t } = L;
  return (
    <section className={`${card} space-y-4 p-3 sm:p-4`} aria-labelledby="cs-targeting" data-testid="targeting-card">
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0">
          <h3 id="cs-targeting" className="text-sm font-semibold">{t('callScripts.editor.targeting')}</h3>
          <p className="text-xs text-muted-foreground">{t('callScripts.editor.targetingHint')}</p>
        </div>
      </div>

      <div className="space-y-2">
        <p className={groupLabelCls}>{t('callScripts.editor.groups')}</p>
        <GroupChips value={groups} onChange={onGroups} coverage={coverage} disabled={disabled} />
        {coverage === null && <p className="text-[11px] text-muted-foreground">{t('callScripts.editor.waitingUnknown')}</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={groupLabelCls}>{t('callScripts.editor.products')}</p>
          <ProductPicker products={products} value={productIds} onChange={onProducts} twins={twins} title={title} disabled={disabled}
            className="w-full sm:w-72" label={productIds.length ? t('callScripts.editor.pickedN', { n: productIds.length }) : undefined} />
        </div>
        <PickedProducts value={productIds} onChange={onProducts} twins={twins} name={productName} disabled={disabled} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label htmlFor="cs-priority" className={groupLabelCls}>{t('callScripts.editor.priority')}</label>
        <Input id="cs-priority" type="number" inputMode="numeric" min={PRIORITY_MIN} max={PRIORITY_MAX} step={1} value={priority}
          disabled={disabled} onChange={(e) => onPriority(clampPriority(e.target.value))} className="h-9 w-24 text-base md:text-sm" />
        <p className="basis-full text-[11px] leading-snug text-muted-foreground sm:basis-auto sm:flex-1">{t('callScripts.editor.priorityHint')}</p>
      </div>
    </section>
  );
}
