/**
 * Colour roles for the connected Overview — every value here was run through the
 * dataviz skill's validator (scripts/validate_palette.js) against THIS app's chart
 * surfaces: light card #ffffff, dark card #171b26 (hsl(225 25% 12%)).
 * Colour is never the only channel: every bucket also has a label + value in text,
 * the status buckets carry an icon, and every chart has a table twin.
 *
 * 1. SOURCES — identity, fixed order, never cycled. The owner's order and names
 *    (28.09.2026): AlterCPA · Телешоп – Lead out (elyon_crm) · Телешоп – Lead in
 *    (teleshop_other) · Социјални мрежи (social) · Веб-продавница (web).
 *    altercpa · elyon_crm · teleshop_other · social · web
 *    light #2a78d6 #eb6834 #1baf7a #4a3aa7 #eda100 · dark #3987e5 #d95926 #199e70 #8b5cf6 #c98500
 *    = the reference theme's slots 1, 2, 3, then violet (slot 7) for Social media, and
 *    slot 4 (yellow) for the web shop. With the new order the old hues could not stay:
 *    Lead out (orange) beside Lead in (then yellow) is the pair the reference theme
 *    fails (dark CVD 4.8, light normal 13.7), so Lead in and the web shop swapped hues
 *    (aqua ↔ yellow) — the least repainting that passes (AlterCPA and Lead out keep
 *    theirs); an exhaustive search over the documented hues found nothing that
 *    repaints fewer and stays ≥ 8 CVD.
 *    Social = violet, light #4a3aa7 as documented. Its documented dark step #9085e9
 *    sits 12.3 normal ΔE from the context gray (floor 15), so dark is held at the
 *    same hue one step deeper, #8b5cf6: vs gray CVD 20.8 / normal 21.8. Magenta
 *    (slot 5) collapses beside aqua under deutan (dark ΔE 1.6); green and red fail
 *    the normal floor beside aqua / yellow in dark.
 *    Adjacent (the order above), validated against #ffffff / #171b26: worst CVD
 *    9.2 light / 9.4 dark (target 8), worst normal 27.6 / 26.5 (floor 15), both on
 *    orange↔aqua; violet↔aqua CVD 31.1 / 23.5, normal 35.8 / 31.7 · violet↔yellow
 *    CVD 41.0 / 33.4, normal 45.9 / 34.7 (light / dark). Every hue vs the context
 *    gray: ≥ 8.0 CVD / 15.4 normal both modes. Violet clears 3:1 in both modes.
 *    Light aqua/yellow sit under 3:1 → relief = direct labels + the table views.
 *    The trend small multiples put ONE source hue per panel (plus the context gray),
 *    so the all-pairs cap never binds; the panel title names the source. (Not
 *    adjacent, and failing all-pairs: orange↔yellow (Lead out ↔ web) and dark
 *    violet↔blue (Social ↔ AlterCPA, CVD 4.1) — they meet only when the sources
 *    between them are 0, and every mark carries its source's name.)
 *
 * 2. PIPELINE — an ordinal one-hue ramp (indigo), awaiting → preparing → courier.
 *    light #818cf8 → #4f46e5 → #312e81 · dark #4f46e5 → #818cf8 → #c7d2fe
 *    (dark flips the anchor: further along = lighter). --ordinal: monotone, ΔL ≥ .06,
 *    single hue (2–3°), light end 2.98:1 / 2.73:1.
 *
 * 3. OUTCOME STATUS — delivered = good (emerald), lost = returned (critical red) and
 *    cancelled (serious orange), trashed = neutral slate. Each ships with an icon.
 *    The bar reads like the shop panel: delivered · courier · preparing · awaiting ·
 *    returned · cancelled · trashed · no record (web history). Adjacent in that order: CVD ≥ 15.5, normal ≥ 17.9
 *    (both modes). Because a zero bucket drops out and makes non-neighbours touch, all
 *    pairs were checked too: worst CVD delivered↔cancelled 9.9 light / 7.7 dark (floor
 *    band — legal with the 2px surface gaps + labelled tiles), normal ≥ 16.2.
 *
 * 4. CONTEXT GRAY — "placed" line in the trends and the sparklines: slate-400 #94a3b8,
 *    ≥ 8.0 CVD / 15.4 normal from every source hue in both modes.
 */
import type { OverviewBucketKey, OverviewSourceKey } from '@/lib/api';

export const SOURCE_ORDER: OverviewSourceKey[] = ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web'];

/** CSS custom properties, set once on the Overview root (light + .dark). */
export const OVERVIEW_COLOR_VARS =
  '[--ov-src-altercpa:#2a78d6] [--ov-src-elyon_crm:#eb6834] [--ov-src-teleshop_other:#1baf7a] [--ov-src-social:#4a3aa7] [--ov-src-web:#eda100] ' +
  'dark:[--ov-src-altercpa:#3987e5] dark:[--ov-src-elyon_crm:#d95926] dark:[--ov-src-teleshop_other:#199e70] dark:[--ov-src-social:#8b5cf6] dark:[--ov-src-web:#c98500] ' +
  '[--ov-context:#94a3b8] [--ov-grid:#e5e7eb] dark:[--ov-grid:#262c3b] [--ov-axis:#6b7280] dark:[--ov-axis:#8b93a7]';

export const sourceColorVar = (key: OverviewSourceKey | string) => `var(--ov-src-${key})`;

/** A segment of the outcome bar. `preparing` there = to pack + packed (the shop's
 *  "being prepared"); `no_record` = web history nobody closed. */
export type BarBucket = Exclude<OverviewBucketKey, 'packed'> | 'no_record';

/** Stacked-bar order — the shop panel's: done first, losses last, unknown at the end. */
export const BAR_ORDER: BarBucket[] = [
  'delivered', 'courier', 'preparing', 'awaiting', 'returned', 'cancelled', 'trashed', 'no_record',
];

/** Literal class strings so Tailwind generates them. */
export const BUCKET_TONE: Record<BarBucket, string> = {
  delivered: 'bg-[#059669] dark:bg-[#10b981]',
  courier: 'bg-[#312e81] dark:bg-[#c7d2fe]',
  preparing: 'bg-[#4f46e5] dark:bg-[#818cf8]',
  awaiting: 'bg-[#818cf8] dark:bg-[#4f46e5]',
  returned: 'bg-[#b91c1c] dark:bg-[#ef4444]',
  cancelled: 'bg-[#fb923c] dark:bg-[#fb923c]',
  trashed: 'bg-[#cbd5e1] dark:bg-[#64748b]',
  // stone, not slate: vs trashed CVD 15.3 / normal 15.6 light, 30.7 / 31.7 dark;
  // vs cancelled 12.2 / 15.6 and delivered 9.3 / 17.7 (light), all ≥ 14 dark.
  no_record: 'bg-[#a8a29e] dark:bg-[#d6d3d1]',
};

/** Status text tones (always paired with an icon + a word). */
export const TONE_TEXT = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  critical: 'text-red-700 dark:text-red-400',
  neutral: 'text-muted-foreground',
} as const;
