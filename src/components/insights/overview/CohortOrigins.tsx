import type { CSSProperties } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CohortSourceRow } from '../shared/cohortTypes';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { accountParts, originParts } from './cohortOverview';
import { sourceColorVar } from './palette';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Bio Natural wears Тим Маџари's colour, Natura Therapy / Ad Astra Тим Центар's; "new" stays grey. */
const DOT: Record<string, { style?: CSSProperties; className?: string }> = {
  bio_natural: { style: { background: sourceColorVar('altercpa') } },
  natura: { style: { background: sourceColorVar('teleshop_other') } },
  new: { className: 'bg-muted-foreground/40' },
};

/**
 * "Од каде се купувачите" in a department card (owner 15.10.2026, Тим Центар Out and its mirror Тим
 * Маџари Out): the department's sales by where each buyer FIRST came from — Bio Natural (a Тим
 * Маџари / affiliate lead), Natura Therapy / Ad Astra (teleshop, social, the web shop) or new. The
 * three add up to the card's total (insights_cohort, 20261015120100); денари for owners. Under them
 * the MEX profile the sales went out on — the post alone cannot tell the origin (~14 % differ).
 * Nothing is drawn when the payload has no origins (before the first fill, an older api).
 */
export function CohortOrigins({ row, money, f }: { row: CohortSourceRow; money: boolean; f: InsightsFormat }) {
  const parts = originParts(row);
  if (!parts) return null;
  const { t } = f;
  const total = parts.reduce((a, p) => a + p.count, 0);
  const byValue = money && parts.every((p) => p.count === 0 || typeof p.value_mkd === 'number');
  const weight = (p: (typeof parts)[number]) => (byValue ? Math.max(0, num(p.value_mkd)) : p.count);
  const sumW = parts.reduce((a, p) => a + weight(p), 0);
  const mixed = parts.reduce((a, p) => a + num(p.mixed), 0);
  const accounts = accountParts(row);

  return (
    <section
      aria-label={t('overview.cohort.origin.title')}
      className="mt-2 rounded-lg border border-dashed px-2.5 py-2"
      data-testid={`origin-${row.key}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.cohort.origin.title')}</h4>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={t('overview.cohort.origin.hint')}>
          <Info className="h-3 w-3 shrink-0" aria-hidden />{t('overview.cohort.origin.basis')}
        </span>
      </div>

      {sumW > 0 && (
        <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          {parts.filter((p) => weight(p) > 0).map((p) => (
            <div
              key={p.key}
              className={cn('h-full border-r-2 border-card last:border-r-0', DOT[p.key]?.className)}
              style={{ width: `${(weight(p) / sumW) * 100}%`, ...DOT[p.key]?.style }}
            />
          ))}
        </div>
      )}

      <ul className="mt-1.5 space-y-0.5">
        {parts.map((p) => {
          const web = num(p.web);
          const noPhone = num(p.no_phone);
          return (
            <li key={p.key} className={cn('min-w-0', p.count === 0 && 'opacity-55')}>
              <div className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-tight text-muted-foreground">
                  <span className={cn('h-2 w-2 shrink-0 translate-y-[-1px] rounded-full', DOT[p.key]?.className)} style={DOT[p.key]?.style} aria-hidden />
                  <span className="min-w-0 break-words">{t(`overview.cohort.origin.key.${p.key}`, { defaultValue: p.key })}</span>
                </span>
                <b className="shrink-0 text-sm font-semibold tabular-nums text-card-foreground">{f.int(p.count)}</b>
                <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{f.share(p.count, total)}</span>
                {money && (
                  <span className="w-[5.75rem] shrink-0 text-right tabular-nums text-muted-foreground sm:w-28">
                    {typeof p.value_mkd === 'number' ? f.den(p.value_mkd) : '—'}
                  </span>
                )}
              </div>
              {p.key === 'natura' && web > 0 && (
                <p className="pl-[0.875rem] text-[11px] text-muted-foreground">{t('overview.cohort.origin.web', { n: f.int(web), count: web })}</p>
              )}
              {p.key === 'new' && noPhone > 0 && (
                <p className="pl-[0.875rem] text-[11px] text-muted-foreground">{t('overview.cohort.origin.noPhone', { n: f.int(noPhone), count: noPhone })}</p>
              )}
            </li>
          );
        })}
      </ul>

      {(accounts || mixed > 0) && (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          {accounts && (
            <span data-testid={`accounts-${row.key}`}>
              {t('overview.cohort.origin.accountsTitle')}:{' '}
              {accounts.map((a) => `${t(`overview.cohort.origin.account.${a.key}`, { defaultValue: a.key })} ${f.int(a.count)}`).join(' · ')}
            </span>
          )}
          {mixed > 0 && <span>{t('overview.cohort.origin.mixed', { n: f.int(mixed), count: mixed })}</span>}
        </p>
      )}
    </section>
  );
}
