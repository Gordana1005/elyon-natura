import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useToast } from '@/hooks/use-toast';
import { formatDmy } from '@/components/insights/shared/period';
import { isoDow } from '@/lib/shiftsApi';
import { HOLIDAY_SCOPES, apiHrDeleteHoliday, apiHrHolidays, apiHrSaveHoliday, type HrHoliday } from '@/lib/hrApi';
import { hrErrorText } from './labels';

/**
 * Празници — the year's non-working days: the state days for everyone (a Sunday one moved to the
 * Monday) and the religious / community days for their believers. A date marked "check" was
 * computed (lunar / movable) — HR confirms it against the government's calendar.
 */
export function HolidaysTab({ today }: { today: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [editing, setEditing] = useState<HrHoliday | 'new' | null>(null);
  const q = useQuery({ queryKey: ['hr', 'holidays', year], queryFn: () => apiHrHolidays(year) });
  const del = useMutation({
    mutationFn: (id: string) => apiHrDeleteHoliday(id),
    onSuccess: () => { toast({ title: t('hrPage.holidays.deleted') }); void q.refetch(); },
    onError: (e) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' }),
  });
  const canEdit = q.data?.can_edit ?? false;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('hrPage.balances.prevYear')} onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span className="min-w-14 text-center text-sm font-semibold tabular-nums">{year}</span>
          <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('hrPage.balances.nextYear')} onClick={() => setYear((y) => y + 1)}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {canEdit && (
          <Button type="button" size="sm" variant="outline" className="ml-auto h-9" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden /> {t('hrPage.holidays.add')}
          </Button>
        )}
      </div>

      {q.isError && !q.data ? (
        <LoadError text={t('hrPage.loadFailed')} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="space-y-2" aria-hidden>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-10" />)}</div>
      ) : q.data.holidays.length === 0 ? (
        <EmptyState title={t('hrPage.holidays.empty', { year })} size="sm" className="rounded-xl shadow-sm" />
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-sm" data-testid="hr-holidays">
          {q.data.holidays.map((h) => (
            <li key={h.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-medium break-words">{h.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  <span className="tabular-nums">{formatDmy(h.date)}</span> · {t(`shiftsPage.dow.${isoDow(h.date)}`)} · {t(`hrPage.calendars.${h.scope}`)}
                  {h.moved_from && ` · ${t('hrPage.holidays.movedFrom', { date: formatDmy(h.moved_from) })}`}
                </span>
                {!h.verified && (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-amber-800 dark:text-amber-300">
                    <TriangleAlert className="h-3 w-3" aria-hidden />{t('hrPage.holidays.unverified')}
                  </span>
                )}
              </span>
              {canEdit && (
                <span className="flex shrink-0 gap-1">
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.edit')} onClick={() => setEditing(h)}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t('common.delete')} disabled={del.isPending}
                    onClick={() => { if (window.confirm(t('hrPage.holidays.confirmDelete', { name: h.name }))) del.mutate(h.id); }}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <HolidayDialog holiday={editing} year={year} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void q.refetch(); }} />
    </div>
  );
}

function HolidayDialog({ holiday, year, onClose, onSaved }: {
  holiday: HrHoliday | 'new' | null; year: number; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const cur = holiday && holiday !== 'new' ? holiday : null;
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>('all');
  const [moved, setMoved] = useState('');
  const [verified, setVerified] = useState(true);
  useEffect(() => {
    if (!holiday) return;
    setDate(cur?.date ?? `${year}-01-01`); setName(cur?.name ?? ''); setScope(cur?.scope ?? 'all');
    setMoved(cur?.moved_from ?? ''); setVerified(cur?.verified ?? true);
  }, [holiday, cur, year]);
  const save = useMutation({
    mutationFn: () => apiHrSaveHoliday(cur?.id ?? null, {
      date, name: name.trim(), scope: scope as HrHoliday['scope'], moved_from: moved || null, verified, note: null,
    }),
    onSuccess: () => { toast({ title: t('hrPage.holidays.saved') }); onSaved(); },
    onError: (e) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' }),
  });
  return (
    <Dialog open={!!holiday} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{cur ? cur.name : t('hrPage.holidays.add')}</DialogTitle>
          <DialogDescription>{t('hrPage.holidays.dialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label htmlFor="hol-name">{t('hrPage.holidays.name')}</Label>
            <Input id="hol-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5"><Label htmlFor="hol-date">{t('hrPage.holidays.date')}</Label>
              <Input id="hol-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="hol-moved">{t('hrPage.holidays.moved')}</Label>
              <Input id="hol-moved" type="date" value={moved} onChange={(e) => setMoved(e.target.value)} /></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="hol-scope">{t('hrPage.holidays.scope')}</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id="hol-scope"><SelectValue /></SelectTrigger>
              <SelectContent>{HOLIDAY_SCOPES.map((s) => <SelectItem key={s} value={s}>{t(`hrPage.calendars.${s}`)}</SelectItem>)}</SelectContent>
            </Select></div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={verified} onCheckedChange={(v) => setVerified(v === true)} />{t('hrPage.holidays.verified')}
          </label>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" disabled={save.isPending || !date || !name.trim()} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
