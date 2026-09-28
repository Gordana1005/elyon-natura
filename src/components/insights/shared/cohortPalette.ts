/**
 * Colour roles for the sales cohort (CohortBar, SourceTable, the leads funnel).
 * Every hex here was run through the dataviz skill's validator
 * (scripts/validate_palette.js; its OKLab ΔE ×100 under Machado 2009 CVD)
 * against THIS app's card surfaces: light #ffffff, dark #171b26.
 * Colour is never the only channel: every part has a word, a number and an icon,
 * the bar has 2 px surface gaps, and SourceTable is the table twin.
 *
 * Bar order (fixed, the lifecycle — done first, lost last):
 *   paid · paid_legacy · paid_unproven · courier · courier_problem · label · to_pack · returned
 *   light #059669 #6ee7b7 #dc2626 #312e81 #f59e0b #4f46e5 #818cf8 #f472b6
 *   dark  #10b981 #047857 #dc2626 #c7d2fe #fbbf24 #818cf8 #4f46e5 #db2777
 *
 * - Status roles: paid = good (emerald), paid_legacy = the same hue a step
 *   lighter (light) / darker (dark) — still paid, labelled, not an alarm;
 *   paid_unproven = critical red WITH a 45° hatch + OctagonAlert (it should
 *   read 0); courier_problem = warning amber (MEX 3/9/13); returned = PINK
 *   (owner rule: Вратени = pink dot, Откажани = red dot).
 * - Pipeline: to_pack → label → courier is the Overview's ordinal indigo ramp
 *   (--ordinal PASS both modes: monotone L, ΔL ≥ .06, hue spread 2–3°, light
 *   end 2.98:1 / 2.73:1). Dark flips the anchor: further along = lighter.
 * - Adjacent pairs (the stack): light worst CVD 10.2 (to_pack~returned), normal
 *   18.4; dark worst CVD 8.6 (paid_legacy~paid_unproven), normal 18.4 — all PASS.
 * - A zero part drops out, so non-neighbours can touch; all pairs were checked:
 *   light worst CVD 8.6 / normal 17.9 (PASS everywhere). Dark worst CVD 8.6;
 *   one pair sits under the normal floor — paid_unproven~returned 10.1 — and they
 *   touch only when every in-flight part is 0 AND unproven > 0; the hatch +
 *   icon + labelled tiles carry that case. (A lighter dark pink fixes it but
 *   drops paid~returned — the pair every closed-out period shows — to CVD 6.3.)
 * - Contrast: light paid_legacy 1.52, courier_problem 2.15, to_pack 2.98,
 *   returned 2.65 and dark to_pack 2.73 sit under 3:1 → relief = the labelled
 *   tiles and the table (never colour alone).
 *
 * Outside the total (dots beside words, never touching fills):
 *   cancelled_after_sale RED light #dc2626 / dark #ff5a4f (owner: Откажани =
 *   red) · trashed_after_sale and trashed leads GREY #cbd5e1 / #64748b (Во
 *   корпа) · replacement slate #64748b / #94a3b8. Dark red↔pink is CVD 13.2 /
 *   normal 13.7 — the word beside each dot carries it.
 */
import type { CohortBucketKey, CohortOutsideKey } from './cohortTypes';

/** Literal class strings so Tailwind generates them. */
export const COHORT_TONE: Record<CohortBucketKey, string> = {
  paid: 'bg-[#059669] dark:bg-[#10b981]',
  paid_legacy: 'bg-[#6ee7b7] dark:bg-[#047857]',
  paid_unproven: 'bg-[#dc2626] dark:bg-[#dc2626]',
  courier: 'bg-[#312e81] dark:bg-[#c7d2fe]',
  courier_problem: 'bg-[#f59e0b] dark:bg-[#fbbf24]',
  label: 'bg-[#4f46e5] dark:bg-[#818cf8]',
  to_pack: 'bg-[#818cf8] dark:bg-[#4f46e5]',
  returned: 'bg-[#f472b6] dark:bg-[#db2777]',
};

/** The texture channel: unproven "paid" is hatched, so it never reads as paid. */
export const COHORT_HATCH: Partial<Record<CohortBucketKey, string>> = {
  paid_unproven: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.55) 0 2px, transparent 2px 6px)',
};

export const OUTSIDE_TONE: Record<CohortOutsideKey | 'trashed', string> = {
  cancelled_after_sale: 'bg-[#dc2626] dark:bg-[#ff5a4f]',
  trashed_after_sale: 'bg-[#cbd5e1] dark:bg-[#64748b]',
  replacement: 'bg-[#64748b] dark:bg-[#94a3b8]',
  trashed: 'bg-[#cbd5e1] dark:bg-[#64748b]',
};

/** Status text tones (always paired with an icon + a word). */
export const STATUS_TEXT = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  critical: 'text-red-700 dark:text-red-400',
  returned: 'text-pink-700 dark:text-pink-400',
  neutral: 'text-muted-foreground',
} as const;
