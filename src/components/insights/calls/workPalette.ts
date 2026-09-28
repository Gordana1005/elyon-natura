/**
 * Colour roles for Insights → Work. Every hex here was run through the dataviz
 * skill's validator (scripts/validate_palette.js, OKLab ΔE ×100 under Machado
 * 2009 CVD) against THIS app's card surfaces: light #ffffff, dark #171b26.
 * Colour is never the only channel: every outcome has a word and a number
 * beside it, bars have 2 px surface gaps, and every chart has a table twin.
 *
 * OUTCOMES (a decision's result, fixed order — reached-and-won first, junk last):
 *   sale · callback · no_answer · cancel · trash
 *   light #059669 #818cf8 #eda100 #dc2626 #cbd5e1
 *   dark  #10b981 #6366f1 #fbbf24 #ff5a4f #64748b
 * - Status roles shared with the cohort: sale = good (the cohort's paid emerald),
 *   cancel = the cohort's cancelled red (owner rule: Откажани = red), trash = the
 *   cohort's grey (Во корпа = grey). The grey is a neutral on purpose, so it
 *   "fails" the categorical lightness / chroma band by design (as in the cohort).
 * - callback = the Overview's indigo (awaiting) — "not decided yet";
 *   no_answer = the reference palette's yellow (light) / amber-400 (dark).
 * - All pairs (a zero part drops out, so any two can touch): light worst CVD
 *   8.6 (sale↔cancel), normal ≥ 20.9 — PASS; dark worst CVD 7.4 (sale↔cancel,
 *   floor band → legal only with the secondary channels above), normal ≥ 16.9.
 * - Contrast: light callback 2.98 and no_answer 2.17, trash 1.48 sit under 3:1
 *   → relief = the labelled legend with counts + the table view.
 *
 * HEAT (hour × person) — sequential, one hue (blue), 5 bins, zero = the muted
 * surface. light #60a5fa #3b82f6 #2563eb #1e40af #172554 · dark #1d4ed8 #3b82f6
 * #60a5fa #93c5fd #dbeafe (dark flips: more = lighter). --ordinal PASS in both
 * modes (monotone L, ΔL ≥ .06, hue spread ≤ 16°, light end 2.54 : 1 / 2.57 : 1).
 *
 * PRESENCE — the Overview TeamsBoard's: active emerald-500, idle amber-400,
 * break sky-500 (the same words and shapes as "Кој работи").
 */
import type { WorkOutcomeKey } from './workModel';

/** Literal class strings so Tailwind generates them. */
export const OUTCOME_TONE: Record<WorkOutcomeKey, string> = {
  sale: 'bg-[#059669] dark:bg-[#10b981]',
  callback: 'bg-[#818cf8] dark:bg-[#6366f1]',
  no_answer: 'bg-[#eda100] dark:bg-[#fbbf24]',
  cancel: 'bg-[#dc2626] dark:bg-[#ff5a4f]',
  trash: 'bg-[#cbd5e1] dark:bg-[#64748b]',
};

/** CSS custom properties for the chart fills (recharts takes a colour string). */
export const WORK_COLOR_VARS =
  '[--wk-sale:#059669] [--wk-callback:#818cf8] [--wk-no_answer:#eda100] [--wk-cancel:#dc2626] [--wk-trash:#cbd5e1] ' +
  'dark:[--wk-sale:#10b981] dark:[--wk-callback:#6366f1] dark:[--wk-no_answer:#fbbf24] dark:[--wk-cancel:#ff5a4f] dark:[--wk-trash:#64748b] ' +
  '[--wk-grid:#e5e7eb] dark:[--wk-grid:#262c3b] [--wk-axis:#6b7280] dark:[--wk-axis:#8b93a7] ' +
  // the Overview Sparkline's context gray
  '[--ov-context:#94a3b8]';

export const outcomeVar = (k: WorkOutcomeKey) => `var(--wk-${k})`;

/** Heat bins 1..5 (0 = no activity → the muted surface). */
export const HEAT_TONE = [
  'bg-muted',
  'bg-[#60a5fa] dark:bg-[#1d4ed8]',
  'bg-[#3b82f6] dark:bg-[#3b82f6]',
  'bg-[#2563eb] dark:bg-[#60a5fa]',
  'bg-[#1e40af] dark:bg-[#93c5fd]',
  'bg-[#172554] dark:bg-[#dbeafe]',
] as const;

/** Presence minutes (the TeamsBoard's bar). */
export const PRESENCE_TONE = {
  active: 'bg-emerald-500',
  idle: 'bg-amber-400',
  break: 'bg-sky-500',
} as const;
