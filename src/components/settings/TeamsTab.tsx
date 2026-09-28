// Settings → Teams (owners only, 2026-09-28). "Who works what — that list can
// always be changed and more people added" (Mile). Rendered only for a business
// owner (SettingsPage, same gate as Owners); every route behind it
// (/api/sales-people/*) re-checks is_business_owner() and writes audit_log.
// Data model: migration 20260935000100 (people, identities, dated team
// memberships, orders.sold_*); the writes: 20260939000200.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRightLeft, Crown, Link2, Loader2, Plus, RefreshCw, Search, Trash2, Unlink, UserPlus, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import i18n from '@/i18n';
import { cn } from '@/lib/utils';
import {
  apiAddSalesIdentity, apiCreateSalesPerson, apiDeleteSalesMembership, apiGetSalesTeams, apiGetSalesUnmapped,
  apiMoveSalesPerson, apiRemoveSalesIdentity, apiUpdateSalesPerson,
  type SalesIdentityInput, type SalesIdentityKind, type SalesMembership, type SalesPerson, type SalesTeamsOverview,
  type SalesUnmapped,
} from '@/lib/api';
import {
  altercpaIds, currentPrimary, dmy, identityKindForVia, movePreview, nextPrimary, personMatches,
  skopjeTodayYmd, teamColumns,
} from './teamsModel';
import { agoText } from './integrationsHealthModel';

const KINDS: SalesIdentityKind[] = ['altercpa_user', 'order_name', 'collabbox_author'];
const NONE = '__none__';

/** The routes answer with error CODES; settings.teams.err.<code> are their words. */
function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown) => {
    const code = err instanceof Error ? err.message : '';
    return code && i18n.exists(`settings.teams.err.${code}`) ? t(`settings.teams.err.${code}`) : apiErrorText(err);
  };
}

const ymdOf = (iso: string | null | undefined) => (iso ? skopjeTodayYmd(new Date(iso)) : '');

interface AddPreset { display_name?: string; user_id?: string | null; identity?: SalesIdentityInput | null; team_key?: string | null }

