import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, ChevronDown, ChevronRight, ChevronUp, Loader2 } from 'lucide-react';
import { apiGetAllCallScripts, type CallScript } from '@/lib/api';
import {
  resolveScript, SCRIPT_LANGS, storedScriptLang, persistScriptLang, type ScriptLang,
} from '@/lib/callScripts';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { cn } from '@/lib/utils';
import { hoverLift } from '@/lib/design-utils';
import { QuickAnswers } from '@/components/callscripts/QuickAnswers';

export function CallScriptsPanel() {
  const { t } = useTranslation();
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The script language is INDEPENDENT of the app language: an agent whose UI is
  // Macedonian may still need to read the Albanian script to an Albanian-speaking
  // customer. Macedonian until the agent presses the Albanian flag.
  const [scriptLang, setScriptLang] = useState<ScriptLang>(storedScriptLang);
  const pickScriptLang = (l: ScriptLang) => { setScriptLang(l); persistScriptLang(l); };

  const { data: allScripts, isLoading } = useQuery({
    queryKey: ['product-scripts'],
    queryFn: apiGetAllCallScripts,
    staleTime: 5 * 60 * 1000,
    select: (all: CallScript[]) => all.filter(s => s.context_type === 'product'),
  });

  const scripts = allScripts ?? [];

  const toggle = (id: string) => setExpandedId(prev => prev === id ? null : id);

  return (
    <div className={`rounded-xl border border-border/60 bg-card p-3 ${hoverLift}`}>
      {/* Panel header */}
      <div
        className="flex items-center justify-between cursor-pointer select-none mb-1"
        onClick={() => setIsPanelOpen(p => !p)}
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FileText className="h-3.5 w-3.5 text-violet-400" />
          {t('scriptsPanel.title')}
          {scripts.length > 0 && (
            <span className="font-normal normal-case">({scripts.length})</span>
          )}
          {/* Script language: Macedonian / Albanian. stopPropagation keeps a flag
              press from collapsing the whole panel, since the header toggles it. */}
          <div
            className="ml-1.5 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-muted/30 p-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            {SCRIPT_LANGS.map(l => (
              <button
                key={l}
                type="button"
                onClick={() => pickScriptLang(l)}
                aria-pressed={l === scriptLang}
                title={t('scriptsPanel.scriptLanguage', { lang: t(`languages.${l}`) })}
                aria-label={t('scriptsPanel.scriptLanguage', { lang: t(`languages.${l}`) })}
                className={cn(
                  'rounded px-1 py-0.5 transition-opacity',
                  l === scriptLang
                    ? 'bg-background shadow-sm opacity-100 ring-1 ring-primary/30'
                    : 'opacity-45 hover:opacity-80',
                )}
              >
                <FlagIcon lang={l} className="h-2.5 w-5" />
              </button>
            ))}
          </div>
        </div>
        {isPanelOpen
          ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/60" />
          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />}
      </div>

      {isPanelOpen && (
        <div className="mt-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : scripts.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 text-center py-4 italic">
              {t('scriptsPanel.noScripts')}
            </p>
          ) : (
            <div className="space-y-1">
              {scripts.map(script => (
                <ScriptAccordionItem
                  key={script.id}
                  script={script}
                  lang={scriptLang}
                  isExpanded={expandedId === script.id}
                  onToggle={() => toggle(script.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScriptAccordionItem({
  script,
  lang,
  isExpanded,
  onToggle,
}: {
  script: CallScript;
  lang: ScriptLang;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Resolve for the SCRIPT language the agent picked with the flags — deliberately
  // not the app language. What an agent reads aloud to a Macedonian customer is a
  // property of the call, not of the language their own buttons are in. Per-field
  // fallback to the Macedonian base still applies, so a half-translated Albanian
  // script shows Macedonian for whatever is missing rather than a blank.
  const r = resolveScript(script, lang);
  return (
    <div className={cn(
      'rounded-lg border transition-colors',
      isExpanded
        ? 'border-primary/30 bg-primary/5'
        : 'border-border/40 bg-muted/20 hover:bg-muted/40',
    )}>
      {/* Row header (unchanged behavior) */}
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-primary" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <span className="text-xs font-semibold truncate block leading-tight">{r.title}</span>
            {r.description && (
              <span className="text-[10px] text-muted-foreground truncate block leading-tight mt-0.5">
                {r.description}
              </span>
            )}
          </div>
        </div>
      </button>

      {/* Expanded content — 70/30 split (mirrors the exact History/Calls 7fr_3fr pattern above for consistency) */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-2 border-t border-primary/20">
          <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-3">
            {/* LEFT 70% — the main script text (prominent, readable, preserved wide experience) */}
            <div
              className={cn(
                'rounded-lg bg-muted/30 border border-border/30 p-4',
                'text-[14px] leading-[1.85] whitespace-pre-wrap break-words',
                'text-foreground/90 max-h-[380px] overflow-y-auto overflow-x-hidden',
                'w-full',
              )}
            >
              {r.script_text
                ? <HighlightedScript text={r.script_text} />
                : <span className="text-muted-foreground italic text-xs">{t('scriptsPanel.noContent')}</span>}
            </div>

            {/* RIGHT 30% — the helpers / FAQ pane (shared with the targeted dock's "Брзи одговори") */}
            <QuickAnswers helpers={r.helpers || []} legacy />
          </div>
        </div>
      )}
    </div>
  );
}

// Highlights [placeholders] in the script text for easy reading
function HighlightedScript({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\])/g);
  return (
    <>
      {parts.map((part, i) =>
        /^\[[^\]]+\]$/.test(part) ? (
          <mark
            key={i}
            className="bg-amber-200/60 dark:bg-amber-800/40 text-amber-900 dark:text-amber-200 rounded px-0.5 font-semibold not-italic"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
