import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { apiGetSegments, apiRecomputeSegments, apiGetCooldownClients, type CooldownClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import {
  Layers, Star, AlertTriangle, Shield, ShoppingBag, RotateCcw, Loader2, ChevronRight, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { formatDate } from '@/i18n/dates';
import { predictionListLabel } from '@/lib/predictionListLabel';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SegmentList {
  id: string;
  name: string;
  description: string;
  category: 'value' | 'prestige' | 'cancel' | 'return' | 'other';
  trigger_event: string;
  recency_months_min: number | null;
  recency_months_max: number | null;
  single_price_min: number | null;
  single_price_max: number | null;
  min_paid_count: number | null;
  lifetime_min: number | null;
  is_active: boolean;
  display_order: number;
  member_count: number | null;
  assigned_count: number | null;
  completed_count: number | null;
  engine_data_as_of?: string | null;
}

const CATEGORY_META: Record<SegmentList['category'], { labelKey: string; icon: typeof Layers; tone: string }> = {
  value:    { labelKey: 'segments.category.value',    icon: ShoppingBag,   tone: 'text-emerald-700' },
  prestige: { labelKey: 'segments.category.prestige', icon: Star,          tone: 'text-amber-700' },
  cancel:   { labelKey: 'segments.category.cancel',   icon: AlertTriangle, tone: 'text-red-700' },
  return:   { labelKey: 'segments.category.return',   icon: AlertTriangle, tone: 'text-rose-700' },
  other:    { labelKey: 'segments.category.other',    icon: Shield,        tone: 'text-slate-700' },
};

const CATEGORY_ORDER: SegmentList['category'][] = ['value', 'prestige', 'cancel', 'return', 'other'];

export default function SegmentsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin || user?.isManager;
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: segments = [], isLoading } = useQuery<SegmentList[]>({
    queryKey: ['segments'],
    queryFn: apiGetSegments,
    enabled: !!isAdmin,
    refetchInterval: 60_000,
  });

  const recomputeMutation = useMutation({
    mutationFn: apiRecomputeSegments,
    onSuccess: (data: any) => {
      toast({ title: t('segments.recomputed'), description: t('segments.recomputedDesc', { count: data.recomputed_customers ?? 0 }) });
      qc.invalidateQueries({ queryKey: ['segments'] });
    },
    onError: (err: any) => toast({ title: t('segments.recomputeFailed'), description: err?.message, variant: 'destructive' }),
  });

  const [cooldownOpen, setCooldownOpen] = useState(false);
  const { data: cooldownData, isLoading: cooldownLoading } = useQuery({
    queryKey: ['cooldown-clients'],
    queryFn: apiGetCooldownClients,
    enabled: cooldownOpen,
  });

  const grouped = useMemo(() => {
    const m: Record<string, SegmentList[]> = {};
    for (const s of segments) {
      if (!m[s.category]) m[s.category] = [];
      m[s.category].push(s);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => a.display_order - b.display_order);
    return m;
  }, [segments]);

  const totalMembers = segments.reduce((s, x) => s + (x.member_count ?? 0), 0);
  const totalAssigned = segments.reduce((s, x) => s + (x.assigned_count ?? 0), 0);

  if (!isAdmin) {
    return (
      <AppLayout title={t('nav.predictionLists')}>
        <div className="text-sm text-muted-foreground">{t('segments.adminRequired')}</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.predictionLists')}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Layers className="h-6 w-6 text-primary" /> {t('nav.predictionLists')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('segments.summaryLine', { lists: segments.length, members: totalMembers.toLocaleString(), assigned: totalAssigned.toLocaleString() })}
            </p>
            {segments[0]?.engine_data_as_of && (
              <p className="text-xs text-emerald-700 mt-0.5">
                {t('segments.engineAsOf', { date: formatDate(new Date(segments[0].engine_data_as_of), 'dd MMM HH:mm') })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCooldownOpen(true)}
              className="gap-1.5"
            >
              <Clock className="h-3.5 w-3.5" />
              {t('segments.cooldownClients')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
              className="gap-1.5"
            >
              {recomputeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {t('segments.recomputeAll')}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <div className="space-y-8">
            {CATEGORY_ORDER.map(cat => {
              const lists = grouped[cat] || [];
              if (lists.length === 0) return null;
              const meta = CATEGORY_META[cat];
              const Icon = meta.icon;
              return (
                <section key={cat}>
                  <h2 className={cn('text-xs font-semibold uppercase tracking-wider mb-3 flex items-center gap-1.5', meta.tone)}>
                    <Icon className="h-3.5 w-3.5" />
                    {t(meta.labelKey)}
                    <span className="text-muted-foreground font-normal normal-case">({lists.length})</span>
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {lists.map(list => <SegmentCard key={list.id} list={list} />)}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Cooldown Clients Modal */}
      <Dialog open={cooldownOpen} onOpenChange={setCooldownOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('segments.cooldownTitle')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {cooldownLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : cooldownData && cooldownData.clients.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2">{t('segments.colPhone')}</th>
                    <th className="py-2">{t('segments.colLastStatus')}</th>
                    <th className="py-2">{t('segments.colLastAt')}</th>
                    <th className="py-2">{t('segments.colCooldownUntil')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cooldownData.clients.map((c: CooldownClient) => (
                    <tr key={c.phone} className="border-b last:border-0">
                      <td className="py-1.5 font-mono text-xs">{c.phone}</td>
                      <td className="py-1.5 capitalize">{c.last_status}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{format(new Date(c.last_at), 'dd MMM yyyy HH:mm')}</td>
                      <td className="py-1.5 text-xs font-medium text-amber-600">{format(new Date(c.cooldown_until), 'dd MMM yyyy')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground py-4">{t('segments.noCooldown')}</p>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            These phones are temporarily blocked from all prediction lists due to a recent protected status change (paid / confirmed / shipped / cancelled).
          </p>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function SegmentCard({ list }: { list: SegmentList }) {
  const { t } = useTranslation();
  const restricted = list.member_count == null; // server hides counts for roles without segment-member access
  const mc = list.member_count ?? 0;
  const ac = list.assigned_count ?? 0;
  const cc = list.completed_count ?? 0;
  const unassigned = mc - ac;
  const completionPct = mc > 0 ? Math.round((cc / mc) * 100) : 0;
  const hasMembers = !restricted && mc > 0;

  return (
    <Link to={`/segments/${list.id}`} className="block group">
      <Card className={cn(
        'hover:shadow-md hover:border-primary/40 transition-all duration-150 cursor-pointer h-full',
        !list.is_active && 'opacity-60'
      )}>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-card-foreground truncate" title={list.name}>{predictionListLabel(list.name)}</div>
              <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{list.description}</div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors shrink-0 mt-0.5" />
          </div>

          <div className="flex items-end justify-between pt-1">
            <div>
              <div className="text-2xl font-bold tabular-nums text-card-foreground">{restricted ? <span className="text-sm font-medium text-muted-foreground">{t('segments.adminOnly')}</span> : mc.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground">{t('segments.members')}</div>
            </div>
            {hasMembers && (
              <div className="text-right text-[10px] space-y-0.5">
                <div className="text-emerald-700">
                  <span className="font-semibold">{ac}</span> {t('segments.assigned')}
                </div>
                {unassigned > 0 && (
                  <div className="text-amber-700">
                    <span className="font-semibold">{unassigned}</span> {t('segments.unassigned')}
                  </div>
                )}
                <div className="text-muted-foreground">{completionPct}% done</div>
              </div>
            )}
          </div>

          {hasMembers && (
            <div className="h-1 w-full bg-muted rounded-full overflow-hidden flex">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${(cc / mc) * 100}%` }}
              />
              <div
                className="h-full bg-blue-500/70 transition-all"
                style={{ width: `${((ac - cc) / mc) * 100}%` }}
              />
            </div>
          )}

          {!list.is_active && (
            <div className="text-[10px] text-muted-foreground italic">{t('segments.listPaused')}</div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
