import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import {
  LayoutDashboard, ShoppingCart, ClipboardList, Package,
  Users, CalendarDays, FileText, History, ChevronLeft,
  ChevronRight, ChevronDown, Phone, PhoneCall, PhoneIncoming, Warehouse, Settings, Inbox,
  Webhook, UserPlus, SearchIcon, TrendingUp, Activity, Zap, Layers, Lock, Clock, Gauge, FileUp,
  Handshake, Radio,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SidebarCallIndicator } from '@/components/calls/SidebarCallIndicator';
import { useIsMobile } from '@/hooks/use-mobile';

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
      // Insights now also hosts the former Performance (Agents tab) and
      // Agent Activity (Call Activity tab) pages, so keep it visible for users
      // who only had those modules.
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
      { titleKey: 'nav.assignedToMe', path: '/assigned', icon: ClipboardList, moduleKey: 'assigned' },
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

export function AppSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();
  const { canAccessModule } = usePermissions();

  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(() => {
    // Default to collapsed (icons only) on mobile so it doesn't take over the screen.
    if (typeof window !== 'undefined') {
      return window.innerWidth < 768;
    }
    return false;
  });
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  // Filter sections based on module enabled + role permissions
  const visibleSections = sections
    .map(section => {
      const items = section.items.filter(item => {
        // Partner-only surface: admins pass canAccessModule for everything,
        // but the portal items should only clutter an actual affiliate's nav.
        if (item.moduleKey === 'affiliate_portal' && !user?.isAffiliate) return false;
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
    <aside
      className={cn(
        'flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out',
        collapsed ? 'w-[68px]' : 'w-[240px]',
      )}
    >
      {/* ── Brand ── */}
      <div
        className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-4 cursor-pointer"
        onClick={() => {
          if (isMobile) {
            setCollapsed(!collapsed);
          }
        }}
        role={isMobile ? 'button' : undefined}
        aria-label={isMobile ? t('nav.toggleSidebar') : undefined}
      >
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
      </div>

      {/* Mobile: Expand/Collapse toggle right below the Elyon Logo so it's always visible at the top (no need to scroll to bottom of sidebar) */}
      {isMobile && (
        <div className="shrink-0 border-b border-sidebar-border px-2 py-1 flex justify-center">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center justify-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-all duration-150"
          >
            {collapsed ? (
              <>
                <ChevronRight className="h-3 w-3" />
                <span>{t('common.expand')}</span>
              </>
            ) : (
              <>
                <ChevronLeft className="h-3 w-3" />
                <span>{t('common.collapse')}</span>
              </>
            )}
          </button>
        </div>
      )}

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
                      if (isMobile) {
                        // After navigating on mobile, auto-collapse back to icons-only.
                        setCollapsed(true);
                      }
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
  );
}
