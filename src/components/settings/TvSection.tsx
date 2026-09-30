// Поставки → ТВ табла (admins; Phase 10, 2026-10-01). The TV board v2
// (leaderboard_day_v2) reads neither the roster nor the bonus rules, and bonus
// is deferred by the owner — so this page only hands out the board's links:
// one for the whole company, one per department and one per team, in the
// language the TV should speak, plus the access tokens (new, rotate, revoke —
// rotate and revoke blank every TV on the old link, so both ask first).
// The roster / bonus-tier / mode UI stays in LeaderboardTab.tsx, not mounted.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Loader2, Plus, RefreshCw, Trash2, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { formatDayDmy } from '@/i18n/dates';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { DEPARTMENTS, deptKey } from '@/lib/leaderboardV2';
import { teamLabel } from '@/components/tvboard/tvBoardHelpers';
import { apiGetLeaderboardAdmin, apiGetSalesTeams, apiManageLeaderboardToken, type LeaderboardAccessToken } from '@/lib/api';
import { ConfirmDialog, SectionHeader, SettingsCard, settingsErrorText } from './settingsUi';

/** The TV URL for a token + a view. `dept` / `team` are what TvLeaderboardPage's initialFilter reads. */
export function tvUrl(origin: string, token: string, view: { dept?: string; team?: string }, lang: string): string {
  const qs = new URLSearchParams({ key: token });
  if (view.dept) qs.set('dept', view.dept);
  if (view.team) qs.set('team', view.team);
  if (lang) qs.set('lang', lang);
  return `${origin}/tv/leaderboard?${qs.toString()}`;
}

/** Macedonian first: the office TVs speak it. */
const LANGS = [...SUPPORTED_LANGUAGES].sort((a, b) => (a === 'mk' ? -1 : b === 'mk' ? 1 : 0));

