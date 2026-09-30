import { ArrowDown, ArrowUp, Check, Circle, CircleCheck, CirclePause, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/insights/shared/cohortPalette';
import { formatDate, formatDayDmy } from '@/i18n/dates';
import { isUserOnline, nextSort, type UserSort, type UserSortKey } from '@/lib/users/filterUsers';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { HighlightMatch } from './UserFilters';
import { roleIcon, roleLabel, roleTone } from './roleMeta';

/** A row of GET /api/users: profiles.* + roles[] + two counts. */
export interface UserRow {
  user_id: string;
  full_name: string;
  email: string;
  roles: string[];
  role?: string;
  is_active: boolean;
  orders_processed: number;
  leads_processed: number;
  created_at: string;
  /** profiles.last_seen_at (the app's heartbeat); absent on an older api. */
  last_seen_at?: string | null;
}

export interface UsersListProps {
  rows: UserRow[];
  query: string;
  /** The moment the list was loaded — "online" is judged against it. */
  now: number;
  hasPresence: boolean;
  sort: UserSort;
  onSort: (sort: UserSort) => void;
  currentUserId?: string;
  /** The viewer may change this user's roles, status and delete them (the manager rule lives in the page). */
  canManage: (u: UserRow) => boolean;
  /** The roles the viewer may hand out. */
  availableRoles: readonly string[];
  /** Admins edit name / e-mail / password. */
  canEdit: boolean;
  onToggleRole: (u: UserRow, role: string) => void;
  onToggleActive: (u: UserRow) => void;
  onEdit: (u: UserRow) => void;
  onDelete: (u: UserRow) => void;
  f: InsightsFormat;
}

const initials = (name: string) =>
  (name ?? '').trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] ?? '').join('').toUpperCase() || '?';

/**
 * Every account: a sortable table from xl (the Insights PeopleTable look —
 * sticky header and first column, 13 px, tabular numbers), one card per user
 * below it (two columns from lg). Below xl the sidebar leaves 480–740 px, where
 * a table would scroll sideways. Both carry the same facts and controls.
 */
export function UsersList(props: UsersListProps) {
  return (
    <>
      <UsersTable {...props} />
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2 xl:hidden" aria-label={props.f.t('nav.users')}>
        {props.rows.map((u) => <UserCard key={u.user_id} u={u} {...props} />)}
      </ul>
    </>
  );
}

