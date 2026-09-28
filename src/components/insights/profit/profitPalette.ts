/**
 * Colour roles for Pure Profit and Margins — an EMPHASIS form, not a
 * categorical one: the money that came in (collected revenue) and what is
 * left (net profit) carry colour; every cost is the de-emphasis gray. Run
 * through the dataviz skill's validator (scripts/validate_palette.js) against
 * this app's card surfaces, light #ffffff and dark #171b26, pair by pair
 * (the grays are deliberately low-chroma, so the categorical band checks do
 * not apply to them):
 *   revenue ↔ cost   light #059669↔#94a3b8 CVD 12.0 / normal 17.7 ·
 *                    dark  #10b981↔#64748b CVD 16.4 / normal 21.2
 *   cost ↔ net       light #94a3b8↔#334155 CVD 33.9 · dark #64748b↔#cbd5e1 CVD 31.1
 *   net ↔ loss       light #334155↔#dc2626 CVD 13.7 / normal 31.8 ·
 *                    dark  #cbd5e1↔#ef4444 CVD 24.7 / normal 32.1
 *   (emerald ↔ red never touch: revenue is a line / the first bar, a loss is
 *   always the net bar, below the zero line.)
 * Contrast: the light cost gray is 2.56:1 → relief = every bar carries its
 * value in text, and every chart has a table twin. An ESTIMATE (uncosted
 * packages at the view's cost share, allocated costs) is the cost gray with a
 * 45° hatch — texture, never a new hue.
 */

export const PROFIT_COLOR_VARS =
  '[--pp-rev:#059669] dark:[--pp-rev:#10b981] [--pp-cost:#94a3b8] dark:[--pp-cost:#64748b] ' +
  '[--pp-net:#334155] dark:[--pp-net:#cbd5e1] [--pp-loss:#dc2626] dark:[--pp-loss:#ef4444] ' +
  '[--pp-grid:#e5e7eb] dark:[--pp-grid:#262c3b] [--pp-axis:#6b7280] dark:[--pp-axis:#8b93a7]';

/** Literal class strings so Tailwind generates them. */
export const PP_FILL = {
  revenue: 'bg-[#059669] dark:bg-[#10b981]',
  cost: 'bg-[#94a3b8] dark:bg-[#64748b]',
  net: 'bg-[#334155] dark:bg-[#cbd5e1]',
  loss: 'bg-[#dc2626] dark:bg-[#ef4444]',
} as const;

/** The texture channel of an estimate. */
export const PP_HATCH = 'repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 2px, transparent 2px 6px)';

export const ppVar = (k: 'rev' | 'cost' | 'net' | 'loss' | 'grid' | 'axis') => `var(--pp-${k})`;
