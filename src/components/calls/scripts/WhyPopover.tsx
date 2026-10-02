import { useTranslation } from 'react-i18next';
import { HelpCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ScriptContext, ScriptMatch } from '@/lib/callScriptsTypes';
import { basisLine, reasonLines } from './scriptDockModel';
import { cn } from '@/lib/utils';

/**
 * "Зошто?" — why the dock shows this script: the tier, the reasons, what decided a tie with the
 * next script, and how the call's group was found. Display only; the raw list name is in the
 * tooltip of the list chip, never here.
 */
export function WhyPopover({
  match, context, draftsIncluded, picked, className,
}: {
  match: ScriptMatch | null;
  context: ScriptContext | null;
  draftsIncluded?: boolean;
  /** The script on screen was picked by hand from the search. */
  picked?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const basis = basisLine(t, context);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          data-testid="why-trigger"
        >
          <HelpCircle className="h-3.5 w-3.5 text-sky-500" />
          {t('scriptDock.why.button')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-3 text-xs" data-testid="why-popover">
        <div className="mb-2 text-sm font-semibold">{t('scriptDock.why.title')}</div>
        {picked || !match ? (
          <p className="text-muted-foreground">{t('scriptDock.why.picked')}</p>
        ) : (
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('scriptDock.why.matchTitle')}</div>
            <p className="font-medium">{t(`scriptDock.why.tier.${match.tier}`)}</p>
            <ul className="space-y-1">
              {reasonLines(t, match, context).map((line, i) => (
                <li key={i} className="flex gap-1.5 break-words">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/60" aria-hidden />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
            {match.tie_break && (
              <p className="rounded-md bg-muted/50 px-2 py-1 text-muted-foreground">{t(`scriptDock.why.tieBreak.${match.tie_break}`)}</p>
            )}
          </div>
        )}
        {(basis || draftsIncluded) && (
          <div className="mt-3 space-y-1 border-t border-border/60 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('scriptDock.why.contextTitle')}
              {context && <span className="font-normal normal-case"> · {t(`scriptDock.source.${context.source}`)}</span>}
            </div>
            {basis && <p className="break-words">{basis}</p>}
            {draftsIncluded && <p className="text-amber-700 dark:text-amber-300">{t('scriptDock.why.drafts')}</p>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
