import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { fmtPct } from '@/components/insights/overview/model';
import { cohortState, guaranteeMath } from '../../../../supabase/functions/api/altercpaGuarantee';
import { cohortSentence, durationText, minutesBetween, toTargetText, type Sentence } from './guaranteeText';

const SETTINGS = { target: 30, minCohort: 20, settleDays: 3 };
const pct = (x: number | null) => fmtPct(x, 'mk', 1);
const say = (s: Sentence) => i18n.t(s.key, s.vars);
const sentence = (leads: number, counted: number, open: number, age = 0) => {
  const c = { leads, counted, open };
  return say(cohortSentence({ math: guaranteeMath(c, 30), state: cohortState(c, age, SETTINGS) }, 20, pct));
};

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('cohortSentence — the one thing to do (mk)', () => {
  it('under target, reachable: how many of the open to confirm, and how many may still go', () => {
    expect(sentence(40, 8, 4)).toBe('Потврди уште 4 од 4 отворени → 30%');
    expect(sentence(40, 9, 12)).toBe('Потврди уште 3 од 12 отворени → 30% · може да се откажат до 9');
  });

  it('over / on target: every open lead may be cancelled', () => {
    expect(sentence(50, 18, 12)).toBe('Над целта +3 · сите 12 отворени може да се откажат');
    expect(sentence(157, 50, 30)).toBe('Над целта +2 · сите 30 отворени може да се откажат');
    expect(sentence(50, 18, 0)).toBe('Над целта +3');
    expect(sentence(10, 3, 0, 5)).toBe('Премалку лидови (10 < 20)');
    expect(sentence(70, 21, 4)).toBe('Точно на целта · сите 4 отворени може да се откажат');
    expect(sentence(70, 21, 0, 5)).toBe('Точно на целта');
  });

  it('unreachable: the best this cohort can still end at; closed: how far under', () => {
    expect(sentence(40, 8, 3)).toBe('Недостижно со сегашните лидови: најмногу 27,5%');
    expect(sentence(48, 10, 3)).toBe('Недостижно со сегашните лидови: најмногу 27,1%');
    expect(sentence(40, 8, 0, 5)).toBe('Под целта: 20,0% — недостасуваат 4 потврди');
  });

  it('too few leads is never judged', () => {
    expect(sentence(12, 0, 12)).toBe('Премалку лидови (12 < 20)');
  });

  it('never says "На чекање" or "прогноза"', () => {
    const all = [sentence(40, 8, 4), sentence(40, 9, 12), sentence(50, 18, 12), sentence(40, 8, 3), sentence(12, 0, 12)].join(' ');
    expect(all).not.toMatch(/На чекање|рогноз/);
  });
});

describe('the To-30% tile and durations', () => {
  it('"уште 4" under, "+2 над целта" over', () => {
    expect(say(toTargetText(guaranteeMath({ leads: 40, counted: 8, open: 10 }, 30)))).toBe('уште 4');
    expect(say(toTargetText(guaranteeMath({ leads: 157, counted: 50, open: 30 }, 30)))).toBe('+2 над целта');
  });

  it('durations: minutes, hours, days', () => {
    expect(say(durationText(45))).toBe('45 мин');
    expect(say(durationText(130))).toBe('2 ч 10 мин');
    expect(say(durationText(60 * 52))).toBe('2 д 4 ч');
    expect(minutesBetween('2026-10-01T08:00:00Z', '2026-10-01T10:10:00Z')).toBe(130);
    expect(minutesBetween('2026-10-01T10:00:00Z', '2026-10-01T08:00:00Z')).toBeNull();
    expect(minutesBetween(null, '2026-10-01T08:00:00Z')).toBeNull();
  });
});
