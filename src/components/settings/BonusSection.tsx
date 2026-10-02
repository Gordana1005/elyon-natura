// Поставки → Бонуси (owners; owner 02.10.2026, migration 20260947001100). The prediction (Out) bonus: per department
// (Тим Центар Out, Тим Маџари Out) a daily target in денари and the € each milestone unlocks — at 1/3, 2/3 and 3/3 of
// the target. The pool unlocked on a day is shared by the value each seller contributed; the TV board shows it live,
// and it is paid only for what MEX collected. Every save is a new version from a day (a past day never changes) and
// is audited.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatDayDmy } from '@/i18n/dates';
import { formatDenari, formatEurExact } from '@/lib/currency';
import { deptKey, type Department } from '@/lib/leaderboardV2';
import {
  apiGetBonusTargets, apiSetBonusTarget, BONUS_DEPARTMENTS, BONUS_QUERY_KEY,
  type BonusDepartment, type BonusTarget,
} from '@/lib/bonusApi';
import { SectionHeader, SettingsCard, settingsErrorText } from './settingsUi';

const skopjeToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Skopje' });

interface Draft { valid_from: string; target_mkd: string; m1_eur: string; m2_eur: string; m3_eur: string; note: string }

const draftOf = (t: BonusTarget | null, today: string): Draft => ({
  valid_from: today,
  target_mkd: t ? String(t.target_mkd) : '',
  m1_eur: t ? String(t.m1_eur) : '',
  m2_eur: t ? String(t.m2_eur) : '',
  m3_eur: t ? String(t.m3_eur) : '',
  note: '',
});

function DepartmentCard({ dept, current, upcoming }: { dept: BonusDepartment; current: BonusTarget | null; upcoming: BonusTarget[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const today = skopjeToday();
  const [d, setD] = useState<Draft>(() => draftOf(current, today));
  useEffect(() => { setD(draftOf(current, today)); }, [current, today]);
  const target = Number(d.target_mkd);
  const valid = target > 0 && [d.m1_eur, d.m2_eur, d.m3_eur].every((x) => x !== '' && Number(x) >= 0) && /^\d{4}-\d{2}-\d{2}$/.test(d.valid_from);
  const save = useMutation({
    mutationFn: () => apiSetBonusTarget({
      department: dept, valid_from: d.valid_from, target_mkd: target,
      m1_eur: Number(d.m1_eur), m2_eur: Number(d.m2_eur), m3_eur: Number(d.m3_eur), note: d.note || null,
    }),
    onSuccess: () => { toast({ title: t('bonus.saved') }); void qc.invalidateQueries({ queryKey: BONUS_QUERY_KEY }); },
    onError: (e) => toast({ title: t('common.error'), description: settingsErrorText(e), variant: 'destructive' }),
  });
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD((x) => ({ ...x, [k]: e.target.value }));
  const id = `bonus-${dept}`;
  return (
    <SettingsCard title={t(`leaderboard2.dept.${deptKey(dept as Department)}`)} labelledBy={id}
      desc={current
        ? t('bonus.current', {
            date: formatDayDmy(current.valid_from), target: formatDenari(current.target_mkd),
            m1: formatEurExact(current.m1_eur), m2: formatEurExact(current.m2_eur), m3: formatEurExact(current.m3_eur),
          })
        : t('bonus.none')}>
      {upcoming.length > 0 && (
        <ul className="mb-3 space-y-1 text-xs text-muted-foreground">
          {upcoming.map((u) => (
            <li key={u.id}>{t('bonus.upcoming', { date: formatDayDmy(u.valid_from), target: formatDenari(u.target_mkd),
              m1: formatEurExact(u.m1_eur), m2: formatEurExact(u.m2_eur), m3: formatEurExact(u.m3_eur) })}</li>
          ))}
        </ul>
      )}
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="space-y-1">
          <Label htmlFor={`${id}-from`}>{t('bonus.validFrom')}</Label>
          <Input id={`${id}-from`} type="date" value={d.valid_from} onChange={set('valid_from')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-target`}>{t('bonus.target')}</Label>
          <Input id={`${id}-target`} type="number" inputMode="numeric" min={1} step={1} value={d.target_mkd} onChange={set('target_mkd')} />
        </div>
        <div className="space-y-1 sm:col-span-2 lg:col-span-1">
          <Label htmlFor={`${id}-note`}>{t('bonus.note')}</Label>
          <Input id={`${id}-note`} value={d.note} maxLength={500} onChange={set('note')} />
        </div>
        {(['m1_eur', 'm2_eur', 'm3_eur'] as const).map((k, i) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`${id}-${k}`}>{t(`bonus.m${i + 1}`)}</Label>
            <Input id={`${id}-${k}`} type="number" inputMode="decimal" min={0} step={0.5} value={d[k]} onChange={set(k)} />
            {target > 0 && (
              <p className="text-[11px] text-muted-foreground">{t('bonus.at', { value: formatDenari(Math.round((target * (i + 1)) / 3)) })}</p>
            )}
          </div>
        ))}
        <div className="flex items-end sm:col-span-2 lg:col-span-3">
          <Button type="submit" disabled={!valid || save.isPending} className="h-9">
            {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} {t('bonus.save')}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

export function BonusSection() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: BONUS_QUERY_KEY, queryFn: apiGetBonusTargets });
  const history = useMemo(() => q.data?.history ?? [], [q.data]);
  return (
    <div className="space-y-4">
      <SectionHeader icon={Gift} title={t('bonus.title')} desc={t('bonus.desc')} />
      {q.isLoading && <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>}
      {q.error && <p className="text-sm text-destructive">{settingsErrorText(q.error)}</p>}
      {q.data && BONUS_DEPARTMENTS.map((dept) => (
        <DepartmentCard key={dept} dept={dept} current={q.data!.current[dept] ?? null}
          upcoming={q.data!.upcoming.filter((u) => u.department === dept)} />
      ))}
      {history.length > 0 && (
        <SettingsCard title={t('bonus.history')}>
          <ul className="divide-y text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                <span className="font-medium">{t(`leaderboard2.dept.${deptKey(h.department as Department)}`)} · {formatDayDmy(h.valid_from)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatDenari(h.target_mkd)} · {formatEurExact(h.m1_eur)} / {formatEurExact(h.m2_eur)} / {formatEurExact(h.m3_eur)}
                  {h.note ? ` · ${h.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
    </div>
  );
}
