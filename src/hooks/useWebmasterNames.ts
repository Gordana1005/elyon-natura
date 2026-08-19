import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetAlterCpaWebmasters } from '@/lib/api';
import type { WebmasterNames } from '@/lib/orderSource';

/**
 * wm_id → affiliate name, for every surface that would otherwise print a bare
 * number: the /orders source cell and expanded panel, the AlterCPA mirror, and
 * the rate-guarantee table.
 *
 * A hook rather than a prop because the consumers are leaf components
 * (MirrorTab's LeadRow, a row inside RatesTab) several levels below where the
 * data would have to be fetched. React Query dedupes the request across all of
 * them, so this is one call per page regardless of how many rows render.
 *
 * The endpoint is admin/manager only. `enabled` lets a caller skip it entirely
 * for roles that will never see a name — a 403 per page load is noise.
 */
export function useWebmasterNames(enabled = true): WebmasterNames {
  const { data } = useQuery({
    queryKey: ['altercpa-webmasters'],
    queryFn: () => apiGetAlterCpaWebmasters(),
    enabled,
    staleTime: 300_000,
  });
  return useMemo(() => {
    const m: WebmasterNames = {};
    for (const w of data || []) m[w.wm_id] = w.name;
    return m;
  }, [data]);
}
