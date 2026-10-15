/**
 * The Web page's api (naturatherapy.mk, owner 15.10.2026). The totals come from the SAME
 * endpoints Insights uses (GET /insights/cohort?source=web, GET /insights/profit → the web row),
 * the page's own breakdowns from GET /web/page and /web/customers. Types and pure helpers come
 * from the edge function's dependency-free module.
 */
import { apiFetch } from './api';
import type { WebCustomers, WebPage } from '../../supabase/functions/api/web';
import type { Cohort } from '@/components/insights/shared/cohortTypes';

export * from '../../supabase/functions/api/web';

export const apiWebPage = (from: string, to: string, signal?: AbortSignal): Promise<WebPage> =>
  apiFetch(`web/page?${new URLSearchParams({ from, to }).toString()}`, { signal });

export const apiWebCustomers = (signal?: AbortSignal): Promise<WebCustomers> => apiFetch('web/customers', { signal });

/** The web department's cohort — the same call and numbers as Insights. */
export const apiWebCohort = (from: string, to: string, compare: boolean, signal?: AbortSignal): Promise<Cohort> => {
  const qs = new URLSearchParams({ from, to, source: 'web' });
  if (compare) qs.set('compare', '1');
  return apiFetch(`insights/cohort?${qs.toString()}`, { signal });
};
