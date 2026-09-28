import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { predictionListLabel } from '@/lib/predictionListLabel';
// Value brackets are stored in EUR, set in denari.
import { eurToDen, denToEur } from '@/lib/currency';
import {
  apiGetSegmentEngineConfig, apiSaveSegmentEngineConfig, apiGetSegmentEngineDiff,
  apiGetSegmentEngineControls, apiSetShadowEngine, apiRecomputeShadow, apiRecomputeSegments,
  type SegmentEngineConfig, type SegmentEngineConfigRow, type SegmentEngineDiff, type SegmentEngineControls,
} from '@/lib/api';
import {
  Loader2, Plus, Trash2, Save, Clock, Banknote, Repeat, Package,
  GitCompareArrows, AlertTriangle, Info, RefreshCw, Power, Play,
} from 'lucide-react';

// A text input that maps an empty value to null (for "open-ended" band bounds).
function NumOrNull({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  return (
    <Input
      type="number"
      className="h-8 w-24"
      value={value === null || value === undefined ? '' : String(value)}
      placeholder={placeholder ?? '∞'}
      onChange={(e) => {
        const s = e.target.value.trim();
        onChange(s === '' ? null : Number(s));
      }}
    />
  );
}

function deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

/**
 * A plain daily pg_cron schedule ("M H * * *" — pg_cron runs in UTC) as the
 * Skopje wall-clock time it fires today, DST-aware ("0 0 * * *" → "02:00" in
 * summer, "01:00" in winter). null for anything else.
 */
function cronSkopjeTime(schedule: string | null | undefined): string | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(schedule ?? '').trim());
  if (!m) return null;
  const d = new Date();
  d.setUTCHours(Number(m[2]), Number(m[1]), 0, 0);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

