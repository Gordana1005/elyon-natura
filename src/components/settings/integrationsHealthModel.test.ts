import { describe, expect, it } from 'vitest';
import type { IntegrationsHealth } from '@/lib/api';
import { agoParts, errorIsCurrent, issueCount, noParcelReportCsv, skopjeDateTime, worse } from './integrationsHealthModel';

describe('skopjeDateTime', () => {
  it('renders Skopje wall time (CEST in September, CET in December)', () => {
    expect(skopjeDateTime('2026-09-28T19:10:00Z')).toBe('28.09 21:10');
    expect(skopjeDateTime('2026-12-01T20:10:00Z', true)).toBe('01.12.2026 21:10');
    expect(skopjeDateTime(null)).toBe('');
    expect(skopjeDateTime('nope')).toBe('');
  });
});

describe('agoParts', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('picks the largest whole unit', () => {
    expect(agoParts('2026-09-28T11:59:30Z', now)).toEqual({ unit: 'now', n: 0 });
    expect(agoParts('2026-09-28T11:15:00Z', now)).toEqual({ unit: 'm', n: 45 });
    expect(agoParts('2026-09-27T12:00:00Z', now)).toEqual({ unit: 'h', n: 24 });
    expect(agoParts('2026-09-04T12:00:00Z', now)).toEqual({ unit: 'd', n: 24 });
    expect(agoParts(null, now)).toBeNull();
  });
});

describe('statuses', () => {
  it('orders failing > stale > ok', () => {
    expect(worse('ok', 'stale')).toBe('stale');
    expect(worse('failing', 'stale')).toBe('failing');
    expect(worse('n/a', 'ok')).toBe('n/a');
  });
  it('an error is current only when newer than the last success', () => {
    expect(errorIsCurrent('2026-09-27T01:15:00Z', '2026-08-09T01:16:00Z')).toBe(true);
    expect(errorIsCurrent('2026-09-22T03:08:00Z', '2026-09-27T23:40:00Z')).toBe(false);
    expect(errorIsCurrent(null, null)).toBe(false);
    expect(errorIsCurrent('2026-09-22T03:08:00Z', null)).toBe(true);
  });
  it('counts every non-ok status on the page (inactive cron jobs ignored)', () => {
    const h = {
      generated_at: '', today: '2026-09-28',
      feeds: [
        { key: 'altercpa', status: 'ok', jobs: [{ status: 'ok' }, { status: 'failing' }, { status: 'failing' }] },
        { key: 'collabbox', status: 'stale', jobs: [] },
        { key: 'web', status: 'n/a', jobs: [] },
      ],
      no_parcel: { status: 'ok' },
      cron: [{ active: true, status: 'failing' }, { active: false, status: 'failing' }, { active: true, status: 'n/a' }],
    } as unknown as IntegrationsHealth;
    expect(issueCount(h)).toBe(4);
    expect(issueCount(null)).toBe(0);
  });
});

describe('noParcelReportCsv', () => {
  it('writes English headers, denari at the frozen peg, Skopje times, escaped cells', () => {
    const csv = noParcelReportCsv([{
      order_id: 'x', display_id: 'ORD-1', customer_name: 'Ана, "Мила"', customer_phone: '+38970111222', city: 'Скопје',
      product: 'ВЕНО ГАРД', quantity: 2, price_eur: 32.52, sold_at: '2026-09-18T10:00:00Z', days_waiting: 10,
      seller: 'Iva', sale_source: 'altercpa', status_now: 'confirmed', action: 'cancel', parcel: null, other_order: null,
    }]);
    expect(csv.startsWith('﻿Order,Customer,Phone,City,Product,Qty,Price MKD,Sold at (Skopje)')).toBe(true);
    const line = csv.split('\r\n')[1];
    expect(line).toBe('ORD-1,"Ана, ""Мила""",+38970111222,Скопје,ВЕНО ГАРД,2,2000,18.09.2026 12:00,10,Iva,altercpa,confirmed,cancel,,');
  });
});
