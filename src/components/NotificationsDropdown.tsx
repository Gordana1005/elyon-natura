import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { addDaysYmd, skopjeMidnightIso, skopjeTodayYmd } from '@/lib/skopjeTime';
import type { NotifFilter } from '@/lib/notifications/registry';
import { NotificationFeedView, NotificationFilterChips } from '@/components/notifications/NotificationFeedView';
import { useNotificationFeed } from '@/components/notifications/useNotificationFeed';
import { useOpenNotification } from '@/components/notifications/useOpenNotification';

// Kept here for the callers / tests that import it from the bell.
export { localizeNotification } from '@/lib/notifications/localize';

/** The bell shows the last 7 Skopje days of stacks; /notifications has the whole history. */
const BELL_DAYS = 7;

/**
 * The bell (stacked, owner 15.10.2026): "Важно" on top, then one card per type per day for the
 * high-volume kinds (paid, returned, the unpaid chase, assignments, idle alerts) with "Види ги сите",
 * and every other notification as its own row — so the guarantees never drown in paid orders.
 * The badge counts each unread row + ONE per unread stack. Full history: /notifications.
 */
export function NotificationsDropdown() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotifFilter>('all');
  const today = skopjeTodayYmd();
  const from = useMemo(() => skopjeMidnightIso(addDaysYmd(today, -(BELL_DAYS - 1))), [today]);
  const n = useNotificationFeed({ from, filter, live: true, poll: true });
  const close = useMemo(() => () => setOpen(false), []);
  const openRow = useOpenNotification(n.markRow, close);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg border bg-background hover:bg-muted transition-colors"
          aria-label={t('notif.header')}
          data-testid="notif-bell"
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {n.unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white tabular-nums">
              {n.unread > 99 ? '99+' : n.unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-[calc(100vw-1rem)] max-w-[26rem] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <h3 className="text-sm font-semibold text-foreground">{t('notif.header')}</h3>
          {n.unread > 0 && (
            <button
              type="button"
              onClick={() => void n.markAll()}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <CheckCheck className="h-3 w-3" />
              {t('notif.markAllRead')}
            </button>
          )}
        </div>
        <NotificationFilterChips value={filter} onChange={setFilter} countOf={n.countOf} className="border-b px-4 py-2.5" />
        {/* Native overflow scroll — a Radix ScrollArea eats wheel events inside a popover. */}
        <div className="max-h-[min(30rem,calc(100dvh-11rem))] overflow-y-auto overscroll-contain">
          <NotificationFeedView
            feed={n.feed}
            userId={n.userId}
            readBefore={n.readBefore}
            onOpenRow={openRow}
            onMarkStack={n.markStack}
            onShowImportant={() => setFilter('important')}
            loading={n.loading}
            error={n.error}
          />
        </div>
        <Link
          to="/notifications"
          onClick={close}
          className="block border-t px-4 py-2.5 text-center text-xs font-medium text-primary hover:bg-muted"
        >
          {t('notif.openAll')} →
        </Link>
      </PopoverContent>
    </Popover>
  );
}
