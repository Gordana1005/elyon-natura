/**
 * /orders (Нарачки) — the list's state, kept in the URL (Phase 11 A).
 *
 *   ?search=…            name / order no. / product; a phone matches by its last 8 digits
 *   ?view=orders|leads|cancelled|trashed|all      the status chips (default: orders)
 *   ?range=today|week|month|year|all|custom (+ from=YYYY-MM-DD&to=…)   Skopje days (default: week)
 *   ?dept=a,b            the six departments (cohort_order_source keys)
 *   ?seller=<uuid>       sales_people.id — who is credited with the sale
 *   ?mex=a,b             MEX groups: at_mex · courier · delivered · returned · rejected · no_parcel
 *   ?source=a,b          altercpa · import · manual (the only source_type values in MK)
 *   ?agent=<uuid>|none   the assigned agent
 *   ?mine=1|0            "my orders" (agents: always on)
 *   ?pmin / ?pmax        price, денари
 *   ?wm / ?offer / ?stream   CPA provenance (admin / manager)
 *   ?page=N
 *
 * An Insights drill-down (?cohort_bucket=…&sold_from=… etc., ORDERS_DRILL_KEYS)
 * and a ?search= link define their own set: with either, the chips default to
 * "Сите" and the period to "all dates", so the link lists exactly what it
 * promised. An explicit chip or period in the URL always wins.
 *
 * Pure (no React): listParams.test.ts covers it.
 */
import { ORDERS_DRILL_KEYS } from '@/lib/api';
import { addDays, isYmd, MAX_SPAN_DAYS, presetRange, type DayRange } from '@/components/insights/shared/period';
import { denToEur } from '@/lib/currency';

export const LIST_VIEWS = ['orders', 'leads', 'cancelled', 'trashed', 'all'] as const;
export type ListView = (typeof LIST_VIEWS)[number];

export const LIST_RANGES = ['today', 'week', 'month', 'year', 'all', 'custom'] as const;
export type ListRange = (typeof LIST_RANGES)[number];

/** The six departments, in the owner's order (insights/overview/palette SOURCE_ORDER). */
export const LIST_DEPARTMENTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'] as const;

/** MEX parcel groups (the api's ordersList.ts MEX_GROUPS). */
export const MEX_GROUP_KEYS = ['at_mex', 'courier', 'delivered', 'returned', 'rejected', 'no_parcel'] as const;
export type MexGroupKey = (typeof MEX_GROUP_KEYS)[number];
export const MEX_GROUP_IDS: Record<Exclude<MexGroupKey, 'no_parcel'>, number[]> = {
  at_mex: [8], courier: [1, 3, 4, 9, 10], delivered: [2], returned: [7], rejected: [13],
};

/** The source_type values that exist in MK. */
export const LIST_SOURCES = ['altercpa', 'import', 'manual'] as const;

export interface OrdersListState {
  search: string;
  /** null = not in the URL → the default (see effectiveView). */
  view: ListView | null;
  range: ListRange | null;
  from: string | null;
  to: string | null;
  depts: string[];
  seller: string | null;
  mex: MexGroupKey[];
  sources: string[];
  /** uuid | 'none' */
  agent: string | null;
  /** null = not in the URL → agents on, everyone else off. */
  mine: boolean | null;
  /** денари */
  priceMin: number | null;
  priceMax: number | null;
  wm: string | null;
  offer: string | null;
  stream: string | null;
  page: number;
}

/** Every URL key the list owns (the drill keys are the Insights links'). */
export const LIST_PARAM_KEYS = [
  'search', 'view', 'range', 'from', 'to', 'dept', 'seller', 'mex', 'source', 'agent', 'mine',
  'pmin', 'pmax', 'wm', 'offer', 'stream', 'page',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const csvOf = <T extends string>(raw: string | null, allowed: readonly T[]): T[] =>
  [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s)))];
const oneOf = <T extends string>(raw: string | null, allowed: readonly T[]): T | null =>
  raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
const posInt = (raw: string | null): number | null => {
  if (raw == null || !/^\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw);
};
const text = (raw: string | null, max = 60): string | null => {
  const s = (raw ?? '').trim();
  return s && s.length <= max && ![...s].some((ch) => ch.charCodeAt(0) < 32) ? s : null;
};

