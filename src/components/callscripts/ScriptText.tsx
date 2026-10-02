import { useTranslation } from 'react-i18next';
import {
  substitute, type ScriptLanguage, type ScriptSegment, type ScriptVars, type ScriptVarName,
} from '@/lib/callScriptsTypes';
import { cn } from '@/lib/utils';

/**
 * Script text with its variables — rendered from substitute()'s SEGMENTS as text nodes, never
 * as HTML (a "<b>" in a script stays literal; no dangerouslySetInnerHTML anywhere here).
 *
 *   vars = object     the call: a known value is filled in (lightly marked), an unknown one is an
 *                     AMBER chip with the variable's label ("Град") — the agent says it in their own words
 *   vars = null       a template (the /call-scripts editor preview): every variable is a neutral chip
 *   vars = undefined  plain text, nothing substituted (today's legacy panel)
 */
export function ScriptText({
  text, vars, lang, className,
}: {
  text: string | null | undefined;
  vars: ScriptVars | null | undefined;
  lang: ScriptLanguage;
  className?: string;
}) {
  if (vars === undefined) return <span className={className}>{text ?? ''}</span>;
  const segs = substitute(text, vars, lang);
  return (
    <span className={className}>
      {segs.map((s, i) => <Segment key={i} seg={s} template={vars === null} />)}
    </span>
  );
}

function Segment({ seg, template }: { seg: ScriptSegment; template: boolean }) {
  const { t } = useTranslation();
  const label = (name: ScriptVarName) => t(`callScripts.vars.${name}`, { defaultValue: name });
  if (seg.kind === 'text') return <>{seg.text}</>;
  if (seg.kind === 'var') {
    return (
      <span
        className="rounded-sm bg-primary/10 px-0.5 font-semibold text-foreground"
        title={label(seg.name)}
        data-testid="var-filled"
        data-var={seg.name}
      >
        {seg.text}
      </span>
    );
  }
  // missing (or every variable of a template)
  return (
    <span
      className={cn(
        'mx-px inline-flex items-center whitespace-nowrap rounded-md border px-1.5 align-baseline text-[0.85em] font-medium leading-snug',
        template
          ? 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200'
          : 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
      )}
      title={template ? seg.raw : `${t('scriptDock.body.missing', { label: label(seg.name) })} · ${seg.raw}`}
      data-testid={template ? 'var-chip' : 'var-missing'}
      data-var={seg.name}
    >
      {label(seg.name)}
    </span>
  );
}
