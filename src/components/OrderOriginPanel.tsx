import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, PackageCheck } from 'lucide-react';
import { formatDenari } from '@/lib/currency';
import { formatDate } from '@/i18n/dates';
import { departmentLabel, sourceLabel } from '@/lib/orderSource';
import { cn } from '@/lib/utils';

/**
 * "Origin & proof" in the order window (owner, 29.09.2026: "every order source clear — where
 * from, how, who made it, how much money; MEX is the final proof: delivered, when, where, to whom,
 * from whom, at what price"). Renders GET /orders/:id `origin` (order_origin, migration
 * 20260942001600) — admin / manager only; absent → nothing renders.
 */
export interface OrderOrigin {
  department?: string | null;
  intake?: string | null;
  doc_type?: string | null;
  seller?: string | null;
  sold_at?: string | null;
  sold_via?: string | null;
  paid_basis?: string | null;
  price_mkd?: number | null;
  parcel?: {
    tracking?: string | null; account?: string | null; series?: string | null;
    status_id?: number | null; status_name?: string | null; cod_mkd?: number | null;
    receiver_name?: string | null; receiver_city?: string | null;
    created_at?: string | null; delivered_at?: string | null; returned_at?: string | null;
  } | null;
  collabbox?: { doc?: string | null; type?: string | null; type_name?: string | null; author?: string | null; doc_at?: string | null; amount_mkd?: number | null } | null;
  altercpa?: { lead?: string | null; decision?: string | null; decided_at?: string | null; operator?: string | null } | null;
}

const ACCOUNT_LABEL: Record<string, string> = { bio_natural: 'BIO NATURAL', natura: 'NATURA' };
const dt = (v?: string | null) => (v ? formatDate(v, 'dd.MM.yyyy HH:mm') : '—');

export function OrderOriginPanel({ origin, status }: { origin: OrderOrigin | null | undefined; status?: string | null }) {
  const { t } = useTranslation();
  if (!origin) return null;
  const p = origin.parcel;
  const cod = p?.cod_mkd ?? null;
  const price = origin.price_mkd ?? null;
  const codDiffers = cod != null && price != null && cod > 0 && Math.abs(cod - price) > 3 && Math.abs(cod - price - 150) > 3;
  const paidNoProof = !p && (status === 'paid' || status === 'delivered');
  const row = (label: string, value: ReactNode, tone?: string) => (
    <div className="flex items-start justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('text-right font-medium', tone)}>{value}</span>
    </div>
  );
  return (
    <section>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderOrigin.title')}</h3>
      <div className="rounded-lg border bg-card p-3 divide-y divide-border/60">
        <div className="pb-1.5">
          {row(t('orderOrigin.department'), departmentLabel(t, origin.department) || '—')}
          {row(t('orderOrigin.intake'), [sourceLabel(t, origin.intake), origin.sold_via ? t(`orderOrigin.via.${origin.sold_via}`, { defaultValue: origin.sold_via }) : null].filter(Boolean).join(' · '))}
          {row(t('orderOrigin.seller'), origin.seller || '—')}
          {row(t('orderOrigin.soldAt'), dt(origin.sold_at))}
        </div>
        {(origin.altercpa || origin.collabbox) && (
          <div className="py-1.5">
            {origin.altercpa && row('AlterCPA', [
              origin.altercpa.decision ? t(`orderOrigin.decision.${origin.altercpa.decision}`, { defaultValue: origin.altercpa.decision }) : null,
              origin.altercpa.operator, dt(origin.altercpa.decided_at),
            ].filter(Boolean).join(' · '))}
            {origin.collabbox && row('collabBox', [
              origin.collabbox.type_name || origin.collabbox.type, origin.collabbox.author, dt(origin.collabbox.doc_at),
            ].filter(Boolean).join(' · '))}
          </div>
        )}
        <div className="pt-1.5">
          {row(t('orderOrigin.priceCrm'), price != null ? formatDenari(price) : '—')}
          {p ? (
            <>
              {row(t('orderOrigin.codMex'), cod != null ? formatDenari(cod) : '—', codDiffers ? 'text-amber-600' : undefined)}
              {row('MEX', [p.account ? ACCOUNT_LABEL[p.account] ?? p.account : null, p.tracking, p.status_name].filter(Boolean).join(' · '))}
              {row(t('orderOrigin.shippedAt'), dt(p.created_at))}
              {p.delivered_at && row(t('orderOrigin.delivered'), dt(p.delivered_at), 'text-emerald-600')}
              {p.returned_at && row(t('orderOrigin.returned'), dt(p.returned_at), 'text-destructive')}
              {(p.receiver_name || p.receiver_city) && row(t('orderOrigin.receiver'), [p.receiver_name, p.receiver_city].filter(Boolean).join(', '))}
            </>
          ) : (
            <div className={cn('flex items-center gap-1.5 py-1 text-xs', paidNoProof ? 'text-destructive' : 'text-muted-foreground')}>
              {paidNoProof ? <AlertTriangle className="h-3.5 w-3.5" /> : <PackageCheck className="h-3.5 w-3.5" />}
              {paidNoProof ? t('orderOrigin.paidWithoutProof') : t('orderOrigin.noParcel')}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