/** The list's state out of the URL. Anything unreadable is simply left out. */
export function readListParams(sp: URLSearchParams): OrdersListState {
  const from = sp.get('from');
  const to = sp.get('to');
  let range = oneOf(sp.get('range'), LIST_RANGES);
  // a from/to pair without a preset (a link from elsewhere) is a custom period
  if (!range && isYmd(from) && isYmd(to)) range = 'custom';
  const agent = sp.get('agent');
  const seller = sp.get('seller');
  const mine = sp.get('mine');
  return {
    search: sp.get('search') ?? '',
    view: oneOf(sp.get('view'), LIST_VIEWS),
    range,
    from: isYmd(from) ? from : null,
    to: isYmd(to) ? to : null,
    depts: csvOf(sp.get('dept'), LIST_DEPARTMENTS),
    seller: seller && UUID_RE.test(seller) ? seller : null,
    mex: csvOf(sp.get('mex'), MEX_GROUP_KEYS),
    sources: csvOf(sp.get('source'), LIST_SOURCES),
    agent: agent === 'none' || (agent && UUID_RE.test(agent)) ? agent : null,
    mine: mine === '1' ? true : mine === '0' ? false : null,
    priceMin: posInt(sp.get('pmin')),
    priceMax: posInt(sp.get('pmax')),
    wm: text(sp.get('wm')),
    offer: text(sp.get('offer')),
    stream: text(sp.get('stream'), 120),
    page: Math.max(1, posInt(sp.get('page')) ?? 1),
  };
}

export type ListPatch = Partial<Omit<OrdersListState, 'page'>> & { page?: number };

/**
 * Writes a change back, keeping every other param (a drill, the label). Empty
 * values leave the URL; any filter change sends the list back to page 1.
 */
export function writeListParams(sp: URLSearchParams, patch: ListPatch): URLSearchParams {
  const out = new URLSearchParams(sp);
  const set = (k: string, v: string | null | undefined) => (v ? out.set(k, v) : out.delete(k));
  const has = (k: keyof ListPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('search')) set('search', (patch.search ?? '').trim() ? patch.search! : null);
  if (has('view')) set('view', patch.view ?? null);
  if (has('range')) {
    set('range', patch.range ?? null);
    if (patch.range !== 'custom') { out.delete('from'); out.delete('to'); }
  }
  if (has('from')) set('from', patch.from ?? null);
  if (has('to')) set('to', patch.to ?? null);
  if (has('depts')) set('dept', patch.depts?.length ? patch.depts.join(',') : null);
  if (has('seller')) set('seller', patch.seller ?? null);
  if (has('mex')) set('mex', patch.mex?.length ? patch.mex.join(',') : null);
  if (has('sources')) set('source', patch.sources?.length ? patch.sources.join(',') : null);
  if (has('agent')) set('agent', patch.agent ?? null);
  if (has('mine')) set('mine', patch.mine == null ? null : patch.mine ? '1' : '0');
  if (has('priceMin')) set('pmin', patch.priceMin != null ? String(patch.priceMin) : null);
  if (has('priceMax')) set('pmax', patch.priceMax != null ? String(patch.priceMax) : null);
  if (has('wm')) set('wm', patch.wm ?? null);
  if (has('offer')) set('offer', patch.offer ?? null);
  if (has('stream')) set('stream', patch.stream ?? null);
  if (has('page')) set('page', patch.page && patch.page > 1 ? String(patch.page) : null);
  else out.delete('page');
  return out;
}

/** Removes every list filter AND the drill (the "Исчисти" button). */
export function clearListParams(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(sp);
  for (const k of [...LIST_PARAM_KEYS, ...ORDERS_DRILL_KEYS, 'lbl']) out.delete(k);
  return out;
}

/** Removes only the drill (its banner's ✕); the list's own filters stay. */
export function clearDrillParams(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(sp);
  for (const k of [...ORDERS_DRILL_KEYS, 'lbl']) out.delete(k);
  out.delete('page');
  return out;
}

export interface ListContext {
  /** An Insights drill-down is in the URL. */
  drill: boolean;
}

/** A link that defines its own set (a drill, a search) lists every status. */
const opensEverything = (s: OrdersListState, ctx: ListContext) => ctx.drill || s.search.trim() !== '';

