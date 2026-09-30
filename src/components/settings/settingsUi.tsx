// Поставки — small shared pieces in the Insights look: the section header, a
// card, the confirm dialog every dangerous action goes through, the "last
// changed by" line and the 10-second Undo toast.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, type LucideIcon } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import { skopjeDateTime } from './integrationsHealthModel';
import type { SettingsMetaEntry } from '@/lib/api';

export function SectionHeader({ icon: Icon, title, desc, aside }: {
  icon: LucideIcon; title: string; desc?: ReactNode; aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden /> <span className="min-w-0 break-words">{title}</span>
        </h2>
        {desc && <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{desc}</p>}
      </div>
      {aside}
    </div>
  );
}

export function SettingsCard({ title, desc, children, className, labelledBy }: {
  title?: ReactNode; desc?: ReactNode; children: ReactNode; className?: string; labelledBy?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card p-4 shadow-sm', className)} aria-labelledby={labelledBy}>
      {(title || desc) && (
        <header className="mb-3 space-y-0.5">
          {title && <h3 id={labelledBy} className="text-sm font-semibold">{title}</h3>}
          {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Every dangerous one-click action asks first. */
export function ConfirmDialog({ open, title, body, confirmLabel, destructive, busy, onConfirm, onCancel }: {
  open: boolean; title: ReactNode; body: ReactNode; confirmLabel: string; destructive?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            disabled={busy}
            className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Последна промена 01.10.2026 10:00 · Миле" (or "never changed"). */
export function LastChanged({ entry, className }: { entry: SettingsMetaEntry | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const text = !entry?.at
    ? t('settingsPage.rules.neverChanged')
    : entry.by_name
      ? t('settingsPage.rules.lastChanged', { when: skopjeDateTime(entry.at, true), who: entry.by_name })
      : t('settingsPage.rules.lastChangedNoWho', { when: skopjeDateTime(entry.at, true) });
  return <p className={cn('text-[11px] text-muted-foreground', className)}>{text}</p>;
}

/** The api's refusal codes in the reader's words; anything else through apiErrorText. */
export function settingsErrorText(err: unknown): string {
  const code = err instanceof Error ? err.message : '';
  return code && i18n.exists(`settingsPage.err.${code}`) ? i18n.t(`settingsPage.err.${code}`) : apiErrorText(err);
}

export const UNDO_MS = 10_000;

/** A toast with an Undo button that stays 10 seconds. */
export function useUndoToast() {
  const { toast } = useToast();
  const { t } = useTranslation();
  return (title: string, onUndo: () => void) => {
    toast({
      title,
      duration: UNDO_MS,
      action: (
        <ToastAction altText={t('settingsPage.undo')} onClick={onUndo}>
          {t('settingsPage.undo')}
        </ToastAction>
      ),
    });
  };
}