export function PredictionEngineTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  // "0 0 * * * (02:00 Скопје)"; a schedule that is not plain daily keeps (UTC).
  const cronText = (schedule: string | null | undefined) => {
    const at = cronSkopjeTime(schedule);
    return `${schedule ?? ''} (${at ? t('predEngine.cronAtSkopje', { time: at }) : 'UTC'})`;
  };
  const [row, setRow] = useState<SegmentEngineConfigRow | null>(null);
  const [cfg, setCfg] = useState<SegmentEngineConfig | null>(null);
  const [diff, setDiff] = useState<SegmentEngineDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [controls, setControls] = useState<SegmentEngineControls | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiGetSegmentEngineConfig();
      setRow(r);
      setCfg(deepClone(r.config));
      try { setDiff(await apiGetSegmentEngineDiff()); } catch { /* diff optional */ }
      try { setControls(await apiGetSegmentEngineControls()); } catch { /* controls optional */ }
    } catch (e) {
      toast({ title: apiErrorText(e), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const toggleShadow = async (enabled: boolean) => {
    setBusy('shadow');
    try {
      await apiSetShadowEngine(enabled);
      setControls((c) => (c ? { ...c, shadow_enabled: enabled, shadow_cron_active: enabled } : c));
      toast({ title: enabled
        ? t('predEngine.shadowOn', { defaultValue: 'Preview engine started (nightly at 03:30).' })
        : t('predEngine.shadowOff', { defaultValue: 'Preview engine stopped. Live lists keep working.' }) });
    } catch (e) { toast({ title: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };

  const recomputeLive = async () => {
    setBusy('live');
    try {
      const res = await apiRecomputeSegments();
      toast({ title: t('predEngine.recomputedLive', { defaultValue: 'Live lists recomputed ({{n}} customers).', n: (res as any)?.recomputed_customers ?? '' }) });
    } catch (e) { toast({ title: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };

  const recomputePreview = async () => {
    setBusy('preview');
    try {
      await apiRecomputeShadow();
      try { setDiff(await apiGetSegmentEngineDiff()); } catch { /* */ }
      toast({ title: t('predEngine.recomputedPreview', { defaultValue: 'Preview rebuilt.' }) });
    } catch (e) { toast({ title: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const patch = (fn: (c: SegmentEngineConfig) => void) => {
    setCfg((prev) => { if (!prev) return prev; const next = deepClone(prev); fn(next); return next; });
  };

  // ── client-side validation mirroring the server ──
  const errors: string[] = [];
  if (cfg) {
    if (!cfg.recency_bands?.length) errors.push(t('predEngine.errRecencyEmpty', { defaultValue: 'Add at least one recency band.' }));
    if (cfg.recency_bands?.length && !cfg.recency_bands.some((b) => b.max_days == null))
      errors.push(t('predEngine.errRecencyOpen', { defaultValue: 'The last recency band must be open-ended (leave its days empty).' }));
    let prev = -Infinity, asc = true;
    for (const b of cfg.recency_bands || []) {
      if (b.max_days != null) { if (b.max_days <= prev) asc = false; prev = b.max_days; }
    }
    if (!asc) errors.push(t('predEngine.errRecencyAsc', { defaultValue: 'Recency band days must increase top to bottom.' }));
    if (cfg.value_bands?.length && !cfg.value_bands.some((b) => b.max_price == null))
      errors.push(t('predEngine.errValueOpen', { defaultValue: 'The last value band must be open-ended (leave its price empty).' }));
    if (cfg.recency_bands?.some((b) => !b.label?.trim()) || cfg.value_bands?.some((b) => !b.label?.trim()) || cfg.frequency_bands?.some((b) => !b.label?.trim()))
      errors.push(t('predEngine.errLabels', { defaultValue: 'Every band needs a label.' }));
  }
  const canSave = cfg && errors.length === 0 && !saving;

  const save = async () => {
    if (!cfg || errors.length) return;
    setSaving(true);
    try {
      const res = await apiSaveSegmentEngineConfig(cfg, note);
      setDiff(res.diff);
      setNote('');
      toast({ title: t('predEngine.saved', { defaultValue: 'Engine config saved (v{{v}}). Shadow preview updated.', v: res.version }) });
      await load();
    } catch (e) {
      toast({ title: apiErrorText(e), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!cfg || !row) return <div className="py-20 text-center text-muted-foreground">{t('predEngine.loadFailed', { defaultValue: 'Could not load the engine config.' })}</div>;

  const isShadow = row.active_engine !== 'v4';

  return (
    <div className="space-y-6">
      {/* Mode banner */}
      <div className={`rounded-lg border p-4 flex items-start gap-3 ${isShadow ? 'border-info/40 bg-info/5' : 'border-warning/40 bg-warning/5'}`}>
        <Info className="h-5 w-5 shrink-0 mt-0.5 text-info" />
        <div className="text-sm">
          <div className="font-medium">
            {isShadow
              ? t('predEngine.modeShadowTitle', { defaultValue: 'Preview (shadow) mode — live lists are unchanged' })
              : t('predEngine.modeLiveTitle', { defaultValue: 'Live mode — edits change what agents call' })}
          </div>
          <div className="text-muted-foreground mt-0.5">
            {isShadow
              ? t('predEngine.modeShadowDesc', { defaultValue: 'The current (v3.4) engine still feeds every calling list. Saving here only rebuilds a side-by-side SHADOW preview so you can see exactly what would change before you flip the switch.' })
              : t('predEngine.modeLiveDesc', { defaultValue: 'The config-driven engine is live. Saving re-classifies every customer immediately.' })}
          </div>
          <Badge variant="outline" className="mt-2">{t('predEngine.versionBadge', { defaultValue: 'Config v{{v}} · live engine: {{e}}', v: row.version, e: row.active_engine })}</Badge>
        </div>
      </div>

      {/* Controls: recompute now + stop/start the preview engine */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Power className="h-4 w-4" /> {t('predEngine.controlsTitle', { defaultValue: 'Controls' })}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('predEngine.controlsDesc', { defaultValue: 'Recompute on demand instead of waiting for the nightly 03:00 run, and stop/start the new preview engine whenever you like. The live lists are never affected by stopping the preview.' })}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={recomputeLive} disabled={busy !== null} className="gap-2">
              {busy === 'live' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('predEngine.recomputeLive', { defaultValue: 'Recompute live lists now' })}
            </Button>
            <Button variant="outline" onClick={recomputePreview} disabled={busy !== null} className="gap-2">
              {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t('predEngine.recomputePreview', { defaultValue: 'Rebuild preview now' })}
            </Button>
          </div>
          {controls && (
            <>
              <div className="flex items-center justify-between gap-4 border-t pt-4">
                <div>
                  <Label className="text-sm">{t('predEngine.shadowSwitch', { defaultValue: 'Preview (shadow) engine' })}</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('predEngine.shadowSwitchDesc', { defaultValue: 'Runs the new engine nightly into a side-by-side preview. Turn off to stop all new-engine background work — your live lists keep running untouched.' })}
                  </p>
                </div>
                <Switch checked={!!controls.shadow_enabled} disabled={busy !== null} onCheckedChange={toggleShadow} />
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={controls.live_cron_active ? 'outline' : 'secondary'}>
                  {t('predEngine.liveCron', { defaultValue: 'Live nightly: {{s}}', s: controls.live_cron_active ? cronText(controls.live_cron_schedule) : t('predEngine.cronOff') })}
                </Badge>
                <Badge variant={controls.shadow_cron_active ? 'outline' : 'secondary'}>
                  {t('predEngine.shadowCron', { defaultValue: 'Preview nightly: {{s}}', s: controls.shadow_cron_active ? cronText(controls.shadow_cron_schedule) : t('predEngine.cronStopped') })}
                </Badge>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recency bands */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4" /> {t('predEngine.recencyTitle', { defaultValue: 'Recency bands (days since last paid order)' })}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('predEngine.recencyDesc', { defaultValue: 'How recently they ordered. First matching band wins (top to bottom). The last band must be open-ended. A “holding pen” band (e.g. NEWCOMERS) has no price split and never auto-inherits an agent.' })}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {cfg.recency_bands.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-8 w-40" value={b.label} placeholder={t('predEngine.label', { defaultValue: 'Label' })}
                onChange={(e) => patch((c) => { c.recency_bands[i].label = e.target.value; })} />
              <span className="text-xs text-muted-foreground">≤</span>
              <NumOrNull value={b.max_days} onChange={(v) => patch((c) => { c.recency_bands[i].max_days = v; })} placeholder={t('predEngine.openEnded', { defaultValue: 'open-ended' })} />
              <span className="text-xs text-muted-foreground">{t('predEngine.days', { defaultValue: 'days' })}</span>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-2">
                <Switch checked={!!b.holding_pen} onCheckedChange={(v) => patch((c) => { c.recency_bands[i].holding_pen = v; c.recency_bands[i].strip_assignment = v; })} />
                {t('predEngine.holdingPen', { defaultValue: 'Holding pen' })}
              </label>
              <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto" onClick={() => patch((c) => { c.recency_bands.splice(i, 1); })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => patch((c) => { c.recency_bands.splice(c.recency_bands.length - 1, 0, { label: '', max_days: 0 }); })}>
            <Plus className="h-4 w-4" /> {t('predEngine.addBand', { defaultValue: 'Add band' })}
          </Button>
        </CardContent>
      </Card>

      {/* Value bands */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Banknote className="h-4 w-4" /> {t('predEngine.valueTitle', { defaultValue: 'Value brackets (last paid order price, ден)' })}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('predEngine.valueDesc', { defaultValue: 'Splits each non-holding-pen band by order price. Last bracket must be open-ended.' })}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {cfg.value_bands.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-8 w-32" value={b.label} placeholder={t('predEngine.label', { defaultValue: 'Label' })}
                onChange={(e) => patch((c) => { c.value_bands[i].label = e.target.value; })} />
              <span className="text-xs text-muted-foreground">≤</span>
              {/* max_price is stored in EUR; the bracket is set in denari. */}
              <NumOrNull
                value={b.max_price == null ? null : eurToDen(b.max_price)}
                onChange={(v) => patch((c) => { c.value_bands[i].max_price = v == null ? null : denToEur(v); })}
                placeholder={t('predEngine.openEnded', { defaultValue: 'open-ended' })}
              />
              <span className="text-xs text-muted-foreground">ден</span>
              <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto" onClick={() => patch((c) => { c.value_bands.splice(i, 1); })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => patch((c) => { c.value_bands.splice(c.value_bands.length - 1, 0, { label: '', max_price: 0 }); })}>
            <Plus className="h-4 w-4" /> {t('predEngine.addBracket', { defaultValue: 'Add bracket' })}
          </Button>
        </CardContent>
      </Card>

      {/* Frequency tiers */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Repeat className="h-4 w-4" /> {t('predEngine.freqTitle', { defaultValue: 'Frequency tiers (lifetime paid orders)' })}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('predEngine.freqDesc', { defaultValue: 'The most specific tier wins (highest min-orders the customer reaches). Labels are literally true — a “(3+)” list never contains a 2-order customer.' })}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          {cfg.frequency_bands.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input className="h-8 w-40" value={b.label} placeholder={t('predEngine.label', { defaultValue: 'Label' })}
                onChange={(e) => patch((c) => { c.frequency_bands[i].label = e.target.value; })} />
              <span className="text-xs text-muted-foreground">{t('predEngine.minOrders', { defaultValue: 'min orders ≥' })}</span>
              <Input type="number" className="h-8 w-20" value={b.min_count}
                onChange={(e) => patch((c) => { c.frequency_bands[i].min_count = Number(e.target.value); })} />
              <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto" onClick={() => patch((c) => { c.frequency_bands.splice(i, 1); })}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => patch((c) => { c.frequency_bands.push({ label: '', min_count: 0 }); })}>
            <Plus className="h-4 w-4" /> {t('predEngine.addTier', { defaultValue: 'Add tier' })}
          </Button>
        </CardContent>
      </Card>

      {/* Windows */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('predEngine.windowsTitle', { defaultValue: 'Holding windows' })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm">{t('predEngine.cancelsWindow', { defaultValue: 'Current Cancels park (days)' })}</Label>
            <Input type="number" className="h-8 w-24" value={cfg.windows.current_cancels_days}
              onChange={(e) => patch((c) => { c.windows.current_cancels_days = Number(e.target.value); })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm">{t('predEngine.ncRecentWindow', { defaultValue: 'Never-Converted “Recent” cutoff (days)' })}</Label>
            <Input type="number" className="h-8 w-24" value={cfg.windows.never_converted_recent_days}
              onChange={(e) => patch((c) => { c.windows.never_converted_recent_days = Number(e.target.value); })} />
          </div>
        </CardContent>
      </Card>

      {/* Reorder (package-based recall) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> {t('predEngine.reorderTitle', { defaultValue: 'Package-based recall — “Due to Reorder”' })}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('predEngine.reorderDesc', { defaultValue: 'Calls each customer just before they run out of product. Supply = Σ(packages × each product’s days-of-supply). Set per-product days-of-supply on the Products screen (default 15 = a 30-capsule pack; a 4-pack = 60).' })}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm">{t('predEngine.reorderEnabled', { defaultValue: 'Enable the “Due to Reorder” list' })}</Label>
            <Switch checked={!!cfg.reorder.enabled} onCheckedChange={(v) => patch((c) => { c.reorder.enabled = v; })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm">{t('predEngine.reorderBuffer', { defaultValue: 'Call this many days BEFORE they run out' })}</Label>
            <Input type="number" className="h-8 w-24" value={cfg.reorder.buffer_days}
              onChange={(e) => patch((c) => { c.reorder.buffer_days = Number(e.target.value); })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="max-w-[60%]">
              <Label className="text-sm">{t('predEngine.reorderAgg', { defaultValue: 'When an order has different products' })}</Label>
              <p className="text-xs text-muted-foreground mt-0.5">{t('predEngine.reorderAggDesc', { defaultValue: 'Different products are parallel treatments — 2× one + 2× another = 1 month, not 2. Packages of the SAME product still add up.' })}</p>
            </div>
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={cfg.reorder.aggregation ?? 'longest'}
              onChange={(e) => patch((c) => { c.reorder.aggregation = e.target.value as 'longest' | 'earliest'; })}
            >
              <option value="longest">{t('predEngine.reorderAggLongest', { defaultValue: 'Longest treatment (call when all run out)' })}</option>
              <option value="earliest">{t('predEngine.reorderAggEarliest', { defaultValue: 'Earliest (call when the first runs low)' })}</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm">{t('predEngine.reorderDefault', { defaultValue: 'Default days-of-supply per package (fallback)' })}</Label>
            <Input type="number" className="h-8 w-24" value={cfg.reorder.default_days_of_supply_per_unit}
              onChange={(e) => patch((c) => { c.reorder.default_days_of_supply_per_unit = Number(e.target.value); })} />
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="sticky bottom-0 bg-background/80 backdrop-blur border-t py-3 flex items-center gap-3">
        <Input className="h-9 max-w-xs" value={note} placeholder={t('predEngine.notePlaceholder', { defaultValue: 'Optional note for this version…' })} onChange={(e) => setNote(e.target.value)} />
        <Button onClick={save} disabled={!canSave} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isShadow ? t('predEngine.savePreview', { defaultValue: 'Save & preview' }) : t('predEngine.saveLive', { defaultValue: 'Save (live)' })}
        </Button>
        {errors.length > 0 && (
          <div className="text-xs text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" /> {errors[0]}
          </div>
        )}
      </div>

      {/* Diff / preview */}
      {diff && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <GitCompareArrows className="h-4 w-4" /> {t('predEngine.diffTitle', { defaultValue: 'Preview: current lists vs the new engine' })}
            </CardTitle>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant={diff.drift === 0 ? 'outline' : 'secondary'}>{t('predEngine.drift', { defaultValue: '{{n}} membership change(s)', n: diff.drift })}</Badge>
              <Badge variant="outline">{t('predEngine.liveTotal', { defaultValue: 'live total {{n}}', n: diff.live_total })}</Badge>
              <Badge variant="outline">{t('predEngine.shadowTotal', { defaultValue: 'preview total {{n}}', n: diff.shadow_total })}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-1.5 pr-4">{t('predEngine.colList', { defaultValue: 'List' })}</th>
                    <th className="py-1.5 px-3 text-right">{t('predEngine.colLive', { defaultValue: 'Now' })}</th>
                    <th className="py-1.5 px-3 text-right">{t('predEngine.colPreview', { defaultValue: 'Preview' })}</th>
                    <th className="py-1.5 pl-3 text-right">{t('predEngine.colDelta', { defaultValue: 'Δ' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.lists.filter((l) => l.live > 0 || l.shadow > 0).map((l) => {
                    const delta = l.shadow - l.live;
                    return (
                      <tr key={l.list_id} className="border-b border-border/50">
                        <td className="py-1.5 pr-4">
                          <span title={l.name}>{predictionListLabel(l.name)}</span>
                          {l.is_static && <Badge variant="outline" className="ml-2 text-[10px]">{t('predEngine.static', { defaultValue: 'static' })}</Badge>}
                          {!l.is_active && <Badge variant="secondary" className="ml-2 text-[10px]">{t('predEngine.inactive', { defaultValue: 'inactive' })}</Badge>}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{l.live}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{l.shadow}</td>
                        <td className={`py-1.5 pl-3 text-right tabular-nums ${delta === 0 ? 'text-muted-foreground' : delta > 0 ? 'text-success' : 'text-destructive'}`}>
                          {delta > 0 ? `+${delta}` : delta}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
