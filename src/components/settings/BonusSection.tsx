// Поставки → Бонуси (owners; owner 02.10.2026, migration 20260947001100). The prediction (Out) bonus: per department
// (Тим Центар Out, Тим Маџари Out) a daily target in денари and the € each milestone unlocks — at 1/3, 2/3 and 3/3 of
// the target. The pool unlocked on a day is shared by the value each seller contributed; the TV board shows it live,
// and it is paid only for what MEX collected. Every save is a new version from a day (a past day never changes) and
// is audited.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Gift, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { formatDayDmy } from '@/i18n/dates';
import { formatDenari, formatEurExact } from '@/lib/currency';
import { deptKey, type Department } from '@/lib/leaderboardV2';
import {
  apiGetBonusMonth, apiGetBonusTargets, apiSetBonusRules, apiSetBonusTarget, apiSettleBonusMonth, BONUS_DEPARTMENTS,
  BONUS_MONTH_KEY, BONUS_QUERY_KEY, type BonusDepartment, type BonusRules, type BonusTarget,
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

// ── the month's return cut (20260947001200): settle days + tiers ────────────
function RulesCard({ rules }: { rules: BonusRules | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const init = () => ({
    days: String(rules?.settle_after_days ?? 3),
    tiers: (rules?.return_tiers ?? []).map((x) => ({ min: String(x.min_pct), cut: String(x.cut_pct) })),
  });
  const [d, setD] = useState(init);
  useEffect(() => { setD(init()); }, [rules]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = /^\d{1,2}$/.test(d.days) && Number(d.days) <= 31
    && d.tiers.every((x) => x.min !== '' && x.cut !== '' && Number(x.min) >= 0 && Number(x.min) <= 100 && Number(x.cut) >= 0 && Number(x.cut) <= 100)
    && new Set(d.tiers.map((x) => Number(x.min))).size === d.tiers.length;
  const save = useMutation({
    mutationFn: () => apiSetBonusRules({
      settle_after_days: Number(d.days),
      return_tiers: d.tiers.map((x) => ({ min_pct: Number(x.min), cut_pct: Number(x.cut) })),
    }),
    onSuccess: () => { toast({ title: t('bonus.saved') }); void qc.invalidateQueries({ queryKey: ['settings', 'bonus'] }); },
    onError: (e) => toast({ title: t('common.error'), description: settingsErrorText(e), variant: 'destructive' }),
  });
  const setTier = (i: number, k: 'min' | 'cut', v: string) =>
    setD((x) => ({ ...x, tiers: x.tiers.map((y, j) => (j === i ? { ...y, [k]: v } : y)) }));
  return (
    <SettingsCard title={t('bonus.rules.title')} desc={t('bonus.rules.desc')} labelledBy="bonus-rules">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="max-w-xs space-y-1">
          <Label htmlFor="bonus-settle-days">{t('bonus.rules.settleDays')}</Label>
          <Input id="bonus-settle-days" type="number" min={0} max={31} step={1} value={d.days}
            onChange={(e) => setD((x) => ({ ...x, days: e.target.value }))} />
        </div>
        <div className="space-y-2">
          {d.tiers.map((tier, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <div className="w-32 space-y-1">
                <Label htmlFor={`tier-min-${i}`}>{t('bonus.rules.minPct')}</Label>
                <Input id={`tier-min-${i}`} type="number" min={0} max={100} step={0.5} value={tier.min}
                  onChange={(e) => setTier(i, 'min', e.target.value)} />
              </div>
              <div className="w-32 space-y-1">
                <Label htmlFor={`tier-cut-${i}`}>{t('bonus.rules.cutPct')}</Label>
                <Input id={`tier-cut-${i}`} type="number" min={0} max={100} step={0.5} value={tier.cut}
                  onChange={(e) => setTier(i, 'cut', e.target.value)} />
              </div>
              <Button type="button" variant="ghost" size="sm" className="h-9" aria-label={t('bonus.rules.remove')}
                onClick={() => setD((x) => ({ ...x, tiers: x.tiers.filter((_, j) => j !== i) }))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="h-9"
            onClick={() => setD((x) => ({ ...x, tiers: [...x.tiers, { min: '', cut: '' }] }))}>
            <Plus className="mr-1 h-4 w-4" /> {t('bonus.rules.add')}
          </Button>
        </div>
        <Button type="submit" disabled={!valid || save.isPending} className="h-9">
          {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} {t('bonus.save')}
        </Button>
      </form>
    </SettingsCard>
  );
}

// ── a month per seller: Σ daily shares, return %, cut, final ────────────────
const monthOf = (offset: number) => {
  const [y, m] = skopjeToday().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
};

function MonthCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => monthOf(0));
  const q = useQuery({ queryKey: BONUS_MONTH_KEY(month), queryFn: () => apiGetBonusMonth(month) });
  const settle = useMutation({
    mutationFn: () => apiSettleBonusMonth(month),
    onSuccess: () => { toast({ title: t('bonus.month.settledToast') }); void qc.invalidateQueries({ queryKey: BONUS_MONTH_KEY(month) }); },
    onError: (e) => toast({ title: t('common.error'), description: settingsErrorText(e), variant: 'destructive' }),
  });
  const m = q.data;
  const past = month < monthOf(0);
  return (
    <SettingsCard title={t('bonus.month.title')} labelledBy="bonus-month"
      desc={m ? (m.settled ? t('bonus.month.settled', { date: formatDayDmy(String(m.settled_at ?? '').slice(0, 10)) })
                           : t('bonus.month.provisional', { date: formatDayDmy(m.settle_on) })) : undefined}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {[-1, 0].map((o) => {
          const v = monthOf(o);
          return (
            <Button key={v} type="button" size="sm" variant={v === month ? 'default' : 'outline'} className="h-8" onClick={() => setMonth(v)}>
              {v}
            </Button>
          );
        })}
        {m && !m.settled && past && (
          <Button type="button" size="sm" variant="outline" className="h-8" disabled={settle.isPending} onClick={() => settle.mutate()}>
            <CalendarCheck className="mr-1 h-4 w-4" /> {t('bonus.month.settleNow')}
          </Button>
        )}
      </div>
      {q.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>}
      {m && m.people.length === 0 && <p className="text-sm text-muted-foreground">{t('bonus.month.empty')}</p>}
      {m && m.people.length > 0 && (
        <>
          <p className="mb-2 text-sm font-semibold tabular-nums">
            {t('bonus.month.total', { final: formatEurExact(m.total_final_eur), days: formatEurExact(m.total_days_bonus_eur) })}
          </p>
          <ul className="divide-y text-sm">
            {m.people.map((p) => (
              <li key={p.person_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2">
                <span className="min-w-0 break-words font-medium">{p.name ?? '—'}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t('bonus.month.row', {
                    days: formatEurExact(p.days_bonus_eur),
                    ret: p.return_pct == null ? '—' : `${p.return_pct}%`,
                    cut: p.cut_pct,
                  })}{' '}
                  <b className="font-semibold text-foreground">{formatEurExact(p.final_eur)}</b>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
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
      {q.data && <RulesCard rules={q.data.rules ?? null} />}
      {q.data && <MonthCard />}
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
