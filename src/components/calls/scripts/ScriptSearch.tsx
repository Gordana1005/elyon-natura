import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { apiGetPublishedScriptsIndex, CALL_SCRIPTS_QUERY_KEYS } from '@/lib/callScriptsApi';
import { normalizeForSearch } from '@/lib/transliterate';
import { cn } from '@/lib/utils';
import { SCRIPTS_STALE_MS } from './useCallScripts';

/** Latin or Cyrillic, either way ("prostatol" finds "Простатол"). */
const filterScripts = (value: string, search: string) => {
  const q = normalizeForSearch(search);
  return !q || normalizeForSearch(value).includes(q) ? 1 : 0;
};

/**
 * Any published script, by title — for a call the matcher did not foresee. Loads the index
 * (GET /call-scripts/published-index) only when opened; the dock fetches the picked script by id.
 */
export function ScriptSearch({ onPick, className }: { onPick: (id: string) => void; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const index = useQuery({
    queryKey: CALL_SCRIPTS_QUERY_KEYS.publishedIndex(),
    queryFn: apiGetPublishedScriptsIndex,
    enabled: open,
    staleTime: SCRIPTS_STALE_MS,
  });
  const rows = index.data?.scripts ?? [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('scriptDock.search.button')}
          title={t('scriptDock.search.button')}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          data-testid="script-search-trigger"
        >
          <Search className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0" data-testid="script-search">
        <Command filter={filterScripts}>
          {/* text-base below md: iOS zooms into a field under 16 px. */}
          <CommandInput placeholder={t('scriptDock.search.placeholder')} className="text-base md:text-sm" />
          <CommandList>
            {index.isLoading ? (
              <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : (
              <>
                <CommandEmpty>{t('scriptDock.search.empty')}</CommandEmpty>
                <CommandGroup heading={t('scriptDock.search.heading')}>
                  {rows.map((r) => (
                    <CommandItem
                      key={r.id}
                      value={`${r.title} ${r.id}`}
                      onSelect={() => { setOpen(false); onPick(r.id); }}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="w-full break-words text-sm">{r.title}</span>
                      <span className="w-full truncate text-[11px] text-muted-foreground">
                        {r.groups.length === 0
                          ? t('scriptDock.why.allGroups')
                          : r.groups.map((g) => t(`callScripts.groups.${g}`, { defaultValue: g })).join(' · ')}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
