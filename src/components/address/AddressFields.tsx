import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Home, Lock, Loader2, MapPin, Plus, Truck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { apiGetCourierCities } from '@/lib/api';
import { splitTrailingHouseNumber, composeHomeAddress } from '@/lib/address';
import { DeliveryMethodPicker } from '@/components/DeliveryMethodPicker';
import { isOfficeDelivery, type OrderFormGap } from '@/lib/orderForm';
import { CityCombobox } from './CityCombobox';
import { DistrictCombobox } from './DistrictCombobox';
import { StreetCombobox } from './StreetCombobox';
import { ZoneChip } from './MexPreview';
import { settlementLabel, type AddressDraft, type AddressResolution } from './useAddressResolution';

const LEGACY = ['speedy', 'econt'];

function Field({ label, children, className, htmlFor }: { label: string; children: React.ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

const inputCls = 'h-11 text-base md:h-9 md:text-sm';

/**
 * The address block of the order form (Create / Confirm / Edit):
 *   Град / село*  (search, Cyrillic + Latin; a district row picks its city too)
 *   Населба*      (only when the city is split over several MEX zones — Скопје)
 *   Улица + број
 *   + зграда / влез / кат / стан  (collapsed unless prefilled)
 *   postcode chip (always from the settlement; editable only when it has none)
 *   "MEX зона: …" chip — red when there is no zone
 * `locked` (the parcel is already at MEX) renders the same facts read-only.
 * A legacy office order keeps the old office picker; the Home / Office pills show
 * only when MEX offices exist or the order already is an office order.
 */
export function AddressFields({ value, onChange, resolution, gaps = [], locked, disabled }: {
  value: AddressDraft;
  onChange: (v: AddressDraft) => void;
  resolution: AddressResolution;
  gaps?: OrderFormGap[];
  locked?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const r = resolution;
  const [moreOpen, setMoreOpen] = useState(false);
  const partsPrefilled = !!(value.block || value.entry || value.floor || value.apartment);
  const showParts = moreOpen || partsPrefilled;
  const set = <K extends keyof AddressDraft>(k: K, v: AddressDraft[K]) => onChange({ ...value, [k]: v });

  const { data: mexOffices = [] } = useQuery({
    queryKey: ['courier-cities', 'mex', ''],
    queryFn: () => apiGetCourierCities('mex', '', 1),
    staleTime: 10 * 60_000,
    enabled: !locked,
  });
  const office = isOfficeDelivery(value.delivery_type);
  const showPills = !locked && (mexOffices.length > 0 || office);
  const legacyCourier = LEGACY.includes(value.home_courier) ? (value.home_courier === 'speedy' ? 'Speedy' : 'Econt') : null;

  if (locked) {
    return (
      <div className="space-y-2" data-testid="address-locked">
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('orderForm.address.locked')}</span>
        </div>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="font-medium break-words">{office
            ? `${value.courier_office_city} — #${value.courier_office_code} ${value.courier_office_name}`
            : [value.city, value.postal_code].filter(Boolean).join(' · ')}</div>
          {!office && <div className="mt-0.5 break-words text-muted-foreground">{composeHomeAddress(value) || '—'}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showPills && (
        <div className="grid grid-cols-2 gap-2">
          {([['home', Home, t('delivery.homeAddress')], ['mex_office', Truck, t('delivery.office')]] as const).map(([kind, Icon, label]) => {
            const active = kind === 'home' ? !office : office;
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => {
                  if (active) return;
                  onChange(kind === 'home'
                    ? { ...value, delivery_type: 'home' }
                    : { ...value, delivery_type: 'mex_office', courier_office_code: '', courier_office_name: '', courier_office_city: '' });
                }}
                className={cn(
                  'inline-flex h-11 items-center justify-center gap-1.5 rounded-md border-2 text-sm font-medium md:h-9 md:text-xs',
                  active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </button>
            );
          })}
        </div>
      )}

      {office ? (
        // A legacy (or future MEX) office order keeps the office picker.
        <div data-gap="office"><DeliveryMethodPicker value={value} onChange={(v) => onChange({ ...value, ...v })} disabled={disabled} /></div>
      ) : (
        <>
          {legacyCourier && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              {t('delivery.legacyCourierNote', { courier: legacyCourier })}
            </div>
          )}

          <Field label={t('orderForm.address.city')} htmlFor="order-address-city">
            <CityCombobox
              value={value.city}
              onPick={r.pickSettlement}
              onClear={value.city ? r.clear : undefined}
              disabled={disabled}
              invalid={gaps.includes('settlement')}
            />
          </Field>

          {r.resolving && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {t('orderForm.address.resolving')}
            </p>
          )}

          {r.candidates && r.candidates.length > 0 && (
            <div className="space-y-1.5" data-testid="address-candidates">
              <p className="text-xs text-amber-800 dark:text-amber-300">{t('orderForm.address.whichPlace', { text: value.city })}</p>
              <div className="flex flex-wrap gap-1.5">
                {r.candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => r.pickCandidate(c)}
                    className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full border bg-background px-3 py-1 text-left text-xs hover:bg-muted"
                  >
                    <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="break-words">
                      {c.kind === 'city_district' ? `${c.name} · ${c.parent_name ?? ''}` : settlementLabel(c).replace(', општ.', ' · општ.')}
                      {c.mex_city_name ? ` → ${c.mex_city_name}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {!value.settlement_id && !r.resolving && !r.candidates && value.city && (
            <p className="text-xs text-red-700 dark:text-red-300">{t('orderForm.address.unresolved', { text: value.city })}</p>
          )}

          {value.settlement_id && r.districts.length > 0 && (
            <Field
              label={r.requiresDistrict ? t('orderForm.address.districtRequired') : t('orderForm.address.district')}
              htmlFor="order-address-district"
            >
              <DistrictCombobox
                districts={r.districts}
                value={value.quarter}
                required={r.requiresDistrict}
                loading={r.districtsLoading}
                onPick={r.pickDistrict}
                onFreeText={(q) => set('quarter', q)}
                disabled={disabled}
                invalid={gaps.includes('district')}
              />
              {r.requiresDistrict && !r.zone?.district_id && (
                <p className="text-xs text-muted-foreground">{t('orderForm.address.districtHint', { city: r.zone?.city_name ?? value.city })}</p>
              )}
            </Field>
          )}
          {value.settlement_id && r.districts.length === 0 && (value.quarter || !r.zoneLoading) && (
            <Field label={t('orderForm.address.district')} htmlFor="order-address-quarter">
              <Input id="order-address-quarter" value={value.quarter} onChange={(e) => set('quarter', e.target.value)} className={inputCls} disabled={disabled} />
            </Field>
          )}

          <div className="flex gap-2">
            <Field label={t('orderForm.address.street')} className="flex-1" htmlFor="order-address-street">
              <StreetCombobox
                value={value.street}
                settlementId={value.settlement_id}
                onChange={(street) => onChange(splitTrailingHouseNumber({ ...value, street }))}
                disabled={disabled}
                invalid={gaps.includes('street')}
              />
            </Field>
            <Field label={t('orderForm.address.number')} className="w-20 shrink-0 sm:w-24" htmlFor="order-address-number">
              <Input
                id="order-address-number"
                value={value.street_number}
                onChange={(e) => set('street_number', e.target.value)}
                className={cn(inputCls, gaps.includes('street') && !value.street_number && 'border-destructive')}
                inputMode="text"
                disabled={disabled}
              />
            </Field>
          </div>

          {showParts ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(['block', 'entry', 'floor', 'apartment'] as const).map((k) => (
                <Field key={k} label={t(`orderForm.address.${k}`)} htmlFor={`order-address-${k}`}>
                  <Input id={`order-address-${k}`} value={value[k]} onChange={(e) => set(k, e.target.value)} className={inputCls} disabled={disabled} />
                </Field>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              disabled={disabled}
              className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <Plus className="h-3 w-3" aria-hidden /> {t('orderForm.address.moreParts')}
            </button>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {value.settlement_id && r.zone && !r.zone.post_code ? (
              <div className="flex items-center gap-1.5">
                <label htmlFor="order-address-postcode" className="text-xs text-muted-foreground">{t('orderForm.address.postcode')}</label>
                <Input
                  id="order-address-postcode"
                  value={value.postal_code}
                  onChange={(e) => set('postal_code', e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="h-9 w-20 text-sm"
                  inputMode="numeric"
                  disabled={disabled}
                />
              </div>
            ) : (
              <span
                data-testid="postcode-chip"
                className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                title={t('orderForm.address.postcode')}
              >
                {t('orderForm.address.postcode')}: <span className="font-mono text-foreground">{value.postal_code || '—'}</span>
              </span>
            )}
            <ZoneChip zoneName={value.settlement_id ? r.zone?.mex_city_name ?? null : null} loading={r.zoneLoading || r.resolving} />
          </div>
        </>
      )}
    </div>
  );
}
