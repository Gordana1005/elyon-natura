import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Inbox, ListChecks, RotateCcw, Search, UserMinus, Users, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { friendlyRoleLabel } from '@/lib/roles';
import type { AppRole } from '@/contexts/AuthContext';
import type { AssignerBoardAgent } from '@/lib/assignerApi';
import {
  agentHolds, agentLoad, filterBoard, isManagementOnly, presenceOf, sortBoardAgents, type BoardRoleFilter,
} from '@/lib/assigner/board';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { teamLabel } from '@/components/tvboard/tvBoardHelpers';
import { Chip, LABEL, LiveCount, PresenceMark } from './parts';

/**
 * ALL profiles at once, online first — the owner's key request (29.09): a
 * compact grid (2 columns on a phone, 3 on a tablet, 4–5 on a desktop) of live
 * tiles. Clicking a tile toggles the agent as a distribution TARGET for the
 * active tab; "Одземи…" (or shift-click) opens the agent in the Unassign tab.
 */
export function AgentBoard({
  agents, loading, selected, onToggle, onSelectMany, onClear, onUnassign, f,
}: {
  agents: AssignerBoardAgent[] | undefined;
  loading: boolean;
  selected: string[];
  onToggle: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
  onClear: () => void;
  onUnassign: (agent: AssignerBoardAgent) => void;
  f: InsightsFormat;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [role, setRole] = useState<BoardRoleFilter>('all');

  const all = useMemo(() => sortBoardAgents(agents ?? []), [agents]);
  const shown = useMemo(() => filterBoard(all, { query, onlineOnly, role }), [all, query, onlineOnly, role]);
  const online = all.filter((a) => a.online || a.in_call).length;
  const onlineCallers = all.filter((a) => (a.online || a.in_call) && !isManagementOnly(a)).map((a) => a.user_id);

  return (
    <section aria-labelledby="assigner-board-title" className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card/80 px-3 py-2">
        <h2 id="assigner-board-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" aria-hidden />
          {t('assigner.board.title')}
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('assigner.agentPicker.onlineOf', { online: f.int(online), total: f.int(all.length) })}
        </span>
        <div className="relative min-w-[10rem] flex-1 sm:max-w-[16rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('assigner.agentPicker.search')}
            aria-label={t('assigner.agentPicker.search')}
            className="h-9 pl-8 text-sm sm:h-8"
          />
        </div>
        <Chip on={onlineOnly} onClick={() => setOnlineOnly((v) => !v)}>{t('assigner.board.onlineOnly')}</Chip>
        <div role="group" aria-label={t('assigner.board.role')} className="flex items-center gap-1">
          {(['all', 'agents', 'management'] as const).map((r) => (
            <Chip key={r} on={role === r} onClick={() => setRole(r)} className="px-2.5">
              {t(`assigner.board.roleFilter.${r}`)}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {selected.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
              {t('assigner.board.selectedN', { n: f.int(selected.length) })}
            </span>
          )}
          <Button type="button" size="sm" variant="outline" className="h-9 gap-1.5 text-xs sm:h-8"
            disabled={onlineCallers.length === 0}
            title={t('assigner.board.selectOnlineHint')}
            onClick={() => onSelectMany(onlineCallers)}>
            <Check className="h-3.5 w-3.5" aria-hidden />
            {t('assigner.board.selectOnline')}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-9 gap-1.5 text-xs sm:h-8" disabled={selected.length === 0} onClick={onClear}>
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('assigner.board.clearSelection')}
          </Button>
        </div>
      </div>

      <div className="p-2 sm:p-3">
        {loading && !agents ? (
          <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[1700px]:grid-cols-6" aria-busy>
            {Array.from({ length: 10 }, (_, i) => <li key={i}><Skeleton variant="card" className="h-[52px]" /></li>)}
          </ul>
        ) : shown.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} size="sm" className="border-0 bg-transparent"
            title={all.length ? t('assigner.agentPicker.noMatches') : t('assigner.noAgentsFound')} />
        ) : (
          <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[1700px]:grid-cols-6">
            {shown.map((a) => (
              <AgentTile key={a.user_id} agent={a} selected={selected.includes(a.user_id)}
                onToggle={() => onToggle(a.user_id)} onUnassign={() => onUnassign(a)} f={f} />
            ))}
          </ul>
        )}
        <p className={cn(LABEL, 'mt-2 normal-case tracking-normal')}>{t('assigner.board.hint')}</p>
      </div>
    </section>
  );
}

