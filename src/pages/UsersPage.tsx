import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Users as UsersIcon } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetUsers, apiToggleUserActive, apiSetUserRoles, apiDeleteUser, apiUpdateUser } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import type { AppRole } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { UserFilters } from '@/components/users/UserFilters';
import { UsersKpis, type UsersKpiCounts } from '@/components/users/UsersKpis';
import { UsersList, type UserRow } from '@/components/users/UsersList';
import { CreateUserDialog, EditUserDialog, type NewUser, type UserPatch } from '@/components/users/UserDialogs';
import { useUserFilterParams } from '@/components/users/useUserFilterParams';
import { filterUsers, hasActiveFilters, isUserOnline, roleCounts, sortUsers } from '@/lib/users/filterUsers';

const ALL_ROLES: AppRole[] = ['admin', 'manager', 'pending_agent', 'prediction_agent', 'warehouse', 'ads_admin'];
const MANAGER_ALLOWED_ROLES: AppRole[] = ['pending_agent', 'prediction_agent'];

/**
 * Тим → Корисници: every login, in the Insights look. Top to bottom: the
 * accounts at a glance (tiles that filter) · the toolbar (search by name or
 * e-mail in Cyrillic or Latin, status, online, sort, roles — all in the URL) ·
 * the list (a table on a desktop, cards on a phone) with the role toggles, the
 * active switch and the edit / delete menu.
 *
 * Data: GET /api/users (profiles.* + roles[] + two counts), fetched once and
 * again after every change; filtering and sorting are client-side
 * (lib/users/filterUsers.ts, shared with Settings → Users & roles).
 * Rules as before: admins manage everyone and edit name / e-mail / password;
 * a manager only manages users whose roles are all pending / prediction agent;
 * nobody changes or deletes themselves.
 */
