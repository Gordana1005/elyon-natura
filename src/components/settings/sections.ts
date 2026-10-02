// Поставки (Phase 10, 2026-10-01): the section registry — which sections exist,
// how they are grouped, and WHO sees each one. Pure (no React), unit-tested in
// sections.test.ts. SettingsPage renders /settings as the grouped list and
// /settings/:section as one section; the old ?tab= / #hash deep links map here.
//
// Visibility law (CLAUDE.md): owners see money, and every active admin is an
// owner (is_business_owner()); managers never see money. A manager sees only
// Лично, the rules (read-only) and the link to Корисници, as their module
// permissions allow. Telephony is deferred: its section exists only while
// VITE_USE_REAL_VOIP is on.

export type SettingsGroupId = 'people' | 'rules' | 'system' | 'advanced' | 'personal';
export const GROUP_ORDER: SettingsGroupId[] = ['people', 'rules', 'system', 'advanced', 'personal'];

export type SettingsSectionId =
  | 'users' | 'levels' | 'teams' | 'access' | 'money'
  | 'rules'
  | 'integrations' | 'tv' | 'courier' | 'partners' | 'warehouse' | 'telephony'
  | 'engine'
  | 'personal';

/** Who is looking. */
export interface SettingsViewer {
  isAdmin: boolean;
  isManager: boolean;
  /** is_business_owner() = can_see_revenue(): company-wide revenue (super_admin / owner / finance /
   *  administrator — access levels, 20260947001600). */
  isOwner: boolean;
  /** can_see_margins(): margins, purchase costs, courier rates, bonus rules (super_admin / owner /
   *  finance). An administrator is an owner (revenue) but NOT a margin viewer. */
  canSeeMargins: boolean;
  /** The person's access level (get_my_permissions().accessLevel, 20260947001600). Пристап и
   *  улоги opens for super_admin and owner (the api: GET /settings/access). */
  accessLevel?: string | null;
  /** canAccessModule('users') — the Корисници page itself. */
  canUsers: boolean;
  /** PBX_CONFIG.useRealVoip — telephony is deferred while it is off. */
  voipOn: boolean;
}

export interface SettingsSectionDef {
  id: SettingsSectionId;
  group: SettingsGroupId;
  labelKey: string;
  descKey: string;
  visible: (v: SettingsViewer) => boolean;
  /** Shown but not editable (a manager on Правила). */
  readOnly?: (v: SettingsViewer) => boolean;
}

const staff = (v: SettingsViewer) => v.isAdmin || v.isManager;

