import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions, useInsightsAccess } from '@/contexts/PermissionsContext';
import {
  Activity, BookUser, Boxes, CalendarClock, ChartNoAxesCombined, ChevronDown, Handshake, Headset,
  HeartPulse, History, LayoutDashboard, ListChecks, Megaphone, NotebookPen, Package, PanelLeftClose,
  PanelLeftOpen, PhoneForwarded, ScrollText, Settings, ShoppingBag, Split, Store, UsersRound, Warehouse,
  Webhook, X,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarCallIndicator } from '@/components/calls/SidebarCallIndicator';
import { useIsMobile } from '@/hooks/use-mobile';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PresenceHeaderButton } from '@/components/presence/PresenceHeaderButton';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { navItemActive } from '@/lib/navActive';
import { useShopsAccess } from '@/components/shops/useShopsAccess';
import { BRAND, BRAND_LOGO } from '@/lib/brand';

interface NavItem {
  /** i18n key under nav.* — resolved with t() at render time */
  titleKey: string;
  path: string;
  icon: React.ElementType;
  moduleKey: string;
  /** Extra module keys that also grant this item (any-of). Used by Insights,
   *  which now hosts the former Performance / Agent Activity pages as tabs. */
  moduleKeysAny?: string[];
}

interface NavSection {
  /** i18n key under nav.sections.* ('' = unlabeled section). Also the stable
   *  open/closed state key, so it must not change with language. */
  labelKey: string;
  items: NavItem[];
}

