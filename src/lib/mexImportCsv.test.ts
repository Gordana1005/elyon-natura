// The MEX Poshta portal-import contract, pinned. If any of these fail, the
// exported file will be rejected by (or silently mis-import into) the MEX
// bulk importer — fix the data path, not the assertion.
import { describe, it, expect } from 'vitest';
import { toCsv } from './csv';
import { buildMexImportColumns, MEX_IMPORT_HEADERS, MEX_IMPORT_WEIGHT_KG } from './mexImportCsv';

const csvFor = (orders: any[]) => toCsv(orders, buildMexImportColumns(), ',', false);

const homeOrder = {
  display_id: 'ORD-01234',
  customer_name: 'Ана Марија Петровска',
  customer_phone: '+38976123456',
  street: 'Партизанска',
  street_number: '12',
  floor: '3',
  apartment: '7',
  customer_city: 'Скопје',
  mex_city_name: 'Skopje - Aerodrom',
  delivery_type: 'home',
  delivery_instructions: 'викни по 18ч',
  price: 30.08, // ×61.5 = 1849.92 → codFor rounds to 1850 ден
};

const officeOrder = {
  display_id: 'ORD-00077',
  customer_name: 'Јован Стојановски',
  customer_phone: '070111222',
  delivery_type: 'mex_office',
  courier_office_code: 'SK1',
  courier_office_name: 'МЕХ Центар',
  courier_office_city: 'Скопје',
  mex_city_name: 'Skopje',
  price: 24.39, // ×61.5 = 1499.98 → 1500 ден
};

describe('MEX portal import CSV', () => {
  it('emits the exact 8-column header row the importer expects', () => {
    expect(csvFor([])).toBe('Kod na pratka,Ime,Adresa,Grad,Telefon,Otkup,Opis,Tezina');
  });

  it('home delivery: Latin, digits-only code, comma-free address, integer Otkup', () => {
    const row = csvFor([homeOrder]).split('\r\n')[1];
    expect(row).toBe(
      '01234,Ana Marija Petrovska,Partizanska br. 12 kat 3 stan 7,Skopje - Aerodrom,076123456,1850,vikni po 18ch,'
      + MEX_IMPORT_WEIGHT_KG,
    );
  });

  it('office pickup: the pickup point rides inside the address, Grad is the zone name', () => {
    const row = csvFor([officeOrder]).split('\r\n')[1];
    expect(row).toBe(
      '00077,Jovan Stojanovski,Podiganje: #SK1 MEH Tsentar Skopje,Skopje,070111222,1500,,'
      + MEX_IMPORT_WEIGHT_KG,
    );
  });

  it('never produces a quoted field — a naive importer must read every row as 8 plain cells', () => {
    const nasty = {
      ...homeOrder,
      customer_name: 'Тест, "Јунак"',
      delivery_instructions: 'прво, ѕвони;\nпотоа чекај',
    };
    const csv = csvFor([nasty]);
    expect(csv).not.toContain('"');
    for (const line of csv.split('\r\n')) {
      expect(line.split(',')).toHaveLength(MEX_IMPORT_HEADERS.length);
    }
  });
});
