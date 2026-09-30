import {
  Crown, Handshake, Headphones, Megaphone, Package, Phone, Shield, UserCheck, Users, type LucideIcon,
} from 'lucide-react';
import i18n from '@/i18n';

/** A role's icon — a role is always shown as icon + word, never as a colour alone. */
export const ROLE_ICONS: Record<string, LucideIcon> = {
  admin: Crown,
  manager: Shield,
  agent: Headphones,
  inbound_agent: Phone,
  pending_agent: UserCheck,
  prediction_agent: Users,
  warehouse: Package,
  ads_admin: Megaphone,
  affiliate: Handshake,
};

export const roleIcon = (r: string): LucideIcon => ROLE_ICONS[r] ?? Shield;

/** A held role's badge tone (theme tokens, so dark mode follows). */
export const ROLE_TONES: Record<string, string> = {
  admin: 'bg-primary/10 text-primary border-primary/30',
  manager: 'bg-chart-2/10 text-chart-2 border-chart-2/30',
  agent: 'bg-accent text-accent-foreground border-accent',
  inbound_agent: 'bg-accent text-accent-foreground border-accent',
  pending_agent: 'bg-chart-3/10 text-chart-3 border-chart-3/30',
  prediction_agent: 'bg-chart-5/10 text-chart-5 border-chart-5/30',
  warehouse: 'bg-chart-4/10 text-chart-4 border-chart-4/30',
  ads_admin: 'bg-chart-1/10 text-chart-1 border-chart-1/30',
};

export const roleTone = (r: string): string => ROLE_TONES[r] ?? 'bg-muted text-muted-foreground border-border';

/**
 * A role in the reader's language: userRole.*; a role without one (affiliate)
 * falls back to its roles.* label, then to the raw value. Callers subscribe
 * through useTranslation() so a language switch re-renders them.
 */
export function roleLabel(r: string): string {
  if (i18n.exists(`userRole.${r}`)) return i18n.t(`userRole.${r}`);
  if (i18n.exists(`roles.${r}`)) return i18n.t(`roles.${r}`);
  return r;
}
