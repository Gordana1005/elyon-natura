// Поставки — the small sections: link cards to the pages that own the work
// (Корисници, Партнери, Магацин) and Лично (language + theme).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight, Check, Crown, Handshake, Moon, Shield, Sun, UserCog, Users, Warehouse, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { cn } from '@/lib/utils';
import { apiGetUsers } from '@/lib/api';
import { SectionHeader, SettingsCard, settingsErrorText } from './settingsUi';

function OpenButton({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild size="sm" className="h-9">
      <Link to={to}>{label} <ArrowRight className="ml-1 h-4 w-4" aria-hidden /></Link>
    </Button>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="min-w-0 break-words">{label}</span>
      </div>
      <div className="text-2xl font-semibold leading-tight tabular-nums">{value}</div>
    </div>
  );
}

interface StaffRow { user_id: string; is_active: boolean; roles?: string[] }

/** Корисници — the page is /users (the Insights-style one); here only the counts and the way there. */
export function UsersLinkSection() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['settings-staff'], queryFn: apiGetUsers });
  const c = useMemo(() => {
    const rows = (q.data ?? []) as StaffRow[];
    const active = rows.filter((u) => u.is_active);
    return {
      total: rows.length,
      active: active.length,
      suspended: rows.length - active.length,
      admins: active.filter((u) => (u.roles ?? []).includes('admin')).length,
      managers: active.filter((u) => (u.roles ?? []).includes('manager') && !(u.roles ?? []).includes('admin')).length,
    };
  }, [q.data]);
  return (
    <div className="space-y-4">
      <SectionHeader icon={Users} title={t('settingsPage.users.title')} desc={t('settingsPage.users.desc')} />
      <SettingsCard>
        {q.isError ? (
          <p className="text-sm text-destructive">{settingsErrorText(q.error)}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat icon={Users} label={t('settingsPage.users.active')} value={q.isLoading ? '…' : c.active} />
            <Stat icon={Users} label={t('settingsPage.users.suspended')} value={q.isLoading ? '…' : c.suspended} />
            <Stat icon={Crown} label={t('settingsPage.users.admins')} value={q.isLoading ? '…' : c.admins} />
            <Stat icon={Shield} label={t('settingsPage.users.managers')} value={q.isLoading ? '…' : c.managers} />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <OpenButton to="/users" label={t('settingsPage.users.open')} />
          <p className="text-xs text-muted-foreground">{t('settingsPage.users.hint')}</p>
        </div>
      </SettingsCard>
    </div>
  );
}

/** Партнери — /affiliates-admin is out of the menu but reachable; the payout stays in EUR (owner, 10.08). */
export function PartnersSection() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <SectionHeader icon={Handshake} title={t('settingsPage.partners.title')} desc={t('settingsPage.partners.desc')} />
      <SettingsCard>
        <p className="text-sm">{t('settingsPage.partners.eurRule')}</p>
        <div className="mt-4"><OpenButton to="/affiliates-admin" label={t('settingsPage.partners.open')} /></div>
      </SettingsCard>
    </div>
  );
}

/** Магацин → MEX праќање: the switch and the low-stock thresholds live in Warehouse now. */
export function WarehouseLinkSection() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <SectionHeader icon={Warehouse} title={t('settingsPage.warehouse.title')} desc={t('settingsPage.warehouse.desc')} />
      <SettingsCard>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{t('settingsPage.warehouse.mexPush')}</li>
          <li>{t('settingsPage.warehouse.thresholds')}</li>
        </ul>
        <div className="mt-4"><OpenButton to="/warehouse" label={t('settingsPage.warehouse.open')} /></div>
      </SettingsCard>
    </div>
  );
}

/** Macedonian first. */
const LANGS = [...SUPPORTED_LANGUAGES].sort((a, b) => (a === 'mk' ? -1 : b === 'mk' ? 1 : 0));

/** Лично — the same language and theme as the top bar, for this login / this device. */
export function PersonalSection() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // next-themes resolves on the client; before that the choice is unknown (no wrong flash).
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';

  const choice = (on: boolean) => cn(
    'flex min-h-11 min-w-0 flex-1 basis-36 items-center gap-2 rounded-xl border-2 px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    on ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40',
  );

  return (
    <div className="space-y-4">
      <SectionHeader icon={UserCog} title={t('settingsPage.personal.title')} desc={t('settingsPage.personal.desc')} />
      <SettingsCard title={t('common.language')} desc={t('settings.languageDesc')} labelledBy="personal-lang">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="personal-lang">
          {LANGS.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={language === l} onClick={() => setLanguage(l)} className={choice(language === l)}>
              <FlagIcon lang={l} className="h-3.5 w-6 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{t(`languages.${l}`)}</span>
              {language === l && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
            </button>
          ))}
        </div>
      </SettingsCard>
      <SettingsCard title={t('settings.theme')} desc={t('settingsPage.personal.themeDesc')} labelledBy="personal-theme">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="personal-theme">
          <button type="button" role="radio" aria-checked={mounted && !dark} onClick={() => setTheme('light')} className={choice(mounted && !dark)}>
            <Sun className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
            <span className="min-w-0 flex-1">{t('settings.light')}</span>
            {mounted && !dark && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
          </button>
          <button type="button" role="radio" aria-checked={dark} onClick={() => setTheme('dark')} className={choice(dark)}>
            <Moon className="h-4 w-4 shrink-0 text-sky-500" aria-hidden />
            <span className="min-w-0 flex-1">{t('settings.dark')}</span>
            {dark && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}
