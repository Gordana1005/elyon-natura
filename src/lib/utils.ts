import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a product line with its quantity using the canonical "Name xN" style.
 * Smartly skips appending " xN" when the incoming productName (from website bundles,
 * legacy data, or pack-size variants like "Prostatol 3", "Prostatol 4") already
 * describes a specific quantity or bundle. This prevents ugly "Prostatol 3 x3"
 * or "Prostatol 4 x4" and preserves descriptive promo names like
 * "Prostatol 3 + Palmetto 1 x3".
 */
export function formatProductWithQuantity(productName: string, quantity: number = 1): string {
  if (!productName) return '';
  const trimmed = productName.trim();
  if (!trimmed) return '';

  // Detect names that already embed quantity/pack/bundle info:
  // - " ... x3", " ... 3", "Foo x 2 + Bar 1 x3"
  // - trailing number (pack size / variant)
  // - words like pack, комплект, бр.
  const hasEmbeddedQty = /\b(x\s*\d+|×\s*\d+|\d+\s*[x×]\s*\d*|\s+\d{1,3}\s*$|pack|комплект|бр\.|бр\s*\d)/i.test(trimmed);
  if (hasEmbeddedQty) {
    return trimmed;
  }
  if (quantity <= 1) {
    return trimmed;
  }
  return `${trimmed} x${quantity}`;
}

/**
 * Placeholder product names the CRM writes on synthetic outcome rows — the
 * cancel/trash records /calls creates when a customer has no open order.
 *
 * These are NOT products and must never be treated as one. Reading a placeholder
 * back as a real product is self-perpetuating: the next cancel for the same
 * customer finds the placeholder row (it is the most recent), copies it forward,
 * and the customer's actual purchase is buried one row deeper each time. That is
 * how 401 orders ended up claiming "No prior product on file" while 94% of those
 * customers had a real, paid product one row below.
 */
export function isSyntheticProductName(name: string | null | undefined): boolean {
  const n = (name || '').trim();
  if (!n || n === '—') return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
}

/**
 * Detects product names that likely came from the website as promotional bundles
 * (e.g. "Prostatol 3 + Palmetto 1 x3", "Prostatol 4", names with "+" or baked-in numbers).
 * These should be replaced by the agent with real catalogue products during the call.
 */
export function isLegacyPromoName(name: string | null | undefined, productId?: string | null): boolean {
  if (!name) return false;
  const n = name.trim();
  if (!n) return false;

  // If it already has a valid product_id from the catalogue, treat as resolved
  if (productId) return false;

  // Typical patterns from website promos / bundles
  return / \+ |\+ | x\d|Prostatol\s*\d|Palmetto\s*\d|\d\s*\+\s*|\d\s*x\s*\d/i.test(n) ||
         /\s+\d{1,2}\s*$/.test(n); // ends with a number (e.g. "Prostatol 4")
}

/**
 * Builds lookup maps from a list of products for cleaning legacy/dirty product names
 * to the current official warehouse/catalogue names.
 */
// Known product-name aliases that fuzzy matching can't bridge — typically a
// Latin/English order name (from the website / OpenCart import) vs the Cyrillic
// catalogue name. Maps a normalised (lowercased) order/line-item name → SKU so
// the fulfilment export always emits a SKU. Matched by substring, so variants
// like "2x Matcha Collagen" still resolve. Add entries as new mismatches show
// up; the deeper fix is linking product_id at import time (webhook/OpenCart).
const PRODUCT_NAME_ALIASES: Record<string, string> = {
  'matcha collagen': 'NT0145',               // МАЧА с КОЛАГЕН 175 гр
  'neuro active': '5310416001160',           // НЕВРО АКТИВ - 60капсули
  'prostatol': 'NT0004',                     // Простатол Комплекс
  'creatine monohydrate': 'NT0103',          // CREATINE powder 200 gr. (also beats the free-Tribulus fuzzy match)
  'diet shake с вкус на шоколад': 'NT0100',  // Diet shake chocolate 500g
};

export function buildProductNameLookups(products: any[] = []) {
  const nameById: Record<string, string> = {};
  const cleanNameByLower: Record<string, string> = {};
  // Lowercased product name (full + shortened) → catalogue SKU. Lets the
  // fulfilment export recover a SKU for legacy/imported line items that were
  // never linked to a product (product_id is null) but whose name still
  // matches a catalogue product.
  const skuByLower: Record<string, string> = {};

  for (const p of products) {
    if (!p?.id || !p?.name) continue;

    nameById[p.id] = p.name;

    const lower = p.name.toLowerCase().trim();
    cleanNameByLower[lower] = p.name;
    if (p.sku) skuByLower[lower] = p.sku;

    // Also store a shortened version for better matching against old promo strings
    const short = p.name.replace(/\s*(Комплекс|Форте|active|Пептид|Пептид со).*$/i, '').trim().toLowerCase();
    if (short && short !== lower) {
      cleanNameByLower[short] = p.name;
      if (p.sku && !skuByLower[short]) skuByLower[short] = p.sku;
    }
  }

  function resolveToCleanCatalogueName(rawName: string | null | undefined): string {
    if (!rawName) return rawName || '';
    const key = rawName.toLowerCase().trim();
    if (cleanNameByLower[key]) return cleanNameByLower[key];

    // Partial / fuzzy fallback
    for (const [k, clean] of Object.entries(cleanNameByLower)) {
      if (key.includes(k) || k.includes(key)) return clean;
    }
    return rawName;
  }

  // Resolve a raw order/line-item name to its catalogue SKU. Tries an exact
  // name match, then the canonical name (via the same fuzzy resolver), so messy
  // promo strings like "Brain Active (30cps) - добавка…" still map to NT0063.
  // Returns '' when the name matches no catalogue product (a real data gap).
  function resolveSku(rawName: string | null | undefined): string {
    if (!rawName) return '';
    const key = rawName.toLowerCase().trim();
    if (skuByLower[key]) return skuByLower[key];
    // Curated cross-script aliases (substring match).
    for (const alias in PRODUCT_NAME_ALIASES) {
      if (key.includes(alias)) return PRODUCT_NAME_ALIASES[alias];
    }
    const canonical = resolveToCleanCatalogueName(rawName).toLowerCase().trim();
    return skuByLower[canonical] || '';
  }

  return { nameById, cleanNameByLower, skuByLower, resolveToCleanCatalogueName, resolveSku };
}
