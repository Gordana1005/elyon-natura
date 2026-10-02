// Bonuses — prediction (Out) milestones (owner 02.10.2026; migration 20260947001100, api bonus.ts).
// Owners set a daily target per department + the € each milestone (1/3, 2/3, 3/3) unlocks; the TV board shows the
// day's progress, the pool and each seller's € share (live = the day's sales; paid = what MEX collected).
import { apiFetch } from '@/lib/api';

export type BonusDepartment = 'teleshop_out' | 'elyon_crm';
export const BONUS_DEPARTMENTS: BonusDepartment[] = ['teleshop_out', 'elyon_crm'];

export interface BonusTarget {
  id: string;
  department: BonusDepartment;
  valid_from: string;
  target_mkd: number;
  m1_eur: number;
  m2_eur: number;
  m3_eur: number;
  note: string | null;
  created_at: string;
}

export interface BonusTargets {
  current: Record<BonusDepartment, BonusTarget | null>;
  upcoming: BonusTarget[];
  history: BonusTarget[];
}

export interface BonusTargetInput {
  department: BonusDepartment;
  valid_from: string;
  target_mkd: number;
  m1_eur: number;
  m2_eur: number;
  m3_eur: number;
  note?: string | null;
}

export const BONUS_QUERY_KEY = ['settings', 'bonus'] as const;

export const apiGetBonusTargets = (): Promise<BonusTargets> => apiFetch('settings/bonus');

export const apiSetBonusTarget = (body: BonusTargetInput): Promise<{ ok: true; target: BonusTarget }> =>
  apiFetch('settings/bonus', { method: 'PUT', body: JSON.stringify(body) });

export interface BoardBonusPerson {
  person_id: string | null;
  value_mkd: number;
  share: number | null;
  bonus_eur: number;
  paid_value_mkd: number;
  paid_bonus_eur: number;
}

export interface BoardBonusDept {
  department: BonusDepartment;
  valid_from: string;
  target_mkd: number;
  thresholds_mkd: number[];
  milestones_eur: number[];
  value_mkd: number;
  reached: number;
  pool_eur: number;
  paid_value_mkd: number;
  paid_reached: number;
  paid_pool_eur: number;
  people: BoardBonusPerson[];
}

export interface BoardBonus { day: string; departments: BoardBonusDept[] }

/** A seller's € on the board (live and paid), summed over the departments she sold in; null = no bonus row. */
export function bonusForPerson(bonus: BoardBonus | null | undefined, personId: string | null | undefined):
  { bonus_eur: number; paid_bonus_eur: number } | null {
  if (!bonus || !personId) return null;
  let found = false;
  let live = 0;
  let paid = 0;
  for (const d of bonus.departments) {
    for (const p of d.people) {
      if (p.person_id === personId) { found = true; live += p.bonus_eur; paid += p.paid_bonus_eur; }
    }
  }
  return found ? { bonus_eur: Math.round(live * 100) / 100, paid_bonus_eur: Math.round(paid * 100) / 100 } : null;
}

/** The departments the board shows a strip for: the chosen one, or both Out departments on "Сите". */
export function bonusDepartmentsFor(bonus: BoardBonus | null | undefined, department: string | null): BoardBonusDept[] {
  if (!bonus) return [];
  if (!department) return bonus.departments;
  return bonus.departments.filter((d) => d.department === department);
}

/** Progress 0–1 (capped) of a department toward its target. */
export const bonusProgress = (d: Pick<BoardBonusDept, 'value_mkd' | 'target_mkd'>): number =>
  d.target_mkd > 0 ? Math.max(0, Math.min(1, d.value_mkd / d.target_mkd)) : 0;
