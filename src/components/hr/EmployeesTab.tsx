import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2, Pencil, Search, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useToast } from '@/hooks/use-toast';
import { formatDmy } from '@/components/insights/shared/period';
import { Chip, LABEL } from '@/components/assigner/parts';
import { userMatchesQuery } from '@/lib/users/filterUsers';
import {
  CONTRACT_TYPES, HOLIDAY_CALENDARS, HR_TEAMS, WORKPLACES, apiHrEmployees, apiHrSaveEmployee, type HrEmployee,
} from '@/lib/hrApi';
import { hrErrorText } from './labels';
import { groupKey, groupLabel, groupOrder } from './groups';

const NONE = '__none__';

/**
 * Вработени — the dossier (super_admin / owner / finance only; the api refuses everyone else):
 * every employee, with or without a CRM login — shop and warehouse staff are added here. Personal
 * data, the contract and its dates, the work week and holiday calendars (they decide how leave
 * days count), the first approver. Every save is audited (the changed keys, never the values).
 */
export function EmployeesTab({ today }: { today: string }) {
  const { t } = useTranslation();
  const [showLeft, setShowLeft] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<HrEmployee | 'new' | null>(null);
  const q = useQuery({ queryKey: ['hr', 'employees', 'all'], queryFn: () => apiHrEmployees(true) });

  const list = (q.data?.employees ?? [])
    .filter((e) => (showLeft || e.status === 'active') && (!search.trim() || userMatchesQuery({ full_name: e.full_name }, search)));
  const groups = useMemo(() => {
    const m = new Map<string, HrEmployee[]>();
    for (const e of list) m.set(groupKey(e), [...(m.get(groupKey(e)) ?? []), e]);
    return [...m.entries()].sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b));
  }, [list]);
  const leftCount = (q.data?.employees ?? []).filter((e) => e.status === 'left').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" className="h-9" onClick={() => setEditing('new')}>
          <UserPlus className="h-4 w-4" aria-hidden /> {t('hrPage.employees.add')}
        </Button>
        {leftCount > 0 && <Chip on={showLeft} onClick={() => setShowLeft((v) => !v)}>{t('hrPage.employees.showLeft', { n: leftCount })}</Chip>}
        <label className="relative ml-auto block w-full sm:w-56">
          <span className="sr-only">{t('hrPage.calendar.search')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('hrPage.calendar.search')} className="h-9 pl-8 text-sm" />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('hrPage.employees.hint')}</p>

      {q.isError && !q.data ? (
        <LoadError text={t('hrPage.loadFailed')} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <div className="grid gap-2 md:grid-cols-2" aria-hidden>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-20" />)}</div>
      ) : groups.length === 0 ? (
        <EmptyState title={t('hrPage.employees.empty')} size="sm" className="rounded-xl shadow-sm" />
      ) : groups.map(([k, people]) => (
        <section key={k} className="space-y-1.5" aria-label={groupLabel(t, k)}>
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{groupLabel(t, k)} · {people.length}</h4>
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {people.map((e) => {
              const flags = [
                !e.user_id && t('hrPage.employees.noLogin'),
                e.contract_end && e.contract_end >= today && t('hrPage.employees.contractUntil', { date: formatDmy(e.contract_end) }),
                e.probation_end && e.probation_end >= today && t('hrPage.employees.probationUntil', { date: formatDmy(e.probation_end) }),
                e.status === 'left' && t('hrPage.employees.left', { date: formatDmy(e.left_at) }),
              ].filter(Boolean) as string[];
              return (
                <li key={e.id}>
                  <button type="button" onClick={() => setEditing(e)}
                    className={cn('flex w-full min-h-14 items-start justify-between gap-2 rounded-xl border bg-card p-3 text-left shadow-sm hover:bg-muted/40',
                      e.status === 'left' && 'opacity-60')}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{e.full_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[e.position, e.phone].filter(Boolean).join(' · ') || t(`hrPage.workplace.${e.workplace}`)}
                      </span>
                      {flags.length > 0 && <span className="mt-0.5 block text-[11px] text-amber-800 dark:text-amber-300">{flags.join(' · ')}</span>}
                    </span>
                    <Pencil className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <EmployeeDialog employee={editing} logins={q.data?.logins ?? []}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void q.refetch(); }} />
    </div>
  );
}

type Form = Record<string, string | number[] | string[]>;
const TEXT_KEYS = ['full_name', 'position', 'company', 'shop_name', 'phone', 'email', 'address', 'emergency_contact',
  'extra_leave_reason', 'notes'] as const;
const DATE_KEYS = ['birth_date', 'hire_date', 'contract_end', 'probation_end', 'left_at'] as const;

function toForm(e: HrEmployee | null): Form {
  const f: Form = {};
  for (const k of TEXT_KEYS) f[k] = (e?.[k] as string | null | undefined) ?? '';
  for (const k of DATE_KEYS) f[k] = (e?.[k] as string | null | undefined) ?? '';
  f.status = e?.status ?? 'active';
  f.workplace = e?.workplace ?? 'call_centre';
  f.team_key = e?.team_key ?? NONE;
  f.contract_type = e?.contract_type ?? NONE;
  f.user_id = e?.user_id ?? NONE;
  f.approver_id = e?.approver_id ?? NONE;
  f.work_days = e?.work_days ?? [1, 2, 3, 4, 5];
  f.holiday_calendars = e?.holiday_calendars ?? ['orthodox'];
  f.prior_service_months = String(e?.prior_service_months ?? 0);
  f.extra_leave_days = String(e?.extra_leave_days ?? 0);
  return f;
}

function EmployeeDialog({ employee, logins, onClose, onSaved }: {
  employee: HrEmployee | 'new' | null;
  logins: { user_id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const current = employee && employee !== 'new' ? employee : null;
  const [f, setF] = useState<Form>(() => toForm(null));
  const [orig, setOrig] = useState<Form>(() => toForm(null));
  useEffect(() => { if (employee) { const x = toForm(current); setF(x); setOrig(x); } }, [employee, current]);
  const set = (k: string, v: string | number[] | string[]) => setF((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(f)) {
        if (JSON.stringify(v) === JSON.stringify(orig[k]) && current) continue;
        if (k === 'prior_service_months' || k === 'extra_leave_days') out[k] = Number(v) || 0;
        else if (v === NONE) out[k] = null;
        else if ((DATE_KEYS as readonly string[]).includes(k)) out[k] = v || null;
        else out[k] = v;
      }
      if (!current) for (const k of DATE_KEYS) if (!out[k]) delete out[k];
      return apiHrSaveEmployee(current?.id ?? null, out);
    },
    onSuccess: () => { toast({ title: t('hrPage.employees.saved') }); onSaved(); },
    onError: (e) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' }),
  });

  const text = (k: string, type = 'text') => (
    <div className="grid gap-1.5">
      <Label htmlFor={`emp-${k}`}>{t(`hrPage.field.${k}`)}</Label>
      <Input id={`emp-${k}`} type={type} value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  const select = (k: string, options: readonly string[], label: (o: string) => string, allowNone = true) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`emp-${k}`}>{t(`hrPage.field.${k}`)}</Label>
      <Select value={String(f[k])} onValueChange={(v) => set(k, v)}>
        <SelectTrigger id={`emp-${k}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>—</SelectItem>}
          {options.map((o) => <SelectItem key={o} value={o}>{label(o)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
  const toggleIn = (k: 'work_days' | 'holiday_calendars', v: number | string) => {
    const cur = f[k] as (number | string)[];
    set(k, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]) as number[] | string[]);
  };

  return (
    <Dialog open={!!employee} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{current ? current.full_name : t('hrPage.employees.add')}</DialogTitle>
          <DialogDescription>{t('hrPage.employees.dialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className={cn(LABEL, 'mb-1 sm:col-span-2')}>{t('hrPage.employees.sectionWork')}</legend>
            {text('full_name')}
            {text('position')}
            {select('workplace', WORKPLACES, (o) => t(`hrPage.workplace.${o}`), false)}
            {f.workplace === 'shop' ? text('shop_name') : select('team_key', HR_TEAMS, (o) => t(`hrPage.groups.team.${o}`))}
            {text('company')}
            {select('user_id', logins.map((l) => l.user_id), (o) => logins.find((l) => l.user_id === o)?.name ?? o)}
            {select('approver_id', logins.map((l) => l.user_id), (o) => logins.find((l) => l.user_id === o)?.name ?? o)}
            {select('status', ['active', 'left'], (o) => t(`hrPage.employees.status.${o}`), false)}
            {f.status === 'left' && text('left_at', 'date')}
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className={cn(LABEL, 'mb-1 sm:col-span-2')}>{t('hrPage.employees.sectionContract')}</legend>
            {text('hire_date', 'date')}
            {select('contract_type', CONTRACT_TYPES, (o) => t(`hrPage.contract.${o}`))}
            {text('contract_end', 'date')}
            {text('probation_end', 'date')}
            {text('prior_service_months', 'number')}
            {text('extra_leave_days', 'number')}
            <div className="sm:col-span-2">{text('extra_leave_reason')}</div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className={cn(LABEL, 'mb-1')}>{t('hrPage.employees.sectionDays')}</legend>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('hrPage.field.work_days')}>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <Chip key={d} on={(f.work_days as number[]).includes(d)} onClick={() => toggleIn('work_days', d)}>{t(`shiftsPage.dow.${d}`)}</Chip>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('hrPage.field.holiday_calendars')}>
              {HOLIDAY_CALENDARS.map((c) => (
                <Chip key={c} on={(f.holiday_calendars as string[]).includes(c)} onClick={() => toggleIn('holiday_calendars', c)}>{t(`hrPage.calendars.${c}`)}</Chip>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('hrPage.employees.daysHint')}</p>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className={cn(LABEL, 'mb-1 sm:col-span-2')}>{t('hrPage.employees.sectionPersonal')}</legend>
            {text('phone', 'tel')}
            {text('email', 'email')}
            {text('birth_date', 'date')}
            {text('emergency_contact')}
            <div className="sm:col-span-2">{text('address')}</div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="emp-notes">{t('hrPage.field.notes')}</Label>
              <Textarea id="emp-notes" rows={3} value={String(f.notes ?? '')} onChange={(e) => set('notes', e.target.value)} />
            </div>
          </fieldset>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" disabled={save.isPending || !String(f.full_name).trim() || (f.work_days as number[]).length === 0} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
