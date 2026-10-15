import {
  AlertTriangle, BadgeCheck, CalendarClock, Clock, FileWarning, FileX, Handshake, Hourglass, Info, Package,
  PackageSearch, PackageX, PhoneMissed, RotateCcw, TrendingDown, TrendingUp, Truck, UserPlus,
  type LucideIcon,
} from 'lucide-react';

/**
 * ONE place that knows every notification type the bell can show (owner 15.10.2026, stacked bell).
 * A new producer adds its type here — icon, tone, toast loudness, category, and whether it stacks —
 * and nowhere else (the five per-type maps of NotificationsDropdown were folded into this).
 *
 *  - stack: one card per type per Skopje day ("Платени нарачки · 48 · 93.600 ден.", "Види ги сите").
 *    The high-volume types only — an admin gets ~490 paid / returned rows a day.
 *  - important: shown pinned on top of the bell while unread ("Важно"); never stacked.
 *  - everything else: its own row, fetched apart from the stacks, so a flood of paid orders can
 *    never push it out of the bell.
 */
export type NotifCategory = 'orders' | 'affiliate' | 'team' | 'system';
export const NOTIF_CATEGORIES: readonly NotifCategory[] = ['orders', 'affiliate', 'team', 'system'];

/** happy = paid, sad = returned, red = urgent, warn = act today. */
export type NotifTone = 'happy' | 'sad' | 'rose' | 'red' | 'warn' | 'sky' | 'violet' | 'primary' | 'neutral';
export type ToastLevel = 'error' | 'warning' | 'success' | 'default';

export interface NotifTypeSpec {
  icon: LucideIcon;
  tone: NotifTone;
  toast: ToastLevel;
  category: NotifCategory;
  stack?: boolean;
  important?: boolean;
}

export const NOTIF_TYPES: Record<string, NotifTypeSpec> = {
  // ── Нарачки ──
  order_paid: { icon: BadgeCheck, tone: 'happy', toast: 'success', category: 'orders', stack: true },
  order_returned: { icon: RotateCcw, tone: 'sad', toast: 'error', category: 'orders', stack: true },
  // The unpaid-delivery chase: one per order per day from day 3 (20260905000100).
  shipped_unpaid: { icon: Truck, tone: 'warn', toast: 'warning', category: 'orders', stack: true },
  unpaid_digest: { icon: PackageSearch, tone: 'warn', toast: 'warning', category: 'orders' },
  // The 5-day collabBox entry rule (20260947001900): cancelled (red) / the evening-before warning.
  not_in_collab: { icon: FileX, tone: 'red', toast: 'error', category: 'orders', important: true },
  not_in_collab_warning: { icon: FileWarning, tone: 'warn', toast: 'warning', category: 'orders' },
  // ── Affiliate (the AlterCPA guarantee, 20260944000300; a partner's lead via POST /cpa/lead) ──
  altercpa_rate: { icon: TrendingUp, tone: 'sky', toast: 'default', category: 'affiliate' },
  altercpa_rate_below: { icon: TrendingDown, tone: 'warn', toast: 'warning', category: 'affiliate', important: true },
  affiliate_lead: { icon: Handshake, tone: 'violet', toast: 'default', category: 'affiliate' },
  // ── Тим ──
  assignment: { icon: UserPlus, tone: 'primary', toast: 'default', category: 'team', stack: true },
  // 30+ idle minutes (20260935000200) — a manager gets one per idle agent per half hour.
  inactivity: { icon: Hourglass, tone: 'warn', toast: 'warning', category: 'team', stack: true },
  // The shifts runway alert at 17:05 (20260943000100).
  shifts_runway: { icon: CalendarClock, tone: 'warn', toast: 'warning', category: 'team', important: true },
  // ── Систем ──
  missed_call: { icon: PhoneMissed, tone: 'rose', toast: 'error', category: 'system' },
  low_stock: { icon: PackageX, tone: 'warn', toast: 'warning', category: 'system', important: true },
  info: { icon: Info, tone: 'primary', toast: 'default', category: 'system' },
  warning: { icon: AlertTriangle, tone: 'warn', toast: 'warning', category: 'system' },
  shipment: { icon: Package, tone: 'happy', toast: 'default', category: 'system' },
  reminder: { icon: Clock, tone: 'sky', toast: 'default', category: 'system' },
};

