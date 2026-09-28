// Export the Pure Profit tab over the selected date range as Excel (default,
// one sheet per section) or CSV (one file, SECTION header rows, ';' + BOM for
// Excel). Sections are toggleable. Numbers in Excel are real numbers so
// they can be summed/filtered/formatted. Money is stored EUR; the Summary
// section also carries MKD, derived at the frozen 61.5 rate.
// The xlsx library (~430 kB) is loaded on demand, only when exporting Excel.
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { toCsv, downloadCsv, type CsvColumn } from '@/lib/csv';
import { eurToDen } from '@/lib/currency';
import { cn } from '@/lib/utils';
import type { InsightsResponse } from '@/lib/api';
import type { DateRange } from '@/components/DateRangePicker';

const n2 = (v: number | undefined | null) => Math.round((Number(v) || 0) * 100) / 100;

type SectionKey = 'summary' | 'products' | 'logistics' | 'commissions';
type Section = { name: string; rows: Record<string, unknown>[]; widths: number[] };

// Dialog labels are translated (ppExport.section.*); the FILE's sheet names and
// column headers stay English on purpose (elyon-i18n: export file content).
const SECTIONS: { key: SectionKey }[] = [
  { key: 'summary' }, { key: 'products' }, { key: 'logistics' }, { key: 'commissions' },
];

