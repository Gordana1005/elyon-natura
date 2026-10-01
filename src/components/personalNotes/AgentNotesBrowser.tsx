import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, NotebookPen, Search, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDistanceToNow } from '@/i18n/dates';
import { PN_KEYS, apiGetNotesAuthors, personalNotesErrorText } from '@/lib/personalNotesApi';
import { readNotesUrl, writeNotesUrl } from '@/lib/personalNotes/model';
import { NotesWorkspace } from './NotesWorkspace';

/**
 * "Дневници на оператори" (admins / managers): who keeps a Личен дневник — cards with a name
 * search and an inactive badge — and, once one is picked (`?owner=`), their notebooks READ ONLY.
 * The server decides who may be read (a manager never an admin) and audits every opening.
 */
export function AgentNotesBrowser() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { owner } = readNotesUrl(params);
  const [search, setSearch] = useState('');
  const authors = useQuery({ queryKey: PN_KEYS.authors, queryFn: apiGetNotesAuthors, staleTime: 60_000 });

  const list = authors.data?.authors ?? [];
  const shown = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    return q ? list.filter((a) => a.name.toLocaleLowerCase().includes(q)) : list;
  }, [list, search]);

  if (owner) {
    const who = list.find((a) => a.owner_id === owner);
    return (
      <div className="space-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            variant="outline" size="sm" className="h-8 shrink-0 gap-1.5"
            onClick={() => setParams((p) => writeNotesUrl(p, { owner: null }), { replace: true })}
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />{t('personalNotes.authors.all')}
          </Button>
          {who && (
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{who.name}</span>
              {!who.is_active && <InactiveBadge />}
            </span>
          )}
        </div>
        <NotesWorkspace key={owner} ownerId={owner} readOnly ownerName={who?.name ?? null} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* "Само читање. Секое отворање се евидентира" is the page's subtitle on this tab. */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('personalNotes.authors.search')}
          aria-label={t('personalNotes.authors.search')}
          className="h-9 pl-8 text-sm"
        />
      </div>
      {authors.isLoading ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : authors.isError ? (
        <LoadError text={personalNotesErrorText(authors.error)} onRetry={() => void authors.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState size="sm" icon={<NotebookPen className="h-5 w-5" />} title={t('personalNotes.authors.empty')} />
      ) : shown.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('personalNotes.authors.noMatch', { q: search.trim() })}</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((a) => (
            <li key={a.owner_id} className="min-w-0">
              <button
                type="button"
                onClick={() => setParams((p) => writeNotesUrl(p, { owner: a.owner_id }), { state: { pnDrill: true } })}
                className="block w-full min-w-0 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{a.name}</span>
                  {!a.is_active && <InactiveBadge />}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t('personalNotes.authors.notebooks', { count: a.notebook_count })} · {t('personalNotes.notebooks.notes', { count: a.note_count })}
                </span>
                {a.last_updated && (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {t('personalNotes.authors.lastUpdate', { when: formatDistanceToNow(new Date(a.last_updated), { addSuffix: true }) })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InactiveBadge() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t('personalNotes.authors.inactive')}
    </span>
  );
}
