import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { activityActor, activityText } from './activityFeed';

// The Dashboard activity feed: the api sends an i18n key + structured fields and
// the reader's language builds the sentence. An older api sent only an English
// `description` — that must still render.
describe('activityText / activityActor', () => {
  beforeAll(async () => { await i18n.changeLanguage('mk'); });
  afterAll(async () => { await i18n.changeLanguage('en'); });

  it('status change: order id as data, statuses translated, missing from = new', () => {
    const row = { type: 'status_change', i18n: 'dashboard.feed.statusChange', display_id: 'ORD-1', metadata: { from: null, to: 'confirmed' } };
    expect(activityText(row)).toBe('Ја промени нарачката ORD-1 од нова во Потврдена');
  });

  it('call: outcome and context translated', () => {
    const row = { type: 'call', i18n: 'dashboard.feed.call', metadata: { outcome: 'no_answer', context_type: 'standalone' } };
    expect(activityText(row)).toBe(`Направи повик: ${i18n.t('outcome.no_answer')} (директен повик)`);
  });

  it('note: the excerpt is data, never translated', () => {
    const row = { type: 'note', i18n: 'dashboard.feed.note', display_id: 'ORD-9', note_excerpt: 'Call after 5pm' };
    expect(activityText(row)).toBe('Додаде белешка на ORD-9: „Call after 5pm“');
  });

  it('an older api (English description, no key) renders as sent', () => {
    expect(activityText({ type: 'call', description: 'Made a no_answer call (order)' })).toBe('Made a no_answer call (order)');
    expect(activityActor({ type: 'call', actor: 'Agent' })).toBe('Agent');
  });

  it('unknown actor falls back per type, in the reader\'s language', () => {
    expect(activityActor({ type: 'status_change', actor: null })).toBe('Систем');
    expect(activityActor({ type: 'call', actor: null })).toBe('Агент');
    expect(activityActor({ type: 'note', actor: 'Марија' })).toBe('Марија');
  });
});
