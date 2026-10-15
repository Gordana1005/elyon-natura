import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, OctagonAlert, Pencil, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useToast } from '@/hooks/use-toast';
import { formatDmy } from '@/components/insights/shared/period';
import { userMatchesQuery } from '@/lib/users/filterUsers';
import { apiHrBalances, apiHrEmployees, apiHrSetEntitlement, type HrBalance } from '@/lib/hrApi';
import { daysText, hrErrorText } from './labels';
import { groupKey, groupLabel } from './groups';

/**
 * Салда — everyone's annual leave in a year: right (base + extra + carry), used, planned,
 * waiting, left; the carry that expires on 30.06; sick days employer / ФЗОМ. A dossier viewer
 * sets a year's right (e.g. what was left of 2026 before HR existed) — audited.
 */
export function BalancesTab({ today, canEdit }: { today: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<HrBalance | null>(null);
  const bal = useQuery({ queryKey: ['hr', 'balances', year], queryFn: () => apiHrBalances(year) });
  const emp = useQuery({ queryKey: ['hr', 'employees', 'all'], queryFn: () => apiHrEmployees(true) });
  const byId = useMemo(() => new Map((emp.data?.employees ?? []).map((e) => [e.id, e])), [emp.data]);

  const rows = (bal.data?.balances ?? [])
    .map((b) => ({ b, e: byId.get(b.employee_id) }))
    .filter(({ e }) => !!e && (!search.trim() || userMatchesQuery({ full_name: e.full_name }, search)));

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
        <label className="relative ml-auto block w-full sm:w-56">
          <span className="sr-only">{t('hrPage.calendar.search')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('hrPage.calendar.search')} className="h-9 pl-8 text-sm" />
        </label>
      </div>
      {year === 2026 && <p className="text-xs text-muted-foreground">{t('hrPage.balances.firstYearHint')}</p>}

      {(bal.isError || emp.isError) && !bal.data ? (
        <LoadError text={t('hrPage.loadFailed')} onRetry={() => { void bal.refetch(); void emp.refetch(); }} />
      ) : !bal.data || !emp.data ? (
        <div className="space-y-2" aria-hidden>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-10" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState title={t('hrPage.balances.empty')} size="sm" className="rounded-xl shadow-sm" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block">
            <table className="w-full text-sm" data-testid="hr-balances">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">{t('hrPage.calendar.person')}</th>
                  {(['entitled', 'used', 'planned', 'pending', 'remaining'] as const).map((k) => (
                    <th key={k} className="px-2 py-2 text-right font-medium">{t(`hrPage.balance.${k}`)}</th>
                  ))}
                  <th className="px-2 py-2 text-right font-medium">{t('hrPage.balance.sick')}</th>
                  {canEdit && <th className="px-2 py-2" aria-label={t('common.edit')} />}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ b, e }) => (
                  <tr key={b.employee_id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <span className="block font-medium">{e!.full_name}</span>
                      <span className="block text-[11px] text-muted-foreground">{groupLabel(t, groupKey(e!))}</span>
                      <Flags b={b} today={today} />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" title={breakdown(t, b)}>{daysText(b.entitled)}{b.source === 'set' && <sup className="ml-0.5 text-[9px] text-muted-foreground">✎</sup>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{daysText(b.used)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{daysText(b.planned)}</td>
                    <td className={cn('px-2 py-2 text-right tabular-nums', b.pending > 0 && 'text-amber-700 dark:text-amber-400')}>{daysText(b.pending)}</td>
                    <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', b.remaining < 0 && 'text-red-700 dark:text-red-400')}>{daysText(b.remaining)}</td>
                    <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">{b.sick_employer_days + b.sick_fzom_days ? `${b.sick_employer_days} / ${b.sick_fzom_days}` : '—'}</td>
                    {canEdit && (
                      <td className="px-2 py-2 text-right">
                        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t('hrPage.balances.edit', { name: e!.full_name })} onClick={() => setEditing(b)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 md:hidden">
            {rows.map(({ b, e }) => (
              <li key={b.employee_id} className="rounded-xl border bg-card p-3 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{e!.full_name}</p>
                    <p className="text-[11px] text-muted-foreground">{groupLabel(t, groupKey(e!))}</p>
                  </div>
                  <p className={cn('shrink-0 text-xl font-semibold tabular-nums', b.remaining < 0 && 'text-red-700 dark:text-red-400')}>{daysText(b.remaining)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {t('hrPage.balances.cardLine', { entitled: daysText(b.entitled), used: daysText(b.used), planned: daysText(b.planned), pending: daysText(b.pending) })}
                </p>
                <Flags b={b} today={today} />
                {canEdit && (
                  <Button type="button" variant="outline" size="sm" className="mt-2 h-9" onClick={() => setEditing(b)}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden /> {t('hrPage.balances.setRight')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <EntitlementDialog balance={editing} name={editing ? byId.get(editing.employee_id)?.full_name ?? '' : ''}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void bal.refetch(); }} />
    </div>
  );
}

const breakdown = (t: (k: string, o?: Record<string, unknown>) => string, b: HrBalance) =>
  t('hrPage.balances.breakdown', { base: daysText(b.base_days), extra: daysText(b.extra_days), carry: daysText(b.carry_available) });

function Flags({ b, today }: { b: HrBalance; today: string }) {
  const { t } = useTranslation();
  const flags: string[] = [];
  if (b.carry_expiring > 0) flags.push(t('hrPage.warn.carryExpiringShort', { n: daysText(b.carry_expiring), date: formatDmy(b.carry_until).slice(0, 5) }));
  if (!b.first_part_ok && today.slice(5, 7) >= '09' && b.remaining >= 12 && b.year === Number(today.slice(0, 4))) flags.push(t('hrPage.warn.firstPartShort'));
  if (b.personal_paid_over) flags.push(t('hrPage.warn.personalOverShort', { n: daysText(b.personal_paid_days) }));
  if (!flags.length) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-amber-800 dark:text-amber-300">
      {flags.map((f) => <span key={f} className="inline-flex items-center gap-0.5"><OctagonAlert className="h-3 w-3" aria-hidden />{f}</span>)}
    </span>
  );
}

function EntitlementDialog({ balance, name, onClose, onSaved }: {
  balance: HrBalance | null; name: string; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [base, setBase] = useState('20');
  const [extra, setExtra] = useState('0');
  const [carry, setCarry] = useState('0');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!balance) return;
    setBase(String(balance.base_days)); setExtra(String(balance.extra_days)); setCarry(String(balance.carry_days)); setNote(balance.note ?? '');
  }, [balance]);
  const num = (s: string) => Number(s.replace(',', '.'));
  const save = useMutation({
    mutationFn: (reset: boolean) => apiHrSetEntitlement({
      employee_id: balance!.employee_id, year: balance!.year,
      base_days: reset ? null : num(base), extra_days: reset ? 0 : num(extra), carry_days: reset ? 0 : num(carry), note: note.trim() || null,
    }),
    onSuccess: () => { toast({ title: t('hrPage.balances.saved') }); onSaved(); },
    onError: (e) => toast({ title: t('common.error'), description: hrErrorText(e), variant: 'destructive' }),
  });
  return (
    <Dialog open={!!balance} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('hrPage.balances.dialogTitle', { name, year: balance?.year ?? '' })}</DialogTitle>
          <DialogDescription>{t('hrPage.balances.dialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          {([['base', base, setBase], ['extra', extra, setExtra], ['carry', carry, setCarry]] as const).map(([k, v, set]) => (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={`ent-${k}`}>{t(`hrPage.balances.field.${k}`)}</Label>
              <Input id={`ent-${k}`} inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} />
            </div>
          ))}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ent-note">{t('hrPage.request.note')}</Label>
          <Input id="ent-note" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter className="gap-2">
          {balance?.source === 'set' && (
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(true)}>{t('hrPage.balances.reset')}</Button>
          )}
          <Button type="button" disabled={save.isPending || [base, extra, carry].some((s) => !Number.isFinite(num(s)))} onClick={() => save.mutate(false)}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
