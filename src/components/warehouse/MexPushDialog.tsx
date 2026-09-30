import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatDenari } from '@/lib/currency';
import { apiErrorText } from '@/i18n/apiErrors';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import {
  apiMexPush, MEX_ACCOUNTS, type AccountOverride, type MexAccount, type PushResult, type PushSwitch, type SendRow,
} from '@/lib/warehouseApi';
import { accountName, codeText, warningText } from './warehouseText';

/** One send request carries at most this many orders — each needs up to four MEX calls. */
export const PUSH_CHUNK = 10;
const MIN_REASON = 3;

interface Pick { account: MexAccount | ''; reason: string; double_ok: boolean }

/** The override the server needs for this order, or null (none needed / not complete yet). */
export function overrideFor(r: PushResult | undefined, p: Pick | undefined): AccountOverride | null {
  if (!r || !p || !p.account) return null;
  const reason = p.reason.trim();
  if (reason.length < MIN_REASON) return null;
  const suggested = r.decision?.account ?? null;
  const needs = !!r.decision?.needs_pick || p.account !== suggested || (r.blockers ?? []).includes('double_parcel_risk') || p.double_ok;
  return needs ? { account: p.account, reason, double_ok: p.double_ok } : null;
}

type Phase = 'checking' | 'review' | 'sending' | 'done';

/**
 * "Испрати до MEX": first a DRY RUN (the exact add_shipment.php bodies and every problem,
 * nothing sent), then an explicit "MEX has no cancel" confirmation, then the send in chunks
 * of ten, then what happened to each order. The switch (app_settings.mex_push) is enforced
 * on the server; here the send button simply stays disabled while it is off.
 */
