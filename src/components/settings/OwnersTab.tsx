// Поставки → Кој гледа пари (owners only). Since 28.09 the money view is
// is_business_owner() = every ACTIVE admin automatically, plus the people on the
// owners list (public.business_owners, 20260939000500). So this page shows:
//   1. the active admins — they see the money whatever the list says;
//   2. the list — it adds people who are NOT admins (e.g. a manager), and the
//      list plus the admins are the "owners" who get the owners' alerts (the
//      30-minute idle alert, presence_alert_recipients('owners')).
// Managers never see money unless they are on the list. Every route behind it
// (/business-owners) is owners-only on the server and audited
// (business_owner.add / business_owner.remove); a name comes off the list
// unless NOBODY would be left to see the money (settingsAccess.ownerRemovalBlocked).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, Crown, Loader2, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDayDmy } from '@/i18n/dates';
import {
  apiGetBusinessOwners, apiAddBusinessOwner, apiRemoveBusinessOwner, apiGetUsers,
  type BusinessOwner,
} from '@/lib/api';
import { ConfirmDialog, SectionHeader, SettingsCard } from './settingsUi';

// The /business-owners routes answer with error CODES; these are their words.
const ERROR_KEYS: Record<string, string> = {
  owners_only: 'owners.errOwnersOnly',
  already_owner: 'owners.errAlreadyOwner',
  target_not_active_staff: 'owners.errNotActiveStaff',
  not_an_owner: 'owners.errNotAnOwner',
  last_owner: 'owners.errLastOwner',
};

interface StaffRow { user_id: string; full_name: string | null; email: string | null; is_active: boolean; roles?: string[] }

const nameOf = (o: { full_name: string | null; email: string | null }) => o.full_name || o.email || '—';
const initial = (o: { full_name: string | null; email: string | null }) => (Array.from(nameOf(o))[0] ?? '?').toUpperCase();

