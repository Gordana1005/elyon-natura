import { describe, expect, it } from 'vitest';
import type { CustomerTimeline, TimelineEvent } from '@/lib/api';
import {
  decisionKey, decisionTone, differentName, filterEvents, formatSeconds, formatSkopje, kindCounts, parcelTone, sourceKey, webOutcomeTone,
} from './timelineModel';
import en from '@/i18n/locales/en.json';

const ev = (kind: TimelineEvent['kind'], key: string): TimelineEvent => ({ kind, key, at: '2026-09-01T10:00:00Z' });

describe('formatSkopje', () => {
  it('prints DD.MM.YYYY HH:mm in Skopje time (CEST, UTC+2)', () => {
    expect(formatSkopje('2026-09-27T08:22:01+00:00')).toBe('27.09.2026 10:22');
  });
  it('follows CET in winter (UTC+1) and crosses midnight correctly', () => {
    expect(formatSkopje('2026-01-15T23:30:00Z')).toBe('16.01.2026 00:30');
  });
  it('can drop the time and tolerates junk', () => {
    expect(formatSkopje('2025-10-21T12:00:00+00:00', false)).toBe('21.10.2025');
    expect(formatSkopje(undefined)).toBe('');
    expect(formatSkopje('not a date')).toBe('');
  });
});

describe('filterEvents / kindCounts', () => {
  const events = [ev('order', 'o1'), ev('parcel', 'p1'), ev('order', 'o2'), ev('call', 'c1')];
  it('an empty selection shows everything', () => {
    expect(filterEvents(events, new Set())).toHaveLength(4);
  });
  it('filters to the selected kinds', () => {
    expect(filterEvents(events, new Set(['order'])).map((e) => e.key)).toEqual(['o1', 'o2']);
    expect(filterEvents(events, new Set(['parcel', 'call'])).map((e) => e.key)).toEqual(['p1', 'c1']);
    expect(filterEvents(undefined, new Set(['order']))).toEqual([]);
  });
  it('prefers the server’s full counts over the capped page', () => {
    const tl: CustomerTimeline = { ok: true, events, kind_counts: { order: 169, parcel: 6 } };
    expect(kindCounts(tl)).toEqual({ order: 169, parcel: 6 });
    expect(kindCounts({ ok: true, events })).toEqual({ order: 2, parcel: 1, call: 1 });
  });
});

describe('sourceKey', () => {
  it('names collabBox orders by their channel', () => {
    expect(sourceKey({ kind: 'order', source: 'collabbox', source_detail: 'teleshop' })).toBe('teleshop');
    expect(sourceKey({ kind: 'order', source: 'collabbox', source_detail: 'leads_out' })).toBe('leads_out');
    expect(sourceKey({ kind: 'order', source: 'collabbox', source_detail: '9225' })).toBe('collabbox');
  });
  it('maps the other sources and kinds', () => {
    expect(sourceKey({ kind: 'order', source: 'altercpa', source_detail: 'history' })).toBe('altercpa');
    expect(sourceKey({ kind: 'order', source: 'elyon_crm' })).toBe('elyon_crm');
    expect(sourceKey({ kind: 'web_order' })).toBe('web');
    expect(sourceKey({ kind: 'altercpa_lead' })).toBe('altercpa');
    expect(sourceKey({ kind: 'parcel', source: 'social' })).toBe('social');
    expect(sourceKey({ kind: 'parcel', source: 'something-new' })).toBe('other');
    expect(sourceKey({ kind: 'order' })).toBeNull();
  });
});

describe('tones and small formatters', () => {
  it('colours MEX statuses by outcome', () => {
    expect(parcelTone({ status_id: 2 })).toBe('green');
    expect(parcelTone({ status_id: 7 })).toBe('pink');
    expect(parcelTone({ status_id: 8 })).toBe('blue');
  });
  it('colours web outcomes and AlterCPA decisions', () => {
    expect(webOutcomeTone('delivered')).toBe('green');
    expect(webOutcomeTone('no_record')).toBe('gray');
    expect(decisionTone('cancel_other')).toBe('teal'); // booked as confirmed (2026-08-11)
    expect(decisionTone(undefined)).toBe('amber');
  });
  it('has a label for every AlterCPA decision (cancel_other must not look like a plural)', () => {
    const labels = (en as any).customer360.decision as Record<string, string>;
    for (const d of ['approved', 'cancel_other', 'cancelled', 'trashed', undefined]) {
      expect(labels[decisionKey(d)]).toBeTruthy();
    }
  });
  it('formats seconds and compares names loosely', () => {
    expect(formatSeconds(125)).toBe('2:05');
    expect(formatSeconds(null)).toBe('');
    expect(differentName('Suta  Topkoska', 'suta topkoska')).toBe(false);
    expect(differentName('Горан', 'Goran Todorovski')).toBe(true);
    expect(differentName(undefined, 'x')).toBe(false);
  });
});