export const SECTIONS: SettingsSectionDef[] = [
  // Луѓе и пристап
  { id: 'users', group: 'people', labelKey: 'settingsPage.section.users.label', descKey: 'settingsPage.section.users.desc',
    visible: (v) => v.isAdmin || (v.isManager && v.canUsers) },
  // Пристап и улоги (owner 03.10.2026): every login's money LEVEL + departments. Super admins
  // change them, the owner reads them (GET / PUT /settings/access).
  { id: 'levels', group: 'people', labelKey: 'settingsPage.section.levels.label', descKey: 'settingsPage.section.levels.desc',
    visible: (v) => v.accessLevel === 'super_admin' || v.accessLevel === 'owner' },
  { id: 'teams', group: 'people', labelKey: 'settingsPage.section.teams.label', descKey: 'settingsPage.section.teams.desc',
    visible: (v) => v.isOwner },
  { id: 'access', group: 'people', labelKey: 'settingsPage.section.access.label', descKey: 'settingsPage.section.access.desc',
    visible: (v) => v.isAdmin },
  { id: 'money', group: 'people', labelKey: 'settingsPage.section.money.label', descKey: 'settingsPage.section.money.desc',
    visible: (v) => v.isOwner },
  // Правила
  { id: 'rules', group: 'rules', labelKey: 'settingsPage.section.rules.label', descKey: 'settingsPage.section.rules.desc',
    visible: staff, readOnly: (v) => !v.isAdmin },
  // Систем
  { id: 'integrations', group: 'system', labelKey: 'settingsPage.section.integrations.label', descKey: 'settingsPage.section.integrations.desc',
    visible: (v) => v.isOwner },
  { id: 'tv', group: 'system', labelKey: 'settingsPage.section.tv.label', descKey: 'settingsPage.section.tv.desc',
    visible: (v) => v.isAdmin },
  // The courier rate card is a margin figure: GET / PATCH /courier-rates answer 403 owners_only
  // unless can_see_margins (access levels, 20260947001600).
  { id: 'courier', group: 'system', labelKey: 'settingsPage.section.courier.label', descKey: 'settingsPage.section.courier.desc',
    visible: (v) => v.canSeeMargins },
  { id: 'partners', group: 'system', labelKey: 'settingsPage.section.partners.label', descKey: 'settingsPage.section.partners.desc',
    visible: (v) => v.isOwner },
  { id: 'warehouse', group: 'system', labelKey: 'settingsPage.section.warehouse.label', descKey: 'settingsPage.section.warehouse.desc',
    visible: (v) => v.isAdmin },
  { id: 'telephony', group: 'system', labelKey: 'settingsPage.section.telephony.label', descKey: 'settingsPage.section.telephony.desc',
    visible: (v) => v.isAdmin && v.voipOn },
  // Напредно
  { id: 'engine', group: 'advanced', labelKey: 'settingsPage.section.engine.label', descKey: 'settingsPage.section.engine.desc',
    visible: (v) => v.isAdmin },
  // Лично
  { id: 'personal', group: 'personal', labelKey: 'settingsPage.section.personal.label', descKey: 'settingsPage.section.personal.desc',
    visible: staff },
];

/** Sections that show money (or what money is made of): never for a non-owner. */
export const MONEY_SECTIONS: SettingsSectionId[] = ['money', 'courier', 'partners', 'teams', 'integrations'];

export const sectionById = (id: string | null | undefined): SettingsSectionDef | null =>
  SECTIONS.find((s) => s.id === id) ?? null;

export const visibleSections = (v: SettingsViewer): SettingsSectionDef[] => SECTIONS.filter((s) => s.visible(v));

/** The visible sections, grouped in display order (empty groups dropped). */
export function groupedSections(v: SettingsViewer): { group: SettingsGroupId; sections: SettingsSectionDef[] }[] {
  const vis = visibleSections(v);
  return GROUP_ORDER
    .map((group) => ({ group, sections: vis.filter((s) => s.group === group) }))
    .filter((g) => g.sections.length > 0);
}

/** 'ok' — render it · 'hidden' — it exists but not for this viewer · 'unknown' — no such section. */
export function sectionAccess(id: string | null | undefined, v: SettingsViewer): 'ok' | 'hidden' | 'unknown' {
  const s = sectionById(id);
  if (!s) return 'unknown';
  return s.visible(v) ? 'ok' : 'hidden';
}

/**
 * The old tab values (/settings?tab=… or /settings#…) → the new section. The
 * Users & roles, Financial visibility and Warehouse tabs are gone: they land on
 * the Корисници link, Пристап по улога and the Магацин link card.
 */
const LEGACY: Record<string, SettingsSectionId> = {
  users: 'users', owners: 'money', teams: 'teams', integrations: 'integrations',
  modules: 'access', permissions: 'access', financial: 'access', privacy: 'access',
  telephony: 'telephony', logistics: 'courier', courier: 'courier', leaderboard: 'tv', tv: 'tv',
  system: 'rules', rules: 'rules', predengine: 'engine', engine: 'engine',
  warehouse: 'warehouse', appearance: 'personal', personal: 'personal', money: 'money', access: 'access',
  partners: 'partners', levels: 'levels',
};

export function sectionFromLegacy(tab: string | null | undefined): SettingsSectionId | null {
  const k = String(tab ?? '').trim().replace(/^#/, '').toLowerCase();
  return k ? (LEGACY[k] ?? null) : null;
}
