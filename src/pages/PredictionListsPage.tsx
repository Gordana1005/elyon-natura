import { useState, useEffect, useMemo } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { Upload, Eye, FileSpreadsheet, Check, AlertTriangle, Loader2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatDayDmy } from '@/i18n/dates';
import { EmptyState } from '@/components/EmptyState';
import {
  isValidPhone,
  findDuplicatePhoneIndices,
  hasEmptyRequiredFields,
} from '@/lib/validation';
import { apiGetPredictionLists, apiCreatePredictionList } from '@/lib/api';

type PreviewRow = { name: string; telephone: string; address: string; city: string; product: string };

interface RowIssue {
  type: 'error' | 'warning';
  message: string;
}

interface ListRow {
  id: string;
  name: string;
  uploaded_at: string;
  total_records: number;
  assigned_count: number;
}

export default function PredictionListsPage() {
  const { t } = useTranslation();
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [listName, setListName] = useState('');
  const [, setFileName] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const [error, setError] = useState<string | null>(null);

  const fetchLists = () => {
    setLoading(true);
    setError(null);
    apiGetPredictionLists()
      .then((data) => setLists(data || []))
      .catch((err) => {
        console.error('Failed to load prediction lists:', err);
        setError(err.message || t('predLists.failedLoad'));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchLists(); }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setListName(file.name.replace(/\.(xlsx?|csv)$/i, ''));

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = evt.target?.result;
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws);

      const mapped = json.map((row) => ({
        name: (row['Name'] || row['name'] || row['Nom'] || '').toString().trim(),
        telephone: (row['Telephone'] || row['telephone'] || row['Phone'] || row['phone'] || row['Téléphone'] || '').toString().trim(),
        address: (row['Address'] || row['address'] || row['Adresse'] || '').toString().trim(),
        city: (row['City'] || row['city'] || row['Ville'] || '').toString().trim(),
        product: (row['Product'] || row['product'] || row['Produit'] || '').toString().trim(),
      })).filter(r => r.name || r.telephone);

      setPreview(mapped);
    };
    reader.readAsArrayBuffer(file);
  };

  const rowIssues = useMemo(() => {
    const issues = new Map<number, RowIssue[]>();
    const dupeIndices = findDuplicatePhoneIndices(preview.map(r => r.telephone));

    preview.forEach((row, i) => {
      const rowProblems: RowIssue[] = [];
      if (hasEmptyRequiredFields(row)) rowProblems.push({ type: 'error', message: t('predLists.missingNamePhone') });
      if (row.telephone && !isValidPhone(row.telephone)) rowProblems.push({ type: 'error', message: t('predLists.invalidPhone') });
      if (dupeIndices.has(i)) rowProblems.push({ type: 'warning', message: t('predLists.duplicatePhone') });
      if (rowProblems.length > 0) issues.set(i, rowProblems);
    });
    return issues;
  }, [preview]);

  const errorCount = useMemo(() => {
    let count = 0;
    rowIssues.forEach(issues => { if (issues.some(i => i.type === 'error')) count++; });
    return count;
  }, [rowIssues]);

  const warningCount = useMemo(() => {
    let count = 0;
    rowIssues.forEach(issues => { if (issues.some(i => i.type === 'warning') && !issues.some(i => i.type === 'error')) count++; });
    return count;
  }, [rowIssues]);

  const handleSave = async () => {
    if (!listName.trim() || preview.length === 0) return;
    if (errorCount > 0) {
      toast({ title: t('predLists.cannotSave'), description: t('predLists.fixErrorsDesc', { count: errorCount }), variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await apiCreatePredictionList({ name: listName, entries: preview });
      toast({ title: t('predLists.listImported'), description: t('predLists.recordsSaved', { count: preview.length }) });
      setUploadOpen(false);
      setPreview([]);
      setListName('');
      setFileName('');
      fetchLists();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const resetUpload = () => {
    setUploadOpen(false);
    setPreview([]);
    setFileName('');
    setListName('');
  };

  return (
    <AppLayout title={t('nav.predictionLists')}>
      <div className="mb-6 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('predLists.nLists', { count: lists.length })}</p>
        <Button onClick={() => setUploadOpen(true)} className="gap-2">
          <Upload className="h-4 w-4" /> {t('predLists.uploadExcel')}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchLists}>{t('common.retry')}</Button>
          </div>
        ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('predLists.colListName')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('predLists.colDateUploaded')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('predLists.colTotalRecords')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('predLists.colAssigned')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {lists.map(list => (
              <tr key={list.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium">
                  <span className="inline-flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4 text-primary" />
                    {list.name}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatDayDmy(list.uploaded_at)}</td>
                <td className="px-4 py-3 font-semibold">{list.total_records}</td>
                <td className="px-4 py-3">
                  <span className={cn('text-sm font-medium', list.assigned_count === list.total_records && list.total_records > 0 ? 'text-green-600' : 'text-muted-foreground')}>
                    {list.assigned_count}/{list.total_records}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Link to={`/predictions/${list.id}`} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted transition-colors">
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  </Link>
                </td>
              </tr>
            ))}
            {lists.length === 0 && (
              <tr>
                <td colSpan={5} className="p-0">
                  <EmptyState
                    icon={<FileSpreadsheet className="h-5 w-5" />}
                    title={t('predLists.noLists')}
                    description={t('predLists.uploadToStart')}
                    size="sm"
                    className="border-0 bg-transparent hover:shadow-none"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{t('predLists.uploadTitle')}</DialogTitle>
            <DialogDescription>{t('predLists.uploadColsDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-1 overflow-auto py-2">
            {preview.length === 0 ? (
              <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-muted-foreground/30 p-12 hover:border-primary/50 transition-colors">
                <Upload className="h-10 w-10 text-muted-foreground" />
                <span className="text-sm font-medium text-muted-foreground">{t('predLists.clickSelect')}</span>
                <span className="text-xs text-muted-foreground">{t('predLists.requiredCols')}</span>
                <input type="file" accept=".xls,.xlsx" className="hidden" onChange={handleFileUpload} />
              </label>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium text-muted-foreground shrink-0">{t('predLists.listName')}</label>
                  <input
                    type="text"
                    value={listName}
                    onChange={(e) => setListName(e.target.value)}
                    className="h-9 flex-1 rounded-lg border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder={t('predLists.listNamePlaceholder')}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Check className="h-4 w-4 text-green-600" />
                    {t('predLists.recordsFound', { count: preview.length })}
                  </span>
                  {errorCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-destructive font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      {t('predLists.nErrors', { count: errorCount })}
                    </span>
                  )}
                  {warningCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-warning font-medium">
                      <AlertTriangle className="h-4 w-4" />
                      {t('predLists.nWarnings', { count: warningCount })}
                    </span>
                  )}
                </div>

                <div className="overflow-auto rounded-lg border max-h-72">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0">
                      <tr className="border-b bg-muted/50">
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground w-8">#</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('search.name')}</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('predDetail.colTelephone')}</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('orderModal.city')}</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
                        <th className="px-3 py-2 text-left font-medium text-muted-foreground">{t('predLists.colIssues')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.slice(0, 100).map((row, i) => {
                        const issues = rowIssues.get(i);
                        const hasError = issues?.some(iss => iss.type === 'error');
                        return (
                          <tr key={i} className={cn('border-b last:border-0', hasError ? 'bg-destructive/5' : issues ? 'bg-warning/5' : '')}>
                            <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                            <td className={cn('px-3 py-1.5', !row.name.trim() && 'text-destructive italic')}>
                              {row.name || 'Empty'}
                            </td>
                            <td className={cn('px-3 py-1.5 font-mono', !row.telephone.trim() && 'text-destructive italic')}>
                              {row.telephone || 'Empty'}
                            </td>
                            <td className="px-3 py-1.5">{row.city}</td>
                            <td className="px-3 py-1.5">{row.product}</td>
                            <td className="px-3 py-1.5">
                              {issues && (
                                <div className="space-y-0.5">
                                  {issues.map((iss, j) => (
                                    <span key={j} className={cn('block text-[10px] leading-tight', iss.type === 'error' ? 'text-destructive' : 'text-warning')}>
                                      {iss.message}
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
              </>
            )}
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" onClick={resetUpload}>{t('common.cancel')}</Button>
            <Button onClick={handleSave} disabled={preview.length === 0 || !listName.trim() || errorCount > 0 || saving}>
              {saving ? t('products.savingDots') : errorCount > 0 ? t('predLists.fixToSave', { count: errorCount }) : t('predLists.saveList', { count: preview.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
