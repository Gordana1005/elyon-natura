import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, FileText } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { resolveTargetedScript } from '@/lib/callScriptsTypes';
import { storedScriptLang } from '@/lib/callScripts';
import { cn } from '@/lib/utils';
import { PreviewBadge, ScriptDockPanel } from './ScriptDock';
import { scriptCallKey } from './scriptDockModel';
import { useCallScriptsForCall, useCallScriptsMode, type CallScriptCtx } from './useCallScripts';

/**
 * Below md: one compact row "Скрипта · <title>" inside the pinned outcome bar (OutcomeBar's
 * `accessory`); a tap opens the same script in a bottom sheet at 85 % of the screen.
 */
export function ScriptDockMobile({ phone, context, className }: { phone: string; context: CallScriptCtx; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mode = useCallScriptsMode();
  const q = useCallScriptsForCall(phone, context, mode.data?.enabled_for_me === true);
  const best = q.data?.enabled ? q.data.best : null;
  const title = best ? resolveTargetedScript(best, storedScriptLang()).title : null;
  const preview = (q.data?.mode ?? mode.data?.mode) === 'preview';
  const label = q.isPending
    ? t('scriptDock.triggerLoading')
    : q.isError ? t('scriptDock.error')
      : title ? t('scriptDock.trigger', { title }) : t('scriptDock.triggerEmpty');

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-violet-200 bg-violet-50/70 px-3 text-left text-sm',
            'text-violet-950 transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100 dark:hover:bg-violet-500/20',
            className,
          )}
          data-testid="script-dock-trigger"
        >
          <FileText className="h-4 w-4 shrink-0 text-violet-500" />
          <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
          {preview && <PreviewBadge />}
          <ChevronUp className="h-4 w-4 shrink-0 opacity-60" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="flex h-[85vh] max-h-[85dvh] flex-col gap-0 rounded-t-2xl bg-card p-0"
        data-testid="script-dock-sheet"
      >
        <SheetHeader className="px-4 pb-1 pr-12 pt-4 text-left">
          <SheetTitle className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <FileText className="h-3.5 w-3.5 text-violet-500" /> {t('scriptDock.title')}
          </SheetTitle>
          <SheetDescription className="sr-only">{t('scriptDock.tabsLabel')}</SheetDescription>
        </SheetHeader>
        <ScriptDockPanel key={scriptCallKey(phone, context)} phone={phone} context={context} variant="sheet" />
      </SheetContent>
    </Sheet>
  );
}
