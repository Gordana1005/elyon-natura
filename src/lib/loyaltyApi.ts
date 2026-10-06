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
  grants: LoyaltyGrant[];
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
