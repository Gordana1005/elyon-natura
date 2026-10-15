/**
 * /orders — the status filter (owner, Mile, 15.10.2026: "Status is status").
 *
 * ONE pick over every order status, plus the MEX parcel parts of the only two
 * statuses where MEX adds anything — the Overview cohort's own parts:
 *
 *   Потврдена  ↳ Во магацин за пакување (no parcel yet) · ↳ Спакувано (MEX 8, the label)
 *   Испратена  ↳ Кај курирот (MEX 1 · 4 · 10)           · ↳ Проблем кај курирот (MEX 3 · 9 · 13)
 *
 * Everywhere else MEX repeats the status (paid = MEX 2, returned = MEX 7). MEX 13
 * "Одбиена" is not a return yet: the customer refused, the parcel is on its way
 * back and becomes MEX 7 → Вратена when MEX books it.
 *
 * The keys are the api's (supabase/functions/api/ordersList.ts STATE_KEYS, the
 * `state=` param). A parent covers its children; a child narrows. The quick-view
 * strip (Сите · Нарачки · Отворени лидови · Откажани · Корпа · Вратени) is a
 * pick too. Pure (no React): statusModel.test.ts.
 */

import type { TFunction } from 'i18next';
import { statusLabel } from '@/types';

export const STATE_KEYS = [
  'pending', 'take', 'call_again', 'duplicated',
  'confirmed', 'confirmed.no_parcel', 'confirmed.packed',
  'shipped', 'shipped.courier', 'shipped.problem',
  'delivered', 'paid', 'returned', 'cancelled', 'trashed',
] as const;
export type StateKey = (typeof STATE_KEYS)[number];

/** The sale statuses (the api's SALE_STATUSES) and the open-lead statuses (LEAD_STATUSES). */
export const SALE_STATES: StateKey[] = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];
export const LEAD_STATES: StateKey[] = ['pending', 'take', 'call_again', 'duplicated'];

export const CHILDREN: Partial<Record<StateKey, StateKey[]>> = {
  confirmed: ['confirmed.no_parcel', 'confirmed.packed'],
  shipped: ['shipped.courier', 'shipped.problem'],
};

/** The order status a key belongs to ('confirmed.packed' → 'confirmed'). */
export const statusOfState = (k: string): string => k.split('.')[0];
/** The parent of a sub-state, else null. */
export const parentOf = (k: StateKey): StateKey | null => (k.includes('.') ? (statusOfState(k) as StateKey) : null);
/** 'confirmed.packed' → 'packed'. */
export const subPartOf = (k: StateKey): string | null => (k.includes('.') ? k.split('.')[1] : null);

/** The pick in list order, unknown keys dropped, a child dropped when its parent is picked (the api's twin). */
export function normalizeStates(states: readonly string[]): StateKey[] {
  const set = new Set(states);
  return STATE_KEYS.filter((k) => set.has(k) && !(k.includes('.') && set.has(statusOfState(k))));
}

/** Is the key ticked — itself, or covered by its picked parent? */
export function isPicked(states: readonly StateKey[], key: StateKey): boolean {
  const p = parentOf(key);
  return states.includes(key) || (p != null && states.includes(p));
}

/**
 * One click on a row of the panel. A parent toggles (and takes its children with it). A child of a
 * picked parent is "un-ticked" by keeping the parent's OTHER children; any other child toggles.
 */
export function toggleState(states: readonly StateKey[], key: StateKey): StateKey[] {
  const set = new Set(normalizeStates(states));
  const parent = parentOf(key);
  if (!parent) {
    if (set.has(key)) set.delete(key);
    else { set.add(key); for (const c of CHILDREN[key] ?? []) set.delete(c); }
  } else if (set.has(parent)) {
    set.delete(parent);
    for (const c of CHILDREN[parent] ?? []) if (c !== key) set.add(c);
  } else if (set.has(key)) {
    set.delete(key);
  } else {
    set.add(key);
  }
  return normalizeStates([...set]);
}

