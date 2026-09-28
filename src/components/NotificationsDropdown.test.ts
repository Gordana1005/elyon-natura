import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

// The bell renders money in денари only (owner, 2026-09-28): new order_paid rows
// carry meta.amountMkd (20260940000400); older rows only have '€NN.NN' in the
// stored English and are re-read by the legacy parser.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const { localizeNotification } = await import('./NotificationsDropdown');

const row = (over: Record<string, unknown>) => ({
  id: 'n1', title: 'Order paid', message: '', type: 'order_paid', is_read: false,
  link: '/orders', created_at: '2026-09-28T08:00:00Z', meta: null, ...over,
}) as Parameters<typeof localizeNotification>[0];

describe('localizeNotification — денари in the bell', () => {
  beforeAll(async () => { await i18n.changeLanguage('mk'); });
  afterAll(async () => { await i18n.changeLanguage('en'); });

  it('new order_paid rows: amountMkd is already denari (never ×61.5 again)', () => {
    const out = localizeNotification(row({
      message: 'Order ORD-1 (Марија) was paid — 2.490 ден.',
      meta: { i18n: 'notif.orderPaid', order: 'ORD-1', customer: 'Марија', amountMkd: 2490 },
    }));
    expect(out.title).toBe('Нарачката е платена');
    expect(out.message).toBe('Нарачката ORD-1 (Марија) е платена — 2.490 ден.');
  });

  it('legacy order_paid rows (meta NULL, €NN.NN) are re-rendered in денари', () => {
    const out = localizeNotification(row({ message: 'Order ORD-71829 (Ana (Bitola)) was paid — €24.23.' }));
    expect(out.message).toBe('Нарачката ORD-71829 (Ana (Bitola)) е платена — 1.490 ден.');
    expect(out.message).not.toContain('€');
  });

  it('an order_paid message the parser does not recognise is shown as stored', () => {
    const out = localizeNotification(row({ message: 'Something else' }));
    expect(out).toEqual({ title: 'Order paid', message: 'Something else' });
  });

  it('unpaid digest: MEX age from 36 h; the old BigArena syncAgeHours is ignored', () => {
    const base = { i18n: 'notif.unpaidDigest', total: 3, new: 1, days: 3, oldestOrder: 'ORD-9', oldestDays: 7 };
    const stale = localizeNotification(row({ type: 'unpaid_digest', meta: { ...base, mexSyncAgeHours: 40 } }));
    expect(stale.message).toContain('MEX');
    const legacy = localizeNotification(row({ type: 'unpaid_digest', meta: { ...base, syncAgeHours: 900 } }));
    expect(legacy.message).not.toContain('BigArena');
    expect(legacy.message).not.toContain('900');
  });
});
