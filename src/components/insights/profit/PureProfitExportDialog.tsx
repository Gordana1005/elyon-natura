// Export the Pure Profit tab (both clocks) over the selected period as Excel
// (one sheet per section) or CSV (one file, SECTION rows, ';' + BOM for Excel).
// Every money cell is whole денари straight from the api (never converted
// again); counts and percentages have their own columns. Sheet names and
// column headers stay English on purpose (elyon-i18n: export file content);
// the dialog itself is translated. xlsx (~430 kB) loads only when used.
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { toCsv, downloadCsv, type CsvColumn } from '@/lib/csv';
import { cn } from '@/lib/utils';
import type { PLRow, ProfitResponse } from '@/lib/insightsApi/profit';
import { dm } from '../overview/useOverviewFormat';
import { EXPORT_AFFILIATES_SHEET, EXPORT_SOURCE_NAME } from './profitModel';

type SectionKey = 'summary' | 'products' | 'affiliates';
type Section = { name: string; rows: Record<string, unknown>[]; widths: number[] };
const SECTIONS: SectionKey[] = ['summary', 'products', 'affiliates'];
const pct = (x: number | null | undefined) => (x == null ? '' : Math.round(x * 1000) / 10);

// the owner's department names (28.09.2026) — the export's columns stay English
const SOURCE_NAME: Record<string, string> = EXPORT_SOURCE_NAME;

function plLines(clock: string, rows: PLRow[]): Record<string, unknown>[] {
  const line = (metric: string, get: (r: PLRow) => number | string | null, unit: 'MKD' | 'count' | '%') => {
    const o: Record<string, unknown> = { Clock: clock, Line: metric, Unit: unit };
    for (const r of rows) o[SOURCE_NAME[r.key] ?? r.key] = get(r) ?? '';
    return o;
  };
  // VAT per product from Sigma (01.10.2026): the line, then its part per rate, then what had no rate
  const rates = [...new Set(rows.flatMap((r) => (r.vat_split ?? []).map((p) => p.rate)))].sort((a, b) => a - b);
  const vatAt = (r: PLRow, rate: number) => -(r.vat_split?.find((p) => p.rate === rate)?.vat_mkd ?? 0);
  return [
    line('Sales', (r) => r.sales, 'count'),
    line('Revenue', (r) => r.revenue_mkd, 'MKD'),
    line('of which card', (r) => r.card_mkd, 'MKD'),
    line('VAT per product, Sigma rates (included in price)', (r) => -r.vat_mkd, 'MKD'),
    ...rates.map((rate) => line(`  VAT at ${Math.round(rate * 100)}%`, (r) => vatAt(r, rate), 'MKD')),
    line('  VAT on unclassified value (no Sigma rate, at 5%)', (r) => (r.vat_unclassified ? -r.vat_unclassified.vat_mkd : null), 'MKD'),
    line('Unclassified value (no Sigma rate)', (r) => r.vat_unclassified?.revenue_mkd ?? null, 'MKD'),
    line('Product cost (known)', (r) => -r.cogs_known_mkd, 'MKD'),
    line('Product cost (estimated, uncosted packages)', (r) => (r.cogs_est_mkd == null ? null : -r.cogs_est_mkd), 'MKD'),
    line('Gifts and extra packed goods (collabBox)', (r) => (r.cogs_extra_mkd == null ? null : -r.cogs_extra_mkd), 'MKD'),
    line('Courier (MEX, delivered parcels)', (r) => -r.courier_mkd, 'MKD'),
    line('Returns (MEX return fee)', (r) => -r.returns_mkd, 'MKD'),
    line('Agent commission (current rule)', (r) => -r.commission_mkd, 'MKD'),
    line('Lead cost (not configured)', (r) => -r.lead_cost_mkd, 'MKD'),
    line('Net profit', (r) => r.net_mkd, 'MKD'),
    line('Margin', (r) => pct(r.margin), '%'),
    line('Net profit, uncosted at 0 (upper bound)', (r) => r.net_upper_mkd, 'MKD'),
    line('Margin on costed packages', (r) => pct(r.costed.margin), '%'),
    line('Average sale', (r) => r.aov_mkd, 'MKD'),
    line('Profit per sale', (r) => r.profit_per_sale_mkd, 'MKD'),
    line('Return rate', (r) => pct(r.return_rate), '%'),
    line('Packages', (r) => r.packages, 'count'),
    line('Free packages', (r) => r.free_packages, 'count'),
    line('Cost coverage (packages)', (r) => pct(r.coverage_packages), '%'),
  ];
}

