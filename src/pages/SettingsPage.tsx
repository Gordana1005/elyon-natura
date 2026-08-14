import { useState, useEffect, useMemo } from 'react';
import { useTheme } from 'next-themes';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/contexts/LanguageContext';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { FlagIcon } from '@/components/LanguageSwitcher';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { usePermissions } from '@/contexts/PermissionsContext';
import { EmptyState } from '@/components/EmptyState';
// Courier rates are stored in EUR but entered in denari — convert at the input.
import { eurToDen, denToEur } from '@/lib/currency';
import {
  apiGetUsers, apiToggleUserActive, apiSetUserRoles, apiDeleteUser,
  apiGetProducts, apiUpdateProduct,
  apiGetCourierRates, apiUpdateCourierRates, type CourierRate,
  apiGetAppSettings, apiUpdateAppSettings,
} from '@/lib/api';
import { Input } from '@/components/ui/input';
import {
  Users, Shield, Headphones, Package, Settings2, Palette, Warehouse,
  Search, UserPlus, ToggleLeft, ToggleRight, Trash2, Loader2,
  Sun, Moon, Eye, EyeOff, Bell, ChevronDown, ChevronRight, Languages,
  AlertTriangle, Mail, Lock, User as UserIcon,
  Crown, Clock, TrendingUp, Megaphone, ArrowUpDown,
  Blocks, KeyRound, DollarSign, LockKeyhole, Check, X, Phone, Truck, Trophy,
} from 'lucide-react';
import { TelephonyTab } from '@/components/settings/TelephonyTab';
import { LeaderboardTab } from '@/components/settings/LeaderboardTab';
import { PredictionEngineTab } from '@/components/settings/PredictionEngineTab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';

// ────── Constants ──────
const ALL_ROLES = ['admin', 'manager', 'agent', 'inbound_agent', 'pending_agent', 'prediction_agent', 'warehouse', 'ads_admin'] as const;

const ROLE_META: Record<string, { icon: any; labelKey: string; color: string; descKey: string }> = {
  admin:            { icon: Crown,       labelKey: 'userRole.admin',            color: 'bg-destructive/10 text-destructive border-destructive/30',   descKey: 'settings.roleDesc.admin' },
  manager:          { icon: Shield,      labelKey: 'userRole.manager',          color: 'bg-primary/10 text-primary border-primary/30',               descKey: 'settings.roleDesc.manager' },
  agent:            { icon: Headphones,  labelKey: 'userRole.agent',            color: 'bg-info/10 text-info border-info/30',                        descKey: 'settings.roleDesc.agent' },
  inbound_agent:    { icon: Phone,       labelKey: 'userRole.inbound_agent',    color: 'bg-info/10 text-info border-info/30',                        descKey: 'settings.roleDesc.inbound_agent' },
  pending_agent:    { icon: Clock,       labelKey: 'userRole.pending_agent',    color: 'bg-warning/10 text-warning border-warning/30',               descKey: 'settings.roleDesc.pending_agent' },
  prediction_agent: { icon: TrendingUp,  labelKey: 'userRole.prediction_agent', color: 'bg-accent/10 text-accent-foreground border-accent/30',       descKey: 'settings.roleDesc.prediction_agent' },
  warehouse:        { icon: Package,     labelKey: 'userRole.warehouse',        color: 'bg-success/10 text-success border-success/30',               descKey: 'settings.roleDesc.warehouse' },
  ads_admin:        { icon: Megaphone,   labelKey: 'userRole.ads_admin',        color: 'bg-secondary/60 text-secondary-foreground border-secondary', descKey: 'settings.roleDesc.ads_admin' },
};

const ORDER_STATUSES = [
  { key: 'pending', labelKey: 'status.pending', color: 'bg-yellow-500' },
  { key: 'take', labelKey: 'status.take', color: 'bg-blue-500' },
  { key: 'call_again', labelKey: 'status.call_again', color: 'bg-purple-500' },
  { key: 'confirmed', labelKey: 'status.confirmed', color: 'bg-green-500' },
  { key: 'shipped', labelKey: 'status.shipped', color: 'bg-cyan-500' },
  { key: 'delivered', labelKey: 'status.delivered', color: 'bg-emerald-600' },
  { key: 'returned', labelKey: 'status.returned', color: 'bg-red-500' },
  { key: 'paid', labelKey: 'status.paid', color: 'bg-emerald-500' },
  { key: 'trashed', labelKey: 'status.trashed', color: 'bg-gray-500' },
  { key: 'cancelled', labelKey: 'status.cancelled', color: 'bg-rose-500' },
];

const LEAD_STATUSES = [
  { key: 'not_contacted', labelKey: 'leadStatus.not_contacted', color: 'bg-gray-500' },
  { key: 'no_answer', labelKey: 'leadStatus.no_answer', color: 'bg-yellow-500' },
  { key: 'interested', labelKey: 'leadStatus.interested', color: 'bg-blue-500' },
  { key: 'not_interested', labelKey: 'leadStatus.not_interested', color: 'bg-red-500' },
  { key: 'confirmed', labelKey: 'leadStatus.confirmed', color: 'bg-green-500' },
];

interface UserRow {
  user_id: string;
  full_name: string;
  email: string;
  roles: string[];
  is_active: boolean;
  orders_processed: number;
  leads_processed: number;
  created_at: string;
}

