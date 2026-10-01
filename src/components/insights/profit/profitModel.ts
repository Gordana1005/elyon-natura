/**
 * Pure rules of Insights → Pure Profit and Margins (no React, no network —
 * profitModel.test.ts covers them). The server (insightsProfit.ts) does the
 * P&L; this file only turns a P&L row into the steps a reader follows, sorts
 * and filters products, and solves Margin Lab's floor price.
 */
import type { PLRow, ProfitProduct } from '@/lib/insightsApi/profit';
import { PROFIT_SOURCES } from '@/lib/insightsApi/profit';
import type { CohortSourceRow } from '../shared/cohortTypes';
import type { ProfitResponse } from '@/lib/insightsApi/profit';

export type Basis = 'estimated' | 'costed';

export type StepKey =
  | 'revenue' | 'vat' | 'cogs_known' | 'cogs_est' | 'courier' | 'returns' | 'commission' | 'lead' | 'net';

export interface Step {
  key: StepKey;
  /** Signed денари: revenue and net as they are, every cost negative. */
  value: number;
  /** Where the bar starts and ends, as денари from 0 (the running total). */
  from: number;
  to: number;
  /** The step is an estimate / an allocation (drawn hatched). */
  estimate?: boolean;
  /** The slot exists but has no data (lead cost). */
  pending?: boolean;
}

// ── VAT (per product from Sigma, owner 01.10.2026 — docs/VAT.md) ─────────────

/** The rate of a line with no product rate (meta.vat.default_rate; an older api: meta.vat.rate). */
export const defaultVatRate = (meta: ProfitResponse['meta']): number => meta.vat.default_rate ?? meta.vat.rate;

/** true = the VAT line is Σ per line at each product's Sigma rate. */
export const vatPerProduct = (meta: ProfitResponse['meta']): boolean => meta.vat.mode === 'per_product_sigma';

/** A product's rate for the floor price / simulator: its own, else the default. */
export const productVatRate = (p: Pick<ProfitProduct, 'vat_rate'>, defaultRate: number): number =>
  p.vat_rate == null ? defaultRate : p.vat_rate;

/**
 * The waterfall of one P&L row. `estimated`: every package, uncosted ones at
 * the view's cost share (the headline). `costed`: the costed packages alone —
 * their revenue, their own VAT (per product) and known cost; courier, returns
 * and commission allocated by their share of the revenue. `defaultRate` is used
 * only when an older api sends no costed VAT.
 */
export function waterfall(row: PLRow, basis: Basis, defaultRate: number): Step[] {
  let revenue = row.revenue_mkd;
  let vat = row.vat_mkd;
  let courier = row.courier_mkd;
  let returns = row.returns_mkd;
  let commission = row.commission_mkd;
  let cogsEst = row.cogs_est_mkd ?? 0;
  if (basis === 'costed') {
    const sigma = row.revenue_mkd > 0 ? row.revenue_costed_mkd / row.revenue_mkd : 0;
    revenue = row.revenue_costed_mkd;
    vat = row.vat_costed_mkd ?? Math.round(revenue * defaultRate / (1 + defaultRate));
    courier = Math.round(courier * sigma);
    returns = Math.round(returns * sigma);
    commission = Math.round(commission * sigma);
    cogsEst = 0;
  }
  const costs: Omit<Step, 'from' | 'to'>[] = [
    { key: 'vat', value: -vat },
    { key: 'cogs_known', value: -row.cogs_known_mkd },
    ...(basis === 'estimated' && row.cogs_est_mkd != null ? [{ key: 'cogs_est' as const, value: -cogsEst, estimate: true }] : []),
    { key: 'courier', value: -courier, estimate: basis === 'costed' },
    { key: 'returns', value: -returns, estimate: basis === 'costed' },
    { key: 'commission', value: -commission, estimate: basis === 'costed' },
    { key: 'lead', value: -row.lead_cost_mkd, pending: true },
  ];
  const steps: Step[] = [{ key: 'revenue', value: revenue, from: 0, to: revenue }];
  let run = revenue;
  for (const c of costs) {
    steps.push({ ...c, from: run, to: run + c.value });
    run += c.value;
  }
  const net = basis === 'costed' ? row.costed.net_mkd : row.net_mkd;
  // the server's net is authoritative; the rounding of the parts may differ by a few денари
  steps.push({ key: 'net', value: net, from: 0, to: net });
  return steps;
}

