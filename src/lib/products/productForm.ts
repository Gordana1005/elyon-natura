import { denToEur, eurToDen } from '@/lib/currency';
import type { BrandLine } from './brandLines';
import { lineOf } from './brandLines';
import { kindOf, type CatalogueRow, type ProductKind } from './kinds';

/**
 * The product form (Производи 2.0): Основно · Цени · Код · Залиха · Детали.
 *
 * Prices are STORED in EUR (frozen MKD_PER_EUR) and never shown as euro — the
 * form holds денари and converts only at the api boundary. An EDIT sends only
 * the fields that changed: a price nobody touched keeps its exact stored EUR
 * (no rounding drift), and a stock count the warehouse changed meanwhile is not
 * overwritten by the form's stale copy. The kind and the line are not product
 * fields — they go through their own audited routes, and only when they changed.
 *
 * Pure and unit-tested (productForm.test.ts).
 */

export interface ProductFormValues {
  name: string;
  kind: ProductKind | null;
  line: BrandLine | null;
  isActive: boolean;
  priceDen: string;
  costDen: string;
  sku: string;
  barcode: string;
  stock: string;
  threshold: string;
  supply: string;
  description: string;
  category: string;
  supplierId: string;
}

export type FormField = keyof ProductFormValues;
/** field → the i18n key of its problem (products.form.errors.*). */
export type FormErrors = Partial<Record<FormField, string>>;

export const LIMITS = {
  name: 200, sku: 50, barcode: 50, description: 2000, category: 200,
  price: 10_000_000, stock: 1_000_000, threshold: 100_000, supply: 3650,
};

export function formFromRow(p: CatalogueRow | null): ProductFormValues {
  return {
    name: p?.name ?? '',
    kind: p ? kindOf(p) : null,
    line: p ? lineOf(p) : null,
    isActive: p ? p.is_active : true,
    priceDen: p ? String(eurToDen(p.price)) : '',
    costDen: p && p.cost_price != null ? String(eurToDen(p.cost_price)) : '',
    sku: p?.sku ?? '',
    barcode: p?.barcode ?? '',
    stock: p ? String(p.stock_quantity) : '0',
    threshold: p ? String(p.low_stock_threshold) : '5',
    supply: String(p?.days_of_supply_per_unit ?? 15),
    description: p?.description ?? '',
    category: p?.category ?? '',
    supplierId: p?.supplier_id ?? '',
  };
}

const isNum = (s: string) => /^\d+([.,]\d+)?$/.test(s.trim());
const isInt = (s: string) => /^\d+$/.test(s.trim());
const toNum = (s: string) => Number(s.trim().replace(',', '.'));

/** Every problem, field → i18n key. Empty object = can be saved. */
export function validateForm(v: ProductFormValues, opts: { showCost: boolean }): FormErrors {
  const e: FormErrors = {};
  const name = v.name.trim();
  if (!name) e.name = 'required';
  else if (name.length > LIMITS.name) e.name = 'tooLong';
  if (v.priceDen.trim() === '') e.priceDen = 'required';
  else if (!isNum(v.priceDen) || toNum(v.priceDen) > LIMITS.price) e.priceDen = 'number';
  if (opts.showCost && v.costDen.trim() !== '' && (!isNum(v.costDen) || toNum(v.costDen) > LIMITS.price)) e.costDen = 'number';
  if (v.sku.trim().length > LIMITS.sku) e.sku = 'tooLong';
  if (v.barcode.trim().length > LIMITS.barcode) e.barcode = 'tooLong';
  if (!isInt(v.stock) || toNum(v.stock) > LIMITS.stock) e.stock = 'wholeNumber';
  if (!isInt(v.threshold) || toNum(v.threshold) > LIMITS.threshold) e.threshold = 'wholeNumber';
  if (!isInt(v.supply) || toNum(v.supply) < 1 || toNum(v.supply) > LIMITS.supply) e.supply = 'days';
  if (v.description.length > LIMITS.description) e.description = 'tooLong';
  if (v.category.trim().length > LIMITS.category) e.category = 'tooLong';
  return e;
}