export function TvSection() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // Same cache key as Insights → Агенти (TeamsBoard), so both see one token list.
  const cfgQ = useQuery({ queryKey: ['lb-admin', 'prediction'], queryFn: () => apiGetLeaderboardAdmin('prediction') });
  // The team list (owners only on the api; an admin is always an owner).
  const teamsQ = useQuery({ queryKey: ['sales-teams'], queryFn: apiGetSalesTeams, enabled: canSeeBusiness || !!user?.isAdmin, retry: 0 });
  const [lang, setLang] = useState<string>(LANGS.includes(i18n.language as never) ? i18n.language : 'mk');
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'rotate' | 'revoke' | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rotate' } | { kind: 'revoke'; token: LeaderboardAccessToken } | null>(null);

  const active = useMemo(() => (cfgQ.data?.tokens ?? []).filter((tok) => tok.is_active), [cfgQ.data]);
  const token = active.find((tok) => tok.id === tokenId) ?? active[0] ?? null;
  const teams = useMemo(
    () => (teamsQ.data?.teams ?? []).filter((tm) => tm.key !== 'management'),
    [teamsQ.data],
  );

  const act = async (kind: 'create' | 'rotate' | 'revoke', body: Parameters<typeof apiManageLeaderboardToken>[0]) => {
    setBusy(kind);
    try {
      const res = await apiManageLeaderboardToken(body);
      toast({ title: t(`settingsPage.tv.done.${kind}`) });
      if (res?.token?.id) setTokenId(res.token.id);
      await qc.invalidateQueries({ queryKey: ['lb-admin'] });
    } catch (err) {
      toast({ title: t('common.error'), description: settingsErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard?.writeText(url);
      toast({ title: t('settingsPage.tv.copied') });
    } catch {
      toast({ title: t('common.error'), description: url });
    }
  };

  const rows: { key: string; label: string; view: { dept?: string; team?: string } }[] = [
    { key: 'all', label: t('settingsPage.tv.all'), view: {} },
    ...DEPARTMENTS.map((d) => ({ key: `d:${d}`, label: t(`leaderboard2.dept.${deptKey(d)}`), view: { dept: d } })),
    ...teams.map((tm) => ({ key: `t:${tm.key}`, label: teamLabel(t, tm.key, tm.name), view: { team: tm.key } })),
  ];

  return (
    <div className="space-y-4">
      <SectionHeader icon={Tv} title={t('settingsPage.tv.title')} desc={t('settingsPage.tv.desc')} />

      {/* Tokens */}
      <SettingsCard title={t('settingsPage.tv.tokensTitle')} desc={t('settingsPage.tv.tokensDesc')} labelledBy="tv-tokens">
        {cfgQ.isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
        ) : cfgQ.isError ? (
          <p className="text-sm text-destructive">{settingsErrorText(cfgQ.error)}</p>
        ) : (
          <div className="space-y-3">
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settingsPage.tv.noToken')}</p>
            ) : (
              <ul className="divide-y rounded-lg border" aria-labelledby="tv-tokens">
                {active.map((tok) => (
                  <li key={tok.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">{tok.label || 'TV'}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{t('settingsPage.tv.createdOn', { date: formatDayDmy(tok.created_at) })}</span>
                    </span>
                    <Button variant="ghost" size="sm" className="h-9 text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirm({ kind: 'revoke', token: tok })} disabled={busy !== null}>
                      <Trash2 className="mr-1 h-4 w-4" aria-hidden /> {t('settingsPage.tv.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-9" onClick={() => void act('create', { action: 'create', label: 'TV' })} disabled={busy !== null}>
                {busy === 'create' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />} {t('settingsPage.tv.create')}
              </Button>
              {active.length > 0 && (
                <Button variant="outline" size="sm" className="h-9" onClick={() => setConfirm({ kind: 'rotate' })} disabled={busy !== null}>
                  <RefreshCw className="mr-1 h-4 w-4" /> {t('settingsPage.tv.rotate')}
                </Button>
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      {/* Links */}
      {token && (
        <SettingsCard title={t('settingsPage.tv.linksTitle')} desc={t('settingsPage.tv.linksDesc')} labelledBy="tv-links">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <span className="block text-[11px] font-medium text-muted-foreground">{t('settingsPage.tv.lang')}</span>
              <Select value={lang} onValueChange={setLang}>
                <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANGS.map((l) => <SelectItem key={l} value={l}>{t(`languages.${l}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            {active.length > 1 && (
              <label className="space-y-1">
                <span className="block text-[11px] font-medium text-muted-foreground">{t('settingsPage.tv.token')}</span>
                <Select value={token.id} onValueChange={setTokenId}>
                  <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {active.map((tok) => (
                      <SelectItem key={tok.id} value={tok.id}>{`${tok.label || 'TV'} · ${formatDayDmy(tok.created_at)}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
          </div>
          <ul className="divide-y rounded-lg border" aria-labelledby="tv-links">
            {rows.map((r, i) => {
              const url = tvUrl(origin, token.token, r.view, lang);
              const heading = i === 0 ? null : i === 1 ? t('settingsPage.tv.byDept') : i === 1 + DEPARTMENTS.length ? t('settingsPage.tv.byTeam') : null;
              return (
                <li key={r.key}>
                  {heading && <p className="bg-muted/40 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{heading}</p>}
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 basis-40 text-sm font-medium">{r.label}</span>
                    <span className="flex shrink-0 gap-1.5">
                      <Button variant="outline" size="sm" className="h-9" onClick={() => void copy(url)} aria-label={`${t('settingsPage.tv.copy')} · ${r.label}`}>
                        <Copy className="mr-1 h-4 w-4" aria-hidden /> {t('settingsPage.tv.copy')}
                      </Button>
                      <Button asChild variant="ghost" size="sm" className="h-9">
                        <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${t('settingsPage.tv.open')} · ${r.label}`}>
                          <ExternalLink className="mr-1 h-4 w-4" aria-hidden /> {t('settingsPage.tv.open')}
                        </a>
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </SettingsCard>
      )}

      <p className="text-[11px] text-muted-foreground">{t('settingsPage.tv.bonusDeferred')}</p>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'rotate' ? t('settingsPage.tv.rotateTitle') : t('settingsPage.tv.revokeTitle')}
        body={<p>{confirm?.kind === 'rotate' ? t('settingsPage.tv.rotateBody', { count: active.length }) : t('settingsPage.tv.revokeBody')}</p>}
        confirmLabel={confirm?.kind === 'rotate' ? t('settingsPage.tv.rotateConfirm') : t('settingsPage.tv.revokeConfirm')}
        destructive
        busy={busy === 'rotate' || busy === 'revoke'}
        onConfirm={() => {
          if (confirm?.kind === 'rotate') void act('rotate', { action: 'rotate', label: 'TV' });
          else if (confirm?.kind === 'revoke') void act('revoke', { action: 'revoke', id: confirm.token.id });
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
