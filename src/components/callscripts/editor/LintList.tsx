import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LintIssue, ScriptSection } from '@/lib/callScriptsTypes';
import { lintSectionId } from '../scriptsModel';
import { card, useScriptLabels } from '../parts';

/**
 * Предупредувања — never block a save: Bulgarian leftovers (евро, лв, Еконт, Спиди…), the owner's
 * terminology (прогноза, пендинг, на чекање), unknown {{variables}}, old [Placeholders] / ______,
 * and (information) parts with no Albanian text. A click jumps to the part.
 */
export function LintList({ issues, sections, onJump }: {
  issues: readonly LintIssue[];
  sections: readonly ScriptSection[];
  onJump?: (lang: 'mk' | 'sq', sectionId: string | null) => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const warns = issues.filter((i) => i.severity === 'warn');
  const infos = issues.filter((i) => i.severity === 'info');
  const fieldLabel = (field: string) => {
    const id = lintSectionId(field);
    if (id) { const s = sections.find((x) => x.id === id); return s ? L.section(s) : id; }
    if (field.startsWith('helper:')) return t('callScripts.lint.fieldHelper', { n: Number(field.slice(7)) + 1 });
    if (field === 'title') return t('callScripts.lint.fieldTitle');
    if (field === 'description') return t('callScripts.lint.fieldDescription');
    return t('callScripts.lint.fieldText');
  };
  const row = (i: LintIssue, k: number) => {
    const sid = lintSectionId(i.field);
    const body = (
      <>
        {i.severity === 'warn'
          ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium">{L.lint(i.code)}</span>
          <span className="text-muted-foreground"> · {i.lang.toUpperCase()} · {fieldLabel(i.field)}</span>
          {i.code !== 'missing_sq' && <> · <q className="rounded bg-muted px-1 font-mono text-[11px]">{i.match}</q></>}
        </span>
      </>
    );
    return (
      <li key={k}>
        {onJump ? (
          <button type="button" onClick={() => onJump(i.lang, sid)}
            className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {body}
          </button>
        ) : <div className="flex items-start gap-2 px-1.5 py-1 text-xs">{body}</div>}
      </li>
    );
  };
  return (
    <section className={cn(card, 'space-y-2 p-3 sm:p-4')} aria-labelledby="cs-lint" data-testid="lint-list">
      <h3 id="cs-lint" className="text-sm font-semibold">{t('callScripts.lint.title')}</h3>
      {warns.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />{t('callScripts.lint.none')}
        </p>
      ) : <ul className="space-y-0.5">{warns.map(row)}</ul>}
      {infos.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">{t('callScripts.lint.infoN', { n: infos.length })}</summary>
          <ul className="mt-1 space-y-0.5">{infos.map(row)}</ul>
        </details>
      )}
    </section>
  );
}