// Hidden from the menu by the owner's page audit (30.09.2026, 61 days of request logs): Missed calls,
// Inbound leads, Webhooks & ads (all 0 rows ever), Lead distribution (off since 16.09 — the Assigner
// distributes), Search prediction (the top search bar), Import orders (never created a real order) and
// Affiliates admin (no partners yet). Their routes still resolve (or redirect) so old links don't break.
// Icons (Natura Therapy HUB, owner 02.10.2026): one per page, one brand tone — no rainbow.
const sections: NavSection[] = [
  {
    // Affiliate (webmaster) portal — module access alone isn't enough here:
    // admins pass every module check, but these pages are the partner's view,
    // so the items render only for logins that actually hold the role.
    labelKey: '',
    items: [
      { titleKey: 'nav.affiliateDashboard', path: '/affiliate', icon: Handshake, moduleKey: 'affiliate_portal' },
      { titleKey: 'nav.affiliateOffers', path: '/affiliate/offers', icon: Package, moduleKey: 'affiliate_portal' },
      { titleKey: 'nav.affiliateIntegration', path: '/affiliate/integration', icon: Webhook, moduleKey: 'affiliate_portal' },
    ],
  },
  {
    labelKey: '',
    items: [
      { titleKey: 'nav.calls', path: '/calls', icon: Headset, moduleKey: 'calls' },
      // A queue inside /calls since plan Фаза 11 (/call-again redirects there).
      { titleKey: 'nav.callAgain', path: '/calls?queue=call-again', icon: PhoneForwarded, moduleKey: 'calls' },
      { titleKey: 'nav.personalList', path: '/personal-list', icon: BookUser, moduleKey: 'calls' },
      // Личен дневник (plan Фаза 7): a tab of /personal-list; the query path lights only this item.
      { titleKey: 'nav.personalNotes', path: '/personal-list?tab=notes', icon: NotebookPen, moduleKey: 'calls' },
    ],
  },
  {
    // All "looking at numbers" destinations in one place.
    labelKey: 'nav.sections.analytics',
    items: [
      { titleKey: 'nav.dashboard', path: '/', icon: LayoutDashboard, moduleKey: 'dashboard' },
      // Insights hosts the money tabs (owners only) plus the operational
      // Agents / Payout / Call Activity tabs. Its visibility is decided by
      // useInsightsAccess() in the filter below, NOT by these module keys.
      { titleKey: 'nav.insights', path: '/insights', icon: ChartNoAxesCombined, moduleKey: 'insights', moduleKeysAny: ['performance', 'agent_activity'] },
      { titleKey: 'nav.operations', path: '/operations', icon: Activity, moduleKey: 'operations' },
      // Продавници (owner 02.10.2026): owners + managers + admins — decided by useShopsAccess() below.
      { titleKey: 'nav.shops', path: '/shops', icon: Store, moduleKey: 'shops' },
    ],
  },
  {
    labelKey: 'nav.sections.sales',
    items: [
      { titleKey: 'nav.orders', path: '/orders', icon: ShoppingBag, moduleKey: 'orders' },
      { titleKey: 'nav.assigner', path: '/assigner', icon: Split, moduleKey: 'assigner' },
      { titleKey: 'nav.predictionLists', path: '/segments', icon: ListChecks, moduleKey: 'segments' },
    ],
  },
  {
    labelKey: 'nav.sections.warehouse',
    items: [
      { titleKey: 'nav.warehouse', path: '/warehouse', icon: Warehouse, moduleKey: 'warehouse' },
    ],
  },
  {
    labelKey: 'nav.sections.team',
    items: [
      { titleKey: 'nav.users', path: '/users', icon: UsersRound, moduleKey: 'users' },
      // Performance → Insights "Agents" tab; Agent Activity → Insights "Call Activity" tab.
      // One "Смени" page (owner 30.09): agents see their own shifts, admins/managers the tools too.
      { titleKey: 'nav.shiftsManagement', path: '/shifts', icon: CalendarClock, moduleKey: 'shifts', moduleKeysAny: ['my_shifts'] },
      { titleKey: 'nav.callSupportCenter', path: '/call-scripts', icon: ScrollText, moduleKey: 'call_scripts' },
      { titleKey: 'nav.callHistory', path: '/call-history', icon: History, moduleKey: 'call_history' },
    ],
  },
  {
    labelKey: 'nav.sections.productsAds',
    items: [
      { titleKey: 'nav.products', path: '/products', icon: Boxes, moduleKey: 'products' },
      { titleKey: 'nav.altercpa', path: '/altercpa', icon: Megaphone, moduleKey: 'altercpa_bridge' },
    ],
  },
  {
    labelKey: '',
    items: [
      // VOIP health only once the phone system exists (telephony is deferred on MK).
      ...(PBX_CONFIG.useRealVoip ? [{ titleKey: 'nav.voipHealth', path: '/voip-health', icon: HeartPulse, moduleKey: 'voip_health' }] : []),
      { titleKey: 'nav.settings', path: '/settings', icon: Settings, moduleKey: 'settings' },
    ],
  },
];

/**
 * The Natura Therapy HUB sidebar (owner, 02.10.2026): the brand's deep forest green (as on the login),
 * the Natura Therapy logo with "Powered by elyonpremium" under it, one icon tone, a light-green bar on
 * the page you are on.
 *
 * Desktop / tablet (≥ 768 px): the rail in the page flow, collapsible to icons.
 * Phone (< 768 px, owner 30.09.2026 — "perfect on every screen"): no rail eating the width; an off-canvas
 * drawer opened by the hamburger in AppLayout's top bar, full labels, closed by the backdrop, Esc, the X or
 * any navigation. Language, theme and "who is working" live in the drawer's footer on a phone, so the top
 * bar keeps room for the page title.
 */
