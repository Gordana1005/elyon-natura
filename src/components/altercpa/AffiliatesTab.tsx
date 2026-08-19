import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGetAlterCpaWebmasters, apiUpdateAlterCpaWebmaster, AlterCpaWebmaster } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { format } from 'date-fns';
import { Check, Info, Loader2, Users } from 'lucide-react';

/**
 * The affiliate naming queue.
 *
 * AlterCPA identifies an affiliate only by a numeric `wm`. Their merchant API
 * has no directory endpoint — comp/list.json returns no name and comp/stats.json
 * cannot even group by affiliate — so the names exist solely inside their web
 * panel and have to be transcribed once, exactly as the operator directory in
 * scripts/data/altercpa-operators.json was.
 *
 * The sync records every affiliate it sees, so a partner that starts sending
 * traffic tomorrow appears here by itself with an empty name. Unnamed rows sort
 * first: that is the work.
 *
 * Orders store the ID, never the name, so a correction here reaches every
 * historical order the moment it is saved.
 */
export function AffiliatesTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = !!user?.isAdmin;
  const queryClient = useQueryClient();

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['altercpa-webmasters'],
    queryFn: () => apiGetAlterCpaWebmasters(),
  });

  const mutation = useMutation({
    mutationFn: (v: { id: string; name: string }) => apiUpdateAlterCpaWebmaster(v.id, { name: v.name }),
    onSuccess: (_data, v) => {
      // Every surface that renders an affiliate name reads one of these two.
      queryClient.invalidateQueries({ queryKey: ['altercpa-webmasters'] });
      queryClient.invalidateQueries({ queryKey: ['cpa-attribution-dimensions'] });
      setDrafts((d) => { const next = { ...d }; delete next[v.id]; return next; });
      toast({ title: t('common.saved') });
    },
    onError: (err: any) =>
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  // Unnamed first, then by volume — the same ordering rule the offer queue uses,
  // and for the same reason: the biggest unnamed partner is the one to name.
  const sorted = [...rows].sort((a, b) => {
    const an = a.name ? 1 : 0, bn = b.name ? 1 : 0;
    if (an !== bn) return an - bn;
    return Number(b.seen_count || 0) - Number(a.seen_count || 0);
  });
  const unnamed = sorted.filter((r) => !r.name).length;

  const draftFor = (r: AlterCpaWebmaster) => drafts[r.id] ?? (r.name ?? '');
  const isDirty = (r: AlterCpaWebmaster) => drafts[r.id] !== undefined && drafts[r.id] !== (r.name ?? '');

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>{t('altercpa.affiliatesHint')}</AlertDescription>
      </Alert>

      {unnamed > 0 && (
        <div className="text-sm text-muted-foreground">
          <Badge variant="secondary" className="mr-2">{unnamed}</Badge>
          {t('altercpa.affiliatesUnnamed')}
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={t('altercpa.affiliatesEmpty')}
          description={t('altercpa.affiliatesEmptyDesc')}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">{t('altercpa.colWebmaster')}</TableHead>
                <TableHead>{t('altercpa.colAffiliateName')}</TableHead>
                <TableHead className="w-28 text-right">{t('altercpa.colLeads')}</TableHead>
                <TableHead className="w-32">{t('altercpa.colFirstSeen')}</TableHead>
                <TableHead className="w-32">{t('altercpa.colLastSeen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.id} className={!r.name ? 'bg-amber-50/50 dark:bg-amber-950/20' : undefined}>
                  <TableCell className="font-mono text-xs">#{r.wm_id}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        value={draftFor(r)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && isDirty(r)) mutation.mutate({ id: r.id, name: draftFor(r).trim() });
                        }}
                        placeholder={t('altercpa.affiliateNamePlaceholder')}
                        disabled={!isAdmin || mutation.isPending}
                        className="h-8 max-w-xs"
                      />
                      {isDirty(r) && (
                        <Button
                          size="sm"
                          className="h-8"
                          disabled={mutation.isPending}
                          onClick={() => mutation.mutate({ id: r.id, name: draftFor(r).trim() })}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{Number(r.seen_count || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.first_seen_at ? format(new Date(r.first_seen_at), 'dd.MM.yy') : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.last_seen_at ? format(new Date(r.last_seen_at), 'dd.MM.yy') : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
