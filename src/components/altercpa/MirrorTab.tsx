import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  apiGetAlterCpaLeads, apiGetAlterCpaSummary, apiGetAlterCpaAccounts, AlterCpaLead,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SmartPagination } from '@/components/SmartPagination';
import { EmptyState } from '@/components/EmptyState';
import { formatMoney, formatEurExact } from '@/lib/currency';
import { Globe, Loader2, Search } from 'lucide-react';
import { format } from 'date-fns';
import { affiliateLabel } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { cn } from '@/lib/utils';

/** AlterCPA `phase` — their outcome field. 1-5, and the only one worth reading. */
const PHASES = [1, 2, 3, 4, 5] as const;
const SKIPS = ['none', 'not_pending', 'geo_not_callable', 'unmapped_offer', 'test_order', 'no_phone', 'no_fx_rate'] as const;

const phaseBadge: Record<number, string> = {
  1: 'bg-muted text-muted-foreground border-border',
  2: 'bg-amber-500/10 text-amber-600 border-amber-200',
  3: 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))] border-[hsl(var(--success))]/30',
  4: 'bg-destructive/10 text-destructive border-destructive/30',
  5: 'bg-destructive/10 text-destructive border-destructive/30',
};

/**
 * The mirror — every lead AlterCPA has, across every geo, offer and webmaster,
 * including the traffic we deliberately do not call. This is the multi-country
 * report.
 *
 * ⚠️ Money rendering is the subtle part. formatMoney turns a stored EUR value
 * into denars, which is right for Macedonia and WRONG for every other geo: a
 * Romanian lei figure printed with a "ден" suffix is a number nobody can act
 * on. So the customer-facing денар figure is shown only for MK, and every other
 * row shows the raw amount in the currency AlterCPA actually recorded, with the
 * EUR conversion alongside where we have a rate.
 */
