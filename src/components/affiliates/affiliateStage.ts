// Affiliate display stages — PAYMENT truth shared by the partner portal and
// the staff Dashboard tab. 'hold' renders as "Approved": payout is earned at
// the FIRST confirmation and is sticky, so the edge fn folds paid / returned /
// cancelled-after-confirm orders into it; cancel/trash here mean killed
// BEFORE confirm. Postback event codes are a separate, unchanged vocabulary
// (logistics truth) — do not reuse these for the postback log.
import type { AffiliateStats } from '@/lib/api';

export const AFFILIATE_STAGES = ['wait', 'hold', 'cancel', 'trash'] as const;

export const stageBadgeClass: Record<string, string> = {
  wait: 'bg-slate-500/10 text-slate-600 border-slate-200',
  hold: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  cancel: 'bg-destructive/10 text-destructive border-destructive/30',
  trash: 'bg-muted text-muted-foreground border-border',
};

/**
 * Fold the two retired stages onto 'hold' before any badge/label lookup.
 *
 * The edge function stopped emitting `approve`/`return` when payout moved to
 * earn-at-confirmation, and their i18n keys are gone with them — but the SPA
 * and the function deploy separately, and the deploy order is function FIRST.
 * If that order is ever reversed, or a stale bundle is served during the
 * window, an unmapped stage would render the raw key string ("affiliate.stage.
 * approve") in the partner's face. The i18n keys-used test cannot catch it
 * either: it only scans for literally-written key strings, and every stage
 * label in this app is looked up through an interpolated template instead.
 * Both old values meant "was confirmed", which is exactly 'hold' now, so this
 * is a lossless one-way fold. Delete it once both repos are past the
 * transitional release. (MK addition — worth back-porting to Elyon BG.)
 */
export const normalizeStage = (stage: string | null | undefined): string =>
  stage === 'approve' || stage === 'return' ? 'hold' : (stage || 'wait');

/** Approve rate = ever-confirmed share of everything sent. */
export const approveRatePct = (t?: AffiliateStats | null): number =>
  t && t.sent > 0 ? Math.round((t.approved / t.sent) * 100) : 0;

/** Buyout rate (informational only — payout no longer depends on it) = paid share of the approved pool. */
export const buyoutRatePct = (t?: AffiliateStats | null): number =>
  t && t.approved > 0 ? Math.round((t.paid / t.approved) * 100) : 0;
