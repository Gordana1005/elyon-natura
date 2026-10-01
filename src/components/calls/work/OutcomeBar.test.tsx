import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/i18n';
import { OutcomeBar } from './OutcomeBar';
import { DialPanel } from './DialPanel';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const NOW = new Date('2026-10-01T08:00:00Z'); // 10:00 Skopje

function renderBar() {
  const h = {
    onNoAnswer: vi.fn(), onCallAgain: vi.fn(), onCancel: vi.fn(), onTrash: vi.fn(), onConfirm: vi.fn(),
  };
  render(<OutcomeBar {...h} now={() => NOW} />);
  const bar = screen.getByRole('toolbar');
  const btn = (name: string) => within(bar).getByRole('button', { name: new RegExp(name) });
  return { h, bar, btn };
}

describe('OutcomeBar — one tap per outcome', () => {
  it('shows the five outcomes in Macedonian', () => {
    const { bar } = renderBar();
    const labels = within(bar).getAllByRole('button').map((b) => b.textContent?.replace(/\d$/, '').trim());
    expect(labels).toEqual(['Не одговара', 'Повторно', 'Откажа', 'Корпа', 'Потврди']);
  });

  it('"Не одговара" is ONE tap', () => {
    const { h, btn } = renderBar();
    fireEvent.click(btn('Не одговара'));
    expect(h.onNoAnswer).toHaveBeenCalledTimes(1);
  });

  it('a cancel REQUIRES a reason: the first tap only opens the reason chips', () => {
    const { h, btn } = renderBar();
    fireEvent.click(btn('Откажа'));
    expect(h.onCancel).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Зошто откажа?' });
    // the top 4 reasons + "Друго…"
    const chips = within(group).getAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'Затвори');
    expect(chips.map((b) => b.textContent?.replace(/^\d/, ''))).toEqual([
      'Не е заинтересиран', 'Ќе ни се јави', 'Сè уште го користи производот', 'Нема пари', 'Друго…',
    ]);
    fireEvent.click(within(group).getByRole('button', { name: 'Нема пари' }));
    expect(h.onCancel).toHaveBeenCalledWith('no_money', '');
  });

  it('"Друго…" opens the full picker; save stays disabled until a reason (and, for "Друго", a note)', () => {
    const { h, btn } = renderBar();
    fireEvent.click(btn('Откажа'));
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Друго…' }));
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Зачувај откажување' });
    expect(save).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Друго' }));
    expect(save).toBeDisabled(); // 'other' needs the note
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'се сели во странство' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(h.onCancel).toHaveBeenCalledWith('other', 'се сели во странство');
  });

  it('a trash also needs its reason', () => {
    const { h, btn } = renderBar();
    fireEvent.click(btn('Корпа'));
    expect(h.onTrash).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Погрешен број' }));
    expect(h.onTrash).toHaveBeenCalledWith('wrong_number', '');
  });

  it('"Повторно" offers time chips on the Skopje clock', () => {
    const { h, btn } = renderBar();
    fireEvent.click(btn('Повторно'));
    const group = screen.getByRole('group', { name: 'Кога да се јавиме повторно?' });
    fireEvent.click(within(group).getByRole('button', { name: /Вечерва/ }));
    expect(h.onCallAgain).toHaveBeenCalledTimes(1);
    expect((h.onCallAgain.mock.calls[0][0] as Date).toISOString()).toBe('2026-10-01T16:00:00.000Z');
  });

  it('desktop shortcuts: 1 = no answer; 3 then 1 = cancel "not interested"; Esc closes', () => {
    const { h } = renderBar();
    fireEvent.keyDown(window, { key: '1' });
    expect(h.onNoAnswer).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: '3' });
    expect(screen.getByRole('group')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.keyDown(window, { key: '1' });
    expect(h.onCancel).toHaveBeenCalledWith('not_interested', '');
    fireEvent.keyDown(window, { key: '5' });
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a digit typed into a text field is never a shortcut', () => {
    const { h } = renderBar();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: '1' });
    expect(h.onNoAnswer).not.toHaveBeenCalled();
    input.remove();
  });

  it('busy: every outcome is locked while one is being saved', () => {
    render(<OutcomeBar busy="cancelled" onNoAnswer={vi.fn()} onCallAgain={vi.fn()} onCancel={vi.fn()} onTrash={vi.fn()} onConfirm={vi.fn()} />);
    for (const b of within(screen.getByRole('toolbar')).getAllByRole('button')) expect(b).toBeDisabled();
  });
});

describe('DialPanel — the Call button while VOIP is off', () => {
  it('on a phone it is a tel: link in the local form, and records the attempt', () => {
    const onAttempt = vi.fn(() => true);
    render(<DialPanel phone="+38970123456" isMobile voip={false} onAttempt={onAttempt} />);
    const link = screen.getByTestId('dial-tel');
    expect(link).toHaveAttribute('href', 'tel:070123456');
    expect(link).toHaveTextContent('070 123 456');
    link.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot open the phone app
    fireEvent.click(link);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('a refused attempt (an answer is owed elsewhere) does not dial', () => {
    render(<DialPanel phone="+38970123456" isMobile voip={false} onAttempt={() => false} />);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByTestId('dial-tel').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('on a computer: the big number + copy, no tel: link, no mock softphone', () => {
    render(<DialPanel phone="+38970123456" isMobile={false} voip={false} onAttempt={() => true} />);
    expect(screen.getByTestId('dial-desktop')).toHaveTextContent('070 123 456');
    expect(screen.getByRole('button', { name: /Копирај/ })).toBeInTheDocument();
    expect(screen.queryByTestId('dial-tel')).toBeNull();
  });

  it('with VOIP on it is the softphone button again', () => {
    const onVoipDial = vi.fn();
    render(<DialPanel phone="+38970123456" isMobile voip onVoipDial={onVoipDial} onAttempt={() => true} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onVoipDial).toHaveBeenCalled();
    expect(screen.queryByTestId('dial-tel')).toBeNull();
  });
});
