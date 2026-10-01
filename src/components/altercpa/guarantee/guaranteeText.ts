/**
 * The ONE action sentence each AlterCPA guarantee cohort gets (plan 01.10.2026,
 * Фаза 4) — what the floor should do to land on the 30%:
 *   "Потврди уште 3 од 12 отворени → 30% · може да се откажат до 9"
 *   "Над целта +3 · сите 12 отворени може да се откажат"
 *   "Недостижно со сегашните лидови: најмногу 27,1%"
 *   "Премалку лидови (12 < 20)"
 * Pure: returns an i18n key + its values (guaranteeText.test.ts renders them).
 */
import type { CohortState, GuaranteeMath } from '@/lib/altercpaGuaranteeApi';

export interface Sentence {
  key: string;
  vars: Record<string, string | number>;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}

const NS = 'altercpaGuarantee.say';

export function cohortSentence(
  v: { state: CohortState; math: GuaranteeMath },
  minCohort: number,
  pct: (fraction: number | null) => string,
): Sentence {
  const m = v.math;
  if (v.state === 'too_few') return { key: `${NS}.tooFew`, vars: { n: m.leads, min: minCohort }, tone: 'muted' };
  if (!m.reachable) {
    if (m.open === 0) return { key: `${NS}.closedBelow`, vars: { rate: pct(m.rate), need: m.need }, tone: 'bad' };
    return { key: `${NS}.unreachable`, vars: { max: pct(m.maxRate) }, tone: 'bad' };
  }
  if (m.need > 0) {
    return m.cancellable > 0
      ? { key: `${NS}.confirmMoreCancellable`, vars: { need: m.need, open: m.open, target: m.target, cancellable: m.cancellable }, tone: 'warn' }
      : { key: `${NS}.confirmMore`, vars: { need: m.need, open: m.open, target: m.target }, tone: 'warn' };
  }
  // At or over the target, C already holds it: every open lead may still be cancelled.
  const margin = m.margin ?? 0;
  if (margin > 0) {
    return m.open > 0
      ? { key: `${NS}.overCancellable`, vars: { margin, open: m.open }, tone: 'good' }
      : { key: `${NS}.over`, vars: { margin }, tone: 'good' };
  }
  return m.open > 0
    ? { key: `${NS}.onTargetCancellable`, vars: { open: m.open }, tone: 'good' }
    : { key: `${NS}.onTarget`, vars: {}, tone: 'good' };
}

/** The "До 30%" tile: "уште 4" under the target, "+2 над целта" at or over it. */
export function toTargetText(m: GuaranteeMath): Sentence {
  if (m.leads === 0) return { key: 'altercpaGuarantee.tile.toTargetNone', vars: {}, tone: 'muted' };
  if (m.need > 0) return { key: 'altercpaGuarantee.tile.toTargetNeed', vars: { n: m.need }, tone: m.reachable ? 'warn' : 'bad' };
  return { key: 'altercpaGuarantee.tile.toTargetOver', vars: { n: m.margin ?? 0 }, tone: 'good' };
}

/** A duration in minutes → an i18n key + values: 45 мин · 2 ч 10 мин · 3 д 4 ч. */
export function durationText(min: number | null | undefined): Sentence {
  const total = Math.max(0, Math.round(Number(min) || 0));
  if (total < 60) return { key: 'altercpaGuarantee.dur.m', vars: { m: total }, tone: 'muted' };
  const h = Math.floor(total / 60);
  if (h < 48) return { key: 'altercpaGuarantee.dur.hm', vars: { h, m: total % 60 }, tone: 'muted' };
  return { key: 'altercpaGuarantee.dur.dh', vars: { d: Math.floor(h / 24), h: h % 24 }, tone: 'muted' };
}

/** Minutes between two instants (null when either is missing or reversed). */
export function minutesBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.floor((b - a) / 60_000);
}

export const SENTENCE_TONE_CLASS: Record<Sentence['tone'], string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  muted: 'text-muted-foreground',
};

/** The rate's colour against the target: green at or over, red under, muted when not judged. */
export function rateToneClass(state: CohortState, m: GuaranteeMath): string {
  if (state === 'too_few' || m.rate == null) return 'text-muted-foreground';
  return m.need === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
}
