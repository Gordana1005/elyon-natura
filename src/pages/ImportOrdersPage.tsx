import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Upload, Check, AlertTriangle, Loader2, FileSpreadsheet, PartyPopper } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { isValidPhone } from '@/lib/validation';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiImportOrders, apiGetProducts, type ImportOrderRow, type ImportOrdersResult } from '@/lib/api';

// One parsed row from the uploaded sheet, already mapped onto our import columns.
type PreviewRow = {
  external_order_id: string;
  order_date: string;
  customer_name: string;
  customer_phone: string;
  product_name: string;
  quantity: string;
  price: string;
  status: string;
  customer_city: string;
  customer_address: string;
  postal_code: string;
  note: string;
};

interface RowIssue { type: 'error' | 'warning'; message: string }

const EMPTY: PreviewRow = {
  external_order_id: '', order_date: '', customer_name: '', customer_phone: '',
  product_name: '', quantity: '', price: '', status: '', customer_city: '',
  customer_address: '', postal_code: '', note: '',
};

// Flexible header matching — first column whose header (case-insensitive, trimmed)
// is in the candidate list wins. Lets the Macedonia team hand us English or Albanian
// headers without exact-naming the file.
// Header aliases, matched case-insensitively after trimming. English +
// Macedonian (Cyrillic and common Latin transliterations) + Albanian, so a file
// exported from almost any local system maps without being re-typed first.
const HEADER_MAP: Record<keyof PreviewRow, string[]> = {
  external_order_id: ['external_order_id', 'order_id', 'order id', 'order_no', 'order no', 'order number', 'order #', '#', 'id', 'nr', 'no',
    'нарачка', 'број на нарачка', 'бр', 'бр.', 'нарачка бр', 'порачка', 'broj na naracka', 'naracka',
    'porosia'],
  order_date: ['order_date', 'date', 'data', 'datum', 'date_added', 'dt',
    'датум', 'датум на нарачка'],
  customer_name: ['customer_name', 'name', 'full name', 'fullname', 'client', 'customer',
    'име', 'име и презиме', 'клиент', 'купувач', 'ime', 'ime i prezime', 'klient',
    'emri', 'emri mbiemri'],
  customer_phone: ['customer_phone', 'phone', 'telephone', 'tel', 'number', 'phone number', 'mobile', 'gsm',
    'телефон', 'телефонски број', 'број', 'мобилен', 'telefon', 'mobilen',
    'numri', 'telefoni'],
  product_name: ['product_name', 'product', 'item', 'article', 'produkt',
    'производ', 'артикл', 'proizvod', 'artikl',
    'produkti'],
  quantity: ['quantity', 'qty', 'count', 'pcs',
    'количина', 'кол', 'кол.', 'парчиња', 'kolicina',
    'sasia'],
  price: ['price', 'total', 'amount', 'total price', 'sum', 'value',
    'цена', 'износ', 'вкупно', 'сума', 'cena', 'iznos', 'vkupno',
    'cmimi', 'çmimi'],
  status: ['status', 'state',
    'статус', 'состојба', 'sostojba',
    'statusi', 'gjendja'],
  customer_city: ['customer_city', 'city', 'town',
    'град', 'место', 'grad', 'mesto',
    'qyteti', 'vendi'],
  customer_address: ['customer_address', 'address', 'street',
    'адреса', 'улица', 'adresa', 'ulica',
    'adresë', 'rruga'],
  postal_code: ['postal_code', 'postcode', 'post code', 'zip', 'zip code',
    'поштенски код', 'пошт. код', 'поштенски број', 'postenski kod',
    'kodi postar'],
  note: ['note', 'notes', 'comment', 'comments', 'remark',
    'забелешка', 'коментар', 'напомена', 'zabeleska', 'komentar',
    'koment', 'shenim', 'shënim'],
};

const VALID_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'paid', 'cancelled', 'returned', 'trashed', 'call_again'];
const CHUNK = 200;

