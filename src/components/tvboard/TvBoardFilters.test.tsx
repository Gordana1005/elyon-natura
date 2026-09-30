import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/i18n';
import type { BoardTeam } from '@/lib/leaderboardV2';
import { TvBoardFilters } from './TvBoardFilters';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const TEAMS: BoardTeam[] = [
  { key: 'teleshop', name: 'Телешоп', people: 24, kind: 'line', sort_order: 10,
    lanes: [{ lane: 'in', key: 'teleshop:in', people: 5 }, { lane: 'out', key: 'teleshop:out', people: 17 }, { lane: 'social', key: 'teleshop:social', people: 2 }] },
  { key: 'affiliate', name: 'Affiliate', people: 21, kind: 'line', sort_order: 20, lanes: [{ lane: 'in', key: 'affiliate:in', people: 21 }] },
  { key: 'management', name: 'Management', people: 11, kind: 'management', sort_order: 90, lanes: [] },
];

describe('TV board — the team filter (teams = business lines)', () => {
  it('a line opens its lanes in the owner\'s words; a lane is team:lane', () => {
    const onChange = vi.fn();
    render(<TvBoardFilters filter={{ department: null, team: 'teleshop' }} teams={TEAMS} onChange={onChange} />);
    const lanes = screen.getByRole('group', { name: i18n.t('teamLines.filterLanes', { team: 'Телешоп' }) });
    expect(within(lanes).getByRole('button', { name: /предикција/ })).toBeInTheDocument();
    expect(within(lanes).getByRole('button', { name: /Социјални мрежи/ })).toBeInTheDocument();
    fireEvent.click(within(lanes).getByRole('button', { name: /лидови/ }));
    expect(onChange).toHaveBeenCalledWith({ department: null, team: 'teleshop:in' });
    // the team row names teams, never a board mode
    const teams = screen.getByRole('group', { name: i18n.t('leaderboard2.filterTeams') });
    expect(teams.textContent).not.toMatch(/На чекање|Прогноз/);
    expect(within(teams).getByRole('button', { name: /Менаџмент/ })).toBeInTheDocument();
  });
  it('no lane row without a line chosen; an old link\'s alias stays selectable under its alias name', () => {
    render(<TvBoardFilters filter={{ department: null, team: 'altercpa_leads' }} teams={TEAMS} onChange={() => {}} />);
    expect(screen.queryByRole('group', { name: /Ознаки во/ })).toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('tvBoard.alias.altercpa_leads') })).toHaveAttribute('aria-pressed', 'true');
  });
});
