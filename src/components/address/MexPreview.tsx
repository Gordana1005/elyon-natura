import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, Truck } from 'lucide-react';
import { buildMexImportColumns, type MexImportOrder } from '@/lib/mexImportCsv';
import { cn } from '@/lib/utils';

/**
 * The address exactly as the MEX import file will carry it — the SAME formatters
 * the /orders "MEX Import CSV" runs (src/lib/mexImportCsv.ts: Latin, commas
 * stripped, Grad = the zone's own name). What the agent reads here is what the
 * courier gets.
 */
export function mexPreviewFields(o: MexImportOrder): { adresa: string; grad: string; opis: string } {
  const cols = buildMexImportColumns();
  const get = (key: string) => cols.find((c) => c.key === key)?.format?.(o) ?? '';
  return { adresa: String(get('adresa')), grad: String(get('grad')), opis: String(get('opis')) };
}

export function ZoneChip({ zoneName, loading, className }: { zoneName: string | null; loading?: boolean; className?: string }) {
  const { t } = useTranslation();
  const none = !loading && !zoneName;
  return (
    <span
      data-testid="mex-zone-chip"
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        none
          ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300'
          : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300',
        className,
      )}
    >
      <Truck className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">
        {loading ? t('orderForm.address.resolving') : zoneName ? t('orderForm.address.zone', { zone: zoneName }) : t('orderForm.address.noZone')}
      </span>
    </span>
  );
}

export function MexPreview({ draft }: { draft: MexImportOrder }) {
  const { t } = useTranslation();
  const f = useMemo(() => mexPreviewFields(draft), [draft]);
  const rows: [string, string][] = [
    [t('orderForm.preview.address'), f.adresa],
    [t('orderForm.preview.city'), f.grad],
    [t('orderForm.preview.note'), f.opis],
  ];
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-3" data-testid="mex-preview">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <MapPin className="h-3 w-3" aria-hidden /> {t('orderForm.preview.title')}
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className={cn('min-w-0 break-words font-mono', !v && 'text-muted-foreground')}>{v || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
