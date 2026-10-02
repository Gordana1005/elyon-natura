// Поставки → Пристап и улоги (owner 03.10.2026). Every active staff login with its access LEVEL
// (migration 20260947001600) — what money it sees, and for a department admin which departments —
// and, for a super admin, the editor: a level, the department checkboxes grouped Тим Центар /
// Тим Маџари / Веб / Менаџмент, a note. GET /settings/access (super_admin + owner) and PUT
// /settings/access/:userId (super_admin) → the SQL writer access_set(), which re-checks, refuses
// to leave the system without a super admin and writes the audit row. App ROLES (the pages) stay
// on Корисници. Below xl the list is cards; from xl a table.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Briefcase, Building2, Crown, Handshake, Headphones, Landmark, Loader2, Lock, Package, Pencil, Search,
  ShieldCheck, Users, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollStrip } from '@/components/ui/scroll-strip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { cn } from '@/lib/utils';
import { departmentLabel } from '@/lib/orderSource';
import { ACCESS_LEVEL_ORDER, accessLevelName } from '@/lib/roles';
import type { AccessLevel } from '@/lib/access';
import { apiGetAccessLevels, apiSetAccessLevel, type AccessPersonRow } from '@/lib/api';
import { roleLabel } from '@/components/users/roleMeta';
import { skopjeDateTime } from './integrationsHealthModel';
import { SectionHeader, SettingsCard, settingsErrorText } from './settingsUi';
import {
  DEPT_GROUPS, bodyOf, draftChanged, draftError, draftOf, filterPeople, groupState, levelCounts,
  moneyScopeOf, takesDepts, toggleDept, toggleGroup, type AccessDraft,
} from './levelsModel';

const QUERY_KEY = ['settings-access-levels'] as const;

/** A level is always icon + word, never a colour alone. */
const LEVEL_ICON: Record<AccessLevel, LucideIcon> = {
  super_admin: ShieldCheck, owner: Crown, finance: Landmark, administrator: Briefcase, dept_admin: Building2,
  team_lead: Users, operator: Headphones, warehouse: Package, partner: Handshake,
};
const LEVEL_TONE: Record<AccessLevel, string> = {
  super_admin: 'bg-primary/10 text-primary border-primary/30',
  owner: 'bg-primary/10 text-primary border-primary/30',
  finance: 'bg-primary/10 text-primary border-primary/30',
  administrator: 'bg-chart-2/10 text-chart-2 border-chart-2/30',
  dept_admin: 'bg-chart-4/10 text-chart-4 border-chart-4/30',
  team_lead: 'bg-muted text-muted-foreground border-border',
  operator: 'bg-muted text-muted-foreground border-border',
  warehouse: 'bg-muted text-muted-foreground border-border',
  partner: 'bg-muted text-muted-foreground border-border',
};

const nameOf = (p: { full_name: string | null; email: string | null }) => p.full_name || p.email || '—';
const initial = (p: { full_name: string | null; email: string | null }) => (Array.from(nameOf(p))[0] ?? '?').toUpperCase();

function LevelBadge({ level, className }: { level: AccessLevel; className?: string }) {
  const { t } = useTranslation();
  const Icon = LEVEL_ICON[level];
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-left text-xs font-medium leading-tight', LEVEL_TONE[level], className)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{accessLevelName(level, t)}</span>
    </span>
  );
}

/** Company-wide · the departments (chips) · no money. */
function ScopeLine({ p }: { p: AccessPersonRow }) {
  const { t } = useTranslation();
  const s = moneyScopeOf(p.level, p.departments);
  if (s.kind === 'company') return <span className="text-xs text-muted-foreground">{t('settingsPage.levels.companyWide')}</span>;
  const chips = s.keys.map((k) => (
    <span key={k} className="inline-flex items-center rounded-md border bg-background px-1.5 py-0.5 text-[11px]">
      {departmentLabel(t, k) ?? k}
    </span>
  ));
  if (s.kind === 'depts') return <span className="flex flex-wrap gap-1">{chips}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-xs text-muted-foreground">{t('settingsPage.levels.noMoney')}</span>
      {chips}
    </span>
  );
}

