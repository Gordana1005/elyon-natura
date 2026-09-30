import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MkDistrict } from '@/lib/api';
import { normalizeMkGeo } from '@/lib/transliterate';
import { ResponsiveCombobox, type ComboItem } from './ResponsiveCombobox';

/** Local filter: Cyrillic ⇄ Latin, substring on the folded name. */
export function filterDistricts(districts: MkDistrict[], search: string): MkDistrict[] {
  const q = normalizeMkGeo(search);
  if (!q) return districts;
  return districts
    .filter((d) => normalizeMkGeo(d.name).includes(q) || normalizeMkGeo(d.name_lat || '').includes(q))
    .sort((a, b) => {
      const ap = normalizeMkGeo(a.name).startsWith(q) ? 0 : 1;
      const bp = normalizeMkGeo(b.name).startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name, 'mk', { numeric: true });
    });
}

/**
 * Населба — the districts of the picked city with the MEX zone each routes to.
 * REQUIRED (no free text) when the city is split over several zones (Скопје);
 * optional, with "use what I typed", everywhere else.
 */
export function DistrictCombobox({ districts, value, required, loading, onPick, onFreeText, disabled, invalid }: {
  districts: MkDistrict[];
  value: string;
  required: boolean;
  loading?: boolean;
  onPick: (d: MkDistrict) => void;
  onFreeText?: (text: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const items: ComboItem<MkDistrict>[] = useMemo(
    () => filterDistricts(districts, search).map((d) => ({
      key: d.id, item: d, label: d.name, hint: d.mex_city_name || undefined,
    })),
    [districts, search],
  );
  return (
    <ResponsiveCombobox
      id="order-address-district"
      gap="district"
      value={value}
      title={t('orderForm.address.districtTitle')}
      placeholder={t('orderForm.address.districtPlaceholder')}
      search={search}
      onSearch={setSearch}
      items={items}
      loading={loading}
      emptyText={t('orderForm.address.noMatch')}
      onPick={(d) => { onPick(d); setSearch(''); }}
      freeText={!required && onFreeText ? { label: (q) => t('orderForm.address.useTyped', { text: q }), onUse: (q) => { onFreeText(q); setSearch(''); } } : undefined}
      disabled={disabled}
      invalid={invalid}
    />
  );
}
