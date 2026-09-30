import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiCreateProduct, apiUpdateProduct } from '@/lib/api';
// Prices are STORED in EUR (frozen MKD_PER_EUR) but the euro is an internal
// accounting unit and must never surface in this Macedonian UI. Both price
// fields therefore take DENARI: the form state holds denars, and the values are
// converted to EUR only at the API boundary in save(), and back again on open.
import { formatMoney, eurToDen, denToEur } from '@/lib/currency';
import type { ProductRow } from './ProductsList';

// Agents' default = website retail (Selling Price) when set, else cost×3 or the
// floor, whichever is larger. Kept in EUR because that is what the server
// computes (the same rule in the products API handler); the callers convert the
// denar form values in and the result out.
const PRICE_FLOOR_EUR = 15;
const suggestedSell = (costEur: number, priceEur: number) =>
  priceEur > 0 ? priceEur : Math.max((costEur || 0) * 3, PRICE_FLOOR_EUR);

const inputClass = 'w-full rounded-lg border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';

/**
 * Add (product = null) or edit a product — the same fields as before the
 * brand-line work (the line itself is set from the list, audited). Cost is
 * admins only (`showCost`). Stock fields are unchanged (stock is deferred by the
 * owner — nothing added).
 */
export function ProductFormDialog({ open, onOpenChange, product, suppliers, showCost, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductRow | null;
  suppliers: { id: string; name: string }[];
  showCost: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const editing = !!product;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [sku, setSku] = useState('');
  const [stock, setStock] = useState('0');
  const [threshold, setThreshold] = useState('5');
  const [supply, setSupply] = useState('15');
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [saving, setSaving] = useState(false);

  // Fill (edit) or reset (add) each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const p = product;
    setName(p?.name ?? '');
    setDesc(p?.description || '');
    setPrice(p ? String(eurToDen(p.price)) : '');
    setCost(p ? String(eurToDen(p.cost_price || 0)) : '');
    setSku(p?.sku || '');
    setStock(p ? String(p.stock_quantity) : '0');
    setThreshold(p ? String(p.low_stock_threshold) : '5');
    setSupply(String(p?.days_of_supply_per_unit ?? 15));
    setCategory(p?.category || '');
    setSupplierId(p?.supplier_id || '');
  }, [open, product]);

  // The two price fields hold DENARI; the API speaks EUR.
  const priceEur = () => denToEur(parseFloat(price) || 0);
  const costEur = () => denToEur(parseFloat(cost) || 0);

  const save = async () => {
    if (!editing && !name.trim()) return;
    setSaving(true);
    const body = {
      name, description: desc, price: priceEur(),
      cost_price: costEur(),
      sku: sku || null, stock_quantity: parseInt(stock) || 0, low_stock_threshold: parseInt(threshold) || 5,
      days_of_supply_per_unit: parseInt(supply) || 15,
      category, supplier_id: supplierId || null,
    };
    try {
      if (product) {
        await apiUpdateProduct(product.id, { ...body, is_active: product.is_active });
        toast({ title: t('products.productUpdated') });
      } else {
        await apiCreateProduct(body);
        toast({ title: t('products.productCreated') });
      }
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const denInput = (value: string, set: (v: string) => void, placeholder: string, tone: string) => (
    <div className="relative">
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} type="number" inputMode="decimal" className={`${inputClass} pr-10`} />
      <span className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm ${tone}`}>ден</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? t('products.editProduct') : t('products.addProduct')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('products.productNameReq')} aria-label={t('products.productNameReq')} className={inputClass} />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('products.description')} aria-label={t('products.description')} className={inputClass} />
          <div className={`grid gap-3 ${showCost ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
            {showCost && (
              <div className="min-w-0">
                <label className="text-xs text-muted-foreground">{t('products.costPriceAdmin')}</label>
                {denInput(cost, setCost, t('products.colCostPrice'), 'text-muted-foreground')}
              </div>
            )}
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">{t('products.sellingPriceDesc')}</label>
              {denInput(price, setPrice, t('products.colSellingPrice'), 'text-primary')}
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {t('products.agentDefaultHint', { amount: formatMoney(suggestedSell(costEur(), priceEur())) })}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">{editing ? t('products.colSku') : t('products.skuAuto')}</label>
              <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder={t('products.colSku')} className={inputClass} />
            </div>
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">{t('products.colCategory')}</label>
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('products.colCategory')} className={inputClass} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('products.colSupplier')}</label>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={inputClass}>
              <option value="">{t('products.noSupplier')}</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">{t('products.stockQty')}</label>
              <input value={stock} onChange={(e) => setStock(e.target.value)} type="number" inputMode="numeric" className={inputClass} />
            </div>
            <div className="min-w-0">
              <label className="text-xs text-muted-foreground">{t('products.lowStockThreshold')}</label>
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" inputMode="numeric" className={inputClass} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('products.daysOfSupply', { defaultValue: 'Days of supply per package' })}</label>
            <input value={supply} onChange={(e) => setSupply(e.target.value)} type="number" inputMode="numeric" className={inputClass} />
            <p className="mt-0.5 text-[10px] text-muted-foreground">{t('products.daysOfSupplyHint', { defaultValue: 'Used by “Due to Reorder” recall. 15 = a 30-capsule pack; a 4-pack = 60.' })}</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={saving}>
            {editing
              ? (saving ? t('products.savingDots') : t('common.save'))
              : (saving ? t('products.creating') : t('products.create'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
