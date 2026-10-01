import type { ShopDocRow } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { hasKey, numOrNull } from './shopsModel';
import { Section } from './parts';
import type { ShopsFormat } from './useShopsFormat';

/**
 * A shop's goods documents (in / out / counts): time, collabBox type and number, Natura's Sigma
 * invoice when known, signed units (+ into the shop, − out of it) and, for owners, the value.
 * A table from md, cards below.
 */
export function DocList({ id, title, subtitle, rows, f }: { id: string; title: string; subtitle?: string; rows: ShopDocRow[]; f: ShopsFormat }) {
  const { t } = f;
  const money = rows.some((r) => hasKey(r, 'value_mkd'));
  const signed = (n: number) => (n > 0 ? `+${f.int(n)}` : n < 0 ? `−${f.int(Math.abs(n))}` : '0');
  const value = (r: ShopDocRow) => {
    const v = numOrNull(r.value_mkd);
    return v == null ? '—' : v < 0 ? `−${f.den(Math.abs(v))}` : f.den(v);
  };
  const units = rows.reduce((a, r) => a + (numOrNull(r.units) ?? 0), 0);

  return (
    <Section id={id} title={title} subtitle={rows.length ? t('shops.detail.docsSummary', { n: f.int(rows.length), units: signed(units) }) : subtitle}>
      {rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-4 text-center text-sm text-muted-foreground">{t('shops.detail.noDocs')}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">{t('shops.detail.colDate')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('shops.detail.colType')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('shops.detail.colDoc')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('shops.detail.colNatura')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.detail.colUnits')}</th>
                  {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('shops.detail.colValue')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.doc}-${r.at}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{f.dayTime(r.at)}</td>
                    <td className="px-2 py-2">
                      <span>{r.type_name}</span> <span className="font-mono text-[11px] text-muted-foreground">{r.type}</span>
                    </td>
                    <td className="break-all px-2 py-2 font-mono text-xs">{r.doc}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{r.natura_doc ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className={cn('whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums', r.units < 0 && 'text-muted-foreground')}>{signed(r.units)}</td>
                    {money && <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{value(r)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map((r) => (
              <li key={`${r.doc}-${r.at}`} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{r.type_name} <span className="font-mono text-[11px] text-muted-foreground">{r.type}</span></div>
                    <div className="text-xs tabular-nums text-muted-foreground">{f.dayTime(r.at)}</div>
                  </div>
                  <span className={cn('shrink-0 text-base font-semibold tabular-nums', r.units < 0 && 'text-muted-foreground')}>{signed(r.units)}</span>
                </div>
                <div className="mt-1 break-all font-mono text-xs">{r.doc}</div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('shops.detail.colNatura')}: <span className="font-mono text-foreground">{r.natura_doc ?? '—'}</span></span>
                  {money && <span className="tabular-nums text-foreground">{value(r)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
