import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { callReasonFor, priorDecisions, type HistoryOrderLike } from './priorDecisions';
import { isCancelSelectionValid } from '@/lib/cancellationReasons';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import { isDispositionNoteValid, noteLength, noteMinFromMessage, normalizeNote } from '@/lib/dispositionNote';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const order = (over: Partial<HistoryOrderLike>): HistoryOrderLike => ({
  id: 'o', display_id: '100000', status: 'paid', created_at: '2026-08-01T08:00:00Z', ...over,
});

describe('priorDecisions — the next operator sees the previous cancel and trash', () => {
  it('nothing to show for a customer who never cancelled or was trashed', () => {
    expect(priorDecisions([order({ id: 'a' }), order({ id: 'b', status: 'pending' })])).toEqual({});
    expect(priorDecisions(null)).toEqual({});
  });

  it('the LATEST cancel and the LATEST trash, each with reason, note, who and when', () => {
    const r = priorDecisions([
      order({ id: 'c-old', status: 'cancelled', cancellation_reason: 'changed_mind', cancelled_at: '2026-06-01T08:00:00Z', decided_by_name: 'Ана' }),
      order({
        id: 'c-new', display_id: '100231', status: 'cancelled', cancellation_reason: 'no_money',
        cancellation_reason_notes: '  ќе плати\n по 15-ти ', cancelled_at: '2026-09-28T09:00:00Z', decided_by_name: 'Марија', decided_auto: false,
      }),
      order({
        id: 't1', status: 'trashed', trash_reason: 'not_reachable', trashed_at: '2026-08-12T10:00:00Z',
        decided_by_name: null, decided_auto: true,
      }),
    ]);
    expect(r.cancel).toEqual({
      kind: 'cancel', orderId: 'c-new', displayId: '100231', at: '2026-09-28T09:00:00Z',
      reasonLabel: 'Нема пари', note: 'ќе плати по 15-ти', by: 'Марија', auto: false,
    });
    expect(r.trash).toMatchObject({ kind: 'trash', orderId: 't1', reasonLabel: i18n.t('trashReason.not_reachable'), note: null, by: null, auto: true });
  });

  it('a duplicate_order trash is housekeeping, never shown as the customer\'s trash', () => {
    const r = priorDecisions([
      order({ id: 'dup', status: 'trashed', trash_reason: 'duplicate_order', trashed_at: '2026-09-30T08:00:00Z' }),
      order({ id: 'rude', status: 'trashed', trash_reason: 'rude', trash_reason_notes: 'викаше', trashed_at: '2026-07-01T08:00:00Z' }),
    ]);
    expect(r.trash?.orderId).toBe('rude');
    expect(priorDecisions([order({ status: 'trashed', trash_reason: 'duplicate_order' })])).toEqual({});
  });

  it('falls back to the creation day; an imported note that already starts with the reason is not doubled', () => {
    const r = priorDecisions([
      order({ id: 'x', status: 'cancelled', cancellation_reason: 'other', cancellation_reason_notes: 'Друго — duplicate — веќе нарачала', created_at: '2026-05-05T08:00:00Z' }),
    ]);
    expect(r.cancel).toMatchObject({ at: '2026-05-05T08:00:00Z', reasonLabel: null, note: 'Друго — duplicate — веќе нарачала' });
  });
});

describe('callReasonFor — the reason chip of a call row', () => {
  const byId = new Map<string, HistoryOrderLike>([
    ['c', order({ id: 'c', status: 'cancelled', cancellation_reason: 'no_money' })],
    ['t', order({ id: 't', status: 'trashed', trash_reason: 'wrong_number' })],
    ['n', order({ id: 'n', status: 'cancelled' })],
  ]);
  it('cancel / trash / wrong number read the order the call was logged against', () => {
    expect(callReasonFor({ outcome: 'cancelled', context_type: 'order', context_id: 'c' }, byId)).toBe('Нема пари');
    expect(callReasonFor({ outcome: 'trash', context_type: 'order', context_id: 't' }, byId)).toBe('Погрешен број');
    expect(callReasonFor({ outcome: 'wrong_number', context_type: 'order', context_id: 't' }, byId)).toBe('Погрешен број');
  });
  it('null for other outcomes, unknown orders, standalone rows and orders without a reason', () => {
    expect(callReasonFor({ outcome: 'no_answer', context_type: 'order', context_id: 'c' }, byId)).toBeNull();
    expect(callReasonFor({ outcome: 'cancelled', context_type: 'order', context_id: 'zzz' }, byId)).toBeNull();
    expect(callReasonFor({ outcome: 'cancelled', context_type: 'standalone', context_id: null }, byId)).toBeNull();
    expect(callReasonFor({ outcome: 'cancelled', context_type: 'order', context_id: 'n' }, byId)).toBeNull();
  });
});

describe('dispositionNote (client mirror) and the shared save-gates', () => {
  it('counts like the server', () => {
    expect(normalizeNote('  a  b  ')).toBe('a b');
    expect(noteLength('  a  b  ')).toBe(3);
    expect(noteLength('нема')).toBe(4);
    expect(noteLength('😀')).toBe(1);
    expect(isDispositionNoteValid('нема')).toBe(false);
    expect(isDispositionNoteValid('нема пари')).toBe(true);
    expect(isDispositionNoteValid('x'.repeat(1001))).toBe(false);
    expect(noteMinFromMessage('The note must be at least 7 characters long')).toBe(7);
    expect(noteMinFromMessage('boom')).toBe(5);
  });
  it('every reason needs the 5 characters now, not only "other"', () => {
    expect(isCancelSelectionValid('no_money', '')).toBe(false);
    expect(isCancelSelectionValid('no_money', 'нема')).toBe(false);
    expect(isCancelSelectionValid('no_money', 'нема пари')).toBe(true);
    expect(isCancelSelectionValid(null, 'нема пари')).toBe(false);
    expect(isTrashSelectionValid('wrong_number', '   ')).toBe(false);
    expect(isTrashSelectionValid('wrong_number', 'друг човек')).toBe(true);
  });
});
