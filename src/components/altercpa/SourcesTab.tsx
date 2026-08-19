import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiGetAlterCpaStreamDistribution, AlterCpaStreamDistribution } from '@/lib/api';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { affiliateLabel } from '@/lib/orderSource';
import { statusLabel } from '@/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { format } from 'date-fns';
import { Info, Loader2, Waypoints } from 'lucide-react';

/**
 * The per-publisher distribution — the CRM's counterpart of AlterCPA's
 * "Lead distribution by affiliate traffic sources" panel.
 *
 * Each affiliate sends traffic through one or more sources (streams): the code
 * is the actual publisher/media buyer's placement under that partner. KMA.biz
 * is itself a reseller network, so this code is the only way to tell its
 * buyers apart.
 *
 * RAW CODES ON PURPOSE (operator decision 2026-08-19): the tracking fields are
 * undocumented in AlterCPA's API, no endpoint lists or names streams, and even
 * their own panel renders the bare hashes — so unlike the Affiliates tab there
 * is no naming queue here. Read-only by design.
 */
export function SourcesTab() {
  const { t } = useTranslation();
  const webmasterNames = useWebmasterNames();

  const { data, isLoading } = useQuery<AlterCpaStreamDistribution>({
    queryKey: ['altercpa-stream-distribution'],
    queryFn: apiGetAlterCpaStreamDistribution,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const streams = data?.streams || [];

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>{t('altercpa.sourcesHint')}</AlertDescription>
      </Alert>

      {(data?.total_orders ?? 0) > 0 && (
        <div className="text-sm text-muted-foreground">
          {t('altercpa.sourcesCoverage', {
            attributed: (data?.attributed_orders ?? 0).toLocaleString(),
            total: (data?.total_orders ?? 0).toLocaleString(),
          })}
        </div>
      )}

      {streams.length === 0 ? (
        <EmptyState
          icon={<Waypoints className="h-5 w-5" />}
          title={t('altercpa.sourcesEmpty')}
          description={t('altercpa.sourcesEmptyDesc')}
        />
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('altercpa.colPublisher')}</TableHead>
                <TableHead>{t('ordersPage.colAffiliate')}</TableHead>
                <TableHead className="text-right">{t('altercpa.colOrders')}</TableHead>
                <TableHead className="text-right">{statusLabel('paid')}</TableHead>
                <TableHead className="text-right">{statusLabel('confirmed')}</TableHead>
                <TableHead className="text-right">{statusLabel('cancelled')}</TableHead>
                <TableHead className="text-right">{statusLabel('trashed')}</TableHead>
                <TableHead className="w-24">{t('altercpa.colFirstSeen')}</TableHead>
                <TableHead className="w-24">{t('altercpa.colLastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {streams.map((s) => (
                <TableRow key={`${s.stream_id}|${s.wm_id ?? ''}`}>
                  <TableCell className="font-mono text-xs">{s.stream_id}</TableCell>
                  <TableCell className="text-sm">{affiliateLabel(s.wm_id, webmasterNames)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm font-medium">{s.orders.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{s.paid.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{s.confirmed.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{s.cancelled.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{s.trashed.toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.first_seen ? format(new Date(s.first_seen), 'dd.MM.yy') : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.last_seen ? format(new Date(s.last_seen), 'dd.MM.yy') : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
