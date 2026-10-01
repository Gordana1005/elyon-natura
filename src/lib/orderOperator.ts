import type { TFunction } from 'i18next';

/**
 * The "Оператор" of an order (owner 01.10.2026): WHO PRODUCED ITS CURRENT STATUS, whatever the status
 * is — the seller of a sale, the agent who cancelled / trashed / set a call-again, the AlterCPA operator
 * who decided a lead. The api computes it (order_operators, 20260943002000) and sends
 * operator_name / operator_basis / operator_auto with every /orders and search row:
 *
 *   sale      a sale status → the seller (sold_* stamp, else the confirmer)
 *   history   the person in order_history who moved the order into its current status
 *   assigned  the agent the order is assigned to (orders from before order_history, 01.08.2026)
 *   altercpa  the AlterCPA operator: who decided the lead in their panel, or holds its callback
 *   auto      the status itself came from an automatic rule (no-parcel, a repair) — the name is the
 *             person behind the lead, not someone who pressed "cancel"
 *
 * Display only. A row from an api that does not send operator_* yet (a deploy in flight) falls back
 * to what the column showed before: the seller on a sale, the assignee otherwise.
 */
export type OperatorBasis = 'sale' | 'history' | 'assigned' | 'altercpa';

export interface OrderOperator {
  name: string | null;
  basis: OperatorBasis | null;
  auto: boolean;
}

export interface OperatorFields {
  status?: string | null;
  operator_name?: string | null;
  operator_basis?: string | null;
  operator_auto?: boolean | null;
  seller_name?: string | null;
  confirmed_by_name?: string | null;
  assigned_agent_name?: string | null;
}

/** The sale statuses (packed is a substate of confirmed) — their operator is the seller. */
export const OPERATOR_SALE_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);

const BASES: readonly OperatorBasis[] = ['sale', 'history', 'assigned', 'altercpa'];

export function operatorOf(o: OperatorFields): OrderOperator {
  if (o.operator_name !== undefined || o.operator_basis !== undefined) {
    const name = o.operator_name?.trim() || null;
    const basis = BASES.includes(o.operator_basis as OperatorBasis) ? (o.operator_basis as OperatorBasis) : null;
    return { name, basis: name ? basis : null, auto: !!name && o.operator_auto === true };
  }
  // An older api: the seller on a sale, the assignee otherwise.
  if (o.status && OPERATOR_SALE_STATUSES.has(o.status)) {
    const name = o.seller_name || o.confirmed_by_name || null;
    return { name, basis: name ? 'sale' : null, auto: false };
  }
  const name = o.assigned_agent_name?.trim() || null;
  return { name, basis: name ? 'assigned' : null, auto: false };
}

/** The hover text: how the name was decided ("Откажана — поставено во CRM"), plus the automatic note. */
export function operatorTitle(t: TFunction, op: OrderOperator, statusText: string): string | undefined {
  if (!op.name || !op.basis) return undefined;
  const base = t(`ordersList.operator.basis.${op.basis}`, { status: statusText });
  return op.auto ? `${base} · ${t('ordersList.operator.autoTitle')}` : base;
}
