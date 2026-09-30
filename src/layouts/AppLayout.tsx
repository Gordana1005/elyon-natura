import { AppSidebar } from '@/components/AppSidebar';
import { LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { BreakButton } from '@/components/calls/BreakButton';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NotificationsDropdown } from '@/components/NotificationsDropdown';
import { VoipIncidentBanner } from '@/components/VoipIncidentBanner';
import { PresenceHeaderButton } from '@/components/presence/PresenceHeaderButton';
import { usePresenceTracking } from '@/hooks/usePresence';
import { friendlyRoleLabel } from '@/lib/roles';
import { useNavigate } from 'react-router-dom';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsMobile } from '@/hooks/use-mobile';

interface AppLayoutProps {
  children: React.ReactNode;
  title: string;
  /** Optional controls rendered next to the page title (e.g. the Calls dialer). */
  headerActions?: React.ReactNode;
}

export function AppLayout({ children, title, headerActions }: AppLayoutProps) {
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // phone: the sidebar is an off-canvas drawer opened from the top bar (AppSidebar)
  const [navOpen, setNavOpen] = useState(false);
  // Time on the CRM + the 30-minute idle alert. The tracker is module-level,
  // so this per-page layout remounting on navigation does not restart it.
  usePresenceTracking();

  const handleLogout = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  const initials = user?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?';

  return (
    <>
    {/* relative: absolutely positioned descendants (the sr-only captions, headings and table
        twins the Insights tabs carry) need a containing block INSIDE the h-screen frame — without one
        they are placed against the page, stretch it past the viewport and the window scrolls into an
        empty grey area below the content (seen on Insights → Агенти / Продажби, 29.09.2026). */}
    <div className="relative flex h-screen w-full overflow-hidden">
      <AppSidebar mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="flex h-16 items-center justify-between border-b bg-card px-3 sm:px-4 md:px-6 gap-2 md:gap-4">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            {isMobile && (
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                aria-label={t('nav.toggleSidebar')}
                aria-controls="app-sidebar"
                aria-expanded={navOpen}
                className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-card-foreground hover:bg-muted"
              >
                <Menu className="h-5 w-5" />
              </button>
            )}
            {/* Title is optional — some pages (e.g. Calls) drop it to keep the bar uncluttered. */}
            {title && <h1 className="text-base sm:text-lg md:text-xl font-semibold text-card-foreground truncate">{title}</h1>}
            {headerActions}
          </div>
          <div className="flex items-center gap-1.5 md:gap-3">
            {/* on a phone these three move into the drawer's footer */}
            {!isMobile && <LanguageSwitcher />}
            {!isMobile && <ThemeToggle />}
            {/* Break + customer search are staff tools — hidden for external
                affiliate logins (their API calls would 403 on the hard wall). */}
            {!isMobile && !user?.isAffiliate && <BreakButton />}
            {!user?.isAffiliate && <GlobalSearch />}
            {/* Owners only ("Who is working") — renders nothing for anyone else. */}
            {!isMobile && <PresenceHeaderButton />}
            {!user?.isAffiliate && <NotificationsDropdown />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-muted transition-colors">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    {initials}
                  </div>
                  {/* Hide full user info on small screens to avoid crowding next to the (narrow) sidebar */}
                  <div className="text-left hidden xl:block">
                    <span className="block text-sm font-medium text-card-foreground">{user?.full_name || t('common.user')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {friendlyRoleLabel(user?.roles)}
                    </span>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  {t('common.signOut')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {/* Superadmin telephony alert strip (quiet unless something is wrong) */}
        <VoipIncidentBanner />
        {/* Content */}
        <main className="relative flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden bg-background p-3 sm:p-4 md:p-6">{children}</main>
      </div>
    </div>
    </>
  );
}
