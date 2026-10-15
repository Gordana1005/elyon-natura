import { supabase } from '@/integrations/supabase/client';
import type { NotificationRow } from './localize';
import { EMPTY_OVERVIEW, skopjeDayBounds, type NotifOverview } from './feed';
import { STACK_TYPES, typesOfFilter, type NotifFilter } from './registry';

// The bell's reads and writes (20261015130000). Own rows only — RLS, and every call filters by user.
// The RPCs are not in the generated types yet, hence the casts.
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args);

const inList = (types: readonly string[]) => `(${types.map((t) => `"${t}"`).join(',')})`;

/** Unread per type (all history) + the stacks of [from, to). */
export async function fetchOverview(from: string, to: string | null = null): Promise<NotifOverview> {
  const { data, error } = await rpc('notifications_overview', {
    p_stack_types: STACK_TYPES, p_from: from, p_to: to,
  });
  if (error) throw new Error(error.message);
  const ov = (data ?? EMPTY_OVERVIEW) as NotifOverview;
  return { readBefore: ov.readBefore ?? null, unread: ov.unread ?? {}, stacks: ov.stacks ?? [] };
}

/**
 * The rows that are NOT stacked, newest first — fetched apart from the stacks so a flood of paid
 * orders can never push a guarantee or a collab warning out of the bell. Keyset by created_at.
 */
export async function fetchRows(opts: {
  userId: string;
  filter: NotifFilter;
  limit?: number;
  before?: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<NotificationRow[]> {
  let q = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', opts.userId)
    .not('type', 'in', inList(STACK_TYPES));
  const types = typesOfFilter(opts.filter);
  if (types) q = q.in('type', types);
  if (opts.from) q = q.gte('created_at', opts.from);
  if (opts.to) q = q.lt('created_at', opts.to);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(opts.limit ?? 50);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

/** The rows of one stack (one type, one Skopje day), newest first, a page at a time. */
export async function fetchStackRows(userId: string, type: string, day: string, offset: number, size = 20): Promise<NotificationRow[]> {
  const { from, to } = skopjeDayBounds(day);
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type)
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: false })
    .range(offset, offset + size - 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

export async function markRowRead(id: string): Promise<void> {
  await supabase.from('notifications').update({ is_read: true }).eq('id', id);
}

export async function markStackRead(type: string, day: string): Promise<void> {
  const { from, to } = skopjeDayBounds(day);
  const { error } = await rpc('notifications_mark_read', { p_type: type, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
}

/** Everything up to now counts as read — one watermark, not thousands of row updates. */
export async function markAllRead(): Promise<string> {
  const { data, error } = await rpc('notifications_mark_all_read');
  if (error) throw new Error(error.message);
  return String(data);
}