export default function PureProfitExportDialog({ data, range }: { data: InsightsResponse; range: DateRange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [picked, setPicked] = useState<Record<SectionKey, boolean>>({
    summary: true, products: true, logistics: true, commissions: true,
  });

  const toggle = (k: SectionKey, v: boolean) => setPicked(p => ({ ...p, [k]: v }));
  const anyPicked = SECTIONS.some(s => picked[s.key]);

  // One source of truth for both formats: each picked section becomes
  // uniform row objects (column header → value).
  const buildSections = (): Section[] => {
    const pp = data.pure_profit;
    const out: Section[] = [];

    if (picked.summary && pp) {
      const vatPct = Math.round((pp.vat_rate ?? 0.18) * 100);
      // Denars only. The figures are stored in EUR but this report goes to
      // Macedonian readers, and a two-currency sheet invites someone to quote
      // the wrong column.
      // Money rows fill 'MKD'; the count / percentage rows below fill their
      // own column, so the MKD header never labels a count.
      const money = (metric: string, eur: number) => ({
        'Metric': metric, 'MKD': eurToDen(eur), 'Count / %': '',
      });
      // Unchecked topics disappear from the Summary too (e.g. a report shared
      // without commission info must not carry the commissions line). Clear
      // profit is then relabeled and adjusted so the visible rows still sum
      // exactly — never show a total whose hidden parts can be derived.
      const commissions = pp.agent_commissions ?? pp.special_agent_commissions ?? 0;
      const shipping = (pp.delivery_cost ?? 0) + (pp.return_loss ?? 0);
      const rows: Record<string, unknown>[] = [
        money('Cash collected (paid orders)', pp.cash_collected ?? 0),
        money(`VAT (${vatPct}% included in price)`, -(pp.vat ?? 0)),
        money('Product cost (COGS)', -(pp.cogs ?? 0)),
      ];
      if (picked.logistics) {
        rows.push(money('Delivery cost', -(pp.delivery_cost ?? 0)));
        rows.push(money('Return loss (round-trip)', -(pp.return_loss ?? 0)));
      }
      if (picked.commissions) rows.push(money('Agent commissions', -commissions));
      const excluded = [
        ...(picked.logistics ? [] : ['shipping']),
        ...(picked.commissions ? [] : ['agent commissions']),
      ];
      const clear = (pp.clear_profit ?? 0)
        + (picked.logistics ? 0 : shipping)
        + (picked.commissions ? 0 : commissions);
      rows.push(money(excluded.length ? `Clear profit (excl. ${excluded.join(' & ')})` : 'Clear profit', clear));
      rows.push(
        // Counts and percentages, not money — their own column.
        { 'Metric': 'Paid orders', 'MKD': '', 'Count / %': pp.paid_orders ?? 0 },
        { 'Metric': 'Paid packages', 'MKD': '', 'Count / %': pp.paid_packages ?? 0 },
        { 'Metric': 'Cost coverage %', 'MKD': '', 'Count / %': n2((pp.cost_coverage ?? 1) * 100) },
      );
      out.push({ name: 'Summary', widths: [40, 16, 12], rows });
    }

    if (picked.products && pp?.by_product?.length) {
      out.push({
        name: 'Products',
        widths: [36, 10, 8, 14, 13, 13, 16, 11, 12, 15],
        rows: pp.by_product.map(p => ({
          'Product': p.product,
          'Packages': p.packages,
          'Orders': p.orders,
          'Unit Price (MKD)': eurToDen(p.unit_price),
          'Unit Cost (MKD)': p.unit_cost > 0 ? eurToDen(p.unit_cost) : '',
          'Revenue (MKD)': eurToDen(p.revenue),
          'Net Revenue (MKD)': eurToDen(p.net_revenue ?? p.revenue),
          'Cost (MKD)': eurToDen(p.cogs),
          'Profit (MKD)': eurToDen(p.profit),
          'Net Profit (MKD)': eurToDen(p.net_profit ?? p.profit),
        })),
      });
    }

    if (picked.logistics && data.logistics?.length) {
      out.push({
        name: 'Shipping by Courier',
        widths: [12, 10, 10, 10, 18, 16, 12],
        rows: data.logistics.map(l => ({
          'Courier': l.courier,
          'Service': l.service,
          'Delivered': l.delivered,
          'Returned': l.returned,
          'Delivery Cost (MKD)': eurToDen(l.deliver_cost),
          'Return Loss (MKD)': eurToDen(l.return_cost),
          'Total (MKD)': eurToDen(l.total_cost),
        })),
      });
    }

    if (picked.commissions) {
      const agents = (data.agents || [])
        .filter((a: any) => (a.payout_earned ?? 0) > 0)
        .sort((a: any, b: any) => (b.payout_earned ?? 0) - (a.payout_earned ?? 0));
      if (agents.length) {
        out.push({
          name: 'Agent Commissions',
          widths: [24, 13, 14],
          rows: agents.map((a: any) => ({
            'Agent': a.name,
            'Payout (MKD)': eurToDen(a.payout_earned),
            'Packages Sold': a.packages_sold ?? a.units ?? 0,
          })),
        });
      }
    }

    return out;
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const sections = buildSections();
      if (!sections.length) return;
      const stamp = range.from || range.to
        ? `${range.from || 'start'}_to_${range.to || 'today'}`
        : 'all-time';

      if (format === 'xlsx') {
        const XLSX = await import('xlsx');
        const wb = XLSX.utils.book_new();
        for (const s of sections) {
          const ws = XLSX.utils.json_to_sheet(s.rows);
          ws['!cols'] = s.widths.map(wch => ({ wch }));
          XLSX.utils.book_append_sheet(wb, ws, s.name);
        }
        XLSX.writeFile(wb, `pure-profit_${stamp}.xlsx`);
      } else {
        const blocks = sections.map((s, i) => {
          const cols: CsvColumn<Record<string, unknown>>[] =
            Object.keys(s.rows[0]).map(k => ({ key: k, header: k }));
          // BOM only on the first block so Excel sees exactly one.
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
        <div className="text-xs text-muted-foreground -mt-2">
          {t('ppExport.period', {
            range: range.from || range.to
              ? `${range.from ? range.from.split('-').reverse().join('.') : '…'} → ${range.to ? range.to.split('-').reverse().join('.') : t('ppExport.today')}`
              : t('ppExport.allTime'),
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            onClick={() => setFormat('xlsx')}
            className={cn(
              'flex items-center gap-2 rounded-md border p-2.5 text-sm transition-colors',
              format === 'xlsx' ? 'border-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
            <span>Excel (.xlsx)<span className="block text-[11px] font-normal text-muted-foreground">{t('ppExport.sheetPerSection')}</span></span>
          </button>
          <button
            type="button"
            onClick={() => setFormat('csv')}
            className={cn(
              'flex items-center gap-2 rounded-md border p-2.5 text-sm transition-colors',
              format === 'csv' ? 'border-primary bg-primary/5 font-medium' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <FileText className="h-4 w-4 text-sky-600" />
            <span>CSV<span className="block text-[11px] font-normal text-muted-foreground">{t('ppExport.forImports')}</span></span>
          </button>
        </div>
        <div className="space-y-3 py-2">
          {SECTIONS.map(s => (
            <div key={s.key} className="flex items-start gap-3">
              <Checkbox
                id={`exp-${s.key}`}
                checked={picked[s.key]}
                onCheckedChange={(v) => toggle(s.key, v === true)}
                className="mt-0.5"
              />
              <Label htmlFor={`exp-${s.key}`} className="font-normal cursor-pointer">
                <span className="font-medium">{t(`ppExport.section.${s.key}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`ppExport.section.${s.key}Hint`)}</span>
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
