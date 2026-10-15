import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  CALENDAR_DAY_TYPES, LEAVE_TYPES, apiHrCreateRequest, requestDays, type HrHoliday, type LeaveType,
} from '@/lib/hrApi';
import { daysText, hrErrorText, typeLabel } from './labels';

export interface RequestPerson { id: string; name: string; work_days: number[]; holiday_calendars: string[] }

/**
 * "Побарај отсуство" / "Внеси отсуство": type, from–to, a note (and the doctor's note number for
 * sick leave). The days are previewed with the person's work week and holidays (the server counts
 * again and decides). A manager may pick anyone in scope and tick "record as approved" (HR enters a
 * sick note or a shop worker's day); for oneself the request goes to the team, then a manager.
 */
export function RequestDialog({
  open, onOpenChange, people, defaultPersonId, holidays, canRecord, today, onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The people the caller may enter for (one = oneself, no picker). */
  people: RequestPerson[];
  defaultPersonId: string | null;
  holidays: HrHoliday[];
  canRecord: boolean;
  today: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [personId, setPersonId] = useState<string | null>(defaultPersonId);
  const [type, setType] = useState<LeaveType>('annual');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [note, setNote] = useState('');
  const [docRef, setDocRef] = useState('');
  const [record, setRecord] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPersonId(defaultPersonId ?? people[0]?.id ?? null);
    setType('annual'); setFrom(today); setTo(today); setNote(''); setDocRef(''); setRecord(false);
  }, [open, defaultPersonId, people, today]);

  const person = people.find((p) => p.id === personId) ?? null;
  const days = useMemo(
    () => (person ? requestDays(type, from, to <= from ? from : to, person.work_days, person.holiday_calendars, holidays) : 0),
    [person, type, from, to, holidays],
  );
  const badRange = !from || !to || to < from;
  const isSelf = people.length === 1 && people[0].id === defaultPersonId;

  const save = useMutation({
    mutationFn: () => apiHrCreateRequest({
      employee_id: isSelf ? null : personId, type, date_from: from, date_to: to,
      note: note.trim() || null, doc_ref: docRef.trim() || null, record: canRecord && record,
    }),
    onSuccess: (r) => {
      toast({
        title: r.stage === 'approved' ? t('hrPage.request.recorded') : t('hrPage.request.sent'),
        description: r.shifts_removed ? t('hrPage.request.shiftsRemoved', { count: r.shifts_removed }) : undefined,
      });
      onOpenChange(false);
      onDone();
    },
    onError: (e) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{canRecord && !isSelf ? t('hrPage.request.titleFor') : t('hrPage.request.title')}</DialogTitle>
          <DialogDescription>{isSelf ? t('hrPage.request.descSelf') : t('hrPage.request.descManager')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {!isSelf && (
            <div className="grid gap-1.5">
              <Label htmlFor="hr-person">{t('hrPage.request.person')}</Label>
              <Select value={personId ?? undefined} onValueChange={setPersonId}>
                <SelectTrigger id="hr-person"><SelectValue placeholder={t('hrPage.request.pickPerson')} /></SelectTrigger>
                <SelectContent>
                  {people.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="hr-type">{t('hrPage.request.type')}</Label>
            <Select value={type} onValueChange={(v) => setType(v as LeaveType)}>
              <SelectTrigger id="hr-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((k) => <SelectItem key={k} value={k}>{typeLabel(t, k)}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t(`hrPage.typeHint.${type}`)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="hr-from">{t('hrPage.request.from')}</Label>
              <Input id="hr-from" type="date" value={from}
                onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="hr-to">{t('hrPage.request.to')}</Label>
              <Input id="hr-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="hr-days-preview">
            {badRange ? t('hrPage.request.badRange')
              : CALENDAR_DAY_TYPES.includes(type)
                ? t('hrPage.request.calendarDays', { n: daysText(days) })
                : t('hrPage.request.workingDays', { n: daysText(days) })}
          </p>
          {(type === 'sick' || type === 'maternity') && (
            <div className="grid gap-1.5">
              <Label htmlFor="hr-doc">{t('hrPage.request.docRef')}</Label>
              <Input id="hr-doc" value={docRef} maxLength={100} onChange={(e) => setDocRef(e.target.value)} />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="hr-note">{t('hrPage.request.note')}</Label>
            <Textarea id="hr-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {canRecord && !isSelf && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={record} onCheckedChange={(v) => setRecord(v === true)} className="mt-0.5" />
              <span>
                {t('hrPage.request.record')}
                <span className="block text-[11px] text-muted-foreground">{t('hrPage.request.recordHint')}</span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || badRange || !personId}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {canRecord && record && !isSelf ? t('hrPage.request.saveRecord') : t('hrPage.request.send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
