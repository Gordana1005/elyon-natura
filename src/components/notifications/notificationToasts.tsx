import { toast } from 'sonner';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import { showIdleSelfToast } from '@/lib/presence/ui';
import { localizeNotification, type NotificationRow } from '@/lib/notifications/localize';
import { specOf } from '@/lib/notifications/registry';

/* ------------------------------------------------------------------
   The arrival toast of a new notification (Realtime INSERT).
   Order Paid  → happy uplifting + dollars raining (green/emerald)
   Refund      → pinkish + sad drifting 💸
   Missed call → stays the urgent red treatment (toast.error)

   Paid / returned (owner 15.10.2026): ONLY the sale's owner gets a toast
   (meta.recipient = 'owner', 20261015130000) — the admins' company-wide copy
   lives in the bell's daily card. A burst (MEX reconcile flips many orders in one
   run) is gathered for a moment: up to 3 → one toast each, more → ONE summary.
------------------------------------------------------------------ */

const BURST_WINDOW_MS = 1500;
const BURST_SINGLE_MAX = 3;
const bursts = new Map<string, { rows: NotificationRow[]; timer: ReturnType<typeof setTimeout> }>();

export function showNotificationToast(n: NotificationRow) {
  // The person's OWN idle alert: the activity beat already raised this exact
  // toast in the tab that sent it (same id → sonner replaces, never stacks);
  // every other open tab gets it from here.
  if (n.type === 'inactivity' && n.meta?.self) {
    showIdleSelfToast(Number(n.meta?.minutes) || 0);
    return;
  }

  if (n.type === 'order_paid' || n.type === 'order_returned') {
    if (n.meta?.recipient !== 'owner') return;
    const b = bursts.get(n.type);
    if (b) { b.rows.push(n); return; }
    bursts.set(n.type, { rows: [n], timer: setTimeout(() => flushBurst(n.type), BURST_WINDOW_MS) });
    return;
  }

  const local = localizeNotification(n);
  const sev = specOf(n.type).toast;
  const opts = local.message ? { description: local.message } : {};
  if (sev === 'error') toast.error(local.title, opts);
  else if (sev === 'warning') toast.warning(local.title, opts);
  else if (sev === 'success') toast.success(local.title, opts);
  else toast(local.title, opts);
}

function flushBurst(type: string) {
  const b = bursts.get(type);
  bursts.delete(type);
  if (!b) return;
  const paid = type === 'order_paid';
  if (b.rows.length <= BURST_SINGLE_MAX) {
    for (const n of b.rows) {
      const local = localizeNotification(n);
      toast.custom(
        (t) => (paid
          ? <HappyOrderPaidToast t={t} title={local.title} message={local.message} />
          : <SadRefundToast t={t} title={local.title} message={local.message} />),
        { duration: paid ? 5200 : 4800 },
      );
    }
    return;
  }
  const sum = b.rows.reduce((s, n) => s + (Number(n.meta?.amountMkd) || 0), 0);
  const key = paid ? 'notif.toastPaidMany' : 'notif.toastReturnedMany';
  const title = i18n.t(`${key}.title`, { count: b.rows.length });
  const message = sum > 0 ? i18n.t(`${key}.body`, { amount: formatDenari(sum) }) : '';
  toast.custom(
    (t) => (paid
      ? <HappyOrderPaidToast t={t} title={title} message={message} />
      : <SadRefundToast t={t} title={title} message={message} />),
    { duration: 6000 },
  );
}

function RainingMoney({
  color = 'text-emerald-500',
  count = 8,
  sad = false,
}: {
  color?: string;
  count?: number;
  sad?: boolean;
}) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
      {Array.from({ length: count }).map((_, i) => {
        const left = ((i * 17) % 88) + (i % 3) * 4;
        const delay = i * (sad ? 180 : 95);
        const duration = sad ? 1350 : 820;
        const anim = sad ? 'sad-drift' : 'money-rain';
        const symbol = sad ? '💸' : '$';
        return (
          <span
            key={i}
            className={`absolute text-lg font-bold select-none ${color}`}
            style={{
              left: `${left}%`,
              top: sad ? '25%' : '-4px',
              animation: `${anim} ${duration}ms linear ${delay}ms forwards`,
              opacity: sad ? 0.65 : 0.9,
            }}
          >
            {symbol}
          </span>
        );
      })}
    </div>
  );
}

function HappyOrderPaidToast({ t, title, message }: { t: { id: string | number } | string | number; title: string; message: string }) {
  const id = typeof t === 'object' ? t.id : t;
  return (
    <div className="relative w-full max-w-[340px] overflow-hidden rounded-xl border border-emerald-500/40 bg-background p-4 shadow-xl">
      <div className="flex items-start gap-3 pr-5">
        <div className="text-3xl leading-none mt-px">🎉</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-emerald-600 dark:text-emerald-400 text-[15px] tracking-[-0.2px]">
            {i18n.t('notif.congrats')}
          </div>
          <div className="mt-0.5 text-sm font-medium leading-snug text-foreground">
            {title}
          </div>
          {message && (
            <div className="mt-1 text-xs text-muted-foreground leading-snug">
              {message}
            </div>
          )}
          <div className="mt-1 text-[10px] text-emerald-500/80 font-medium">{i18n.t('notif.kaChing')}</div>
        </div>
      </div>

      <RainingMoney color="text-emerald-400 dark:text-emerald-500" count={9} />

      <button
        onClick={() => toast.dismiss(id)}
        className="absolute right-1.5 top-1.5 rounded p-1 text-emerald-600/60 hover:text-emerald-600 hover:bg-emerald-500/10 transition-colors"
        aria-label={i18n.t('common.close')}
      >
        ×
      </button>
    </div>
  );
}

function SadRefundToast({ t, title, message }: { t: { id: string | number } | string | number; title: string; message: string }) {
  const id = typeof t === 'object' ? t.id : t;
  return (
    <div className="relative w-full max-w-[340px] overflow-hidden rounded-xl border border-pink-500/40 bg-background p-4 shadow-xl">
      <div className="flex items-start gap-3 pr-5">
        <div className="text-3xl leading-none mt-px opacity-80">💔</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-pink-600 dark:text-pink-400 text-[15px]">
            {i18n.t('notif.refundProcessed')}
          </div>
          <div className="mt-0.5 text-sm font-medium leading-snug text-foreground">
            {title}
          </div>
          {message && (
            <div className="mt-1 text-xs text-muted-foreground leading-snug">
              {message}
            </div>
          )}
          <div className="mt-1 text-[10px] text-pink-500/70">{i18n.t('notif.nextOne')}</div>
        </div>
      </div>

      <RainingMoney color="text-pink-400/90 dark:text-pink-500/90" count={5} sad />

      <button
        onClick={() => toast.dismiss(id)}
        className="absolute right-1.5 top-1.5 rounded p-1 text-pink-600/60 hover:text-pink-600 hover:bg-pink-500/10 transition-colors"
        aria-label={i18n.t('common.close')}
      >
        ×
      </button>
    </div>
  );
}
