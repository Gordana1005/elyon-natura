import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions, useInsightsAccess } from '@/contexts/PermissionsContext';
import {
  LayoutDashboard, ShoppingCart, Package,
  Users, CalendarDays, FileText, History, ChevronLeft,
  ChevronRight, ChevronDown, Phone, PhoneCall, PhoneIncoming, Warehouse, Settings, Inbox,
  Webhook, UserPlus, SearchIcon, TrendingUp, Activity, Zap, Layers, Lock, Clock, Gauge, FileUp,
  Handshake, Radio, X,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarCallIndicator } from '@/components/calls/SidebarCallIndicator';
import { useIsMobile } from '@/hooks/use-mobile';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PresenceHeaderButton } from '@/components/presence/PresenceHeaderButton';

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
      { titleKey: 'nav.calls', path: '/calls', icon: PhoneCall, moduleKey: 'calls' },
      { titleKey: 'nav.callAgain', path: '/call-again', icon: Clock, moduleKey: 'calls' },
      { titleKey: 'nav.missedCalls', path: '/missed-calls', icon: PhoneIncoming, moduleKey: 'calls' },
      { titleKey: 'nav.personalList', path: '/personal-list', icon: Lock, moduleKey: 'calls' },
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
      { titleKey: 'nav.insights', path: '/insights', icon: TrendingUp, moduleKey: 'insights', moduleKeysAny: ['performance', 'agent_activity'] },
      { titleKey: 'nav.operations', path: '/operations', icon: Activity, moduleKey: 'operations' },
    ],
  },
  {
    labelKey: 'nav.sections.sales',
    items: [
      { titleKey: 'nav.orders', path: '/orders', icon: ShoppingCart, moduleKey: 'orders' },
      { titleKey: 'nav.inboundLeads', path: '/inbound-leads', icon: Inbox, moduleKey: 'inbound_leads' },
      { titleKey: 'nav.assigner', path: '/assigner', icon: UserPlus, moduleKey: 'assigner' },
      { titleKey: 'nav.leadDistribution', path: '/lead-distribution', icon: Zap, moduleKey: 'lead_distribution' },
      { titleKey: 'nav.predictionLists', path: '/segments', icon: Layers, moduleKey: 'segments' },
      { titleKey: 'nav.searchPrediction', path: '/search-prediction', icon: SearchIcon, moduleKey: 'search_prediction' },
      // Admin-only: the 'order_import' module key isn't seeded for any role, so
      // canAccessModule() returns true only for admins (who bypass the check).
      { titleKey: 'nav.importOrders', path: '/import-orders', icon: FileUp, moduleKey: 'order_import' },
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
      { titleKey: 'nav.users', path: '/users', icon: Users, moduleKey: 'users' },
      // Performance → Insights "Agents" tab; Agent Activity → Insights "Call Activity" tab.
      { titleKey: 'nav.shiftsManagement', path: '/shifts', icon: CalendarDays, moduleKey: 'shifts' },
      { titleKey: 'nav.myShifts', path: '/my-shifts', icon: CalendarDays, moduleKey: 'my_shifts' },
      { titleKey: 'nav.callSupportCenter', path: '/call-scripts', icon: FileText, moduleKey: 'call_scripts' },
      { titleKey: 'nav.callHistory', path: '/call-history', icon: History, moduleKey: 'call_history' },
    ],
  },
  {
    labelKey: 'nav.sections.productsAds',
    items: [
      { titleKey: 'nav.products', path: '/products', icon: Package, moduleKey: 'products' },
      { titleKey: 'nav.webhooksAds', path: '/webhooks', icon: Webhook, moduleKey: 'webhooks' },
      { titleKey: 'nav.affiliates', path: '/affiliates-admin', icon: Handshake, moduleKey: 'affiliates_admin' },
      { titleKey: 'nav.altercpa', path: '/altercpa', icon: Radio, moduleKey: 'altercpa_bridge' },
    ],
  },
  {
    labelKey: '',
    items: [
      { titleKey: 'nav.voipHealth', path: '/voip-health', icon: Gauge, moduleKey: 'voip_health' },
      { titleKey: 'nav.settings', path: '/settings', icon: Settings, moduleKey: 'settings' },
    ],
  },
];

