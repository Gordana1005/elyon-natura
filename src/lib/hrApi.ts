/**
 * The HR page's api (Човечки ресурси, owner 15.10.2026; migration 20261016120000). Same base URL
 * and auth as every other call (apiFetch). The types and pure helpers come from the edge
 * function's own dependency-free module, so the page previews exactly what the server counts.
 */
import { apiFetch } from './api';
import type {
  HrBalance, HrCalendar, HrEmployee, HrHoliday, HrMe, HrRequest, LeaveRequestBody,
} from '../../supabase/functions/api/hr';

export * from '../../supabase/functions/api/hr';

const qs = (params: Record<string, string | number | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export interface WriteResult {
  request: HrRequest;
  stage: string;
  shifts_removed?: number;
  shifts_restored?: number;
}

export const apiHrMe = (year?: number): Promise<HrMe> => apiFetch(`hr/me${qs({ year })}`);
export const apiHrCalendar = (from: string, to: string): Promise<HrCalendar> => apiFetch(`hr/calendar${qs({ from, to })}`);
export const apiHrRequests = (p: { status?: 'open' | 'all'; year?: number; employee_id?: string } = {}): Promise<{ requests: HrRequest[] }> =>
  apiFetch(`hr/requests${qs(p)}`);
export const apiHrCreateRequest = (body: Partial<LeaveRequestBody>): Promise<WriteResult> =>
  apiFetch('hr/requests', { method: 'POST', body: JSON.stringify(body) });
export const apiHrDecide = (id: string, decision: 'approve' | 'reject', note?: string | null): Promise<WriteResult> =>
  apiFetch(`hr/requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note: note ?? null }) });
export const apiHrCancel = (id: string, note?: string | null): Promise<WriteResult> =>
  apiFetch(`hr/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({ note: note ?? null }) });

export interface HrEmployeesResult {
  employees: HrEmployee[];
  /** Active logins, for linking an employee to a CRM account (dossier viewers only). */
  logins?: { user_id: string; name: string }[];
}
export const apiHrEmployees = (all = false): Promise<HrEmployeesResult> => apiFetch(`hr/employees${qs({ status: all ? 'all' : null })}`);
export const apiHrSaveEmployee = (id: string | null, data: Record<string, unknown>): Promise<{ id: string; changed: string[]; employee: HrEmployee }> =>
  apiFetch(id ? `hr/employees/${id}` : 'hr/employees', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) });

export const apiHrBalances = (year: number): Promise<{ year: number; balances: HrBalance[] }> => apiFetch(`hr/balances${qs({ year })}`);
export const apiHrSetEntitlement = (body: {
  employee_id: string; year: number; base_days: number | null; extra_days: number; carry_days: number; note?: string | null;
}): Promise<{ balance: HrBalance }> => apiFetch('hr/entitlements', { method: 'PUT', body: JSON.stringify(body) });

export const apiHrHolidays = (year: number): Promise<{ year: number; holidays: HrHoliday[]; can_edit: boolean }> =>
  apiFetch(`hr/holidays${qs({ year })}`);
export const apiHrSaveHoliday = (id: string | null, body: Omit<HrHoliday, 'id'>): Promise<{ holiday: HrHoliday }> =>
  apiFetch(id ? `hr/holidays/${id}` : 'hr/holidays', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
export const apiHrDeleteHoliday = (id: string): Promise<unknown> => apiFetch(`hr/holidays/${id}`, { method: 'DELETE' });
