import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Loader2, MoreHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface ShellAction {
  key: string;
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * The order form's frame — Create / Confirm / Edit (Phase 6, plan 30.09).
 *
 *   md and up   a centred dialog (max-w-2xl; `wide` → two columns fit at lg)
 *   below md    a full-screen bottom sheet (h-[100dvh])
 *
 * Header and footer stick, the body scrolls. The backdrop, an outside click and
 * Escape NEVER close it — agents fill this in mid-call, so it closes only through
 * the X or Cancel. On a phone the footer keeps only the total and the primary
 * button; the other actions move into the ⋯ menu.
 */
export function OrderFormShell({
  open, onClose, title, subtitle, headerExtra, total, primary, secondary = [], notice, wide, children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  headerExtra?: ReactNode;
  /** The total, already formatted (денари). */
  total?: ReactNode;
  primary?: ShellAction;
  /** Cancel, "Зачувај го клиентот", … — inline from md, in ⋯ on a phone. */
  secondary?: ShellAction[];
  /** A line above the footer (what is missing, a warning). */
  notice?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          // No auto-focus on open: it put a ring on the X and raised the phone keyboard.
          onOpenAutoFocus={(e) => e.preventDefault()}
          data-testid="order-form-shell"
          className={cn(
            'fixed z-50 flex flex-col bg-card text-card-foreground shadow-2xl outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0',
            // phone: full-screen bottom sheet
            'inset-x-0 bottom-0 h-[100dvh] w-full max-md:data-[state=open]:slide-in-from-bottom-10',
            // md+: centred dialog
            'md:inset-auto md:left-1/2 md:top-1/2 md:h-auto md:max-h-[92dvh] md:w-[calc(100vw-2rem)] md:max-w-2xl',
            'md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:data-[state=open]:zoom-in-95',
            wide && 'lg:max-w-5xl',
          )}
        >
          <header className="shrink-0 border-b px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5 md:pt-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="break-words text-base font-semibold leading-tight">{title}</DialogPrimitive.Title>
                {subtitle && <div className="mt-0.5 min-w-0 text-xs text-muted-foreground">{subtitle}</div>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="-mr-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {headerExtra && <div className="mt-2">{headerExtra}</div>}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 md:px-5" data-testid="order-form-body">
            {children}
          </div>

          {notice && <div className="shrink-0 border-t bg-muted/40 px-4 py-2 text-xs md:px-5">{notice}</div>}

          <footer className="flex shrink-0 items-center gap-2 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3">
            <div className="min-w-0 flex-1 truncate text-base font-bold tabular-nums text-primary" data-testid="order-form-total">{total}</div>
            <div className="hidden items-center gap-2 md:flex">
              {secondary.map((a) => (
                <Button key={a.key} type="button" variant="outline" size="sm" onClick={a.onClick} disabled={a.disabled}>
                  {a.loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : a.icon}
                  {a.label}
                </Button>
              ))}
            </div>
            {secondary.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0 md:hidden" aria-label={t('orderForm.moreActions')}>
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[12rem]">
                  {secondary.map((a) => (
                    <DropdownMenuItem key={a.key} onSelect={a.onClick} disabled={a.disabled} className="min-h-11 gap-2">
                      {a.icon}{a.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {primary && (
              <Button
                type="button"
                onClick={primary.onClick}
                disabled={primary.disabled}
                className="h-11 shrink-0 px-4 md:h-9"
                data-testid="order-form-primary"
              >
                {primary.loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
                {primary.label}
              </Button>
            )}
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