/**
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
        return canAccessModule(item.moduleKey) ||
          (item.moduleKeysAny?.some(k => canAccessModule(k)) ?? false);
      });
      if (items.length === 0) return null;
      return { ...section, items };
    })
    .filter(Boolean) as NavSection[];

  // Vertical gradient colors for the nav icons (non-active state).
  // We treat the entire visible nav as one vertical sequence.
  // More aggressive color progression: starts at green (top, telephony/brand) and
  // rapidly shifts through teal/blue/purple/magenta to end in red at the bottom.
  // This gives a much wider rainbow of colors (not just green-to-blue) when viewing the whole sidebar.
  const flatNavItems = visibleSections.flatMap((s) => s.items);
  const totalNavItems = flatNavItems.length;
  const pathToIconColor = new Map<string, string>();
  flatNavItems.forEach((item, idx) => {
    if (totalNavItems <= 1) {
      pathToIconColor.set(item.path, 'hsl(135, 70%, 58%)');
      return;
    }
    const progress = idx / (totalNavItems - 1);
    // Hue starts vibrant green (~135) and aggressively shifts +220° to red (~355)
    // passing through cyan, blue, indigo, purple, magenta etc. for lots of color variety.
    const hue = 135 + progress * 220;
    // Stronger saturation ramp for more vivid colors as we descend
    const sat = 60 + progress * 20;
    // Lightness tuned for dark sidebar (visible but not overpowering)
    const light = 58;
    pathToIconColor.set(item.path, `hsl(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${light}%)`);
  });

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
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" aria-hidden onClick={() => onMobileClose?.()} />
    )}
    <aside
      id="app-sidebar"
      aria-hidden={isMobile && !mobileOpen ? true : undefined}
      className={cn(
        'flex flex-col border-r border-sidebar-border bg-sidebar',
        isMobile
          ? cn('fixed inset-y-0 left-0 z-50 h-[100dvh] w-[min(85vw,300px)] shadow-2xl transition-transform duration-300 ease-in-out',
               mobileOpen ? 'translate-x-0' : '-translate-x-full invisible')
          : cn('h-screen transition-all duration-300 ease-in-out', collapsed ? 'w-[68px]' : 'w-[240px]'),
      )}
    >
      {/* ── Brand ── */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary shadow-sm shadow-primary/20">
          <Phone className="h-4 w-4 text-primary-foreground" />
        </div>
        <span
          className={cn(
            'text-[15px] font-bold tracking-tight text-sidebar-accent-foreground transition-opacity duration-200',
            collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100',
          )}
        >
          Elyon CRM
        </span>
        {isMobile && (
          <button
            type="button"
            onClick={() => onMobileClose?.()}
            aria-label={t('common.close')}
            className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* ── Active call (pushes nav down while a call is live; hidden otherwise) ── */}
      <SidebarCallIndicator collapsed={collapsed} />

      {/* ── Navigation ── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-1">
        {visibleSections.map((section, idx) => (
          <div key={section.labelKey || idx}>
            {section.labelKey && !collapsed && (
              <button
                onClick={() => toggleSection(section.labelKey)}
                className="group flex w-full items-center justify-between rounded-lg px-3 py-2 mt-4 mb-0.5 text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/50 hover:text-sidebar-foreground/70 transition-colors"
                aria-expanded={openSections[section.labelKey]}
              >
                <span>{t(section.labelKey)}</span>
                <ChevronDown
                  className={cn(
                    'h-3 w-3 transition-transform duration-200',
                    openSections[section.labelKey] ? 'rotate-0' : '-rotate-90',
                  )}
                />
              </button>
            )}

            {section.labelKey && collapsed && (
              <div className="mx-auto my-3 h-px w-6 bg-sidebar-border" />
            )}

            <div
              className={cn(
                'space-y-0.5 overflow-hidden transition-all duration-200 ease-in-out',
                section.labelKey && !collapsed && !openSections[section.labelKey]
                  ? 'max-h-0 opacity-0'
                  : 'max-h-[500px] opacity-100',
              )}
            >
              {section.items.map(item => {
                const isActive = location.pathname === item.path;
                const linkContent = (
                  <Link
                    key={item.path}
                    to={item.path}
                    onClick={() => {
                      // on a phone the drawer closes after navigating
                      if (isMobile) onMobileClose?.();
                    }}
                    className={cn(
                      'group flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] font-medium transition-all duration-150',
                      collapsed && 'justify-center px-0',
                      isActive
                        ? 'bg-primary/10 text-primary shadow-sm'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    )}
                  >
                    <item.icon
                      className={cn(
                        'h-[18px] w-[18px] shrink-0 transition-all duration-150',
                        isActive && 'text-primary',
                        !isActive && 'group-hover:brightness-125 group-hover:saturate-150',
                      )}
                      style={!isActive ? { color: pathToIconColor.get(item.path) || 'hsl(220, 12%, 65%)' } : undefined}
                      strokeWidth={isActive ? 2.2 : 1.8}
                    />
                    {!collapsed && <span className="truncate min-w-0">{t(item.titleKey)}</span>}
                    {isActive && !collapsed && (
                      <div className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
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
        <div className="shrink-0 border-t border-sidebar-border p-3">
          <div className="flex items-center justify-center gap-2 rounded-xl bg-card p-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <PresenceHeaderButton />
          </div>
        </div>
      )}

      {/* ── Collapse toggle ── */}
      <div className={cn(
        "shrink-0 border-t border-sidebar-border p-3",
        isMobile && "hidden"
      )}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-all duration-150"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              <span>{t('common.collapse')}</span>
            </>
          )}
        </button>
      </div>
    </aside>
    </>
  );
}