// ────── Settings Page ──────
export default function SettingsPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.isAdmin ?? false;
  const isManager = currentUser?.isManager ?? false;

  if (!isAdmin && !isManager) {
    return (
      <AppLayout title={t('nav.settings')}>
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Shield className="h-12 w-12 mb-4 opacity-40" />
          <p className="text-lg font-medium">{t('settings.adminAccessRequired')}</p>
          <p className="text-sm mt-1">{t('settings.noPermissionSettings')}</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.settings')}>
      <Tabs defaultValue="users" className="space-y-6">
        <TabsList className="h-auto rounded-xl bg-muted/60 p-1 gap-1">
          <TabsTrigger value="users" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Users className="h-4 w-4" /> {t('settings.tabUsersRoles')}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="modules" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <Blocks className="h-4 w-4" /> {t('settings.tabModules')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="permissions" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <KeyRound className="h-4 w-4" /> {t('settings.tabRolePerms')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="financial" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <DollarSign className="h-4 w-4" /> {t('settings.tabFinancial')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="privacy" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <LockKeyhole className="h-4 w-4" /> {t('settings.tabPrivacy')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="telephony" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <Phone className="h-4 w-4" /> {t('settings.tabTelephony')}
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="logistics" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <Truck className="h-4 w-4" /> {t('settings.tabCourierRates')}
            </TabsTrigger>
          )}
          <TabsTrigger value="leaderboard" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Trophy className="h-4 w-4" /> {t('settings.tabLeaderboard', { defaultValue: 'Leaderboard' })}
          </TabsTrigger>
          <TabsTrigger value="system" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Settings2 className="h-4 w-4" /> {t('settings.tabSystemRules')}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="predengine" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
              <TrendingUp className="h-4 w-4" /> {t('settings.tabPredictionEngine', { defaultValue: 'Prediction Engine' })}
            </TabsTrigger>
          )}
          <TabsTrigger value="warehouse" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Warehouse className="h-4 w-4" /> {t('settings.tabWarehouse')}
          </TabsTrigger>
          <TabsTrigger value="appearance" className="rounded-lg gap-2 text-sm data-[state=active]:bg-card data-[state=active]:shadow-sm">
            <Palette className="h-4 w-4" /> {t('settings.tabAppearance')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users"><UsersTab /></TabsContent>
        {isAdmin && <TabsContent value="modules"><ModuleManagerTab /></TabsContent>}
        {isAdmin && <TabsContent value="permissions"><RolePermissionsTab /></TabsContent>}
        {isAdmin && <TabsContent value="financial"><FinancialVisibilityTab /></TabsContent>}
        {isAdmin && <TabsContent value="privacy"><PiiVisibilityTab /></TabsContent>}
        {isAdmin && <TabsContent value="telephony"><TelephonyTab /></TabsContent>}
        {isAdmin && <TabsContent value="logistics"><CourierRatesTab /></TabsContent>}
        <TabsContent value="leaderboard"><LeaderboardTab /></TabsContent>
        <TabsContent value="system"><SystemRulesTab /></TabsContent>
        {isAdmin && <TabsContent value="predengine"><PredictionEngineTab /></TabsContent>}
        <TabsContent value="warehouse"><WarehouseTab /></TabsContent>
        <TabsContent value="appearance"><AppearanceTab /></TabsContent>
      </Tabs>
    </AppLayout>
  );
}

// ════════════════════════════════════════════════════
// TAB 1: Users & Roles
// ════════════════════════════════════════════════════
function UsersTab() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<'full_name' | 'created_at' | 'orders_processed'>('full_name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showModal, setShowModal] = useState(false);
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRoles, setFormRoles] = useState<Set<string>>(new Set(['agent']));
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  const { user: currentUser } = useAuth();

  const fetchUsers = () => {
    setLoading(true);
    apiGetUsers()
      .then((data) => setUsers(data.map((u: any) => ({ ...u, roles: u.roles || [u.role || 'agent'] }))))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchUsers(); }, []);

  const filtered = useMemo(() => {
    let result = users;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(u => u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }
    if (roleFilter !== 'all') result = result.filter(u => u.roles.includes(roleFilter));
    if (statusFilter !== 'all') result = result.filter(u => statusFilter === 'active' ? u.is_active : !u.is_active);
    // Sort
    result = [...result].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'full_name') cmp = a.full_name.localeCompare(b.full_name);
      else if (sortField === 'created_at') cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      else if (sortField === 'orders_processed') cmp = a.orders_processed - b.orders_processed;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [users, search, roleFilter, statusFilter, sortField, sortDir]);

  const toggleFormRole = (role: string) => {
    setFormRoles(prev => {
      const next = new Set(prev);
      next.has(role) && next.size > 1 ? next.delete(role) : next.add(role);
      return next;
    });
  };

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formEmail.trim() || !formPassword.trim()) {
      toast({ title: t('common.error'), description: t('usersPage.allFieldsRequired'), variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api/users/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token || ''}`,
          'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ full_name: formName, email: formEmail, password: formPassword, roles: Array.from(formRoles) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      toast({ title: t('usersPage.userCreated') });
      setShowModal(false);
      setFormName(''); setFormEmail(''); setFormPassword(''); setFormRoles(new Set(['agent']));
      fetchUsers();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setCreating(false); }
  };

  const handleToggle = async (userId: string) => {
    try { await apiToggleUserActive(userId); fetchUsers(); } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleToggleRole = async (userId: string, role: string, currentRoles: string[]) => {
    const hasRole = currentRoles.includes(role);
    const newRoles = hasRole ? currentRoles.filter(r => r !== role) : [...currentRoles, role];
    if (newRoles.length === 0) { toast({ title: t('common.error'), description: t('usersPage.mustHaveRole'), variant: 'destructive' }); return; }
    try { await apiSetUserRoles(userId, newRoles); toast({ title: t('usersPage.rolesUpdated') }); fetchUsers(); } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try { await apiDeleteUser(deleteTarget.user_id); toast({ title: t('usersPage.userDeleted') }); setDeleteTarget(null); fetchUsers(); } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setDeleting(false); }
  };

  const isSelf = (userId: string) => currentUser?.id === userId;

  // Role stats
  const roleStats = useMemo(() => {
    const stats: Record<string, number> = {};
    ALL_ROLES.forEach(r => { stats[r] = 0; });
    users.forEach(u => u.roles.forEach(r => { stats[r] = (stats[r] || 0) + 1; }));
    return stats;
  }, [users]);

  return (
    <div className="space-y-4">
      {/* Header with role summary */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('settings.tabUsersRoles')}</h2>
          <p className="text-sm text-muted-foreground">{t('settings.usersSummary', { total: users.length, active: users.filter(u => u.is_active).length })}</p>
        </div>
        <button onClick={() => setShowModal(true)} className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
          <UserPlus className="h-4 w-4" /> {t('usersPage.addUser')}
        </button>
      </div>

      {/* Role summary chips */}
      <div className="flex flex-wrap gap-2">
        {ALL_ROLES.map(role => {
          const meta = ROLE_META[role];
          const Icon = meta.icon;
          const isActive = roleFilter === role;
          return (
            <button
              key={role}
              onClick={() => setRoleFilter(isActive ? 'all' : role)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                isActive ? 'bg-primary text-primary-foreground border-primary' : `${meta.color} hover:opacity-80`
              }`}
            >
              <Icon className="h-3 w-3" />
              {t(meta.labelKey)}
              <span className="ml-1 font-bold">{roleStats[role]}</span>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t('settings.searchNameEmail')} className="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-9 rounded-lg border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
          <option value="all">{t('settings.allStatus')}</option>
          <option value="active">{t('usersPage.active')}</option>
          <option value="inactive">{t('usersPage.suspended')}</option>
        </select>
        {(search || roleFilter !== 'all' || statusFilter !== 'all') && (
          <button onClick={() => { setSearch(''); setRoleFilter('all'); setStatusFilter('all'); }} className="h-9 px-3 rounded-lg border text-xs font-medium text-muted-foreground hover:bg-muted transition-colors">
            {t('settings.clearFilters')}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title={t('settings.noUsersFound')}
            description={t('settings.noUsersDesc')}
            size="sm"
            className="border-0 bg-transparent py-4"
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  <button onClick={() => toggleSort('full_name')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                    {t('usersPage.colUser')} <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('usersPage.colRoles')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('settings.colStatus')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  <button onClick={() => toggleSort('orders_processed')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                    {t('usersPage.colOrders')} <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('usersPage.colLeads')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  <button onClick={() => toggleSort('created_at')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                    {t('settings.colJoined')} <ArrowUpDown className="h-3 w-3" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('settings.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <tr key={u.user_id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${u.is_active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                        {u.full_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium truncate">{u.full_name} {isSelf(u.user_id) && <span className="text-xs text-muted-foreground">{t('settings.you')}</span>}</p>
                        <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {isSelf(u.user_id) ? (
                        u.roles.map(r => {
                          const meta = ROLE_META[r] || ROLE_META.agent;
                          const Icon = meta.icon;
                          return (
                            <span key={r} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.color}`}>
                              <Icon className="h-3 w-3" /> {t(meta.labelKey)}
                            </span>
                          );
                        })
                      ) : (
                        ALL_ROLES.map(role => {
                          const hasRole = u.roles.includes(role);
                          const meta = ROLE_META[role];
                          const Icon = meta.icon;
                          return (
                            <Tooltip key={role}>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => handleToggleRole(u.user_id, role, u.roles)}
                                  className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-all ${
                                    hasRole ? meta.color : 'border-transparent text-muted-foreground/30 hover:border-border hover:text-muted-foreground/60'
                                  }`}
                                >
                                  <Icon className="h-2.5 w-2.5" />
                                  {hasRole ? t(meta.labelKey) : ''}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-medium">{hasRole ? t('usersPage.removeRole', { role: t(meta.labelKey) }) : t('usersPage.addRole', { role: t(meta.labelKey) })}</p>
                                <p className="text-xs text-muted-foreground">{t(meta.descKey)}</p>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => !isSelf(u.user_id) && handleToggle(u.user_id)}
                      disabled={isSelf(u.user_id)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                        isSelf(u.user_id) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-80'
                      } ${u.is_active ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}
                    >
                      {u.is_active ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                      {u.is_active ? t('usersPage.active') : t('usersPage.suspended')}
                    </button>
                  </td>
                  <td className="px-4 py-3 font-semibold tabular-nums">{u.orders_processed}</td>
                  <td className="px-4 py-3 font-semibold tabular-nums">{u.leads_processed}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    {!isSelf(u.user_id) && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button onClick={() => setDeleteTarget(u)} className="flex h-7 w-7 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10 transition-colors">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('usersPage.deleteUserTitle')}</TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create User Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold flex items-center gap-2"><UserPlus className="h-5 w-5 text-primary" /> {t('usersPage.createNewUser')}</h2>
            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('usersPage.fullName')}</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input value={formName} onChange={e => setFormName(e.target.value)} placeholder={t('settings.namePh')} className="w-full rounded-lg border bg-background pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('usersPage.email')}</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input value={formEmail} onChange={e => setFormEmail(e.target.value)} placeholder={t('settings.emailPh')} type="email" className="w-full rounded-lg border bg-background pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('settings.rolesLabel')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {ALL_ROLES.map(role => {
                    const isSelected = formRoles.has(role);
                    const meta = ROLE_META[role];
                    const Icon = meta.icon;
                    return (
                      <button key={role} type="button" onClick={() => toggleFormRole(role)}
                        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all border ${
                          isSelected ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'border-border text-muted-foreground hover:bg-muted'
                        }`}>
                        <Icon className="h-4 w-4" />
                        <div className="text-left">
                          <p className="text-sm font-medium">{t(meta.labelKey)}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">{t('usersPage.password')}</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input value={formPassword} onChange={e => setFormPassword(e.target.value)} placeholder={t('settings.passwordPh')} type="password" className="w-full rounded-lg border bg-background pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button onClick={() => setShowModal(false)} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">{t('common.cancel')}</button>
              <button onClick={handleCreate} disabled={creating} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t('usersPage.createUser')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('usersPage.deleteUser')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.deleteUserPre')} <strong>{deleteTarget?.full_name}</strong> ({deleteTarget?.email})? {t('settings.deleteUserPost')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? t('usersPage.deleting') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ════════════════════════════════════════════════════
// TAB 2: System Rules
// ════════════════════════════════════════════════════
function SystemRulesTab() {
  const { t } = useTranslation();
  const [autoAssign, setAutoAssign] = useState(false);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderHours, setReminderHours] = useState([24]);
  const [notifyOnStatusChange, setNotifyOnStatusChange] = useState(true);
  const [notifyOnNewOrder, setNotifyOnNewOrder] = useState(true);
  const [expandedSection, setExpandedSection] = useState<string | null>('statuses');

  const { user } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const { toast } = useToast();

  // Personal List capacity (operator-tunable global cap)
  const [maxHolds, setMaxHolds] = useState<string>('');
  const [maxHoldsSaved, setMaxHoldsSaved] = useState<number | null>(null);
  const [savingMaxHolds, setSavingMaxHolds] = useState(false);

  // Unpaid-delivery chase window — how long a shipped-but-unpaid order waits
  // before the owning agent is reminded to call, and when to stop reminding.
  // Read by the nightly notify_unpaid_shipped_orders() job.
  const [chaseDays, setChaseDays] = useState<string>('');
  const [chaseStop, setChaseStop] = useState<string>('');
  const [chaseSaved, setChaseSaved] = useState<{ days: number; stop: number } | null>(null);
  const [savingChase, setSavingChase] = useState(false);

  // Manual CPA push button on /orders (admin/manager). Persisted in
  // app_settings — the push route re-reads it on every call, so switching it
  // off here kills the feature within one request. Saves on toggle.
  const [cpaPushEnabled, setCpaPushEnabled] = useState(false);
  const [savingCpaPush, setSavingCpaPush] = useState(false);

  useEffect(() => {
    apiGetAppSettings()
      .then((s) => {
        setMaxHolds(String(s.personal_list_max_holds)); setMaxHoldsSaved(s.personal_list_max_holds);
        setChaseDays(String(s.unpaid_chase_days)); setChaseStop(String(s.unpaid_chase_stop_days));
        setChaseSaved({ days: Number(s.unpaid_chase_days), stop: Number(s.unpaid_chase_stop_days) });
        setCpaPushEnabled(s.altercpa_push_enabled === true);
      })
      .catch(() => {});
  }, []);

  const saveCpaPush = async (enabled: boolean) => {
    setSavingCpaPush(true);
    setCpaPushEnabled(enabled); // optimistic — reverted on failure
    try {
      await apiUpdateAppSettings({ altercpa_push_enabled: enabled });
      toast({ title: enabled ? t('settings.cpaPushEnabledToast') : t('settings.cpaPushDisabledToast') });
    } catch (err: any) {
      setCpaPushEnabled(!enabled);
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' as any });
    } finally {
      setSavingCpaPush(false);
    }
  };

  const saveChase = async () => {
    const d = Math.floor(Number(chaseDays));
    const s = Math.floor(Number(chaseStop));
    if (!Number.isFinite(d) || d < 1 || d > 30 || !Number.isFinite(s) || s < d || s > 999) {
      toast({ title: t('common.error'), description: t('settings.unpaidChaseRange'), variant: 'destructive' as any });
      return;
    }
    setSavingChase(true);
    try {
      await apiUpdateAppSettings({ unpaid_chase_days: d, unpaid_chase_stop_days: s });
      setChaseSaved({ days: d, stop: s });
      toast({ title: t('settings.unpaidChaseSaved', { days: d, stop: s }) });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' as any });
    } finally {
      setSavingChase(false);
    }
  };
  const saveMaxHolds = async () => {
    const n = Math.floor(Number(maxHolds));
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      toast({ title: t('common.error'), description: t('settings.personalListCapRange'), variant: 'destructive' as any });
      return;
    }
    setSavingMaxHolds(true);
    try {
      await apiUpdateAppSettings({ personal_list_max_holds: n });
      setMaxHoldsSaved(n);
      toast({ title: t('settings.personalListCapSaved', { count: n }) });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' as any });
    } finally {
      setSavingMaxHolds(false);
    }
  };

  const toggleSection = (s: string) => setExpandedSection(prev => prev === s ? null : s);

  // === Dev test helpers for the new personalized notification UI ===
  // These insert directly for *your* user so you can immediately see the
  // happy (paid), sad pink (refund), urgent red (missed call), etc. toasts + list items.
  const sendTestNotification = async (type: string, title: string, message?: string, link?: string | null) => {
    if (!user?.id) {
      toast({ title: 'Not signed in', variant: 'destructive' as any });
      return;
    }
    try {
      const { error } = await supabase.from('notifications').insert({
        user_id: user.id,
        type,
        title,
        message: message || null,
        link: link || null,
        is_read: false,
      });
      if (error) throw error;
      toast({ title: 'Test notification inserted', description: `${type} — ${title}` });
    } catch (err: any) {
      toast({ title: 'Insert failed', description: err?.message || String(err), variant: 'destructive' as any });
    }
  };

  const sendAllTestNotifications = async () => {
    const tests = [
      ['order_paid', 'Order #TEST-88421 has been paid', '2× items, total 11.530 ден. Customer paid in full.', '/orders'],
      ['order_returned', 'Order #TEST-39102 returned by customer', 'Reason: changed mind. Will be restocked.', '/orders'],
      ['missed_call', 'Missed call from +38970765432', 'Called at 15:47. No answer after 4 rings.', '/missed-calls'],
      ['low_stock', 'Low stock alert: Product XYZ-500ml', 'Only 4 units remaining (threshold: 10).', '/products'],
      ['info', 'New feature: Missed calls page now has voicemail playback', 'Check the Calls tab for details.', '/calls'],
    ];
    for (const [type, title, msg, link] of tests) {
      await sendTestNotification(type as string, title as string, msg as string, link as string);
      await new Promise(r => setTimeout(r, 180)); // small stagger so toasts don't all pile at once
    }
  };

  const markAllMyNotificationsRead = async () => {
    if (!user?.id) return;
    try {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', user.id)
        .eq('is_read', false);
      toast({ title: 'All your notifications marked as read' });
    } catch (err: any) {
      toast({ title: 'Failed to mark read', description: apiErrorText(err), variant: 'destructive' as any });
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.sysRules')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.sysRulesDesc')}</p>
      </div>

      {/* Order Status Flow */}
      <CollapsibleCard title={t('settings.orderFlow')} subtitle={t('settings.orderFlowSub', { count: ORDER_STATUSES.length })} expanded={expandedSection === 'statuses'} onToggle={() => toggleSection('statuses')}>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground mb-3">{t('settings.orderFlowDesc')}</p>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {ORDER_STATUSES.map((s, i) => (
              <div key={s.key} className="flex items-center gap-1">
                <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium">
                  <div className={`h-2.5 w-2.5 rounded-full ${s.color}`} />
                  {t(s.labelKey)}
                </span>
                {i < ORDER_STATUSES.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {ORDER_STATUSES.map((s, i) => (
              <div key={s.key} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 hover:bg-muted/30 transition-colors">
                <span className="text-xs text-muted-foreground font-mono w-6">#{i + 1}</span>
                <div className={`h-3 w-3 rounded-full shrink-0 ${s.color}`} />
                <span className="text-sm font-medium flex-1">{t(s.labelKey)}</span>
                <Badge variant="outline" className="text-[10px] font-mono">{s.key}</Badge>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleCard>

      {/* Lead Statuses */}
      <CollapsibleCard title={t('settings.leadFlow')} subtitle={t('settings.leadFlowSub', { count: LEAD_STATUSES.length })} expanded={expandedSection === 'leads'} onToggle={() => toggleSection('leads')}>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5 mb-4">
            {LEAD_STATUSES.map((s, i) => (
              <div key={s.key} className="flex items-center gap-1">
                <span className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs font-medium">
                  <div className={`h-2.5 w-2.5 rounded-full ${s.color}`} />
                  {t(s.labelKey)}
                </span>
                {i < LEAD_STATUSES.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/50" />}
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            {LEAD_STATUSES.map((s, i) => (
              <div key={s.key} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 hover:bg-muted/30 transition-colors">
                <div className={`h-3 w-3 rounded-full ${s.color}`} />
                <span className="text-sm font-medium flex-1">{t(s.labelKey)}</span>
                <Badge variant="outline" className="text-[10px] font-mono">{s.key}</Badge>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleCard>

      {/* Role Permissions */}
      <CollapsibleCard title={t('settings.rolePermsTitle')} subtitle={t('settings.rolesConfigured', { count: ALL_ROLES.length })} expanded={expandedSection === 'permissions'} onToggle={() => toggleSection('permissions')}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground mb-2">{t('settings.rolePermsDesc2')}</p>
          {ALL_ROLES.map(role => {
            const meta = ROLE_META[role];
            const Icon = meta.icon;
            return (
              <div key={role} className={`flex items-start gap-3 rounded-lg border p-3 ${meta.color}`}>
                <Icon className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold">{t(meta.labelKey)}</p>
                  <p className="text-xs opacity-80">{t(meta.descKey)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleCard>

      {/* Automation */}
      <CollapsibleCard title={t('settings.automation')} subtitle={t('settings.automationSub')} expanded={expandedSection === 'automation'} onToggle={() => toggleSection('automation')}>
        <div className="space-y-5">
          <SettingRow label={t('settings.autoAssign')} description={t('settings.autoAssignDesc')}>
            <Switch checked={autoAssign} onCheckedChange={setAutoAssign} />
          </SettingRow>
          <SettingRow label={t('settings.followup')} description={t('settings.followupDesc', { hours: reminderHours[0] })}>
            <Switch checked={reminderEnabled} onCheckedChange={setReminderEnabled} />
          </SettingRow>
          {reminderEnabled && (
            <div className="pl-4 border-l-2 border-primary/20">
              <label className="text-xs font-medium text-muted-foreground mb-2 block">{t('settings.reminderDelay')}</label>
              <Slider value={reminderHours} onValueChange={setReminderHours} min={1} max={72} step={1} className="w-48" />
              <p className="text-xs text-muted-foreground mt-1">{t('settings.hoursShort', { h: reminderHours[0] })}</p>
            </div>
          )}
        </div>
      </CollapsibleCard>

      {/* Personal List capacity */}
      <CollapsibleCard title={t('settings.personalListCap')} subtitle={t('settings.personalListCapSub')} expanded={expandedSection === 'personalList'} onToggle={() => toggleSection('personalList')}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('settings.personalListCapDesc')}</p>
          <div className="flex items-end gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('settings.personalListCapLabel')}</label>
              <Input
                type="number"
                min={1}
                max={1000}
                value={maxHolds}
                disabled={!isAdmin}
                onChange={(e) => setMaxHolds(e.target.value)}
                className="w-28"
              />
            </div>
            {isAdmin && (
              <button
                onClick={saveMaxHolds}
                disabled={savingMaxHolds || maxHolds === '' || Number(maxHolds) === maxHoldsSaved}
                className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingMaxHolds && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.save')}
              </button>
            )}
          </div>
          {!isAdmin && <p className="text-[11px] text-muted-foreground/70">{t('settings.personalListCapAdminOnly')}</p>}
        </div>
      </CollapsibleCard>

      {/* Unpaid delivery chase */}
      <CollapsibleCard title={t('settings.unpaidChase')} subtitle={t('settings.unpaidChaseSub')} expanded={expandedSection === 'unpaidChase'} onToggle={() => toggleSection('unpaidChase')}>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('settings.unpaidChaseDesc')}</p>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('settings.unpaidChaseDaysLabel')}</label>
              <Input
                type="number"
                min={1}
                max={30}
                value={chaseDays}
                disabled={!isAdmin}
                onChange={(e) => setChaseDays(e.target.value)}
                className="w-28"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t('settings.unpaidChaseStopLabel')}</label>
              <Input
                type="number"
                min={1}
                max={999}
                value={chaseStop}
                disabled={!isAdmin}
                onChange={(e) => setChaseStop(e.target.value)}
                className="w-28"
              />
            </div>
            {isAdmin && (
              <button
                onClick={saveChase}
                disabled={
                  savingChase || chaseDays === '' || chaseStop === '' ||
                  (Number(chaseDays) === chaseSaved?.days && Number(chaseStop) === chaseSaved?.stop)
                }
                className="flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingChase && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.save')}
              </button>
            )}
          </div>
          {!isAdmin && <p className="text-[11px] text-muted-foreground/70">{t('settings.personalListCapAdminOnly')}</p>}
        </div>
      </CollapsibleCard>

      {/* Manual CPA push (AlterCPA write-back button on /orders) */}
      <CollapsibleCard title={t('settings.cpaPush')} subtitle={t('settings.cpaPushSub')} expanded={expandedSection === 'cpaPush'} onToggle={() => toggleSection('cpaPush')}>
        <div className="space-y-3">
          <SettingRow label={t('altercpa.pushToggleLabel')} description={t('altercpa.pushToggleHint')}>
            <Switch checked={cpaPushEnabled} disabled={!isAdmin || savingCpaPush} onCheckedChange={saveCpaPush} />
          </SettingRow>
          {!isAdmin && <p className="text-[11px] text-muted-foreground/70">{t('settings.personalListCapAdminOnly')}</p>}
        </div>
      </CollapsibleCard>

      {/* Notifications */}
      <CollapsibleCard title={t('settings.notifications')} subtitle={t('settings.notificationsSub')} expanded={expandedSection === 'notifications'} onToggle={() => toggleSection('notifications')}>
        <div className="space-y-4">
          <SettingRow label={t('settings.notifyStatus')} description={t('settings.notifyStatusDesc')}>
            <Switch checked={notifyOnStatusChange} onCheckedChange={setNotifyOnStatusChange} />
          </SettingRow>
          <SettingRow label={t('settings.notifyNewOrder')} description={t('settings.notifyNewOrderDesc')}>
            <Switch checked={notifyOnNewOrder} onCheckedChange={setNotifyOnNewOrder} />
          </SettingRow>

          {/* === DEV TEST PANEL: use this to instantly test the new personalized notifications === */}
          {import.meta.env.DEV && (
          <div className="pt-3 mt-2 border-t border-border">
            <div className="flex items-center gap-2 mb-1.5">
              <Bell className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dev Test Notifications</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">UI testing only</span>
            </div>
            <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
              Inserts real rows for <b>your</b> account. You should immediately see the bottom-right toast (with raining $ for paid, drifting 💸 for returns) + the item in the bell dropdown with the correct happy (emerald), sad pink, or urgent red styling.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              <button
                onClick={() => sendTestNotification('order_paid', 'Order #TEST-88421 has been paid', '2× items, total 11.530 ден. Customer paid in full via cash on delivery.', '/orders')}
                className="text-xs px-2.5 py-1 rounded-md border border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 transition-colors"
              >
                🎉 Test Order Paid (happy + $ rain)
              </button>
              <button
                onClick={() => sendTestNotification('order_returned', 'Order #TEST-39102 was returned', 'Customer returned 1 item. Reason: changed mind. Stock adjustment needed.', '/orders')}
                className="text-xs px-2.5 py-1 rounded-md border border-pink-500/40 hover:bg-pink-500/10 text-pink-600 dark:text-pink-400 transition-colors"
              >
                💔 Test Order Return / Refund (pink sad)
              </button>
              <button
                onClick={() => sendTestNotification('missed_call', 'Missed call from +389 70 765 432', 'Rang 5 times at 15:47. No voicemail recorded.', '/missed-calls')}
                className="text-xs px-2.5 py-1 rounded-md border border-rose-500/40 hover:bg-rose-500/10 text-rose-600 dark:text-rose-400 transition-colors"
              >
                📞 Test Missed Call (urgent)
              </button>
              <button
                onClick={() => sendTestNotification('low_stock', 'Low stock: Super Shampoo 500ml', 'Current stock 3 / threshold 10. Reorder recommended.', '/products')}
                className="text-xs px-2.5 py-1 rounded-md border border-amber-500/40 hover:bg-amber-500/10 text-amber-600 dark:text-amber-400 transition-colors"
              >
                ⚠️ Test Low Stock
              </button>
              <button
                onClick={() => sendTestNotification('info', 'New: Voicemail playback in Missed Calls', 'You can now listen to recordings directly in the CRM.', '/calls')}
                className="text-xs px-2.5 py-1 rounded-md border hover:bg-muted text-foreground transition-colors"
              >
                ℹ️ Test Info
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={sendAllTestNotifications}
                className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
              >
                Send ONE OF EVERYTHING (staggered)
              </button>
              <button
                onClick={markAllMyNotificationsRead}
                className="text-xs px-2.5 py-1 rounded-md border hover:bg-muted transition-colors"
              >
                Mark all my notifications as read
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1.5">Tip: Open the bell in the top bar (or stay on this page) to watch the toasts + dropdown update live.</p>
          </div>
          )}
        </div>
      </CollapsibleCard>
    </div>
  );
}

// ════════════════════════════════════════════════════
// TAB 3: Warehouse Configuration
// ════════════════════════════════════════════════════
function WarehouseTab() {
  const { t } = useTranslation();
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lowStockAlerts, setLowStockAlerts] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    apiGetProducts().then(setProducts).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleThresholdChange = async (productId: string, value: number[]) => {
    const product = products.find(p => p.id === productId);
    if (!product) return;
    setProducts(prev => prev.map(p => p.id === productId ? { ...p, low_stock_threshold: value[0] } : p));
    try {
      await apiUpdateProduct(productId, { low_stock_threshold: value[0] });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.whConfig')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.whConfigDesc')}</p>
      </div>

      {/* Global Settings */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /> {t('settings.alertSettings')}</h3>
        <SettingRow label={t('settings.lowStockAlerts')} description={t('settings.lowStockAlertsDesc')}>
          <Switch checked={lowStockAlerts} onCheckedChange={setLowStockAlerts} />
        </SettingRow>
      </div>

      {/* Products & Thresholds */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/50">
          <h3 className="text-sm font-semibold">{t('settings.productThresholds')}</h3>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : products.length === 0 ? (
          <EmptyState
            icon={<Package className="h-6 w-6" />}
            title={t('settings.noProducts')}
            description={t('settings.noProductsDesc')}
            size="sm"
            className="border-0 bg-transparent py-4"
          />
        ) : (
          <div className="divide-y">
            {products.map(p => {
              const stockPercent = p.low_stock_threshold > 0 ? (p.stock_quantity / (p.low_stock_threshold * 3)) * 100 : 100;
              const isLow = p.stock_quantity <= p.low_stock_threshold;
              return (
                <div key={p.id} className="px-5 py-4 hover:bg-muted/20 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                        <Package className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.sku || t('settings.noSku')}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-semibold tabular-nums ${isLow ? 'text-destructive' : 'text-foreground'}`}>
                        {t('settings.unitsCount', { count: p.stock_quantity })}
                        {isLow && <AlertTriangle className="inline h-3.5 w-3.5 ml-1 text-destructive" />}
                      </p>
                      <p className="text-xs text-muted-foreground">{t('settings.thresholdLabel', { value: p.low_stock_threshold })}</p>
                    </div>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden mb-3">
                    <div className={`h-full rounded-full transition-all ${isLow ? 'bg-destructive' : stockPercent < 50 ? 'bg-warning' : 'bg-success'}`} style={{ width: `${Math.min(stockPercent, 100)}%` }} />
                  </div>
                  <div className="flex items-center gap-4">
                    <label className="text-xs text-muted-foreground shrink-0">{t('settings.lowStockAt')}</label>
                    <Slider value={[p.low_stock_threshold]} onValueChange={(v) => handleThresholdChange(p.id, v)} min={1} max={500} step={5} className="flex-1" />
                    <span className="text-xs font-medium tabular-nums w-12 text-right">{p.low_stock_threshold}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Same setLanguage as the top-bar switcher — persists to localStorage + profiles.language.
function LanguageCard() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
      <h3 className="text-sm font-semibold flex items-center gap-2"><Languages className="h-4 w-4 text-primary" /> {t('common.language')}</h3>
      <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
      <div className="flex gap-3">
        {SUPPORTED_LANGUAGES.map(lang => (
          <button
            key={lang}
            onClick={() => setLanguage(lang)}
            className={`flex-1 rounded-xl border-2 p-3 text-sm font-medium transition-all ${
              language === lang ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/30'
            }`}
          >
            <span className="flex items-center justify-center gap-2">
              <FlagIcon lang={lang} className="h-3.5 w-7" /> {t(`languages.${lang}`)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════
// TAB 4: Appearance
// ════════════════════════════════════════════════════
function AppearanceTab() {
  const { t } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [showOrderCards, setShowOrderCards] = useState(true);
  const [showLeadCards, setShowLeadCards] = useState(true);
  const [showWarehouseCards, setShowWarehouseCards] = useState(true);
  const [showTeamCards, setShowTeamCards] = useState(true);
  const [showActivityFeed, setShowActivityFeed] = useState(true);

  // Theme is managed app-wide by next-themes (persisted per-device under localStorage
  // "theme"); this tab and the nav-bar ThemeToggle share that single source of truth.
  // Mounted guard avoids a wrong-state flash before the client theme resolves.
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.appearance')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.appearanceDesc')}</p>
      </div>

      {/* Theme */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Palette className="h-4 w-4 text-primary" /> {t('settings.theme')}</h3>
        <div className="flex gap-3">
          <button
            onClick={() => setTheme('light')}
            className={`flex-1 flex flex-col items-center gap-3 rounded-xl border-2 p-4 transition-all ${
              !isDark ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/30'
            }`}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Sun className="h-6 w-6 text-warning" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{t('settings.light')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.lightDesc')}</p>
            </div>
          </button>
          <button
            onClick={() => setTheme('dark')}
            className={`flex-1 flex flex-col items-center gap-3 rounded-xl border-2 p-4 transition-all ${
              isDark ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-muted-foreground/30'
            }`}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Moon className="h-6 w-6 text-info" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{t('settings.dark')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.darkDesc')}</p>
            </div>
          </button>
        </div>
      </div>

      {/* Language */}
      <LanguageCard />

      {/* Dashboard Widgets */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Eye className="h-4 w-4 text-primary" /> {t('settings.widgets')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.widgetsDesc')}</p>
        <div className="space-y-3">
          <SettingRow label={t('settings.wOrder')} description={t('settings.wOrderDesc')}>
            <Switch checked={showOrderCards} onCheckedChange={setShowOrderCards} />
          </SettingRow>
          <SettingRow label={t('settings.wLead')} description={t('settings.wLeadDesc')}>
            <Switch checked={showLeadCards} onCheckedChange={setShowLeadCards} />
          </SettingRow>
          <SettingRow label={t('settings.wWarehouse')} description={t('settings.wWarehouseDesc')}>
            <Switch checked={showWarehouseCards} onCheckedChange={setShowWarehouseCards} />
          </SettingRow>
          <SettingRow label={t('settings.wTeam')} description={t('settings.wTeamDesc')}>
            <Switch checked={showTeamCards} onCheckedChange={setShowTeamCards} />
          </SettingRow>
          <SettingRow label={t('settings.wActivity')} description={t('settings.wActivityDesc')}>
            <Switch checked={showActivityFeed} onCheckedChange={setShowActivityFeed} />
          </SettingRow>
        </div>
      </div>

      {/* Layout */}
      <div className="rounded-xl border bg-card p-5 shadow-sm space-y-5">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Settings2 className="h-4 w-4 text-primary" /> {t('settings.layout')}</h3>
        <SettingRow label={t('settings.compactMode')} description={t('settings.compactModeDesc')}>
          <Switch checked={compactMode} onCheckedChange={setCompactMode} />
        </SettingRow>
      </div>
    </div>
  );
}


// ════════════════════════════════════════════════════
// TAB: Module Manager (Admin only)
// ════════════════════════════════════════════════════
const PROTECTED_MODULES = ['dashboard', 'users', 'settings'];

function ModuleManagerTab() {
  const { t } = useTranslation();
  const { modules, refresh } = usePermissions();
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();

  const handleToggle = async (moduleKey: string, currentEnabled: boolean) => {
    if (PROTECTED_MODULES.includes(moduleKey)) {
      toast({ title: t('settings.protectedModule'), description: t('settings.protectedModuleDesc'), variant: 'destructive' });
      return;
    }
    setSaving(moduleKey);
    try {
      const { error } = await supabase
        .from('module_settings')
        .update({ is_enabled: !currentEnabled, updated_at: new Date().toISOString() } as any)
        .eq('module_key', moduleKey);
      if (error) throw error;
      await refresh();
      toast({ title: !currentEnabled ? t('settings.moduleEnabled') : t('settings.moduleDisabled') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><Blocks className="h-5 w-5 text-primary" /> {t('settings.moduleManager')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.moduleManagerDesc')}</p>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('settings.colModule')}</th>
              <th className="px-4 py-3 text-center font-medium text-muted-foreground">{t('settings.colStatus')}</th>
              <th className="px-4 py-3 text-center font-medium text-muted-foreground">{t('settings.colProtected')}</th>
            </tr>
          </thead>
          <tbody>
            {modules.map(mod => {
              const isProtected = PROTECTED_MODULES.includes(mod.module_key);
              return (
                <tr key={mod.module_key} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{mod.module_label}</span>
                      <Badge variant="outline" className="text-[10px] font-mono">{mod.module_key}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex justify-center">
                      {saving === mod.module_key ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <Switch
                          checked={mod.is_enabled}
                          onCheckedChange={() => handleToggle(mod.module_key, mod.is_enabled)}
                          disabled={isProtected}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {isProtected && (
                      <Tooltip>
                        <TooltipTrigger>
                          <LockKeyhole className="h-4 w-4 text-warning mx-auto" />
                        </TooltipTrigger>
                        <TooltipContent>{t('settings.protectedTooltip')}</TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════
// TAB: Role Permissions (Admin only)
// ════════════════════════════════════════════════════
const PERMISSION_ROLES = ['admin', 'manager', 'agent', 'inbound_agent', 'pending_agent', 'prediction_agent', 'warehouse', 'ads_admin'] as const;
const ACTIONS = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_export'] as const;
const ACTION_LABELS: Record<string, string> = {
  can_view: 'settings.actView', can_create: 'settings.actCreate', can_edit: 'settings.actEdit', can_delete: 'settings.actDelete', can_export: 'settings.actExport',
};

function RolePermissionsTab() {
  const { t } = useTranslation();
  const { modules, rolePermissions, refresh } = usePermissions();
  const [selectedRole, setSelectedRole] = useState<string>('agent');
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();

  const permsForRole = useMemo(() => {
    return rolePermissions.filter(p => p.role === selectedRole);
  }, [rolePermissions, selectedRole]);

  const getPermValue = (moduleKey: string, action: string): boolean => {
    const perm = permsForRole.find(p => p.module_key === moduleKey);
    return perm ? (perm as any)[action] : false;
  };

  const handleToggle = async (moduleKey: string, action: string, currentValue: boolean) => {
    // Don't allow editing admin permissions
    if (selectedRole === 'admin') {
      toast({ title: t('settings.info'), description: t('settings.adminPermsInfo') });
      return;
    }
    setSaving(`${moduleKey}-${action}`);
    try {
      // Upsert (not update) so a role×module that was never seeded still toggles —
      // this is what lets the admin control EVERY tab/module per role, not just
      // the pre-seeded ones.
      const { error } = await supabase
        .from('role_permissions')
        .upsert({ role: selectedRole, module_key: moduleKey, [action]: !currentValue, updated_at: new Date().toISOString() } as any, { onConflict: 'role,module_key' });
      if (error) throw error;
      await refresh();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  const handleBulkToggleModule = async (moduleKey: string, enable: boolean) => {
    if (selectedRole === 'admin') return;
    setSaving(moduleKey);
    try {
      const update: any = { role: selectedRole, module_key: moduleKey, updated_at: new Date().toISOString() };
      ACTIONS.forEach(a => { update[a] = enable; });
      const { error } = await supabase
        .from('role_permissions')
        .upsert(update, { onConflict: 'role,module_key' });
      if (error) throw error;
      await refresh();
      toast({ title: t(enable ? 'settings.enabledAllFor' : 'settings.disabledAllFor', { module: moduleKey }) });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /> {t('settings.rolePermsTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.rolePermsDesc')}</p>
      </div>

      {/* Role selector */}
      <div className="flex flex-wrap gap-2">
        {PERMISSION_ROLES.map(role => {
          const meta = ROLE_META[role];
          const Icon = meta?.icon || Shield;
          return (
            <button
              key={role}
              onClick={() => setSelectedRole(role)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                selectedRole === role ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {meta ? t(meta.labelKey) : role}
            </button>
          );
        })}
      </div>

      {selectedRole === 'admin' && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning flex items-center gap-2">
          <LockKeyhole className="h-4 w-4 shrink-0" />
          {t('settings.adminFullAccessWarning')}
        </div>
      )}

      {/* Permissions grid */}
      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground min-w-[180px]">{t('settings.colModule')}</th>
              {ACTIONS.map(a => (
                <th key={a} className="px-3 py-3 text-center font-medium text-muted-foreground text-xs">{t(ACTION_LABELS[a])}</th>
              ))}
              <th className="px-3 py-3 text-center font-medium text-muted-foreground text-xs">{t('settings.colAll')}</th>
            </tr>
          </thead>
          <tbody>
            {modules.map(mod => {
              const allEnabled = ACTIONS.every(a => getPermValue(mod.module_key, a));
              return (
                <tr key={mod.module_key} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-sm">{mod.module_label}</td>
                  {ACTIONS.map(action => {
                    const val = getPermValue(mod.module_key, action);
                    const key = `${mod.module_key}-${action}`;
                    return (
                      <td key={action} className="px-3 py-2.5 text-center">
                        {saving === key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary mx-auto" />
                        ) : (
                          <button
                            onClick={() => handleToggle(mod.module_key, action, val)}
                            disabled={selectedRole === 'admin'}
                            className={`mx-auto flex h-6 w-6 items-center justify-center rounded-md transition-all ${
                              val
                                ? 'bg-success/15 text-success hover:bg-success/25'
                                : 'bg-muted text-muted-foreground/40 hover:bg-muted/80'
                            } ${selectedRole === 'admin' ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {val ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-center">
                    {saving === mod.module_key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary mx-auto" />
                    ) : (
                      <button
                        onClick={() => handleBulkToggleModule(mod.module_key, !allEnabled)}
                        disabled={selectedRole === 'admin'}
                        className={`mx-auto flex h-6 w-6 items-center justify-center rounded-md border transition-all ${
                          allEnabled
                            ? 'border-success/30 bg-success/10 text-success hover:bg-success/20'
                            : 'border-border bg-background text-muted-foreground/40 hover:bg-muted'
                        } ${selectedRole === 'admin' ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        {allEnabled ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════
// TAB: Financial Visibility (Admin only)
// ════════════════════════════════════════════════════
const FINANCIAL_METRICS = [
  { key: 'show_profit', labelKey: 'settings.fin.profit', descKey: 'settings.finDesc.profit' },
  { key: 'show_net_contribution', labelKey: 'settings.fin.netContribution', descKey: 'settings.finDesc.netContribution' },
  { key: 'show_cost', labelKey: 'settings.fin.cost', descKey: 'settings.finDesc.cost' },
  { key: 'show_returned_value', labelKey: 'settings.fin.returnedValue', descKey: 'settings.finDesc.returnedValue' },
  { key: 'show_financial_insights', labelKey: 'settings.fin.insights', descKey: 'settings.finDesc.insights' },
] as const;

function FinancialVisibilityTab() {
  const { t } = useTranslation();
  const { financialVisibility, refresh } = usePermissions();
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();

  const getFinValue = (role: string, metric: string): boolean => {
    const vis = financialVisibility.find(v => v.role === role);
    return vis ? (vis as any)[metric] : false;
  };

  const handleToggle = async (role: string, metric: string, currentValue: boolean) => {
    if (role === 'admin') {
      toast({ title: t('settings.info'), description: t('settings.adminFinInfo') });
      return;
    }
    setSaving(`${role}-${metric}`);
    try {
      const { error } = await supabase
        .from('financial_visibility')
        .update({ [metric]: !currentValue, updated_at: new Date().toISOString() } as any)
        .eq('role', role);
      if (error) throw error;
      await refresh();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><DollarSign className="h-5 w-5 text-primary" /> {t('settings.finVisTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.finVisDesc')}</p>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground min-w-[140px]">{t('settings.colRole')}</th>
              {FINANCIAL_METRICS.map(m => (
                <th key={m.key} className="px-3 py-3 text-center font-medium text-muted-foreground text-xs">
                  <Tooltip>
                    <TooltipTrigger className="cursor-help">{t(m.labelKey)}</TooltipTrigger>
                    <TooltipContent>{t(m.descKey)}</TooltipContent>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROLES.map(role => {
              const meta = ROLE_META[role];
              const Icon = meta?.icon || Shield;
              return (
                <tr key={role} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta?.color || ''}`}>
                      <Icon className="h-3 w-3" /> {meta ? t(meta.labelKey) : role}
                    </span>
                  </td>
                  {FINANCIAL_METRICS.map(metric => {
                    const val = getFinValue(role, metric.key);
                    const key = `${role}-${metric.key}`;
                    return (
                      <td key={metric.key} className="px-3 py-2.5 text-center">
                        {saving === key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary mx-auto" />
                        ) : (
                          <button
                            onClick={() => handleToggle(role, metric.key, val)}
                            disabled={role === 'admin'}
                            className={`mx-auto flex h-6 w-6 items-center justify-center rounded-md transition-all ${
                              val
                                ? 'bg-success/15 text-success hover:bg-success/25'
                                : 'bg-muted text-muted-foreground/40 hover:bg-muted/80'
                            } ${role === 'admin' ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {val ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────── Access & Privacy (customer-identity + recordings visibility per role) ──────
const PII_FLAGS = [
  { key: 'show_customer_phone',   labelKey: 'settings.pii.phone',          descKey: 'settings.piiDesc.phone' },
  { key: 'show_customer_name',    labelKey: 'settings.pii.name',           descKey: 'settings.piiDesc.name' },
  { key: 'show_customer_address', labelKey: 'settings.pii.address',        descKey: 'settings.piiDesc.address' },
  { key: 'show_order_history',    labelKey: 'settings.pii.orderHistory',   descKey: 'settings.piiDesc.orderHistory' },
  { key: 'show_segment_members',  labelKey: 'settings.pii.segmentMembers', descKey: 'settings.piiDesc.segmentMembers' },
  { key: 'can_hear_recordings',   labelKey: 'settings.pii.hearRecordings', descKey: 'settings.piiDesc.hearRecordings' },
  { key: 'can_hear_own_recordings', labelKey: 'settings.pii.hearOwnRecordings', descKey: 'settings.piiDesc.hearOwnRecordings' },
] as const;

function PiiVisibilityTab() {
  const { t } = useTranslation();
  const { privacy, refresh } = usePermissions();
  const [saving, setSaving] = useState<string | null>(null);
  const { toast } = useToast();

  const getVal = (role: string, flag: string): boolean => {
    const p = privacy.find(v => v.role === role);
    return p ? (p as any)[flag] : false;
  };

  const handleToggle = async (role: string, flag: string, currentValue: boolean) => {
    if (role === 'admin') {
      toast({ title: t('settings.info'), description: t('settings.adminPrivacyInfo') });
      return;
    }
    setSaving(`${role}-${flag}`);
    try {
      const { error } = await supabase
        .from('role_privacy')
        .update({ [flag]: !currentValue, updated_at: new Date().toISOString() } as any)
        .eq('role', role);
      if (error) throw error;
      await refresh();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-primary" /> {t('settings.privacyTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.privacyDesc')}</p>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground min-w-[140px]">{t('settings.colRole')}</th>
              {PII_FLAGS.map(m => (
                <th key={m.key} className="px-3 py-3 text-center font-medium text-muted-foreground text-xs">
                  <Tooltip>
                    <TooltipTrigger className="cursor-help">{t(m.labelKey)}</TooltipTrigger>
                    <TooltipContent>{t(m.descKey)}</TooltipContent>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_ROLES.map(role => {
              const meta = ROLE_META[role];
              const Icon = meta?.icon || Shield;
              return (
                <tr key={role} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${meta?.color || ''}`}>
                      <Icon className="h-3 w-3" /> {meta ? t(meta.labelKey) : role}
                    </span>
                  </td>
                  {PII_FLAGS.map(flag => {
                    const val = getVal(role, flag.key);
                    const key = `${role}-${flag.key}`;
                    return (
                      <td key={flag.key} className="px-3 py-2.5 text-center">
                        {saving === key ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary mx-auto" />
                        ) : (
                          <button
                            onClick={() => handleToggle(role, flag.key, val)}
                            disabled={role === 'admin'}
                            className={`mx-auto flex h-6 w-6 items-center justify-center rounded-md transition-all ${
                              val
                                ? 'bg-success/15 text-success hover:bg-success/25'
                                : 'bg-muted text-muted-foreground/40 hover:bg-muted/80'
                            } ${role === 'admin' ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {val ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────── Courier Rates (logistics cost calibration) ──────
const COURIER_RATE_ROWS: { courier: 'econt' | 'speedy' | 'mex'; service: 'office' | 'door'; labelKey: string }[] = [
  // MEX first — it is the live Macedonian carrier. The Bulgarian rows stay so
  // historical logistics costs remain editable and keep pricing old reports.
  { courier: 'mex', service: 'door', labelKey: 'settings.courierRow.mexDoor' },
  { courier: 'mex', service: 'office', labelKey: 'settings.courierRow.mexOffice' },
  { courier: 'econt', service: 'office', labelKey: 'settings.courierRow.econtOffice' },
  { courier: 'econt', service: 'door', labelKey: 'settings.courierRow.econtDoor' },
  { courier: 'speedy', service: 'office', labelKey: 'settings.courierRow.speedyOffice' },
  { courier: 'speedy', service: 'door', labelKey: 'settings.courierRow.speedyDoor' },
];

function CourierRatesTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [rates, setRates] = useState<CourierRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGetCourierRates()
      .then(setRates)
      .catch((e: any) => toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, []);

  const getRate = (courier: string, service: string) =>
    rates.find((r) => r.courier === courier && r.service === service);

  const setField = (courier: string, service: string, field: 'deliver_cost' | 'return_cost', value: number) => {
    setRates((prev) => {
      const existing = prev.find((r) => r.courier === courier && r.service === service);
      if (existing) return prev.map((r) => (r === existing ? { ...r, [field]: value } : r));
      return [...prev, { courier: courier as any, service: service as any, deliver_cost: 0, return_cost: 0, [field]: value }];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiUpdateCourierRates(
        COURIER_RATE_ROWS.map(({ courier, service }) => {
          const r = getRate(courier, service);
          return { courier, service, deliver_cost: Number(r?.deliver_cost || 0), return_cost: Number(r?.return_cost || 0) };
        }),
      );
      toast({ title: t('settings.saved'), description: t('settings.courierRatesUpdated') });
    } catch (e: any) {
      toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><Truck className="h-5 w-5 text-primary" /> {t('settings.courierRates')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.courierIntro')}{' '}
          <strong>{t('settings.deliverWord')}</strong> {t('settings.deliverDef')}{' '}
          <strong>{t('settings.returnWord')}</strong> {t('settings.returnDef')}
          {' '}{t('settings.courierOutro')}
        </p>
      </div>

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('settings.colCourierService')}</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('settings.colDeliver')}</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('settings.colReturn')}</th>
            </tr>
          </thead>
          <tbody>
            {COURIER_RATE_ROWS.map(({ courier, service, labelKey }) => {
              const r = getRate(courier, service);
              return (
                <tr key={`${courier}_${service}`} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-medium">{t(labelKey)}</td>
                  {/* Rates are STORED in EUR (courier_rates.deliver_cost /
                      return_cost) but are entered and shown in denari. */}
                  <td className="px-4 py-2.5 text-right">
                    <input
                      type="number" step="1" min="0"
                      className="w-24 rounded-md border bg-background px-2 py-1 text-right"
                      value={eurToDen(r?.deliver_cost ?? 0)}
                      onChange={(e) => setField(courier, service, 'deliver_cost', denToEur(Number(e.target.value)))}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <input
                      type="number" step="1" min="0"
                      className="w-24 rounded-md border bg-background px-2 py-1 text-right"
                      value={eurToDen(r?.return_cost ?? 0)}
                      onChange={(e) => setField(courier, service, 'return_cost', denToEur(Number(e.target.value)))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {t('settings.saveRates')}
      </button>
    </div>
  );
}


function CollapsibleCard({ title, subtitle, expanded, onToggle, children }: {
  title: string; subtitle?: string; expanded: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden transition-all">
      <button onClick={onToggle} className="flex w-full items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors">
        <div>
          <h3 className="text-sm font-semibold text-left">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {expanded && <div className="border-t px-5 py-4">{children}</div>}
    </div>
  );
}

function SettingRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