export default function PureProfitExportDialog({ data }: { data: ProfitResponse }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [picked, setPicked] = useState<Record<SectionKey, boolean>>({ summary: true, products: true, affiliates: true });
  const anyPicked = SECTIONS.some((s) => picked[s]);
  const period = data.meta.from === data.meta.to ? dm(data.meta.from, true) : `${dm(data.meta.from, true)} – ${dm(data.meta.to, true)}`;

  const buildSections = (): Section[] => {
    const out: Section[] = [];
    if (picked.summary) {
      out.push({
        name: 'P&L',
        // Clock · Line · Unit, then one column per department (+ Total), wide enough for its name
        widths: [10, 44, 7, 21, 22, 21, 20, 14, 14, 14],
        rows: [
          ...plLines('Cohort (sale day)', [...data.cohort.by_source, data.cohort.total]),
          ...plLines('Cash (MEX delivery day)', [...data.cash.by_source, data.cash.total]),
        ],
      });
    }
    if (picked.products && data.products.length) {
      const rows = [...data.products, ...(data.products_others ? [data.products_others] : [])];
      out.push({
        name: 'Products',
        widths: [40, 12, 10, 8, 14, 13, 14, 14, 14, 10, 12, 12, 16, 14, 9, 10],
        rows: rows.map((p) => ({
          'Product': p.key === '__mex_only__' ? 'MEX parcels without an order (contents unknown)' : p.key === '__others__' ? 'Others' : (p.name ?? p.key),
          'Kind': p.kind,
          'Packages': p.package ? p.packages : '',
          'Free': p.free_packages,
          'Revenue (MKD)': p.revenue_mkd,
          'Cost / package (MKD)': p.unit_cost_mkd ?? '',
          'Product cost (MKD)': p.cost_known || p.cost_partial ? p.cogs_mkd : '',
          'Estimated cost (MKD)': p.cost_known ? '' : (p.cogs_est_mkd ?? ''),
          'Extra packed goods (MKD)': p.cogs_extra_mkd ?? '',
          // per product from Sigma (01.10.2026); "no" = no rate on file, taxed at the default
          'VAT rate %': p.vat_rate == null ? '' : Math.round(p.vat_rate * 100),
          'VAT rate from Sigma': p.vat_classified === undefined ? '' : p.vat_classified ? 'yes' : 'no',
          'VAT (MKD)': p.vat_mkd,
          'Courier+commission (MKD)': p.courier_mkd + p.commission_mkd,
          'Net (MKD)': p.net_mkd,
          'Margin %': pct(p.margin),
          'Returned packages': p.returned_packages,
        })),
      });
    }
    if (picked.affiliates && data.cohort.affiliates.length) {
      out.push({
        name: EXPORT_AFFILIATES_SHEET,
        widths: [24, 10, 10, 10, 14, 14, 9],
        rows: data.cohort.affiliates.map((a) => ({
          'Webmaster': a.key === '__none__' ? 'No webmaster on file' : (a.name ?? `WM ${a.key}`),
          'Id': a.key === '__none__' ? '' : a.key,
          'Sales': a.sales_total,
          'Collected': a.pl.sales,
          'Revenue (MKD)': a.pl.revenue_mkd,
          'Net before lead cost (MKD)': a.pl.net_mkd,
          'Return rate %': pct(a.pl.return_rate),
        })),
      });
    }
    return out;
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const sections = buildSections();
      if (!sections.length) return;
      const stamp = `${data.meta.from}_to_${data.meta.to}`;
      if (format === 'xlsx') {
        const XLSX = await import('xlsx');
        const wb = XLSX.utils.book_new();
        for (const s of sections) {
          const ws = XLSX.utils.json_to_sheet(s.rows);
          ws['!cols'] = s.widths.map((wch) => ({ wch }));
          XLSX.utils.book_append_sheet(wb, ws, s.name);
        }
        XLSX.writeFile(wb, `pure-profit_${stamp}.xlsx`);
      } else {
        const blocks = sections.map((s, i) => {
          const cols: CsvColumn<Record<string, unknown>>[] = Object.keys(s.rows[0]).map((k) => ({ key: k, header: k }));
          return `SECTION;${s.name}\r\n${toCsv(s.rows, cols, ';', i === 0)}`;
        });
        downloadCsv(`pure-profit_${stamp}.csv`, blocks.join('\r\n\r\n'));
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" /> {t('ppExport.openBtn')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('ppExport.title')}</DialogTitle>
        </DialogHeader>
        <div className="-mt-2 text-xs text-muted-foreground">{t('ppExport.period', { range: period })}</div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          {(['xlsx', 'csv'] as const).map((fmt) => (
            <button key={fmt} type="button" onClick={() => setFormat(fmt)}
              className={cn('flex items-center gap-2 rounded-md border p-2.5 text-sm transition-colors',
                format === fmt ? 'border-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:bg-muted/50')}>
              {fmt === 'xlsx' ? <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> : <FileText className="h-4 w-4 text-sky-600" />}
              <span>{fmt === 'xlsx' ? 'Excel (.xlsx)' : 'CSV'}
                <span className="block text-[11px] font-normal text-muted-foreground">{fmt === 'xlsx' ? t('ppExport.sheetPerSection') : t('ppExport.forImports')}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="space-y-3 py-2">
          {SECTIONS.map((s) => (
            <div key={s} className="flex items-start gap-3">
              <Checkbox id={`pp-exp-${s}`} checked={picked[s]} onCheckedChange={(v) => setPicked((p) => ({ ...p, [s]: v === true }))} className="mt-0.5" />
              <Label htmlFor={`pp-exp-${s}`} className="cursor-pointer font-normal">
                <span className="font-medium">{t(`insights.profit.export.${s}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`insights.profit.export.${s}Hint`)}</span>
              </Label>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={doExport} disabled={!anyPicked || busy} className="gap-2">
            <Download className="h-4 w-4" /> {busy ? t('ppExport.exporting') : t('ppExport.exportBtn', { fmt: format === 'xlsx' ? 'Excel' : 'CSV' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
