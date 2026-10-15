/**
 * The Web page (naturatherapy.mk, owner 15.10.2026; migrations 20261016130000 / 0100). The pure
 * half of GET /api/web/page and /api/web/customers: number coercion, the ad metrics (ROAS, paid
 * ROAS, cost per order, CPC, CTR) and the money wall — the page is for revenue viewers
 * (can_see_revenue), the ad SPEND and everything derived from it only for margin viewers
 * (can_see_margins: super_admin / owner / finance). Without margins the spend keys are ABSENT.
 * Dependency-free (Deno + Vitest + the browser bundle share it).
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** a ÷ b, or null when b is 0 (no spend = no ROAS, never ∞). */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export interface WebOutcome {
  orders: number;
  value_mkd: number;
  paid: number;
  paid_mkd: number;
  returned: number;
  returned_mkd: number;
}

export interface WebChannelRow extends WebOutcome {
  channel: string;
  source: string;
}

export interface WebSpend {
  spend_mkd: number;
  spend_other_mkd: number;
  impressions: number;
  link_clicks: number;
  meta_purchases: number;
  /** sales value ÷ spend */
  roas: number | null;
  /** what MEX paid ÷ spend */
  paid_roas: number | null;
  cost_per_order: number | null;
}

export interface WebCampaign extends WebOutcome, Partial<WebSpend> {
  id: string | null;
  name: string | null;
  status: string | null;
}

export interface WebAds extends WebSpend {
  currency: string | null;
  synced_at: string | null;
  cpc: number | null;
  /** link clicks ÷ impressions */
  ctr: number | null;
}

export interface WebDay {
  d: string;
  orders: number;
  value_mkd: number;
  paid_social_mkd: number;
  spend_mkd?: number;
}

export interface WebPage {
  from: string;
  to: string;
  /** Spend counts from here (the later of the period start and the floor day). */
  spend_from: string;
  floor_day: string;
  total: WebOutcome & { no_order: number };
  channels: WebChannelRow[];
  paid_social: WebOutcome & { no_campaign: number };
  /** null without margins. */
  ads: WebAds | null;
  campaigns: WebCampaign[];
  daily: WebDay[];
  coupons: { code: string; orders: number; value_mkd: number }[];
  cities: { city: string; orders: number; value_mkd: number; returned: number }[];
  payment: { method: string; orders: number; value_mkd: number; returned: number }[];
  products: { name: string; qty: number; value_mkd: number; orders: number }[];
  lost: { cancelled: { orders: number; value_mkd: number }; card_unpaid: { orders: number; value_mkd: number } };
  access: { margins: boolean };
}

const outcome = (r: Record<string, unknown>): WebOutcome => ({
  orders: num(r.orders), value_mkd: num(r.value_mkd), paid: num(r.paid), paid_mkd: num(r.paid_mkd),
  returned: num(r.returned), returned_mkd: num(r.returned_mkd),
});

function spendOf(r: Record<string, unknown>, o: WebOutcome): WebSpend {
  const spend = num(r.spend_mkd);
  return {
    spend_mkd: spend, spend_other_mkd: num(r.spend_other_mkd), impressions: num(r.impressions),
    link_clicks: num(r.link_clicks), meta_purchases: num(r.meta_purchases),
    roas: ratio(o.value_mkd, spend), paid_roas: ratio(o.paid_mkd, spend), cost_per_order: o.orders > 0 && spend > 0 ? spend / o.orders : null,
  };
}

