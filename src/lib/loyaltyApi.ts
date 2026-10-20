import { apiFetch } from '@/lib/api';

export interface LoyaltySummary {
  customers: number;
  points: number;
  orders: number;
  on_shop: number;
}

export interface LoyaltyRow {
  phone8: string;
  name: string;
  city: string;
  phone: string;
  points: number;
  orders: number;
  nt_mkd: number;
  last_day: string;
  shop_profiles: number;
  /** The shop's own balance on the same last-8 phone (shown, never added up). */
  web_points: number;
}

export interface LoyaltyPage {
  summary: LoyaltySummary;
  q: string;
  page: number;
  size: number;
  total: number;
  rows: LoyaltyRow[];
}

export interface LoyaltyGrant {
  display_id: string | null;
  sale_day: string;
  nt_mkd: number;
  points: number;
  mex_tracking_id: string;
}

export interface LoyaltyPhone {
  phone8: string;
  name: string;
  city: string;
  phone: string;
  points: number;
  orders: number;
  nt_mkd: number;
  shop_profiles: number;
  web_points: number;
  web_orders: number;
  web_synced_at: string | null;
  grants: LoyaltyGrant[];
}

export interface LoyaltyWebRow {
  /** phone8, or "id:<shop customer id>" for a profile with no usable phone. */
  key: string;
  phone8: string | null;
  name: string;
  city: string;
  phone: string;
  points: number;
  orders: number;
  profiles: number;
  crm_points: number;
}

export interface LoyaltyWebPage {
  summary: { customers: number; points: number; with_crm: number; synced_at: string | null };
  q: string;
  page: number;
  size: number;
  total: number;
  rows: LoyaltyWebRow[];
}

const PHONE8 = /^[0-9]{8}$/;

export const isPhone8 = (v: string | null | undefined): v is string => !!v && PHONE8.test(v);

export function apiGetLoyaltyPage(q: string, page: number, signal?: AbortSignal): Promise<LoyaltyPage> {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  p.set('page', String(page));
  return apiFetch<LoyaltyPage>(`loyalty?${p}`, { signal });
}

export function apiGetLoyaltyPhone(phone8: string, signal?: AbortSignal): Promise<LoyaltyPhone> {
  return apiFetch<LoyaltyPhone>(`loyalty/phone/${phone8}`, { signal });
}

export function apiGetLoyaltyWebPage(q: string, page: number, signal?: AbortSignal): Promise<LoyaltyWebPage> {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  p.set('page', String(page));
  return apiFetch<LoyaltyWebPage>(`loyalty/web?${p}`, { signal });
}
