import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  MAX_SECTIONS, MAX_SECTION_TEXT, MAX_SECTION_TITLE, type ScriptSection, type SectionKey,
} from '@/lib/callScriptsTypes';
import { ScriptText } from '../ScriptText';
import { moveItem, newCustomSectionId, type SqDraft } from '../scriptsModel';
import { card, useScriptLabels } from '../parts';
import type { useCursorInsert } from './VariableMenu';

const KEY_DOT: Record<SectionKey, string> = {
  opening: 'bg-sky-500', pitch: 'bg-violet-500', objections: 'bg-amber-500', closing: 'bg-emerald-500', custom: 'bg-zinc-400 dark:bg-zinc-500',
};

/**
 * The script's parts: Отворање · Презентација · Приговори · Затворање (always there, empty ones are
 * not saved) and the writer's own parts ("Додај сопствен дел", a title each), every part movable.
 * In Albanian the same cards edit translations.sq by section id, with the Macedonian text below
 * for reference; an empty Albanian part falls back to Macedonian on /calls.
 */
export function SectionsEditor({ sections, onSections, sq, onSq, lang, bind, disabled, warnings }: {
  sections: ScriptSection[];
  onSections: (s: ScriptSection[]) => void;
  sq: SqDraft;
  onSq: (sq: SqDraft) => void;
  lang: 'mk' | 'sq';
  bind: ReturnType<typeof useCursorInsert>['bind'];
  disabled?: boolean;
  /** Warnings per section id (lint) — a small count on the card. */
  warnings?: Record<string, number>;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const setSection = (id: string, patch: Partial<ScriptSection>) =>
    onSections(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const setSq = (id: string, patch: { text?: string; title?: string }) =>
    onSq({ ...sq, sections: { ...sq.sections, [id]: { text: '', ...sq.sections[id], ...patch } } });
  const remove = (id: string) => {
    const rest = { ...sq.sections };
    delete rest[id];
    onSections(sections.filter((s) => s.id !== id));
    onSq({ ...sq, sections: rest });
  };
  const add = () => onSections([...sections, { id: newCustomSectionId(), key: 'custom', title: '', text: '' }]);

  return (
    <div className="space-y-3" data-testid="sections-editor">
      {sections.map((s, i) => {
        const custom = s.key === 'custom';
        const sqTr = sq.sections[s.id];
        const value = lang === 'mk' ? s.text : (sqTr?.text ?? '');
        const fieldId = `cs-sec-${s.id}`;
        const warn = warnings?.[s.id] ?? 0;
        return (
          <section key={s.id} className={cn(card, 'space-y-2 p-3')} aria-labelledby={`${fieldId}-h`} data-testid={`section-${s.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', KEY_DOT[s.key])} aria-hidden />
              {custom ? (
                <Input id={`${fieldId}-title`} aria-label={t('callScripts.editor.customTitle')} maxLength={MAX_SECTION_TITLE}
                  value={lang === 'mk' ? (s.title ?? '') : (sqTr?.title ?? '')}
                  placeholder={lang === 'mk' ? t('callScripts.editor.customTitlePlaceholder') : (s.title || t('callScripts.editor.customTitlePlaceholder'))}
                  onChange={(e) => (lang === 'mk' ? setSection(s.id, { title: e.target.value }) : setSq(s.id, { title: e.target.value }))}
                  disabled={disabled} className="h-8 min-w-0 flex-1 basis-40 text-base font-semibold md:text-sm" />
              ) : (
                <h4 id={`${fieldId}-h`} className="min-w-0 flex-1 text-sm font-semibold">{L.section(s)}</h4>
              )}
              {custom && <span id={`${fieldId}-h`} className="sr-only">{L.section(s)}</span>}
              {warn > 0 && (
                <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                  {t('callScripts.lint.countShort', { n: warn })}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={disabled || i === 0}
                  onClick={() => onSections(moveItem(sections, i, -1))} aria-label={t('callScripts.editor.moveUp', { section: L.section(s) })}>
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9" disabled={disabled || i === sections.length - 1}
                  onClick={() => onSections(moveItem(sections, i, 1))} aria-label={t('callScripts.editor.moveDown', { section: L.section(s) })}>
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </Button>
                {custom && (
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-destructive" disabled={disabled}
                    onClick={() => remove(s.id)} aria-label={t('callScripts.editor.removeSection', { section: L.section(s) })}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </div>
            </div>
            <Textarea id={fieldId} aria-labelledby={`${fieldId}-h`} value={value} disabled={disabled} maxLength={MAX_SECTION_TEXT}
              placeholder={lang === 'mk' ? t(`callScripts.editor.placeholder.${s.key}`) : (s.text ? t('callScripts.editor.sqPlaceholder') : t(`callScripts.editor.placeholder.${s.key}`))}
              {...bind((v) => (lang === 'mk' ? setSection(s.id, { text: v }) : setSq(s.id, { text: v })))}
              onChange={(e) => (lang === 'mk' ? setSection(s.id, { text: e.target.value }) : setSq(s.id, { text: e.target.value }))}
              className="min-h-[7.5rem] resize-y text-base leading-relaxed md:text-sm" />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
              {lang === 'sq' && s.text.trim() ? (
                <details className="min-w-0 flex-1">
                  <summary className="cursor-pointer select-none">{t('callScripts.editor.showMk')}</summary>
                  <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/30 p-2 text-xs leading-relaxed text-foreground">
                    <ScriptText text={s.text} vars={null} lang="mk" />
                  </div>
                </details>
              ) : <span />}
              <span className="tabular-nums">{value.length.toLocaleString('mk-MK')} / {MAX_SECTION_TEXT.toLocaleString('mk-MK')}</span>
            </div>
          </section>
        );
      })}
      <Button type="button" variant="outline" size="sm" className="h-9" onClick={add} disabled={disabled || lang !== 'mk' || sections.length >= MAX_SECTIONS}
        data-testid="add-section">
        <Plus className="mr-1.5 h-4 w-4" aria-hidden />{t('callScripts.editor.addSection')}
      </Button>
      {lang !== 'mk' && <p className="text-[11px] text-muted-foreground">{t('callScripts.editor.addSectionMkOnly')}</p>}
    </div>
  );
}