export default function UsersPage() {
  const { t } = useTranslation();
  const f = useInsightsFormat();
  const { toast } = useToast();
  const { user: currentUser } = useAuth();

  const isAdmin = currentUser?.isAdmin ?? false;
  const isManager = currentUser?.isManager ?? false;
  // Roles this user can assign
  const availableRoles = isAdmin ? ALL_ROLES : MANAGER_ALLOWED_ROLES;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  // "Online" is judged against the moment the list arrived (the api's snapshot).
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<UserRow | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { filters, sort, setQuery, setFilters, setSort, clear: clearFilters } = useUserFilterParams();

  const fetchUsers = () => {
    const first = phase !== 'ready';
    if (first) setPhase('loading');
    apiGetUsers()
      .then((data: any[]) => {
        setUsers((data ?? []).map((u: any) => ({ ...u, roles: u.roles || [u.role || 'pending_agent'] })));
        setLoadedAt(Date.now());
        setPhase('ready');
      })
      .catch((err: unknown) => {
        // A failed first load says so with a retry; a failed refresh keeps the list and says so.
        if (first) { setLoadError(apiErrorText(err)); setPhase('error'); }
        else toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      });
  };

  useEffect(() => { fetchUsers(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The payload carries profiles.last_seen_at (null for someone never seen).
  const hasPresence = useMemo(() => users.some((u) => u.last_seen_at !== undefined), [users]);
  const effective = useMemo(() => ({ ...filters, online: hasPresence && filters.online }), [filters, hasPresence]);
  const rows = useMemo(
    () => sortUsers(filterUsers(users, effective, loadedAt), sort),
    [users, effective, loadedAt, sort],
  );
  const counts = useMemo<UsersKpiCounts>(() => ({
    total: users.length,
    active: users.filter((u) => u.is_active).length,
    suspended: users.filter((u) => !u.is_active).length,
    online: hasPresence ? users.filter((u) => isUserOnline(u, loadedAt)).length : null,
    roles: roleCounts(users),
  }), [users, hasPresence, loadedAt]);
  const filtering = hasActiveFilters(effective);

  const handleCreate = async (nu: NewUser): Promise<boolean> => {
    if (!nu.full_name.trim() || !nu.email.trim() || !nu.password.trim()) {
      toast({ title: t('common.error'), description: t('usersPage.allFieldsRequired'), variant: 'destructive' });
      return false;
    }
    if (nu.roles.length === 0) {
      toast({ title: t('common.error'), description: t('usersPage.oneRoleRequired'), variant: 'destructive' });
      return false;
    }
    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api/users/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify(nu),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');
      toast({ title: t('usersPage.userCreated') });
      setShowCreate(false);
      fetchUsers();
      return true;
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      return false;
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (u: UserRow) => {
    try {
      await apiToggleUserActive(u.user_id);
      fetchUsers();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleToggleRole = async (u: UserRow, role: string) => {
    const newRoles = u.roles.includes(role) ? u.roles.filter((r) => r !== role) : [...u.roles, role];
    if (newRoles.length === 0) {
      toast({ title: t('common.error'), description: t('usersPage.mustHaveRole'), variant: 'destructive' });
      return;
    }
    try {
      await apiSetUserRoles(u.user_id, newRoles);
      toast({ title: t('usersPage.rolesUpdated') });
      fetchUsers();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteUser(deleteTarget.user_id);
      toast({ title: t('usersPage.userDeleted') });
      setDeleteTarget(null);
      fetchUsers();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveEdit = async (u: UserRow, patch: UserPatch) => {
    if (Object.keys(patch).length === 0) {
      toast({ title: t('usersPage.noChanges') });
      return;
    }
    setSavingEdit(true);
    try {
      await apiUpdateUser(u.user_id, patch);
      toast({ title: t('usersPage.userUpdated') });
      setEditTarget(null);
      fetchUsers();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSavingEdit(false);
    }
  };

  // Manager can only manage agents they can create (pending_agent, prediction_agent)
  const canManageUser = (u: UserRow) => {
    if (isAdmin) return true;
    if (isManager) return u.roles.every((r) => MANAGER_ALLOWED_ROLES.includes(r as AppRole));
    return false;
  };

  return (
    <AppLayout title={t('nav.users')}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('nav.users')}</h2>
            <p className="text-xs text-muted-foreground">{t('users.subtitle')}</p>
          </div>
          <Button onClick={() => setShowCreate(true)} className="h-9">
            <UserPlus className="h-4 w-4" aria-hidden /> {t('usersPage.addUser')}
          </Button>
        </div>

        {phase === 'error' ? (
          <LoadError text={loadError} onRetry={fetchUsers} />
        ) : phase === 'loading' ? (
          <UsersSkeleton />
        ) : (
          <>
            <UsersKpis counts={counts} filters={effective} onFilters={setFilters} f={f} />
            <section aria-label={t('nav.users')} className="space-y-3">
              <UserFilters
                filters={effective}
                onQueryChange={setQuery}
                onFilters={setFilters}
                onClear={clearFilters}
                sort={sort}
                onSort={setSort}
                counts={counts.roles}
                shown={rows.length}
                total={users.length}
                hasPresence={hasPresence}
              />
              {rows.length === 0 ? (
                <EmptyState
                  icon={<UsersIcon className="h-6 w-6" />}
                  title={t('settings.noUsersFound')}
                  description={filtering ? t('users.filter.noMatch') : t('settings.noUsersDesc')}
                  action={filtering ? <Button variant="outline" size="sm" onClick={clearFilters}>{t('settings.clearFilters')}</Button> : undefined}
                  size="sm"
                  className="rounded-xl shadow-sm"
                />
              ) : (
                <UsersList
                  rows={rows}
                  query={filters.query}
                  now={loadedAt}
                  hasPresence={hasPresence}
                  sort={sort}
                  onSort={setSort}
                  currentUserId={currentUser?.id}
                  canManage={canManageUser}
                  availableRoles={availableRoles}
                  canEdit={isAdmin}
                  onToggleRole={handleToggleRole}
                  onToggleActive={handleToggleActive}
                  onEdit={setEditTarget}
                  onDelete={setDeleteTarget}
                  f={f}
                />
              )}
            </section>
          </>
        )}
      </div>

      <CreateUserDialog open={showCreate} onOpenChange={setShowCreate} availableRoles={availableRoles} busy={creating} onCreate={handleCreate} />

      {/* Edit (Superadmin only) */}
      <EditUserDialog target={editTarget} onClose={() => setEditTarget(null)} busy={savingEdit} onSave={handleSaveEdit} />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('usersPage.deleteUser')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('usersPage.deleteConfirm', { name: deleteTarget?.full_name, email: deleteTarget?.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t('usersPage.deleting') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

function UsersSkeleton() {
  return (
    <div className="space-y-6" aria-hidden data-testid="users-skeleton">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
        <Skeleton variant="card" className="col-span-2 h-24 lg:col-span-full xl:col-span-2" />
      </div>
      <Skeleton variant="card" className="h-24" />
      <div className="space-y-2 rounded-xl border bg-card p-3 shadow-sm">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-11" />)}
      </div>
    </div>
  );
}
