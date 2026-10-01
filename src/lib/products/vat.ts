/**
 * VAT per product, from Sigma (owner decision, Mile, 01.10.2026 — docs/VAT.md;
 * migration 20260944000900). It replaces the flat 18 % of 28.09.2026: every
 * product carries the rate Natura's books (Sigma Item.VatId) charge for it — food
 * supplements 5 %, cosmetics / gels / creams / oils / devices / chia drinks 18 %.
 *
 * The rate lives on products.vat_rate (NULL = unclassified: every report taxes it
 * at 5 % and shows the amount apart) and is set only through
 * POST /api/products/vat-rate (owners, audited). The server twin of this file is
 * supabase/functions/api/vatRates.ts. Owners only see it (the margins view).
 *
 * Pure: the filter, the counts, the evidence reader and the local update are
 * unit-tested in vat.test.ts.
 */

export const VAT_RATES = [0.05, 0.18, 0.1, 0] as const;
export type VatRate = (typeof VAT_RATES)[number];
/** The rate a report uses for a product with no rate (the core range). */
export const DEFAULT_VAT_RATE = 0.05;

/** A rate as one of the four (numeric(4,3) may arrive as "0.050"); null for anything else. */
export function asVatRate(v: unknown): VatRate | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const hit = VAT_RATES.find((r) => Math.abs(r - n) < 1e-9);
  return hit === undefined ? null : hit;
}

/** A product's rate, or null (missing / unknown = unclassified). */
export const vatOf = (p: { vat_rate?: unknown }): VatRate | null => asVatRate(p.vat_rate);

/** The share of a gross (VAT-inclusive) amount that is VAT at rate r. */
export const vatShare = (r: number) => r / (1 + r);

/**
 * A rate's chip tone — literal classes so Tailwind generates them, with a dark
 * twin. Always shown with its percentage, never colour alone.
 */
export const VAT_TONES: Record<VatRate, string> = {
  0.05: 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300',
  0.18: 'border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/50 dark:text-orange-300',
  0.1: 'border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300',
  0: 'border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200',
};
export const UNCLASSIFIED_VAT_TONE = 'border-dashed bg-muted/40 text-muted-foreground border-border';

/** "5%" — the percentage of a rate, whole (the four rates are whole percents), as fmtPct writes it. */
export const ratePct = (r: number) => `${Math.round(r * 100)}%`;

// ── where a rate came from (products.vat_source) ─────────────────────────────

export type VatSourceKind = 'crosswalk' | 'manual' | 'byName' | 'byNameMixed' | 'rule' | 'owner' | 'other';

/**
 * sigma:crosswalk-VERIFIED|HIGH|MEDIUM · sigma:manual · sigma:by-name[+mixed] ·
 * rule:supplement-5 | cosmetic-18 | device-18 · owner. `detail` = the crosswalk
 * confidence or the rule.
 */
export function vatSourceOf(source: string | null | undefined): { kind: VatSourceKind; detail: string | null } | null {
  if (!source) return null;
  const s = String(source);
  const cw = s.match(/^sigma:crosswalk-?(.*)$/);
  if (cw) return { kind: 'crosswalk', detail: cw[1] || null };
  if (s === 'sigma:manual') return { kind: 'manual', detail: null };
  if (s === 'sigma:by-name+mixed') return { kind: 'byNameMixed', detail: null };
  if (s === 'sigma:by-name') return { kind: 'byName', detail: null };
  const rule = s.match(/^rule:(.+)$/);
  if (rule) return { kind: 'rule', detail: rule[1] };
  if (s === 'owner') return { kind: 'owner', detail: null };
  return { kind: 'other', detail: s };
}

export interface EvidenceLine {
  /** a calendar year of Sigma sales invoices, or the МЕКС ПОШТА COD invoices */
  kind: 'year' | 'mex';
  year: string | null;
  rate: number;
  lines: number;
}

/**
 * The Sigma invoice evidence ("2025@5.00: 88; 2026@18.00: 40; mex@5.00: 10") as
 * lines; null when the text is not in that form (an owner's note) — show it raw.
 */
export function parseVatEvidence(text: string | null | undefined): EvidenceLine[] | null {
  if (!text || !text.trim()) return null;
  const out: EvidenceLine[] = [];
  for (const part of text.split(';')) {
    const m = part.trim().match(/^(\d{4}|mex)@(\d+(?:\.\d+)?):\s*(\d+)$/);
    if (!m) return null;
    out.push({ kind: m[1] === 'mex' ? 'mex' : 'year', year: m[1] === 'mex' ? null : m[1], rate: Number(m[2]) / 100, lines: Number(m[3]) });
  }
  return out.length ? out : null;
}

// ── the /products filter (owners) ────────────────────────────────────────────

export const VAT_FILTERS = ['all', 'r5', 'r18', 'r10', 'r0', 'none'] as const;
export type VatFilter = (typeof VAT_FILTERS)[number];
export const isVatFilter = (v: unknown): v is VatFilter => typeof v === 'string' && (VAT_FILTERS as readonly string[]).includes(v);

const FILTER_RATE: Record<Exclude<VatFilter, 'all' | 'none'>, VatRate> = { r5: 0.05, r18: 0.18, r10: 0.1, r0: 0 };

export function matchesVat(p: { vat_rate?: unknown }, f: VatFilter | undefined): boolean {
  if (!f || f === 'all') return true;
  const r = vatOf(p);
  return f === 'none' ? r === null : r === FILTER_RATE[f];
}

/** The filter key of a row (for the faceted counts). */
export const vatFilterOf = (p: { vat_rate?: unknown }): Exclude<VatFilter, 'all'> => {
  const r = vatOf(p);
  if (r === null) return 'none';
  return r === 0.05 ? 'r5' : r === 0.18 ? 'r18' : r === 0.1 ? 'r10' : 'r0';
};

/** The chips worth showing: Сите, every rate some product carries, the chosen one, Некласифицирано. */
export const shownVatFilters = (counts: Record<VatFilter, number>, value: VatFilter): VatFilter[] =>
  VAT_FILTERS.filter((k) => k === 'all' || k === 'none' || k === value || counts[k] > 0);

// ── POST /products/vat-rate ──────────────────────────────────────────────────

export interface SetVatResult {
  rate: VatRate | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: { id: string; name: string; from: VatRate | null; to: VatRate | null; from_source: string | null }[];
}

/** Apply the writer's answer to local rows: the new rate, source "owner" (or none when cleared), set now. */
export function applyVatChanges<T extends { id: string; vat_rate?: unknown; vat_source?: unknown; vat_set_at?: unknown }>(
  rows: readonly T[], result: Pick<SetVatResult, 'changes'>, now: Date = new Date(),
): T[] {
  if (!result.changes.length) return rows as T[];
  const to = new Map(result.changes.map((c) => [c.id, c.to]));
  return rows.map((r) => {
    if (!to.has(r.id)) return r;
    const rate = to.get(r.id) ?? null;
    return { ...r, vat_rate: rate, vat_source: rate === null ? null : 'owner', vat_set_at: now.toISOString() } as T;
  });
}
