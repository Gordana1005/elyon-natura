import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import type { LeaderboardResponse, LeaderboardRow } from '@/lib/api';

// Render smoke test for the TV board: the redesigned response (everyone on the
// team, presence, guests, AlterCPA-only rows) and the PRE-redesign response a
// TV may still receive while the api is being redeployed.
const channel = { on: () => channel, subscribe: () => channel };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { channel: () => channel, removeChannel: vi.fn() },
}));
const board = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetLeaderboard: (...a: unknown[]) => board(...a),
}));

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const { default: TvLeaderboardPage } = await import('./TvLeaderboardPage');

const base = (over: Partial<LeaderboardRow>): LeaderboardRow => ({
  user_id: 'u', full_name: 'X', is_super: false, rank: 1, confirmed_count: 0, packages: 0, avg_order_value: 0,
  revenue: 0, target_pct: 0, sold_rate: 0, calls: 0, bonus: 0, bonus_breakdown: {}, ...over,
});
const presence = (state: 'online' | 'idle' | 'break' | 'offline' | 'n/a', extra = {}) => ({
  state, online_min: 0, active_min: 0, idle_min: 0, break_min: 0, first_seen: null, last_seen: null,
  first_active: null, last_active: null, idle_alerts: 0, idle_streak_min: null, first_login: null, ...extra,
});
const now = new Date();

const redesigned: LeaderboardResponse = {
  generated_at: now.toISOString(), mode: 'pending', day: '2026-09-28', today: '2026-09-28', is_today: true,
  target: 0, team_revenue: 0, team_target_pct: 0, team_target_bonus: 0,
  summary: {
    people: 4, members: 3, guests: 1, extras: 0, managers: 1, online_now: 1, idle: 1, on_break: 0, offline: 1, no_login: 1,
    was_online: 2, zero_sale_people: 2, worked: 40, unmapped_decisions: 0, sales: 12, sold_value_eur: 480,
    unattributed_sales: 0, unattributed_value_eur: 0, live_credited_sales: 0, team_target_earners: 0,
  },
  agents: [
    base({ key: 'p1', person_id: 'p1', user_id: 'u1', full_name: 'Sanela Dzogovikj', rank: 1, confirmed_count: 10, revenue: 400,
      avg_order_value: 40, bonus: 30, sales: 10, worked: 30, sale_decisions: 10, conversion_pct: 33.3, is_member: true,
      presence: presence('online', { online_min: 312, active_min: 280, idle_min: 20, break_min: 12, idle_alerts: 1,
        first_active: '2026-09-28T06:58:00Z', last_active: now.toISOString() }) }),
    base({ key: 'p2', person_id: 'p2', user_id: 'u2', full_name: 'Nina', rank: 2, is_super: true, is_manager: true, is_guest: true,
      team_key: 'management', team_name: 'Management', confirmed_count: 2, revenue: 80, sales: 2, worked: 2,
      presence: presence('idle', { online_min: 60, idle_min: 40, idle_streak_min: 34 }) }),
    base({ key: 'p3', person_id: 'p3', user_id: null, full_name: 'AlterCPA #4531 (unnamed)', rank: 3, worked: 8, sales: 0,
      last_decision_at: new Date(now.getTime() - 12 * 60000).toISOString(), presence: presence('n/a') }),
    base({ key: 'p4', person_id: 'p4', user_id: 'u4', full_name: 'Iva', rank: 4, worked: 0, sales: 0, presence: presence('offline') }),
  ],
};

const legacy: LeaderboardResponse = {
  generated_at: now.toISOString(), mode: 'prediction', day: '2026-09-22', today: '2026-09-22', is_today: true,
  target: 4000, team_revenue: 1692.71, team_target_pct: 42.3, team_target_bonus: 10,
  agents: [base({ user_id: 'u9', full_name: 'Ruzhica Parizovska', confirmed_count: 5, revenue: 235.77, bonus: 34 })],
};

function renderAt(url: string) {
  return render(<MemoryRouter initialEntries={[url]}><TvLeaderboardPage /></MemoryRouter>);
}

describe('TV leaderboard', () => {
  it('shows every person with presence, guests, managers and the AlterCPA-only last decision', async () => {
    board.mockResolvedValue(redesigned);
    renderAt('/tv/leaderboard?key=k&mode=pending');
    expect(await screen.findByText('Sanela Dzogovikj')).toBeInTheDocument();
    for (const n of ['Nina', 'AlterCPA #4531 (unnamed)', 'Iva']) expect(screen.getByText(n)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.onlineNow'))).toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.lastDecisionAgo', { n: 12 }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.idleFor', { n: 34 }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.adminBadge'))).toBeInTheDocument();
    expect(screen.getByText(`${i18n.t('tvBoard.guestBadge')} · ${i18n.t('tvBoard.team.management')}`)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.durHM', { h: 5, m: '12' }))).toBeInTheDocument();
    expect(board).toHaveBeenCalledWith('k', undefined, 'pending');
  });

  it('still renders a pre-redesign response (no summary, no presence)', async () => {
    board.mockResolvedValue(legacy);
    renderAt('/tv/leaderboard?key=k');
    expect(await screen.findByText('Ruzhica Parizovska')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.agentsOnline'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.teamTarget'))).toBeInTheDocument();
  });
});
