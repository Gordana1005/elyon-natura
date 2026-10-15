import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCheck } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { addDaysYmd, skopjeMidnightIso, skopjeTodayYmd } from '@/lib/skopjeTime';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import { presetRange, type DayRange, type PeriodPreset } from '@/components/insights/shared/period';
import type { NotifFilter } from '@/lib/notifications/registry';
import { NotificationFeedView, NotificationFilterChips } from '@/components/notifications/NotificationFeedView';
import { useNotificationFeed } from '@/components/notifications/useNotificationFeed';
import { useOpenNotification } from '@/components/notifications/useOpenNotification';

const PRESETS: PeriodPreset[] = ['today', 'week', 'month'];

/**
 * /notifications — every notification of the signed-in person (owner 15.10.2026): the bell's
 * categories and daily stacks over a chosen period (Денес ‹ › · 7 дена · Овој месец), the rows
 * 50 at a time. Own rows only (RLS); "Означи ги сите" moves the person's read watermark.
 */
export default function NotificationsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const today = skopjeTodayYmd();
  const [filter, setFilter] = useState<NotifFilter>('all');
  const [preset, setPreset] = useState<PeriodPreset>('week');
  const [range, setRange] = useState<DayRange>(() => presetRange('week', today));
  const from = useMemo(() => skopjeMidnightIso(range.from), [range.from]);
  const to = useMemo(() => skopjeMidnightIso(addDaysYmd(range.to, 1)), [range.to]);
  const n = useNotificationFeed({ from, to, filter, pinLimit: 0 });
  const openRow = useOpenNotification(n.markRow);

  // The partner portal never reaches staff pages (elyon-affiliates hard wall).
  if (user?.isAffiliate) return <Navigate to="/start" replace />;

  const choose = (p: PeriodPreset) => {
    setPreset(p);
    setRange(presetRange(p, today));
  };

  return (
    <AppLayout title={t('notif.pageTitle')}>
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-full border bg-background p-0.5">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => choose(p)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      preset === p ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
                    )}
                  >
                    {t(`notif.period.${p}`)}
                  </button>
                ))}
              </div>
              <PeriodStepper
                range={range}
                today={today}
                onStep={(next) => { setPreset(next.preset); setRange(next.range); }}
              />
            </div>
            {n.unread > 0 && (
              <Button variant="outline" size="sm" onClick={() => void n.markAll()} className="gap-1">
                <CheckCheck className="h-3.5 w-3.5" />
                {t('notif.markAllRead')}
              </Button>
            )}
          </div>
          <NotificationFilterChips value={filter} onChange={setFilter} countOf={n.countOf} />
        </div>

        <div className="overflow-hidden rounded-xl border bg-card">
          <NotificationFeedView
            feed={n.feed}
            userId={n.userId}
            readBefore={n.readBefore}
            onOpenRow={openRow}
            onMarkStack={n.markStack}
            loading={n.loading}
            error={n.error}
            emptyText={t('notif.pageEmpty')}
          />
          {n.hasMoreRows && (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" size="sm" disabled={n.loadingMoreRows} onClick={n.loadMoreRows}>
                {n.loadingMoreRows ? t('common.loading') : t('notif.loadMore')}
              </Button>
            </div>
          )}
        </div>
        <p className="px-1 text-xs text-muted-foreground">{t('notif.pageHint')}</p>
      </div>
    </AppLayout>
  );
}