// The file's price column is EUR (the stored unit — importOrders.help); the
// preview shows what the CRM will display, in денари. A denar figure typed
// into the file by mistake therefore shows up here 61.5× too large.
function previewPrice(raw: string): string {
  const n = Number(raw.replace(',', '.'));
  return raw.trim() && Number.isFinite(n) ? formatMoney(n) : raw;
}

function pick(row: Record<string, string>, candidates: string[]): string {
  for (const [k, v] of Object.entries(row)) {
    if (candidates.includes(String(k).toLowerCase().trim())) {
      const val = (v ?? '').toString().trim();
      if (val) return val;
    }
  }
  return '';
}

// Mirror of the server's date acceptance (ISO + dd.mm.yyyy variants) so the
// preview can warn before upload. Returns true if the cell looks parseable.
function dateParseable(raw: string): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return true;
  return /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(s);
}

export default function ImportOrdersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [source, setSource] = useState('');
  const [upsertProfiles, setUpsertProfiles] = useState(true);
  const [knownProducts, setKnownProducts] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportOrdersResult | null>(null);

  // Load the catalogue once so the preview can warn when a product name won't
  // match (it still imports — just with no product link). Best-effort; a failed
  // load simply disables the warning.
  useEffect(() => {
    apiGetProducts()
      .then((rows: { name?: string }[]) => setKnownProducts(new Set((rows || []).map((p) => String(p.name || '').toLowerCase().trim()).filter(Boolean))))
      .catch(() => { /* warning stays off */ });
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setSource(file.name.replace(/\.(xlsx?|csv)$/i, ''));

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = evt.target?.result;
      const wb = XLSX.read(data, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });

      const mapped: PreviewRow[] = json.map((row) => {
        const out = { ...EMPTY };
        (Object.keys(HEADER_MAP) as (keyof PreviewRow)[]).forEach((field) => {
          out[field] = pick(row, HEADER_MAP[field]);
        });
        // Fall back to first_name + last_name when there's no single name column.
        if (!out.customer_name) {
          const fn = pick(row, ['first_name', 'firstname', 'first name', 'emri']);
          const ln = pick(row, ['last_name', 'lastname', 'last name', 'mbiemri', 'surname']);
          out.customer_name = `${fn} ${ln}`.trim();
        }
        return out;
      }).filter((r) => r.customer_phone || r.product_name || r.customer_name);

      setPreview(mapped);
    };
    reader.readAsArrayBuffer(file);
  };

  const rowIssues = useMemo(() => {
    const issues = new Map<number, RowIssue[]>();
    const seenOrderIds = new Set<string>();
    preview.forEach((row, i) => {
      const problems: RowIssue[] = [];
      if (!row.customer_phone.trim()) problems.push({ type: 'error', message: t('importOrders.missingPhone') });
      else if (!isValidPhone(row.customer_phone)) problems.push({ type: 'error', message: t('importOrders.invalidPhone') });
      if (!row.product_name.trim()) problems.push({ type: 'error', message: t('importOrders.missingProduct') });
      else if (knownProducts.size > 0 && !knownProducts.has(row.product_name.toLowerCase().trim())) {
        problems.push({ type: 'warning', message: t('importOrders.unknownProduct') });
      }
      if (!row.order_date.trim() || !dateParseable(row.order_date)) problems.push({ type: 'warning', message: t('importOrders.badDate') });
      if (!row.price.trim() || !(Number(row.price.replace(',', '.')) > 0)) problems.push({ type: 'warning', message: t('importOrders.missingPrice') });
      if (row.status.trim() && !VALID_STATUSES.includes(row.status.toLowerCase().trim())) problems.push({ type: 'warning', message: t('importOrders.badStatus') });
      if (!row.external_order_id.trim()) problems.push({ type: 'warning', message: t('importOrders.noOrderId') });
      else if (seenOrderIds.has(row.external_order_id.trim())) problems.push({ type: 'warning', message: t('importOrders.duplicateInFile') });
      else seenOrderIds.add(row.external_order_id.trim());
      if (problems.length) issues.set(i, problems);
    });
    return issues;
  }, [preview, knownProducts, t]);

  const errorCount = useMemo(() => {
    let c = 0;
    rowIssues.forEach((iss) => { if (iss.some((x) => x.type === 'error')) c++; });
    return c;
  }, [rowIssues]);

  const warningCount = useMemo(() => {
    let c = 0;
    rowIssues.forEach((iss) => { if (iss.some((x) => x.type === 'warning') && !iss.some((x) => x.type === 'error')) c++; });
    return c;
  }, [rowIssues]);

  const toRow = (r: PreviewRow): ImportOrderRow => {
    // Sanitize numeric/enum cells so one bad value can't fail-validate the whole
    // chunk server-side. Non-numeric qty/price are dropped (server defaults), and
    // an unrecognized status falls back to the server default rather than erroring.
    const qty = Math.floor(Number(r.quantity));
    const price = Number(r.price.replace(',', '.'));
    const status = r.status.toLowerCase().trim();
    return {
      external_order_id: r.external_order_id || undefined,
      order_date: r.order_date || undefined,
      customer_name: r.customer_name || undefined,
      customer_phone: r.customer_phone,
      product_name: r.product_name || undefined,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : undefined,
      price: Number.isFinite(price) && price >= 0 ? price : undefined,
      status: VALID_STATUSES.includes(status) ? status : undefined,
      customer_city: r.customer_city || undefined,
      customer_address: r.customer_address || undefined,
      postal_code: r.postal_code || undefined,
      note: r.note || undefined,
    };
  };

  const handleImport = async () => {
    if (preview.length === 0 || errorCount > 0) return;
    // Only send rows without blocking errors.
    const sendable = preview.filter((_, i) => !(rowIssues.get(i)?.some((x) => x.type === 'error')));
    const rows = sendable.map(toRow);
    setImporting(true);
    setResult(null);
    const agg: ImportOrdersResult = { success: true, total: 0, created: 0, duplicates: 0, skipped_no_phone: 0, failed: 0 };
    setProgress({ done: 0, total: rows.length });
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        try {
          const res = await apiImportOrders({ source: source.trim() || 'import', upsert_profiles: upsertProfiles, rows: chunk });
          agg.total += res.total;
          agg.created += res.created;
          agg.duplicates += res.duplicates;
          agg.skipped_no_phone += res.skipped_no_phone;
          agg.failed += res.failed;
        } catch (err) {
          agg.total += chunk.length;
          agg.failed += chunk.length;
          toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
        }
        setProgress({ done: Math.min(i + CHUNK, rows.length), total: rows.length });
      }
      setResult(agg);
      toast({ title: t('importOrders.doneTitle'), description: t('importOrders.doneSummary', { created: agg.created, duplicates: agg.duplicates }) });
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const reset = () => {
    setPreview([]);
    setSource('');
    setResult(null);
  };

  return (
    <AppLayout title={t('nav.importOrders')}>
      <div className="mb-6">
        <p className="text-sm text-muted-foreground max-w-3xl">{t('importOrders.subtitle')}</p>
      </div>

      {result ? (
        <div className="rounded-xl border bg-card p-8 shadow-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <PartyPopper className="h-10 w-10 text-green-600" />
            <h2 className="text-lg font-semibold">{t('importOrders.doneTitle')}</h2>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
              <div><span className="block text-2xl font-bold text-green-600">{result.created}</span>{t('importOrders.statCreated')}</div>
              <div><span className="block text-2xl font-bold text-muted-foreground">{result.duplicates}</span>{t('importOrders.statDuplicates')}</div>
              <div><span className="block text-2xl font-bold text-muted-foreground">{result.skipped_no_phone}</span>{t('importOrders.statSkipped')}</div>
              <div><span className={cn('block text-2xl font-bold', result.failed > 0 ? 'text-destructive' : 'text-muted-foreground')}>{result.failed}</span>{t('importOrders.statFailed')}</div>
            </div>
            <Button className="mt-4" onClick={reset}>{t('importOrders.reset')}</Button>
          </div>
        </div>
      ) : preview.length === 0 ? (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/30 p-12 hover:border-primary/50 transition-colors">
          <Upload className="h-10 w-10 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">{t('importOrders.clickSelect')}</span>
          <span className="text-xs text-muted-foreground text-center max-w-md">{t('importOrders.requiredCols')}</span>
          <input type="file" accept=".xls,.xlsx,.csv" className="hidden" onChange={handleFileUpload} />
        </label>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">{t('importOrders.sourceLabel')}</label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-9 w-64 rounded-lg border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('importOrders.sourcePlaceholder')}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={upsertProfiles} onChange={(e) => setUpsertProfiles(e.target.checked)} className="h-4 w-4 rounded border" />
              {t('importOrders.upsertProfiles')}
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Check className="h-4 w-4 text-green-600" />
              {t('importOrders.recordsFound', { count: preview.length })}
            </span>
            {errorCount > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {t('importOrders.nErrors', { count: errorCount })}
              </span>
            )}
            {warningCount > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" />
                {t('importOrders.nWarnings', { count: warningCount })}
              </span>
            )}
          </div>

          <div className="max-h-[28rem] overflow-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colOrderId')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colDate')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colName')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colPhone')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colProduct')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colQty')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colPrice')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colStatus')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colCity')}</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('importOrders.colIssues')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 200).map((row, i) => {
                  const issues = rowIssues.get(i);
                  const hasError = issues?.some((x) => x.type === 'error');
                  return (
                    <tr key={i} className={cn('border-b last:border-0', hasError ? 'bg-destructive/5' : issues ? 'bg-warning/5' : '')}>
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono">{row.external_order_id}</td>
                      <td className="px-3 py-1.5">{row.order_date}</td>
                      <td className={cn('px-3 py-1.5', !row.customer_name.trim() && 'italic text-muted-foreground')}>{row.customer_name || '—'}</td>
                      <td className={cn('px-3 py-1.5 font-mono', !row.customer_phone.trim() && 'italic text-destructive')}>{row.customer_phone || t('importOrders.empty')}</td>
                      <td className={cn('px-3 py-1.5', !row.product_name.trim() && 'italic text-destructive')}>{row.product_name || t('importOrders.empty')}</td>
                      <td className="px-3 py-1.5">{row.quantity}</td>
                      <td className="px-3 py-1.5">{previewPrice(row.price)}</td>
                      <td className="px-3 py-1.5">{row.status}</td>
                      <td className="px-3 py-1.5">{row.customer_city}</td>
                      <td className="px-3 py-1.5">
                        {issues && (
                          <div className="space-y-0.5">
                            {issues.map((x, j) => (
                              <span key={j} className={cn('block text-[10px] leading-tight', x.type === 'error' ? 'text-destructive' : 'text-warning')}>
                                {x.message}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {preview.length > 200 && (
            <p className="text-xs text-muted-foreground">{t('importOrders.previewTruncated', { count: preview.length })}</p>
          )}

          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" onClick={reset} disabled={importing}>{t('common.cancel')}</Button>
            <Button onClick={handleImport} disabled={preview.length === 0 || errorCount > 0 || importing} className="gap-2">
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              {importing
                ? (progress ? t('importOrders.progress', { done: progress.done, total: progress.total }) : t('importOrders.importing'))
                : errorCount > 0
                  ? t('importOrders.fixErrors', { count: errorCount })
                  : t('importOrders.importBtn', { count: preview.length - errorCount })}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-8 flex items-start gap-2 rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
        <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t('importOrders.help')}</p>
      </div>
    </AppLayout>
  );
}
