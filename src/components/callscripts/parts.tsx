import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSkopje } from '@/lib/skopjeTime';
import { fmtInt, fmtNum } from '@/components/insights/overview/model';
import { isFixedKey } from './scriptsModel';
import type { LintCode, ScriptGroup, ScriptSectionLite, ScriptStatus, ScriptVarName, TargetedScript } from '@/lib/callScriptsTypes';

/** The Insights filter-bar chips (the /products and /users bars): 36 px on touch, 32 px from lg. */
export const chip = 'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 lg:h-8';
export const chipOn = 'border-foreground/80 bg-foreground text-background';
export const chipOff = 'bg-card text-foreground hover:bg-muted';
export const card = 'rounded-xl border bg-card shadow-sm';
export const groupLabelCls = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

/** Every label the page shows for the shared vocabulary (groups / sections / variables are C's keys). */
export function useScriptLabels() {
  const { t, i18n } = useTranslation();
  return useMemo(() => ({
    t,
    lang: i18n.language,
    group: (g: ScriptGroup | string) => t(`callScripts.groups.${g}`),
    groupDesc: (g: ScriptGroup | string) => t(`callScripts.groupsDesc.${g}`),
    family: (f: 'leads' | 'prediction' | 'all') => t(`callScripts.families.${f}`),
    section: (s: Pick<ScriptSectionLite, 'key' | 'title'>) =>
      (isFixedKey(s.key) ? t(`callScripts.sections.${s.key}`) : (s.title?.trim() || t('callScripts.sections.custom'))),
    status: (s: ScriptStatus | 'legacy') => t(`callScripts.status.${s}`),
    variable: (v: ScriptVarName | string) => t(`callScripts.vars.${v}`),
    lint: (c: LintCode | string) => t(`callScripts.lint.code.${c}`),
    date: (iso: string | null | undefined) => (iso ? formatSkopje(iso, 'dd.MM.yyyy HH:mm') : '—'),
    /** Counts with the reader's marks (1.514 in Macedonian), the Insights helpers. */
    int: (n: number | null | undefined) => fmtInt(n, i18n.language),
    /** A percentage figure (76.4 → "76,4%"). */
    pct: (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${fmtNum(v, i18n.language, 1)}%`),
  }), [t, i18n.language]);
}
export type ScriptLabels = ReturnType<typeof useScriptLabels>;

export const STATUS_TONES: Record<ScriptStatus | 'legacy', string> = {
  published: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  draft: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  archived: 'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300',
  legacy: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
};

export function StatusBadge({ script, className }: { script: Pick<TargetedScript, 'status' | 'context_type'>; className?: string }) {
  const L = useScriptLabels();
  const k = script.context_type === 'targeted' ? script.status : 'legacy';
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full border px-2 text-[11px] font-medium', STATUS_TONES[k], className)}>
      {L.status(k)}
    </span>
  );
}

/** The groups a script is attached to — "Сите групи" when none. */
export function GroupBadges({ groups, max = 4 }: { groups: readonly ScriptGroup[]; max?: number }) {
  const L = useScriptLabels();
  if (!groups.length) return <span className="text-xs text-muted-foreground">{L.t('callScripts.library.allGroups')}</span>;
  const shown = groups.slice(0, max);
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {shown.map((g) => (
        <span key={g} className="inline-flex h-6 max-w-full items-center rounded-md border bg-muted/40 px-1.5 text-[11px] font-medium">
          <span className="truncate">{L.group(g)}</span>
        </span>
      ))}
      {groups.length > max && <span className="inline-flex h-6 items-center text-[11px] text-muted-foreground">+{groups.length - max}</span>}
    </span>
  );
}

/** The products a script is attached to — "Сите производи" when none. */
export function ProductNames({ ids, name, max = 3 }: { ids: readonly string[]; name: (id: string) => string | undefined; max?: number }) {
  const L = useScriptLabels();
  if (!ids.length) return <span className="text-xs text-muted-foreground">{L.t('callScripts.library.allProducts')}</span>;
  const shown = ids.slice(0, max).map((id) => name(id) ?? L.t('callScripts.library.unknownProduct'));
  return (
    <span className="block min-w-0 break-words text-xs">
      {shown.join(' · ')}
      {ids.length > max && <span className="text-muted-foreground"> {L.t('callScripts.library.moreProducts', { n: ids.length - max })}</span>}
    </span>
  );
}

/** "⚠ N" — how many warnings the lint found (info-only issues do not count). */
export function WarningsBadge({ script }: { script: Pick<TargetedScript, 'lint'> }) {
  const L = useScriptLabels();
  const n = (script.lint ?? []).filter((l) => l.severity === 'warn').length;
  if (!n) return null;
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
      title={L.t('callScripts.library.warnings', { n })}>
      <AlertTriangle className="h-3 w-3" aria-hidden />{n}
    </span>
  );
}
