/**
 * Colour roles for Insights → Агенти. No new hue: every value is one the
 * cohort palette (../shared/cohortPalette.ts) or the Overview (../overview/
 * palette.ts) already validated with the dataviz validator against this app's
 * card surfaces (light #ffffff, dark #171b26).
 *
 * DECISIONS (the work ledger's outcomes) reuse the leads funnel's order and
 * steps (CohortSecondary.tsx LEADS_PARTS): sale = the cohort's paid emerald ·
 * callback = its to_pack indigo (open) · cancel = the owner's RED (Откажани) ·
 * trash = the owner's GREY (Во корпа). Adjacent CVD ≥ 20.2 light / 10.7 dark;
 * all pairs ≥ 8.6 light, dark sale~cancel 7.4 (floor band — the 2 px gaps, the
 * worded legend and the table view carry it). Re-run 2026-09-28:
 * validate_palette.js "#059669,#dc2626,#cbd5e1,#f59e0b" --pairs all → CVD PASS.
 *
 * CREDITED SALES per day is one series → the same emerald (a sale), no legend
 * box (the title names it). Sources keep the Overview's identity hues.
 */
import { COHORT_TONE, OUTSIDE_TONE } from '../shared/cohortPalette';

export const DECISIONS = ['sale', 'callback', 'cancel', 'trash'] as const;
export type DecisionKey = (typeof DECISIONS)[number];

/** Literal class strings (Tailwind generates them). */
export const DECISION_TONE: Record<DecisionKey, string> = {
  sale: COHORT_TONE.paid,
  callback: COHORT_TONE.to_pack,
  cancel: OUTSIDE_TONE.cancelled_after_sale,
  trash: OUTSIDE_TONE.trashed,
};

/** The same roles as CSS variables for the charts (set once on the tab root). */
export const AGENTS_COLOR_VARS =
  '[--ag-sale:#059669] dark:[--ag-sale:#10b981] [--ag-callback:#818cf8] dark:[--ag-callback:#4f46e5] ' +
  '[--ag-cancel:#dc2626] dark:[--ag-cancel:#ff5a4f] [--ag-trash:#cbd5e1] dark:[--ag-trash:#64748b]';

export const decisionVar = (k: DecisionKey) => `var(--ag-${k})`;