export function AppSidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void } = {}) {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  const { canAccessModule } = usePermissions();
  const insightsAccess = useInsightsAccess();
  const shopsAccess = useShopsAccess();

  const isMobile = useIsMobile();
  // a tablet (768–1023 px) starts with the icon rail, so the page keeps its width; the user can expand it
  const [railCollapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  // the phone drawer always shows full labels
  const collapsed = railCollapsed && !isMobile;

  // close the phone drawer on navigation and on Esc
  useEffect(() => {
    if (isMobile) onMobileClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onMobileClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, mobileOpen, onMobileClose]);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  // Filter sections based on module enabled + role permissions
  const visibleSections = sections
    .map(section => {
      const items = section.items.filter(item => {
        // Partner-only surface: admins pass canAccessModule for everything,
        // but the portal items should only clutter an actual affiliate's nav.
        if (item.moduleKey === 'affiliate_portal' && !user?.isAffiliate) return false;
        // Insights (owner ruling 2026-09-27): shown to an owner, or to anyone
        // who can open at least one operational tab — the same rule the page
        // uses to build its tab list.
        if (item.path === '/insights') return insightsAccess.any;
        // Shops: owners see money, managers the same pages counted; nobody else (the api refuses them).
        if (item.path === '/shops') return shopsAccess.any;
        return canAccessModule(item.moduleKey) ||
          (item.moduleKeysAny?.some(k => canAccessModule(k)) ?? false);
      });
      if (items.length === 0) return null;
      return { ...section, items };
    })
    .filter(Boolean) as NavSection[];

  useEffect(() => {
    const initial: Record<string, boolean> = {};
    visibleSections.forEach(s => {
      if (s.labelKey) initial[s.labelKey] = true;
    });
    setOpenSections(initial);
  }, [user?.roles?.join(',')]);

  const toggleSection = (labelKey: string) => {
    if (collapsed) return;
    setOpenSections(prev => ({ ...prev, [labelKey]: !prev[labelKey] }));
  };

  return (
    <>
    {isMobile && mobileOpen && (
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] duration-200 animate-in fade-in-0 motion-reduce:animate-none"
        aria-hidden
        onClick={() => onMobileClose?.()}
      />
    )}
    <aside
      id="app-sidebar"
      aria-hidden={isMobile && !mobileOpen ? true : undefined}
      className={cn(
        'nt-sidebar flex flex-col border-r border-black/20 text-white',
        isMobile
          ? cn('fixed inset-y-0 left-0 z-50 h-[100dvh] w-[min(85vw,300px)] rounded-r-2xl shadow-2xl transition-transform duration-300 ease-in-out motion-reduce:transition-none',
               mobileOpen ? 'translate-x-0' : '-translate-x-full invisible')
          : cn('h-screen transition-all duration-300 ease-in-out motion-reduce:transition-none', collapsed ? 'w-[68px]' : 'w-[240px]'),
      )}
    >
      {/* ── Brand: the Natura Therapy logo, "Powered by elyonpremium" under it. 64 px — its edge lines
            up with the top bar's. Collapsed: the emblem alone. ── */}
      <div
        className={cn(
          'flex h-16 shrink-0 items-center border-b border-white/[0.07]',
          collapsed ? 'justify-center' : 'gap-3 px-5',
        )}
      >
        {collapsed ? (
          <img src={BRAND_LOGO.markWhite} alt={BRAND.product} draggable={false} className="h-8 w-auto select-none" />
        ) : (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img src={BRAND_LOGO.white} alt={BRAND.product} draggable={false} className="h-[34px] w-auto select-none" />
              <span className="rounded-[5px] bg-white/[0.08] px-1.5 py-[3px] text-[9.5px] font-bold leading-none tracking-[0.16em] text-[#a9d3c6] ring-1 ring-inset ring-white/10">
                {BRAND.hub}
              </span>
            </div>
            <p className="mt-1 truncate text-[10.5px] leading-none text-white/45">
              {BRAND.poweredBy} <span className="font-semibold tracking-tight text-white/75">{BRAND.maker}</span>
            </p>
          </div>
        )}
        {isMobile && (
          <button
            type="button"
            onClick={() => onMobileClose?.()}
            aria-label={t('common.close')}
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cc3b2]/70"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* ── Active call (pushes nav down while a call is live; hidden otherwise) ── */}
      <SidebarCallIndicator collapsed={collapsed} />

      {/* ── Navigation ── */}
      <nav className="nt-sidebar-scroll flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4 pt-3">
        {visibleSections.map((section, idx) => (
          <div key={section.labelKey || idx}>
            {section.labelKey && !collapsed && (
              <button
                type="button"
                onClick={() => toggleSection(section.labelKey)}
                className="group mb-1 mt-5 flex w-full items-center justify-between rounded-md px-3 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/40 transition-colors hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cc3b2]/70"
                aria-expanded={openSections[section.labelKey]}
              >
                <span>{t(section.labelKey)}</span>
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'h-3 w-3 text-white/30 transition-transform duration-200 group-hover:text-white/60',
                    openSections[section.labelKey] ? 'rotate-0' : '-rotate-90',
                  )}
                />
              </button>
            )}

            {section.labelKey && collapsed && (
              <div className="mx-auto my-3 h-px w-8 bg-white/10" />
            )}

            <div
              className={cn(
                'space-y-0.5 overflow-hidden transition-all duration-200 ease-in-out',
                // room for the light-green bar that sits on the sidebar's edge
                '-ml-3 pl-3',
                section.labelKey && !collapsed && !openSections[section.labelKey]
                  ? 'max-h-0 opacity-0'
                  : 'max-h-[500px] opacity-100',
              )}
            >
              {section.items.map(item => {
                // Sub-routes (/settings/teams, /segments/:id…) keep their menu item lit; '/' stays exact.
                // A query item (/calls?queue=call-again) is lit only on that view, and its
                // plain sibling (/calls) is not lit while that view is open.
                const isActive = navItemActive(item.path, location.pathname, location.search, section.items.map((i) => i.path));
                const linkContent = (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => {
                      // on a phone the drawer closes after navigating
                      if (isMobile) onMobileClose?.();
                    }}
                    className={cn(
                      'group relative flex items-center rounded-lg text-[13.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cc3b2]/70',
                      collapsed ? 'mx-auto h-10 w-10 justify-center' : 'h-9 gap-3 px-3',
                      isActive
                        ? 'bg-white/[0.09] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                        : 'text-white/[0.68] hover:bg-white/[0.05] hover:text-white',
                    )}
                  >
                    {/* the page you are on: a light-green bar on the sidebar's edge */}
                    {isActive && (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#8cc3b2]',
                          collapsed ? '-left-[14px]' : '-left-3',
                        )}
                      />
                    )}
                    <item.icon
                      aria-hidden
                      className={cn(
                        'h-[18px] w-[18px] shrink-0 transition-colors duration-150',
                        isActive ? 'text-[#8cc3b2]' : 'text-white/50 group-hover:text-white/85',
                      )}
                      strokeWidth={isActive ? 2 : 1.75}
                    />
                    {!collapsed && <span className="min-w-0 truncate">{t(item.titleKey)}</span>}
                  </Link>
                );

                if (collapsed) {
                  return (
                    <Tooltip key={item.path} delayDuration={0}>
                      <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="text-xs font-medium">
                        {t(item.titleKey)}
                      </TooltipContent>
                    </Tooltip>
                  );
                }

                return <div key={item.path}>{linkContent}</div>;
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* ── Phone: language, theme and "who is working" (the top bar keeps room for the title) ── */}
      {isMobile && (
        <div className="shrink-0 border-t border-white/[0.07] p-3">
          <div className="flex items-center justify-center gap-2 rounded-xl bg-white/[0.06] p-2 ring-1 ring-inset ring-white/[0.08]">
            <LanguageSwitcher />
            <ThemeToggle />
            <PresenceHeaderButton />
          </div>
        </div>
      )}

      {/* ── Collapse toggle ── */}
      <div className={cn('shrink-0 border-t border-white/[0.07] p-3', isMobile && 'hidden')}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? t('common.expand') : t('common.collapse')}
          className={cn(
            'flex h-9 w-full items-center rounded-lg text-[12.5px] font-medium text-white/45 transition-colors duration-150 hover:bg-white/[0.05] hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8cc3b2]/70',
            collapsed ? 'justify-center' : 'gap-3 px-3',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          ) : (
            <>
              <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
              <span>{t('common.collapse')}</span>
            </>
          )}
        </button>
      </div>
    </aside>
    </>
  );
}
