import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { AgentChip } from './AgentPickerChips';
import { AgentSelectList } from './AgentSelectList';

interface Props {
  agents: AgentChip[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  className?: string;
  /** A fixed trigger text (e.g. "Додај агент") instead of the picked names. */
  triggerLabel?: string;
}

/**
 * Agent multi-select for the basket bar.
 *
 * The basket bar is `position: fixed; bottom: 4`, so anything rendered inline
 * inside it grows UPWARDS. With ~45 agents the wrapped chip list made the bar
 * taller than the screen, and its top — along with the first two dozen agents —
 * ended up above the viewport with no way to scroll to them.
 *
 * A popover fixes that structurally: it is height-capped, scrolls internally,
 * and `collisionPadding` keeps it inside the viewport whichever way it opens.
 */
export function AgentPickerPopover({ agents, selected, onChange, disabled, className, triggerLabel }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const onlineCount = agents.filter((a) => a.is_online).length;
  const selectedNames = agents.filter((a) => selected.includes(a.user_id)).map((a) => a.full_name);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn('min-w-[180px] justify-start gap-1.5', selected.length > 0 && 'border-primary text-primary', className)}
          // The full list of picked names, for when the button can only show a count.
          title={selectedNames.join(', ') || undefined}
        >
          <Users className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {triggerLabel ? triggerLabel : selected.length === 0
              ? t('assigner.basket.pickAgents')
              : selected.length === 1
                ? selectedNames[0]
                : t('assigner.agentPicker.selected', { count: selected.length })}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="center"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(720px,calc(100vw-2rem))] p-0"
      >
        <AgentSelectList
          agents={agents}
          selected={selected}
          onToggle={toggle}
          onClear={() => onChange([])}
          searchThreshold={0}
        />
        <div className="flex items-center justify-between border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>{t('assigner.agentPicker.onlineOf', { online: onlineCount, total: agents.length })}</span>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setOpen(false)}>
            {t('common.done')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