/** web_page() → the page; the spend (and its ratios) only with `margins`. */
export function shapeWebPage(rpc: unknown, margins: boolean): WebPage {
  const r = isObj(rpc) ? rpc : {};
  const total = isObj(r.total) ? r.total : {};
  const ps = isObj(r.paid_social) ? r.paid_social : {};
  const psOutcome = outcome(ps);
  const adsRaw = isObj(r.ads) ? r.ads : {};
  const lost = isObj(r.lost) ? r.lost : {};
  const lostOf = (k: string) => { const x = isObj(lost[k]) ? lost[k] as Record<string, unknown> : {}; return { orders: num(x.orders), value_mkd: num(x.value_mkd) }; };

  let ads: WebAds | null = null;
  if (margins) {
    const s = spendOf(adsRaw, psOutcome);
    ads = {
      ...s, currency: str(adsRaw.currency), synced_at: str(adsRaw.synced_at),
      cpc: ratio(s.spend_mkd, s.link_clicks), ctr: ratio(s.link_clicks, s.impressions),
    };
  }

  return {
    from: String(r.from ?? ""), to: String(r.to ?? ""),
    spend_from: String(r.spend_from ?? ""), floor_day: String(r.floor_day ?? ""),
    total: { ...outcome(total), no_order: num(total.no_order) },
    channels: arr(r.channels).map((c) => ({ ...outcome(c), channel: String(c.channel ?? "unknown"), source: String(c.source ?? "") })),
    paid_social: { ...psOutcome, no_campaign: num(ps.no_campaign) },
    ads,
    campaigns: arr(r.campaigns)
      .map((c) => {
        const o = outcome(c);
        const base: WebCampaign = { ...o, id: str(c.id), name: str(c.name), status: str(c.status) };
        return margins ? { ...base, ...spendOf(c, o) } : base;
      })
      // without margins a campaign that only spent (no orders) says nothing — leave it out
      .filter((c) => margins || c.orders > 0),
    daily: arr(r.daily).map((d) => {
      const day: WebDay = { d: String(d.d ?? ""), orders: num(d.orders), value_mkd: num(d.value_mkd), paid_social_mkd: num(d.paid_social_mkd) };
      return margins ? { ...day, spend_mkd: num(d.spend_mkd) } : day;
    }),
    coupons: arr(r.coupons).map((c) => ({ code: String(c.code ?? ""), orders: num(c.orders), value_mkd: num(c.value_mkd) })),
    cities: arr(r.cities).map((c) => ({ city: String(c.city ?? ""), orders: num(c.orders), value_mkd: num(c.value_mkd), returned: num(c.returned) })),
    payment: arr(r.payment).map((c) => ({ method: String(c.method ?? "unknown"), orders: num(c.orders), value_mkd: num(c.value_mkd), returned: num(c.returned) })),
    products: arr(r.products).map((c) => ({ name: String(c.name ?? ""), qty: num(c.qty), value_mkd: num(c.value_mkd), orders: num(c.orders) })),
    lost: { cancelled: lostOf("cancelled"), card_unpaid: lostOf("card_unpaid") },
    access: { margins },
  };
}

/** The channels folded for the page's headline: paid · organic · direct · referral · email · other. */
export const CHANNEL_GROUPS = ["paid", "organic", "direct", "referral", "email", "mex_only", "other"] as const;
export type ChannelGroup = typeof CHANNEL_GROUPS[number];
export function channelGroup(channel: string): ChannelGroup {
  if (channel === "paid_social" || channel === "paid_search" || channel === "paid") return "paid";
  if (channel === "organic_search" || channel === "organic_social") return "organic";
  if (channel === "direct") return "direct";
  if (channel === "referral") return "referral";
  if (channel === "email" || channel === "newsletter") return "email";
  if (channel === "mex_only") return "mex_only";
  return "other";
}

export function groupChannels(rows: readonly WebChannelRow[]): (WebOutcome & { group: ChannelGroup })[] {
  const m = new Map<ChannelGroup, WebOutcome>();
  for (const r of rows) {
    const g = channelGroup(r.channel);
    const a = m.get(g) ?? { orders: 0, value_mkd: 0, paid: 0, paid_mkd: 0, returned: 0, returned_mkd: 0 };
    a.orders += r.orders; a.value_mkd += r.value_mkd; a.paid += r.paid; a.paid_mkd += r.paid_mkd;
    a.returned += r.returned; a.returned_mkd += r.returned_mkd;
    m.set(g, a);
  }
  return CHANNEL_GROUPS.filter((g) => m.has(g)).map((g) => ({ group: g, ...m.get(g)! }))
    .sort((a, b) => b.value_mkd - a.value_mkd);
}

export const RECENCY_KEYS = ["d0_20", "d21_57", "d58_120", "d121_365", "d365_plus", "never"] as const;
export type RecencyKey = typeof RECENCY_KEYS[number];

export interface WebCustomers {
  total: number;
  with_email: number;
  with_phone: number;
  opted_in: number;
  with_account: number;
  repeat: number;
  with_points: number;
  points_total: number;
  recency: Record<RecencyKey, { count: number; with_email: number }>;
  cities: { city: string; count: number }[];
  new_by_month: { m: string; count: number }[];
  synced_at: string | null;
}

export function shapeCustomers(rpc: unknown): WebCustomers {
  const r = isObj(rpc) ? rpc : {};
  const rec = isObj(r.recency) ? r.recency : {};
  const recency = Object.fromEntries(RECENCY_KEYS.map((k) => {
    const x = isObj(rec[k]) ? rec[k] as Record<string, unknown> : {};
    return [k, { count: num(x.count), with_email: num(x.with_email) }];
  })) as WebCustomers["recency"];
  return {
    total: num(r.total), with_email: num(r.with_email), with_phone: num(r.with_phone), opted_in: num(r.opted_in),
    with_account: num(r.with_account), repeat: num(r.repeat), with_points: num(r.with_points), points_total: num(r.points_total),
    recency,
    cities: arr(r.cities).map((c) => ({ city: String(c.city ?? ""), count: num(c.count) })),
    new_by_month: arr(r.new_by_month).map((c) => ({ m: String(c.m ?? ""), count: num(c.count) })),
    synced_at: str(r.synced_at),
  };
}
