import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';

// The Natura Therapy HUB login (owner, 02.10.2026): the brand, the username → login-email
// rule, the shift gate, and Supabase's English errors shown in the reader's language.
const signIn = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ signIn }) }));
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: i18n.language, setLanguage: (l: string) => i18n.changeLanguage(l) }),
}));
const signOut = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signOut: () => signOut() } } }));
const checkShift = vi.fn();
const logShift = vi.fn();
vi.mock('@/lib/api', () => ({
  apiCheckShiftLogin: () => checkShift(),
  apiLogShiftLogin: (b: unknown) => logShift(b),
}));

const { default: LoginPage } = await import('./LoginPage');

beforeAll(async () => {
  await i18n.changeLanguage('mk');
});
afterEach(() => {
  vi.clearAllMocks();
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/start" element={<p>START</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillAndSubmit(user: string, pass: string) {
  fireEvent.change(screen.getByLabelText('Корисничко име'), { target: { value: user } });
  fireEvent.change(screen.getByLabelText('Лозинка'), { target: { value: pass } });
  fireEvent.click(screen.getByRole('button', { name: /Најави се/ }));
}

describe('LoginPage — Natura Therapy HUB', () => {
  it('shows the product name, the logo and "Powered by elyonpremium"', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Natura Therapy HUB');
    expect(screen.getAllByAltText('Natura Therapy').length).toBeGreaterThan(0);
    expect(screen.getByText(/Powered by/)).toHaveTextContent('Powered by elyonpremium');
    expect(document.title).toBe('Најави се · Natura Therapy HUB');
  });

  it('a bare username logs in on the CRM domain and lands on /start', async () => {
    signIn.mockResolvedValue(undefined);
    checkShift.mockResolvedValue({ allowed: true, bypass: true });
    renderLogin();
    fillAndSubmit('marija.m', 'secret');
    expect(await screen.findByText('START')).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledWith('marija.m@elyon-mk.local', 'secret');
    expect(logShift).not.toHaveBeenCalled();
  });

  it('a full email is used as typed', async () => {
    signIn.mockResolvedValue(undefined);
    checkShift.mockResolvedValue({ allowed: true, bypass: true });
    renderLogin();
    fillAndSubmit('mile@elyon.com', 'secret');
    await screen.findByText('START');
    expect(signIn).toHaveBeenCalledWith('mile@elyon.com', 'secret');
  });

  it("Supabase's English 'Invalid login credentials' reads in Macedonian", async () => {
    signIn.mockRejectedValue(Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }));
    renderLogin();
    fillAndSubmit('x', 'y');
    expect(await screen.findByRole('alert')).toHaveTextContent('Невалидни податоци за најава');
    expect(checkShift).not.toHaveBeenCalled();
  });

  it('a banned account and a dead network get their own message', async () => {
    signIn.mockRejectedValueOnce(new Error('User is banned'));
    renderLogin();
    fillAndSubmit('x', 'y');
    expect(await screen.findByRole('alert')).toHaveTextContent('Профилот е блокиран');

    signIn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: /Најави се/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Нема врска со серверот'));
  });

  it('an outage never reads "{}", a rate limit and a bad username read in Macedonian', async () => {
    // auth-js's AuthRetryableFetchError on a 503 carries JSON.stringify(Response) = "{}" as its message.
    signIn.mockRejectedValueOnce(Object.assign(new Error('{}'), { name: 'AuthRetryableFetchError', status: 503 }));
    renderLogin();
    fillAndSubmit('x', 'y');
    expect(await screen.findByRole('alert')).toHaveTextContent('Серверот моментално не одговара');
    expect(screen.getByRole('alert')).not.toHaveTextContent('{}');

    signIn.mockRejectedValueOnce(Object.assign(new Error('Request rate limit reached'), { code: 'over_request_rate_limit', status: 429 }));
    fireEvent.click(screen.getByRole('button', { name: /Најави се/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Премногу барања'));

    signIn.mockRejectedValueOnce(
      Object.assign(new Error('Unable to validate email address: invalid format'), { code: 'validation_failed', status: 400 }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Најави се/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Невалидни податоци за најава'));
  });

  it('after a failed login the cursor is back in the password, ready to retype', async () => {
    signIn.mockRejectedValue(Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }));
    renderLogin();
    fillAndSubmit('x', 'wrong');
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByLabelText('Лозинка')).toHaveFocus());
  });

  it('the shift gate signs the person out and says why', async () => {
    signIn.mockResolvedValue(undefined);
    checkShift.mockResolvedValue({ allowed: false, code: 'no_shift_today' });
    renderLogin();
    fillAndSubmit('agent', 'pw');
    expect(await screen.findByRole('alert')).toHaveTextContent('Денес немате смена.');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('START')).not.toBeInTheDocument();
  });

  it('the eye button shows and hides the password (one name, a pressed state)', () => {
    renderLogin();
    const pass = screen.getByLabelText('Лозинка');
    const eye = screen.getByRole('button', { name: 'Прикажи ја лозинката' });
    expect(pass).toHaveAttribute('type', 'password');
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(eye);
    expect(pass).toHaveAttribute('type', 'text');
    expect(eye).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(eye);
    expect(pass).toHaveAttribute('type', 'password');
    expect(eye).toHaveAttribute('aria-pressed', 'false');
  });

  it('a second press while signing in sends nothing more', async () => {
    let finish: () => void = () => {};
    signIn.mockImplementation(() => new Promise<void>((r) => { finish = r; }));
    checkShift.mockResolvedValue({ allowed: true, bypass: true });
    renderLogin();
    fillAndSubmit('agent', 'pw');
    const busy = await screen.findByRole('button', { name: /Се најавува/ });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(signIn).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(await screen.findByText('START')).toBeInTheDocument();
  });

  it("the browser's 'fill out this field' speaks Macedonian", () => {
    renderLogin();
    const user = screen.getByLabelText('Корисничко име') as HTMLInputElement;
    fireEvent.invalid(user);
    expect(user.validationMessage).toBe('Пополни го ова поле.');
    fireEvent.input(user, { target: { value: 'm' } });
    expect(user.validationMessage).not.toBe('Пополни го ова поле.');
  });

  it('a wrong password marks both fields invalid; a language switch re-translates the error', async () => {
    signIn.mockRejectedValue(Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }));
    renderLogin();
    fillAndSubmit('x', 'y');
    expect(await screen.findByRole('alert')).toHaveTextContent('Невалидни податоци за најава');
    expect(screen.getByLabelText('Корисничко име')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Лозинка')).toHaveAttribute('aria-invalid', 'true');
    await act(async () => {
      await i18n.changeLanguage('sq');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Kredenciale të pavlefshme');
    await act(async () => {
      await i18n.changeLanguage('mk');
    });
  });

  it('warns while Caps Lock is on', () => {
    renderLogin();
    const pass = screen.getByLabelText('Лозинка');
    fireEvent.keyDown(pass, { key: 'A', modifierCapsLock: true });
    expect(screen.getByText('Caps Lock е вклучен')).toBeInTheDocument();
    expect(pass).toHaveAttribute('aria-describedby', 'caps-lock-hint');
    fireEvent.keyUp(pass, { key: 'a', modifierCapsLock: false });
    expect(screen.queryByText('Caps Lock е вклучен')).not.toBeInTheDocument();
  });

  it('the username field never auto-capitalises (a phone would break the login)', () => {
    renderLogin();
    const user = screen.getByLabelText('Корисничко име');
    expect(user).toHaveAttribute('autocapitalize', 'none');
    expect(user).toHaveAttribute('autocomplete', 'username');
  });

  it('reads in Albanian once the language is switched', async () => {
    renderLogin();
    await act(async () => {
      await i18n.changeLanguage('sq');
    });
    // The brand line is the same in every language.
    expect(screen.getByText(/Powered by/)).toHaveTextContent('Powered by elyonpremium');
    expect(screen.getByRole('button', { name: /^Hyr$/ })).toBeInTheDocument();
    // <html lang> follows the UI language (WCAG 3.1.1).
    expect(document.documentElement.lang).toBe('sq');
    await act(async () => {
      await i18n.changeLanguage('mk');
    });
  });
});
