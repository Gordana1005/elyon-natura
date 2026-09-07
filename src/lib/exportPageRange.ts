/**
 * Page-window arithmetic for the /orders "Export view" download.
 *
 * The orders list is server-paginated at `pageSize` rows per screen page, but
 * fetching one screen page per request would be ~1 request per 20 rows. So the
 * export pulls `chunkSize`-row chunks and slices the operator's window out of
 * them. This module is the arithmetic on its own, so the boundaries can be
 * tested — an off-by-one here hands the operator a file of the wrong orders
 * without anything looking broken, which is precisely the failure this export
 * change exists to remove.
 *
 * Page numbers are 1-based and mean the same thing as the pager at the bottom
 * of the screen: page 1 is the newest `pageSize` orders.
 */

export interface ExportWindow {
  /** 0-based row index the export starts at (inclusive). */
  startRow: number;
  /** 0-based row index the export stops at (exclusive); Infinity for "all". */
  endRow: number;
  /** 1-based chunk number to request first. */
  firstChunk: number;
  /** How many rows to drop off the front of the concatenated chunks. */
  offsetIntoChunk: number;
}

export function planExportWindow(
  scope: 'all' | 'range',
  pageFrom: number,
  pageTo: number,
  pageSize: number,
  chunkSize: number,
): ExportWindow {
  const startRow = scope === 'range' ? (pageFrom - 1) * pageSize : 0;
  const endRow = scope === 'range' ? pageTo * pageSize : Infinity;
  const firstChunk = Math.floor(startRow / chunkSize) + 1;
  return { startRow, endRow, firstChunk, offsetIntoChunk: startRow - (firstChunk - 1) * chunkSize };
}

/**
 * Clamp the two page boxes to a window that exists.
 *
 * Empty, non-numeric, reversed and out-of-range inputs all resolve to something
 * sane rather than exporting nothing: a blank "to" means "through the last
 * page", and `to` can never end up before `from`.
 */
export function clampPageRange(
  rawFrom: string | number,
  rawTo: string | number,
  totalPages: number,
): { pageFrom: number; pageTo: number } {
  const lastPage = Math.max(1, totalPages);
  const nFrom = typeof rawFrom === 'number' ? rawFrom : parseInt(rawFrom, 10);
  const nTo = typeof rawTo === 'number' ? rawTo : parseInt(rawTo, 10);
  const pageFrom = Math.min(Math.max(Number.isFinite(nFrom) ? nFrom : 1, 1), lastPage);
  const pageTo = Math.min(Math.max(Number.isFinite(nTo) ? nTo : lastPage, pageFrom), lastPage);
  return { pageFrom, pageTo };
}

/** Rows the current settings will produce — the figure shown before clicking. */
export function estimateExportRows(
  scope: 'all' | 'range',
  pageFrom: number,
  pageTo: number,
  total: number,
  pageSize: number,
  cap: number,
): number {
  if (scope === 'all') return Math.min(total, cap);
  const start = (pageFrom - 1) * pageSize;
  return Math.max(0, Math.min(Math.min(pageTo * pageSize, total) - start, cap));
}
