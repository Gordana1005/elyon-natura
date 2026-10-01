import { useTranslation } from 'react-i18next';
import { BadgeCheck } from 'lucide-react';
import type { OpenLeadView } from '@/lib/altercpaGuaranteeApi';
import { CrmChip, Dur, MexChip, skopjeHm } from './bits';

/**
 * A webmaster's OPEN leads of the day (AlterCPA has not decided them yet), oldest first:
 * when each arrived, how long it has waited, the offer, the stream, the customer (masked by the
 * server for a viewer without the name privilege) and the CRM order. "CRM потврдена — чека AlterCPA"
 * marks a lead the floor already sold here that AlterCPA still shows open — the one to chase in
 * their panel. A table from lg, cards below.
 */
export function OpenLeadsList({ leads }: { leads: OpenLeadView[] }) {
  const { t } = useTranslation();
  if (!leads.length) return <p className="py-2 text-xs text-muted-foreground">{t('altercpaGuarantee.open.empty')}</p>;

  const flag = (l: OpenLeadView) => l.crm_confirmed && (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
      <BadgeCheck className="h-3 w-3 shrink-0" aria-hidden />{t('altercpaGuarantee.open.crmConfirmed')}
    </span>
  );

  return (
    <>
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="w-16 py-1.5 pr-2 font-medium">{t('altercpaGuarantee.open.arrived')}</th>
              <th scope="col" className="w-24 py-1.5 pr-2 font-medium">{t('altercpaGuarantee.open.age')}</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">{t('altercpaGuarantee.open.offer')}</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">{t('altercpaGuarantee.open.stream')}</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">{t('altercpaGuarantee.open.customer')}</th>
              <th scope="col" className="py-1.5 font-medium">{t('altercpaGuarantee.open.crm')}</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.lead_id} className="border-b align-top last:border-0">
                <td className="py-1.5 pr-2 tabular-nums">{skopjeHm(l.arrived_at)}</td>
                <td className="py-1.5 pr-2 tabular-nums"><Dur min={l.age_min} /></td>
                <td className="break-words py-1.5 pr-2">{l.offer_name}</td>
                <td className="break-all py-1.5 pr-2 font-mono text-[11px] text-muted-foreground">{l.stream}</td>
                <td className="break-words py-1.5 pr-2">{l.customer_name || '—'}</td>
                <td className="py-1.5">
                  <div className="flex flex-col items-start gap-1">
                    <CrmChip displayId={l.display_id} status={l.crm_status} />
                    {l.display_id && <MexChip statusId={l.mex_status_id} trackingId={l.mex_tracking_id} />}
                    {flag(l)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 lg:hidden">
        {leads.map((l) => (
          <li key={l.lead_id} className="rounded-lg border bg-background p-2.5 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <span className="font-medium tabular-nums">{skopjeHm(l.arrived_at)} · <Dur min={l.age_min} /></span>
              <CrmChip displayId={l.display_id} status={l.crm_status} />
            </div>
            <div className="mt-1 break-words">{l.offer_name}</div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-muted-foreground">
              <span className="break-all font-mono text-[11px]">{l.stream}</span>
              {l.customer_name && <span className="break-words">· {l.customer_name}</span>}
            </div>
            {(l.crm_confirmed || l.display_id) && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {l.display_id && <MexChip statusId={l.mex_status_id} trackingId={l.mex_tracking_id} />}
                {flag(l)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
