import { Link } from 'react-router-dom';
import { ArrowRight, Tv } from 'lucide-react';
import type { ShopsPeriod } from '@/lib/shopsTypes';
import { hasKey, numOrNull, shareOf } from './shopsModel';
import { Section, Stat } from './parts';
import type { ShopsFormat } from './useShopsFormat';

/**
 * "Натура → продавници": what Natura DOO invoiced the shops in Sigma in the period — units for
 * everyone, the invoiced value, Natura's cost and our margin for owners. The TV re-invoicing to
 * Stores is advertising, not goods: shown apart, never inside the margin.
 */
export function NaturaBlock({ natura, deliveriesHref, f }: { natura: ShopsPeriod['natura']; deliveriesHref: string; f: ShopsFormat }) {
  const { t } = f;
  const invoiced = numOrNull(natura.invoiced_ex_vat_mkd);
  const cost = numOrNull(natura.natura_cost_mkd);
  const margin = numOrNull(natura.natura_margin_mkd);
  const ads = numOrNull(natura.ads_reinvoiced_ex_vat_mkd);
  const pending = t('shops.natura.pending');
  return (
    <Section
      id="shops-natura" title={t('shops.natura.title')} subtitle={t('shops.natura.subtitle')}
      actions={(
        <Link to={deliveriesHref} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {t('shops.natura.open')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      )}
    >
      <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-3">
          <Stat label={t('shops.natura.unitsDelivered')} value={f.int(natura.units_delivered)} />
          <Stat label={t('shops.natura.unitsReturned')} value={f.int(natura.units_returned)} />
          {hasKey(natura, 'invoiced_ex_vat_mkd') && <Stat label={t('shops.natura.invoiced')} value={invoiced != null ? f.den(invoiced) : '—'} />}
          {hasKey(natura, 'natura_cost_mkd') && <Stat label={t('shops.natura.cost')} value={cost != null ? f.den(cost) : pending} />}
          {hasKey(natura, 'natura_margin_mkd') && (
            <Stat label={t('shops.natura.margin')}
              value={margin != null ? (
                <>
                  {f.den(margin)}
                  {shareOf(margin, invoiced) != null && <span className="ml-1 text-xs font-normal text-muted-foreground">({f.pct(shareOf(margin, invoiced))})</span>}
                </>
              ) : pending} />
          )}
        </dl>
        {hasKey(natura, 'ads_reinvoiced_ex_vat_mkd') && (
          <div className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs">
            <Tv className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t('shops.natura.ads')}</div>
              <div className="text-muted-foreground">{t('shops.natura.adsHint')}</div>
            </div>
            <div className="font-semibold tabular-nums">{ads != null ? f.den(ads) : '—'}</div>
          </div>
        )}
      </div>
    </Section>
  );
}
