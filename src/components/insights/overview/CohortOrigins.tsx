import type { CSSProperties } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CohortOrigin, CohortSourceRow } from '../shared/cohortTypes';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { accountParts, originParts } from './cohortOverview';
import { sourceColorVar } from './palette';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The Bio Natural base wears Affiliate's colour, the Natura Therapy base Teleshop's. */
const TONE: Record<'bio_natural' | 'natura', string> = {
  bio_natural: sourceColorVar('altercpa'),
  natura: sourceColorVar('teleshop_other'),
};
const tileStyle = (c: string): CSSProperties => ({
  borderColor: `color-mix(in srgb, ${c} 55%, transparent)`,
  background: `color-mix(in srgb, ${c} 9%, transparent)`,
});

/**
 * "Од која база се нарачките" at the TOP of the two Out departments (owner 15.10.2026: Teleshop Out
 * and Affiliate Out — "многу битен детал", it must be seen at a glance): two big tiles, the Bio
 * Natural base (buyers who first came as Affiliate leads) and the Natura Therapy base (Teleshop
 * buyers of Natura Therapy / Ad Astra, the web shop inside), with orders, share and денари; the
 * new buyers in one line under them. The three add up to the card's total (insights_cohort,
 * 20261015120100). Under them the MEX profile the orders went out on. Nothing is drawn when the
 * payload has no origins (before the first fill, an older api).
 */
export function CohortOrigins({ row, money, f }: { row: CohortSourceRow; money: boolean; f: InsightsFormat }) {
  const parts = originParts(row);
  if (!parts) return null;
  const { t } = f;
  const total = parts.reduce((a, p) => a + p.count, 0);
  const by = (k: string) => parts.find((p) => p.key === k) as CohortOrigin;
  const mixed = parts.reduce((a, p) => a + num(p.mixed), 0);
  const accounts = accountParts(row);
  const nw = by('new');

  return (
    <section
      aria-label={t('overview.cohort.origin.title')}
      className="mt-3"
      data-testid={`origin-${row.key}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 className="text-xs font-semibold text-card-foreground">{t('overview.cohort.origin.title')}</h4>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={t('overview.cohort.origin.hint')}>
          <Info className="h-3 w-3 shrink-0" aria-hidden />{t('overview.cohort.origin.basis')}
        </span>
      </div>

      <ul className="mt-1.5 grid grid-cols-2 gap-2">
        {(['bio_natural', 'natura'] as const).map((k) => {
          const p = by(k);
          const web = num(p.web);
          return (
            <li key={k} className="min-w-0 rounded-lg border-2 px-2.5 py-2" style={tileStyle(TONE[k])} data-testid={`origin-tile-${k}`}>
              <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold leading-tight text-card-foreground">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: TONE[k] }} aria-hidden />
                <span className="min-w-0 break-words">{t(`overview.cohort.origin.key.${k}`)}</span>
              </p>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{t(`overview.cohort.origin.sub.${k}`)}</p>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5">
                <b className="text-2xl font-bold leading-none tabular-nums text-card-foreground">{f.int(p.count)}</b>
                <span className="text-xs text-muted-foreground">{t('overview.cohort.origin.orders', { count: p.count })}</span>
                <span className="ml-auto rounded-full px-1.5 py-px text-xs font-semibold tabular-nums text-card-foreground" style={{ background: `color-mix(in srgb, ${TONE[k]} 22%, transparent)` }}>
                  {f.share(p.count, total)}
                </span>
              </p>
              {money && typeof p.value_mkd === 'number' && (
                <p className="mt-1 text-sm font-semibold tabular-nums text-card-foreground">{f.den(p.value_mkd)}</p>
              )}
              {k === 'natura' && web > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t('overview.cohort.origin.web', { n: f.int(web), count: web })}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className={cn(nw.count === 0 && 'opacity-60')} title={t('overview.cohort.origin.sub.new')}>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-muted-foreground/40 align-middle" aria-hidden />
          {t('overview.cohort.origin.key.new')} <b className="font-semibold tabular-nums text-foreground">{f.int(nw.count)}</b>
          {' '}({f.share(nw.count, total)}){money && typeof nw.value_mkd === 'number' && nw.count > 0 ? ` · ${f.den(nw.value_mkd)}` : ''}
          {num(nw.no_phone) > 0 && ` · ${t('overview.cohort.origin.noPhone', { n: f.int(num(nw.no_phone)), count: num(nw.no_phone) })}`}
        </span>
        {accounts && (
          <span data-testid={`accounts-${row.key}`}>
            {t('overview.cohort.origin.accountsTitle')}:{' '}
            {accounts.map((a) => `${t(`overview.cohort.origin.account.${a.key}`, { defaultValue: a.key })} ${f.int(a.count)}`).join(' · ')}
          </span>
        )}
        {mixed > 0 && <span>{t('overview.cohort.origin.mixed', { n: f.int(mixed), count: mixed })}</span>}
      </div>
    </section>
  );
}