/** Σ costs of a row on the headline basis (estimated unknowns included). */
export const totalCosts = (r: PLRow) =>
  r.vat_mkd + r.cogs_known_mkd + (r.cogs_est_mkd ?? 0) + r.courier_mkd + r.returns_mkd + r.commission_mkd + r.lead_cost_mkd;

// ── the cohort strip as CohortBar rows ──────────────────────────────────────

const EMPTY_LEADS = { came_in: 0, became_sales: 0, cancelled: 0, trashed: 0, open: 0, other: 0, disposition: 0, conversion: null };

/** The strip's per-source blocks as the rows CohortBar builds its links from. */
export function stripRows(strip: ProfitResponse['strip']): CohortSourceRow[] {
  return strip.by_source.map((s) => ({
    key: s.key, total: s.total, buckets: s.buckets, outside: s.outside, splits: [], leads_in: EMPTY_LEADS,
  }));
}

// ── products ────────────────────────────────────────────────────────────────

export type ProductSort = 'revenue' | 'net' | 'margin' | 'packages' | 'returns';

export const isRealProduct = (p: ProfitProduct) => p.package && p.key !== '__mex_only__' && p.key !== '__unknown__';

/** Search (name, case-insensitive), then sort; missing values sort last. */
export function sortProducts(rows: ProfitProduct[], sort: ProductSort, query = ''): ProfitProduct[] {
  const q = query.trim().toLocaleLowerCase();
  const val = (p: ProfitProduct): number | null => {
    switch (sort) {
      case 'net': return p.net_mkd;
      case 'margin': return p.margin;
      case 'packages': return p.packages;
      case 'returns': return p.return_rate;
      default: return p.revenue_mkd;
    }
  };
  return rows
    .filter((p) => !q || (p.name ?? '').toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return b.revenue_mkd - a.revenue_mkd;
      if (va == null) return 1;
      if (vb == null) return -1;
      return vb - va || b.revenue_mkd - a.revenue_mkd || a.key.localeCompare(b.key);
    });
}

// ── Margin Lab ──────────────────────────────────────────────────────────────

export const MKD_PER_EUR = 61.5;

/** index.ts packageBonusRate(), unchanged: EUR per package by unit price in EUR. */
export const packageBonusRate = (unitEur: number) => (unitEur >= 35 ? 3 : unitEur > 25 ? 2 : 1);

export interface UnitEconomics {
  /** Realized денари per package (all packages of the product, free ones included). */
  price: number;
  vat: number;
  cost: number | null;
  courier: number;
  commission: number;
  /** null when the cost is unknown — the status is "no cost", never "clears". */
  net: number | null;
}

/** Per-package economics of one product on the P&L's basis (same VAT, known
 *  cost, courier share, commission share as the Pure Profit rows). */
export function productUnit(p: ProfitProduct): UnitEconomics | null {
  if (!(p.packages > 0)) return null;
  const n = p.packages;
  const price = p.revenue_mkd / n;
  const vat = p.vat_mkd / n;
  const courier = p.courier_mkd / n;
  const commission = p.commission_mkd / n;
  const cost = p.cost_known && p.unit_cost_mkd != null ? p.cogs_mkd / n : null;
  return { price, vat, cost, courier, commission, net: cost == null ? null : price - vat - cost - courier - commission };
}

export type FloorStatus = 'clears' | 'below' | 'no_cost';

export function floorStatus(u: UnitEconomics | null, targetMkd: number): FloorStatus {
  if (!u || u.net == null) return 'no_cost';
  return u.net >= targetMkd ? 'clears' : 'below';
}

/**
 * The price per package that nets `target` денари: P − P·r/(1+r) − cost −
 * courier − commission(P) = target, i.e. P = (1+r)(target + cost + courier +
 * commission), r = THE PRODUCT'S VAT rate (Sigma: 5 % supplements, 18 %
 * cosmetics / devices — productVatRate). Commission is today's tier of the
 * resulting price (1/2/3 € per package) times the share of this product's
 * packages that earn one (γ, from the P&L: most Телешоп / Affiliate – Lead in
 * sellers are not agents). null without a cost.
 */
