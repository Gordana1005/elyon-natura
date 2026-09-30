import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiSearchSettlements, type MkSettlement } from '@/lib/api';
import { ResponsiveCombobox, type ComboItem } from './ResponsiveCombobox';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]);
  return d;
}

/** "Карпош 2 · Скопје" / "Кадино · општ. Скопје" / "Битола". */
export function settlementOptionLabel(s: MkSettlement): string {
  if (s.kind === 'city_district' && s.parent_name) return `${s.name} · ${s.parent_name}`;
  const m = (s.municipality || '').trim();
  if (s.kind === 'village' && m && m.toLowerCase() !== s.name.toLowerCase()) return `${s.name} · општ. ${m}`;
  return s.name;
}

/**
 * Град / село — searches Cyrillic and Latin (the server folds both scripts). A
 * district is listed with its city ("Карпош 2 · Скопје"), so typing a
 * neighbourhood finds it directly.
 */
export function CityCombobox({ value, onPick, onClear, disabled, invalid }: {
  value: string;
  onPick: (s: MkSettlement) => void;
  onClear?: () => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const { data = [], isFetching } = useQuery({
    queryKey: ['settlements', q],
    queryFn: () => apiSearchSettlements(q),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
  const items: ComboItem<MkSettlement>[] = (q.length >= 2 ? data : []).map((s) => ({
    key: s.id,
    item: s,
    label: settlementOptionLabel(s),
    hint: s.post_code || undefined,
  }));
  return (
    <ResponsiveCombobox
      id="order-address-city"
      gap="settlement"
      value={value}
      title={t('orderForm.address.cityTitle')}
      placeholder={t('orderForm.address.cityPlaceholder')}
      search={search}
      onSearch={setSearch}
      items={items}
      loading={isFetching && q.length >= 2}
      emptyText={q.length >= 2 ? t('orderForm.address.noMatch') : t('orderForm.address.searchMin')}
      onPick={(s) => { onPick(s); setSearch(''); }}
      onClear={onClear}
      clearLabel={t('orderForm.address.clear')}
      disabled={disabled}
      invalid={invalid}
    />
  );
}
