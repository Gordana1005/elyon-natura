import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, ChevronDown, ChevronRight, ChevronUp, Loader2, Search, HelpCircle } from 'lucide-react';
import { apiGetAllCallScripts, type CallScript } from '@/lib/api';
import {
  resolveScript, SCRIPT_LANGS, storedScriptLang, persistScriptLang, type ScriptLang,
} from '@/lib/callScripts';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { cn } from '@/lib/utils';
import { hoverLift } from '@/lib/design-utils';
import { normalizeForSearch } from '@/lib/transliterate';

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
  // Local state for the 30% helpers pane (clean, per-script, no global stuffing)
  const [helperSearch, setHelperSearch] = useState('');
  const [openHelper, setOpenHelper] = useState<string | null>(null); // single open for minimalist feel

  const searchNorm = normalizeForSearch(helperSearch);
  const helpers = (r.helpers || []).filter(h => {
    if (!searchNorm) return true;
    const titleNorm = normalizeForSearch(h.title);
    const contentNorm = normalizeForSearch(h.content || '');
    return titleNorm.includes(searchNorm) || contentNorm.includes(searchNorm);
  });

  const toggleHelper = (title: string) => {
    setOpenHelper(prev => (prev === title ? null : title));
  };

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

            {/* RIGHT 30% — clean, minimalist helpers / FAQ pane */}
            <div className="rounded-lg border border-border/40 bg-card/60 p-2.5 flex flex-col min-w-0">
              <div className="flex items-center justify-between mb-1.5 px-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <HelpCircle className="h-3 w-3 text-sky-400" />
                  {t('scriptsPanel.helpers')}
                  {helpers.length > 0 && <span className="font-normal normal-case text-[10px]">({helpers.length})</span>}
                </div>
              </div>

              {/* Tiny search (only useful, not stuffed) */}
              { (r.helpers || []).length > 3 && (
                <div className="relative mb-1.5">
                  <Search className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground/60" />
                  <input
                    type="text"
                    value={helperSearch}
                    onChange={(e) => { setHelperSearch(e.target.value); setOpenHelper(null); }}
                    placeholder={t('scriptsPanel.searchPlaceholder')}
                    className="w-full bg-background/60 border border-border/50 text-[11px] pl-6 pr-2 py-1 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/50"
                    title={t('scriptsPanel.searchTooltip')}
                  />
                </div>
              )}

              <div className="flex-1 space-y-0.5 overflow-y-auto max-h-[340px] pr-0.5 text-[11px]">
                {helpers.length === 0 ? (
                  <div className="text-[10px] text-muted-foreground/60 italic px-1 py-2">
                    { (r.helpers || []).length === 0
                      ? t('scriptsPanel.noHelpers')
                      : t('scriptsPanel.noMatches') }
                  </div>
                ) : (
                  helpers.map((h, idx) => {
                    const key = `${h.title}-${idx}`;
                    const isOpen = openHelper === key;
                    return (
                      <div key={key} className={cn(
                        'rounded border border-border/30 bg-muted/10',
                        isOpen && 'border-primary/20 bg-primary/5'
                      )}>
                        <button
                          type="button"
                          onClick={() => toggleHelper(key)}
                          className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/30 rounded"
                        >
                          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform text-muted-foreground/70', isOpen && 'rotate-90')} />
                          <span className="font-medium truncate">{h.title}</span>
                          {h.category && (
                            <span className="ml-auto text-[9px] px-1 py-px rounded bg-muted/40 text-muted-foreground/70">{h.category}</span>
                          )}
                        </button>
                        {isOpen && h.content && (
                          <div className="px-2.5 pb-2 pt-0.5 text-[11px] leading-[1.55] text-foreground/90 whitespace-pre-wrap border-t border-primary/10">
                            {h.content}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
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
