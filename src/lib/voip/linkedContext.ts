import type { LinkedContext } from '@/contexts/VoipContext';

/**
 * The order a call is about, from the customer's history (GET customers/:phone/history → orders).
 * Only ACTIONABLE orders are linked — pending / take / call_again / confirmed, newest first within the
 * priority. Paid, shipped, returned, cancelled, trashed are NEVER linked: a call to such a customer is almost
 * always a prediction-list RE-SALE, where "Confirmed" must create a NEW order, not mutate a closed one (which
 * throws "cannot move paid → confirmed"). No actionable order → null → the call logs as standalone and the
 * Confirmed → Create Order flow opens a fresh order. Shared by /calls (the dial) and the inbound answer
 * (05.11.2026: an answered Teleshop call looks the customer up the same way).
 */
export function pickLinkedContext(orders: any[] | null | undefined): LinkedContext | null {
  if (!orders || orders.length === 0) return null;
  const priority = ['pending', 'take', 'call_again', 'confirmed'];
  const actionable = orders.filter((o) => priority.includes(o.status));
  if (actionable.length === 0) return null;
  const sorted = [...actionable].sort((a, b) => {
    const ai = priority.indexOf(a.status);
    const bi = priority.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  const top = sorted[0];
  return { type: 'order', id: top.id, display_id: top.display_id };
}