export function effectiveView(s: OrdersListState, ctx: ListContext): ListView {
  return s.view ?? (opensEverything(s, ctx) ? 'all' : 'orders');
}

/** The period the list is showing: a preset and its Skopje days (null = all dates). */
export function effectiveRange(s: OrdersListState, today: string, ctx: ListContext): { preset: ListRange; days: DayRange | null } {
  const preset: ListRange = s.range ?? (opensEverything(s, ctx) ? 'all' : 'week');
  if (preset === 'all') return { preset, days: null };
  if (preset === 'custom') {
    // an open end is allowed here (from only / to only), unlike the Insights period
    if (s.from && !s.to) return { preset, days: { from: s.from, to: today } };
    if (!s.from && s.to) return { preset, days: { from: addDays(s.to, -MAX_SPAN_DAYS), to: s.to } };
  }
  return { preset, days: presetRange(preset, today, { from: s.from ?? undefined, to: s.to ?? undefined }) };
}

/** "My orders" as it applies: agents always, everyone else when switched on. */
export const effectiveMine = (s: OrdersListState, isAgent: boolean) => isAgent || s.mine === true;

/** How many filters are set beyond the defaults (the phone "Филтри" badge). */
export function activeFilterCount(s: OrdersListState, isAgent: boolean): number {
  return [
    s.range != null, s.depts.length > 0, !!s.seller, s.mex.length > 0, s.sources.length > 0, !!s.agent,
    !isAgent && s.mine === true, s.priceMin != null || s.priceMax != null, !!s.wm, !!s.offer, !!s.stream,
  ].filter(Boolean).length;
}

export interface ApiListParams {
  view: ListView;
  search?: string;
  day_from?: string;
  day_to?: string;
  dept?: string;
  seller?: string;
  mex?: string;
  source?: string;
  agent_id?: string;
  price_min?: number;
  price_max?: number;
  cpa_webmaster?: string;
  cpa_offer?: string;
  cpa_stream?: string;
}

/**
 * The GET /orders parameters for the list (the page, the chip counts and the
 * "Export view" all send exactly these). Prices go to the api in EUR — orders
 * are stored in EUR; the operator types denari.
 */
export function toApiParams(
  s: OrdersListState,
  ctx: ListContext & { today: string; isAgent: boolean; userId?: string | null },
): ApiListParams {
  const { days } = effectiveRange(s, ctx.today, ctx);
  const search = s.search.trim();
  // An agent's search is global (RLS still decides what they may see); otherwise
  // "my orders" wins over the agent picker.
  const mine = effectiveMine(s, ctx.isAgent) && !(ctx.isAgent && search);
  const agent = mine && ctx.userId ? ctx.userId : s.agent ?? undefined;
  return {
    view: effectiveView(s, ctx),
    ...(search ? { search } : {}),
    ...(days ? { day_from: days.from, day_to: days.to } : {}),
    ...(s.depts.length ? { dept: s.depts.join(',') } : {}),
    ...(s.seller ? { seller: s.seller } : {}),
    ...(s.mex.length ? { mex: s.mex.join(',') } : {}),
    ...(s.sources.length ? { source: s.sources.join(',') } : {}),
    ...(agent ? { agent_id: agent } : {}),
    ...(s.priceMin != null ? { price_min: denToEur(s.priceMin) } : {}),
    ...(s.priceMax != null ? { price_max: denToEur(s.priceMax) } : {}),
    ...(s.wm ? { cpa_webmaster: s.wm } : {}),
    ...(s.offer ? { cpa_offer: s.offer } : {}),
    ...(s.stream ? { cpa_stream: s.stream } : {}),
  };
}

/** The api's phoneLast8 twin (ordersList.ts): the last 8 digits of something
 *  that looks like a phone (8–15 digits, any spacing), else null. */
export function phoneLast8(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || !/^\+?[\d\s\-./()]+$/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d.slice(-8) : null;
}

/** The MEX group of a parcel status (the badge + the filter). */
export function mexGroupOf(statusId: number | null | undefined, trackingId: string | null | undefined): MexGroupKey | null {
  if (!trackingId) return 'no_parcel';
  for (const [g, ids] of Object.entries(MEX_GROUP_IDS)) if (ids.includes(Number(statusId))) return g as MexGroupKey;
  return null;
}
