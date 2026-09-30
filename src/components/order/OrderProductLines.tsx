import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProductCombobox } from '@/components/ProductCombobox';
import { EmptyState } from '@/components/EmptyState';
import { cn, formatProductWithQuantity, isLegacyPromoName } from '@/lib/utils';
// Lines are STORED in EUR; the agent only ever sees and types denari.
import { eurToDen, denToEur } from '@/lib/currency';

export interface ProductLine {
  product_id: string | null;
  product_name: string;
  quantity: number;
  price_per_unit: number;
}

/** Agent-facing default unit price: the server's suggested_price, else max(catalogue, €15). Never €0. */
export const PRICE_FLOOR = 15;
export const suggestedFor = (p: any): number =>
  Number(p?.suggested_price) || Math.max(Number(p?.price) || 0, PRICE_FLOOR);

export const lineTotalEur = (i: ProductLine) => Math.max(1, i.quantity) * Math.max(0, i.price_per_unit);
export const linesTotalEur = (items: ProductLine[]) => items.reduce((s, i) => s + lineTotalEur(i), 0);

/**
 * Производи — the order's lines: product (Cyrillic ⇄ Latin search), quantity,
 * unit price and line total in денари (the line total can be typed; the unit
 * price is back-filled). Same behaviour as the old modal, bigger touch targets.
 */
export function OrderProductLines({ items, onChange, products, loading, invalid, disabled }: {
  items: ProductLine[];
  onChange: (items: ProductLine[]) => void;
  products: any[];
  loading?: boolean;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // Raw text while a line total is typed, so the value is not reformatted mid-keystroke.
  const [totalDraft, setTotalDraft] = useState<Record<number, string>>({});
  const update = (idx: number, patch: Partial<ProductLine>) =>
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const add = () => {
    const p = products.find((x) => x.is_active) || products[0];
    if (!p) return;
    onChange([...items, { product_id: p.id, product_name: p.name, quantity: 1, price_per_unit: suggestedFor(p) }]);
  };
  const change = (idx: number, productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (p) update(idx, { product_id: productId, product_name: p.name, price_per_unit: suggestedFor(p) });
  };
  const remove = (idx: number) => onChange(items.filter((_, i) => i !== idx));

  if (loading) return <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden /></div>;

  return (
    <div className="space-y-2" data-gap="products">
      {items.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-4 w-4" />}
          title={t('createOrder.noProducts')}
          size="sm"
          className={cn('border-0 bg-transparent py-2 text-xs', invalid && 'text-destructive')}
        />
      ) : items.map((item, idx) => (
        <div key={idx} className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
          <div className="flex items-start gap-2">
            <ProductCombobox
              products={products}
              value={item.product_id}
              productName={item.product_name}
              onChange={(id) => change(idx, id)}
              disabled={disabled}
              className="min-h-11 flex-1 md:min-h-9"
            />
            {!disabled && (
              <button
                type="button"
                onClick={() => remove(idx)}
                className="inline-flex h-11 w-9 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-destructive md:h-9"
                aria-label={t('common.delete')}
                title={t('common.delete')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="min-w-0">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('createOrder.qty')}</label>
              <Input
                type="number" min={1} value={item.quantity} inputMode="numeric"
                onChange={(e) => update(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                className="h-11 text-center text-base md:h-9 md:text-sm"
                disabled={disabled}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('createOrder.unitEur')}</label>
              <Input
                type="number" min={0} step={1} value={eurToDen(item.price_per_unit)} inputMode="numeric"
                onChange={(e) => update(idx, { price_per_unit: denToEur(Math.max(0, parseFloat(e.target.value) || 0)) })}
                className="h-11 text-right text-base tabular-nums md:h-9 md:text-sm"
                disabled={disabled}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
                {t('createOrder.total')}<span className="sm:hidden"> · ден</span>
              </label>
              <div className="relative">
                <Input
                  type="text" inputMode="numeric"
                  value={totalDraft[idx] ?? String(eurToDen(lineTotalEur(item)))}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTotalDraft((d) => ({ ...d, [idx]: v }));
                    const qty = Math.max(1, item.quantity);
                    update(idx, { price_per_unit: Math.max(0, denToEur(parseFloat(v) || 0)) / qty });
                  }}
                  onBlur={() => setTotalDraft((d) => { const c = { ...d }; delete c[idx]; return c; })}
                  className="h-11 pr-3 text-right text-base font-semibold tabular-nums text-primary sm:pr-9 md:h-9 md:text-sm"
                  disabled={disabled}
                />
                {/* On a phone the unit sits in the label — the suffix would cover the number. */}
                <span className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 text-sm text-primary sm:block">ден</span>
              </div>
            </div>
          </div>
          {isLegacyPromoName(item.product_name, item.product_id) && (
            <span className="inline-block rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300" title={t('createOrder.websiteTitle')}>
              {t('createOrder.website')}
            </span>
          )}
        </div>
      ))}
      {items.length > 0 && (
        <div className="break-words pt-1 text-[10px] text-muted-foreground">
          {t('orderModal.lines')} {items.map((item, idx) => (
            <span key={idx}>
              {idx > 0 && ', '}
              <span className={cn('font-medium', isLegacyPromoName(item.product_name, item.product_id) ? 'text-amber-700' : 'text-foreground')}>
                {formatProductWithQuantity(item.product_name, item.quantity)}
              </span>
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={products.length === 0} className="h-11 w-full gap-1.5 border-dashed text-sm md:h-8 md:text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden /> {t('createOrder.add')}
        </Button>
      )}
    </div>
  );
}
