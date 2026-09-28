import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { CustomerTimeline as TimelineData } from '@/lib/api';
import { formatDenari, formatMoney } from '@/lib/currency';

// Render smoke test: an owner payload shows cash; the same customer without the
// owner-only keys (what the api sends everyone else) shows not one of them.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const timeline = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetCustomerTimeline: (...a: unknown[]) => timeline(...a),
}));

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const { CustomerTimeline } = await import('./CustomerTimeline');

const owner = (): TimelineData => ({
  ok: true, phone8: '76451040', money: true,
  customer: { names: ['Goran Todorovski', 'Горан'], cities: ['Skopje'], first_seen: '2024-06-11T19:28:50Z', last_seen: '2026-09-04T02:29:02Z' },
  summary: {
    orders: 1, sales: 1, dispositions: 0, delivered: 0, returned: 0, cancelled: 1, trashed: 0, open: 0, in_progress: 0,
    web_orders: 1, web_delivered: 1, altercpa_leads: 1, parcels: 1, parcels_delivered: 1, parcels_returned: 0, parcels_mex_only: 1,
    calls: 0, notes: 0, system_notes: 1, lists: ['Never-Converted Recent'], lifetime_delivered_mkd: 2250, paid_orders_eur: 0,
  },
  total_events: 4, truncated: false, kind_counts: { order: 1, web_order: 1, parcel: 1, list: 1 },
  events: [
    { kind: 'list', key: 'l:Never-Converted Recent', at: '2026-09-18T09:55:33Z', title: 'Never-Converted Recent', status: 'waiting' },
    {
      kind: 'order', key: 'o:1', at: '2026-09-04T02:29:02Z', status: 'cancelled', source: 'altercpa', source_detail: 'bridge',
      title: 'Adenofrin', items: [{ name: 'Adenofrin', qty: 1 }], amount_eur: 32.36, cancellation_reason: 'other',
      lead: { altercpa_id: '1472013', decision: 'cancelled', decided_by: 'Zaklina Denik', phase: 4, price_eur: 32.36, webmaster: '2676' },
      system_notes_count: 1, system_notes: [{ at: '2026-09-18T00:54:54Z', who: 'System', text: 'Mirrored from AlterCPA' }],
      refs: { order_id: 'uuid-1', display_id: 'ORD-97278', altercpa_id: '1472013' },
    },
    {
      kind: 'parcel', key: 'p:x', at: '2026-08-24T05:18:20Z', status: 'Delivered', source: 'teleshop', title: '002-9102-174616/2026',
      parcel: { tracking_id: '002-9102-174616/2026', channel: 'teleshop', status_id: 2, status_name: 'Delivered', cod_mkd: 2250, account: 'natura' },
      refs: { tracking_id: '002-9102-174616/2026' },
    },
    {
      kind: 'web_order', key: 'w:1', at: '2024-06-26T14:05:31Z', status: 'delivered', legacy: true, title: 'OC-16546',
      items: [{ name: 'Diet Shake', qty: 2 }], amount_mkd: 1980, refs: { web_number: 'OC-16546' },
    },
  ],
});

/** What a non-owner receives: the api drops every owner-only money key. */
const staff = (): TimelineData => {
  const t = owner();
  t.money = false;
  delete t.summary!.lifetime_delivered_mkd;
  delete t.summary!.paid_orders_eur;
  for (const e of t.events!) {
    delete e.amount_mkd;
    if (e.lead) { delete e.lead.price_eur; delete e.lead.webmaster; }
    if (e.parcel) delete e.parcel.cod_mkd;
  }
  return t;
};

function renderWith(payload: TimelineData, onOpenOrder?: (id: string, d: string) => void) {
  timeline.mockResolvedValue(payload);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CustomerTimeline phone="+38976451040" enabled onOpenOrder={onOpenOrder} />
    </QueryClientProvider>,
  );
}

describe('CustomerTimeline', () => {
  it('shows every kind, the owner’s cash and the CRM price', async () => {
    renderWith(owner());
    expect(await screen.findByText('ORD-97278')).toBeInTheDocument();
    expect(screen.getByText('OC-16546')).toBeInTheDocument();
    expect(screen.getByText('002-9102-174616/2026')).toBeInTheDocument();
    expect(screen.getAllByText('Never-Converted Recent').length).toBeGreaterThan(0);
    expect(screen.getAllByText(formatMoney(32.36))).toHaveLength(2);        // order price + AlterCPA price
    expect(screen.getByText(formatDenari(1980))).toBeInTheDocument();       // web total
    expect(screen.getByText(/2676/)).toBeInTheDocument();                   // webmaster (owner payload carries it)
    expect(screen.getAllByText(formatDenari(2250)).length).toBeGreaterThan(0); // COD + lifetime
    expect(screen.getByText(/Наплатено преку MEX/)).toBeInTheDocument();
    expect(timeline).toHaveBeenCalledWith('+38976451040');
  });

  it('shows no owner-only money to everyone else, but keeps the order price', async () => {
    renderWith(staff());
    expect(await screen.findByText('ORD-97278')).toBeInTheDocument();
    expect(screen.getAllByText(formatMoney(32.36))).toHaveLength(1);        // the order price only
    expect(screen.queryByText(formatDenari(1980))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(formatDenari(2250)))).not.toBeInTheDocument();
    expect(screen.queryByText(/Наплатено преку MEX/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2676/)).not.toBeInTheDocument();
  });

  it('filters by kind and opens an order through the host page', async () => {
    const open = vi.fn();
    renderWith(owner(), open);
    fireEvent.click(await screen.findByText('ORD-97278'));
    expect(open).toHaveBeenCalledWith('uuid-1', 'ORD-97278');
    fireEvent.click(screen.getByRole('button', { name: /MEX пратки/ }));
    expect(screen.queryByText('ORD-97278')).not.toBeInTheDocument();
    expect(screen.getByText('002-9102-174616/2026')).toBeInTheDocument();
  });

  it('refuses a number with fewer than 8 digits without calling the api', () => {
    timeline.mockClear();
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><CustomerTimeline phone="••••••876" enabled /></QueryClientProvider>);
    expect(screen.getByText(/помалку од 8 цифри/)).toBeInTheDocument();
    expect(timeline).not.toHaveBeenCalled();
  });
});
