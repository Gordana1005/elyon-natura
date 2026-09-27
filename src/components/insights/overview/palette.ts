/**
 * Colour roles for the connected Overview — every value here was run through the
 * dataviz skill's validator (scripts/validate_palette.js) against THIS app's chart
 * surfaces: light card #ffffff, dark card #171b26 (hsl(225 25% 12%)).
 * Colour is never the only channel: every bucket also has a label + value in text,
 * the status buckets carry an icon, and every chart has a table twin.
 *
 * 1. SOURCES — identity, fixed order, never cycled (reference theme slots 1–4).
 *    light #2a78d6 #eb6834 #1baf7a #eda100 · dark #3987e5 #d95926 #199e70 #c98500
 *    Adjacent: CVD ΔE 9.1 light / 8.4 dark (target 8), normal 22.9 / 19.8 (floor 15).
 *    Light aqua/yellow sit under 3:1 → relief = direct labels + the table views.
 *    The trend small multiples put ONE source hue per panel (plus the context gray),
 *    so the all-pairs cap never binds; the panel title names the source.
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

export const SOURCE_ORDER: OverviewSourceKey[] = ['altercpa', 'elyon_crm', 'web', 'teleshop_other'];

/** CSS custom properties, set once on the Overview root (light + .dark). */
export const OVERVIEW_COLOR_VARS =
  '[--ov-src-altercpa:#2a78d6] [--ov-src-elyon_crm:#eb6834] [--ov-src-web:#1baf7a] [--ov-src-teleshop_other:#eda100] ' +
  'dark:[--ov-src-altercpa:#3987e5] dark:[--ov-src-elyon_crm:#d95926] dark:[--ov-src-web:#199e70] dark:[--ov-src-teleshop_other:#c98500] ' +
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
