import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Bell, CheckCheck, ChevronDown, ChevronUp, Copy, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDenari } from '@/lib/currency';
import { formatDistanceToNow } from '@/i18n/dates';
import { formatDmy } from '@/components/insights/shared/period';
import { addDaysYmd, skopjeTodayYmd } from '@/lib/skopjeTime';
import { fetchStackRows } from '@/lib/notifications/api';
import {
  isUnread, stackAmount, uniqueNames, type Feed, type NotifStack,
} from '@/lib/notifications/feed';
import { extractCallerPhone, localizeNotification, type NotificationRow } from '@/lib/notifications/localize';
import {
  NOTIF_FILTERS, iconClassOf, specOf, unreadRowClassOf, unreadTitleClassOf, type NotifFilter,
} from '@/lib/notifications/registry';

const STACK_PAGE = 20;

/** Сите · Важно · Нарачки · Affiliate · Тим · Систем — each with its unread count. */
export function NotificationFilterChips({
  value, onChange, countOf, className,
}: {
  value: NotifFilter;
  onChange: (f: NotifFilter) => void;
  countOf: (f: NotifFilter) => number;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} role="tablist">
      {NOTIF_FILTERS.map((f) => {
        const n = countOf(f);
        const active = value === f;
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(f)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted',
            )}
          >
            {t(`notif.filters.${f}`)}
            {n > 0 && (
              <span className={cn(
                'rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                active ? 'bg-primary-foreground/20' : f === 'important' ? 'bg-red-500 text-white' : 'bg-muted text-muted-foreground',
              )}>
                {n > 99 ? '99+' : n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function dayLabel(day: string, t: (k: string) => string): string {
  const today = skopjeTodayYmd();
  if (day === today) return t('notif.today');
  if (day === addDaysYmd(today, -1)) return t('notif.yesterday');
  return formatDmy(day);
}

/** One notification. `onOpen` marks it read and follows its link (the parent decides). */
export function NotificationRowView({
  n, unread, onOpen, dense = false,
}: {
  n: NotificationRow;
  unread: boolean;
  onOpen: (n: NotificationRow) => void;
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const spec = specOf(n.type);
  const Icon = spec.icon;
  const phone = extractCallerPhone(n);
  const { title, message } = localizeNotification(n);
  const copyPhone = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      toast.success(t('notif.numberCopied'), { description: p });
    } catch {
      toast.error(t('notif.copyFailed'));
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(n)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(n); } }}
      className={cn(
        'flex w-full cursor-pointer gap-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60',
        dense ? 'px-3 py-2' : 'px-4 py-3',
        unread && unreadRowClassOf(n.type),
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconClassOf(n.type))} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm break-words', unread ? unreadTitleClassOf(n.type) : 'text-muted-foreground')}>{title}</p>
        {message && <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>}
        {phone && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void copyPhone(phone); }}
            className="mt-1.5 inline-flex items-center gap-1 rounded-md border bg-background/70 px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-muted hover:text-primary"
            title={t('notif.copyNumber')}
          >
            <Copy className="h-3 w-3 shrink-0" />
            {phone}
          </button>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">
          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
        </p>
      </div>
      {unread && <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-500" />}
    </div>
  );
}

/**
 * One type, one Skopje day: "Платени нарачки · 48 · 93.600 ден." + the newest names, and
 * "Види ги сите (48)" opening the rows in place, 20 at a time.
 */
export function NotificationStackCard({
  stack, userId, readBefore, onOpenRow, onMarkStack,
}: {
  stack: NotifStack;
  userId: string;
  readBefore: string | null;
  onOpenRow: (n: NotificationRow) => void;
  onMarkStack: (s: NotifStack) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const spec = specOf(stack.type);
  const Icon = spec.icon;
  const unread = stack.unread > 0;
  const amount = stackAmount(stack);
  const names = uniqueNames(stack.names, 3);
  const moreNames = stack.total > names.length;

  const load = async (offset: number) => {
    setBusy(true);
    setFailed(false);
    try {
      const page = await fetchStackRows(userId, stack.type, stack.day, offset, STACK_PAGE);
      setRows((prev) => (offset === 0 ? page : [...prev, ...page]));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows.length === 0) void load(0);
  };
  const markRead = async () => {
    await onMarkStack(stack);
    setRows((prev) => prev.map((r) => ({ ...r, is_read: true })));
  };

  return (
    <div className={cn('border-b last:border-b-0', unread && unreadRowClassOf(stack.type))} data-testid={`notif-stack-${stack.type}`}>
      <div className="flex gap-3 px-4 py-3">
        <div className="relative mt-0.5 shrink-0">
          <Icon className={cn('h-4 w-4', iconClassOf(stack.type))} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm', unread ? unreadTitleClassOf(stack.type) : 'text-foreground')}>
            {t(`notif.stack.${stack.type}`, { defaultValue: stack.type })}
            <span className="font-normal text-muted-foreground"> · <span className="tabular-nums">{stack.total}</span></span>
            {amount != null && (
              <span className="font-normal text-muted-foreground"> · <span className="whitespace-nowrap tabular-nums">{formatDenari(amount)}</span></span>
            )}
          </p>
          {names.length > 0 && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {names.join(', ')}{moreNames ? ' …' : ''}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" onClick={toggle} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" aria-expanded={open}>
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {open ? t('notif.hide') : t('notif.seeAll', { count: stack.total })}
            </button>
            {unread && (
              <button type="button" onClick={() => void markRead()} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline">
                <CheckCheck className="h-3 w-3" />
                {t('notif.markStackRead')}
              </button>
            )}
            <span className="text-[10px] text-muted-foreground">
              {formatDistanceToNow(new Date(stack.latestAt), { addSuffix: true })}
            </span>
          </div>
        </div>
        {unread && (
          <span className="mt-0.5 h-fit shrink-0 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold leading-4 text-white tabular-nums" title={t('notif.newCount', { count: stack.unread })}>
            {stack.unread > 99 ? '99+' : stack.unread}
          </span>
        )}
      </div>
      {open && (
        <div className="ml-6 border-l bg-background/60">
          {rows.map((r) => (
            <NotificationRowView key={r.id} n={r} unread={isUnread(r, readBefore)} onOpen={onOpenRow} dense />
          ))}
          {failed && <p className="px-3 py-2 text-xs text-destructive">{t('notif.loadError')}</p>}
          {busy && <p className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>}
          {!busy && rows.length < stack.total && rows.length > 0 && (
            <button type="button" onClick={() => void load(rows.length)} className="w-full px-3 py-2 text-left text-xs font-medium text-primary hover:underline">
              {t('notif.more', { count: stack.total - rows.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Важно" on top, then the days (Денес / Вчера / 13.10.2026), newest first. */
export function NotificationFeedView({
  feed, userId, readBefore, onOpenRow, onMarkStack, onShowImportant, loading, error, emptyText,
}: {
  feed: Feed;
  userId: string | null;
  readBefore: string | null;
  onOpenRow: (n: NotificationRow) => void;
  onMarkStack: (s: NotifStack) => Promise<void>;
  onShowImportant?: () => void;
  loading: boolean;
  error: unknown;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  if (error && feed.days.length === 0 && feed.pinned.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-destructive">{t('notif.loadError')}</p>;
  }
  if (loading && feed.days.length === 0 && feed.pinned.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  if (feed.days.length === 0 && feed.pinned.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Bell className="mb-2 h-8 w-8 opacity-30" />
        <p className="text-sm">{emptyText ?? t('notif.empty')}</p>
      </div>
    );
  }
  return (
    <div>
      {feed.pinned.length > 0 && (
        <section aria-label={t('notif.important')}>
          <h4 className="flex items-center gap-1 bg-red-500/5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            <Pin className="h-3 w-3" />
            {t('notif.important')}
          </h4>
          {feed.pinned.map((n) => (
            <div key={n.id} className="border-b last:border-b-0">
              <NotificationRowView n={n} unread onOpen={onOpenRow} />
            </div>
          ))}
          {feed.pinnedMore > 0 && onShowImportant && (
            <button type="button" onClick={onShowImportant} className="w-full border-b px-4 py-1.5 text-left text-xs font-medium text-primary hover:underline">
              {t('notif.pinnedMore', { count: feed.pinnedMore })}
            </button>
          )}
        </section>
      )}
      {feed.days.map((d) => (
        <section key={d.day} aria-label={dayLabel(d.day, t)}>
          <h4 className="sticky top-0 z-[1] bg-muted/90 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
            {dayLabel(d.day, t)}
          </h4>
          {d.items.map((it) => (it.kind === 'stack'
            ? userId && (
              <NotificationStackCard
                key={`${it.stack.type}:${it.stack.day}`}
                stack={it.stack}
                userId={userId}
                readBefore={readBefore}
                onOpenRow={onOpenRow}
                onMarkStack={onMarkStack}
              />
            )
            : (
              <div key={it.row.id} className="border-b last:border-b-0">
                <NotificationRowView n={it.row} unread={isUnread(it.row, readBefore)} onOpen={onOpenRow} />
              </div>
            )))}
        </section>
      ))}
    </div>
  );
}
