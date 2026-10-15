import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { HeldBadge } from './OrdersList';

// The approval hold (owner 15.10.2026, 20261016150000): a held approval shows "Не се брои — чека MEX / Collab"
// until MEX takes the parcel; nothing on any other order.
beforeAll(async () => {
  await i18n.changeLanguage('mk');
});

describe('HeldBadge', () => {
  it('shows on a held approval with no parcel', async () => {
    render(<HeldBadge o={{ count_held_since: '2026-10-15T10:00:00Z', mex_tracking_id: null }} />);
    const b = await screen.findByTestId('count-held');
    expect(b.textContent).toContain('Не се брои');
    expect(b.getAttribute('title')).toContain('collabBox');
  });

  it('shows nothing without the hold or once a parcel exists', () => {
    const { container: a } = render(<HeldBadge o={{ count_held_since: null, mex_tracking_id: null }} />);
    expect(a.textContent).toBe('');
    const { container: b } = render(<HeldBadge o={{ count_held_since: '2026-10-15T10:00:00Z', mex_tracking_id: '123-9110-1' }} />);
    expect(b.textContent).toBe('');
  });
});
