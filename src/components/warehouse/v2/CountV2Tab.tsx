import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardCheck, ClipboardPaste, Eraser, Loader2, Plus, Search, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LABEL } from '@/components/assigner/parts';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { fromSkopjeDatetimeLocal, skopjeTodayYmd, toSkopjeDatetimeLocal } from '@/lib/skopjeTime';
import i18n from '@/i18n';
import {
  apiStockV2Articles, apiStockV2Count, apiStockV2CountApprove, apiStockV2CountVoid, apiStockV2Counts,
} from '@/lib/stockV2Api';
import type { StockArticleRow, StockCountHistoryRow, StockCountRequest, StockCountResult } from '@/lib/stockV2Types';
import { cn } from '@/lib/utils';
import { moment } from './moves';
import {
  Empty, Pill, WarehousePicker, patchParams, useStockAccess, useStockHealthLite, useWarehouseOptions, warehouseName,
} from './shared';
import { StockV2HealthCard } from './StockV2HealthCard';
import { fmtQty, fmtSigned, hasKey, parseHm, parsePasted, parseQty } from './stockV2Model';

type Kind = StockCountRequest['kind'];
const KINDS: Kind[] = ['partial', 'full', 'opening'];
const DRAFT_KEY = 'elyon.stock2CountDraft.v1';

interface DraftLine { code: string; name: string; qty: string }
interface Draft { lines: DraftLine[]; kind: Kind; packed: boolean; note: string }

const emptyDraft = (): Draft => ({ lines: [], kind: 'partial', packed: false, note: '' });
function loadDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      lines: Array.isArray(d.lines) ? d.lines.filter((l) => l && typeof l.code === 'string').map((l) => ({ code: l.code, name: String(l.name ?? ''), qty: String(l.qty ?? '') })) : [],
      kind: KINDS.includes(d.kind as Kind) ? (d.kind as Kind) : 'partial',
      packed: !!d.packed,
      note: typeof d.note === 'string' ? d.note : '',
    };
  } catch { return emptyDraft(); }
}
function saveDraft(d: Draft) {
  try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private window */ }
}
function clearDraft() {
  try { window.localStorage.removeItem(DRAFT_KEY); } catch { /* private window */ }
}

/** "parcels_near_count:12" → its words; anything unknown (a new code, free text) is shown as the api sent it. */
function warningText(f: InsightsFormat, w: string): string {
  const [code, ...rest] = w.split(':');
  const key = `stock2.count.warn.${code.trim()}`;
  // i18n.exists first: a dev build renders a missing key as ⟪key⟫ even with a defaultValue
  if (!/^[a-z][a-z0-9_]*$/.test(code.trim()) || !i18n.exists(key)) return w;
  return f.t(key, { n: rest.join(':').trim() });
}

/**
 * A refused count speaks the warnings' vocabulary ("unknown_article:000123, 000456",
 * "kom_fraction:100123", "before_last_count", "opening_exists" …) — its words; anything else
 * through the general api-error text.
 */
function countErrorText(f: InsightsFormat, e: unknown): string {
  const msg = e instanceof Error ? e.message.trim() : '';
  const code = msg.split(':')[0].trim();
  if (/^[a-z][a-z0-9_]*$/.test(code) && i18n.exists(`stock2.count.warn.${code}`)) return warningText(f, msg);
  return apiErrorText(e);
}

/**
 * Магацин → Попис (stock v2): a count of one warehouse at one moment (Skopje), opening / full /
 * partial, "were the packed parcels counted?", the counted lines (an article search, or two
 * columns pasted from Excel), a dry PREVIEW against the system quantity at that moment (the
 * difference, its value for owners, the api's warnings), then Save — an owner's count is approved,
 * anyone else's waits for an owner. Under it the history (void with a reason; owners approve) and,
 * for owners and admins, the stock v2 health card.
 */
