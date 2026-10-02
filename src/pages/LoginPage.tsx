import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowBigUp, ArrowRight, Check, ChevronDown, Eye, EyeOff, Loader2, Lock, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { apiCheckShiftLogin, apiLogShiftLogin } from '@/lib/api';
import type { ShiftLoginCheck } from '@/lib/shiftsApi';
import { shiftRefusalText } from '@/components/shifts/loginRefusal';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { SUPPORTED_LANGUAGES, type AppLanguage } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { BRAND, BRAND_LOGO } from '@/lib/brand';

// TODO(macedonia): final login domain — must match the admin emails seeded in
// scripts/create-admin-users.mjs (Phase 3). Placeholder for now.
const EMAIL_DOMAIN = 'elyon-mk.local';

// The brand lines and logos live in src/lib/brand.ts (shared with the sidebar).
const PRODUCT = BRAND.product;
const naturaLogoWhite = BRAND_LOGO.white;
const naturaMark = BRAND_LOGO.mark;
const naturaMarkWhite = BRAND_LOGO.markWhite;

// mk / sq / en — Bulgarian is switched off app-wide (owner, 02.10.2026) — the floor's first.
const FLOOR_FIRST: AppLanguage[] = ['mk', 'sq'];
const floorRank = (l: AppLanguage) => (FLOOR_FIRST.indexOf(l) + 1) || FLOOR_FIRST.length + 1;
const LOGIN_LANGUAGES = [...SUPPORTED_LANGUAGES].sort((a, b) => floorRank(a) - floorRank(b));

// Deep forest green lit by the logo's own #6aa291 — the brand half on a desktop, the band on a phone.
const BRAND_PANEL: CSSProperties = {
  backgroundImage: [
    'radial-gradient(900px 520px at 0% 0%, rgba(106, 162, 145, 0.38), transparent 60%)',
    'radial-gradient(760px 480px at 100% 100%, rgba(106, 162, 145, 0.22), transparent 62%)',
    'linear-gradient(155deg, #1d3d35 0%, #14302a 55%, #0d221e 100%)',
  ].join(', '),
};

// 16 px at every width (iOS zooms into a smaller field). The border carries the 3:1 boundary
// (WCAG 1.4.11); the focus border is the 3:1 cue and the soft halo only decorates it.
const FIELD =
  'h-12 rounded-xl border-nt-field-border bg-nt-field pl-11 text-base text-nt-text shadow-[0_1px_2px_rgba(20,36,32,0.04)] transition-[border-color,box-shadow] placeholder:text-nt-subtle hover:border-nt-muted focus-visible:border-nt-focus focus-visible:ring-4 focus-visible:ring-nt-ring focus-visible:ring-offset-0 aria-[invalid=true]:border-nt-danger-text aria-[invalid=true]:focus-visible:ring-nt-danger-ring md:text-base';

type AuthErrorKind = 'credentials' | 'blocked' | 'rateLimited' | 'network' | 'server' | 'other';

/**
 * What went wrong, from auth-js's `code` / `status` / `name`. An AuthRetryableFetchError (network
 * down, or a 502/503/504) carries `JSON.stringify(Response)` as its message — "{}" — so the
 * message is never trusted for those.
 */
function authErrorKind(err: unknown): AuthErrorKind {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; status?: unknown; name?: unknown };
  const message = typeof e.message === 'string' ? e.message : '';
  const status = typeof e.status === 'number' ? e.status : undefined;
  // A username that is not a valid email ("Marija M") is a wrong username to the person typing it.
  if (e.code === 'invalid_credentials' || e.code === 'validation_failed' || /invalid login credentials/i.test(message)) {
    return 'credentials';
  }
  if (e.code === 'user_banned' || /user is banned/i.test(message)) return 'blocked';
  if (e.code === 'over_request_rate_limit' || status === 429) return 'rateLimited';
  if (status === 0 || /failed to fetch|networkerror|load failed|network request failed/i.test(message)) return 'network';
  if (e.name === 'AuthRetryableFetchError' || (status !== undefined && status >= 500)) return 'server';
  return 'other';
}

