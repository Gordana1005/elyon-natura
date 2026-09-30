import { useMemo } from 'react';
import { Award } from 'lucide-react';
import type { PeoplePerson } from '@/lib/insightsApi/agents';
import { cn } from '@/lib/utils';
import { fmtNum } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { BOARD_MIN_CLOSED, BOARD_MIN_WORKED, RATE_MIN_ACTIVE_MIN, leaderboards, type BoardKey, type BoardEntry } from './model';
import { teamLaneName } from './parts';

const BOARDS: BoardKey[] = ['sales', 'conversion', 'paid', 'return_rate', 'per_hour', 'value'];

/**
 * Who leads — the top five per measure. A rate is ranked only above its floor
 * (a conversion over 3 calls is luck); the value board is owners only. The bar
 * is the value's length against the leader (one hue; the number is the value).
 */
export function Leaderboards({ people, money, teamNames, onPerson, f }: {
  people: PeoplePerson[];
  money: boolean;
  teamNames: Map<string, string | null>;
  onPerson: (id: string) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const boards = useMemo(() => leaderboards(people, money), [people, money]);
  const fmt = (k: BoardKey, v: number) =>
    k === 'conversion' || k === 'return_rate' ? f.pct(v)
      : k === 'per_hour' ? f.t('insights.agents.boards.perHourValue', { n: fmtNum(v, f.lang, 1) })
        : k === 'value' ? f.den(v) : f.int(v);
  const hint = (k: BoardKey) =>
    k === 'conversion' ? t('insights.agents.boards.hint.conversion', { n: BOARD_MIN_WORKED })
      : k === 'return_rate' ? t('insights.agents.boards.hint.return_rate', { n: BOARD_MIN_CLOSED })
        : k === 'per_hour' ? t('insights.agents.boards.hint.per_hour', { n: RATE_MIN_ACTIVE_MIN })
          : t(`insights.agents.boards.hint.${k}`);
  const shown = BOARDS.filter((k) => boards[k] !== null);
  return (
    <section aria-labelledby="ag-boards-title" className="space-y-3">
      <div>
        <h2 id="ag-boards-title" className="text-base font-semibold">{t('insights.agents.boards.title')}</h2>
        <ClockCaption clock={['sale', 'decided']} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((k) => (
          <Board key={k} title={t(`insights.agents.boards.${k}`)} hint={hint(k)} entries={boards[k]!}
            fmt={(v) => fmt(k, v)} teamNames={teamNames} onPerson={onPerson} ascending={k === 'return_rate'} f={f} />
        ))}
      </div>
    </section>
  );
}

function Board({ title, hint, entries, fmt, teamNames, onPerson, ascending, f }: {
  title: string; hint: string; entries: BoardEntry[]; fmt: (v: number) => string;
  teamNames: Map<string, string | null>; onPerson: (id: string) => void; ascending: boolean; f: InsightsFormat;
}) {
  const max = Math.max(...entries.map((e) => e.value), 0);
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
      <header>
        <h3 className="flex items-center gap-1.5 text-sm font-medium"><Award className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{title}</h3>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </header>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{f.t('insights.agents.boards.empty')}</p>
      ) : (
        <ol className="space-y-1.5">
          {entries.map((e, i) => (
            <li key={e.person.person_id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 text-[13px]">
              <span className={cn('text-right text-xs font-semibold tabular-nums', i === 0 ? 'text-foreground' : 'text-muted-foreground')}>{i + 1}</span>
              <span className="min-w-0">
                <button type="button" onClick={() => onPerson(e.person.person_id)}
                  className="block max-w-full truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {e.person.name}
                </button>
                <span className="block truncate text-[10px] text-muted-foreground">{teamLaneName(e.person.team_key, e.person.team_lane, teamNames.get(e.person.team_key) ?? null, f)}</span>
                {/* length against the leader (ascending boards: the lowest leads) */}
                <span className="mt-0.5 block h-1 rounded-full bg-muted" aria-hidden>
                  <span className="block h-full rounded-full bg-foreground/40"
                    style={{ width: `${max > 0 ? (ascending ? (entries[0].value > 0 ? Math.min(1, entries[0].value / Math.max(e.value, 1e-9)) : 1) : e.value / max) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="text-right font-semibold tabular-nums">{fmt(e.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
