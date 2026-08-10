import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Copy, Inbox, Loader2 } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { AffiliatePortalLead } from '@/lib/api';
import { AFFILIATE_STAGES, normalizeStage, stageBadgeClass } from './affiliateStage';

// Row shape both the portal (phone_masked) and the staff tab (real PII +
// order linkage) satisfy — staff-only fields are optional extras.
export type AffiliateLeadRow = Omit<AffiliatePortalLead, 'phone_masked'> & {
  phone_masked?: string | null;
  customer_phone?: string | null;
  order_id?: string | null;
  display_id?: string | null;
  order_status?: string | null;
  confirmed_at?: string | null;
};

interface AffiliateLeadsTableProps {
  title: string;
  rows: AffiliateLeadRow[];
  isLoading: boolean;
  page: number;
  pages: number;
  total: number;
  onPageChange: (p: number) => void;
  stage: string;
  onStageChange: (s: string) => void;
  fmtMoney: (eur: number) => string;
  /** "Your ID" on the portal, "Ext ID" on the staff tab. */
  extIdLabel: string;
  emptyTitle: string;
  emptyDesc: string;
  /** Staff extras: real customer phone, ORD number + CRM status columns. */
  staffColumns?: boolean;
}

// Leads table + stage filter + pagination, shared by the partner portal and
// the staff Dashboard tab. Stage = payment truth (hold = "Approved", sticky);
// the staff CRM-status column is where cancelled-after-confirm stays visible.
export function AffiliateLeadsTable({
  title, rows, isLoading, page, pages, total, onPageChange,
  stage, onStageChange, fmtMoney, extIdLabel, emptyTitle, emptyDesc, staffColumns,
}: AffiliateLeadsTableProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const colCount = staffColumns ? 10 : 8;

  const copyOrder = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: t('affiliatesAdmin.orderCopied') });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Select value={stage} onValueChange={onStageChange}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('affiliate.allStages')}</SelectItem>
            {AFFILIATE_STAGES.map((s) => <SelectItem key={s} value={s}>{t(`affiliate.stage.${s}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colDate')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{extIdLabel}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colClickid')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colSub1')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colOffer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colCustomer')}</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colPayout')}</th>
                {staffColumns && (
                  <>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colOrder')}</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliatesAdmin.colCrmStatus')}</th>
                  </>
                )}
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('affiliate.colStage')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={colCount} className="py-16 text-center"><Loader2 className="h-6 w-6 animate-spin text-primary inline-block" /></td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="p-0">
                    <EmptyState
                      icon={<Inbox className="h-5 w-5" />}
                      title={emptyTitle}
                      description={emptyDesc}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none py-8"
                    />
                  </td>
                </tr>
              ) : rows.map((l) => {
                const stageKey = normalizeStage(l.stage);
                return (
                  <tr key={l.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(l.created_at), 'MMM d, HH:mm')}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{l.ext_id || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs truncate max-w-[140px]" title={l.clickid || ''}>{l.clickid || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{l.sub1 || '—'}</td>
                    <td className="px-4 py-3">{l.offer_name || '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      {l.customer_name}
                      {staffColumns
                        ? l.customer_phone && <span className="text-muted-foreground ml-1.5 font-mono">{l.customer_phone}</span>
                        : l.phone_masked && <span className="text-muted-foreground ml-1.5 font-mono">{l.phone_masked}</span>}
                    </td>
                    <td className="px-4 py-3 font-semibold">{fmtMoney(l.payout_eur)}</td>
                    {staffColumns && (
                      <>
                        <td className="px-4 py-3">
                          {l.display_id ? (
                            <span className="inline-flex items-center gap-1">
                              <code className="font-mono text-xs">{l.display_id}</code>
                              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copyOrder(String(l.display_id))}>
                                <Copy className="h-3 w-3" />
                              </Button>
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {l.order_status ? (
                            <span className="text-xs text-muted-foreground">{t(`status.${l.order_status}`)}</span>
                          ) : '—'}
                        </td>
                      </>
                    )}
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn('text-xs', stageBadgeClass[stageKey])}>
                        {t(`affiliate.stage.${stageKey}`)}
                      </Badge>
                      {l.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{l.reason}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t('affiliate.pageOf', { page, pages, total })}</span>
          <SmartPagination page={page} totalPages={pages} onPageChange={onPageChange} />
        </div>
      )}
    </div>
  );
}