/** The first field with a problem, in the form's order (focus goes there). */
export const FIELD_ORDER: readonly FormField[] = [
  'name', 'kind', 'line', 'isActive', 'priceDen', 'costDen', 'sku', 'barcode', 'stock', 'threshold', 'supply', 'description', 'category', 'supplierId',
];
export const firstError = (e: FormErrors): FormField | null => FIELD_ORDER.find((f) => e[f]) ?? null;

type Body = Record<string, unknown>;

/** A product field's api value from the form. */
function fieldValue(k: FormField, v: ProductFormValues): [string, unknown] | null {
  switch (k) {
    case 'name': return ['name', v.name.trim()];
    case 'isActive': return ['is_active', v.isActive];
    case 'priceDen': return ['price', denToEur(toNum(v.priceDen))];
    case 'costDen': return ['cost_price', v.costDen.trim() === '' ? 0 : denToEur(toNum(v.costDen))];
    case 'sku': return ['sku', v.sku.trim() || null];
    case 'barcode': return ['barcode', v.barcode.trim() || null];
    case 'stock': return ['stock_quantity', Number(v.stock)];
    case 'threshold': return ['low_stock_threshold', Number(v.threshold)];
    case 'supply': return ['days_of_supply_per_unit', Number(v.supply)];
    case 'description': return ['description', v.description];
    case 'category': return ['category', v.category.trim()];
    case 'supplierId': return ['supplier_id', v.supplierId || null];
    default: return null;   // kind / line: their own routes
  }
}

const PRODUCT_FIELDS: readonly FormField[] = [
  'name', 'isActive', 'priceDen', 'costDen', 'sku', 'barcode', 'stock', 'threshold', 'supply', 'description', 'category', 'supplierId',
];

/** POST /api/products: every field (cost only for a login that sees cost). */
export function toCreateBody(v: ProductFormValues, opts: { showCost: boolean }): Body {
  const body: Body = {};
  for (const k of PRODUCT_FIELDS) {
    if (k === 'costDen' && !opts.showCost) continue;
    const kv = fieldValue(k, v);
    if (kv) body[kv[0]] = kv[1];
  }
  return body;
}

const same = (k: FormField, a: ProductFormValues, b: ProductFormValues) => {
  if (k === 'priceDen' || k === 'costDen') {
    const x = a[k].trim();
    const y = b[k].trim();
    return x === y || (isNum(x) && isNum(y) && toNum(x) === toNum(y));
  }
  if (k === 'name' || k === 'sku' || k === 'barcode' || k === 'category') return String(a[k]).trim() === String(b[k]).trim();
  return a[k] === b[k];
};

/** PATCH /api/products/:id: only what changed since the form opened (cost only for a login that sees cost). */
export function toPatch(initial: ProductFormValues, v: ProductFormValues, opts: { showCost: boolean }): Body {
  const patch: Body = {};
  for (const k of PRODUCT_FIELDS) {
    if (k === 'costDen' && !opts.showCost) continue;
    if (same(k, initial, v)) continue;
    const kv = fieldValue(k, v);
    if (kv) patch[kv[0]] = kv[1];
  }
  return patch;
}

/** The audited follow-up writes the save needs: the kind / the line, only when they changed (and may be set). */
export function followUps(initial: ProductFormValues, v: ProductFormValues, opts: { canSetKind: boolean; canSetLine: boolean; creating: boolean }) {
  return {
    kind: opts.canSetKind && (opts.creating ? v.kind !== null : v.kind !== initial.kind) ? { kind: v.kind } : null,
    line: opts.canSetLine && (opts.creating ? v.line !== null : v.line !== initial.line) ? { line: v.line } : null,
  };
}

/** The agents' default price (EUR): the price when set, else max(cost × 3, €15) — the api's rule. */
export const suggestedSellEur = (priceEur: number, costEur: number) => (priceEur > 0 ? priceEur : Math.max((costEur || 0) * 3, 15));
export const denInputToEur = (s: string) => (isNum(s) ? denToEur(toNum(s)) : 0);