export function floorPrice(cost: number | null, courier: number, target: number, vatRate: number, gamma: number): number | null {
  if (cost == null) return null;
  const gross = 1 + vatRate;
  for (const m of [1, 2, 3]) {
    const p = gross * (target + cost + courier + m * MKD_PER_EUR * gamma);
    if (packageBonusRate(p / MKD_PER_EUR) === m) return p;
  }
  return gross * (target + cost + courier + 3 * MKD_PER_EUR * gamma);
}

export interface SimInput {
  price: number;          // денари the customer pays for the order
  paidPackages: number;
  bonusPackages: number;  // free packages in the bundle
  costPerPackage: number | null;
  deliverMkd: number;     // courier per delivered parcel (rate card)
  returnMkd: number;      // courier per returned parcel (rate card)
  returnRate: number;     // 0..1 — expected share of such orders that come back
  vatRate: number;        // the product's Sigma rate (productVatRate), not a flat one
  commissionShare: number; // 0..1 of packages that earn today's bonus
  leadCostMkd: number;    // per order (0 until rates exist)
}

export interface SimResult {
  packages: number;
  perPackagePrice: number;
  vat: number;
  cogs: number | null;
  courier: number;
  commission: number;
  lead: number;
  /** Net of one DELIVERED order. */
  netDelivered: number | null;
  /** Expected net per order sent, returns included: (1−q)·delivered − q·(return fee + lead). */
  netExpected: number | null;
  netPerPackage: number | null;
}

/** One bundle, one order: what it leaves after every cost, and after the expected returns. */
export function simulate(x: SimInput): SimResult {
  const packages = Math.max(1, Math.round(x.paidPackages) + Math.max(0, Math.round(x.bonusPackages)));
  const price = Math.max(0, x.price);
  const perPackagePrice = price / packages;
  const vat = price * x.vatRate / (1 + x.vatRate);
  const cogs = x.costPerPackage == null ? null : x.costPerPackage * packages;
  const commission = packages * packageBonusRate(perPackagePrice / MKD_PER_EUR) * MKD_PER_EUR * Math.min(1, Math.max(0, x.commissionShare));
  const courier = x.deliverMkd;
  const lead = Math.max(0, x.leadCostMkd);
  const q = Math.min(1, Math.max(0, x.returnRate));
  const netDelivered = cogs == null ? null : price - vat - cogs - courier - commission - lead;
  const netExpected = netDelivered == null ? null : (1 - q) * netDelivered - q * (x.returnMkd + lead);
  return {
    packages, perPackagePrice, vat, cogs, courier, commission, lead, netDelivered, netExpected,
    netPerPackage: netExpected == null ? null : netExpected / packages,
  };
}

/** The price of the order that nets `target` per package after the expected returns (null without a cost). */
export function simPriceFor(x: SimInput, targetPerPackage: number): number | null {
  if (x.costPerPackage == null) return null;
  let lo = 0, hi = 1_000_000;
  const netAt = (p: number) => simulate({ ...x, price: p }).netPerPackage ?? -Infinity;
  if (netAt(hi) < targetPerPackage) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (netAt(mid) >= targetPerPackage) hi = mid; else lo = mid;
  }
  return hi;
}

export const SOURCE_KEYS = PROFIT_SOURCES;

/** The Pure Profit export's column names — the owner's six departments (28.09.2026),
 *  kept English on purpose (export file content, elyon-i18n); no system names. */
export const EXPORT_SOURCE_NAME: Record<(typeof PROFIT_SOURCES)[number] | 'total', string> = {
  altercpa: 'Affiliate – Lead in',
  elyon_crm: 'Affiliate – Lead out',
  teleshop_out: 'Teleshop – Lead out',
  teleshop_other: 'Teleshop – Lead in',
  social: 'Social media',
  web: 'Web shop',
  total: 'Total',
};
/** The export's webmaster sheet (an Excel sheet name: ≤ 31 characters, no : \ / ? * [ ]). */
export const EXPORT_AFFILIATES_SHEET = 'Affiliate – Lead in webmasters';