export function TeamsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addPreset, setAddPreset] = useState<AddPreset | null>(null);
  const [days, setDays] = useState(90);

  const teamsQ = useQuery({ queryKey: ['sales-teams'], queryFn: apiGetSalesTeams });
  const unmappedQ = useQuery({ queryKey: ['sales-unmapped', days], queryFn: () => apiGetSalesUnmapped(days) });
  const errorText = useErrorText();

  const data = teamsQ.data;
  const today = data?.today ?? skopjeTodayYmd();
  const reload = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['sales-teams'] }),
      qc.invalidateQueries({ queryKey: ['sales-unmapped'] }),
    ]);
  };

  const visible = useMemo(
    () => (data?.people ?? []).filter((p) => (showInactive || p.is_active) && personMatches(p, search)),
    [data, showInactive, search],
  );
  const columns = useMemo(() => teamColumns(visible, data?.teams ?? [], today), [visible, data, today]);
  const openPerson = data?.people.find((p) => p.id === openId) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> {t('settings.teams.title')}
          </h2>
          <p className="text-sm text-muted-foreground max-w-3xl">{t('settings.teams.desc')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('settings.teams.search')}
              aria-label={t('settings.teams.search')}
              className="h-9 w-64 pl-8"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} /> {t('settings.teams.showInactive')}
          </label>
          <Button variant="outline" size="sm" className="h-9" onClick={reload} aria-label={t('settings.teams.refresh')}>
            <RefreshCw className={cn('h-4 w-4', (teamsQ.isFetching || unmappedQ.isFetching) && 'animate-spin')} />
          </Button>
          <Button size="sm" className="h-9" onClick={() => setAddPreset({})}>
            <UserPlus className="h-4 w-4 mr-1" /> {t('settings.teams.addPerson')}
          </Button>
        </div>
      </div>

      {teamsQ.isLoading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : teamsQ.isError ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {errorText(teamsQ.error)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {columns.map((col) => (
            <section key={col.key} className="rounded-xl border bg-card shadow-sm">
              <header className="flex items-center justify-between border-b px-3 py-2">
                <h3 className="text-sm font-semibold">{col.team ? col.team.name : t('settings.teams.noTeam')}</h3>
                <span className="text-xs text-muted-foreground">{t('settings.teams.people', { count: col.entries.length })}</span>
              </header>
              {col.entries.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('settings.teams.empty')}</p>
              ) : (
                <ul className="divide-y">
                  {col.entries.map((e) => (
                    <li key={`${e.person.id}-${e.secondary ? 's' : 'p'}`}>
                      <PersonRow
                        person={e.person}
                        membership={e.membership}
                        secondary={e.secondary}
                        today={today}
                        teamName={(k) => data?.teams.find((x) => x.key === k)?.name ?? k}
                        onOpen={() => setOpenId(e.person.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {data && (
        <UnmappedPanel
          q={unmappedQ}
          days={days}
          setDays={setDays}
          data={data}
          onChanged={reload}
          onOpenPerson={setOpenId}
          onCreate={setAddPreset}
        />
      )}

      {data && (
        <PersonDrawer
          person={openPerson}
          data={data}
          today={today}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      )}
      {data && addPreset && (
        <AddPersonDialog
          preset={addPreset}
          data={data}
          today={today}
          onClose={() => setAddPreset(null)}
          onCreated={async (id) => { setAddPreset(null); await reload(); setOpenId(id); }}
        />
      )}
    </div>
  );
}

// ── one person in a team column ────────────────────────────────────────────
function PersonRow({
  person, membership, secondary, today, teamName, onOpen,
}: {
  person: SalesPerson; membership: SalesMembership | null; secondary: boolean; today: string;
  teamName: (key: string) => string; onOpen: () => void;
}) {
  const { t } = useTranslation();
  const ids = altercpaIds(person);
  const next = membership ? null : nextPrimary(person.memberships, today);
  const now = Date.now();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'w-full px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !person.is_active && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-sm">{person.display_name}</span>
        {person.is_manager && (
          <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]"><Crown className="h-3 w-3" />{t('settings.teams.badge.manager')}</Badge>
        )}
        {membership?.role === 'lead' && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{t('settings.teams.badge.lead')}</Badge>}
        {secondary && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{t('settings.teams.badge.secondary')}</Badge>}
        {!person.is_active && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{t('settings.teams.badge.inactive')}</Badge>}
        {person.user_id && person.login_active === false && (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">{t('settings.teams.badge.loginOff')}</Badge>
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {person.user_id
          ? (person.login_email || person.login_name)
          : ids.length ? t('settings.teams.altercpaOnly') : t('settings.teams.noLogin')}
        {ids.length > 0 && <span className="ml-1.5 tabular-nums">{ids.join(' ')}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        {membership && <span>{t('settings.teams.since', { date: dmy(membership.valid_from) })}</span>}
        {next && <span>{t('settings.teams.startsOn', { team: teamName(next.team_key), date: dmy(next.valid_from) })}</span>}
        <span>
          {person.last_activity_at
            ? t('settings.teams.lastDecision', { ago: agoText(t, person.last_activity_at, now) })
            : t('settings.teams.noDecisions')}
        </span>
      </div>
    </button>
  );
}

// ── the person drawer ──────────────────────────────────────────────────────
function PersonDrawer({
  person, data, today, onClose, onChanged,
}: {
  person: SalesPerson | null; data: SalesTeamsOverview; today: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const [active, setActive] = useState(true);
  const [manager, setManager] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loginPick, setLoginPick] = useState('');
  const [idKind, setIdKind] = useState<SalesIdentityKind>('order_name');
  const [idValue, setIdValue] = useState('');
  const [idAccount, setIdAccount] = useState('');
  const [removeId, setRemoveId] = useState<{ id: string; value: string } | null>(null);
  const [deleteRow, setDeleteRow] = useState<SalesMembership | null>(null);
  const [moveTeam, setMoveTeam] = useState<string>(NONE);
  const [moveFrom, setMoveFrom] = useState(today);
  const [moveRole, setMoveRole] = useState<'member' | 'lead'>('member');

  useEffect(() => {
    if (!person) return;
    setName(person.display_name);
    setActive(person.is_active);
    setManager(person.is_manager);
    setNotes(person.notes ?? '');
    setLoginPick('');
    setIdValue('');
    setIdAccount(data.accounts[0]?.id ?? '');
    const cur = currentPrimary(person.memberships, today);
    setMoveTeam(data.teams.find((x) => x.key !== cur?.team_key)?.key ?? NONE);
    setMoveFrom(today);
    setMoveRole('member');
    // Re-seed only when a different person opens, never on a background refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  if (!person) return null;

  const teamName = (k: string | null) => (k ? data.teams.find((x) => x.key === k)?.name ?? k : t('settings.teams.noTeam'));
  const accountName = (id: string | null) => data.accounts.find((a) => a.id === id)?.name ?? '';
  const run = async (key: string, fn: () => Promise<unknown>, ok: (r: any) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast({ title: ok(r) });
      await onChanged();
      return true;
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const withStamp = (title: string, r: any) =>
    r?.backstamped > 0 ? `${title} · ${t('settings.teams.backstamped', { count: r.backstamped })}` : title;

  const saveDetails = () => {
    const patch: Record<string, unknown> = {};
    if (name.trim() !== person.display_name) patch.display_name = name.trim();
    if (active !== person.is_active) patch.is_active = active;
    if (manager !== person.is_manager) patch.is_manager = manager;
    if ((notes.trim() || null) !== (person.notes ?? null)) patch.notes = notes.trim() || null;
    if (!Object.keys(patch).length) return;
    void run('save', () => apiUpdateSalesPerson(person.id, patch), (r) => withStamp(t('settings.teams.drawer.saved'), r));
  };
  const dirty = name.trim() !== person.display_name || active !== person.is_active || manager !== person.is_manager
    || (notes.trim() || null) !== (person.notes ?? null);

  const loginOptions = data.logins.filter((l) => l.person_id !== person.id);
  const prev = movePreview(person.memberships, moveFrom, moveTeam === NONE ? null : moveTeam, moveRole);
  const cur = prev.current;
  const previewText = (() => {
    const team = teamName(moveTeam === NONE ? null : moveTeam);
    const from = dmy(moveFrom);
    switch (prev.kind) {
      case 'blocked': return t('settings.teams.drawer.preview.blocked');
      case 'same': return t('settings.teams.drawer.preview.same', { team });
      case 'none': return moveTeam === NONE ? t('settings.teams.drawer.preview.nothingToEnd') : t('settings.teams.drawer.preview.none', { team, from });
      case 'replace': return t('settings.teams.drawer.preview.replace', { current: teamName(cur!.team_key), from, team });
      default: return moveTeam === NONE
        ? t('settings.teams.drawer.preview.closeOnly', { current: teamName(cur!.team_key), date: dmy(prev.closeOn) })
        : t('settings.teams.drawer.preview.close', { current: teamName(cur!.team_key), date: dmy(prev.closeOn), team, from });
    }
  })();
  const moveBlocked = prev.kind === 'blocked' || prev.kind === 'same' || (prev.kind === 'none' && moveTeam === NONE) || !moveFrom;

  return (
    <Sheet open={!!person} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {person.display_name}
            {!person.is_active && <Badge variant="secondary">{t('settings.teams.badge.inactive')}</Badge>}
          </SheetTitle>
          <SheetDescription>
            {person.last_activity_at
              ? t('settings.teams.lastDecision', { ago: agoText(t, person.last_activity_at, Date.now()) })
              : t('settings.teams.noDecisions')}
            {' · '}
            {t('settings.teams.work30', { n: person.decisions_30d, s: person.sales_30d })}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-6">
          {/* Details */}
          <section className="space-y-3">
            <h4 className="text-sm font-semibold">{t('settings.teams.drawer.details')}</h4>
            <div className="space-y-1.5">
              <Label htmlFor="tp-name">{t('settings.teams.drawer.name')}</Label>
              <Input id="tp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t('settings.teams.drawer.active')} <Switch checked={active} onCheckedChange={setActive} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              {t('settings.teams.drawer.manager')} <Switch checked={manager} onCheckedChange={setManager} />
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="tp-notes">{t('settings.teams.drawer.notes')}</Label>
              <Textarea id="tp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
            </div>
            <Button size="sm" onClick={saveDetails} disabled={!dirty || !name.trim() || busy === 'save'}>
              {busy === 'save' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} {t('settings.teams.drawer.save')}
            </Button>
          </section>

          {/* CRM login */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t('settings.teams.drawer.login')}</h4>
            {person.user_id ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span className="truncate">
                  {person.login_name}{person.login_email && <span className="text-muted-foreground"> · {person.login_email}</span>}
                </span>
                <Button
                  variant="ghost" size="sm" disabled={busy === 'unlink'}
                  onClick={() => void run('unlink', () => apiUpdateSalesPerson(person.id, { user_id: null }), () => t('settings.teams.drawer.unlinked'))}
                >
                  <Unlink className="h-4 w-4 mr-1" /> {t('settings.teams.drawer.unlink')}
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Select value={loginPick} onValueChange={setLoginPick}>
                  <SelectTrigger className="h-9 flex-1"><SelectValue placeholder={t('settings.teams.drawer.loginPick')} /></SelectTrigger>
                  <SelectContent>
                    {loginOptions.map((l) => {
                      const owner = l.person_id ? data.people.find((p) => p.id === l.person_id)?.display_name : null;
                      return (
                        <SelectItem key={l.user_id} value={l.user_id} disabled={!!l.person_id}>
                          {l.full_name || l.email}
                          <span className="text-muted-foreground">
                            {l.email && l.full_name ? ` · ${l.email}` : ''}
                            {owner ? ` · ${t('settings.teams.drawer.loginTaken', { name: owner })}` : ''}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <Button
                  size="sm" className="h-9" disabled={!loginPick || busy === 'link'}
                  onClick={() => void run('link', () => apiUpdateSalesPerson(person.id, { user_id: loginPick }), (r) => withStamp(t('settings.teams.drawer.saved'), r))}
                >
                  <Link2 className="h-4 w-4 mr-1" /> {t('settings.teams.drawer.link')}
                </Button>
              </div>
            )}
          </section>

          {/* Identities */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t('settings.teams.drawer.identities')}</h4>
            <p className="text-xs text-muted-foreground">{t('settings.teams.drawer.identitiesDesc')}</p>
            {person.identities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settings.teams.drawer.noIdentities')}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {person.identities.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                    <span className="min-w-0">
                      <Badge variant="outline" className="mr-2 text-[10px]">{t(`settings.teams.kind.${i.kind}`)}</Badge>
                      <span className="font-mono text-xs whitespace-pre-wrap break-all">{i.kind === 'altercpa_user' ? `#${i.value}` : i.value}</span>
                      {i.kind === 'altercpa_user' && data.accounts.length > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">({accountName(i.account_id)})</span>
                      )}
                    </span>
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                      aria-label={t('settings.teams.drawer.remove')}
                      onClick={() => setRemoveId({ id: i.id, value: i.value })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Select value={idKind} onValueChange={(v) => setIdKind(v as SalesIdentityKind)}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k} value={k}>{t(`settings.teams.kind.${k}`)}</SelectItem>)}
                </SelectContent>
              </Select>
              {idKind === 'altercpa_user' && data.accounts.length > 1 && (
                <Select value={idAccount} onValueChange={setIdAccount}>
                  <SelectTrigger className="h-9 w-40" aria-label={t('settings.teams.drawer.account')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                placeholder={t('settings.teams.drawer.valuePh')}
                aria-label={t('settings.teams.drawer.value')}
                className="h-9 flex-1 min-w-[160px]"
                inputMode={idKind === 'altercpa_user' ? 'numeric' : undefined}
              />
              <Button
                size="sm" className="h-9" disabled={!idValue.trim() || busy === 'addId'}
                onClick={async () => {
                  const ok = await run('addId', () => apiAddSalesIdentity(person.id, {
                    kind: idKind, value: idValue, account_id: idKind === 'altercpa_user' ? (idAccount || null) : null,
                  }), (r) => withStamp(t('settings.teams.drawer.added'), r));
                  if (ok) setIdValue('');
                }}
              >
                <Plus className="h-4 w-4 mr-1" /> {t('settings.teams.drawer.add')}
              </Button>
            </div>
          </section>

          {/* Move */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" /> {t('settings.teams.drawer.move')}</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">{t('settings.teams.drawer.moveTeam')}</Label>
                <Select value={moveTeam} onValueChange={setMoveTeam}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.teams.map((tm) => <SelectItem key={tm.key} value={tm.key}>{tm.name}</SelectItem>)}
                    <SelectItem value={NONE}>{t('settings.teams.drawer.moveNoTeam')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="tp-from">{t('settings.teams.drawer.moveFrom')}</Label>
                <Input id="tp-from" type="date" className="h-9" value={moveFrom} onChange={(e) => setMoveFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('settings.teams.drawer.moveRole')}</Label>
                <Select value={moveRole} onValueChange={(v) => setMoveRole(v as 'member' | 'lead')} disabled={moveTeam === NONE}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t('settings.teams.role.member')}</SelectItem>
                    <SelectItem value="lead">{t('settings.teams.role.lead')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className={cn('text-xs', moveBlocked ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{previewText}</p>
            <Button
              size="sm" disabled={moveBlocked || busy === 'move'}
              onClick={() => void run('move', () => apiMoveSalesPerson(person.id, {
                team_key: moveTeam === NONE ? null : moveTeam, from: moveFrom, role: moveRole,
              }), () => t('settings.teams.drawer.moved'))}
            >
              {busy === 'move' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} {t('settings.teams.drawer.moveButton')}
            </Button>
          </section>

          {/* History */}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">{t('settings.teams.drawer.history')}</h4>
            {person.memberships.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settings.teams.drawer.historyEmpty')}</p>
            ) : (
              <ol className="relative space-y-2 border-l pl-4">
                {person.memberships.map((m) => {
                  const live = m.valid_from <= today && (m.valid_to == null || m.valid_to >= today);
                  return (
                    <li key={m.id} className="relative">
                      <span className={cn('absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background', live ? 'bg-primary' : 'bg-muted-foreground/40')} aria-hidden />
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm">
                          <span className="font-medium">{teamName(m.team_key)}</span>
                          {m.role === 'lead' && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-[10px]">{t('settings.teams.badge.lead')}</Badge>}
                          {!m.is_primary && <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">{t('settings.teams.drawer.secondary')}</Badge>}
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {dmy(m.valid_from)} – {m.valid_to ? dmy(m.valid_to) : t('settings.teams.drawer.now')}
                            {m.note && <span className="ml-1.5">· {m.note}</span>}
                          </div>
                        </div>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                          aria-label={t('settings.teams.drawer.deleteRow')}
                          onClick={() => setDeleteRow(m)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        <AlertDialog open={!!removeId} onOpenChange={(o) => { if (!o) setRemoveId(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.teams.drawer.removeTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.teams.drawer.removeBody', { value: removeId?.value ?? '', name: person.display_name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = removeId;
                  setRemoveId(null);
                  if (target) void run('rmId', () => apiRemoveSalesIdentity(target.id), () => t('settings.teams.drawer.removed'));
                }}
              >
                {t('settings.teams.drawer.remove')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={!!deleteRow} onOpenChange={(o) => { if (!o) setDeleteRow(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.teams.drawer.deleteRowTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteRow && t('settings.teams.drawer.deleteRowBody', {
                  team: teamName(deleteRow.team_key), from: dmy(deleteRow.valid_from),
                  to: deleteRow.valid_to ? dmy(deleteRow.valid_to) : t('settings.teams.drawer.now'),
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const target = deleteRow;
                  setDeleteRow(null);
                  if (target) void run('rmRow', () => apiDeleteSalesMembership(target.id), () => t('settings.teams.drawer.rowDeleted'));
                }}
              >
                {t('settings.teams.drawer.deleteRow')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}

// ── "Add person" ───────────────────────────────────────────────────────────
function AddPersonDialog({
  preset, data, today, onClose, onCreated,
}: {
  preset: AddPreset; data: SalesTeamsOverview; today: string; onClose: () => void; onCreated: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const errorText = useErrorText();
  const [name, setName] = useState(preset.display_name ?? '');
  const [login, setLogin] = useState(preset.user_id ?? NONE);
  const [manager, setManager] = useState(false);
  const [team, setTeam] = useState(preset.team_key ?? (preset.identity?.kind === 'altercpa_user' ? 'altercpa_leads' : NONE));
  const [from, setFrom] = useState(today);
  const [role, setRole] = useState<'member' | 'lead'>('member');
  const [idKind, setIdKind] = useState<SalesIdentityKind>(preset.identity?.kind ?? 'order_name');
  const [idValue, setIdValue] = useState(preset.identity?.value ?? '');
  const [busy, setBusy] = useState(false);
  const accountId = preset.identity?.account_id ?? data.accounts[0]?.id ?? null;
  const freeLogins = data.logins.filter((l) => !l.person_id && l.is_active && l.roles.some((r) => r !== 'affiliate'));

  const create = async () => {
    setBusy(true);
    try {
      const identities: SalesIdentityInput[] = idValue.trim()
        ? [{ kind: idKind, value: idValue, account_id: idKind === 'altercpa_user' ? accountId : null }]
        : [];
      const r = await apiCreateSalesPerson({
        display_name: name.trim(), user_id: login === NONE ? null : login, is_manager: manager,
        team_key: team === NONE ? null : team, team_from: team === NONE ? null : from, team_role: role, identities,
      });
      const title = t('settings.teams.add.created', { name: name.trim() });
      toast({ title: r.backstamped > 0 ? `${title} · ${t('settings.teams.backstamped', { count: r.backstamped })}` : title });
      await onCreated(r.person.id);
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.teams.add.title')}</DialogTitle>
          <DialogDescription>{t('settings.teams.add.desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ap-name">{t('settings.teams.add.name')}</Label>
            <Input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>{t('settings.teams.add.login')}</Label>
            <Select value={login} onValueChange={(v) => {
              setLogin(v);
              const l = data.logins.find((x) => x.user_id === v);
              if (l && !name.trim()) setName(l.full_name ?? '');
            }}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('settings.teams.add.noLoginOption')}</SelectItem>
                {freeLogins.map((l) => (
                  <SelectItem key={l.user_id} value={l.user_id}>
                    {l.full_name || l.email}{l.email && l.full_name ? <span className="text-muted-foreground"> · {l.email}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.teams.add.team')}</Label>
              <Select value={team} onValueChange={setTeam}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('settings.teams.add.noTeamOption')}</SelectItem>
                  {data.teams.map((tm) => <SelectItem key={tm.key} value={tm.key}>{tm.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ap-from">{t('settings.teams.add.from')}</Label>
              <Input id="ap-from" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} disabled={team === NONE} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.teams.add.role')}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as 'member' | 'lead')} disabled={team === NONE}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{t('settings.teams.role.member')}</SelectItem>
                  <SelectItem value="lead">{t('settings.teams.role.lead')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            {t('settings.teams.add.manager')} <Switch checked={manager} onCheckedChange={setManager} />
          </label>
          <div className="space-y-1.5">
            <Label>{t('settings.teams.add.identity')}</Label>
            <div className="flex gap-2">
              <Select value={idKind} onValueChange={(v) => setIdKind(v as SalesIdentityKind)}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k} value={k}>{t(`settings.teams.kind.${k}`)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input
                value={idValue} onChange={(e) => setIdValue(e.target.value)} className="h-9 flex-1"
                placeholder={t('settings.teams.drawer.valuePh')} aria-label={t('settings.teams.drawer.value')}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={create} disabled={!name.trim() || busy || (team !== NONE && !from)}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} {t('settings.teams.add.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── the unmapped queue ─────────────────────────────────────────────────────
function PersonPicker({
  people, value, onChange,
}: { people: SalesPerson[]; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-56 text-xs"><SelectValue placeholder={t('settings.teams.unmapped.assignTo')} /></SelectTrigger>
      <SelectContent>
        {people.map((p) => (
          <SelectItem key={p.id} value={p.id} className="text-xs">
            {p.display_name}{!p.is_active ? ` (${t('settings.teams.badge.inactive')})` : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AssignRow({
  people, initial, busy, onAssign, onCreate, label,
}: {
  people: SalesPerson[]; initial?: string | null; busy: boolean; label: string;
  onAssign: (personId: string) => void; onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState(initial ?? '');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PersonPicker people={people} value={pick} onChange={setPick} />
      <Button size="sm" className="h-8" disabled={!pick || busy} onClick={() => onAssign(pick)}>
        {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} {label}
      </Button>
      <Button size="sm" variant="outline" className="h-8" onClick={onCreate}>
        <UserPlus className="h-3.5 w-3.5 mr-1" /> {t('settings.teams.unmapped.create')}
      </Button>
    </div>
  );
}

function SampleOrders({ sample }: { sample: { id: string; display_id: string }[] }) {
  const { t } = useTranslation();
  if (!sample?.length) return null;
  return (
    <span className="text-[11px] text-muted-foreground">
      {t('settings.teams.unmapped.sample')}{' '}
      {sample.map((s, i) => (
        <span key={s.id}>
          {i > 0 && ', '}
          <Link to={`/orders?search=${encodeURIComponent(s.display_id)}`} className="underline-offset-2 hover:underline">{s.display_id}</Link>
        </span>
      ))}
    </span>
  );
}

function UnmappedPanel({
  q, days, setDays, data, onChanged, onOpenPerson, onCreate,
}: {
  q: { data?: SalesUnmapped; isLoading: boolean; isError: boolean; error: unknown };
  days: number; setDays: (d: number) => void; data: SalesTeamsOverview;
  onChanged: () => Promise<void>; onOpenPerson: (id: string) => void; onCreate: (p: AddPreset) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const errorText = useErrorText();
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();
  const people = useMemo(() => [...data.people].sort((a, b) => a.display_name.localeCompare(b.display_name)), [data.people]);
  const u = q.data;

  const act = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key);
    try {
      const r = await fn();
      toast({ title: r?.backstamped > 0 ? `${ok} · ${t('settings.teams.backstamped', { count: r.backstamped })}` : ok });
      await onChanged();
    } catch (err) {
      toast({ title: t('common.error'), description: errorText(err), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const activeLogins = (u?.logins ?? []).filter((l) => l.is_active);
  const orderGroups = u?.orders ?? [];
  const total = (u?.altercpa.length ?? 0) + (u?.unnamed.length ?? 0) + activeLogins.length + orderGroups.length;

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className={cn('h-4 w-4', total > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} />
            {t('settings.teams.unmapped.title')}
            {u && total > 0 && <Badge variant="secondary">{total}</Badge>}
          </h3>
          <p className="text-xs text-muted-foreground">{t('settings.teams.unmapped.desc')}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('settings.teams.unmapped.window')}
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[30, 90, 365].map((d) => <SelectItem key={d} value={String(d)} className="text-xs">{t('settings.teams.unmapped.days', { days: d })}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </header>

      {q.isLoading ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('settings.teams.unmapped.loading')}</p>
      ) : q.isError ? (
        <p className="px-4 py-4 text-sm text-destructive">{errorText(q.error)}</p>
      ) : total === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t('settings.teams.unmapped.allClear')}</p>
      ) : (
        <div className="divide-y">
          {u!.altercpa.length > 0 && (
            <div className="space-y-2 px-4 py-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.teams.unmapped.altercpaTitle')}</h4>
              {u!.altercpa.map((a) => (
                <div key={`${a.account_id}-${a.altercpa_user}`} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-mono font-medium">#{a.altercpa_user}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('settings.teams.unmapped.altercpaRow', { n: a.decisions, sales: a.sales, from: dmy(ymdOf(a.first_at)), to: dmy(ymdOf(a.last_at)) })}
                    </span>
                    <div><SampleOrders sample={a.sample} /></div>
                  </div>
                  <AssignRow
                    people={people} busy={busy === `a${a.altercpa_user}`} label={t('settings.teams.unmapped.assign')}
                    onAssign={(pid) => void act(`a${a.altercpa_user}`, () => apiAddSalesIdentity(pid, { kind: 'altercpa_user', value: String(a.altercpa_user), account_id: a.account_id }), t('settings.teams.drawer.added'))}
                    onCreate={() => onCreate({ display_name: `AlterCPA #${a.altercpa_user}`, identity: { kind: 'altercpa_user', value: String(a.altercpa_user), account_id: a.account_id } })}
                  />
                </div>
              ))}
            </div>
          )}

          {u!.unnamed.length > 0 && (
            <div className="space-y-2 px-4 py-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.teams.unmapped.unnamedTitle')}</h4>
              {u!.unnamed.map((p) => (
                <div key={p.person_id} className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-medium">{p.display_name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('settings.teams.unmapped.unnamedRow', { n: p.decisions, ago: agoText(t, p.last_at, now) })}
                    </span>
                  </div>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => onOpenPerson(p.person_id)}>{t('settings.teams.unmapped.open')}</Button>
                </div>
              ))}
            </div>
          )}

          {(u!.logins.length > 0) && (
            <div className="space-y-2 px-4 py-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.teams.unmapped.loginsTitle')}</h4>
              {u!.logins.map((l) => (
                <div key={l.user_id} className={cn('flex flex-wrap items-center justify-between gap-2', (!l.is_active || l.is_test) && 'opacity-60')}>
                  <div className="text-sm">
                    <span className="font-medium">{l.full_name || l.email}</span>
                    {l.email && <span className="ml-1.5 text-xs text-muted-foreground">{l.email}</span>}
                    {l.is_test && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-[10px]">{t('settings.teams.unmapped.loginTest')}</Badge>}
                    {!l.is_active && <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px]">{t('settings.teams.unmapped.loginInactive')}</Badge>}
                    {l.last_work_at && <span className="ml-1.5 text-xs text-muted-foreground">{t('settings.teams.unmapped.lastWork', { ago: agoText(t, l.last_work_at, now) })}</span>}
                  </div>
                  <AssignRow
                    people={people.filter((p) => !p.user_id)} busy={busy === `l${l.user_id}`} label={t('settings.teams.unmapped.link')}
                    onAssign={(pid) => void act(`l${l.user_id}`, () => apiUpdateSalesPerson(pid, { user_id: l.user_id }), t('settings.teams.drawer.saved'))}
                    onCreate={() => onCreate({
                      display_name: l.full_name ?? '', user_id: l.user_id,
                      identity: l.full_name ? { kind: 'order_name', value: l.full_name } : null,
                    })}
                  />
                </div>
              ))}
            </div>
          )}

          {orderGroups.length > 0 && (
            <div className="space-y-2 px-4 py-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('settings.teams.unmapped.ordersTitle')}</h4>
              {orderGroups.map((g) => {
                const kind = identityKindForVia(g.sold_via);
                const key = `o${g.sold_via}|${g.ext}|${g.stamped}|${g.sale_source}`;
                const via = g.sold_via ?? g.sale_source ?? '';
                return (
                  <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium whitespace-pre">{g.ext ?? t('settings.teams.unmapped.noKey')}</span>
                      {via && <Badge variant="outline" className="ml-1.5 h-5 px-1.5 text-[10px]">
                        {i18n.exists(`settings.teams.unmapped.via.${via}`) ? t(`settings.teams.unmapped.via.${via}`) : via}
                      </Badge>}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('settings.teams.unmapped.ordersRow', { n: g.n, from: dmy(ymdOf(g.first_at)), to: dmy(ymdOf(g.last_at)) })}
                      </span>
                      {g.suggestion && (
                        <div className={cn('text-xs', g.suggestion.match === 'same' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
                          {g.suggestion.match === 'same'
                            ? t('settings.teams.unmapped.suggestSame', { name: g.suggestion.display_name })
                            : t('settings.teams.unmapped.suggestNear', { name: g.suggestion.display_name })}
                        </div>
                      )}
                      {!g.stamped && <div className="text-xs text-muted-foreground">{t('settings.teams.unmapped.notStamped')}</div>}
                      <div><SampleOrders sample={g.sample} /></div>
                    </div>
                    {g.stamped && kind && g.ext && (
                      <AssignRow
                        people={people} initial={g.suggestion?.person_id} busy={busy === key} label={t('settings.teams.unmapped.assign')}
                        onAssign={(pid) => void act(key, () => apiAddSalesIdentity(pid, { kind, value: g.ext! }), t('settings.teams.drawer.added'))}
                        onCreate={() => onCreate({ display_name: g.ext ?? '', identity: { kind, value: g.ext! } })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