const FALLBACK: NotifTypeSpec = { icon: Info, tone: 'neutral', toast: 'default', category: 'system' };

export const specOf = (type: string): NotifTypeSpec => NOTIF_TYPES[type] ?? FALLBACK;

/** The types shown as one card per Skopje day. */
export const STACK_TYPES: readonly string[] = Object.keys(NOTIF_TYPES).filter((k) => NOTIF_TYPES[k].stack);
export const IMPORTANT_TYPES: readonly string[] = Object.keys(NOTIF_TYPES).filter((k) => NOTIF_TYPES[k].important);

export const isStackType = (type: string) => !!NOTIF_TYPES[type]?.stack;

/** The bell's chips: everything, the pinned kinds, or one category. */
export type NotifFilter = 'all' | 'important' | NotifCategory;
export const NOTIF_FILTERS: readonly NotifFilter[] = ['all', 'important', ...NOTIF_CATEGORIES];

export function matchesFilter(type: string, filter: NotifFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'important') return !!specOf(type).important;
  return specOf(type).category === filter;
}

/** The known types of a filter (for a server-side `type in (…)`); null = no type filter. */
export function typesOfFilter(filter: NotifFilter): string[] | null {
  if (filter === 'all') return null;
  return Object.keys(NOTIF_TYPES).filter((k) => matchesFilter(k, filter));
}

const ICON_CLASS: Record<NotifTone, string> = {
  happy: 'text-emerald-500',
  sad: 'text-pink-500',
  rose: 'text-rose-500',
  red: 'text-red-500',
  warn: 'text-amber-500',
  sky: 'text-sky-500',
  violet: 'text-violet-500',
  primary: 'text-primary',
  neutral: 'text-muted-foreground',
};

// An unread row: a tinted bar + background in the type's mood (happy green, sad pink, urgent red).
const UNREAD_ROW_CLASS: Record<NotifTone, string> = {
  happy: 'bg-emerald-500/10 border-l-2 border-emerald-500 data-[highlighted]:bg-emerald-500/15 focus:bg-emerald-500/15',
  sad: 'bg-pink-500/10 border-l-2 border-pink-500 data-[highlighted]:bg-pink-500/15 focus:bg-pink-500/15',
  rose: 'bg-rose-500/10 border-l-2 border-rose-500 data-[highlighted]:bg-rose-500/15 focus:bg-rose-500/15',
  red: 'bg-red-500/10 border-l-2 border-red-600 data-[highlighted]:bg-red-500/15 focus:bg-red-500/15',
  warn: 'bg-amber-500/10 border-l-2 border-amber-500 data-[highlighted]:bg-amber-500/15 focus:bg-amber-500/15',
  sky: 'bg-sky-500/10 border-l-2 border-sky-500 data-[highlighted]:bg-sky-500/15 focus:bg-sky-500/15',
  violet: 'bg-violet-500/10 border-l-2 border-violet-500 data-[highlighted]:bg-violet-500/15 focus:bg-violet-500/15',
  primary: 'bg-primary/5 border-l-2 border-primary data-[highlighted]:bg-primary/10 focus:bg-primary/10',
  neutral: 'bg-red-500/5 border-l-2 border-red-500 data-[highlighted]:bg-red-500/15 focus:bg-red-500/15',
};

const UNREAD_TITLE_CLASS: Record<NotifTone, string> = {
  happy: 'font-semibold text-emerald-600 dark:text-emerald-400',
  sad: 'font-semibold text-pink-600 dark:text-pink-400',
  rose: 'font-semibold text-rose-600 dark:text-rose-400',
  red: 'font-semibold text-red-600 dark:text-red-400',
  warn: 'font-semibold text-amber-600 dark:text-amber-400',
  sky: 'font-semibold text-sky-600 dark:text-sky-400',
  violet: 'font-semibold text-violet-600 dark:text-violet-400',
  primary: 'font-semibold text-foreground',
  neutral: 'font-semibold text-foreground',
};

export const iconClassOf = (type: string) => ICON_CLASS[specOf(type).tone];
export const unreadRowClassOf = (type: string) => UNREAD_ROW_CLASS[specOf(type).tone];
export const unreadTitleClassOf = (type: string) => UNREAD_TITLE_CLASS[specOf(type).tone];
