import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiCreateProduct, apiSetBrandLine, apiSetProductKind, apiUpdateProduct } from '@/lib/api';
import { formatDenari, formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { BRAND_LINES, LINE_NAMES, LINE_TONES, UNDECIDED_TONE, type BrandLine } from '@/lib/products/brandLines';
import { KIND_TONES, PRODUCT_KINDS, UNDECIDED_KIND_TONE, type ProductKind } from '@/lib/products/kinds';
import {
  denInputToEur, firstError, followUps, formFromRow, suggestedSellEur, toCreateBody, toPatch, validateForm,
  type FormErrors, type FormField, type ProductFormValues,
} from '@/lib/products/productForm';
import type { ProductRow } from './ProductsList';
import { KindBadge, useKindLabel } from './KindChip';
import { LineBadge } from './LineChip';
import { sigmaCostMkd } from './recipe';

const inputBase = 'w-full rounded-lg border bg-background px-3 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/40';
const input = cn(inputBase, 'h-11 md:h-10');
const choice = 'inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Add (product = null) or edit a product — Производи 2.0, in the Insights look.
 * A full-screen sheet on a phone (100dvh), a dialog from sm; the header and the
 * footer (Откажи / Зачувај) stay put while the sections scroll:
 *   Основно  name (wraps — long names are never cut), kind, line, active
 *   Цени     sale price in денари; the purchase cost "Набавна (Сигма)" read-only for owners —
 *            since 01.10.2026 it is the product's recipe × Sigma CalcBuyPrice, never typed in
 *            (products.cost_price is a guarded mirror: the form never sends it)
 *   Код      SKU, barcode
 *   Залиха   quantity, low-stock threshold, days per pack (unchanged fields)
 *   Детали   description, category, supplier
 * Validation is inline; Зачувај goes to the first problem. An edit sends only
 * what changed; the kind and the line go through their audited routes (admins +
 * owners) and a partial failure says exactly what was not saved.
 */
export function ProductFormDialog({ open, onOpenChange, product, suppliers, showCost, canSetKind, canSetLine, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductRow | null;
  suppliers: { id: string; name: string }[];
  showCost: boolean;
  canSetKind: boolean;
  canSetLine: boolean;
  /** After any successful write; `id` = the saved product. */
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const kindLabel = useKindLabel();
  // After a create whose kind / line follow-up failed the form stays open on the CREATED product
  // (a retry edits it — it never creates a second one).
  const [createdId, setCreatedId] = useState<string | null>(null);
  const editingId = product?.id ?? createdId;
  const [initial, setInitial] = useState<ProductFormValues>(() => formFromRow(product));
  const [v, setV] = useState<ProductFormValues>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const refs = useRef<Partial<Record<FormField, HTMLElement | null>>>({});

  useEffect(() => {
    if (!open) return;
    const init = formFromRow(product);
    setInitial(init);
    setV(init);
    setErrors({});
    setTried(false);
    setCreatedId(null);
  }, [open, product]);

  const set = <K extends FormField>(k: K, value: ProductFormValues[K]) => {
    setV((prev) => {
      const next = { ...prev, [k]: value };
      if (tried) setErrors(validateForm(next, { showCost: false }));
      return next;
    });
  };

  const agentDefault = useMemo(
    () => formatMoney(suggestedSellEur(denInputToEur(v.priceDen), product?.cost_price ?? 0)),
    [v.priceDen, product],
  );

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    // the cost is never sent: it follows the recipe and Sigma (trg_products_cost_guard refuses a typed one)
    const errs = validateForm(v, { showCost: false });
    setErrors(errs);
    const first = firstError(errs);
    if (first) {
      refs.current[first]?.focus();
      toast({ title: t('products.form.fixErrors'), variant: 'destructive' });
      return;
    }
    const creating = !editingId;
    const ups = followUps(initial, v, { canSetKind, canSetLine, creating });
    const patch = creating ? null : toPatch(initial, v, { showCost: false });
    if (!creating && patch && Object.keys(patch).length === 0 && !ups.kind && !ups.line) {
      toast({ title: t('products.form.nothingChanged') });
      onOpenChange(false);
      return;
    }
    setSaving(true);
    let id = editingId;
    try {
      if (creating) {
        const created = await apiCreateProduct(toCreateBody(v, { showCost: false }));
        id = String(created?.id ?? '');
        setCreatedId(id);
      } else if (patch && Object.keys(patch).length) {
        await apiUpdateProduct(editingId!, patch);
      }
    } catch (err: unknown) {
      setSaving(false);
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      return;
    }
    // The product itself is saved — the base for any retry is now the saved values.
    const saved = { ...v, kind: initial.kind, line: initial.line };
    const problems: string[] = [];
    if (id && ups.kind) {
      try { await apiSetProductKind([id], ups.kind.kind); saved.kind = v.kind; }
      catch (err: unknown) { problems.push(t('products.form.partialKind', { error: apiErrorText(err) })); }
    }
    if (id && ups.line) {
      try { await apiSetBrandLine([id], ups.line.line); saved.line = v.line; }
      catch (err: unknown) { problems.push(t('products.form.partialLine', { error: apiErrorText(err) })); }
    }
    setSaving(false);
    if (id) onSaved(id);
    if (problems.length) {
      setInitial(saved);
      toast({ title: t('products.form.partialTitle'), description: problems.join(' · '), variant: 'destructive' });
      return;   // stays open: Зачувај retries only what failed
    }
    toast({ title: creating ? t('products.productCreated') : t('products.productUpdated') });
    onOpenChange(false);
  };

  const err = (k: FormField) => (errors[k] ? t(`products.form.errors.${errors[k]}`) : null);
  const reg = (k: FormField) => (el: HTMLElement | null) => { refs.current[k] = el; };
  const title = editingId ? t('products.form.titleEdit') : t('products.form.titleNew');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent
        className={cn(
          'flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0',
          'sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-xl',
        )}
        onOpenAutoFocus={(e) => { e.preventDefault(); refs.current.name?.focus(); }}
      >
        <form onSubmit={save} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="shrink-0 space-y-1 border-b px-4 py-3 pr-12 text-left sm:px-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="break-words">{product?.name || v.name || ' '}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6" data-testid="product-form-body">
            <Section title={t('products.form.sectionBasic')}>
              <Field id="pf-name" label={t('products.form.name')} required error={err('name')}>
                <textarea id="pf-name" ref={reg('name')} rows={2} value={v.name} maxLength={200}
                  onChange={(e) => set('name', e.target.value.replace(/\n/g, ' '))}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                  aria-invalid={!!errors.name} aria-describedby={errors.name ? 'pf-name-err' : undefined}
                  className={cn(inputBase, 'min-h-[2.75rem] resize-none py-2 leading-snug [field-sizing:content]')} />
              </Field>
              <div className="space-y-1.5">
                <span className="text-sm font-medium" id="pf-kind-label">{t('products.form.kind')}</span>
                {canSetKind ? (
                  <div role="radiogroup" aria-labelledby="pf-kind-label" className="flex flex-wrap gap-1.5">
                    {[...PRODUCT_KINDS, null].map((k) => {
                      const on = v.kind === k;
                      return (
                        <button key={k ?? 'none'} type="button" role="radio" aria-checked={on} onClick={() => set('kind', k as ProductKind | null)}
                          className={cn(choice, on ? (k ? KIND_TONES[k] : UNDECIDED_KIND_TONE) : 'bg-card text-muted-foreground hover:bg-muted', on && 'ring-1 ring-foreground/30')}>
                          {kindLabel(k as ProductKind | null)}
                        </button>
                      );
                    })}
                  </div>
                ) : <KindBadge kind={v.kind} size="md" />}
              </div>
              <div className="space-y-1.5">
                <span className="text-sm font-medium" id="pf-line-label">{t('products.form.line')}</span>
                {canSetLine ? (
                  <div role="radiogroup" aria-labelledby="pf-line-label" className="flex flex-wrap gap-1.5">
                    {[...BRAND_LINES, null].map((l) => {
                      const on = v.line === l;
                      return (
                        <button key={l ?? 'none'} type="button" role="radio" aria-checked={on} onClick={() => set('line', l as BrandLine | null)}
                          className={cn(choice, on ? (l ? LINE_TONES[l] : UNDECIDED_TONE) : 'bg-card text-muted-foreground hover:bg-muted', on && 'ring-1 ring-foreground/30')}>
                          {l ? LINE_NAMES[l] : t('products.line.none')}
                        </button>
                      );
                    })}
                  </div>
                ) : <LineBadge line={v.line} size="md" />}
                {(!canSetKind || !canSetLine) && <p className="text-xs text-muted-foreground">{t('products.form.ownersOnly')}</p>}
              </div>
              <label htmlFor="pf-active" className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t('products.form.active')}</span>
                  <span className="block text-xs text-muted-foreground">{t('products.form.activeHint')}</span>
                </span>
                <Switch id="pf-active" checked={v.isActive} onCheckedChange={(on) => set('isActive', on)} />
              </label>
            </Section>

            <Section title={t('products.form.sectionPrices')}>
              <div className={cn('grid gap-3', showCost && 'sm:grid-cols-2')}>
                <Field id="pf-price" label={t('products.form.price')} required error={err('priceDen')} hint={t('products.agentDefaultHint', { amount: agentDefault })}>
                  <DenInput id="pf-price" inputRef={reg('priceDen')} value={v.priceDen} onChange={(s) => set('priceDen', s)} invalid={!!errors.priceDen} tone="text-primary" />
                </Field>
                {showCost && (
                  <Field id="pf-cost" label={t('productsRecipe.form.cost')} hint={t('productsRecipe.form.costHint')}>
                    <output id="pf-cost" className="flex h-11 items-center rounded-lg border border-dashed bg-muted/30 px-3 text-base tabular-nums text-muted-foreground md:h-10 md:text-sm">
                      {(() => { const c = product ? sigmaCostMkd(product) : null; return c == null ? '—' : formatDenari(c); })()}
                    </output>
                  </Field>
                )}
              </div>
            </Section>

            <Section title={t('products.form.sectionCode')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="pf-sku" label={t('products.form.sku')} error={err('sku')} hint={editingId ? undefined : t('products.form.skuHint')}>
                  <input id="pf-sku" ref={reg('sku')} value={v.sku} onChange={(e) => set('sku', e.target.value)} maxLength={50}
                    aria-invalid={!!errors.sku} autoComplete="off" spellCheck={false} className={input} />
                </Field>
                <Field id="pf-barcode" label={t('products.form.barcode')} error={err('barcode')}>
                  <input id="pf-barcode" ref={reg('barcode')} value={v.barcode} onChange={(e) => set('barcode', e.target.value)} maxLength={50}
                    inputMode="numeric" aria-invalid={!!errors.barcode} autoComplete="off" spellCheck={false} className={input} />
                </Field>
              </div>
            </Section>

            <Section title={t('products.form.sectionStock')}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field id="pf-stock" label={t('products.form.stock')} error={err('stock')}>
                  <input id="pf-stock" ref={reg('stock')} value={v.stock} onChange={(e) => set('stock', e.target.value)} inputMode="numeric"
                    aria-invalid={!!errors.stock} className={input} />
                </Field>
                <Field id="pf-threshold" label={t('products.form.threshold')} error={err('threshold')}>
                  <input id="pf-threshold" ref={reg('threshold')} value={v.threshold} onChange={(e) => set('threshold', e.target.value)} inputMode="numeric"
                    aria-invalid={!!errors.threshold} className={input} />
                </Field>
                <div className="col-span-2 sm:col-span-1">
                  <Field id="pf-supply" label={t('products.form.supply')} error={err('supply')}>
                    <input id="pf-supply" ref={reg('supply')} value={v.supply} onChange={(e) => set('supply', e.target.value)} inputMode="numeric"
                      aria-invalid={!!errors.supply} className={input} />
                  </Field>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('products.daysOfSupplyHint')}</p>
            </Section>

            <Section title={t('products.form.sectionDetails')}>
              <Field id="pf-description" label={t('products.form.description')} error={err('description')}>
                <textarea id="pf-description" ref={reg('description')} rows={3} value={v.description} maxLength={2000}
                  onChange={(e) => set('description', e.target.value)} aria-invalid={!!errors.description}
                  className={cn(inputBase, 'min-h-[4.5rem] resize-y py-2 leading-snug')} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="pf-category" label={t('products.form.category')} error={err('category')}>
                  <input id="pf-category" ref={reg('category')} value={v.category} onChange={(e) => set('category', e.target.value)} maxLength={200}
                    aria-invalid={!!errors.category} className={input} />
                </Field>
                <Field id="pf-supplier" label={t('products.form.supplier')}>
                  <select id="pf-supplier" ref={reg('supplierId')} value={v.supplierId} onChange={(e) => set('supplierId', e.target.value)} className={input}>
                    <option value="">{t('products.noSupplier')}</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              </div>
            </Section>
          </div>

          <div className="flex shrink-0 gap-2 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-end sm:px-6">
            <Button type="button" variant="outline" className="h-11 flex-1 sm:h-10 sm:flex-none" onClick={() => onOpenChange(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" className="h-11 flex-1 sm:h-10 sm:flex-none" disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
              {saving ? t('products.savingDots') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ id, label, required, error, hint, children }: {
  id: string; label: string; required?: boolean; error?: string | null; hint?: string; children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}{required && <span aria-hidden className="text-destructive"> *</span>}
      </label>
      {children}
      {error ? <p id={`${id}-err`} role="alert" className="text-xs text-destructive">{error}</p>
        : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DenInput({ id, value, onChange, invalid, tone, inputRef }: {
  id: string; value: string; onChange: (s: string) => void; invalid: boolean; tone: string; inputRef: (el: HTMLElement | null) => void;
}) {
  return (
    <div className="relative">
      <input id={id} ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" autoComplete="off"
        aria-invalid={invalid} className={cn(input, 'pr-12 tabular-nums')} />
      <span className={cn('pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm', tone)}>ден</span>
    </div>
  );
}