export function CountV2Tab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const access = useStockAccess();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const wh = sp.get('wh') || 'main';
  const health = useStockHealthLite();
  const options = useWarehouseOptions(f, { health: health.data });

  const [draft, setDraft] = useState<Draft>(() => loadDraft());
  useEffect(() => { saveDraft(draft); }, [draft]);
  const nowLocal = () => toSkopjeDatetimeLocal(new Date());
  const [date, setDate] = useState<string>(() => nowLocal().slice(0, 10));
  const [hm, setHm] = useState<string>(() => nowLocal().slice(11, 16));
  const [hmText, setHmText] = useState(hm);
  const [preview, setPreview] = useState<StockCountResult | null>(null);
  const [saved, setSaved] = useState<StockCountResult | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'save'>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

  const countedAt = fromSkopjeDatetimeLocal(`${date}T${hm}`);
  const inPast = !!countedAt && countedAt.getTime() < Date.now() - 15 * 60_000;
  const inFuture = !!countedAt && countedAt.getTime() > Date.now() + 5 * 60_000;
  const lastCount = useMemo(() => {
    const own = (health.data?.openings ?? []).filter((o) => o.warehouse === wh && o.status === 'approved').map((o) => o.counted_at);
    return own.sort().pop() ?? null;
  }, [health.data, wh]);
  const beforeLast = !!countedAt && !!lastCount && countedAt.getTime() < Date.parse(lastCount);

  const parsed = draft.lines.map((l) => ({ ...l, value: parseQty(l.qty) }));
  const invalid = parsed.filter((l) => l.value === 'invalid' || l.value === null);
  const ready = parsed.filter((l) => typeof l.value === 'number') as (DraftLine & { value: number })[];
  const totalUnits = ready.reduce((a, l) => a + l.value, 0);

  const setLines = (fn: (l: DraftLine[]) => DraftLine[]) => { setDraft((d) => ({ ...d, lines: fn(d.lines) })); setPreview(null); };
  const addArticle = (a: { code: string; name: string }, qty = '') => setLines((ls) => (ls.some((l) => l.code === a.code) ? ls : [...ls, { code: a.code, name: a.name, qty }]));
  const body = (dry: boolean): StockCountRequest => ({
    warehouse: wh,
    counted_at: countedAt ? countedAt.toISOString() : new Date().toISOString(),
    kind: draft.kind,
    lines: ready.map((l) => ({ code: l.code, qty: l.value })),
    packed_counted: draft.packed,
    source: 'manual',
    note: draft.note.trim() || undefined,
    dry,
  });

  const runPreview = async () => {
    setBusy('preview');
    try {
      const r = await apiStockV2Count(body(true));
      setPreview(r);
      // the preview knows every article's name — fill the ones pasted without one
      const names = new Map(r.lines.map((l) => [l.code, l.name]));
      setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.name ? l : { ...l, name: names.get(l.code) ?? '' })) }));
    } catch (e) {
      toast({ title: t('common.error'), description: countErrorText(f, e), variant: 'destructive' });
    } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save');
    try {
      const r = await apiStockV2Count(body(false));
      setSaved(r);
      setPreview(null);
      setDraft(emptyDraft());
      clearDraft();
      toast({ title: t(r.status === 'approved' ? 'stock2.count.savedApproved' : 'stock2.count.savedPending') });
      void qc.invalidateQueries({ queryKey: ['stock2'] });
    } catch (e) {
      toast({ title: t('common.error'), description: countErrorText(f, e), variant: 'destructive' });
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4" data-testid="stock2-count-tab">
      {access.canHealth && <StockV2HealthCard f={f} isOwner={access.isOwner} />}

      <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm" aria-labelledby="stock2-count-title">
        <div className="space-y-1">
          <h2 id="stock2-count-title" className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />{t('stock2.count.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('stock2.count.intro')}</p>
        </div>

        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <WarehousePicker value={wh} onChange={(v) => { setSp((p) => patchParams(p, { wh: v === 'main' ? null : v }), { replace: true }); setPreview(null); }} options={options} f={f} />
          <DmyDateInput value={date} onChange={(v) => { if (v) { setDate(v); setPreview(null); } }} label={t('stock2.count.date')} max={skopjeTodayYmd()} />
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <label htmlFor="stock2-count-hm">{t('stock2.count.time')}</label>
            <Input id="stock2-count-hm" value={hmText} inputMode="numeric" autoComplete="off" placeholder={t('stock2.common.hmPlaceholder')}
              onChange={(e) => setHmText(e.target.value)}
              onBlur={() => { const v = parseHm(hmText); if (v) { setHm(v); setHmText(v); setPreview(null); } else setHmText(hm); }}
              aria-invalid={!parseHm(hmText) || undefined}
              className={cn('h-8 w-[84px] text-xs tabular-nums', !parseHm(hmText) && 'border-red-500')} />
          </div>
          <div className="flex flex-col gap-1">
            <span className={LABEL}>{t('stock2.count.kind')}</span>
            <div role="radiogroup" aria-label={t('stock2.count.kind')} className="inline-flex flex-wrap rounded-lg border p-0.5">
              {KINDS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={draft.kind === k} onClick={() => { setDraft((d) => ({ ...d, kind: k })); setPreview(null); }}
                  className={cn('rounded-md px-2.5 py-1 text-xs', draft.kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                  {t(`stock2.count.kinds.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <label className="flex min-h-8 items-center gap-2 text-xs">
            <Checkbox checked={draft.packed} onCheckedChange={(v) => { setDraft((d) => ({ ...d, packed: v === true })); setPreview(null); }} />
            {t('stock2.count.packedCounted')}
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">{t(`stock2.count.kindHint.${draft.kind}`)} {t('stock2.count.packedHint')}</p>

        {(inPast || inFuture || beforeLast) && (
          <div role="status" className="space-y-0.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {inPast && <p className="flex items-start gap-1.5"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{t('stock2.count.pastWarn', { at: moment(countedAt!.toISOString()) })}</p>}
            {inFuture && <p className="flex items-start gap-1.5"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{t('stock2.count.futureWarn')}</p>}
            {beforeLast && <p className="flex items-start gap-1.5"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{t(access.isOwner ? 'stock2.count.beforeLastOwner' : 'stock2.count.beforeLastOthers', { at: moment(lastCount) })}</p>}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-2">
          <ArticleSearch f={f} onPick={(a) => addArticle(a)} />
          <Button variant="outline" size="sm" className="h-9" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste className="mr-1 h-3.5 w-3.5" aria-hidden />{t('stock2.count.paste')}
          </Button>
          <Button variant="ghost" size="sm" className="h-9" disabled={!draft.lines.length} onClick={() => { setDraft((d) => ({ ...d, lines: [] })); setPreview(null); }}>
            <Eraser className="mr-1 h-3.5 w-3.5" aria-hidden />{t('stock2.count.clear')}
          </Button>
        </div>

        {draft.lines.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">{t('stock2.count.noLines')}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t('stock2.count.lines')}>
            {parsed.map((l) => {
              const bad = l.value === 'invalid' || (l.value === null);
              return (
                <li key={l.code} className="flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="break-words text-sm font-medium">{l.name || t('stock2.count.unknownName')}</p>
                    <p className="text-[11px] text-muted-foreground">{l.code}</p>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Input value={l.qty} inputMode="decimal" placeholder={t('stock2.count.qtyPlaceholder')}
                      aria-label={t('stock2.count.qtyFor', { name: l.name || l.code })} aria-invalid={bad || undefined}
                      onChange={(e) => { const v = e.target.value; setLines((ls) => ls.map((x) => (x.code === l.code ? { ...x, qty: v } : x))); }}
                      className={cn('h-8 w-28 text-right tabular-nums', bad && l.qty !== '' && 'border-red-500')} />
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t('stock2.count.remove', { name: l.name || l.code })}
                      onClick={() => setLines((ls) => ls.filter((x) => x.code !== l.code))}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-1">
          <label htmlFor="stock2-count-note" className="text-xs text-muted-foreground">{t('stock2.count.note')}</label>
          <Textarea id="stock2-count-note" rows={2} maxLength={500} value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <span className="text-xs">{t('stock2.count.summary', { lines: f.int(ready.length), units: fmtQty(totalUnits, f.lang) })}</span>
          {invalid.length > 0 && <span role="alert" className="text-xs font-medium text-red-700 dark:text-red-400">{t('stock2.count.invalid', { n: f.int(invalid.length) })}</span>}
          {!access.isOwner && <span className="text-[11px] text-muted-foreground">{t('stock2.count.pendingNote')}</span>}
          <Button size="sm" className="ml-auto h-8" onClick={() => void runPreview()} disabled={busy !== null || !ready.length || invalid.length > 0 || !countedAt}>
            {busy === 'preview' && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}{t('stock2.count.preview')}
          </Button>
        </div>
      </section>

      {preview && <PreviewResult r={preview} f={f} busy={busy} onSave={() => void save()} onCancel={() => setPreview(null)} />}

      {saved && (
        <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="stock2-count-saved">
          <CheckCircle2 className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <p>{t(saved.status === 'approved' ? 'stock2.count.savedApprovedBody' : 'stock2.count.savedPendingBody', { lines: f.int(saved.totals.lines), diff: fmtSigned(saved.totals.diff, f.lang) })}</p>
        </div>
      )}

      <CountHistory f={f} warehouse={wh} isOwner={access.isOwner} canVoid={access.canCount} fallback={health.data?.openings ?? []} />

      <PasteDialog open={pasteOpen} onClose={() => setPasteOpen(false)} f={f}
        onApply={(lines) => {
          setLines((ls) => {
            const map = new Map(ls.map((l) => [l.code, l]));
            for (const p of lines) map.set(p.code, { code: p.code, name: map.get(p.code)?.name ?? '', qty: fmtQty(p.qty, f.lang) });
            return [...map.values()];
          });
          setPasteOpen(false);
        }} />
    </div>
  );
}

/** The article search: type a code or a name, pick from the api's matches. */
function ArticleSearch({ f, onPick }: { f: InsightsFormat; onPick: (a: StockArticleRow) => void }) {
  const { t } = f;
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = window.setTimeout(() => setDebounced(text.trim()), 250); return () => window.clearTimeout(id); }, [text]);
  const q = useQuery({ queryKey: ['stock2', 'articles', debounced], queryFn: () => apiStockV2Articles(debounced), enabled: debounced.length >= 2, staleTime: 60_000 });
  const rows = (q.data ?? []).slice(0, 8);
  const pick = (a: StockArticleRow) => { onPick(a); setText(''); setOpen(false); };
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div ref={box} className="relative min-w-0 flex-1 basis-64">
      <Search className="absolute left-3 top-[18px] h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={text} placeholder={t('stock2.count.search')} aria-label={t('stock2.count.search')} className="h-9 pl-9"
        role="combobox" aria-expanded={open && rows.length > 0} aria-controls="stock2-count-results" autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const code = text.trim().toUpperCase();
          const exact = rows.find((r) => r.code === code);
          if (exact) pick(exact);
          else if (rows.length === 1) pick(rows[0]);
        }} />
      {open && debounced.length >= 2 && (
        <ul id="stock2-count-results" role="listbox" className="absolute left-0 right-0 top-10 z-30 max-h-72 overflow-auto rounded-lg border bg-popover p-1 text-sm shadow-lg">
          {q.isLoading ? <li className="px-2 py-1.5 text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />{t('stock2.common.loading')}</li>
            : rows.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">{t('stock2.count.noResults')}</li>
              : rows.map((r) => (
                <li key={r.code} role="option" aria-selected={false}>
                  <button type="button" onClick={() => pick(r)} className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted">
                    <span className="min-w-0"><span className="block break-words">{r.name}</span><span className="text-[11px] text-muted-foreground">{r.code}{r.brand ? ` · ${r.brand}` : ''}</span></span>
                    {r.on_hand != null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtQty(r.on_hand, f.lang)}</span>}
                  </button>
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}

function PasteDialog({ open, onClose, onApply, f }: { open: boolean; onClose: () => void; onApply: (l: { code: string; qty: number }[]) => void; f: InsightsFormat }) {
  const { t } = f;
  const [text, setText] = useState('');
  const res = useMemo(() => parsePasted(text), [text]);
  useEffect(() => { if (!open) setText(''); }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('stock2.count.pasteTitle')}</DialogTitle>
          <DialogDescription>{t('stock2.count.pasteBody')}</DialogDescription>
        </DialogHeader>
        <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'100123\t24\n100456\t7'} aria-label={t('stock2.count.pasteTitle')} className="font-mono text-xs" />
        <p className="text-xs">{t('stock2.count.pasteFound', { n: f.int(res.lines.length) })}</p>
        {res.errors.length > 0 && (
          <div role="alert" className="max-h-28 overflow-auto rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <p className="font-medium">{t('stock2.count.pasteErrors', { n: f.int(res.errors.length) })}</p>
            {res.errors.slice(0, 10).map((e) => <p key={e.row} className="break-all">{t('stock2.count.pasteRow', { row: e.row })}: {e.text}</p>)}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!res.lines.length} onClick={() => onApply(res.lines)}><Plus className="mr-1 h-4 w-4" aria-hidden />{t('stock2.count.pasteApply', { n: f.int(res.lines.length) })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewResult({ r, f, busy, onSave, onCancel }: { r: StockCountResult; f: InsightsFormat; busy: null | 'preview' | 'save'; onSave: () => void; onCancel: () => void }) {
  const { t } = f;
  const money = hasKey(r.totals, 'value_diff_mkd') || r.lines.some((l) => hasKey(l, 'value_diff_mkd'));
  const wide = useMinWidth(768);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const lines = onlyDiff ? r.lines.filter((l) => l.diff !== 0) : r.lines;
  const tone = (v: number) => (v > 0 ? 'text-emerald-700 dark:text-emerald-400' : v < 0 ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground');
  return (
    <section className="space-y-3 rounded-xl border-2 border-primary/40 bg-card p-4 shadow-sm" aria-labelledby="stock2-count-preview" data-testid="stock2-count-preview">
      <div className="space-y-0.5">
        <h3 id="stock2-count-preview" className="text-sm font-semibold">{t('stock2.count.previewTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('stock2.count.previewBody')}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t('stock2.count.colSystem')} value={fmtQty(r.totals.system_qty, f.lang)} />
        <Stat label={t('stock2.count.colCounted')} value={fmtQty(r.totals.counted_qty, f.lang)} />
        <Stat label={t('stock2.count.colDiff')} value={fmtSigned(r.totals.diff, f.lang)} tone={tone(r.totals.diff)} />
        {money ? <Stat label={t('stock2.count.colValue')} value={r.totals.value_diff_mkd != null ? f.den(r.totals.value_diff_mkd) : '—'} />
          : <Stat label={t('stock2.count.colLines')} value={f.int(r.totals.lines)} />}
      </ul>
      {r.warnings.length > 0 && (
        <ul role="alert" className="space-y-0.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {r.warnings.map((w) => <li key={w} className="flex items-start gap-1.5"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{warningText(f, w)}</li>)}
        </ul>
      )}
      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={onlyDiff} onCheckedChange={(v) => setOnlyDiff(v === true)} />{t('stock2.count.onlyDiff', { n: f.int(r.lines.filter((l) => l.diff !== 0).length) })}
      </label>
      {lines.length === 0 ? <p className="text-xs text-muted-foreground">{t('stock2.count.noDiff')}</p> : wide ? (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="w-full px-3 py-1.5 font-medium">{t('stock2.col.article')}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('stock2.count.colSystem')}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('stock2.count.colCounted')}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('stock2.count.colDiff')}</th>
                {money && <th scope="col" className="px-2 py-1.5 pr-3 text-right font-medium">{t('stock2.count.colValue')}</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.code} className="border-t">
                  <th scope="row" className="px-3 py-1 text-left font-normal"><span className="break-words">{l.name}</span> <span className="text-muted-foreground">{l.code}</span></th>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{fmtQty(l.system_qty, f.lang)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{fmtQty(l.counted_qty, f.lang)}</td>
                  <td className={cn('whitespace-nowrap px-2 py-1 text-right font-medium tabular-nums', tone(l.diff))}>{fmtSigned(l.diff, f.lang)}</td>
                  {money && <td className="whitespace-nowrap px-2 py-1 pr-3 text-right tabular-nums text-muted-foreground">{l.value_diff_mkd != null ? f.den(l.value_diff_mkd) : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {lines.map((l) => (
            <li key={l.code} className="rounded-lg border p-2 text-xs">
              <p className="break-words font-medium">{l.name} <span className="font-normal text-muted-foreground">{l.code}</span></p>
              <p className="tabular-nums text-muted-foreground">
                {t('stock2.count.colSystem')} {fmtQty(l.system_qty, f.lang)} · {t('stock2.count.colCounted')} {fmtQty(l.counted_qty, f.lang)} ·{' '}
                <b className={tone(l.diff)}>{fmtSigned(l.diff, f.lang)}</b>{money && l.value_diff_mkd != null ? ` · ${f.den(l.value_diff_mkd)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy !== null}>{t('common.cancel')}</Button>
        <Button onClick={onSave} disabled={busy !== null}>
          {busy === 'save' && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}{t('stock2.count.save')}
        </Button>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <li className="min-w-0 rounded-lg border bg-muted/20 p-2">
      <p className="break-words text-[11px] leading-tight text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</p>
    </li>
  );
}

/** The count history of the warehouse — void (with a reason), approve (owners). */
function CountHistory({ f, warehouse, isOwner, canVoid, fallback }: {
  f: InsightsFormat; warehouse: string; isOwner: boolean; canVoid: boolean;
  fallback: { warehouse: string; count_id: string; counted_at: string; status: string; source: string }[];
}) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const q = useQuery<StockCountHistoryRow[]>({ queryKey: ['stock2', 'counts', warehouse], queryFn: () => apiStockV2Counts(warehouse), staleTime: 30_000, retry: 0 });
  const [voiding, setVoiding] = useState<StockCountHistoryRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Until the api lists counts, the openings from the health read stand in.
  const rows: StockCountHistoryRow[] = q.data ?? (q.isError ? fallback.filter((o) => o.warehouse === warehouse).map((o) => ({
    id: o.count_id, warehouse: o.warehouse, counted_at: o.counted_at, kind: 'opening', source: o.source,
    status: (o.status as StockCountHistoryRow['status']) ?? 'approved', packed_counted: false, lines: 0, diff_units: null,
    note: null, created_by_name: null, created_at: o.counted_at, approved_by_name: null, approved_at: null, void_reason: null,
  })) : []);
  const partial = q.isError;

  const approve = async (r: StockCountHistoryRow) => {
    setBusy(r.id);
    try {
      await apiStockV2CountApprove(r.id);
      toast({ title: t('stock2.count.approved') });
      void qc.invalidateQueries({ queryKey: ['stock2'] });
    } catch (e) { toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const doVoid = async () => {
    if (!voiding || reason.trim().length < 5) return;
    setBusy(voiding.id);
    try {
      await apiStockV2CountVoid(voiding.id, reason.trim());
      toast({ title: t('stock2.count.voided') });
      setVoiding(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['stock2'] });
    } catch (e) { toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };

  return (
    <section className="space-y-2" aria-labelledby="stock2-count-history" data-testid="stock2-count-history">
      <h3 id="stock2-count-history" className="text-sm font-medium text-muted-foreground">{t('stock2.count.history', { wh: warehouseName(f, warehouse) })}</h3>
      {partial && <p className="text-[11px] text-muted-foreground">{t('stock2.count.historyPartial')}</p>}
      {q.isLoading ? <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />{t('stock2.common.loading')}</p>
        : rows.length === 0 ? <Empty title={t('stock2.count.historyEmpty')} /> : (
          <ul className="grid gap-2 lg:grid-cols-2">
            {rows.map((r) => (
              <li key={r.id} className={cn('space-y-1 rounded-xl border bg-card p-3 text-xs shadow-sm', r.status === 'void' && 'opacity-70')}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium tabular-nums">{moment(r.counted_at)}</p>
                    <p className="text-muted-foreground">{t(`stock2.count.kinds.${r.kind}`, { defaultValue: r.kind })} · {t(`stock2.count.sources.${r.source}`, { defaultValue: r.source })}{r.packed_counted ? ` · ${t('stock2.count.packedShort')}` : ''}</p>
                  </div>
                  <Pill tone={r.status === 'approved' ? 'emerald' : r.status === 'void' ? 'slate' : 'amber'}>{t(`stock2.countStatus.${r.status}`, { defaultValue: r.status })}</Pill>
                </div>
                {!partial && (
                  <p className="tabular-nums">
                    {t('stock2.count.historyLine', { lines: f.int(r.lines), diff: r.diff_units != null ? fmtSigned(r.diff_units, f.lang) : '—' })}
                    {hasKey(r, 'value_diff_mkd') && r.value_diff_mkd != null ? ` · ${f.den(r.value_diff_mkd)}` : ''}
                  </p>
                )}
                {(r.created_by_name || r.approved_by_name) && (
                  <p className="text-muted-foreground">
                    {[r.created_by_name ? t('stock2.count.by', { name: r.created_by_name }) : null,
                      r.approved_by_name ? t('stock2.count.approvedBy', { name: r.approved_by_name, at: moment(r.approved_at) }) : null].filter(Boolean).join(' · ')}
                  </p>
                )}
                {r.note && <p className="break-words text-muted-foreground">{r.note}</p>}
                {r.status === 'void' && r.void_reason && <p className="break-words text-muted-foreground">{t('stock2.count.voidReasonShown', { reason: r.void_reason })}</p>}
                {r.status !== 'void' && !partial && (canVoid || isOwner) && (
                  <div className="flex flex-wrap justify-end gap-2 pt-1">
                    {isOwner && r.status === 'pending' && (
                      <Button size="sm" className="h-7 text-xs" disabled={busy === r.id} onClick={() => void approve(r)}>
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />{t('stock2.count.approve')}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy === r.id} onClick={() => { setVoiding(r); setReason(''); }}>
                      <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden />{t('stock2.count.void')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

      <Dialog open={!!voiding} onOpenChange={(o) => { if (!o) setVoiding(null); }}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>{t('stock2.count.voidTitle')}</DialogTitle>
            <DialogDescription>{voiding ? t('stock2.count.voidBody', { at: moment(voiding.counted_at) }) : ''}</DialogDescription>
          </DialogHeader>
          <label htmlFor="stock2-void-reason" className="text-xs text-muted-foreground">{t('stock2.count.voidReason')}</label>
          <Textarea id="stock2-void-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setVoiding(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={reason.trim().length < 5 || busy !== null} onClick={() => void doVoid()}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}{t('stock2.count.void')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
