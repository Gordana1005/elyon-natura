import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { trashReasonLabel } from '@/lib/trashReasons';
import { cleanNoteForDisplay } from '@/lib/notes';

// The next operator on a customer sees the PREVIOUS cancel and trash — the coded reason,
// the note the colleague wrote and who decided (plan 01.10.2026, "Фаза 1"). Read from
// GET /customers/:phone/history, which since then carries trash_reason / trash_reason_notes
// / trashed_at and, for cancelled / trashed orders, decided_by_name + decided_auto
// (public.order_operators, supabase/functions/api/dispositionNote.ts decisionMeta).

/** The fields of a customer-history order this module reads. */
export interface HistoryOrderLike {
  id: string;
  display_id?: string | null;
  status?: string | null;
  created_at?: string | null;
  cancellation_reason?: string | null;
  cancellation_reason_notes?: string | null;
  cancelled_at?: string | null;
  trash_reason?: string | null;
  trash_reason_notes?: string | null;
  trashed_at?: string | null;
  decided_by_name?: string | null;
  decided_auto?: boolean | null;
}

export interface PriorDecision {
  kind: 'cancel' | 'trash';
  orderId: string;
  displayId: string | null;
  /** When it was decided (cancelled_at / trashed_at, else the order's creation). */
  at: string | null;
  /** The coded reason, translated — null when there is none, or the note already starts with it. */
  reasonLabel: string | null;
  /** What the colleague wrote, cleaned for display — null when nothing. */
  note: string | null;
  /** Who decided — null when unknown. */
  by: string | null;
  /** An automatic rule decided (the no-parcel cancel, the 9-no-answers auto-trash). */
  auto: boolean;
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

const cleanNote = (raw: string | null | undefined): string | null => {
  const s = cleanNoteForDisplay(raw || '').replace(/\s+/g, ' ').trim();
  return s || null;
};

function decisionOf(o: HistoryOrderLike, kind: 'cancel' | 'trash'): PriorDecision {
  const code = kind === 'cancel' ? o.cancellation_reason : o.trash_reason;
  let reasonLabel = code ? (kind === 'cancel' ? cancelReasonLabel(code) : trashReasonLabel(code)) : null;
  const note = cleanNote(kind === 'cancel' ? o.cancellation_reason_notes : o.trash_reason_notes);
  // The imported AlterCPA history writes "<disposition> — <comment>" into the note (orderReasonText).
  if (reasonLabel && note && note.toLowerCase().startsWith(reasonLabel.toLowerCase())) reasonLabel = null;
  return {
    kind,
    orderId: o.id,
    displayId: o.display_id ?? null,
    at: (kind === 'cancel' ? o.cancelled_at : o.trashed_at) ?? o.created_at ?? null,
    reasonLabel,
    note,
    by: o.decided_by_name?.trim() || null,
    auto: o.decided_auto === true,
  };
}

function latest(list: PriorDecision[]): PriorDecision | undefined {
  return list.reduce<PriorDecision | undefined>((best, d) => (!best || ms(d.at) > ms(best.at) ? d : best), undefined);
}

/**
 * The latest cancel and the latest trash among the customer's orders (each by its own
 * decision time). A trash for `duplicate_order` is housekeeping (engine v3.7-mk — the
 * same customer arrived twice), not something the customer did, so it is skipped.
 */
export function priorDecisions(orders: HistoryOrderLike[] | null | undefined): { cancel?: PriorDecision; trash?: PriorDecision } {
  const list = orders ?? [];
  const cancel = latest(list.filter((o) => o.status === 'cancelled').map((o) => decisionOf(o, 'cancel')));
  const trash = latest(list
    .filter((o) => o.status === 'trashed' && o.trash_reason !== 'duplicate_order')
    .map((o) => decisionOf(o, 'trash')));
  return { ...(cancel ? { cancel } : {}), ...(trash ? { trash } : {}) };
}

/** The fields of a customer-history call this module reads. */
export interface HistoryCallLike {
  outcome: string;
  context_type?: string | null;
  context_id?: string | null;
}

/**
 * The reason behind a cancel / trash / wrong-number call row, read off the order it was
 * logged against (when that order is in the same payload) — the call row itself carries
 * no reason column. null for any other call.
 */
export function callReasonFor(call: HistoryCallLike, ordersById: Map<string, HistoryOrderLike>): string | null {
  if (!['cancelled', 'trash', 'wrong_number'].includes(call.outcome)) return null;
  if (call.context_type !== 'order' || !call.context_id) return null;
  const o = ordersById.get(call.context_id);
  if (!o) return null;
  if (call.outcome === 'cancelled') return o.cancellation_reason ? cancelReasonLabel(o.cancellation_reason) : null;
  return o.trash_reason ? trashReasonLabel(o.trash_reason) : null;
}
