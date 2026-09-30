import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MexZoneResolution, MkSettlement } from '@/lib/api';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const api = vi.hoisted(() => ({
  apiGetSettlementZone: vi.fn(),
  apiResolveAddress: vi.fn(),
  apiGetDistricts: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

import {
  useAddressResolution, settlementLabel, applySettlementPick, applyDistrictPick, applyCandidate, applyResolution,
  clearCity, EMPTY_ADDRESS, type AddressDraft,
} from './useAddressResolution';

const SKOPJE: MexZoneResolution = {
  city_id: 'osm:n170792214', city_name: 'Скопје', district_id: null, district_name: null, post_code: '1000',
  mex_city_id: 185, mex_city_name: 'Skopje - Centar', requires_district: true, basis: 'city_default', city_kind: 'city', municipality: 'Скопје',
};
const KARPOS2: MexZoneResolution = {
  ...SKOPJE, district_id: 'osm:n1926166030', district_name: 'Карпош 2', mex_city_id: 176, mex_city_name: 'Skopje - Karpoš', basis: 'district',
};

describe('pure draft helpers', () => {
  it('labels a village with its nearest town, a city plainly', () => {
    expect(settlementLabel({ name: 'Кадино', kind: 'village', municipality: 'Скопје' })).toBe('Кадино, општ. Скопје');
    expect(settlementLabel({ name: 'Битола', kind: 'city', municipality: 'Битола' })).toBe('Битола');
    expect(settlementLabel({ name: 'Струга', kind: 'town', municipality: 'Струга' })).toBe('Струга');
  });
  it('picking a district row sets the city AND the district', () => {
    const s = { id: 'osm:n1926166030', name: 'Карпош 2', kind: 'city_district', parent_name: 'Скопје', post_code: '1000' } as MkSettlement;
    expect(applySettlementPick(EMPTY_ADDRESS, s)).toMatchObject({ settlement_id: 'osm:n1926166030', city: 'Скопје', quarter: 'Карпош 2', postal_code: '1000' });
  });
  it('picking another city clears the old district and takes its postcode', () => {
    const d: AddressDraft = { ...EMPTY_ADDRESS, settlement_id: 'osm:n1926166030', city: 'Скопје', quarter: 'Карпош 2', postal_code: '1000' };
    const bitola = { id: 'osm:n1812231434', name: 'Битола', kind: 'city', municipality: 'Битола', post_code: '7000' } as MkSettlement;
    expect(applySettlementPick(d, bitola)).toMatchObject({ settlement_id: 'osm:n1812231434', city: 'Битола', quarter: '', postal_code: '7000' });
  });
  it('district and candidate picks', () => {
    const d: AddressDraft = { ...EMPTY_ADDRESS, settlement_id: 'osm:n170792214', city: 'Скопје' };
    expect(applyDistrictPick(d, { id: 'osm:n1926166030', name: 'Карпош 2', post_code: '1000' })).toMatchObject({ settlement_id: 'osm:n1926166030', quarter: 'Карпош 2', postal_code: '1000' });
    expect(applyCandidate(EMPTY_ADDRESS, { id: 'v1', name: 'Сушица', kind: 'village', parent_name: null, municipality: 'Струмица', post_code: '2400', mex_city_id: 114, mex_city_name: 'Strumica' }))
      .toMatchObject({ settlement_id: 'v1', city: 'Сушица, општ. Струмица', postal_code: '2400' });
  });
  it('a resolution normalises the city and keeps the street', () => {
    const d: AddressDraft = { ...EMPTY_ADDRESS, city: 'Skopje', quarter: 'Карпош 2', street: 'Партизанска', postal_code: '' };
    expect(applyResolution(d, KARPOS2)).toMatchObject({ settlement_id: 'osm:n1926166030', city: 'Скопје', quarter: 'Карпош 2', street: 'Партизанска', postal_code: '1000' });
    expect(applyResolution(d, { ...SKOPJE, city_id: null })).toBe(d);
  });
  it('clearing the city clears what depended on it', () => {
    expect(clearCity({ ...EMPTY_ADDRESS, settlement_id: 'x', city: 'Скопје', quarter: 'Карпош 2', postal_code: '1000', street: 'A' }))
      .toMatchObject({ settlement_id: null, city: '', quarter: '', postal_code: '', street: 'A' });
  });
});

function setup(initial: AddressDraft = EMPTY_ADDRESS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => {
    const [value, setValue] = useState<AddressDraft>(initial);
    const r = useAddressResolution(value, setValue);
    return { value, r };
  }, { wrapper });
}

describe('useAddressResolution', () => {
  beforeEach(() => {
    api.apiGetSettlementZone.mockReset();
    api.apiResolveAddress.mockReset();
    api.apiGetDistricts.mockReset().mockResolvedValue([
      { id: 'osm:n1929253980', name: 'Центар', name_lat: 'Centar', post_code: '1000', mex_city_id: 185, mex_city_name: 'Skopje - Centar' },
      { id: 'osm:n1926166030', name: 'Карпош 2', name_lat: 'Karpoš 2', post_code: '1000', mex_city_id: 176, mex_city_name: 'Skopje - Karpoš' },
    ]);
  });

  it('a prefilled "Скопје" is resolved: postcode filled, district required', async () => {
    api.apiResolveAddress.mockResolvedValue({ ...SKOPJE, match: 'settlement' });
    api.apiGetSettlementZone.mockResolvedValue(SKOPJE);
    const { result } = setup();
    await act(async () => { await result.current.r.hydrate({ ...EMPTY_ADDRESS, city: 'Skopje', street: 'Партизанска', street_number: '5' }); });
    await waitFor(() => expect(result.current.r.zone?.city_id).toBe('osm:n170792214'));
    expect(api.apiResolveAddress).toHaveBeenCalledWith('Skopje', null);
    expect(result.current.value).toMatchObject({ settlement_id: 'osm:n170792214', city: 'Скопје', postal_code: '1000', street: 'Партизанска' });
    expect(result.current.r.requiresDistrict).toBe(true);
    await waitFor(() => expect(result.current.r.districts).toHaveLength(2));
  });

  it('a stored settlement_id is used directly — no text resolution', async () => {
    api.apiGetSettlementZone.mockResolvedValue(KARPOS2);
    const { result } = setup();
    await act(async () => { await result.current.r.hydrate({ ...EMPTY_ADDRESS, city: 'whatever', settlement_id: 'osm:n1926166030' }); });
    expect(api.apiResolveAddress).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.r.zone?.mex_city_name).toBe('Skopje - Karpoš'));
    expect(result.current.value).toMatchObject({ city: 'Скопје', quarter: 'Карпош 2', postal_code: '1000' });
  });

  it('an ambiguous name shows the places and routes nowhere', async () => {
    api.apiResolveAddress.mockResolvedValue({
      ...SKOPJE, city_id: null, city_name: null, mex_city_id: null, mex_city_name: null, basis: null, match: 'ambiguous',
      candidates: [
        { id: 'a', name: 'Сушица', kind: 'village', parent_name: null, municipality: 'Струмица', post_code: '2400', mex_city_id: 114, mex_city_name: 'Strumica' },
        { id: 'b', name: 'Сушица', kind: 'village', parent_name: null, municipality: 'Гостивар', post_code: '1230', mex_city_id: 120, mex_city_name: 'Gostivar' },
      ],
    });
    api.apiGetSettlementZone.mockResolvedValue({
      ...SKOPJE, city_id: 'a', city_name: 'Сушица', post_code: '2400', mex_city_id: 114, mex_city_name: 'Strumica',
      requires_district: false, basis: 'settlement', city_kind: 'village', municipality: 'Струмица',
    });
    const { result } = setup();
    await act(async () => { await result.current.r.hydrate({ ...EMPTY_ADDRESS, city: 'с. Сушица' }); });
    expect(result.current.r.candidates).toHaveLength(2);
    expect(result.current.value.settlement_id).toBeNull();
    act(() => result.current.r.pickCandidate(result.current.r.candidates![0]));
    expect(result.current.value).toMatchObject({ settlement_id: 'a', city: 'Сушица, општ. Струмица' });
    expect(result.current.r.candidates).toBeNull();
  });

  it('the postcode always follows the picked settlement, even over a stale prefill', async () => {
    api.apiGetSettlementZone.mockResolvedValue(KARPOS2);
    const { result } = setup({ ...EMPTY_ADDRESS, settlement_id: 'osm:n1926166030', city: 'Скопје', postal_code: '1060' });
    await waitFor(() => expect(result.current.value.postal_code).toBe('1000'));
  });

  it('an office order is not resolved', async () => {
    const { result } = setup();
    await act(async () => { await result.current.r.hydrate({ ...EMPTY_ADDRESS, delivery_type: 'speedy_office', city: 'Скопје' }); });
    expect(api.apiResolveAddress).not.toHaveBeenCalled();
    expect(result.current.value.delivery_type).toBe('speedy_office');
  });
});