export function OwnersTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { refresh: refreshPermissions } = usePermissions();
  const [pick, setPick] = useState('');
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BusinessOwner | null>(null);
  const [removing, setRemoving] = useState(false);

  const errorText = (err: unknown) => {
    const key = err instanceof Error ? ERROR_KEYS[err.message] : undefined;
    return key ? t(key) : apiErrorText(err);
  };

  const ownersQ = useQuery({ queryKey: ['business-owners'], queryFn: apiGetBusinessOwners });
  // The same staff list Корисници shows (GET /users), under the key the
  // Settings list shares, so reloading the owners list never re-runs it.
  const staffQ = useQuery({ queryKey: ['settings-staff'], queryFn: apiGetUsers });

  const staff = useMemo(() => (staffQ.data ?? []) as StaffRow[], [staffQ.data]);
  const owners = useMemo(() => ownersQ.data ?? [], [ownersQ.data]);
  const ownerIds = useMemo(() => new Set(owners.map((o) => o.user_id)), [owners]);
  const activeAdmins = useMemo(
    () => staff.filter((u) => u.is_active && (u.roles ?? []).includes('admin'))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [staff],
  );
  const adminIds = useMemo(() => new Set(activeAdmins.map((a) => a.user_id)), [activeAdmins]);
  // Offered for the list: active staff who are neither admins (they see the
  // money anyway) nor on the list, and not external partners (the server
  // refuses an affiliate-only login).
  const candidates = useMemo(
    () => staff
      .filter((u) => u.is_active && !ownerIds.has(u.user_id) && !adminIds.has(u.user_id)
        && (u.roles ?? []).some((r) => r !== 'affiliate'))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [staff, ownerIds, adminIds],
  );

  const add = async () => {
    if (!pick) return;
    setAdding(true);
    try {
      const row = await apiAddBusinessOwner(pick);
      toast({ title: t('settingsPage.money.addedToast', { name: nameOf(row) }) });
      setPick('');
      await qc.invalidateQueries({ queryKey: ['business-owners'] });
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoving(true);
    try {
      await apiRemoveBusinessOwner(target.user_id);
      toast({ title: t('settingsPage.money.removedToast', { name: nameOf(target) }) });
      setRemoveTarget(null);
      // Removing yourself (and you are not an admin): the money disappears at once.
      if (target.user_id === user?.id) await refreshPermissions();
      await qc.invalidateQueries({ queryKey: ['business-owners'] });
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setRemoving(false);
    }
  };

  const pickPlaceholder = staffQ.isLoading
    ? t('common.loading')
    : candidates.length === 0 ? t('settingsPage.money.noCandidates') : t('owners.pickPlaceholder');

  const removeBody = !removeTarget ? '' : adminIds.has(removeTarget.user_id)
    ? t('settingsPage.money.removeAdminDesc', { name: nameOf(removeTarget) })
    : removeTarget.user_id === user?.id
      ? t('settingsPage.money.removeSelfDesc')
      : t('settingsPage.money.removeDesc', { name: nameOf(removeTarget) });

  return (
    <div className="space-y-4">
      <SectionHeader icon={Banknote} title={t('settingsPage.money.title')} desc={t('settingsPage.money.desc')} />

      {/* 1. Active admins — automatic */}
      <SettingsCard
        labelledBy="money-admins"
        title={t('settingsPage.money.adminsTitle', { count: activeAdmins.length })}
        desc={t('settingsPage.money.adminsDesc')}
      >
        {staffQ.isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
        ) : staffQ.isError ? (
          <p className="text-sm text-destructive">{errorText(staffQ.error)}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-labelledby="money-admins">
            {activeAdmins.map((a) => (
              <li key={a.user_id} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border bg-background py-1 pl-1 pr-3 text-sm">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary" aria-hidden>{initial(a)}</span>
                <span className="min-w-0 break-words">{nameOf(a)}</span>
                {a.user_id === user?.id && <span className="text-xs text-muted-foreground">{t('settings.you')}</span>}
                <Crown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t('userRole.admin')} />
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      {/* 2. The owners list */}
      <SettingsCard labelledBy="money-list" title={t('settingsPage.money.listTitle')} desc={t('settingsPage.money.listDesc')}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-56 space-y-1.5">
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="money-add">{t('settingsPage.money.addLabel')}</label>
            <Select value={pick} onValueChange={setPick} disabled={staffQ.isLoading || candidates.length === 0 || adding}>
              <SelectTrigger id="money-add" className="h-9">
                <SelectValue placeholder={pickPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>
                    {nameOf(c)}{c.email && c.full_name ? <span className="text-muted-foreground"> · {c.email}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" className="h-9" onClick={add} disabled={!pick || adding}>
            {adding ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserPlus className="mr-1 h-4 w-4" />}
            {t('settingsPage.money.addButton')}
          </Button>
        </div>

        {ownersQ.isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : ownersQ.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" />}
            title={t('owners.loadFailed')}
            description={errorText(ownersQ.error)}
            size="sm"
            className="border-0 bg-transparent py-4"
            action={<Button variant="outline" size="sm" onClick={() => { void ownersQ.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : owners.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('settingsPage.money.listEmpty')}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-labelledby="money-list">
            {owners.map((o) => {
              const self = o.user_id === user?.id;
              const isAdmin = adminIds.has(o.user_id);
              return (
                <li key={o.user_id} className="flex items-start gap-3 px-3 py-2.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary" aria-hidden>{initial(o)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium">
                      <span className="break-words">{nameOf(o)}</span>
                      {self && <span className="text-xs font-normal text-muted-foreground">{t('settings.you')}</span>}
                      {isAdmin && (
                        <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                          <Crown className="h-3 w-3" aria-hidden /> {t('settingsPage.money.alsoAdmin')}
                        </Badge>
                      )}
                      {!o.is_active && (
                        <Badge variant="outline" className="border-destructive/30 text-[10px] text-destructive">{t('usersPage.suspended')}</Badge>
                      )}
                    </p>
                    {o.email && o.full_name && <p className="break-all text-xs text-muted-foreground">{o.email}</p>}
                    <p className="text-[11px] text-muted-foreground">
                      {t('settingsPage.money.addedLine', {
                        when: o.added_at ? formatDayDmy(o.added_at) : '—',
                        who: o.added_by_name || '—',
                      })}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-destructive hover:bg-destructive/10"
                    onClick={() => setRemoveTarget(o)} aria-label={t('settingsPage.money.removeTitle', { name: nameOf(o) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>

      <p className="text-[11px] text-muted-foreground">{t('settingsPage.money.managersNote')} {t('owners.auditNote')}</p>

      <ConfirmDialog
        open={!!removeTarget}
        title={removeTarget ? t('settingsPage.money.removeTitle', { name: nameOf(removeTarget) }) : ''}
        body={<p>{removeBody}</p>}
        confirmLabel={t('owners.removeConfirm')}
        destructive
        busy={removing}
        onConfirm={() => { void remove(); }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