function UsersTable(p: UsersListProps) {
  const { t } = p.f;
  const cols: { key: string; label: string; sort?: UserSortKey; right?: boolean }[] = [
    { key: 'user', label: t('usersPage.colUser'), sort: 'name' },
    { key: 'roles', label: t('usersPage.colRoles') },
    { key: 'status', label: t('settings.colStatus') },
    ...(p.hasPresence ? [{ key: 'last', label: t('users.col.lastSeen'), sort: 'last' as const }] : []),
    { key: 'orders', label: t('usersPage.colOrders'), sort: 'orders', right: true },
    { key: 'leads', label: t('usersPage.colLeads'), right: true },
    { key: 'created', label: t('users.col.created'), sort: 'created', right: true },
  ];
  return (
    <div className="relative hidden max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm xl:block">
      <table className="w-full text-[13px]">
        <caption className="sr-only">{t('nav.users')}</caption>
        <thead className="sticky top-0 z-20 bg-card text-[11px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
          <tr>
            {cols.map((c, i) => {
              const active = !!c.sort && p.sort.key === c.sort;
              return (
                <th key={c.key} scope="col"
                  aria-sort={c.sort ? (active ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  className={cn('whitespace-nowrap px-2 py-2 font-medium', i === 0 && 'sticky left-0 z-30 bg-card pl-3', c.right ? 'text-right' : 'text-left')}>
                  {c.sort ? (
                    <button type="button" onClick={() => p.onSort(nextSort(p.sort, c.sort!))}
                      className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground')}>
                      {c.label}
                      {active && (p.sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
            <th scope="col" className="w-10 px-2 py-2 pr-3"><span className="sr-only">{t('common.actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((u) => {
            const self = p.currentUserId === u.user_id;
            const manage = !self && p.canManage(u);
            return (
              <tr key={u.user_id} className="border-t hover:bg-muted/30">
                <th scope="row" className="sticky left-0 z-10 max-w-[240px] bg-card py-1.5 pl-3 pr-2 text-left font-normal">
                  <Identity u={u} self={self} {...p} />
                </th>
                <td className="min-w-[150px] px-2 py-1.5">
                  <RoleCell u={u} editable={manage} {...p} />
                </td>
                <td className="whitespace-nowrap px-2 py-1.5"><StatusCell u={u} editable={manage} f={p.f} onToggleActive={p.onToggleActive} /></td>
                {p.hasPresence && <td className="whitespace-nowrap px-2 py-1.5"><LastSeen u={u} now={p.now} f={p.f} /></td>}
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{p.f.int(u.orders_processed)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{p.f.int(u.leads_processed)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{formatDayDmy(u.created_at)}</td>
                <td className="px-2 py-1 pr-3 text-right">
                  <RowActions u={u} canEdit={p.canEdit} canDelete={manage} onEdit={p.onEdit} onDelete={p.onDelete} f={p.f} compact />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserCard({ u, ...p }: UsersListProps & { u: UserRow }) {
  const { t } = p.f;
  const self = p.currentUserId === u.user_id;
  const manage = !self && p.canManage(u);
  const fact = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
  return (
    <li className="min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <Identity u={u} self={self} {...p} />
        <RowActions u={u} canEdit={p.canEdit} canDelete={manage} onEdit={p.onEdit} onDelete={p.onDelete} f={p.f} />
      </div>
      <RoleCell u={u} editable={manage} {...p} card />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusCell u={u} editable={manage} f={p.f} onToggleActive={p.onToggleActive} />
        {p.hasPresence && <LastSeen u={u} now={p.now} f={p.f} />}
      </div>
      <dl className="grid grid-cols-3 gap-2 border-t pt-2">
        <div className="min-w-0"><dt className={fact}>{t('usersPage.colOrders')}</dt><dd className="font-semibold tabular-nums">{p.f.int(u.orders_processed)}</dd></div>
        <div className="min-w-0"><dt className={fact}>{t('usersPage.colLeads')}</dt><dd className="tabular-nums">{p.f.int(u.leads_processed)}</dd></div>
        <div className="min-w-0"><dt className={fact}>{t('users.col.created')}</dt><dd className="text-xs tabular-nums">{formatDayDmy(u.created_at)}</dd></div>
      </dl>
    </li>
  );
}

function Identity({ u, self, query, now, hasPresence, f }: { u: UserRow; self: boolean } & UsersListProps) {
  const online = hasPresence && isUserOnline(u, now);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <span aria-hidden className={cn(
        'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        u.is_active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}>
        {initials(u.full_name)}
        {online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-card" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={u.full_name}>
          <HighlightMatch text={u.full_name} query={query} />
          {self && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{f.t('settings.you')}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={u.email}><HighlightMatch text={u.email} query={query} /></span>
      </span>
    </span>
  );
}

const roleChip = 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium';

function RoleBadge({ role, card }: { role: string; card?: boolean }) {
  const Icon = roleIcon(role);
  return (
    <span className={cn(roleChip, card ? 'h-7 text-xs' : 'h-6 text-[11px]', roleTone(role))}>
      <Icon className="h-3 w-3" aria-hidden />{roleLabel(role)}
    </span>
  );
}

/**
 * The held roles as badges. For a user the viewer may manage, "Уреди улоги"
 * opens every role the viewer may hand out as a toggle (a click saves at once,
 * as before) — so a row stays one line tall on every screen.
 */
function RoleCell({ u, editable, availableRoles, onToggleRole, f, card }: { u: UserRow; editable: boolean; card?: boolean } & UsersListProps) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {u.roles.map((r) => <RoleBadge key={r} role={r} card={card} />)}
      {editable && (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button"
              className={cn(
                'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed px-2 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                card ? 'h-9 px-3 text-xs' : 'h-6 text-[11px]',
              )}
              aria-label={f.t('users.row.editRolesFor', { name: u.full_name })}>
              <Pencil className="h-3 w-3" aria-hidden />{f.t('users.row.editRoles')}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2">
            <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {f.t('users.row.rolesOf', { name: u.full_name })}
            </p>
            <div role="group" aria-label={f.t('usersPage.colRoles')} className="flex flex-col gap-1">
              {availableRoles.map((r) => {
                const on = u.roles.includes(r);
                const Icon = roleIcon(r);
                return (
                  <button key={r} type="button" aria-pressed={on} onClick={() => onToggleRole(u, r)}
                    title={on ? f.t('usersPage.removeRole', { role: roleLabel(r) }) : f.t('usersPage.addRole', { role: roleLabel(r) })}
                    className={cn(
                      'flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      on ? roleTone(r) : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}>
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">{roleLabel(r)}</span>
                    {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

/** The active switch with its word; the whole label (36 px tall) is the touch target. */
function StatusCell({ u, editable, f, onToggleActive }: { u: UserRow; editable: boolean; f: InsightsFormat; onToggleActive: (u: UserRow) => void }) {
  const Icon = u.is_active ? CircleCheck : CirclePause;
  return (
    <label className={cn('inline-flex min-h-9 items-center gap-1.5', editable ? 'cursor-pointer' : 'cursor-not-allowed')}>
      <Switch checked={u.is_active} disabled={!editable} onCheckedChange={() => onToggleActive(u)}
        aria-label={f.t('users.row.activeToggle', { name: u.full_name })} className="-mx-1 scale-75" />
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', u.is_active ? STATUS_TEXT.good : STATUS_TEXT.critical)}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {u.is_active ? f.t('usersPage.active') : f.t('usersPage.suspended')}
      </span>
    </label>
  );
}

function LastSeen({ u, now, f }: { u: UserRow; now: number; f: InsightsFormat }) {
  if (isUserOnline(u, now)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <Circle className="h-2.5 w-2.5 fill-current" aria-hidden />{f.t('overview.teams.state.online')}
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground" title={u.last_seen_at ? formatDate(u.last_seen_at, 'dd.MM.yyyy HH:mm') : undefined}>
      {f.ago(u.last_seen_at, now)}
    </span>
  );
}

function RowActions({ u, canEdit, canDelete, onEdit, onDelete, f, compact }: {
  u: UserRow; canEdit: boolean; canDelete: boolean; onEdit: (u: UserRow) => void; onDelete: (u: UserRow) => void; f: InsightsFormat;
  /** The table's 32 px button; a card gets 36 px (touch). */
  compact?: boolean;
}) {
  const size = compact ? 'h-8 w-8' : 'h-9 w-9';
  if (!canEdit && !canDelete) return <span className={cn('inline-block shrink-0', size)} aria-hidden />;
  return (
    // modal={false}: the menu hands over to a dialog without leaving the page unclickable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('shrink-0', size)} aria-label={f.t('users.row.actions', { name: u.full_name })}>
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {canEdit && (
          <DropdownMenuItem onSelect={() => onEdit(u)}>
            <Pencil className="mr-2 h-4 w-4" aria-hidden />{f.t('common.edit')}
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem onSelect={() => onDelete(u)} className="text-destructive focus:text-destructive">
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />{f.t('common.delete')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
