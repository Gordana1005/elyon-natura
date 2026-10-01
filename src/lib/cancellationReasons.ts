import type { CancellationReason } from '@/lib/api';
import i18n from '@/i18n';
import { isDispositionNoteValid } from '@/lib/dispositionNote';

// Single source of truth for the cancellation reasons agents pick from.
// Used by BOTH input pickers — the order/call modal (CancellationReasonPicker)
// and the in-call widget (ActiveCallWidget) — so the list and its order can
// never drift between them again. The order here is the order operators see.
//
// `value` is what travels onto orders.cancellation_reason (constrained by the
// DB check + the zod enum in supabase/functions/api/index.ts — keep all three
// in sync). Display labels live in src/i18n/locales/*.json under
// "cancelReason.*" (active + retired reasons), so build options at render
// time via getCancelReasonOptions() — never at module level — and make sure
// the rendering component calls useTranslation() to re-render on switch.
export const CANCEL_REASON_VALUES: CancellationReason[] = [
  'not_satisfied',
  'price_too_high',
  'still_using_product',
  'changed_mind',
  'no_money',
  'not_interested',
  'bought_elsewhere',
  'will_call_back',
  // Catch-all, always last: when the real reason isn't above the agent picks
  // 'other' and the free-text note carries it.
  'other',
];

// Label for DISPLAY (pickers, history tabs, synthetic records). Covers the
// active values above plus retired reasons (family_refused, wrong_product,
// duplicate_order) that still exist on historical orders, and the SYSTEM-ONLY
// no_parcel_7d ("AlterCPA-confirmed, no MEX parcel within 7 days" — written by
// a cron, 2026-09-27). no_parcel_7d must never join CANCEL_REASON_VALUES: it
// is not an agent's choice, and the server refuses any request assigning it.
// Unknown values render as-is.
export const cancelReasonLabel = (value: string): string =>
  i18n.t(`cancelReason.${value}`, { defaultValue: value });

export const getCancelReasonOptions = (): { value: CancellationReason; label: string }[] =>
  CANCEL_REASON_VALUES.map(value => ({ value, label: cancelReasonLabel(value) }));

// Every cancel a person makes carries a written note of at least 5 characters
// (owner 01.10.2026, src/lib/dispositionNote.ts) — the next operator reads WHY.
// Before that only the catch-all 'other' needed one. Kept as a function so the
// pickers ask one place.
export const cancelReasonRequiresNote = (_v: CancellationReason | null): boolean => true;

// A cancellation selection is complete only when a reason is chosen AND the note
// is long enough. Reused by every cancel save-gate (the /calls outcome bar, the
// order / create-order modals, the Orders bulk dialog) so the rule can't drift.
export const isCancelSelectionValid = (v: CancellationReason | null, notes: string): boolean =>
  !!v && isDispositionNoteValid(notes);
