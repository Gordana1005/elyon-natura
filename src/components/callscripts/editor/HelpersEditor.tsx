import { ArrowDown, ArrowUp, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CallScriptHelper } from '@/lib/callScriptsTypes';
import { moveItem } from '../scriptsModel';
import { card, useScriptLabels } from '../parts';
import type { useCursorInsert } from './VariableMenu';

/**
 * Брзи одговори — the quick answers next to the script on /calls (call_scripts.helpers): a title
 * the agent sees, an optional category and the text that opens. In Albanian a non-empty list
 * REPLACES the Macedonian one as a whole (no per-row fallback), so "Копирај од македонски" seeds it.
 */
export function HelpersEditor({ helpers, onHelpers, mkHelpers, lang, bind, disabled }: {
  helpers: CallScriptHelper[];
  onHelpers: (h: CallScriptHelper[]) => void;
  /** The Macedonian list (placeholders + the copy button in Albanian). */
  mkHelpers: CallScriptHelper[];
  lang: 'mk' | 'sq';
  bind: ReturnType<typeof useCursorInsert>['bind'];
  disabled?: boolean;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const update = (i: number, patch: Partial<CallScriptHelper>) => onHelpers(helpers.map((h, k) => (k === i ? { ...h, ...patch } : h)));
  return (
    <section className={`${card} space-y-3 p-3 sm:p-4`} aria-labelledby="cs-helpers" data-testid="helpers-editor">
      <div className="flex flex-wrap items-start gap-2">
        <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <h3 id="cs-helpers" className="text-sm font-semibold">{t('callScripts.editor.helpers')}</h3>
          <p className="text-xs text-muted-foreground">{lang === 'sq' ? t('callScripts.editor.helpersSqHint') : t('callScripts.editor.helpersHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {lang === 'sq' && helpers.length === 0 && mkHelpers.length > 0 && (
            <Button type="button" variant="outline" size="sm" className="h-9" disabled={disabled}
              onClick={() => onHelpers(mkHelpers.map((h) => ({ ...h })))}>{t('callScripts.editor.copyMk')}</Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-9" disabled={disabled}
            onClick={() => onHelpers([...helpers, { title: '', content: '', category: null }])} data-testid="add-helper">
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.addHelper')}
          </Button>
        </div>
      </div>
      {helpers.length === 0 && <p className="text-[11px] text-muted-foreground">{t('callScripts.editor.noHelpers')}</p>}
      <ol className="space-y-2">
        {helpers.map((h, i) => {
          const ref = lang === 'sq' ? mkHelpers[i] : undefined;
          return (
            <li key={i} className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 p-2.5">
              <div className="grid grid-cols-1 items-end gap-1.5 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
                <div className="min-w-0">
                  <Label htmlFor={`cs-h-${i}-t`} className="text-[11px] text-muted-foreground">{t('callScripts.helperTitle')}</Label>
                  <Input id={`cs-h-${i}-t`} value={h.title} disabled={disabled} onChange={(e) => update(i, { title: e.target.value })}
                    placeholder={ref?.title || t('callScripts.helperTitlePlaceholder')} className="h-9 text-base md:text-sm" />
                </div>
                <div className="min-w-0">
                  <Label htmlFor={`cs-h-${i}-c`} className="text-[11px] text-muted-foreground">{t('callScripts.helperCategory')}</Label>
                  <Input id={`cs-h-${i}-c`} value={h.category ?? ''} disabled={disabled} onChange={(e) => update(i, { category: e.target.value || null })}
                    placeholder={t('callScripts.helperCategoryPlaceholder')} className="h-9 text-base md:text-sm" />
                </div>
                <div className="flex items-center justify-end gap-0.5">
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={disabled || i === 0}
                    onClick={() => onHelpers(moveItem(helpers, i, -1))} aria-label={t('callScripts.editor.helperUp', { n: i + 1 })}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={disabled || i === helpers.length - 1}
                    onClick={() => onHelpers(moveItem(helpers, i, 1))} aria-label={t('callScripts.editor.helperDown', { n: i + 1 })}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" disabled={disabled}
                    onClick={() => onHelpers(helpers.filter((_, k) => k !== i))} aria-label={t('callScripts.editor.helperRemove', { n: i + 1 })}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
              <div>
                <Label htmlFor={`cs-h-${i}-x`} className="text-[11px] text-muted-foreground">{t('callScripts.helperContent')}</Label>
                <Textarea id={`cs-h-${i}-x`} value={h.content} disabled={disabled}
                  {...bind((v) => update(i, { content: v }))}
                  onChange={(e) => update(i, { content: e.target.value })}
                  placeholder={ref?.content || t('callScripts.helperContentPlaceholder')} className="min-h-[4.5rem] text-base leading-relaxed md:text-sm" />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
