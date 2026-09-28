// Settings → Leaderboard (admin/manager). Three sections:
//   1. Today's extras — people ADDED to today's board. Teams decide who is on a
//      board by default (every member, every day, sales or not — the api's
//      leaderboard_day()); since 2026-09-28 this list can no longer hide anyone.
//   2. Bonus rules — tiered daily bonus per metric (confirmed / avg value / answer rate)
//   3. TV access — the shareable /tv/leaderboard?key=… link + token rotation
// The board itself is the separate daily game layer; it does NOT touch payroll.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trophy, Loader2, Copy, RefreshCw, Trash2, Plus, Tv, Users, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
// Bonus thresholds and amounts are stored in EUR, entered in denari.
import { eurToDen, denToEur } from '@/lib/currency';
import {
  apiGetAgents,
  apiGetLeaderboardAdmin, apiSetLeaderboardRoster, apiSetLeaderboardRule, apiManageLeaderboardToken,
  type LeaderboardBonusRule, type LeaderboardMetric, type LeaderboardTier, type LeaderboardMode,
} from '@/lib/api';

// Labels/hints resolved at render via t(); `unit` stays a raw discriminator
// (never shown as-is) that picks which tier-column header to render.
const METRIC_META: Record<LeaderboardMetric, { labelKey: string; hintKey: string; unit: string }> = {
  confirmed_count: { labelKey: 'settings.lbMetricConfirmed', hintKey: 'settings.lbMetricConfirmedHint', unit: 'orders' },
  avg_order_value: { labelKey: 'settings.lbMetricAvgOrder', hintKey: 'settings.lbMetricAvgOrderHint', unit: 'ден' },
  conversion_rate: { labelKey: 'settings.lbMetricConversion', hintKey: 'settings.lbMetricConversionHint', unit: '%' },
  revenue_target: { labelKey: 'settings.lbMetricRevenueTarget', hintKey: 'settings.lbMetricRevenueTargetHint', unit: 'ден' },
};
// Which bonus metrics each motion uses (per-package commission is automatic on both).
const METRICS_BY_MODE: Record<LeaderboardMode, LeaderboardMetric[]> = {
  prediction: ['revenue_target'],
  pending: ['confirmed_count', 'avg_order_value'],
};

const modeLabelKey = (m: LeaderboardMode) =>
  m === 'prediction' ? 'settings.lbModePrediction' : 'settings.lbModePending';

interface AgentRow { user_id: string; full_name: string; email: string; roles: string[] }

export function LeaderboardTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<LeaderboardMode>('prediction');

  const agentsQ = useQuery({ queryKey: ['lb-agents'], queryFn: apiGetAgents });
  const cfgQ = useQuery({ queryKey: ['lb-admin', mode], queryFn: () => apiGetLeaderboardAdmin(mode) });

  // Call-agents can be added (the same four roles the board has always counted;
  // admins/managers are shown when they sell, and never earn).
  const agents: AgentRow[] = useMemo(
    () => (agentsQ.data || []).filter((a: AgentRow) =>
      a.roles?.some((r) => ['agent', 'pending_agent', 'prediction_agent', 'inbound_agent'].includes(r))),
    [agentsQ.data],
  );
  const invalidate = () => qc.invalidateQueries({ queryKey: ['lb-admin', mode] });

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Trophy className="h-4 w-4 text-primary" /> {t('settings.lbTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('settings.lbDesc')}</p>
        </div>
        <div className="flex shrink-0 rounded-lg border bg-muted/40 p-1">
          <Button variant={mode === 'prediction' ? 'default' : 'ghost'} size="sm" onClick={() => setMode('prediction')}>{t('settings.lbModePrediction')}</Button>
          <Button variant={mode === 'pending' ? 'default' : 'ghost'} size="sm" onClick={() => setMode('pending')}>{t('settings.lbModePending')}</Button>
        </div>
      </div>

      {(cfgQ.isLoading || agentsQ.isLoading) ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
      ) : cfgQ.error ? (
        <div className="py-10 text-destructive">{t('settings.lbLoadFailed')}</div>
      ) : (
        <>
          <RosterSection mode={mode} agents={agents} roster={cfgQ.data!.roster} day={cfgQ.data!.roster_date}
            onSaved={invalidate} toast={toast} />
          <RulesSection mode={mode} rules={cfgQ.data!.rules} onSaved={invalidate} toast={toast} />
          <TokensSection tokens={cfgQ.data!.tokens} onChanged={invalidate} toast={toast} />
        </>
      )}
    </div>
  );
}

