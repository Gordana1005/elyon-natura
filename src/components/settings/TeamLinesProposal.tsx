// Settings → Teams → Предлог (owner ruling 30.09.2026: a TEAM is a BUSINESS LINE, for the whole
// history). The proposal comes from each person's credited sales by department
// (sales_team_line_proposal, migration 20260943000900) with a confidence; the owner accepts one
// row (as proposed, or with another team / lane picked in the row) or every "sure" row at once.
// An accepted row re-keys ALL of the person's memberships (team + lane) — the department of each
// sale never changes (collabBox folder + MEX profile decide it). Insights style: a card per
// person below xl, one grid row per person from xl; nothing scrolls sideways at 360–1920 px.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import {
  apiApplyTeamLines, apiGetLineProposal,
  type LineApplyRow, type LineConfidence, type SalesTeam, type TeamLane,
} from '@/lib/api';
import { laneLabel, teamLaneLabel } from '@/lib/teamLines';
import { fmtNum } from '@/components/insights/overview/model';
import {
  applyRowFor, deptCounts, isCompletePick, laneAfterTeamChange, lanesFor, sureApplyRows, targetTeams, visibleRows,
  type ProposalView,
} from './teamLinesModel';

const DAYS = 60;
const NONE = '__none__';

const CONF_TONE: Record<LineConfidence, string> = {
  sure: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300',
  likely: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300',
  decide: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300',
};

/** A refusal code → words (teamLines.err.*, else the generic api text). */
export function lineErrorText(err: unknown): string {
  const code = err instanceof Error ? err.message : '';
  if (code && i18n.exists(`teamLines.err.${code}`)) return i18n.t(`teamLines.err.${code}`);
  if (code && i18n.exists(`settings.teams.err.${code}`)) return i18n.t(`settings.teams.err.${code}`);
  return apiErrorText(err);
}

