import type { TrashReason } from '@/lib/api';
import i18n from '@/i18n';

// Single source of truth for the trash reasons agents pick from. Used by ALL
// three input surfaces — the /calls outcome bar (OutcomeBar), the order
// editor (OrderModal) and the create-order modal (CreateOrderModal) — so the
// list and its order can never drift between them. Mirrors
// src/lib/cancellationReasons.ts exactly; keep the two in step.
//
// `value` is what travels onto orders.trash_reason (constrained by the DB check
// orders_trash_reason_check + the three zod enums in
// supabase/functions/api/index.ts — keep all three in sync). Display labels live
// in src/i18n/locales/*.json under "trashReason.*", so build options at render
// time via getTrashReasonOptions() — never at module level — and make sure the
// rendering component calls useTranslation() to re-render on switch.
//
// WHY THE REASON MATTERS (engine v3.7 — sticky trash, 2026-08-06). Picking a
// reason is not paperwork: it decides whether the customer is ever called from a
// prediction list again.
//   • wrong_number / wrong_person / rude / uncooperative / other → PERMANENT.
//     Removed from every calling band and held in the Trash List. The ONLY way
//     back is a genuine purchase — a paid order dated after the trash releases
//     them, because paying proves the number is good.
//   • not_reachable → parked 21 days from orders.trashed_at, then auto-released.
//   • duplicate_order → not a trash of the customer at all; see below.
// Prediction lists ONLY. A trashed phone that sends a brand-new lead still
// arrives as a normal pending order and is callable in the Pendings queue.
export const TRASH_REASON_VALUES: TrashReason[] = [
  'wrong_number',
  'wrong_person',
  // Also the server-only auto-trash reason (9 consecutive no-answers). Exposed
  // here so an agent can trash a client as Unreachable by hand; the engine
  // treats a manual not_reachable exactly like the auto path (removed from
  // every calling band, parked in the Trash List). It is the ONE reason that
  // expires on its own — 21 days from orders.trashed_at, then the nightly
  // recompute releases them back into their normal band.
  'not_reachable',
  'rude',
  'uncooperative',
  // Lead de-duplication: the same customer arrived twice (affiliate/webhook
  // intake). Deliberately NOT a dead-number reason — the customer stays in
  // their normal calling band — and engine v3.7 keeps them out of the Trash
  // List entirely, because this is housekeeping, not customer behaviour.
  // (Distinct from the status='duplicated' feature, which is an admin copying
  // an existing order.)
  'duplicate_order',
  // Catch-all, always last: when the real reason isn't above the agent picks
  // 'other' and the free-text note carries it (see trashReasonRequiresNote).
  'other',
];

// Label for DISPLAY (pickers, Trash List Reason column, order history panels).
// Unknown/legacy values render as-is.
export const trashReasonLabel = (value: string): string =>
  i18n.t(`trashReason.${value}`, { defaultValue: value });

export const getTrashReasonOptions = (): { value: TrashReason; label: string }[] =>
  TRASH_REASON_VALUES.map(value => ({ value, label: trashReasonLabel(value) }));

// 'other' is a catch-all — the free-text note carries the real reason, so the
// note is mandatory for this value only; every other reason keeps it optional.
export const trashReasonRequiresNote = (v: TrashReason | null): boolean => v === 'other';

// A trash selection is complete only when a reason is chosen and, for 'other',
// a non-empty note explains it. Reused by every trash save-gate so the rule
// can't drift between the three pickers.
export const isTrashSelectionValid = (v: TrashReason | null, notes: string): boolean =>
  !!v && (!trashReasonRequiresNote(v) || notes.trim().length > 0);
