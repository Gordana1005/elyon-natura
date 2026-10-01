import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiGetAlterCpaRuns, AlterCpaSyncRun } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { History, Info, Loader2, RefreshCw } from 'lucide-react';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';

const statusBadge: Record<string, string> = {
  ok: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  running: 'bg-amber-500/10 text-amber-600 border-amber-200',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
};

/**
 * The run log.
 *
 * This exists because a silently-truncating sync is otherwise indistinguishable
 * from a quiet day. AlterCPA answers an oversized window with an error OBJECT
 * rather than an array, so code that only checks Array.isArray reads it as
 * end-of-stream and reports success — the exact trap the history export hit. A
 * run that fetched nothing when it should have fetched something is only
 * visible here.
 */
export function SyncRunsTab() {
  const { t } = useTranslation();

  const { data: runs = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['altercpa-runs'],
    queryFn: () => apiGetAlterCpaRuns({ limit: 100 }),
    // Cheap, and a run started from the Accounts tab should appear without a
    // manual reload.
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('altercpa.runsHint')}</p>
        <Button size="sm" variant="outline" className="gap-2" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} /> {t('altercpa.refresh')}
        </Button>
      </div>

      {runs.some((r) => r.status === 'failed') && (
        <Alert variant="destructive">
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">{t('altercpa.runsFailedHint')}</AlertDescription>
        </Alert>
      )}

      {!runs.length ? (
        <EmptyState icon={<History className="h-8 w-8" />} title={t('altercpa.noRuns')} description={t('altercpa.noRunsHint')} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('altercpa.colStarted')}</TableHead>
                <TableHead>{t('altercpa.colKind')}</TableHead>
                <TableHead>{t('altercpa.colWindow')}</TableHead>
                <TableHead className="text-right">{t('altercpa.colFetched')}</TableHead>
                <TableHead className="text-right">{t('altercpa.colNewOrders')}</TableHead>
                <TableHead>{t('altercpa.colSkipped')}</TableHead>
                <TableHead>{t('altercpa.colStatus')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => <RunRow key={r.id} run={r} />)}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: AlterCpaSyncRun }) {
  const { t } = useTranslation();
  const skips = Object.entries(run.skipped || {}).filter(([, n]) => n > 0);

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs">
        {formatSkopje(run.started_at, 'dd.MM.yy HH:mm:ss')}
        {run.duration_ms != null && (
          <div className="text-muted-foreground">{(run.duration_ms / 1000).toFixed(1)}s</div>
        )}
      </TableCell>
      <TableCell><Badge variant="outline">{t(`altercpa.kind_${run.kind}`, run.kind)}</Badge></TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {run.window_from ? formatSkopje(run.window_from, 'dd.MM HH:mm') : '—'}
        {' → '}
        {run.window_to ? formatSkopje(run.window_to, 'dd.MM HH:mm') : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">{run.fetched.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">
        {run.orders_created.toLocaleString()}
        {run.orders_updated > 0 && (
          <div className="text-xs text-muted-foreground">+{run.orders_updated} {t('altercpa.updated')}</div>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {skips.length
          ? skips.map(([k, n]) => (
              <div key={k} className="text-muted-foreground">
                {t(`altercpa.skip_${k}`, k)}: {n.toLocaleString()}
              </div>
            ))
          : '—'}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={statusBadge[run.status]}>{run.status}</Badge>
        {run.error && (
          <div className="mt-1 max-w-[240px] truncate text-xs text-destructive" title={run.error}>
            {run.error}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}
