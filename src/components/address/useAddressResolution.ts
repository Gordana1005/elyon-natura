// The order form's address state (Phase 6, plan 30.09).
//
// The draft carries `settlement_id` — the row the agent PICKED from the list (the
// district when the city needs one). Everything MEX cares about follows from it
// on the SERVER (GET /address/settlement/:id → the ONE resolver in SQL): the city,
// the district, the postcode and the zone. The form never computes a zone itself,
// so what the agent sees in "MEX зона" is exactly what the order will be stored
// with.
//
// Opening an order: its (or the profile's) settlement_id when there is one, else
// the free text goes through GET /address/resolve — a clear answer fills the
// fields, an ambiguous name ("с. Сушица") shows the places to pick from, and
// nothing is guessed.
//
// Replaces the DeliveryMethodPicker prefill whose regex stripped the С of
// Скопје and whose postcode was filled only on an explicit city pick (61%).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeliveryValue } from '@/components/DeliveryMethodPicker';
import {
  apiGetDistricts, apiGetSettlementZone, apiResolveAddress,
  type MexZoneCandidate, type MexZoneResolution, type MkDistrict, type MkSettlement,
} from '@/lib/api';

export interface AddressDraft extends DeliveryValue {
  /** The picked mk_settlements row (a district when the city needs one), or null. */
  settlement_id: string | null;
}

export const EMPTY_ADDRESS: AddressDraft = {
  delivery_type: 'home',
  street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
  home_courier: 'mex',
  courier_office_code: '', courier_office_name: '', courier_office_city: '',
  settlement_id: null,
};

/**
 * The City field's text: "Кадино, општ. Скопје" for a village whose nearest town
 * differs (Macedonia repeats village names), the plain name otherwise.
 */
export function settlementLabel(s: { name: string; kind?: string | null; municipality?: string | null }): string {
  const m = (s.municipality || '').trim();
  if (s.kind === 'village' && m && m.toLowerCase() !== s.name.toLowerCase()) return `${s.name}, општ. ${m}`;
  return s.name;
}

/** A row of the city search picked. A district row ("Карпош 2 · Скопје") sets the city AND the district. */
export function applySettlementPick(d: AddressDraft, s: MkSettlement): AddressDraft {
  if (s.kind === 'city_district') {
    return { ...d, settlement_id: s.id, city: s.parent_name || d.city, quarter: s.name, postal_code: s.post_code || d.postal_code };
  }
  const same = s.id === d.settlement_id;
  return { ...d, settlement_id: s.id, city: settlementLabel(s), quarter: same ? d.quarter : '', postal_code: s.post_code || '' };
}

/** A district of the current city picked. */
export function applyDistrictPick(d: AddressDraft, dist: Pick<MkDistrict, 'id' | 'name' | 'post_code'>): AddressDraft {
  return { ...d, settlement_id: dist.id, quarter: dist.name, postal_code: dist.post_code || d.postal_code };
}

/** One of the "which place?" chips picked. */
export function applyCandidate(d: AddressDraft, c: MexZoneCandidate): AddressDraft {
  if (c.kind === 'city_district') {
    return { ...d, settlement_id: c.id, city: c.parent_name || d.city, quarter: c.name, postal_code: c.post_code || d.postal_code };
  }
  return { ...d, settlement_id: c.id, city: settlementLabel(c), quarter: '', postal_code: c.post_code || '' };
}

/** The server's answer for a prefilled address → the draft (canonical city label, district, postcode). */
export function applyResolution(d: AddressDraft, r: MexZoneResolution): AddressDraft {
  if (!r.city_id || !r.city_name) return d;
  return {
    ...d,
    settlement_id: r.district_id || r.city_id,
    city: settlementLabel({ name: r.city_name, kind: r.city_kind, municipality: r.municipality }),
    quarter: r.district_name || d.quarter,
    postal_code: r.post_code || d.postal_code,
  };
}

/** The city cleared: nothing picked, so no zone, no district, no postcode. */
export const clearCity = (d: AddressDraft): AddressDraft =>
  ({ ...d, settlement_id: null, city: '', quarter: '', postal_code: '' });

