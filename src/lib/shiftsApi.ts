/**
 * The "Смени" page's api (plan Фаза 8, 30.09.2026). Same base URL and auth as every other
 * call (apiFetch from ./api). The types and the pure helpers come from the edge function's
 * own dependency-free module, so the page stages exactly what the server validates.
 */
import { apiFetch } from './api';
import type {
  GridCell, LoginActivity, MyShiftDay, RunwaySummary, ShiftCellInput, ShiftStatistics, ShiftsGrid,
} from '../../supabase/functions/api/shifts';

export * from '../../supabase/functions/api/shifts';

const qs = (params: Record<string, string | number | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const apiGetShiftsGrid = (from: string, to: string): Promise<ShiftsGrid> =>
  apiFetch(`shifts/grid${qs({ from, to })}`);

export interface SetCellsChange {
  user_id: string;
  date: string;
  before: Omit<GridCell, 'user_id' | 'date'> | null;
  after: Omit<GridCell, 'user_id' | 'date'> | null;
}
export interface SetCellsResult {
  changed: number;
  unchanged: number;
  cells: SetCellsChange[];
  /** The same POST with these cells reverts the save. */
  undo: ShiftCellInput[];
}
export const apiSetShiftCells = (cells: ShiftCellInput[]): Promise<SetCellsResult> =>
  apiFetch('shifts/cells', { method: 'POST', body: JSON.stringify({ cells }) });

export interface CopyRangeResult {
  apply: boolean;
  mode: 'fill_empty' | 'overwrite';
  src: [string, string];
  dst: [string, string];
  counts: { fill: number; replace: number; clear: number; same: number; kept: number };
  people: { user_id: string; name: string; days: number }[];
  cells: ShiftCellInput[];
  changed: number;
  undo: ShiftCellInput[];
}
export const apiCopyShifts = (body: { src_from: string; src_to: string; dst_from: string; mode?: 'fill_empty' | 'overwrite'; apply?: boolean }): Promise<CopyRangeResult> =>
  apiFetch('shifts/copy', { method: 'POST', body: JSON.stringify(body) });

export interface RollMonthPerson {
  user_id: string;
  name: string;
  /** "07:00-21:00" */
  hours: string;
  /** ISO weekdays worked, e.g. "12345" or "1234567". */
  weekdays: string;
  days: number;
  already_covered: number;
}
export interface RollMonthResult {
  apply: boolean;
  name: string;
  src: [string, string];
  dst: [string, string];
  people: RollMonthPerson[];
  excluded: { user_id: string; name: string }[];
  person_days: number;
  skipped_covered: number;
  shifts_created: number;
  assignments_created: number;
  assignments_widened?: number;
}
export const apiRollShiftsMonth = (body: { apply?: boolean; src_from?: string; src_to?: string; dst_from?: string; dst_to?: string }): Promise<RollMonthResult> =>
  apiFetch('shifts/roll-month', { method: 'POST', body: JSON.stringify(body) });

export const apiGetShiftsRunway = (): Promise<RunwaySummary> => apiFetch('shifts/runway');

export const apiGetMyShiftDays = (from: string, to: string): Promise<MyShiftDay[]> =>
  apiFetch(`shifts/my${qs({ from, to })}`);

export const apiGetShiftLoginActivity = (p: { from: string; to: string; agent_id?: string | null; status?: string | null; limit?: number; offset?: number }): Promise<LoginActivity> =>
  apiFetch(`shifts/login-activity${qs({ from: p.from, to: p.to, agent_id: p.agent_id, status: p.status, limit: p.limit, offset: p.offset })}`);

export const apiGetShiftStatistics = (from: string, to: string): Promise<ShiftStatistics> =>
  apiFetch(`shifts/statistics${qs({ from, to })}`);

export interface ShiftTemplateRow { id: string; name: string; start_time: string; end_time: string }
export const apiCreateShiftTemplate = (body: { name: string; start_time: string; end_time: string }): Promise<ShiftTemplateRow> =>
  apiFetch('shift-templates', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateShiftTemplate = (id: string, body: { name?: string; start_time?: string; end_time?: string }): Promise<{ id: string; shifts_updated: number }> =>
  apiFetch(`shift-templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteShiftTemplate = (id: string): Promise<{ success: boolean }> =>
  apiFetch(`shift-templates/${id}`, { method: 'DELETE' });

/** GET /shifts/check-login (the login gate). `code` on a refusal since 01.10.2026. */
export interface ShiftLoginCheck {
  allowed: boolean;
  bypass?: boolean;
  logged?: boolean;
  shift_id?: string;
  shift_date?: string;
  shift_start_time?: string;
  shift_end_time?: string;
  code?: 'no_assignment' | 'no_shift_today' | 'zero_shift' | 'outside_hours';
  windows?: string[];
  next_shift?: { date: string; start: string; end: string } | null;
  message?: string;
}