function UpdatedLine({ p }: { p: AccessPersonRow }) {
  const { t } = useTranslation();
  if (!p.updated_at) return null;
  const when = skopjeDateTime(p.updated_at, true);
  return (
    <p className="text-[11px] text-muted-foreground">
      {p.updated_by_name ? t('settingsPage.levels.updatedLine', { when, who: p.updated_by_name }) : t('settingsPage.levels.updatedLineNoWho', { when })}
    </p>
  );
}

function ByRuleChip({ p }: { p: AccessPersonRow }) {
  const { t } = useTranslation();
  if (p.explicit) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground"
      title={t('settingsPage.levels.byRuleTitle')}>
      {t('settingsPage.levels.byRule')}
    </span>
  );
}

function LastSuperAdminChip({ p }: { p: AccessPersonRow }) {
  const { t } = useTranslation();
  if (!p.last_super_admin) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
      <Lock className="h-3 w-3" aria-hidden /> {t('settingsPage.levels.lastSuperAdminBadge')}
    </span>
  );
}

export function LevelsSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: apiGetAccessLevels, retry: 0 });
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<string>('all');
  const [editing, setEditing] = useState<AccessPersonRow | null>(null);
  // the legend: open on a desktop, folded on a phone (the list comes first there)
  const [legendOpen, setLegendOpen] = useState(!isMobile);

  const people = useMemo(() => q.data?.people ?? [], [q.data]);
  const canEdit = q.data?.can_edit === true;
  const counts = useMemo(() => levelCounts(people), [people]);
  const shown = useMemo(() => filterPeople(people, query, level), [people, query, level]);

  return (
    <div className="space-y-4">
      <SectionHeader
        icon={ShieldCheck}
        title={t('settingsPage.levels.title')}
        desc={t('settingsPage.levels.desc')}
        aside={q.data ? (
          <span className="rounded-full border bg-card px-2.5 py-0.5 text-xs text-muted-foreground">
            {t('settingsPage.levels.people', { count: people.length })}
          </span>
        ) : undefined}
      />

      {q.data && !canEdit && (
        <p className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> {t('settingsPage.levels.readOnly')}
        </p>
      )}

      {/* What each level sees — read-only, one line each (CLAUDE.md, the access levels of 02.10.2026) */}
      <details
        className="group rounded-xl border bg-card p-4 shadow-sm"
        open={legendOpen}
        onToggle={(e) => setLegendOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer list-none text-sm font-semibold marker:hidden [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>›</span>
            {t('settingsPage.levels.legendTitle')}
          </span>
        </summary>
        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          {ACCESS_LEVEL_ORDER.map((lv) => (
            <div key={lv} className="contents">
              <dt className="pt-0.5"><LevelBadge level={lv} /></dt>
              <dd className="pb-1 text-xs text-muted-foreground sm:pb-0">{t(`access.levelSees.${lv}`)}</dd>
            </div>
          ))}
        </dl>
      </details>

      <SettingsCard labelledBy="levels-list">
        <h3 id="levels-list" className="sr-only">{t('settingsPage.levels.title')}</h3>
        {q.isLoading ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" />}
            title={t('settingsPage.levels.loadFailed')}
            description={settingsErrorText(q.error)}
            size="sm"
            className="border-0 bg-transparent py-4"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : (
          <>
            <div className="mb-3 space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('settingsPage.levels.search')}
                  aria-label={t('settingsPage.levels.search')}
                  className="h-9 pl-8"
                />
              </div>
              <ScrollStrip role="group" aria-label={t('settingsPage.levels.colLevel')}>
                <FilterChip active={level === 'all'} onClick={() => setLevel('all')} label={t('settingsPage.levels.filterAll')} count={people.length} />
                {counts.map((c) => (
                  <FilterChip key={c.level} active={level === c.level} onClick={() => setLevel(level === c.level ? 'all' : c.level)}
                    label={accessLevelName(c.level, t) ?? c.level} count={c.count} />
                ))}
              </ScrollStrip>
            </div>

            {shown.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('settingsPage.levels.empty')}</p>
            ) : (
              <>
                {/* below xl: cards */}
                <ul className="space-y-2 xl:hidden">
                  {shown.map((p) => (
                    <li key={p.user_id} className="rounded-lg border p-3">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary" aria-hidden>{initial(p)}</span>
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div>
                            <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium">
                              <span className="break-words">{nameOf(p)}</span>
                              {p.user_id === user?.id && <span className="text-xs font-normal text-muted-foreground">{t('settings.you')}</span>}
                            </p>
                            {p.email && p.full_name && <p className="break-all text-xs text-muted-foreground">{p.email}</p>}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <LevelBadge level={p.level} />
                            <ByRuleChip p={p} />
                            <LastSuperAdminChip p={p} />
                          </div>
                          <ScopeLine p={p} />
                          {p.note && <p className="break-words text-xs italic text-muted-foreground">{p.note}</p>}
                          <p className="text-[11px] text-muted-foreground">
                            {t('settingsPage.levels.rolesLabel')}: {p.roles.length ? p.roles.map(roleLabel).join(', ') : '—'}
                          </p>
                          <UpdatedLine p={p} />
                        </div>
                        {canEdit && (
                          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => setEditing(p)}
                            aria-label={t('settingsPage.levels.editAria', { name: nameOf(p) })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>

                {/* xl and up: a table */}
                <div className="hidden overflow-hidden rounded-lg border xl:block">
                  <table className="w-full table-fixed text-sm">
                    <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="w-[37%] px-3 py-2 font-medium">{t('settingsPage.levels.colPerson')}</th>
                        <th className="w-[31%] px-3 py-2 font-medium">{t('settingsPage.levels.colLevel')}</th>
                        <th className="px-3 py-2 font-medium">{t('settingsPage.levels.colDepts')}</th>
                        {canEdit && <th className="w-12 px-2 py-2"><span className="sr-only">{t('settingsPage.levels.edit')}</span></th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {shown.map((p) => (
                        <tr key={p.user_id} className="align-top">
                          <td className="px-3 py-2.5">
                            <p className="break-words font-medium">
                              {nameOf(p)}
                              {p.user_id === user?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t('settings.you')}</span>}
                            </p>
                            {p.email && p.full_name && <p className="break-all text-xs text-muted-foreground">{p.email}</p>}
                            <p className="mt-0.5 text-[11px] text-muted-foreground">{p.roles.length ? p.roles.map(roleLabel).join(', ') : '—'}</p>
                            {/* the note and who changed it last sit with the person (no narrow column) */}
                            {p.note && <p className="mt-1 break-words text-xs italic text-muted-foreground">{p.note}</p>}
                            <UpdatedLine p={p} />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-1">
                              <LevelBadge level={p.level} />
                              <ByRuleChip p={p} />
                              <LastSuperAdminChip p={p} />
                            </div>
                          </td>
                          <td className="px-3 py-2.5"><ScopeLine p={p} /></td>
                          {canEdit && (
                            <td className="px-2 py-2">
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(p)}
                                aria-label={t('settingsPage.levels.editAria', { name: nameOf(p) })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </SettingsCard>

      <p className="text-[11px] text-muted-foreground">{t('settingsPage.levels.auditNote')}</p>

      {editing && canEdit && (
        <EditAccessDialog
          person={editing}
          levels={q.data?.levels ?? ACCESS_LEVEL_ORDER.filter((l) => l !== 'partner')}
          isSelf={editing.user_id === user?.id}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-8 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
      )}
    >
      <span className="whitespace-nowrap">{label}</span>
      <span className={cn('tabular-nums font-semibold', active ? '' : 'text-muted-foreground')}>{count}</span>
    </button>
  );
}

function EditAccessDialog({ person, levels, isSelf, onClose }: {
  person: AccessPersonRow; levels: readonly AccessLevel[]; isSelf: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { refresh: refreshPermissions } = usePermissions();
  const [draft, setDraft] = useState<AccessDraft>(() => draftOf(person));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const deptOn = takesDepts(draft.level);
  const shownDepts = deptOn ? draft.departments : [];
  const localError = draftError(person, draft);
  const changed = draftChanged(person, draft);
  const errorCode = serverError ?? (changed ? localError : null);
  // a last super admin's level is locked (access_write refuses to move it)
  const levelLocked = person.last_super_admin;

  const save = async () => {
    if (localError || !changed) return;
    setSaving(true);
    setServerError(null);
    try {
      await apiSetAccessLevel(person.user_id, bodyOf(person, draft));
      toast({ title: t('settingsPage.levels.savedToast', { name: nameOf(person), level: accessLevelName(draft.level, t) ?? draft.level }) });
      await qc.invalidateQueries({ queryKey: QUERY_KEY });
      if (isSelf) await refreshPermissions();
      onClose();
    } catch (err) {
      // the refusal stays in the dialog, in the reader's words (settingsPage.err.<code>)
      setServerError(err instanceof Error && err.message ? err.message : 'invalid_body');
    } finally {
      setSaving(false);
    }
  };

  const errorText = errorCode
    ? (errorCode === 'last_super_admin'
      ? t('settingsPage.levels.lastSuperAdmin', { name: nameOf(person) })
      : settingsErrorText(new Error(errorCode)))
    : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] overflow-y-auto rounded-lg p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base">{t('settingsPage.levels.editTitle', { name: nameOf(person) })}</DialogTitle>
          <DialogDescription className="break-all text-xs">
            {person.email ?? ''}{person.roles.length ? ` · ${t('settingsPage.levels.rolesLabel')}: ${person.roles.map(roleLabel).join(', ')}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* level */}
          <div className="space-y-1.5">
            <label htmlFor="access-level" className="block text-xs font-medium text-muted-foreground">{t('settingsPage.levels.levelLabel')}</label>
            <Select value={draft.level} onValueChange={(v) => { setServerError(null); setDraft((d) => ({ ...d, level: v as AccessLevel })); }}
              disabled={saving || levelLocked}>
              <SelectTrigger id="access-level" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {levels.map((lv) => (
                  <SelectItem key={lv} value={lv}>{accessLevelName(lv, t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(`access.levelSees.${draft.level}`)}</p>
            {levelLocked && (
              <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t('settingsPage.levels.lastSuperAdmin', { name: nameOf(person) })}
              </p>
            )}
          </div>

          {/* departments */}
          <fieldset className="space-y-2" disabled={saving || !deptOn}>
            <legend className="text-xs font-medium text-muted-foreground">{t('settingsPage.levels.deptsLabel')}</legend>
            <p className={cn('text-xs', deptOn ? 'text-muted-foreground' : 'text-muted-foreground/80')}>
              {draft.level === 'dept_admin' ? t('settingsPage.levels.deptsHelpDeptAdmin')
                : draft.level === 'team_lead' ? t('settingsPage.levels.deptsHelpTeamLead')
                  : t('settingsPage.levels.deptsNotApplicable')}
            </p>
            <div className={cn('grid gap-2 sm:grid-cols-2', !deptOn && 'opacity-50')}>
              {DEPT_GROUPS.map((g) => {
                const groupName = g.id === 'centar' ? t('insights.agents.team.byKey.teleshop')
                  : g.id === 'madzari' ? t('insights.agents.team.byKey.affiliate')
                    : g.id === 'web' ? t('settingsPage.levels.groupWeb')
                      : t('insights.common.source.management');
                const gid = `access-grp-${g.id}`;
                const single = g.keys.length === 1;
                return (
                  <div key={g.id} className="rounded-lg border p-2.5">
                    <div className="flex items-center gap-2">
                      <Checkbox id={gid} checked={groupState(shownDepts, g.keys)}
                        onCheckedChange={() => { setServerError(null); setDraft((d) => ({ ...d, departments: toggleGroup(d.departments, g.keys) })); }} />
                      <label htmlFor={gid} className="text-sm font-medium">{groupName}</label>
                    </div>
                    {!single && (
                      <ul className="mt-1.5 space-y-1 pl-6">
                        {g.keys.map((k) => {
                          const id = `access-dept-${k}`;
                          return (
                            <li key={k} className="flex items-center gap-2">
                              <Checkbox id={id} checked={shownDepts.includes(k)}
                                onCheckedChange={() => { setServerError(null); setDraft((d) => ({ ...d, departments: toggleDept(d.departments, k) })); }} />
                              <label htmlFor={id} className="text-xs">{departmentLabel(t, k) ?? k}</label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          {/* note */}
          <div className="space-y-1.5">
            <label htmlFor="access-note" className="block text-xs font-medium text-muted-foreground">{t('settingsPage.levels.noteLabel')}</label>
            <Textarea id="access-note" value={draft.note} maxLength={500} rows={2} disabled={saving}
              placeholder={t('settingsPage.levels.notePlaceholder')}
              onChange={(e) => { setServerError(null); setDraft((d) => ({ ...d, note: e.target.value })); }} />
          </div>

          {isSelf && !levelLocked && (
            <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {t('settingsPage.levels.selfWarning')}
            </p>
          )}
          {errorText && (
            <p role="alert" className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {errorText}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={() => { void save(); }} disabled={saving || !changed || !!localError}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