export interface AddressResolution {
  /** The server's answer for the picked settlement (null while nothing is picked / loading). */
  zone: MexZoneResolution | null;
  zoneLoading: boolean;
  /** The city's visible districts (Скопје: Центар, Карпош 1–4, …). */
  districts: MkDistrict[];
  districtsLoading: boolean;
  requiresDistrict: boolean;
  /** Places an ambiguous prefilled name could mean — the form shows them as chips. */
  candidates: MexZoneCandidate[] | null;
  resolving: boolean;
  pickSettlement: (s: MkSettlement) => void;
  pickDistrict: (d: MkDistrict) => void;
  pickCandidate: (c: MexZoneCandidate) => void;
  clear: () => void;
  /** Set a prefilled draft and resolve it (its settlement_id, else its city + quarter text). */
  hydrate: (base: AddressDraft) => Promise<void>;
}

export function useAddressResolution(value: AddressDraft, onChange: (v: AddressDraft) => void): AddressResolution {
  const qc = useQueryClient();
  // The newest draft: the rendered value, or a base handed to hydrate() before
  // the parent re-rendered with it.
  const latest = useRef(value);
  latest.current = value;
  const emit = useRef(onChange);
  emit.current = onChange;
  const seq = useRef(0);
  const [candidates, setCandidates] = useState<MexZoneCandidate[] | null>(null);
  const [resolving, setResolving] = useState(false);

  const sid = value.settlement_id;
  const zoneQ = useQuery({
    queryKey: ['address-settlement', sid],
    queryFn: () => apiGetSettlementZone(sid as string),
    enabled: !!sid,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const zone = sid ? zoneQ.data ?? null : null;
  const cityId = zone?.city_id ?? null;
  const districtsQ = useQuery({
    queryKey: ['address-districts', cityId],
    queryFn: () => apiGetDistricts(cityId as string),
    enabled: !!cityId,
    staleTime: 30 * 60_000,
  });

  // The postcode ALWAYS follows the picked settlement — also when the order was
  // prefilled (the old form filled it only on an explicit pick: 61% had one).
  const pc = zone?.post_code || null;
  useEffect(() => {
    if (!pc || latest.current.settlement_id !== sid) return;
    if (latest.current.postal_code !== pc) emit.current({ ...latest.current, postal_code: pc });
  }, [pc, sid]);

  const commit = useCallback((next: AddressDraft) => {
    seq.current++;
    setCandidates(null);
    setResolving(false);
    latest.current = next;
    emit.current(next);
  }, []);

  const pickSettlement = useCallback((s: MkSettlement) => commit(applySettlementPick(latest.current, s)), [commit]);
  const pickDistrict = useCallback((d: MkDistrict) => commit(applyDistrictPick(latest.current, d)), [commit]);
  const pickCandidate = useCallback((c: MexZoneCandidate) => commit(applyCandidate(latest.current, c)), [commit]);
  const clear = useCallback(() => commit(clearCity(latest.current)), [commit]);

  const hydrate = useCallback(async (base: AddressDraft) => {
    const my = ++seq.current;
    setCandidates(null);
    latest.current = base;
    emit.current(base);
    const city = (base.city || '').trim();
    if (base.delivery_type !== 'home' || (!base.settlement_id && !city)) { setResolving(false); return; }
    setResolving(true);
    try {
      let r: MexZoneResolution | null = null;
      if (base.settlement_id) {
        const id = base.settlement_id;
        r = await qc.fetchQuery({ queryKey: ['address-settlement', id], queryFn: () => apiGetSettlementZone(id), staleTime: 10 * 60_000 })
          .catch(() => null);
      }
      if (!r?.city_id && city) r = await apiResolveAddress(city, base.quarter || null).catch(() => null);
      if (my !== seq.current) return;
      if (r?.city_id) emit.current(applyResolution(latest.current, r));
      else if (r?.match === 'ambiguous') setCandidates(r.candidates ?? []);
      else if (latest.current.settlement_id) emit.current({ ...latest.current, settlement_id: null });
    } finally {
      if (my === seq.current) setResolving(false);
    }
  }, [qc]);

  return {
    zone,
    zoneLoading: !!sid && zoneQ.isLoading,
    districts: districtsQ.data ?? [],
    districtsLoading: districtsQ.isLoading && !!cityId,
    requiresDistrict: !!zone?.requires_district,
    candidates,
    resolving,
    pickSettlement, pickDistrict, pickCandidate, clear, hydrate,
  };
}
