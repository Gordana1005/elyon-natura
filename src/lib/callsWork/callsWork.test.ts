import { describe, expect, it } from 'vitest';
import { formatLocalDisplay, telHref, toLocalDial } from './dial';
import { callbackChoices, isValidCallback, skopjeClock, skopjeWallToUtc } from './callbacks';
import { EMPTY_BACKOFF_MS, livePollInterval, outcomeForKey, TOP_CANCEL_REASONS, TOP_TRASH_REASONS } from './outcomes';
import { CANCEL_REASON_VALUES } from '@/lib/cancellationReasons';
import { TRASH_REASON_VALUES } from '@/lib/trashReasons';
import { navItemActive } from '@/lib/navActive';

describe('toLocalDial — the number an agent types on their own phone', () => {
  it('turns a Macedonian E.164 number into the local 0… form', () => {
    expect(toLocalDial('+38970123456')).toBe('070123456');
    expect(toLocalDial('0038970123456')).toBe('070123456');
    expect(toLocalDial('+389 2 312 3456')).toBe('023123456');
    expect(toLocalDial('070 123 456')).toBe('070123456');
    expect(toLocalDial('70123456')).toBe('070123456');
  });
  it('keeps a foreign number international and refuses junk', () => {
    expect(toLocalDial('+40721234567')).toBe('+40721234567');
    expect(toLocalDial('123')).toBe('');
    expect(toLocalDial(null)).toBe('');
  });
  it('reads it out in groups and builds the tel: link', () => {
    expect(formatLocalDisplay('070123456')).toBe('070 123 456');
    expect(formatLocalDisplay('023123456')).toBe('02 312 3456');
    expect(formatLocalDisplay('+40721234567')).toBe('+40721234567');
    expect(telHref('+38970123456')).toBe('tel:070123456');
    expect(telHref('')).toBeNull();
  });
});

describe('callback chips — on the Skopje clock', () => {
  it('converts Skopje wall time to UTC across DST', () => {
    expect(skopjeWallToUtc('2026-10-01', 18).toISOString()).toBe('2026-10-01T16:00:00.000Z'); // CEST +2
    expect(skopjeWallToUtc('2026-12-01', 10).toISOString()).toBe('2026-12-01T09:00:00.000Z'); // CET +1
  });
  it('offers in 1 h · in 3 h · this evening · tomorrow 10:00 in the morning', () => {
    const now = new Date('2026-10-01T08:00:00Z'); // 10:00 Skopje
    const c = callbackChoices(now);
    expect(c.map((x) => x.key)).toEqual(['in1h', 'in3h', 'evening', 'tomorrow']);
    expect(c[0].at.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(skopjeClock(c[2].at)).toBe('18:00');
    expect(c[3].at.toISOString()).toBe('2026-10-02T08:00:00.000Z');
  });
  it('drops "this evening" from 17:00 on', () => {
    const c = callbackChoices(new Date('2026-10-01T15:30:00Z')); // 17:30 Skopje
    expect(c.map((x) => x.key)).toEqual(['in1h', 'in3h', 'tomorrow']);
  });
  it('a custom time must be in the future and within 5 days', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    expect(isValidCallback(new Date('2026-10-01T09:00:00Z'), now)).toBe(true);
    expect(isValidCallback(new Date('2026-10-01T07:00:00Z'), now)).toBe(false);
    expect(isValidCallback(new Date('2026-10-07T09:00:00Z'), now)).toBe(false);
    expect(isValidCallback(null, now)).toBe(false);
  });
});

describe('outcomes', () => {
  it('maps the 1–5 shortcuts in bar order', () => {
    expect(['1', '2', '3', '4', '5', '6', 'a'].map(outcomeForKey))
      .toEqual(['no_answer', 'call_again', 'cancelled', 'trash', 'confirmed', null, null]);
  });
  it('the reason chips are pickable reasons, never "other" (that needs the note)', () => {
    for (const r of TOP_CANCEL_REASONS) expect(CANCEL_REASON_VALUES).toContain(r);
    for (const r of TOP_TRASH_REASONS) expect(TRASH_REASON_VALUES).toContain(r);
    expect(TOP_CANCEL_REASONS).not.toContain('other');
    expect(TOP_TRASH_REASONS).not.toContain('other');
    expect(TOP_CANCEL_REASONS).toHaveLength(4);
    expect(TOP_TRASH_REASONS).toHaveLength(4);
  });
  it('polls pause while hidden and back off while empty', () => {
    expect(livePollInterval(15_000, false, false)).toBe(15_000);
    expect(livePollInterval(15_000, true, false)).toBe(EMPTY_BACKOFF_MS);
    expect(livePollInterval(90_000, true, false)).toBe(90_000);
    expect(livePollInterval(15_000, false, true)).toBe(false);
  });
});

describe('navItemActive — the sidebar with a query item', () => {
  const sib = ['/calls', '/calls?queue=call-again', '/personal-list'];
  it('lights the callbacks item only on its view, and /calls steps aside', () => {
    expect(navItemActive('/calls?queue=call-again', '/calls', '?queue=call-again', sib)).toBe(true);
    expect(navItemActive('/calls', '/calls', '?queue=call-again', sib)).toBe(false);
    expect(navItemActive('/calls', '/calls', '', sib)).toBe(true);
    expect(navItemActive('/calls?queue=call-again', '/calls', '', sib)).toBe(false);
  });
  it('keeps sub-routes lit and / exact', () => {
    expect(navItemActive('/segments', '/segments/abc', '')).toBe(true);
    expect(navItemActive('/', '/orders', '')).toBe(false);
    expect(navItemActive('/', '/', '')).toBe(true);
  });
});