// ── 1. Roster ────────────────────────────────────────────────────────────────
function RosterSection({ mode, agents, roster, day, onSaved, toast }: {
  mode: LeaderboardMode; agents: AgentRow[]; roster: string[]; day: string; onSaved: () => void; toast: any;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set(roster));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSelected(new Set(roster)); }, [roster]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const save = async () => {
    setSaving(true);
    try {
      await apiSetLeaderboardRoster(mode, [...selected]);
      toast({
        title: t('settings.lbRosterSaved'),
        description: t('settings.lbRosterSavedDesc', { n: selected.size, mode: t(modeLabelKey(mode)) }),
      });
      onSaved();
    } catch (e: any) {
      toast({ title: t('settings.lbSaveFailed'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium flex items-center gap-2"><Users className="h-4 w-4 text-primary" /> {t('settings.lbRosterTitle', { mode: t(modeLabelKey(mode)) })} <span className="text-xs text-muted-foreground">({day})</span></h3>
          <p className="text-sm text-muted-foreground">{t('settings.lbRosterDesc', { mode: t(modeLabelKey(mode)) })}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set(agents.map((a) => a.user_id)))}>{t('common.all')}</Button>
          <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>{t('settings.lbNone')}</Button>
          <Button size="sm" onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}{t('settings.lbSaveRoster')}</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {agents.map((a) => {
          const on = selected.has(a.user_id);
          return (
            <button key={a.user_id} type="button" onClick={() => toggle(a.user_id)}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${on ? 'border-primary bg-primary/10' : 'bg-card hover:bg-muted/50'}`}>
              <span className="truncate">{a.full_name}</span>
              <Switch checked={on} onClick={(e) => e.stopPropagation()} onCheckedChange={() => toggle(a.user_id)} />
            </button>
          );
        })}
        {agents.length === 0 && <div className="col-span-full py-6 text-center text-sm text-muted-foreground">{t('settings.lbNoAgents')}</div>}
      </div>
    </section>
  );
}

// ── 2. Bonus rules ───────────────────────────────────────────────────────────
function RulesSection({ mode, rules, onSaved, toast }: { mode: LeaderboardMode; rules: LeaderboardBonusRule[]; onSaved: () => void; toast: any }) {
  const { t } = useTranslation();
  const desc = mode === 'prediction' ? t('settings.lbRulesDescPrediction') : t('settings.lbRulesDescPending');
  const metrics = METRICS_BY_MODE[mode];
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-primary" /> {mode === 'prediction' ? t('settings.lbRevenueTargets') : t('settings.lbBonusTiers')}</h3>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      <div className={`grid gap-3 ${metrics.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {metrics.map((metric) => {
          const rule = rules.find((r) => r.metric === metric) || { metric, tiers: [], is_active: true };
          return <RuleCard key={metric} mode={mode} rule={rule} onSaved={onSaved} toast={toast} />;
        })}
      </div>
    </section>
  );
}

function RuleCard({ mode, rule, onSaved, toast }: { mode: LeaderboardMode; rule: LeaderboardBonusRule; onSaved: () => void; toast: any }) {
  const { t } = useTranslation();
  const meta = METRIC_META[rule.metric];
  const [tiers, setTiers] = useState<LeaderboardTier[]>(rule.tiers);
  const [active, setActive] = useState<boolean>(rule.is_active);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setTiers(rule.tiers); setActive(rule.is_active); }, [rule]);

  // `min` is a money threshold only for the value-based metrics; for the rest it
  // is an order count or a percentage and is not converted.
  const isMoneyMin = meta.unit === 'ден';
  const upd = (i: number, field: 'min' | 'bonus', v: string) =>
    setTiers((prev) => prev.map((tier, idx) => idx === i ? { ...tier, [field]: Number(v) || 0 } : tier));
  const addTier = () => setTiers((prev) => [...prev, { min: 0, bonus: 0 }]);
  const delTier = (i: number) => setTiers((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      const sorted = [...tiers].sort((a, b) => a.min - b.min);
      await apiSetLeaderboardRule(mode, { metric: rule.metric, tiers: sorted, is_active: active });
      toast({ title: t('common.saved'), description: t(meta.labelKey) });
      onSaved();
    } catch (e: any) {
      toast({ title: t('settings.lbSaveFailed'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <div className={`rounded-lg border bg-card p-3 ${active ? '' : 'opacity-60'}`}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">{t(meta.labelKey)}</div>
          <div className="text-xs text-muted-foreground">{t(meta.hintKey)}</div>
        </div>
        <Switch checked={active} onCheckedChange={setActive} />
      </div>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <span>{isMoneyMin ? t('settings.lbColMinValue') : meta.unit === '%' ? t('settings.lbColMinRate') : t('settings.lbColMinOrders')}</span>
          <span>{t('settings.lbColBonus')}</span><span />
        </div>
        {tiers.map((tier, i) => (
          // Thresholds and bonuses are STORED in EUR; both are entered in denari.
          // `min` is only money for the value-based metrics — for the others it
          // counts orders or percent and must pass through untouched.
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
            <Input
              type="number"
              value={isMoneyMin ? eurToDen(tier.min) : tier.min}
              onChange={(e) => upd(i, 'min', isMoneyMin ? String(denToEur(Number(e.target.value) || 0)) : e.target.value)}
              className="h-8"
            />
            <Input
              type="number"
              value={eurToDen(tier.bonus)}
              onChange={(e) => upd(i, 'bonus', String(denToEur(Number(e.target.value) || 0)))}
              className="h-8"
            />
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => delTier(i)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-full" onClick={addTier}><Plus className="h-4 w-4 mr-1" /> {t('settings.lbAddTier')}</Button>
      </div>
      <Button size="sm" className="mt-3 w-full" onClick={save} disabled={saving}>
        {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}{t('common.save')}
      </Button>
    </div>
  );
}

// ── 3. TV access tokens ──────────────────────────────────────────────────────
function TokensSection({ tokens, onChanged, toast }: { tokens: any[]; onChanged: () => void; toast: any }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const act = async (body: Parameters<typeof apiManageLeaderboardToken>[0]) => {
    setBusy(true);
    try { await apiManageLeaderboardToken(body); onChanged(); }
    catch (e: any) { toast({ title: t('settings.lbActionFailed'), description: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  const copy = (url: string) => { navigator.clipboard?.writeText(url); toast({ title: t('settings.lbCopied'), description: t('settings.lbCopiedDesc') }); };

  const active = tokens.filter((tok) => tok.is_active);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium flex items-center gap-2"><Tv className="h-4 w-4 text-primary" /> {t('settings.lbTvLink')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.lbTvLinkDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => act({ action: 'rotate', label: 'Office TV' })} disabled={busy}>
            <RefreshCw className="h-4 w-4 mr-1" /> {t('settings.lbRotate')}
          </Button>
          <Button size="sm" onClick={() => act({ action: 'create', label: 'TV' })} disabled={busy}>
            <Plus className="h-4 w-4 mr-1" /> {t('settings.lbNewLink')}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {active.length === 0 && <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">{t('settings.lbNoLink')}</div>}
        {active.map((tok) => {
          const url = `${origin}/tv/leaderboard?key=${tok.token}`;
          return (
            <div key={tok.id} className="flex items-center gap-2 rounded-lg border bg-card p-2">
              <Badge variant="secondary" className="shrink-0">{tok.label || 'TV'}</Badge>
              <Input readOnly value={url} className="h-8 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => copy(url)}><Copy className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => act({ action: 'revoke', id: tok.id })} disabled={busy}><Trash2 className="h-4 w-4" /></Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