export function MexPushDialog({
  open, onOpenChange, rows, push, money, onDone, f,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: SendRow[];
  push: PushSwitch | undefined;
  money: boolean;
  onDone: (results: PushResult[]) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const [phase, setPhase] = useState<Phase>('checking');
  const [dry, setDry] = useState<PushResult[]>([]);
  const [dryError, setDryError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<PushResult[]>([]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const seq = useRef(0);

  const overrides = useMemo(() => {
    const out: Record<string, AccountOverride> = {};
    for (const r of dry) {
      const o = overrideFor(r, picks[r.order_id]);
      if (o) out[r.order_id] = o;
    }
    return out;
  }, [dry, picks]);

  const runDry = useCallback(async (ov: Record<string, AccountOverride>) => {
    const mine = ++seq.current;
    setDryError(null);
    try {
      const res = await apiMexPush({ order_ids: ids, account_overrides: ov, dry_run: true });
      if (mine !== seq.current) return;
      setDry(res.results);
      setPicks((prev) => {
        const next = { ...prev };
        for (const r of res.results) {
          if (!next[r.order_id]) next[r.order_id] = { account: r.decision?.account ?? r.account ?? '', reason: '', double_ok: false };
        }
        return next;
      });
      setPhase('review');
    } catch (e) {
      if (mine !== seq.current) return;
      setDryError(apiErrorText(e));
      setPhase('review');
    }
  }, [ids]);

  // Open → reset → dry run.
  useEffect(() => {
    if (!open) return;
    setPhase('checking'); setDry([]); setPicks({}); setConfirmed(false); setResults([]); setProgress({ done: 0, total: 0 });
    void runDry({});
  }, [open, runDry]);

  // A complete pick (account + reason) → check again, once the typing stops.
  const ovKey = JSON.stringify(overrides);
  useEffect(() => {
    if (!open || phase !== 'review') return;
    const id = window.setTimeout(() => void runDry(overrides), 500);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ovKey]);

  const ready = dry.filter((r) => !(r.blockers ?? []).length);
  const blocked = dry.length - ready.length;
  const switchOn = !!push?.enabled;

  const send = async () => {
    const queue = ready.map((r) => r.order_id);
    setPhase('sending');
    setProgress({ done: 0, total: queue.length });
    const all: PushResult[] = [];
    let retried = false;
    while (queue.length) {
      const chunk = queue.splice(0, PUSH_CHUNK);
      const ov = Object.fromEntries(chunk.filter((id) => overrides[id]).map((id) => [id, overrides[id]]));
      try {
        const res = await apiMexPush({ order_ids: chunk, account_overrides: ov, dry_run: false });
        const deferred = res.results.filter((r) => r.outcome === 'deferred');
        all.push(...res.results.filter((r) => r.outcome !== 'deferred' || retried));
        if (deferred.length && !retried && res.stopped === 'time_budget') { queue.push(...deferred.map((r) => r.order_id)); retried = true; }
        if (res.stopped && res.stopped !== 'time_budget') {
          all.push(...queue.map((id) => ({ order_id: id, display_id: byId.get(id)?.display_id ?? null, outcome: 'deferred' as const, account: null, reason: res.stopped })));
          queue.length = 0;
        }
      } catch (e) {
        const reason = apiErrorText(e);
        all.push(...chunk.map((id) => ({ order_id: id, display_id: byId.get(id)?.display_id ?? null, outcome: 'error' as const, account: null, reason })));
      }
      setProgress({ done: Math.min(all.length, ready.length), total: ready.length });
    }
    setResults(all);
    setPhase('done');
  };

  const close = (o: boolean) => {
    if (phase === 'sending') return;            // never close mid-send
    if (!o && phase === 'done') onDone(results);
    onOpenChange(o);
  };

  const count = (o: PushResult['outcome'][]) => results.filter((r) => o.includes(r.outcome)).length;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100%-1rem)] max-w-3xl flex-col gap-3 overflow-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>{t('warehousePage.dialog.title')}</DialogTitle>
          <DialogDescription>
            {phase === 'checking' ? t('warehousePage.dialog.checking')
              : phase === 'done' ? t('warehousePage.dialog.done', { sent: count(['sent']), linked: count(['exists_linked']), failed: results.length - count(['sent', 'exists_linked']) })
              : t('warehousePage.dialog.summary', { ready: ready.length, blocked })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="mex-push-body">
          {phase === 'checking' && (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('warehousePage.dialog.checking')}
            </p>
          )}
          {dryError && phase !== 'checking' && (
            <p role="alert" className="mb-2 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <XCircle className="h-4 w-4 shrink-0" aria-hidden />{t('warehousePage.dialog.checkFailed')} {dryError}
            </p>
          )}

          {(phase === 'review' || phase === 'sending') && (
            <ul className="space-y-2">
              {dry.map((r) => {
                const row = byId.get(r.order_id);
                const blockers = r.blockers ?? [];
                const ok = blockers.length === 0;
                const pick = picks[r.order_id] ?? { account: '', reason: '', double_ok: false };
                const risky = blockers.includes('double_parcel_risk') || pick.double_ok;
                const showReason = !!r.decision?.needs_pick || (pick.account && pick.account !== (r.decision?.account ?? null)) || risky;
                const set = (patch: Partial<Pick>) => setPicks((p) => ({ ...p, [r.order_id]: { ...pick, ...patch } }));
                return (
                  <li key={r.order_id} className={cn('rounded-lg border p-3 text-sm', ok ? 'border-emerald-300 dark:border-emerald-900' : 'border-amber-300 dark:border-amber-900')}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{r.display_id ?? row?.display_id}</span>
                      <span className={cn('inline-flex items-center gap-1 text-xs font-medium', ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300')}>
                        {ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <CircleSlash className="h-3.5 w-3.5" aria-hidden />}
                        {ok ? t('warehousePage.dialog.ready') : t('warehousePage.dialog.blocked')}
                      </span>
                    </div>
                    {r.payload && (
                      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                        <Field label={t('warehousePage.dialog.fields.name')} value={`${r.payload.first_name} ${r.payload.last_name}`} />
                        <Field label={t('warehousePage.dialog.fields.phone')} value={r.payload.receiver_phone} />
                        <Field label={t('warehousePage.dialog.fields.address')} value={r.payload.receiver_address ?? '—'} />
                        <Field label={t('warehousePage.dialog.fields.zone')} value={row?.zone.name ?? r.csv?.grad ?? String(r.payload.receiver_city_id)} />
                        {money && r.payload.cod !== '' && <Field label={t('warehousePage.dialog.fields.cod')} value={formatDenari(r.payload.cod)} />}
                        {r.payload.instructions && <Field label={t('warehousePage.dialog.fields.opis')} value={r.payload.instructions} />}
                      </dl>
                    )}
                    {!ok && (
                      <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">
                        {blockers.map((b) => codeText(t, b)).join(' · ')}
                      </p>
                    )}
                    {(r.warnings ?? []).length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {(r.warnings ?? []).map((w, i) => (
                          <li key={i} className="flex gap-1"><AlertTriangle className="mt-px h-3 w-3 shrink-0 text-amber-600" aria-hidden />{warningText(t, w)}</li>
                        ))}
                      </ul>
                    )}
                    {!blockers.some((b) => !['needs_pick', 'bad_override', 'double_parcel_risk', 'account_disabled'].includes(b)) && (
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
                        <label className="flex items-center gap-2 text-xs font-medium">
                          <span className="shrink-0">{t('warehousePage.dialog.account')}</span>
                          <select className="min-h-9 rounded-md border bg-background px-2 text-sm" value={pick.account}
                            aria-label={`${t('warehousePage.dialog.account')} ${r.display_id ?? ''}`}
                            disabled={phase === 'sending'}
                            onChange={(e) => set({ account: e.target.value as MexAccount | '' })}>
                            <option value="">—</option>
                            {MEX_ACCOUNTS.map((a) => <option key={a} value={a}>{accountName(a)}</option>)}
                          </select>
                        </label>
                        {showReason && (
                          <Input className="h-9 text-sm" value={pick.reason} disabled={phase === 'sending'}
                            aria-label={`${t('warehousePage.dialog.reason')} ${r.display_id ?? ''}`}
                            placeholder={t('warehousePage.dialog.reasonPh')}
                            onChange={(e) => set({ reason: e.target.value })} />
                        )}
                        {blockers.includes('double_parcel_risk') || pick.double_ok ? (
                          <label className="flex items-center gap-2 text-xs sm:col-span-2">
                            <Checkbox checked={pick.double_ok} disabled={phase === 'sending'}
                              onCheckedChange={(v) => set({ double_ok: v === true })} />
                            {t('warehousePage.dialog.doubleOk')}
                          </label>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {phase === 'done' && (
            <ul className="space-y-1.5" aria-live="polite">
              {results.map((r) => (
                <li key={r.order_id} className="flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm">
                  <OutcomeIcon outcome={r.outcome} />
                  <span className="font-semibold">{r.display_id ?? byId.get(r.order_id)?.display_id}</span>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">
                    {t(`warehousePage.dialog.result.${r.outcome === 'dry_run' ? 'skipped' : r.outcome}`, {
                      tracking: r.tracking_id ?? '', reason: r.reason ? codeText(t, r.reason) : '',
                    })}
                    {r.account ? ` · ${accountName(r.account)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(phase === 'review' || phase === 'sending') && (
          <div className="space-y-2 border-t pt-3">
            {!switchOn && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground"><CircleSlash className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{t('warehousePage.send.switchOff')}</p>
            )}
            <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />{t('warehousePage.dialog.noCancel')}
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={confirmed} disabled={!switchOn || ready.length === 0 || phase === 'sending'}
                onCheckedChange={(v) => setConfirmed(v === true)} aria-label={t('warehousePage.dialog.confirm', { count: ready.length })} />
              {t('warehousePage.dialog.confirm', { count: ready.length })}
            </label>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => close(false)} disabled={phase === 'sending'}>{t('warehousePage.dialog.cancel')}</Button>
              <Button variant="outline" className="h-auto min-h-10 whitespace-normal px-2" onClick={() => void runDry(overrides)} disabled={phase === 'sending'}>
                <RefreshCw className="mr-1 h-4 w-4" aria-hidden />{t('warehousePage.dialog.recheck')}
              </Button>
              <Button className="col-span-2" onClick={() => void send()} disabled={!switchOn || !confirmed || ready.length === 0 || phase === 'sending'}>
                {phase === 'sending'
                  ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />{t('warehousePage.dialog.sending', { done: progress.done, total: progress.total })}</>
                  : t('warehousePage.dialog.send', { count: ready.length })}
              </Button>
            </div>
          </div>
        )}
        {phase === 'done' && (
          <div className="flex justify-end border-t pt-3">
            <Button onClick={() => close(false)}>{t('warehousePage.dialog.close')}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}:</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  );
}

function OutcomeIcon({ outcome }: { outcome: PushResult['outcome'] }) {
  if (outcome === 'sent' || outcome === 'exists_linked') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />;
  if (outcome === 'unknown_outcome' || outcome === 'error') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  return <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />;
}
