import i18n from '@/i18n';
import { formatDenari, formatMoney } from '@/lib/currency';

export interface NotificationRow {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  link: string | null;
  created_at: string;
  // Optional structured payload written by the newer DB jobs:
  // { i18n: 'notif.<key>', ...interpolation vars }. See migration
  // 20260905000000_notifications_meta.sql. order_paid / order_returned also carry
  // recipient 'owner' | 'admin' since 20261015130000.
  meta?: Record<string, any> | null;
}

// An `order_paid` row written before 20260940000400 has no meta and prints the
// stored EUR price as '€NN.NN'. Re-read it into the same vars the new rows
// carry, so every paid bell shows денари (and the reader's language).
const LEGACY_ORDER_PAID = /^Order (.+?) \((.*)\) was paid — €(\d+(?:\.\d+)?)\.$/;
// order_returned had no meta before 20261015130000.
const LEGACY_ORDER_RETURNED = /^Order (.+?) \((.*)\) was marked Returned\.$/;

function legacyMeta(n: NotificationRow): Record<string, any> | null {
  if (n.meta?.i18n) return null;
  if (n.type === 'order_paid') {
    const m = LEGACY_ORDER_PAID.exec(n.message ?? '');
    return m ? { i18n: 'notif.orderPaid', order: m[1], customer: m[2], amountEur: Number(m[3]) } : null;
  }
  if (n.type === 'order_returned') {
    const m = LEGACY_ORDER_RETURNED.exec(n.message ?? '');
    return m ? { i18n: 'notif.orderReturnedLegacy', order: m[1], customer: m[2] } : null;
  }
  return null;
}

// Render a notification in the READER's language.
//
// The DB cannot know which language the reader picked, so triggers/jobs write
// English title+message AND (since 2026-09) an optional `meta.i18n` key plus its
// interpolation vars. When the key is present we translate; the stored English
// text is passed as i18next's `defaultValue`, so a missing locale key degrades to
// readable English instead of a `⟪key⟫` placeholder. Legacy rows (meta = NULL)
// render exactly as before.
//
// Module-level on purpose → uses `i18n.t`, never `t`. Inside the custom toast
// renderers `t` is the sonner toast instance, and inside the components the
// useTranslation() subscription already re-renders on a language switch.
export function localizeNotification(n: NotificationRow): { title: string; message: string } {
  const meta = n.meta?.i18n ? n.meta : legacyMeta(n);
  const key = meta?.i18n;
  if (!key) return { title: n.title, message: n.message };
  // Spread the payload FIRST so `defaultValue` (and any other i18next control
  // option) always wins over the stored data. meta is row data, and row data
  // must never steer the translator.
  const vars: Record<string, any> = { ...meta };
  // Money reaches the text as денари only: amountMkd is already denari
  // (formatDenari, never ×61.5 again); a legacy row's amountEur is the stored
  // EUR price (formatMoney).
  if (vars.amountMkd != null) vars.amount = formatDenari(vars.amountMkd);
  else if (vars.amountEur != null) vars.amount = formatMoney(vars.amountEur);
  // A legacy paid row's stored English still has the euro figure — never fall back to it.
  const fallback = meta === n.meta || n.type === 'order_returned' ? n.message : '';
  let message = i18n.t(`${key}.body`, { ...vars, defaultValue: fallback });
  // The digest carries how long ago MEX last reported courier outcomes (the
  // mex-reconcile cron). Say so when it is over a day and a half old — the
  // counts are only as fresh as that sync. `syncAgeHours` on older rows
  // measured the removed BigArena upload and is deliberately ignored.
  if (n.type === 'unpaid_digest' && vars.mexSyncAgeHours != null && Number(vars.mexSyncAgeHours) >= 36) {
    message += ' ' + i18n.t(`${key}.staleMex`, { ...vars, defaultValue: '' });
  }
  return { title: i18n.t(`${key}.title`, { ...vars, defaultValue: n.title }), message };
}

// Pull the client's number out of a notification so the row can offer a one-tap
// copy (and, for missed calls, a deep-link straight to that caller in the inbox).
// Prefer structured data — `meta.phone`, then a `?phone=` on the link — and only
// then fall back to the first phone-like digit run in the message.
export function extractCallerPhone(n: NotificationRow): string | null {
  if (n.type !== 'missed_call' && n.type !== 'shipped_unpaid') return null;
  if (n.meta?.phone) return String(n.meta.phone);
  if (n.link && n.link.includes('phone=')) {
    const p = new URLSearchParams(n.link.split('?')[1] || '').get('phone');
    if (p) return p;
  }
  // Digit-scraping the message is a last resort for the older missed-call rows
  // that predate `meta`; never applied to a message that could contain an order
  // number instead of a phone.
  if (n.type !== 'missed_call') return null;
  const m = n.message?.match(/\+?\d[\d\s().-]{6,}\d/);
  return m ? m[0].replace(/[\s().-]/g, '') : null;
}
