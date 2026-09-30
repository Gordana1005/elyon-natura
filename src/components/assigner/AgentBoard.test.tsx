import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/i18n';
import type { AssignerBoardAgent } from '@/lib/assignerApi';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { matchesAgentSearch, sortBoardAgents } from '@/lib/assigner/board';
import { AgentBoard } from './AgentBoard';

// The live agent board: ALL profiles at once, online first (in a call before
// free), then the lightest load (pendings + list clients — call-agains are
// already inside both), then the name; offline at the end. Search
// matches Cyrillic ⇄ Latin; a click chooses the agent as a distribution target.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const agent = (over: Partial<AssignerBoardAgent>): AssignerBoardAgent => ({
  user_id: 'u', full_name: 'X', roles: ['agent'], is_admin: false, is_manager: false, team_key: null, team_name: null,
  online: false, in_call: false, last_seen_at: null, shift: null,
  pendings: 0, pendings_pending: 0, pendings_take: 0, call_agains: 0, call_agains_orders: 0, call_agains_members: 0,
  list_open: 0, list_parked: 0, list_assigned: 0, worked_today: 0, ...over,
});

const BOARD_AGENTS: AssignerBoardAgent[] = [
  agent({ user_id: 'u-vesna', full_name: 'Весна Стојанова', online: true, pendings: 4, call_agains: 1, list_open: 5, list_assigned: 5 }),
  agent({ user_id: 'u-ana', full_name: 'Ана Петровска', online: true, in_call: true, pendings: 20, call_agains: 10, list_open: 20, list_assigned: 30, team_key: 'affiliate', team_name: 'Affiliate', team_lane: 'in', shift: { start: '08:00', end: '16:00' } }),
  agent({ user_id: 'u-beti', full_name: 'Бети Николова', online: true, list_open: 2, list_assigned: 2 }),
  agent({ user_id: 'u-ivana', full_name: 'Ivana Trajkovska', online: false }),
  agent({ user_id: 'u-zak', full_name: 'Жаклина Деник', online: true, pendings: 1, pendings_pending: 1, call_agains: 1, call_agains_orders: 1 }),
  agent({ user_id: 'u-boss', full_name: 'Mile Owner', roles: ['admin'], is_admin: true, online: true }),
];

function Harness(props: { agents: AssignerBoardAgent[]; selected?: string[]; onToggle?: (id: string) => void; onSelectMany?: (ids: string[]) => void }) {
  const f = useInsightsFormat();
  return (
    <AgentBoard agents={props.agents} loading={false} selected={props.selected ?? []}
      onToggle={props.onToggle ?? (() => {})} onSelectMany={props.onSelectMany ?? (() => {})}
      onClear={() => {}} onUnassign={() => {}} f={f} />
  );
}

const tileNames = () =>
  screen.getAllByRole('button', { pressed: false }).concat(screen.queryAllByRole('button', { pressed: true }))
    .filter((b) => b.closest('li'))
    .map((b) => b.getAttribute('title')?.split(' · ')[0]);

describe('AgentBoard', () => {
  it('orders online first (in a call before free), then load, then name; offline last', () => {
    expect(sortBoardAgents(BOARD_AGENTS).map((a) => a.full_name)).toEqual([
      'Ана Петровска',      // in a call
      'Mile Owner',          // online, load 0
      'Жаклина Деник',       // online, load 1 (its call-again lead is inside the pending)
      'Бети Николова',       // online, load 2
      'Весна Стојанова',     // online, load 4 + 5 = 9 (the call-again is NOT added again)
      'Ivana Trajkovska',    // offline
    ]);
    // A tie on load is decided by the name (Б before Ж).
    expect(sortBoardAgents([
      agent({ user_id: 'z', full_name: 'Жана', online: true, list_open: 3 }),
      agent({ user_id: 'b', full_name: 'Бојана', online: true, pendings: 3 }),
    ]).map((a) => a.full_name)).toEqual(['Бојана', 'Жана']);
    render(<Harness agents={BOARD_AGENTS} />);
    const list = screen.getByRole('list');
    const names = within(list).getAllByRole('listitem').map((li) => within(li).getAllByRole('button')[0].getAttribute('title')?.split(' · ')[0]);
    expect(names).toEqual(sortBoardAgents(BOARD_AGENTS).map((a) => a.full_name));
    expect(screen.getByText('5 од 6 онлајн')).toBeInTheDocument();
  });

  it('shows the live counters, the translated team badge and the shift in the title', () => {
    render(<Harness agents={BOARD_AGENTS} />);
    const ana = screen.getByTitle(/^Ана Петровска · /);
    // the team + lane as the owner names them (business lines, 30.09): "Affiliate лидови"
    expect(ana).toHaveTextContent('Affiliate лидови');
    expect(ana).not.toHaveTextContent('Pending');
    expect(ana).not.toHaveTextContent('На чекање');
    // the shift rides in the tile's title (the compact tile has no room for it)
    expect(ana.getAttribute('title')).toContain('08:00–16:00');
    expect(within(ana).getByTitle('Пендинзи: 20 (0 недопрени · 0 во работа) — од нив 0 повторни повици')).toHaveTextContent('20');
    expect(within(ana).getByTitle(/^Повторни повици: 10/)).toBeInTheDocument();
    expect(within(ana).getByTitle(/^Клиенти од списоци за јавување: 20/)).toBeInTheDocument();
    expect(ana.getAttribute('title')).toContain('Во разговор');
  });

  it('search matches Cyrillic ⇄ Latin', () => {
    expect(matchesAgentSearch('Ивана Трајковска', 'Ivana')).toBe(true);
    expect(matchesAgentSearch('Ivana Trajkovska', 'Ивана')).toBe(true);
    expect(matchesAgentSearch('Жаклина Деник', 'Zaklina')).toBe(true);
    expect(matchesAgentSearch('Жаклина Деник', 'zhaklina')).toBe(true);
    expect(matchesAgentSearch('Бети Николова', 'Ivana')).toBe(false);

    render(<Harness agents={BOARD_AGENTS} />);
    const search = screen.getByRole('textbox', { name: 'Пребарај агент…' });
    fireEvent.change(search, { target: { value: 'Ивана' } });
    expect(tileNames()).toEqual(['Ivana Trajkovska']);
    fireEvent.change(search, { target: { value: 'zaklina' } });
    expect(tileNames()).toEqual(['Жаклина Деник']);
  });

  it('a click chooses the agent; "choose all online" leaves out the admin', () => {
    const onToggle = vi.fn();
    const onSelectMany = vi.fn();
    const { rerender } = render(<Harness agents={BOARD_AGENTS} onToggle={onToggle} onSelectMany={onSelectMany} />);
    fireEvent.click(screen.getByTitle(/^Бети Николова · /));
    expect(onToggle).toHaveBeenCalledWith('u-beti');

    rerender(<Harness agents={BOARD_AGENTS} selected={['u-beti']} onToggle={onToggle} onSelectMany={onSelectMany} />);
    expect(screen.getByTitle(/^Бети Николова · /)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('1 избрани')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Избери ги сите онлајн/ }));
    expect(onSelectMany).toHaveBeenCalledWith(['u-ana', 'u-zak', 'u-beti', 'u-vesna']);
  });

  it('"само онлајн" hides the offline agents', () => {
    render(<Harness agents={BOARD_AGENTS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Само онлајн' }));
    expect(tileNames()).not.toContain('Ivana Trajkovska');
    expect(tileNames()).toHaveLength(5);
  });
});
