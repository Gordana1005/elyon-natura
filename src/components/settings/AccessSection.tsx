// Поставки → Пристап по улога (admins only; Phase 10, 2026-10-01). The old
// Module manager, Role permissions and Access & privacy tabs on one page:
//   1. Модули — the global switch per module. OFF hides the module from
//      EVERYONE, admins included (canAccessModule checks the switch first), so
//      switching off asks first and offers a 10-second Undo.
//   2. Дозволи по улога — role chips, then View / Edit per module (the only two
//      columns anything reads). Edit implies view.
//   3. Приватност — the five customer-identity flags the api enforces.
// Every change is PUT /api/settings/* (one audit_log row with the before and
// after). Hidden on purpose: admin (always everything), the Bulgarian roles
// agent / inbound_agent, the recording columns (VOIP is off), the modules whose
// page is gone.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, EyeOff, KeyRound, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { usePermissions, type ModuleSetting } from '@/contexts/PermissionsContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { apiSetModuleEnabled, apiSetRolePermission, apiSetRolePrivacy } from '@/lib/api';
import { roleIcon, roleLabel } from '@/components/users/roleMeta';
import { ConfirmDialog, SectionHeader, SettingsCard, settingsErrorText, useUndoToast } from './settingsUi';

/** Mirrors supabase/functions/api/settingsAccess.ts (the api refuses the rest). */
export const PROTECTED_MODULES = ['dashboard', 'users', 'settings'];
export const DEAD_MODULES = ['ads', 'prediction_leads', 'assigned', 'prediction_lists', 'search_prediction'];
export const EDITABLE_ROLES = ['manager', 'pending_agent', 'prediction_agent', 'warehouse', 'ads_admin'] as const;
export const PRIVACY_FLAGS = [
  { key: 'show_customer_phone', labelKey: 'settings.pii.phone', descKey: 'settings.piiDesc.phone' },
  { key: 'show_customer_name', labelKey: 'settings.pii.name', descKey: 'settings.piiDesc.name' },
  { key: 'show_customer_address', labelKey: 'settings.pii.address', descKey: 'settings.piiDesc.address' },
  { key: 'show_order_history', labelKey: 'settings.pii.orderHistory', descKey: 'settings.piiDesc.orderHistory' },
  { key: 'show_segment_members', labelKey: 'settings.pii.segmentMembers', descKey: 'settings.piiDesc.segmentMembers' },
] as const;

const isProtected = (m: ModuleSetting) => m.is_protected || PROTECTED_MODULES.includes(m.module_key);
/** A module in the reader's language; the DB label when there is no translation. */
const moduleName = (t: (k: string, o?: Record<string, unknown>) => string, m: ModuleSetting) =>
  t(`settingsPage.module.${m.module_key}`, { defaultValue: m.module_label });

