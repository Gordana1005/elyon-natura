import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetActiveViews, type ActiveViewsByPhone } from '@/lib/api';

const EMPTY: ActiveViewsByPhone = {};

/**
 * "Who is viewing" for every customer on the page in ONE request (it was one
 * request per row every 30 s, each running a cleanup write first). Keyed by
 * the phone's last 8 digits; refreshed every 30 s while the page is visible.
 */
export function useActiveViews(phones: (string | null | undefined)[]): ActiveViewsByPhone {
  const key = useMemo(() => {
    const set = new Set<string>();
    for (const p of phones) {
      const d = (p ?? '').replace(/\D/g, '');
      if (d.length >= 8) set.add(d.slice(-8));
    }
    return [...set].sort();
  }, [phones]);
  const { data } = useQuery({
    queryKey: ['active-views', key.join(',')],
    queryFn: () => apiGetActiveViews(key),
    enabled: key.length > 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
  return data?.views ?? EMPTY;
}
