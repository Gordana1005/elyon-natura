import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Loader2, Receipt } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import {
  parseVatEvidence, ratePct, UNCLASSIFIED_VAT_TONE, VAT_RATES, VAT_TONES, vatOf, vatSourceOf, type VatRate,
} from '@/lib/products/vat';
import type { CatalogueRow } from '@/lib/products/kinds';

const chipBase = 'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium tabular-nums';

/** A rate's word ("5%") or "Некласифицирано". */
function useVatLabel() {
  const { t } = useTranslation();
  return (rate: VatRate | null) => (rate === null ? t('products.vat.none') : ratePct(rate));
}

const HINT: Record<VatRate, string> = { 0.05: 'products.vat.hint5', 0.18: 'products.vat.hint18', 0.1: 'products.vat.hint10', 0: 'products.vat.hint0' };

/**
 * The four rates (each with what it is for) and "unclassified". A click picks
 * at once; the caller saves through POST /products/vat-rate (owners, audited).
 */
export function VatOptions({ current, onPick }: {
  /** undefined = several products with different rates (nothing is marked). */
  current: VatRate | null | undefined;
  onPick: (rate: VatRate | null) => void;
}) {
  const { t } = useTranslation();
  const option = 'flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div role="group" aria-label={t('products.colVat')} className="flex flex-col gap-1">
      {VAT_RATES.map((r) => {
        const on = current === r;
        return (
          <button key={r} type="button" aria-pressed={on} onClick={() => onPick(r)}
            className={cn(option, on ? VAT_TONES[r] : 'border-transparent hover:bg-muted')}>
            <span className="w-10 shrink-0 font-semibold tabular-nums">{ratePct(r)}</span>
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{t(HINT[r])}</span>
            {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
          </button>
        );
      })}
      <button type="button" aria-pressed={current === null} onClick={() => onPick(null)}
        className={cn(option, 'text-muted-foreground', current === null ? UNCLASSIFIED_VAT_TONE : 'border-transparent hover:bg-muted')}>
        <span className="min-w-0 flex-1">{t('products.vat.clear')}</span>
        {current === null && <Check className="h-4 w-4 shrink-0" aria-hidden />}
      </button>
    </div>
  );
}

/** Where the rate came from: the Sigma item, how it was linked, the invoice lines that prove it. */
export function VatDetails({ p }: { p: Pick<CatalogueRow, 'vat_rate' | 'vat_source' | 'vat_sigma_code' | 'vat_sigma_name' | 'vat_evidence' | 'vat_set_at'> }) {
  const { t } = useTranslation();
  const src = vatSourceOf(p.vat_source);
  const evidence = parseVatEvidence(p.vat_evidence);
  const rate = vatOf(p);
  const srcText = !src ? null
    : src.kind === 'crosswalk' ? t('products.vat.src.crosswalk', { conf: src.detail ?? '—' })
      : src.kind === 'manual' ? t('products.vat.src.manual')
        : src.kind === 'byName' ? t('products.vat.src.byName')
          : src.kind === 'byNameMixed' ? t('products.vat.src.byNameMixed')
            : src.kind === 'rule' ? t('products.vat.src.rule', { rule: src.detail ?? '' })
              : src.kind === 'owner' ? t('products.vat.src.owner') : src.detail;
  return (
    <div className="space-y-1.5 text-xs">
      {rate === null && <p className="text-muted-foreground">{t('products.vat.unclassifiedHint')}</p>}
      {srcText && (
        <p><span className="text-muted-foreground">{t('products.vat.source')}: </span><span className="break-words">{srcText}</span></p>
      )}
      {p.vat_sigma_code && (
        <p className="break-words">{t('products.vat.sigmaItem', { code: p.vat_sigma_code, name: p.vat_sigma_name ?? '' })}</p>
      )}
      {evidence ? (
        <div>
          <p className="text-muted-foreground">{t('products.vat.evidence')}</p>
          <ul className="mt-0.5 space-y-0.5 tabular-nums">
            {evidence.map((e, i) => (
              <li key={i}>
                {e.kind === 'mex'
                  ? t('products.vat.evidenceMex', { pct: ratePct(e.rate), n: e.lines })
                  : t('products.vat.evidenceYear', { year: e.year, pct: ratePct(e.rate), n: e.lines })}
              </li>
            ))}
          </ul>
        </div>
      ) : p.vat_evidence ? <p className="break-words text-muted-foreground">{p.vat_evidence}</p> : null}
      {p.vat_set_at && <p className="text-muted-foreground">{t('products.vat.setAt', { date: formatDate(p.vat_set_at, 'dd.MM.yyyy') })}</p>}
    </div>
  );
}

/**
 * A product's VAT rate (owners only — the api sends the columns to owners alone).
 * Editable: a button that opens the details and VatOptions; else the details on
 * click as well (read-only). Never colour alone: the chip always says the rate.
 */
export function VatChip({ p, editable, busy, onPick, size = 'sm' }: {
  p: CatalogueRow;
  editable: boolean;
  busy?: boolean;
  onPick: (rate: VatRate | null) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const label = useVatLabel();
  const [open, setOpen] = useState(false);
  const rate = vatOf(p);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={busy}
          aria-label={t('products.vat.setFor', { name: p.name })}
          title={t('products.vat.setFor', { name: p.name })}
          data-testid="vat-chip"
          className={cn(
            chipBase,
            // 36 px touch target below lg, the table's 28 px from lg
            size === 'md' ? 'h-9 text-xs lg:h-7' : 'h-9 text-[11px] lg:h-7',
            'transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
            rate === null ? UNCLASSIFIED_VAT_TONE : VAT_TONES[rate],
          )}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Receipt className="h-3 w-3 opacity-70" aria-hidden />}
          {label(rate)}
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] space-y-2.5 p-2.5">
        <p className="break-words px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('products.vat.setFor', { name: p.name })}
        </p>
        <div className="px-1"><VatDetails p={p} /></div>
        {editable && (
          <>
            <VatOptions current={rate} onPick={(r) => { setOpen(false); onPick(r); }} />
            <p className="px-1 text-[11px] leading-snug text-muted-foreground">{t('products.vat.note')}</p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
