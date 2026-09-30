// Поставки → Правила (Phase 10, 2026-10-01). Only the rules that really act,
// each with what it does, where it acts, its value now and who changed it
// last (GET /api/settings/meta: app_settings.updated_by, else the audit row).
// Editable (admins): the personal-list cap, the unpaid-delivery chase window,
// the CPA push switch — PATCH /api/app-settings (audited). Read-only rows:
// the no-parcel rule (its switch lives in Integrations, owners), the 30-minute
// idle alert, and the shift-runway warning. Managers see the page read-only.
// Gone (they saved nothing or were wrong): auto-assign, follow-up, the two
// notification switches, the static Order / Lead flow lists.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Eye, ListChecks, Loader2, Lock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { apiGetAppSettings, apiGetSettingsMeta, apiUpdateAppSettings, type SettingsMetaEntry } from '@/lib/api';
import { noParcelDaysOr } from '@/lib/noParcelRule';
import { LastChanged, SectionHeader, settingsErrorText } from './settingsUi';

/** The shift-runway warning: shifts_runway(5), daily at 17:00 Skopje (migration 20260943000100). */
const SHIFTS_RUNWAY_DAYS = 5;
const SHIFTS_RUNWAY_TIME = '17:00';

/** The newer of several meta entries (a rule stored under two keys). */
function newest(...entries: (SettingsMetaEntry | undefined)[]): SettingsMetaEntry | undefined {
  return entries.filter((e): e is SettingsMetaEntry => !!e?.at)
    .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime())[0] ?? entries.find(Boolean);
}