/** Supabase answers in English; the floor reads Macedonian and Albanian. */
function loginErrorText(t: TFunction, err: unknown): string {
  switch (authErrorKind(err)) {
    case 'credentials':
      return t('login.invalidCredentials');
    case 'blocked':
      return t('login.accountBlocked');
    case 'rateLimited':
      return t('apiErrors.rateLimited');
    case 'network':
      return t('login.networkError');
    case 'server':
      return t('login.serverUnavailable');
    default: {
      const message = (err as { message?: unknown } | null)?.message;
      return typeof message === 'string' && message && message !== '{}' ? message : t('login.invalidCredentials');
    }
  }
}

/** Kept as WHAT failed, not as text — a language switch re-translates the message on screen. */
type LoginFailure = { kind: 'auth'; err: unknown } | { kind: 'shift'; check: ShiftLoginCheck };

/** The language picker: flag + native name, on the brand band (phone) or on the page (desktop). */
function LoginLanguagePicker({ tone }: { tone: 'onBrand' | 'onPage' }) {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${t('common.language')}: ${t(`languages.${language}`)}`}
        className={cn(
          'inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          tone === 'onBrand'
            ? 'border-white/25 bg-white/10 text-white backdrop-blur-md hover:bg-white/15 focus-visible:ring-white focus-visible:ring-offset-transparent data-[state=open]:bg-white/15'
            : 'border-nt-border bg-nt-surface text-nt-text shadow-sm hover:border-nt-border-strong focus-visible:ring-nt-focus focus-visible:ring-offset-nt-bg data-[state=open]:border-nt-border-strong',
        )}
      >
        <FlagIcon lang={language} className="h-3 w-6" />
        {/* Below 360 px the flag alone; the name stays in the button's accessible name. */}
        <span className="max-[359px]:sr-only">{t(`languages.${language}`)}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* The menu renders in a portal, outside the page — it carries the brand palette itself. */}
      <DropdownMenuContent
        align="end"
        className="nt-login min-w-[11rem] rounded-xl border-nt-border bg-nt-surface p-1.5 text-nt-text motion-reduce:animate-none"
      >
        {LOGIN_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang}
            lang={lang}
            role="menuitemradio"
            aria-checked={lang === language}
            onSelect={() => setLanguage(lang)}
            className="gap-2.5 rounded-lg px-2.5 py-2 outline-0 focus:bg-nt-bg focus:text-nt-text focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-nt-focus"
          >
            <FlagIcon lang={lang} className="h-3 w-6" />
            <span className={cn('flex-1', lang === language && 'font-semibold')}>{t(`languages.${lang}`)}</span>
            {lang === language && <Check className="h-4 w-4 text-nt-brand-ink" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function LoginPage() {
  const { t, i18n } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [failure, setFailure] = useState<LoginFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const errorText = !failure
    ? ''
    : failure.kind === 'shift'
      ? shiftRefusalText(t, failure.check)
      : loginErrorText(t, failure.err);
  const credentialsWrong = failure?.kind === 'auth' && authErrorKind(failure.err) === 'credentials';

  // The tagline as two lines split at its dash — the lead, then the rest muted. Screen readers
  // still hear the dash.
  const [taglineLead, taglineTail] = t('login.tagline').split(/\s—\s/);
  const tagline = (
    <>
      <span className="block text-balance">{taglineLead}</span>
      {taglineTail && (
        <>
          <span className="sr-only"> — </span>
          <span className="block text-balance text-white/65">{taglineTail}</span>
        </>
      )}
    </>
  );

  // The tab says what the page is (WCAG 2.4.2) and names the product.
  useEffect(() => {
    const previous = document.title;
    document.title = `${t('login.signIn')} · ${PRODUCT} HUB`;
    return () => {
      document.title = previous;
    };
  }, [t, i18n.language]);

  // With a mouse the cursor waits in the username. A phone or tablet keeps its keyboard down
  // until the field is tapped, so the logo and the whole form stay in view.
  useEffect(() => {
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) usernameRef.current?.focus();
  }, []);

  const trackCapsLock = (e: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.('CapsLock') ?? false);
  };

  // Back to the password with the old one selected — where every retry starts.
  const focusPassword = () =>
    requestAnimationFrame(() => {
      passwordRef.current?.focus();
      passwordRef.current?.select();
    });

  // The eye keeps focus — and a phone's keyboard — in the field, and the caret where it was.
  const togglePassword = () => {
    const el = passwordRef.current;
    const caret = el && document.activeElement === el ? ([el.selectionStart, el.selectionEnd] as const) : null;
    setShowPassword((v) => !v);
    if (el && caret) requestAnimationFrame(() => el.setSelectionRange(caret[0], caret[1]));
  };

  // The browser's own "Please fill out this field" bubble speaks the browser's language.
  const requiredInLanguage = {
    onInvalid: (e: FormEvent<HTMLInputElement>) => e.currentTarget.setCustomValidity(t('login.required')),
    onInput: (e: FormEvent<HTMLInputElement>) => e.currentTarget.setCustomValidity(''),
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // The button stays focusable while signing in (aria-disabled), so a second press is stopped here.
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    setLoading(true);
    try {
      const loginEmail = username.includes('@') ? username : `${username}@${EMAIL_DOMAIN}`;
      await signIn(loginEmail, password);

      // Check shift restrictions after successful auth (the login gate — no shift covering
      // "now" = no login for anyone but admins / managers).
      try {
        const shiftCheck: ShiftLoginCheck = await apiCheckShiftLogin();
        if (!shiftCheck.allowed) {
          // Sign the user out since they can't use the system
          const { supabase } = await import('@/integrations/supabase/client');
          await supabase.auth.signOut();
          setFailure({ kind: 'shift', check: shiftCheck });
          focusPassword();
          return;
        }

        // The api logs the login itself since 01.10.2026 (`logged: true`). Only an older api
        // (no `logged` in the answer) still needs the browser to write it.
        if (!shiftCheck.bypass && shiftCheck.shift_id && shiftCheck.logged === undefined) {
          try {
            await apiLogShiftLogin({
              shift_id: shiftCheck.shift_id,
              shift_date: shiftCheck.shift_date ?? '',
              shift_start_time: shiftCheck.shift_start_time ?? '',
              shift_end_time: shiftCheck.shift_end_time ?? '',
            });
          } catch {
            // Non-critical, don't block login
          }
        }
      } catch {
        // If shift check fails (e.g. network), allow login to proceed
      }

      // /start waits for this login's permissions, then picks its home (agents /calls,
      // admins / managers /insights) — src/lib/homePath.ts.
      navigate('/start', { replace: true });
    } catch (err: unknown) {
      setFailure({ kind: 'auth', err });
      focusPassword();
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="nt-login flex min-h-[100dvh] flex-col bg-nt-bg text-nt-text lg:grid lg:grid-cols-[minmax(0,11fr)_minmax(0,10fr)]">
      {/* Brand — the left half on a desktop */}
      <aside
        className="relative hidden overflow-hidden text-white forced-colors:[forced-color-adjust:none] lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16 2xl:p-20"
        style={BRAND_PANEL}
      >
        <img
          src={naturaMarkWhite}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute -top-28 left-1/2 h-[min(620px,82vh)] w-auto max-w-none rotate-[-14deg] select-none opacity-[0.07] 2xl:-top-40 2xl:h-[min(820px,80vh)]"
        />
        <img
          src={naturaLogoWhite}
          alt={PRODUCT}
          draggable={false}
          className="relative h-16 w-auto self-start xl:h-[72px] 2xl:h-20 min-[1920px]:h-24"
        />
        <p className="relative text-[clamp(30px,2.9vw,54px)] font-semibold leading-[1.12] tracking-tight">{tagline}</p>
      </aside>

      {/* Brand — a band across the top on a phone / tablet; its content shares the form's column. */}
      <header
        className="relative flex min-h-[max(10.5rem,25dvh)] flex-col justify-between overflow-hidden px-5 pb-12 pt-5 text-white forced-colors:[forced-color-adjust:none] sm:px-10 sm:pb-20 sm:pt-8 lg:hidden [@media(max-height:500px)]:min-h-0 [@media(max-height:500px)]:pb-10"
        style={BRAND_PANEL}
      >
        <img
          src={naturaMarkWhite}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute -right-16 -top-16 h-64 w-auto max-w-none rotate-[-14deg] select-none opacity-[0.08] sm:-right-20 sm:-top-24 sm:h-96"
        />
        <div className="relative mx-auto flex w-full max-w-[400px] items-center justify-between gap-4">
          <img src={naturaLogoWhite} alt={PRODUCT} draggable={false} className="h-10 w-auto sm:h-12" />
          <LoginLanguagePicker tone="onBrand" />
        </div>
        {/* A phone on its side has no room for it — the form comes first. */}
        <p className="relative mx-auto mt-7 w-full max-w-[400px] text-xl font-semibold leading-snug tracking-tight sm:mt-14 sm:text-[26px] sm:leading-[1.2] [@media(max-height:500px)]:hidden">
          {tagline}
        </p>
      </header>

      <main className="relative -mt-7 flex flex-1 flex-col rounded-t-[28px] bg-nt-bg lg:mt-0 lg:rounded-none">
        {/* On a desktop this row is the panel's logo row: same padding, the picker on the logo's centre line. */}
        <div className="hidden items-center justify-end lg:flex lg:h-28 lg:px-12 lg:pt-12 xl:h-[136px] xl:px-16 xl:pt-16 2xl:h-40 2xl:px-20 2xl:pt-20 min-[1920px]:h-44">
          <LoginLanguagePicker tone="onPage" />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 pb-8 pt-9 sm:px-8 lg:py-10">
          <div className="w-full max-w-[400px] duration-500 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none 2xl:max-w-[440px] min-[1920px]:max-w-[480px]">
            <img src={naturaMark} alt="" aria-hidden="true" draggable={false} className="mb-5 hidden h-12 w-auto lg:block" />
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px] 2xl:text-[36px] min-[1920px]:text-[40px]">
              {PRODUCT} <span className="text-nt-brand-ink">HUB</span>
            </h1>
            <p className="mt-2 text-[15px] text-nt-muted">{t('login.signInToAccount')}</p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-[13px] text-nt-text">
                  {t('login.username')}
                </Label>
                <div className="relative">
                  <User
                    className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-nt-subtle"
                    aria-hidden="true"
                  />
                  <Input
                    ref={usernameRef}
                    id="username"
                    name="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    {...requiredInLanguage}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={credentialsWrong || undefined}
                    className={FIELD}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-[13px] text-nt-text">
                  {t('login.password')}
                </Label>
                <div className="relative">
                  <Lock
                    className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-nt-subtle"
                    aria-hidden="true"
                  />
                  <Input
                    ref={passwordRef}
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={trackCapsLock}
                    onKeyUp={trackCapsLock}
                    onBlur={() => setCapsLock(false)}
                    required
                    {...requiredInLanguage}
                    autoComplete="current-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={credentialsWrong || undefined}
                    aria-describedby={capsLock ? 'caps-lock-hint' : undefined}
                    className={cn(FIELD, 'pr-12')}
                  />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={togglePassword}
                    aria-label={t('login.showPassword')}
                    aria-pressed={showPassword}
                    aria-controls="password"
                    className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-nt-subtle transition-colors hover:bg-nt-bg hover:text-nt-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nt-focus"
                  >
                    {showPassword ? (
                      <EyeOff className="h-[18px] w-[18px]" aria-hidden="true" />
                    ) : (
                      <Eye className="h-[18px] w-[18px]" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {/* Takes no room until it speaks: no stray gap above the button. */}
                <div aria-live="polite" className="!mt-0">
                  {capsLock && (
                    <p id="caps-lock-hint" className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-nt-warn">
                      <ArrowBigUp className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('login.capsLockOn')}
                    </p>
                  )}
                </div>
              </div>

              {errorText && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-nt-danger-border bg-nt-danger-bg px-3.5 py-3 text-sm leading-snug text-nt-danger-text"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 break-words">{errorText}</p>
                </div>
              )}

              <Button
                type="submit"
                aria-disabled={loading || undefined}
                className="group h-12 w-full rounded-xl border border-transparent bg-nt-btn text-[15px] font-semibold text-nt-btn-text shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(0,0,0,0.18)] hover:bg-nt-btn-hover focus-visible:ring-2 focus-visible:ring-nt-focus focus-visible:ring-offset-2 focus-visible:ring-offset-nt-bg aria-disabled:cursor-progress"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    {t('login.signingIn')}
                  </>
                ) : (
                  <>
                    {t('login.signIn')}
                    <ArrowRight
                      className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </>
                )}
              </Button>
            </form>
          </div>
        </div>

        <footer className="px-5 pb-6 pt-2 text-center text-xs text-nt-muted lg:pb-12 xl:pb-16 2xl:pb-20">
          {BRAND.poweredBy} <span className="font-semibold tracking-tight text-nt-text">{BRAND.maker}</span>
        </footer>
      </main>
    </div>
  );
}