export function MirrorTab() {
  const { t } = useTranslation();

  const [fAccount, setFAccount] = useState('all');
  const [fGeo, setFGeo] = useState('all');
  const [fPhase, setFPhase] = useState('all');
  const [fSkip, setFSkip] = useState('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data: accounts = [] } = useQuery({ queryKey: ['altercpa-accounts'], queryFn: apiGetAlterCpaAccounts });
  const accountId = fAccount === 'all' ? undefined : fAccount;

  const { data: summary } = useQuery({
    queryKey: ['altercpa-summary', fAccount],
    queryFn: () => apiGetAlterCpaSummary({ account_id: accountId }),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['altercpa-leads', fAccount, fGeo, fPhase, fSkip, q, page],
    queryFn: () => apiGetAlterCpaLeads({
      account_id: accountId,
      geo: fGeo === 'all' ? undefined : fGeo,
      phase: fPhase === 'all' ? undefined : Number(fPhase),
      skip: fSkip === 'all' ? undefined : fSkip,
      q: q.trim() || undefined,
      page, limit,
    }),
  });

  const rows = data?.rows || [];
  const total = data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const geos = summary?.geos || [];

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); };

  return (
    <div className="space-y-4">
      {/* Rollups. "Ledger only" is the honest name for mirrored-not-called. */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Stat label={t('altercpa.statLeads')} value={summary.totals.leads.toLocaleString()} />
          <Stat label={t('altercpa.statMirrored')} value={summary.totals.mirrored.toLocaleString()} />
          <Stat label={t('altercpa.statLedgerOnly')} value={summary.totals.ledger_only.toLocaleString()} />
          <Stat label={t('altercpa.statGeos')} value={String(summary.totals.geos)} />
          <Stat label={t('altercpa.statOffers')} value={String(summary.totals.offers)} />
          <Stat label={t('altercpa.statWebmasters')} value={String(summary.totals.webmasters)} />
        </div>
      )}

      {/* Country tabs. The network runs many geos and only some are called, so
          each tab shows both numbers: how many leads arrived, and how many
          actually entered the calling pipeline. A country with leads but zero
          called is not broken — it is the mirror-only design working. */}
      {geos.length > 0 && (
        <div className="flex flex-wrap items-stretch gap-2 border-b pb-3">
          <button
            onClick={() => { setFGeo('all'); setPage(1); }}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-accent',
              fGeo === 'all' && 'border-primary bg-accent',
            )}
          >
            <div className="font-semibold">{t('altercpa.allCountries')}</div>
            <div className="text-muted-foreground">
              {(summary?.totals.leads ?? 0).toLocaleString()}
            </div>
          </button>
          {geos.map((g) => (
            <button
              key={g.geo}
              onClick={() => { setFGeo(g.geo); setPage(1); }}
              className={cn(
                'rounded-md border px-3 py-2 text-left text-xs transition-colors hover:bg-accent',
                fGeo === g.geo && 'border-primary bg-accent',
              )}
            >
              <div className="flex items-center gap-1.5 font-semibold">
                {g.geo}
                {g.mirrored > 0 && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--success))]" />
                )}
              </div>
              <div className="text-muted-foreground">
                {g.leads.toLocaleString()}
                {g.mirrored > 0 && (
                  <span className="ml-1 text-[hsl(var(--success))]">
                    · {g.mirrored.toLocaleString()} {t('altercpa.calledShort')}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {accounts.length > 1 && (
          <Select value={fAccount} onValueChange={resetPage(setFAccount)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('altercpa.allAccounts')}</SelectItem>
              {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={fPhase} onValueChange={resetPage(setFPhase)}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder={t('altercpa.phase')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('altercpa.allPhases')}</SelectItem>
            {PHASES.map((p) => <SelectItem key={p} value={String(p)}>{t(`altercpa.phase_${p}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={fSkip} onValueChange={resetPage(setFSkip)}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder={t('altercpa.handling')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('altercpa.allHandling')}</SelectItem>
            {SKIPS.map((sk) => <SelectItem key={sk} value={sk}>{t(`altercpa.skip_${sk}`)}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t('altercpa.searchPlaceholder')}
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !rows.length ? (
        <EmptyState icon={<Globe className="h-8 w-8" />} title={t('altercpa.noLeads')} description={t('altercpa.noLeadsHint')} />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('altercpa.colDate')}</TableHead>
                  <TableHead>{t('altercpa.colGeo')}</TableHead>
                  <TableHead>{t('altercpa.colOffer')}</TableHead>
                  <TableHead>{t('altercpa.colCustomer')}</TableHead>
                  <TableHead>{t('altercpa.colPhase')}</TableHead>
                  <TableHead className="text-right">{t('altercpa.colPrice')}</TableHead>
                  <TableHead>{t('altercpa.colWebmaster')}</TableHead>
                  <TableHead>{t('altercpa.colInCrm')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((l) => <LeadRow key={l.id} lead={l} />)}
              </TableBody>
            </Table>
          </div>
          <SmartPagination page={page} totalPages={pages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

function LeadRow({ lead }: { lead: AlterCpaLead }) {
  // Shared React Query cache — one request for the whole table, not one per row.
  const webmasterNames = useWebmasterNames();
  const { t } = useTranslation();
  const isMk = lead.geo === 'MK';

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {lead.created_remote ? format(new Date(lead.created_remote), 'dd.MM.yy HH:mm') : '—'}
      </TableCell>
      <TableCell><Badge variant="outline">{lead.geo || '??'}</Badge></TableCell>
      <TableCell className="max-w-[220px] truncate text-sm" title={lead.offer_name || ''}>
        {lead.offer_name || '—'}
      </TableCell>
      <TableCell className="text-sm">
        <div className="truncate">{lead.customer_name || '—'}</div>
        {/* The RAW number, always. These are multi-country and were never
            rewritten to a Macedonian prefix — showing a normalized one here
            would be showing a number that does not exist. */}
        <div className="font-mono text-xs text-muted-foreground">{lead.phone_raw || '—'}</div>
      </TableCell>
      <TableCell>
        {lead.phase ? (
          <Badge variant="outline" className={phaseBadge[lead.phase]}>
            {t(`altercpa.phase_${lead.phase}`)}
          </Badge>
        ) : '—'}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right text-sm">
        {isMk && lead.price_eur != null ? (
          // Macedonia only: денари is what the customer and courier see.
          <>
            <div>{formatMoney(Number(lead.price_eur) * lead.quantity)}</div>
            {lead.quantity > 1 && <div className="text-xs text-muted-foreground">×{lead.quantity}</div>}
          </>
        ) : (
          <>
            <div className="font-mono text-xs">
              {Number(lead.price_raw ?? 0).toLocaleString()} {(lead.currency_raw || '').toUpperCase()}
            </div>
            <div className="text-xs text-muted-foreground">
              {lead.price_eur != null
                ? formatEurExact(Number(lead.price_eur) * lead.quantity)
                : t('altercpa.noRate')}
            </div>
          </>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground" title={lead.webmaster ? `#${lead.webmaster}` : undefined}>
        {affiliateLabel(lead.webmaster, webmasterNames)}
      </TableCell>
      <TableCell>
        {lead.orders?.display_id ? (
          <span className="font-mono text-xs">{lead.orders.display_id}</span>
        ) : (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            {t(`altercpa.skip_${lead.skip_reason || 'none'}`)}
          </Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
