// Settings → Owners (owner ruling 2026-09-27). The named people who see the
// full business/money view: the Insights money tabs (Overview, Sales, Pure
// Profit, Margin Lab, Prediction Lists, Stock, Returns) and the Pure Profit
// export. Holding the admin role is NOT enough. This tab is rendered only for
// an owner, and every route behind it (/business-owners) is owners-only on the
// server and audited (business_owner.add / business_owner.remove).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, Loader2, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDate } from '@/i18n/dates';
import {
  apiGetBusinessOwners, apiAddBusinessOwner, apiRemoveBusinessOwner, apiGetUsers,
  type BusinessOwner,
} from '@/lib/api';

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
  // The same staff list Users & Roles shows (GET /users). Its own key, so
  // reloading the owners list never re-runs this heavier request.
  const staffQ = useQuery({ queryKey: ['settings-staff'], queryFn: apiGetUsers });

  const owners = useMemo(() => ownersQ.data ?? [], [ownersQ.data]);
  const ownerIds = useMemo(() => new Set(owners.map((o) => o.user_id)), [owners]);
  // Active staff who are not owners yet. A login whose only role is
  // `affiliate` is an external partner: the server refuses it, so it is not offered.
  const candidates = useMemo(
    () => ((staffQ.data ?? []) as StaffRow[])
      .filter((u) => u.is_active && !ownerIds.has(u.user_id) && (u.roles ?? []).some((r) => r !== 'affiliate'))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b))),
    [staffQ.data, ownerIds],
  );
  const lastOwner = owners.length <= 1;

  const add = async () => {
    if (!pick) return;
    setAdding(true);
    try {
      const row = await apiAddBusinessOwner(pick);
      toast({ title: t('owners.addedToast', { name: nameOf(row) }) });
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
      toast({ title: t('owners.removedToast', { name: nameOf(target) }) });
      setRemoveTarget(null);
      // Removing yourself takes effect at once: re-read permissions, and the
      // money tabs (and this tab) disappear. Anyone else: just reload the list.
      if (target.user_id === user?.id) await refreshPermissions();
      else await qc.invalidateQueries({ queryKey: ['business-owners'] });
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setRemoving(false);
    }
  };

  const pickPlaceholder = staffQ.isLoading
    ? t('common.loading')
    : candidates.length === 0 ? t('owners.noCandidates') : t('owners.pickPlaceholder');

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Briefcase className="h-4 w-4 text-primary" /> {t('owners.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('owners.desc')}</p>
      </div>

      {/* Add an owner */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
        <div className="flex-1 min-w-[220px] space-y-1.5">
          <label className="block text-xs font-medium text-muted-foreground">{t('owners.addLabel')}</label>
          <Select value={pick} onValueChange={setPick} disabled={staffQ.isLoading || candidates.length === 0 || adding}>
            <SelectTrigger className="h-9">
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
          {staffQ.isError && <p className="text-xs text-destructive">{errorText(staffQ.error)}</p>}
        </div>
        <Button size="sm" className="h-9" onClick={add} disabled={!pick || adding}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <UserPlus className="h-4 w-4 mr-1" />}
          {t('owners.addButton')}
        </Button>
      </div>

      {/* Current owners */}
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        {ownersQ.isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
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
          <EmptyState
            icon={<Briefcase className="h-6 w-6" />}
            title={t('owners.empty')}
            size="sm"
            className="border-0 bg-transparent py-4"
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('owners.colOwner')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('owners.colAdded')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('owners.colAddedBy')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('settings.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => {
                const self = o.user_id === user?.id;
                return (
                  <tr key={o.user_id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                          {nameOf(o).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {nameOf(o)}{' '}
                            {self && <span className="text-xs text-muted-foreground">{t('settings.you')}</span>}
                            {!o.is_active && (
                              <Badge variant="outline" className="ml-1 text-[10px] text-destructive border-destructive/30">
                                {t('usersPage.suspended')}
                              </Badge>
                            )}
                          </p>
                          {o.email && o.full_name && <p className="text-xs text-muted-foreground truncate">{o.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {o.added_at ? formatDate(o.added_at, 'PPP') : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{o.added_by_name || '—'}</td>
                    <td className="px-4 py-3">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* span: a disabled button fires no hover, so the tooltip needs a wrapper */}
                          <span className="inline-flex">
                            <button
                              type="button"
                              onClick={() => setRemoveTarget(o)}
                              disabled={lastOwner}
                              aria-label={t('owners.removeTitle')}
                              className="flex h-7 w-7 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{lastOwner ? t('owners.errLastOwner') : t('owners.removeTitle')}</TooltipContent>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('owners.auditNote')}</p>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('owners.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.user_id === user?.id
                ? t('owners.removeSelfDesc')
                : t('owners.removeDesc', { name: removeTarget ? nameOf(removeTarget) : '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void remove(); }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : t('owners.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
