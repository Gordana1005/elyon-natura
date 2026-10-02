import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { TvBoardFilters } from './TvBoardFilters';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('TV board — the filter bar (departments only since 02.10.2026)', () => {
  it('all + the seven departments, Менаџмент last; no team bar', () => {
    const onChange = vi.fn();
    render(<TvBoardFilters filter={{ department: null, team: null }} onChange={onChange} />);
    const bar = screen.getByRole('group', { name: i18n.t('leaderboard2.filterDepartments') });
    const labels = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.at(-1)).toBe(i18n.t('leaderboard2.deptShort.management'));
    expect(labels).toHaveLength(8);
    expect(screen.queryByRole('group', { name: i18n.t('leaderboard2.filterTeams') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('leaderboard2.deptShort.management') }));
    expect(onChange).toHaveBeenCalledWith({ department: 'management', team: null });
  });
  it('choosing a department clears an old link\'s team', () => {
    const onChange = vi.fn();
    render(<TvBoardFilters filter={{ department: null, team: 'altercpa_leads' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('leaderboard2.deptShort.teleshop_out') }));
    expect(onChange).toHaveBeenCalledWith({ department: 'teleshop_out', team: null });
  });
});
