import { describe, it, expect } from 'vitest';
import { sortPendingQueue, pickNextPending } from './pendingQueue';

const t = (iso: string) => iso;

describe('sortPendingQueue', () => {
  it('puts pending and take before call_again', () => {
    const sorted = sortPendingQueue([
      { id: 'ca', status: 'call_again', call_again_since: t('2026-08-24T08:00:00Z'), created_at: t('2026-08-20T00:00:00Z') },
      { id: 'p', status: 'pending', assigned_at: t('2026-08-24T09:00:00Z'), created_at: t('2026-08-23T00:00:00Z') },
      { id: 'tk', status: 'take', assigned_at: t('2026-08-24T10:00:00Z'), created_at: t('2026-08-22T00:00:00Z') },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['p', 'tk', 'ca']);
  });

  it('orders call_agains oldest-waiting first, not newest assigned_at', () => {
    const sorted = sortPendingQueue([
      { id: 'new', status: 'call_again', assigned_at: t('2026-08-25T12:00:00Z'), call_again_since: t('2026-08-25T12:00:00Z') },
      { id: 'old', status: 'call_again', assigned_at: t('2026-08-25T11:00:00Z'), call_again_since: t('2026-08-24T08:00:00Z') },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['old', 'new']);
  });
});

describe('pickNextPending', () => {
  const rows = sortPendingQueue([
    { id: 'fresh', status: 'pending', assigned_at: t('2026-08-25T10:00:00Z') },
    { id: 'just-na', status: 'call_again', call_again_since: t('2026-08-25T10:01:00Z') },
  ]);

  it('skips the just-disposed id when a fresh lead remains', () => {
    expect(pickNextPending(rows, 'just-na')?.id).toBe('fresh');
  });

  it('returns the same id when it is the only remaining lead', () => {
    const only = [{ id: 'just-na', status: 'call_again' as const, call_again_since: t('2026-08-25T10:01:00Z') }];
    expect(pickNextPending(only, 'just-na')?.id).toBe('just-na');
  });

  it('does not bounce to the same pending when another pending exists', () => {
    const two = sortPendingQueue([
      { id: 'a', status: 'pending', assigned_at: t('2026-08-25T11:00:00Z') },
      { id: 'b', status: 'pending', assigned_at: t('2026-08-25T10:00:00Z') },
    ]);
    expect(pickNextPending(two, 'a')?.id).toBe('b');
  });
});