export function TeamLinesProposal({ teams, defaultOpen, onApplied }: {
  teams: SalesTeam[];
  /** Open on arrival (someone still sits in a legacy team or in no team). */
  defaultOpen: boolean;
  onApplied: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [view, setView] = useState<ProposalView>('changes');
  const [picks, setPicks] = useState<Record<string, { team: string | null; lane: TeamLane | null }>>({});
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['sales-line-proposal', DAYS], queryFn: () => apiGetLineProposal(DAYS), enabled: open, staleTime: 60_000 });
  const data = q.data;
  const rows = useMemo(() => visibleRows(data?.rows ?? [], view), [data, view]);
  const sure = useMemo(() => sureApplyRows(data?.rows ?? []), [data]);
  const options = useMemo(() => targetTeams(teams), [teams]);
  const teamText = (key: string | null) =>
    (key ? t(`insights.agents.team.byKey.${key}`, { defaultValue: teams.find((x) => x.key === key)?.name ?? key }) : t('teamLines.proposal.noTeam'));

  const apply = async (key: string, applyRows: LineApplyRow[]) => {
    if (!applyRows.length) return;
    setBusy(key);
    try {
      await apiApplyTeamLines(applyRows);
      toast({ title: t('teamLines.proposal.accepted', { n: applyRows.length }) });
      setPicks((p) => {
        const next = { ...p };
        for (const r of applyRows) delete next[r.person_id];
        return next;
      });
      await Promise.all([onApplied(), qc.invalidateQueries({ queryKey: ['sales-line-proposal'] })]);
    } catch (err) {
      toast({ title: t('common.error'), description: lineErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const s = data?.summary;
  return (
    <section aria-labelledby="team-lines-title" className="rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
        <div className="min-w-0 max-w-3xl">
          <h3 id="team-lines-title" className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden /> {t('teamLines.proposal.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('teamLines.proposal.desc', { days: DAYS })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {open && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => void q.refetch()} aria-label={t('teamLines.proposal.refresh')}>
              <RefreshCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} aria-hidden />
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8 gap-1" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
            {open ? t('teamLines.proposal.hide') : t('teamLines.proposal.show')}
          </Button>
        </div>
      </header>

      {open && (
        <div className="border-t">
          {q.isLoading ? (
            <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('teamLines.proposal.loading')}
            </p>
          ) : q.isError ? (
            <p className="flex items-center gap-2 px-4 py-4 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {lineErrorText(q.error)}
            </p>
          ) : data && (
            <>
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                {s && (['sure', 'likely', 'decide'] as const).map((c) => (
                  <span key={c} className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', CONF_TONE[c])}>
                    {t(`teamLines.proposal.count.${c}`, { n: s[c] })}
                  </span>
                ))}
                {s && <span className="text-xs text-muted-foreground">{t('teamLines.proposal.count.unchanged', { n: s.unchanged })}</span>}
                <div role="group" aria-label={t('teamLines.proposal.viewLabel')} className="flex items-center gap-1 sm:ml-auto">
                  {(['changes', 'all'] as const).map((v) => (
                    <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                      className={cn('rounded-full border px-2.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        view === v ? 'border-foreground/60 bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}>
                      {t(`teamLines.proposal.view.${v}`)}
                    </button>
                  ))}
                </div>
                <Button size="sm" className="h-8 w-full sm:w-auto" disabled={!sure.length || !!busy} onClick={() => setConfirmAll(true)}>
                  {busy === 'all' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="mr-1 h-3.5 w-3.5" aria-hidden />}
                  {t('teamLines.proposal.acceptAllSure', { n: sure.length })}
                </Button>
              </div>

              {rows.length === 0 ? (
                <p className="px-4 pb-5 text-sm text-muted-foreground">{t('teamLines.proposal.empty')}</p>
              ) : (
                <div className="px-2 pb-3 sm:px-4">
                  {/* the column heads — a grid row from xl; below xl every person is a card */}
                  <div className="hidden gap-3 border-b px-2 pb-1.5 text-[11px] font-medium text-muted-foreground xl:grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.7fr)_minmax(0,1.3fr)_7.5rem]">
                    <span>{t('teamLines.proposal.col.person')}</span>
                    <span>{t('teamLines.proposal.col.now')}</span>
                    <span>{t('teamLines.proposal.col.proposal')}</span>
                    <span>{t('teamLines.proposal.col.sales')}</span>
                    <span className="text-right">{t('teamLines.proposal.col.confidence')}</span>
                  </div>
                  <ul className="space-y-2 xl:space-y-0 xl:divide-y">
                    {rows.map((r) => {
                      const pick = picks[r.person_id] ?? { team: r.proposed.team_key, lane: r.proposed.lane };
                      const lanes = lanesFor(pick.team);
                      const row = applyRowFor(r, pick.team, pick.lane);
                      const changed = pick.team !== r.proposed.team_key || pick.lane !== r.proposed.lane;
                      const setTeam = (team: string) => setPicks((p) => ({ ...p, [r.person_id]: { team, lane: laneAfterTeamChange(team, pick.lane) } }));
                      const setLane = (lane: TeamLane) => setPicks((p) => ({ ...p, [r.person_id]: { team: pick.team, lane } }));
                      const depts = deptCounts(r.counts);
                      return (
                        <li key={r.person_id}
                          className="rounded-lg border p-3 xl:grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1.7fr)_minmax(0,1.3fr)_7.5rem] xl:items-center xl:gap-3 xl:rounded-none xl:border-0 xl:px-2 xl:py-2">
                          {/* person */}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium" title={r.display_name}>{r.display_name}</p>
                            <p className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                              {!r.is_active && <span>{t('teamLines.proposal.inactive')}</span>}
                              {r.is_manager && <span>{t('teamLines.proposal.manager')}</span>}
                              <span>{t(`teamLines.proposal.basis.${r.basis}`, { days: DAYS })}</span>
                            </p>
                          </div>
                          {/* now */}
                          <div className="mt-2 min-w-0 text-xs xl:mt-0">
                            <span className="text-muted-foreground xl:hidden">{t('teamLines.proposal.col.now')}: </span>
                            {/* a legacy key's own label already says "(стар тим)" */}
                            <span className={cn(r.current.legacy && 'text-muted-foreground')}>
                              {teamLaneLabel(t, r.current.team_key, r.current.lane, teamText(r.current.team_key))}
                            </span>
                          </div>
                          {/* proposal: team + lane, pickable */}
                          {/* the team names are short, the lane may be "Социјални мрежи": the lane gets the room */}
                          <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-1.5 xl:mt-0">
                            <Select value={pick.team ?? NONE} onValueChange={(v) => v !== NONE && setTeam(v)}>
                              <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={t('teamLines.proposal.teamFor', { name: r.display_name })}>
                                <SelectValue placeholder={t('teamLines.proposal.pickTeam')} />
                              </SelectTrigger>
                              <SelectContent>
                                {!pick.team && <SelectItem value={NONE} className="text-xs" disabled>{t('teamLines.proposal.pickTeam')}</SelectItem>}
                                {options.map((tm) => <SelectItem key={tm.key} value={tm.key} className="text-xs">{teamText(tm.key)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            {lanes.length > 0 ? (
                              <Select value={pick.lane ?? NONE} onValueChange={(v) => v !== NONE && setLane(v as TeamLane)}>
                                <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={t('teamLines.proposal.laneFor', { name: r.display_name })}>
                                  <SelectValue placeholder={t('teamLines.proposal.pickLane')} />
                                </SelectTrigger>
                                <SelectContent>
                                  {!pick.lane && <SelectItem value={NONE} className="text-xs" disabled>{t('teamLines.proposal.pickLane')}</SelectItem>}
                                  {lanes.map((l) => <SelectItem key={l} value={l} className="text-xs">{laneLabel(t, l)}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            ) : <span className="self-center text-[11px] text-muted-foreground">{t('teamLines.proposal.noLane')}</span>}
                          </div>
                          {/* the sales behind it */}
                          <div className="mt-2 min-w-0 text-[11px] text-muted-foreground xl:mt-0">
                            {depts.length ? (
                              <span className="flex flex-wrap gap-x-2">
                                {depts.map((d) => (
                                  <span key={d.dept} className="whitespace-nowrap tabular-nums">
                                    {t(`leaderboard2.deptShort.${d.dept === 'teleshop_other' ? 'teleshopOther' : d.dept}`)} {fmtNum(d.n, i18n.language)}
                                  </span>
                                ))}
                              </span>
                            ) : t('teamLines.proposal.noSales')}
                          </div>
                          {/* confidence + accept */}
                          <div className="mt-2 flex items-center justify-between gap-2 xl:mt-0 xl:flex-col xl:items-end xl:gap-1">
                            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', CONF_TONE[r.confidence])}
                              title={r.share != null ? t('teamLines.proposal.share', { pct: `${Math.round(r.share * 100)}%` }) : undefined}>
                              {t(`teamLines.proposal.confidence.${r.confidence}`)}
                              {r.share != null && <span className="ml-1 tabular-nums opacity-80">{Math.round(r.share * 100)}%</span>}
                            </span>
                            <Button size="sm" variant={changed ? 'default' : 'outline'} className="h-7 px-2.5 text-xs"
                              disabled={!row || !!busy || !isCompletePick(pick.team, pick.lane)}
                              onClick={() => row && void apply(r.person_id, [row])}>
                              {busy === r.person_id && <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />}
                              {t('teamLines.proposal.accept')}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('teamLines.proposal.acceptAllTitle', { n: sure.length })}</AlertDialogTitle>
            <AlertDialogDescription>{t('teamLines.proposal.acceptAllBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmAll(false); void apply('all', sure); }}>
              {t('teamLines.proposal.accept')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