// ── the quick views (the segmented strip) ───────────────────────────────────

export const QUICK_VIEWS = ['all', 'orders', 'leads', 'cancelled', 'trashed', 'returned'] as const;
export type QuickView = (typeof QUICK_VIEWS)[number];
export const QUICK_VIEW_STATES: Record<QuickView, StateKey[]> = {
  all: [],
  orders: SALE_STATES,
  leads: LEAD_STATES,
  cancelled: ['cancelled'],
  trashed: ['trashed'],
  returned: ['returned'],
};

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The quick view a pick equals, else null (a custom pick from the panel). */
export function quickViewOf(states: readonly StateKey[]): QuickView | null {
  const n = normalizeStates(states);
  return QUICK_VIEWS.find((v) => sameSet(normalizeStates(QUICK_VIEW_STATES[v]), n)) ?? null;
}

/** The old status chips (?view=, links from before 15.10.2026) → the pick they meant. */
export const LEGACY_VIEW_STATES: Record<'orders' | 'leads' | 'cancelled' | 'trashed' | 'all', StateKey[]> = {
  orders: SALE_STATES, leads: LEAD_STATES, cancelled: ['cancelled'], trashed: ['trashed'], all: [],
};

// ── the panel's rows ────────────────────────────────────────────────────────

export interface StatusRow {
  key: StateKey;
  /** 0 = a status (its coloured pill), 1 = a MEX part of the status above. */
  depth: 0 | 1;
  /** No such order exists in MK today (take, delivered): shown only once it has a count or is picked. */
  rare?: boolean;
}

export const STATUS_ROWS: StatusRow[] = [
  { key: 'pending', depth: 0 },
  { key: 'take', depth: 0, rare: true },
  { key: 'call_again', depth: 0 },
  { key: 'duplicated', depth: 0 },
  { key: 'confirmed', depth: 0 },
  { key: 'confirmed.no_parcel', depth: 1 },
  { key: 'confirmed.packed', depth: 1 },
  { key: 'shipped', depth: 0 },
  { key: 'shipped.courier', depth: 1 },
  { key: 'shipped.problem', depth: 1 },
  { key: 'delivered', depth: 0, rare: true },
  { key: 'paid', depth: 0 },
  { key: 'returned', depth: 0 },
  { key: 'cancelled', depth: 0 },
  { key: 'trashed', depth: 0 },
];

/** The rows to show: a rare status only with orders behind it, or when it is picked. */
export function visibleStatusRows(states: readonly StateKey[], counts: Partial<Record<StateKey, number | null>> | undefined): StatusRow[] {
  return STATUS_ROWS.filter((r) => !r.rare || isPicked(states, r.key) || (counts?.[r.key] ?? 0) > 0);
}

/**
 * The collabBox bookings belong beside the list when it can hold a sale with no parcel yet: no status
 * picked, or the pick includes Потврдена / Во магацин за пакување (a booking is that, before MEX).
 */
export function pickHoldsBookings(states: readonly StateKey[]): boolean {
  const n = normalizeStates(states);
  return n.length === 0 || n.includes('confirmed') || n.includes('confirmed.no_parcel');
}

// ── labels ──────────────────────────────────────────────────────────────────

/** One key of the status pick: "Платена", or "Потврдена · Во магацин за пакување". */
export function stateLabel(t: TFunction, key: StateKey): string {
  const part = subPartOf(key);
  if (!part) return statusLabel(key);
  return `${statusLabel(parentOf(key)!)} · ${t(`ordersList.status.sub.${part}`)}`;
}

/** The whole pick in a few words (the export summary). */
export function statusPickLabel(t: TFunction, states: readonly StateKey[]): string {
  const quick = quickViewOf(states);
  if (quick === 'all') return t('ordersList.status.all');
  if (quick) return t(`ordersList.quick.${quick}`);
  if (states.length === 1) return stateLabel(t, states[0]);
  return t('ordersList.status.n', { count: states.length });
}
