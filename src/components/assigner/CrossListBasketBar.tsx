import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingBasket, UserPlus, UserX, X, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type AgentChip } from './AgentPickerChips';
import { AgentPickerPopover } from './AgentPickerPopover';
import { cn } from '@/lib/utils';
import { predictionListLabel } from '@/lib/predictionListLabel';

export interface BasketItem {
  key: string;        // `${listId}|${phone}`
  listId: string;
  listName: string;
  phone: string;
  name: string;
}

interface Props {
  items: BasketItem[];
  agents: AgentChip[];
  busy?: boolean;
  onAssign: (agentIds: string[]) => void;
  onUnassign: () => void;
  onClear: () => void;
  onRemove: (key: string) => void;
}

/**
 * Floating bar shown when the operator has hand-picked customers across one or
 * more lists. Lets them assign the whole basket to one or several agents
 * (round-robin split handled by the parent) or unassign them all.
 */
export function CrossListBasketBar({ items, agents, busy, onAssign, onUnassign, onClear, onRemove }: Props) {
  const { t } = useTranslation();
  const [pickedAgents, setPickedAgents] = useState<string[]>([]);
  if (items.length === 0) return null;

  const listCount = new Set(items.map(i => i.listId)).size;
  const splitNote = pickedAgents.length > 1
    ? t('assigner.basket.splitEach', { each: Math.ceil(items.length / pickedAgents.length), count: pickedAgents.length })
    : pickedAgents.length === 1
      ? t('assigner.basket.allToOne', { count: items.length })
      : t('assigner.basket.pickAgents');

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[min(960px,calc(100vw-2rem))]">
      <div className="rounded-2xl border-2 border-primary/30 bg-card shadow-2xl p-3 flex flex-wrap items-center gap-3">
        {/* Count + review popover */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm font-semibold hover:bg-primary/15">
              <ShoppingBasket className="h-4 w-4 text-primary" />
              {t('assigner.basket.customers', { count: items.length })}
              <span className="text-muted-foreground font-normal">{t('assigner.basket.fromLists', { count: listCount })}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[360px] p-0">
            <div className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('assigner.basket.title', { count: items.length })}
            </div>
            <div className="max-h-[300px] overflow-y-auto py-1">
              {items.map(it => (
                <div key={it.key} className="group flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-muted/50">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{it.name || it.phone}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{it.phone} · {predictionListLabel(it.listName)}</div>
                  </div>
                  <button onClick={() => onRemove(it.key)} className="p-1 rounded hover:bg-rose-100 text-rose-600 shrink-0" title={t('assigner.basket.remove')}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Agent multi-select. A popover, not an inline chip list: this bar is
            fixed to the bottom of the screen, so an inline list of ~45 agents
            grew it upwards until its top — and most of the agents — sat above
            the viewport, unreachable. */}
        <div className="flex-1 min-w-[200px]">
          <AgentPickerPopover agents={agents} selected={pickedAgents} onChange={setPickedAgents} disabled={busy} />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted-foreground hidden md:inline">{splitNote}</span>
          <Button
            size="sm"
            disabled={busy || pickedAgents.length === 0}
            onClick={() => onAssign(pickedAgents)}
            className="gap-1.5"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
            {t('assigner.basket.assign')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onUnassign} className="gap-1.5">
            <UserX className="h-3.5 w-3.5" /> {t('assigner.basket.unassign')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPickedAgents([]); onClear(); }} className={cn('gap-1.5 text-muted-foreground')}>
            <Trash2 className="h-3.5 w-3.5" /> {t('common.clear')}
          </Button>
        </div>
      </div>
    </div>
  );
}
