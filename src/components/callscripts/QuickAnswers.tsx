import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, HelpCircle, Search } from 'lucide-react';
import type { CallScriptHelper } from '@/lib/api';
import type { ScriptLanguage, ScriptVars } from '@/lib/callScriptsTypes';
import { normalizeForSearch } from '@/lib/transliterate';
import { cn } from '@/lib/utils';
import { ScriptText } from './ScriptText';

/** Searching shows only from this many answers up — below it a search box is clutter. */
export const QUICK_ANSWERS_SEARCH_FROM = 4;

export interface QuickAnswersProps {
  helpers: readonly CallScriptHelper[];
  /** undefined = plain text (today's panel) · null = template chips · object = the call's values. */
  vars?: ScriptVars | null;
  lang?: ScriptLanguage;
  /**
   * Today's /calls panel ("Помошници", its own 340 px scroll) — the exact strings and box it always
   * had. Off = the targeted dock's "Брзи одговори" (it scrolls with the script).
   */
  legacy?: boolean;
  className?: string;
}

/**
 * The quick answers (call_scripts.helpers) — one open at a time, a search over title + text
 * (Latin or Cyrillic, normalizeForSearch) once there are more than 3. Extracted from
 * CallScriptsPanel so today's panel and the targeted ScriptBody share one implementation.
 */
export function QuickAnswers({ helpers: all, vars, lang = 'mk', legacy, className }: QuickAnswersProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null); // single open for a minimalist feel

  const k = legacy
    ? { title: 'scriptsPanel.helpers', search: 'scriptsPanel.searchPlaceholder', none: 'scriptsPanel.noHelpers', noMatches: 'scriptsPanel.noMatches' }
    : { title: 'scriptDock.quick.title', search: 'scriptDock.quick.search', none: 'scriptDock.quick.none', noMatches: 'scriptDock.quick.noMatches' };

  const q = normalizeForSearch(search);
  const helpers = all.filter((h) => {
    if (!q) return true;
    return normalizeForSearch(h.title).includes(q) || normalizeForSearch(h.content || '').includes(q);
  });

  return (
    <div className={cn('rounded-lg border border-border/40 bg-card/60 p-2.5 flex flex-col min-w-0', className)} data-testid="quick-answers">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <HelpCircle className="h-3 w-3 text-sky-400" />
          {t(k.title)}
          {helpers.length > 0 && <span className="font-normal normal-case text-[10px]">({helpers.length})</span>}
        </div>
      </div>

      {all.length >= QUICK_ANSWERS_SEARCH_FROM && (
        <div className="relative mb-1.5">
          <Search className="absolute left-2 top-1.5 h-3 w-3 text-muted-foreground/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOpen(null); }}
            placeholder={t(k.search)}
            aria-label={t(k.search)}
            className={cn(
              'w-full bg-background/60 border border-border/50 pl-6 pr-2 py-1 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/50',
              // text-base below md on the dock: iOS zooms into a field under 16 px.
              legacy ? 'text-[11px]' : 'text-base md:text-[11px]',
            )}
            title={legacy ? t('scriptsPanel.searchTooltip') : undefined}
          />
        </div>
      )}

      <div className={cn('flex-1 space-y-0.5 pr-0.5 text-[11px]', legacy && 'overflow-y-auto max-h-[340px]')}>
        {helpers.length === 0 ? (
          <div className="text-[10px] text-muted-foreground/60 italic px-1 py-2">
            {all.length === 0 ? t(k.none) : t(k.noMatches)}
          </div>
        ) : (
          helpers.map((h, idx) => {
            const key = `${h.title}-${idx}`;
            const isOpen = open === key;
            return (
              <div key={key} className={cn('rounded border border-border/30 bg-muted/10', isOpen && 'border-primary/20 bg-primary/5')}>
                <button
                  type="button"
                  onClick={() => setOpen((prev) => (prev === key ? null : key))}
                  aria-expanded={isOpen}
                  className={cn(
                    'w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/30 rounded',
                    !legacy && 'min-h-9 md:min-h-0',
                  )}
                >
                  <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform text-muted-foreground/70', isOpen && 'rotate-90')} />
                  <span className={cn('font-medium', legacy ? 'truncate' : 'min-w-0 break-words text-xs md:text-[11px]')}>{h.title}</span>
                  {h.category && (
                    <span className="ml-auto shrink-0 text-[9px] px-1 py-px rounded bg-muted/40 text-muted-foreground/70">{h.category}</span>
                  )}
                </button>
                {isOpen && h.content && (
                  <div className={cn(
                    'px-2.5 pb-2 pt-0.5 leading-[1.55] text-foreground/90 whitespace-pre-wrap break-words border-t border-primary/10',
                    legacy ? 'text-[11px]' : 'text-[13px]',
                  )}>
                    <ScriptText text={h.content} vars={vars} lang={lang} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