export function RulesSection({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['app-settings'], queryFn: apiGetAppSettings });
  // "Last changed by" is a nicety: the page works without it (e.g. before the api knows the route).
  const metaQ = useQuery({ queryKey: ['settings-meta'], queryFn: apiGetSettingsMeta, retry: 0 });
  const s = settingsQ.data;
  const meta = metaQ.data?.app_settings ?? {};

  const [cap, setCap] = useState('');
  const [chaseDays, setChaseDays] = useState('');
  const [chaseStop, setChaseStop] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!s) return;
    setCap(String(s.personal_list_max_holds ?? ''));
    setChaseDays(String(s.unpaid_chase_days ?? ''));
    setChaseStop(String(s.unpaid_chase_stop_days ?? ''));
  }, [s]);

  const save = async (key: string, patch: Parameters<typeof apiUpdateAppSettings>[0], okText: string) => {
    setSaving(key);
    try {
      await apiUpdateAppSettings(patch);
      toast({ title: okText });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['app-settings'] }),
        qc.invalidateQueries({ queryKey: ['settings-meta'] }),
      ]);
    } catch (err) {
      toast({ title: t('common.error'), description: settingsErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const saveCap = () => {
    const n = Math.floor(Number(cap));
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      toast({ title: t('common.error'), description: t('settings.personalListCapRange'), variant: 'destructive' });
      return;
    }
    void save('cap', { personal_list_max_holds: n }, t('settings.personalListCapSaved', { count: n }));
  };
  const saveChase = () => {
    const d = Math.floor(Number(chaseDays));
    const st = Math.floor(Number(chaseStop));
    if (!Number.isFinite(d) || d < 1 || d > 30 || !Number.isFinite(st) || st < d || st > 999) {
      toast({ title: t('common.error'), description: t('settings.unpaidChaseRange'), variant: 'destructive' });
      return;
    }
    void save('chase', { unpaid_chase_days: d, unpaid_chase_stop_days: st }, t('settings.unpaidChaseSaved', { days: d, stop: st }));
  };
  const saveCpa = (on: boolean) =>
    void save('cpa', { altercpa_push_enabled: on }, on ? t('settings.cpaPushEnabledToast') : t('settings.cpaPushDisabledToast'));

  // Read-only values
  const np = (s?.no_parcel_rule ?? {}) as { days?: number; hour?: number; mode?: string };
  const npDays = noParcelDaysOr(np.days);
  const npMode = np.mode === 'apply' ? t('settings.integrations.np.modeApply') : t('settings.integrations.np.modeReport');
  const idleMin = Number(s?.presence_idle_alert_minutes ?? 30);
  const idleHours = (s?.presence_idle_alert_hours ?? {}) as { from?: number; to?: number };
  const rawRecipients = s?.presence_idle_alert_recipients;
  const recipients = Array.isArray(rawRecipients) ? rawRecipients.map(String) : [String(rawRecipients ?? 'owners')];
  const recipientText = recipients
    .map((r) => (r === 'owners' || r === 'admins' ? t(`settingsPage.rules.idle.recipients.${r}`) : t('settingsPage.rules.idle.recipients.person')))
    .join(', ');
  const scope = String(s?.presence_idle_alert_scope ?? 'agents') === 'all' ? 'all' : 'agents';
  const hh = (n: unknown, d: number) => String(Number.isFinite(Number(n)) ? Number(n) : d).padStart(2, '0');

  const capDirty = s && cap !== '' && Number(cap) !== Number(s.personal_list_max_holds);
  const chaseDirty = s && chaseDays !== '' && chaseStop !== ''
    && (Number(chaseDays) !== Number(s.unpaid_chase_days) || Number(chaseStop) !== Number(s.unpaid_chase_stop_days));

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={ListChecks}
        title={t('settingsPage.rules.title')}
        desc={t('settingsPage.rules.desc')}
        aside={readOnly ? (
          <Badge variant="secondary" className="gap-1"><Eye className="h-3.5 w-3.5" aria-hidden /> {t('settingsPage.badge.readOnly')}</Badge>
        ) : undefined}
      />
      {readOnly && (
        <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> {t('settingsPage.rules.readOnlyNote')}
        </p>
      )}

      {settingsQ.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
      ) : settingsQ.isError ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{settingsErrorText(settingsQ.error)}</p>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {/* Personal-list cap */}
          <RuleCard
            id="rule-cap"
            title={t('settingsPage.rules.personalCap.title')}
            what={t('settingsPage.rules.personalCap.what')}
            where={t('settingsPage.rules.personalCap.where')}
            value={t('settingsPage.rules.personalCap.value', { count: Number(s?.personal_list_max_holds ?? 0) })}
            meta={meta.personal_list_max_holds}
          >
            {!readOnly && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] font-medium text-muted-foreground">{t('settings.personalListCapLabel')}</span>
                  <Input type="number" inputMode="numeric" min={1} max={1000} value={cap} onChange={(e) => setCap(e.target.value)} className="h-9 w-28" />
                </label>
                <Button size="sm" className="h-9" onClick={saveCap} disabled={!capDirty || saving !== null}>
                  {saving === 'cap' && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t('common.save')}
                </Button>
              </div>
            )}
          </RuleCard>

          {/* Unpaid-delivery chase */}
          <RuleCard
            id="rule-chase"
            title={t('settingsPage.rules.unpaidChase.title')}
            what={t('settingsPage.rules.unpaidChase.what')}
            where={t('settingsPage.rules.unpaidChase.where')}
            value={t('settingsPage.rules.unpaidChase.value', { days: Number(s?.unpaid_chase_days ?? 0), stop: Number(s?.unpaid_chase_stop_days ?? 0) })}
            meta={newest(meta.unpaid_chase_days, meta.unpaid_chase_stop_days)}
          >
            {!readOnly && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] font-medium text-muted-foreground">{t('settings.unpaidChaseDaysLabel')}</span>
                  <Input type="number" inputMode="numeric" min={1} max={30} value={chaseDays} onChange={(e) => setChaseDays(e.target.value)} className="h-9 w-24" />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] font-medium text-muted-foreground">{t('settings.unpaidChaseStopLabel')}</span>
                  <Input type="number" inputMode="numeric" min={1} max={999} value={chaseStop} onChange={(e) => setChaseStop(e.target.value)} className="h-9 w-24" />
                </label>
                <Button size="sm" className="h-9" onClick={saveChase} disabled={!chaseDirty || saving !== null}>
                  {saving === 'chase' && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t('common.save')}
                </Button>
              </div>
            )}
          </RuleCard>

          {/* CPA push */}
          <RuleCard
            id="rule-cpa"
            title={t('settingsPage.rules.cpaPush.title')}
            what={t('settingsPage.rules.cpaPush.what')}
            where={t('settingsPage.rules.cpaPush.where')}
            value={s?.altercpa_push_enabled ? t('settingsPage.rules.on') : t('settingsPage.rules.off')}
            meta={meta.altercpa_push_enabled}
          >
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={s?.altercpa_push_enabled === true} disabled={readOnly || saving !== null} onCheckedChange={saveCpa}
                aria-label={t('settingsPage.rules.cpaPush.title')} />
              {saving === 'cpa' && <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />}
              <span className="text-xs text-muted-foreground">{t('altercpa.pushToggleHint')}</span>
            </label>
          </RuleCard>

          {/* No-parcel rule (read-only here) */}
          <RuleCard
            id="rule-noparcel"
            title={t('settingsPage.rules.noParcel.title', { days: npDays })}
            what={t('settingsPage.rules.noParcel.what', { days: npDays })}
            where={t('settingsPage.rules.noParcel.where')}
            value={t('settingsPage.rules.noParcel.value', { days: npDays, mode: npMode, time: `${hh(np.hour, 21)}:10` })}
            meta={meta.no_parcel_rule}
            readOnlyRow
          >
            {!readOnly && (
              <Link to="/settings/integrations" className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
                {t('settingsPage.rules.noParcel.manage')} <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            )}
          </RuleCard>

          {/* Idle alert (read-only) */}
          <RuleCard
            id="rule-idle"
            title={t('settingsPage.rules.idle.title')}
            what={t(`settingsPage.rules.idle.what.${scope}`, { minutes: idleMin })}
            where={t('settingsPage.rules.idle.where')}
            value={t('settingsPage.rules.idle.value', {
              minutes: idleMin, from: hh(idleHours.from, 0), to: hh(idleHours.to, 24), recipients: recipientText,
            })}
            meta={newest(meta.presence_idle_alert_minutes, meta.presence_idle_alert_hours, meta.presence_idle_alert_recipients)}
            readOnlyRow
          />

          {/* Shift runway (read-only) */}
          <RuleCard
            id="rule-shifts"
            title={t('settingsPage.rules.shifts.title')}
            what={t('settingsPage.rules.shifts.what', { days: SHIFTS_RUNWAY_DAYS })}
            where={t('settingsPage.rules.shifts.where')}
            value={t('settingsPage.rules.shifts.value', { days: SHIFTS_RUNWAY_DAYS, time: SHIFTS_RUNWAY_TIME })}
            readOnlyRow
          />
        </ul>
      )}
    </div>
  );
}

function RuleCard({ id, title, what, where, value, meta, readOnlyRow, children }: {
  id: string; title: string; what: string; where: string; value: string;
  meta?: SettingsMetaEntry; readOnlyRow?: boolean; children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className="min-w-0 space-y-2.5 rounded-xl border bg-card p-4 shadow-sm" aria-labelledby={id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={id} className="min-w-0 break-words text-sm font-semibold">{title}</h3>
        {readOnlyRow && (
          <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden /> {t('settingsPage.rules.fixedHere')}
          </Badge>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-y-1.5 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-x-3">
        <dt className="font-medium text-muted-foreground">{t('settingsPage.rules.what')}</dt>
        <dd className="break-words">{what}</dd>
        <dt className="font-medium text-muted-foreground">{t('settingsPage.rules.where')}</dt>
        <dd className="break-words">{where}</dd>
        <dt className="font-medium text-muted-foreground">{t('settingsPage.rules.value')}</dt>
        <dd className="break-words font-semibold tabular-nums">{value}</dd>
      </dl>
      {children}
      {meta !== undefined || !readOnlyRow ? <LastChanged entry={meta} /> : null}
    </li>
  );
}
