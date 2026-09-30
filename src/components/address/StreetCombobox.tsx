import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiSearchStreets } from '@/lib/api';
import { ResponsiveCombobox, type ComboItem } from './ResponsiveCombobox';

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v, ms]);
  return d;
}

/**
 * Улица — suggestions from the picked settlement (a district searches its whole
 * city, its own streets first), plus "use what I typed": MEX takes the address as
 * free text, and OpenStreetMap does not know every village lane.
 */
export function StreetCombobox({ value, settlementId, onChange, disabled, invalid }: {
  value: string;
  settlementId: string | null;
  onChange: (street: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 200);
  const { data = [], isFetching } = useQuery({
    queryKey: ['streets', settlementId, q],
    queryFn: () => apiSearchStreets(settlementId as string, q, 'street'),
    enabled: !!settlementId,
    staleTime: 60_000,
  });
  const items: ComboItem<string>[] = (settlementId ? data : []).map((s) => ({ key: s, item: s, label: s }));
  return (
    <ResponsiveCombobox
      id="order-address-street"
      gap="street"
      value={value}
      title={t('orderForm.address.streetTitle')}
      placeholder={settlementId ? t('orderForm.address.streetPlaceholder') : t('orderForm.address.streetPickCity')}
      search={search}
      onSearch={setSearch}
      items={items}
      loading={isFetching && !!settlementId}
      emptyText={t('orderForm.address.typeStreet')}
      onPick={(s) => { onChange(s); setSearch(''); }}
      freeText={{ label: (text) => t('orderForm.address.useTyped', { text }), onUse: (text) => { onChange(text); setSearch(''); } }}
      onClear={value ? () => onChange('') : undefined}
      clearLabel={t('orderForm.address.clear')}
      disabled={disabled}
      invalid={invalid}
    />
  );
}
