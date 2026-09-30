import { describe, expect, it } from 'vitest';
import { orderFormGaps, hasCourierAddress, addressRequired, profilePatchFromForm, type OrderFormCheck } from './orderForm';
import { validateOrderForFulfilment } from './fulfilmentValidation';

const base = (over: Partial<OrderFormCheck> = {}): OrderFormCheck => ({
  status: 'confirmed',
  name: 'Ана Петровска',
  phone: '+38970123456',
  itemCount: 1,
  address: {
    delivery_type: 'home', settlement_id: 'osm:n1926166030',
    street: 'Партизанска', street_number: '12', quarter: 'Карпош 2', block: '',
  },
  zone: { requires_district: true, district_id: 'osm:n1926166030' },
  ...over,
});

describe('orderFormGaps — what a CONFIRMED order needs', () => {
  it('a complete Skopje order passes', () => {
    expect(orderFormGaps(base())).toEqual([]);
  });
  it('a place must be PICKED from the list — free text is not enough', () => {
    expect(orderFormGaps(base({ address: { ...base().address, settlement_id: null } }))).toEqual(['settlement']);
  });
  it('Скопје without a district needs one', () => {
    const c = base({ address: { ...base().address, settlement_id: 'osm:n170792214', quarter: '' }, zone: { requires_district: true, district_id: null } });
    expect(orderFormGaps(c)).toEqual(['district']);
  });
  it('a town that is not split needs no district', () => {
    const c = base({ address: { ...base().address, settlement_id: 'osm:n1812231434', quarter: '' }, zone: { requires_district: false, district_id: null } });
    expect(orderFormGaps(c)).toEqual([]);
  });
  it('street + number OR quarter + building (the export rule)', () => {
    const noNumber = base({ address: { ...base().address, street_number: '' } });
    expect(orderFormGaps(noNumber)).toEqual(['street']);
    const building = base({ address: { ...base().address, street: '', street_number: '', block: '14' } });
    expect(orderFormGaps(building)).toEqual([]);
  });
  it('name, phone and a product, in display order', () => {
    expect(orderFormGaps(base({ name: ' ', phone: '', itemCount: 0 }))).toEqual(['name', 'phone', 'products']);
  });
  it('a legacy office order needs its office, not a settlement', () => {
    const c = base({ address: { delivery_type: 'speedy_office', settlement_id: null, street: '', street_number: '', quarter: '', block: '', courier_office_code: '12', courier_office_name: 'X', courier_office_city: '' } });
    expect(orderFormGaps(c)).toEqual(['office']);
  });
  it('call-again, pending, cancel and trash need no address or product', () => {
    for (const status of ['call_again', 'pending', 'cancelled', 'trashed']) {
      const c = base({ status, itemCount: 0, address: { ...base().address, settlement_id: null, street: '', street_number: '' }, zone: null });
      expect(orderFormGaps(c)).toEqual([]);
      expect(addressRequired(status)).toBe(false);
    }
  });
  it('name and phone are still required for every outcome', () => {
    expect(orderFormGaps(base({ status: 'cancelled', name: '' }))).toEqual(['name']);
  });
});

describe('the form agrees with the MEX export', () => {
  it('hasCourierAddress matches validateOrderForFulfilment on the address part', () => {
    const cases = [
      { street: 'Партизанска', street_number: '12', quarter: '', block: '' },
      { street: 'Партизанска', street_number: '', quarter: '', block: '' },
      { street: '', street_number: '', quarter: 'Карпош 2', block: '14' },
      { street: '', street_number: '', quarter: 'Карпош 2', block: '' },
    ];
    for (const a of cases) {
      const exported = validateOrderForFulfilment({
        customer_name: 'Ана Петровска', customer_phone: '+38970123456', postal_code: '1000', price: 20,
        product_name: 'X', quantity: 1, mex_city_id: 176, delivery_type: 'home', ...a,
      });
      expect(hasCourierAddress(a)).toBe(exported.ok);
    }
  });
});

describe('profilePatchFromForm — blanks are never sent (fill-only merge)', () => {
  it('sends only what is filled, never birthday or the profile note', () => {
    const p = profilePatchFromForm({
      phone: ' +38970123456 ', name: 'Ана',
      address: {
        delivery_type: 'home', settlement_id: 'osm:n1926166030', city: 'Скопје', postal_code: '1000',
        street: 'Партизанска', street_number: '', quarter: 'Карпош 2', block: '', entry: '', floor: '', apartment: '3',
        home_courier: 'mex',
      },
    });
    expect(p).toEqual({
      phone: '+38970123456', customer_name: 'Ана', delivery_type: 'home', city: 'Скопје', postal_code: '1000',
      quarter: 'Карпош 2', street: 'Партизанска', apartment: '3', home_courier: 'mex', settlement_id: 'osm:n1926166030',
    });
    expect('birthday' in p).toBe(false);
    expect('notes' in p).toBe(false);
  });
});
