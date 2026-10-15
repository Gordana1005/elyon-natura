import type { TFunction } from 'i18next';

/** The calendar's groups: a team (Тим Центар / Тим Маџари / Менаџмент) or a workplace (shop X, warehouse…). */
export interface GroupablePerson { team_key: string | null; workplace: string; shop_name: string | null }

export function groupKey(p: GroupablePerson): string {
  if (p.workplace === 'shop') return `shop:${p.shop_name ?? ''}`;
  if (p.workplace === 'call_centre' || p.workplace === 'office') return `team:${p.team_key ?? 'none'}`;
  return `wp:${p.workplace}`;
}

const ORDER: Record<string, number> = { 'team:teleshop': 1, 'team:affiliate': 2, 'team:management': 3, 'team:none': 4, 'wp:warehouse': 5, 'wp:field': 6 };
export const groupOrder = (k: string) => ORDER[k] ?? (k.startsWith('shop:') ? 10 : 50);

export function groupLabel(t: TFunction, key: string): string {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'shop') return rest ? t('hrPage.groups.shop', { name: rest }) : t('hrPage.groups.shopUnnamed');
  if (kind === 'team') return t(`hrPage.groups.team.${rest}`);
  return t(`hrPage.workplace.${rest}`);
}
