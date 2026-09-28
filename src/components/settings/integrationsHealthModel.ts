// Settings → Integrations health: pure helpers (unit-tested in
// integrationsHealthModel.test.ts). Times are shown in Europe/Skopje whatever
// the reader's machine is set to.
import { eurToDen } from '@/lib/currency';
import type { HealthStatus, IntegrationsHealth, NoParcelReportRow } from '@/lib/api';

/** "28.09 21:10" (withYear: "28.09.2026 21:10") in Europe/Skopje. */
export function skopjeDateTime(iso: string | null | undefined, withYear = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.day}.${parts.month}${withYear ? `.${parts.year}` : ''} ${parts.hour}:${parts.minute}`;
}

/** How long ago, in the largest whole unit: now (< 1 min) · m · h · d. */
export function agoParts(iso: string | null | undefined, now: number): { unit: 'now' | 'm' | 'h' | 'd'; n: number } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return { unit: 'now', n: 0 };
  if (min < 60) return { unit: 'm', n: min };
  const h = Math.floor(min / 60);
  if (h < 48) return { unit: 'h', n: h };
  return { unit: 'd', n: Math.floor(h / 24) };
}

/** "пред 5 мин" / "5 min ago" through the settings.integrations.ago.* keys. */
export function agoText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  iso: string | null | undefined,
  now: number,
): string {
  const p = agoParts(iso, now);
  if (!p) return t('settings.integrations.never');
  if (p.unit === 'now') return t('settings.integrations.ago.now');
  if (p.unit === 'd') return t('settings.integrations.ago.d', { count: p.n });
  return t(`settings.integrations.ago.${p.unit}`, { n: p.n });
}

const RANK: Record<HealthStatus, number> = { failing: 3, stale: 2, ok: 0, 'n/a': 0 };

/** Every status on the page that is not ok: feeds, their jobs, the rule, active cron jobs. */
export function issueCount(h: IntegrationsHealth | null | undefined): number {
  if (!h) return 0;
  let n = 0;
  for (const f of h.feeds ?? []) {
    if (RANK[f.status] > 0) n++;
    for (const j of f.jobs ?? []) if (RANK[j.status] > 0) n++;
  }
  if (h.no_parcel && RANK[h.no_parcel.status] > 0) n++;
  for (const c of h.cron ?? []) if (c.active && RANK[c.status] > 0) n++;
  return n;
}

/** The worse of two statuses (failing > stale > ok / n/a). */
export const worse = (a: HealthStatus, b: HealthStatus): HealthStatus => (RANK[b] > RANK[a] ? b : a);

/** A card's last error matters (is shown red) only when it is newer than its last success. */
export function errorIsCurrent(lastErrorAt: string | null | undefined, lastOkAt: string | null | undefined): boolean {
  if (!lastErrorAt) return false;
  if (!lastOkAt) return true;
  return new Date(lastErrorAt).getTime() > new Date(lastOkAt).getTime();
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The no-parcel run as CSV. Export FILE headers stay English (elyon-i18n);
 * price in whole denari at the frozen peg (elyon-currency); sold-at in Skopje.
 * A UTF-8 BOM so Excel opens Cyrillic names correctly.
 */
export function noParcelReportCsv(rows: NoParcelReportRow[]): string {
  const header = ['Order', 'Customer', 'Phone', 'City', 'Product', 'Qty', 'Price MKD', 'Sold at (Skopje)',
    'Days waiting', 'Seller', 'Source', 'Status now', 'Action', 'Parcel on same phone', 'Parcel belongs to order'];
  const lines = rows.map((r) => [
    r.display_id, r.customer_name, r.customer_phone, r.city, r.product, r.quantity,
    r.price_eur == null ? '' : eurToDen(r.price_eur), skopjeDateTime(r.sold_at, true), r.days_waiting,
    r.seller, r.sale_source, r.status_now, r.action, r.parcel, r.other_order,
  ].map(csvCell).join(','));
  return '﻿' + [header.join(','), ...lines].join('\r\n') + '\r\n';
}
