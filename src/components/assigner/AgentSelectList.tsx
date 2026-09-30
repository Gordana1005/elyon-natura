import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AgentChip } from './AgentPickerChips';
import { matchesAgentSearch } from '@/lib/assigner/board';

export const agentLoad = (a: AgentChip) => a.members_open ?? a.active_leads ?? 0;

/** Online first, then lightest load — the obvious pick lands top-left. */
export const sortAgents = (agents: AgentChip[]) => [...agents].sort((a, b) => {
  if (!!a.is_online !== !!b.is_online) return a.is_online ? -1 : 1;
  return agentLoad(a) - agentLoad(b);
});

interface Props {
  agents: AgentChip[];
  selected: string[];
  onToggle: (id: string) => void;
  onClear?: () => void;
  /** Search box appears past this many agents; below it, it is just clutter. */
  searchThreshold?: number;
  /** Tailwind max-height for the scroll area. */
  maxHeightClass?: string;
  className?: string;
}

/**
 * The agent grid, shared by the inline distribute panel and the basket-bar
 * popover so both stay identical.
 *
 * A fixed grid rather than free-wrapping chips: with ~45 agents, equal-width
 * cells put every name on a predictable column line, which is the difference
 * between a scannable list and a paragraph of names. The scroll cap keeps any
 * container it sits in from growing past the screen.
 */
export function AgentSelectList({
  agents, selected, onToggle, onClear,
  searchThreshold = 12,
  maxHeightClass = 'max-h-[min(50vh,340px)]',
  className,
}: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const showSearch = agents.length > searchThreshold;

  const sorted = useMemo(() => sortAgents(agents), [agents]);
  const filtered = useMemo(() => {
    // Cyrillic ⇄ Latin: "Ivana" finds "Ивана" (normalizeForSearch + a digraph fold).
    if (!q.trim()) return sorted;
    return sorted.filter((a) => matchesAgentSearch(a.full_name || '', q));
  }, [sorted, q]);

  return (
    <div className={className}>
      {showSearch && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('assigner.agentPicker.search')}
            className="h-7 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
          />
          {selected.length > 0 && onClear && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" /> {t('common.clear')}
            </button>
          )}
        </div>
      )}

      <div className={cn('overflow-y-auto p-2', maxHeightClass)}>
        {filtered.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t('assigner.agentPicker.noMatches')}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {filtered.map((a) => {
              const on = selected.includes(a.user_id);
              return (
                <button
                  key={a.user_id}
                  type="button"
                  onClick={() => onToggle(a.user_id)}
                  title={t('assigner.openClientsTooltip')}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs font-medium transition-colors',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-transparent bg-muted/40 hover:bg-muted',
                  )}
                >
                  {on
                    ? <Check className="h-3 w-3 shrink-0" />
                    : <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', a.is_online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />}
                  <span className="truncate">{a.full_name}</span>
                  <span className={cn('ml-auto shrink-0 tabular-nums', on ? 'opacity-90' : 'text-muted-foreground')}>
                    {agentLoad(a)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
