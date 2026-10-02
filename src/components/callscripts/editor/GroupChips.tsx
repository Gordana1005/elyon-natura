import { cn } from '@/lib/utils';
import type { CoverageResponse, ScriptGroup } from '@/lib/callScriptsTypes';
import { GROUP_FAMILIES, groupWaiting, toggleFamily, toggleGroup } from '../scriptsModel';
import { chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';

/**
 * The groups a script is aimed at, in two rows — Лидови (Нов лид · Повторен повик) and
 * Предикција (Нови купувачи … Корпа) — plus "Сите групи" (no group = every group). Each chip
 * carries the clients waiting in that group right now (the coverage's every-product row).
 */
export function GroupChips({ value, onChange, coverage, allowEvery = true, disabled, idPrefix = 'grp' }: {
  value: readonly ScriptGroup[];
  onChange: (groups: ScriptGroup[]) => void;
  coverage?: CoverageResponse | null;
  /** Show the "Сите групи" row (on when nothing is picked). */
  allowEvery?: boolean;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const L = useScriptLabels();
  return (
    <div className="space-y-2.5">
      {GROUP_FAMILIES.map((fam) => {
        const allOn = fam.groups.every((g) => value.includes(g));
        const id = `${idPrefix}-${fam.key}`;
        return (
          <div key={fam.key} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span id={id} className={groupLabelCls}>{L.family(fam.key)}</span>
              <button type="button" disabled={disabled} onClick={() => onChange(toggleFamily(value, fam.key))}
                className="text-[11px] font-medium text-primary hover:underline disabled:opacity-50">
                {allOn ? L.t('callScripts.editor.groupsNone') : L.t('callScripts.editor.groupsAll')}
              </button>
            </div>
            <div role="group" aria-labelledby={id} className="flex flex-wrap gap-1.5">
              {fam.groups.map((g) => {
                const on = value.includes(g);
                const waiting = groupWaiting(coverage, g);
                return (
                  <button key={g} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(toggleGroup(value, g))}
                    title={L.groupDesc(g)} data-testid={`group-chip-${g}`}
                    className={cn(chip, on ? chipOn : chipOff)}>
                    {L.group(g)}
                    {waiting != null && <span className="tabular-nums opacity-70">{L.int(waiting)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {allowEvery && (
        <div className="space-y-1.5">
          <span className={groupLabelCls}>{L.family('all')}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" aria-pressed={value.length === 0} disabled={disabled} onClick={() => onChange([])}
              className={cn(chip, value.length === 0 ? chipOn : chipOff)} data-testid="group-chip-every">
              {L.t('callScripts.editor.everyGroup')}
            </button>
            <span className="text-[11px] leading-snug text-muted-foreground">{L.t('callScripts.editor.everyGroupHint')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
