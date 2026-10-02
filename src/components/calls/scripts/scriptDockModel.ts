/**
 * The /calls script dock — its pure helpers (no React): the remembered open state, the group dot,
 * the "Напиши ја" link, the call's cache identity and the "Зошто?" lines.
 */
import { listLabel } from '@/components/insights/lists/listModel';
import { isLeadGroup, type ScriptContext, type ScriptGroup, type ScriptMatch } from '@/lib/callScriptsTypes';
import { callScriptsForCallKey, type CallScriptCtx } from './useCallScripts';

/** The dock's open / collapsed state survives a refresh (per device). */
export const SCRIPT_DOCK_OPEN_KEY = 'elyon.scriptDock.open';

export function readDockOpen(): boolean {
  try { return localStorage.getItem(SCRIPT_DOCK_OPEN_KEY) !== '0'; } catch { return true; }
}
export function writeDockOpen(open: boolean) {
  try { localStorage.setItem(SCRIPT_DOCK_OPEN_KEY, open ? '1' : '0'); } catch { /* private mode */ }
}

/** A group's dot: leads sky, the recency bands violet, the pens their own tone. */
export function groupDot(g: ScriptGroup | null | undefined): string {
  if (!g) return 'bg-zinc-300 dark:bg-zinc-600';
  if (isLeadGroup(g)) return 'bg-sky-500';
  if (g === 'cancels') return 'bg-rose-500';
  if (g === 'never_converted') return 'bg-zinc-400';
  if (g === 'trash') return 'bg-zinc-500';
  return 'bg-violet-500';
}

/** /call-scripts → a new script already aimed at this call's group and product. */
export function writeScriptHref(context: ScriptContext | null): string {
  const sp = new URLSearchParams({ tab: 'library', new: '1' });
  if (context?.group) sp.set('group', context.group);
  if (context?.product?.id) sp.set('product', context.product.id);
  return `/call-scripts?${sp.toString()}`;
}

/** The cache identity of a call — a new call remounts the panel (fresh tab / picked state). */
export const scriptCallKey = (phone: string, context: CallScriptCtx) => callScriptsForCallKey(phone, context).join('|');

type T = (key: string, opts?: Record<string, unknown>) => string;

/** The match's reason codes in words: group:<g> · all_groups · product:<id> · all_products · twin. */
export function reasonLines(t: T, match: ScriptMatch, context: ScriptContext | null): string[] {
  const out: string[] = [];
  const twin = match.reasons.includes('twin');
  for (const r of match.reasons) {
    if (r === 'all_groups') out.push(t('scriptDock.why.allGroups'));
    else if (r === 'all_products') out.push(t('scriptDock.why.allProducts'));
    else if (r.startsWith('group:')) {
      const g = r.slice('group:'.length);
      out.push(t('scriptDock.why.group', { group: t(`callScripts.groups.${g}`, { defaultValue: g }) }));
    } else if (r.startsWith('product:')) {
      const id = r.slice('product:'.length);
      const all = [...(context?.product ? [context.product] : []), ...(context?.products ?? [])];
      // A twin's id is not on the call — name the call's own product (the twin line says why).
      const name = all.find((p) => p.id === id)?.name ?? (twin ? context?.product?.name : null) ?? t('scriptDock.why.productOther');
      out.push(t('scriptDock.why.product', { product: name }));
    }
  }
  if (twin) out.push(t('scriptDock.why.twin'));
  return out;
}

/** How the server found the call's group (order status · list name · last list · none). */
export function basisLine(t: T, context: ScriptContext | null): string | null {
  if (!context) return null;
  const list = context.list_name ? listLabel(t, context.list_name) : null;
  switch (context.group_basis) {
    case 'order_status':
      return t('scriptDock.why.basis.order_status', {
        status: context.order
          ? t(`status.${context.order.status}`, { defaultValue: context.order.status })
          : t(`callScripts.groups.${context.group}`, { defaultValue: '' }),
      });
    case 'list_name':
      return t('scriptDock.why.basis.list_name', { list: list ?? '' });
    case 'attribution':
      return list ? t('scriptDock.why.basis.attribution', { list }) : t('scriptDock.why.basis.attributionNoList');
    default:
      return t('scriptDock.why.basis.none');
  }
}