export function AccessSection() {
  const { t } = useTranslation();
  const { modules, rolePermissions, privacy, refresh } = usePermissions();
  const { toast } = useToast();
  const undoToast = useUndoToast();
  const [role, setRole] = useState<(typeof EDITABLE_ROLES)[number]>('pending_agent');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<ModuleSetting | null>(null);

  const live = useMemo(
    () => modules.filter((m) => !DEAD_MODULES.includes(m.module_key))
      .sort((a, b) => moduleName(t, a).localeCompare(moduleName(t, b))),
    [modules, t],
  );
  const offCount = live.filter((m) => !m.is_enabled).length;

  const fail = (err: unknown) => toast({ title: t('common.error'), description: settingsErrorText(err), variant: 'destructive' });

  // ── 1. modules ──
  const setModule = async (m: ModuleSetting, on: boolean, withUndo = true) => {
    setBusy(`m:${m.module_key}`);
    try {
      await apiSetModuleEnabled(m.module_key, on);
      await refresh();
      const name = moduleName(t, m);
      const title = on ? t('settingsPage.access.moduleOn', { module: name }) : t('settingsPage.access.moduleOff', { module: name });
      if (withUndo) undoToast(title, () => { void setModule(m, !on, false); });
      else toast({ title: t('settingsPage.undone') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
      setConfirmOff(null);
    }
  };
  const onModuleSwitch = (m: ModuleSetting, on: boolean) => {
    if (!on) setConfirmOff(m);          // switching OFF asks first
    else void setModule(m, true);
  };

  // ── 2. permissions ──
  const perm = (moduleKey: string) => rolePermissions.find((p) => p.role === role && p.module_key === moduleKey);
  const setPerm = async (m: ModuleSetting, patch: { can_view?: boolean; can_edit?: boolean }, prev: { can_view: boolean; can_edit: boolean }, withUndo = true) => {
    setBusy(`p:${m.module_key}`);
    try {
      await apiSetRolePermission(role, m.module_key, patch);
      await refresh();
      if (withUndo) {
        undoToast(t('settingsPage.access.permSaved', { role: roleLabel(role), module: moduleName(t, m) }),
          () => { void setPerm(m, prev, prev, false); });
      } else toast({ title: t('settingsPage.undone') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  // ── 3. privacy ──
  const priv = privacy.find((p) => p.role === role);
  const setPriv = async (flag: string, value: boolean, withUndo = true) => {
    setBusy(`v:${flag}`);
    try {
      await apiSetRolePrivacy(role, flag, value);
      await refresh();
      const f = PRIVACY_FLAGS.find((x) => x.key === flag);
      if (withUndo) {
        undoToast(t('settingsPage.access.privacySaved', { role: roleLabel(role), flag: f ? t(f.labelKey) : flag }),
          () => { void setPriv(flag, !value, false); });
      } else toast({ title: t('settingsPage.undone') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader icon={KeyRound} title={t('settingsPage.access.title')} desc={t('settingsPage.access.desc')} />

      {/* 1. Modules — global */}
      <SettingsCard title={t('settingsPage.access.modulesTitle')} desc={t('settingsPage.access.modulesDesc')} labelledBy="acc-modules">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          {offCount === 0 ? t('settingsPage.access.allOn') : t('settingsPage.access.someOff', { count: offCount })}
        </p>
        <ul className="grid gap-x-4 sm:grid-cols-2 2xl:grid-cols-3" aria-labelledby="acc-modules">
          {live.map((m) => {
            const locked = isProtected(m);
            const id = `mod-${m.module_key}`;
            return (
              <li key={m.module_key} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                <label htmlFor={id} className={cn('min-w-0 flex-1 text-sm', !m.is_enabled && 'text-muted-foreground')}>
                  <span className="break-words">{moduleName(t, m)}</span>
                  {locked && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-muted-foreground">
                      <LockKeyhole className="h-3 w-3" aria-hidden /> {t('settingsPage.access.protected')}
                    </span>
                  )}
                  {!m.is_enabled && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] text-amber-700 dark:text-amber-400">
                      <EyeOff className="h-3 w-3" aria-hidden /> {t('settingsPage.access.moduleIsOff')}
                    </span>
                  )}
                </label>
                {busy === `m:${m.module_key}` ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                ) : (
                  <Switch id={id} checked={m.is_enabled} disabled={locked || busy !== null}
                    onCheckedChange={(v) => onModuleSwitch(m, v)} aria-label={moduleName(t, m)} />
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {/* Role chips — shared by 2 and 3 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('settingsPage.access.pickRole')}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settingsPage.access.pickRole')}>
          {EDITABLE_ROLES.map((r) => {
            const Icon = roleIcon(r);
            const on = r === role;
            return (
              <button key={r} type="button" role="radio" aria-checked={on} onClick={() => setRole(r)}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}>
                <Icon className="h-3.5 w-3.5" aria-hidden /> {roleLabel(r)}
                {on && <Check className="h-3.5 w-3.5" aria-hidden />}
              </button>
            );
          })}
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t('settingsPage.access.adminNote')}
        </p>
      </div>

      {/* 2. Permissions for the chosen role */}
      <SettingsCard title={t('settingsPage.access.rolesTitle', { role: roleLabel(role) })} desc={t('settingsPage.access.rolesDesc')} labelledBy="acc-perms">
        <ul className="divide-y" aria-labelledby="acc-perms">
          {live.map((m) => {
            const p = perm(m.module_key);
            const view = p?.can_view === true;
            const edit = p?.can_edit === true;
            const prev = { can_view: view, can_edit: edit };
            const off = !m.is_enabled;
            return (
              <li key={m.module_key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2">
                <span className={cn('min-w-0 flex-1 basis-40 text-sm', off && 'text-muted-foreground')}>
                  <span className="break-words">{moduleName(t, m)}</span>
                  {off && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px]"><EyeOff className="h-3 w-3" aria-hidden /> {t('settingsPage.access.moduleIsOff')}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-4">
                  {busy === `p:${m.module_key}` && <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />}
                  <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
                    {t('settingsPage.access.view')}
                    <Switch checked={view} disabled={busy !== null}
                      aria-label={`${moduleName(t, m)} · ${t('settingsPage.access.view')}`}
                      onCheckedChange={(v) => void setPerm(m, { can_view: v }, prev)} />
                  </label>
                  <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
                    {t('settingsPage.access.edit')}
                    <Switch checked={edit} disabled={busy !== null}
                      aria-label={`${moduleName(t, m)} · ${t('settingsPage.access.edit')}`}
                      onCheckedChange={(v) => void setPerm(m, { can_edit: v }, prev)} />
                  </label>
                </span>
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      {/* 3. Privacy for the chosen role */}
      <SettingsCard title={t('settingsPage.access.privacyTitle', { role: roleLabel(role) })} desc={t('settingsPage.access.privacyDesc')} labelledBy="acc-privacy">
        <ul className="divide-y" aria-labelledby="acc-privacy">
          {PRIVACY_FLAGS.map((f) => {
            const on = (priv as Record<string, unknown> | undefined)?.[f.key] === true;
            return (
              <li key={f.key} className="flex items-center justify-between gap-4 py-2">
                <span className="min-w-0">
                  <span className="block text-sm">{t(f.labelKey)}</span>
                  <span className="block text-[11px] text-muted-foreground">{t(f.descKey)}</span>
                </span>
                {busy === `v:${f.key}` ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                ) : (
                  <Switch checked={on} disabled={busy !== null || !priv} aria-label={t(f.labelKey)}
                    onCheckedChange={(v) => void setPriv(f.key, v)} />
                )}
              </li>
            );
          })}
        </ul>
      </SettingsCard>

      <p className="text-[11px] text-muted-foreground">{t('settingsPage.access.auditNote')}</p>

      <ConfirmDialog
        open={!!confirmOff}
        title={confirmOff ? t('settingsPage.access.offConfirmTitle', { module: moduleName(t, confirmOff) }) : ''}
        body={<p>{t('settingsPage.access.offConfirmBody')}</p>}
        confirmLabel={t('settingsPage.access.offConfirm')}
        destructive
        busy={!!confirmOff && busy === `m:${confirmOff.module_key}`}
        onConfirm={() => { if (confirmOff) void setModule(confirmOff, false); }}
        onCancel={() => setConfirmOff(null)}
      />
    </div>
  );
}
