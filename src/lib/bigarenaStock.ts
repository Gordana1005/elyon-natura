// BigArena "Fulfillment Panel" stock-export parser.
//
// This is the product-inventory export (Наименование / Информация / Количество …),
// NOT the order-tracking export (whose manual upload UI was removed 2026-08-18 —
// courier statuses now come from the automated MEX reconcile). The logic here is a
// browser-safe port of the battle-tested scripts/import-products-bigarena.mjs so the
// UI button and the CLI fallback always read the file identically.

import * as XLSX from 'xlsx';

export interface ParsedStockRow {
  name: string;
  nameNorm: string;
  sku: string | null;
  barcode: string | null;
  /** "Свободна наличност" — units NOT reserved for orders already being packed. */
  free: number;
  /** "Резервирана наличност" — already committed to orders. Shown, never summed in. */
  reserved: number;
  /** SKUs merged into this row by the shared-barcode rule (display only). */
  mergedSkus: string[];
}

/** "Резервирана наличност: 0Свободна наличност: 2934'>2934" → 2934 */
export function parseFreeStock(cell: unknown): number | null {
  if (cell == null) return null;
  const m = String(cell).match(/Свободна наличност:\s*(-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** "Резервирана наличност: 6Свободна наличност: 15'>21" → 6 */
export function parseReservedStock(cell: unknown): number {
  if (cell == null) return 0;
  const m = String(cell).match(/Резервирана наличност:\s*(-?\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * "SKU: NT0143Баркод: 5310416001610" → { sku: "NT0143", barcode: "5310416001610" }
 *
 * Some products have NO SKU in BigArena, so the cell reads "SKU: Баркод: 531…".
 * The SKU capture is therefore non-greedy and allowed to be empty — a naive
 * `\S+` would happily capture the literal "Баркод:" as the SKU and then match
 * the wrong product later.
 */
export function parseSkuBarcode(cell: unknown): { sku: string | null; barcode: string | null } {
  if (cell == null) return { sku: null, barcode: null };
  const s = String(cell);
  const clean = (v: string | undefined): string | null => {
    const t = (v || '').trim();
    return t && !t.endsWith(':') ? t : null;
  };

  const both = s.match(/SKU:\s*(.*?)\s*Баркод:\s*(\S+)/);
  if (both) return { sku: clean(both[1]), barcode: clean(both[2]) };
  // Tolerate rows that carry only one of the two.
  const skuOnly = s.match(/SKU:\s*(\S+)/);
  const bcOnly = s.match(/Баркод:\s*(\S+)/);
  return { sku: clean(skuOnly?.[1]), barcode: clean(bcOnly?.[1]) };
}

export const normalizeName = (s: unknown): string =>
  String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * True when the sheet header looks like the Fulfillment Panel (product stock) export.
 * Lets the stock-sync UI confirm it was handed the right BigArena file.
 */
export function isFulfillmentPanelFile(headerText: string): boolean {
  const h = (headerText || '').toLowerCase();
  return (
    h.includes('наименование') &&
    h.includes('информация') &&
    (h.includes('количество') || h.includes('наличност'))
  );
}

// ────────────────────────────────────────────────────────────────────────────
// File reading
// ────────────────────────────────────────────────────────────────────────────

// BigArena sometimes serves the CSV as UTF-8 and sometimes as windows-1251. Decode
// as UTF-8 first; the classic "Ð/Ñ" mojibake (or U+FFFD) means it was really cp1251.
function decodeText(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const looksBroken = /�/.test(utf8) || /Ð[-¿]|Ñ[-¿]/.test(utf8);
  if (!looksBroken) return utf8;
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8;
  }
}

// Minimal CSV splitter — handles the quoted fields BigArena emits (incl. "" escapes).
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvToMatrix(text: string): string[][] {
  // Join physical lines back together when a quoted field spans newlines.
  const rows: string[] = [];
  let buf = '';
  let quotes = 0;
  for (const line of text.split(/\r?\n/)) {
    buf = buf ? buf + '\n' + line : line;
    quotes += (line.match(/"/g) || []).length;
    if (quotes % 2 === 0) { rows.push(buf); buf = ''; }
  }
  if (buf) rows.push(buf);

  const nonEmpty = rows.filter(r => r.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  // Detect the delimiter from the first line (BigArena uses "," but Excel re-saves as ";").
  const probe = nonEmpty[0];
  const delimiter = (probe.split(';').length > probe.split(',').length) ? ';' : ',';
  return nonEmpty.map(r => splitCsvLine(r, delimiter));
}

export async function readStockFile(file: File): Promise<string[][]> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xls') {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false }) as unknown[][];
    return rows.map(r => (r || []).map(c => (c == null ? '' : String(c))));
  }
  const text = decodeText(await file.arrayBuffer());
  return csvToMatrix(text);
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────────────

export interface ParseStockResult {
  rows: ParsedStockRow[];
  /** Number of rows folded away by the shared-barcode merge. */
  mergedCount: number;
  /** Set when the file is clearly not a Fulfillment Panel export. */
  error?: string;
}

/**
 * Find the header row. The XLSX export carries a title row above the headers; the
 * CSV export starts at the headers directly — so we scan instead of hard-coding.
 */
function findHeaderRow(matrix: string[][]): number {
  const limit = Math.min(matrix.length, 6);
  for (let i = 0; i < limit; i++) {
    const joined = (matrix[i] || []).join(' ').toLowerCase();
    if (joined.includes('наименование') && joined.includes('информация')) return i;
  }
  return -1;
}

export function parseStockMatrix(matrix: string[][]): ParseStockResult {
  if (!matrix.length) return { rows: [], mergedCount: 0, error: 'empty' };

  const headerIdx = findHeaderRow(matrix);
  if (headerIdx === -1) {
    const firstRows = matrix.slice(0, 3).map(r => r.join(' ')).join(' ');
    const looksLikeOrders = /Ref:\s*\d{3,}/i.test(firstRows) || /поръчка/i.test(firstRows);
    return {
      rows: [],
      mergedCount: 0,
      error: looksLikeOrders ? 'orders_export' : 'unrecognized',
    };
  }

  const header = matrix[headerIdx].map(c => c.toLowerCase());
  const nameCol = 0;
  const infoCol = header.findIndex(h => h.includes('информация'));
  // "Количество" holds the "Резервирана … Свободна …" blob.
  let qtyCol = header.findIndex(h => h.includes('количество') || h.includes('наличност'));
  if (qtyCol === -1) qtyCol = 3;

  const raw: ParsedStockRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r || !r[nameCol] || !String(r[nameCol]).trim()) continue;
    const name = String(r[nameCol]).trim();
    const { sku, barcode } = parseSkuBarcode(r[infoCol === -1 ? 1 : infoCol]);
    const free = parseFreeStock(r[qtyCol]);
    if (free === null) continue; // not a product row
    raw.push({
      name,
      nameNorm: normalizeName(name),
      sku,
      barcode,
      free,
      reserved: parseReservedStock(r[qtyCol]),
      mergedSkus: [],
    });
  }

  // Some products appear twice under two SKUs (one Cyrillic name, one Latin) but
  // share an EAN — same physical inventory. Merge by barcode, SUMMING free stock
  // and keeping the first-seen SKU. (Rule inherited from import-products-bigarena.mjs;
  // required today for NT0108 + 000982, barcode 5310416000743.)
  const merged: ParsedStockRow[] = [];
  let mergedCount = 0;
  for (const row of raw) {
    if (!row.barcode) { merged.push(row); continue; }
    const existing = merged.find(p => p.barcode === row.barcode);
    if (existing) {
      existing.free += row.free;
      existing.reserved += row.reserved;
      if (row.sku) existing.mergedSkus.push(row.sku);
      mergedCount++;
    } else {
      merged.push(row);
    }
  }

  return { rows: merged, mergedCount };
}

export async function parseStockFile(file: File): Promise<ParseStockResult> {
  const matrix = await readStockFile(file);
  return parseStockMatrix(matrix);
}

// ────────────────────────────────────────────────────────────────────────────
// Matching against the CRM catalogue
// ────────────────────────────────────────────────────────────────────────────

export interface MatchableProduct {
  id: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  stock_quantity: number;
}

export interface StockDiffRow {
  row: ParsedStockRow;
  product: MatchableProduct | null;
  matchedBy: 'sku' | 'barcode' | 'name' | null;
  delta: number;
}

/**
 * Match order is SKU → barcode → normalized name. Used identically on the client
 * (preview) and the server (apply) so what the operator sees is what happens.
 */
export function matchRows(rows: ParsedStockRow[], products: MatchableProduct[]): StockDiffRow[] {
  const bySku = new Map<string, MatchableProduct>();
  const byBarcode = new Map<string, MatchableProduct>();
  const byName = new Map<string, MatchableProduct>();
  for (const p of products) {
    if (p.sku) bySku.set(String(p.sku).trim(), p);
    if (p.barcode) byBarcode.set(String(p.barcode).trim(), p);
    const n = normalizeName(p.name);
    if (n && !byName.has(n)) byName.set(n, p);
  }

  return rows.map(row => {
    let product: MatchableProduct | null = null;
    let matchedBy: StockDiffRow['matchedBy'] = null;
    if (row.sku && bySku.has(row.sku)) { product = bySku.get(row.sku)!; matchedBy = 'sku'; }
    else if (row.barcode && byBarcode.has(row.barcode)) { product = byBarcode.get(row.barcode)!; matchedBy = 'barcode'; }
    else if (byName.has(row.nameNorm)) { product = byName.get(row.nameNorm)!; matchedBy = 'name'; }

    return {
      row,
      product,
      matchedBy,
      delta: product ? row.free - Number(product.stock_quantity || 0) : 0,
    };
  });
}
