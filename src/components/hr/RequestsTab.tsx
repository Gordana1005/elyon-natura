import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { Chip } from '@/components/assigner/parts';
import { apiHrRequests } from '@/lib/hrApi';
import { RequestList } from './RequestList';

/**
 * Барања — the requests waiting for a decision (the team step, then the manager step) or the
 * whole year's, in the viewer's scope. A manager can enter one for anyone ("Внеси отсуство").
 */
export function RequestsTab({ year, viewerFinal, canEnter, onEnter, onChanged }: {
  year: number;
  viewerFinal: boolean;
  canEnter: boolean;
  onEnter: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const q = useQuery({ queryKey: ['hr', 'requests', status, year], queryFn: () => apiHrRequests({ status, year }) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label={t('hrPage.requests.filter')}>
          <Chip on={status === 'open'} onClick={() => setStatus('open')}>{t('hrPage.requests.open')}</Chip>
          <Chip on={status === 'all'} onClick={() => setStatus('all')}>{t('hrPage.requests.all', { year })}</Chip>
        </div>
        {canEnter && (
          <Button type="button" variant="outline" size="sm" className="ml-auto h-9" onClick={onEnter}>
            <CalendarPlus className="h-4 w-4" aria-hidden /> {t('hrPage.requests.enter')}
          </Button>
        )}
      </div>
      {q.isError && !q.data ? (
        <LoadError text={t('hrPage.loadFailed')} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="grid gap-2 lg:grid-cols-2" aria-hidden>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-28" />)}</div>
      ) : (
        <RequestList requests={q.data.requests} showName viewerFinal={viewerFinal}
          emptyText={status === 'open' ? t('hrPage.requests.noneOpen') : t('hrPage.requests.none')}
          onChanged={onChanged} />
      )}
    </div>
  );
}