// the team + lane as the TV board names them (the owner's words, 30.09.2026: "Телешоп предикција",
// "Affiliate лидови", "Социјални мрежи", "Менаџмент" — display only); the DB team names are not
// translated; an agent with no team shows the role
function roleBadge(a: AssignerBoardAgent, t: InsightsFormat['t']): string {
  if (a.team_key) return teamLabel(t, a.team_key, a.team_name, a.team_lane);
  return friendlyRoleLabel(a.roles as AppRole[]);
}

export function AgentTile({
  agent: a, selected, onToggle, onUnassign, f,
}: {
  agent: AssignerBoardAgent;
  selected: boolean;
  onToggle: () => void;
  onUnassign: () => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const presence = presenceOf(a);
  const offline = presence === 'offline';
  const badge = roleBadge(a, t);
  const holds = agentHolds(a);
  const name = a.full_name || t('assigner.unknownAgent');
  const presenceWord = t(presence === 'in_call' ? 'assigner.statusInCall' : presence === 'online' ? 'assigner.statusAvailable' : 'assigner.statusOffline');

  // Compact (owner 30.09.2026: "see ALL agents at once"): two short lines — presence + name, then the live
  // counters, the team and the shift — and the unassign action as a slim side button, so ~50 profiles fit
  // on one screen at 1920 px.
  return (
    <li className={cn(
      'flex min-w-0 items-stretch rounded-lg border bg-card transition-colors',
      selected ? 'border-foreground/60 bg-muted ring-1 ring-foreground/40' : 'hover:bg-muted/50',
      offline && !selected && 'opacity-60',
    )}>
      <button
        type="button"
        aria-pressed={selected}
        data-agent-tile={a.user_id}
        onClick={(e) => (e.shiftKey && holds ? onUnassign() : onToggle())}
        title={`${name} · ${presenceWord}${badge ? ` · ${badge}` : ''}${a.shift ? ` · ${a.shift.start}–${a.shift.end}` : ''}`}
        className="flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-lg px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <PresenceMark presence={presence} t={t} />
          {/* a phone: the name may take two lines rather than be cut */}
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium leading-tight sm:line-clamp-1 sm:break-normal">{name}</span>
          {selected && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        </span>
        <span className="flex min-w-0 items-center gap-x-1 text-[11px] leading-none">
          <LiveCount icon={Inbox} value={a.pendings} text={f.int(a.pendings)}
            title={t('assigner.board.pendingsTip', { n: f.int(a.pendings), fresh: f.int(a.pendings_pending), taken: f.int(a.pendings_take), callAgains: f.int(a.call_agains_orders) })} />
          <LiveCount icon={RotateCcw} value={a.call_agains} text={f.int(a.call_agains)}
            title={t('assigner.board.callAgainsTip', { n: f.int(a.call_agains), leads: f.int(a.call_agains_orders), lists: f.int(a.call_agains_members) })} />
          <LiveCount icon={ListChecks} value={a.list_open} text={f.int(a.list_open)}
            title={t('assigner.board.listTip', { n: f.int(a.list_open), parked: f.int(a.list_parked), assigned: f.int(a.list_assigned), callAgains: f.int(a.call_agains_members) })} />
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            {badge && <span className="hidden min-w-0 truncate rounded bg-muted px-1 py-px sm:inline" title={badge}>{badge}</span>}
          </span>
          <span className="sr-only">{t('assigner.board.loadTip', { n: f.int(agentLoad(a)) })}</span>
        </span>
      </button>
      {holds && (
        <button
          type="button"
          onClick={onUnassign}
          title={t('assigner.board.unassignTip', { name })}
          aria-label={t('assigner.board.unassignTip', { name })}
          className="inline-flex w-9 shrink-0 items-center justify-center rounded-r-lg border-l text-muted-foreground hover:bg-rose-500/10 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:hover:text-rose-300 lg:w-8"
        >
          <UserMinus className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}
