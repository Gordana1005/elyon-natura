import { describe, expect, it } from 'vitest';
import {
  charCount, counterText, groupThousands, hhmm, mobileStep, moveId, nextSaveStatus, parentState,
  personalListTab, readNotesUrl, saveStatusKey, snippet, sortNotes, writeNotesUrl,
} from './model';
import { snippet as serverSnippet } from '../../../supabase/functions/api/personalNotes';
import { navItemActive } from '@/lib/navActive';

const NB = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';

describe('the URL state', () => {
  it('reads nb / note / owner; a note needs its notebook; junk is ignored', () => {
    expect(readNotesUrl(new URLSearchParams(`tab=notes&nb=${NB}&note=${NOTE}`))).toEqual({ nb: NB, note: NOTE, owner: null });
    expect(readNotesUrl(new URLSearchParams(`note=${NOTE}`))).toEqual({ nb: null, note: null, owner: null });
    expect(readNotesUrl(new URLSearchParams('nb=abc&owner=x'))).toEqual({ nb: null, note: null, owner: null });
  });
  it('writes a patch and keeps the tab', () => {
    const p = writeNotesUrl(new URLSearchParams('tab=notes'), { nb: NB });
    expect(p.toString()).toBe(`tab=notes&nb=${NB}`);
    const q = writeNotesUrl(p, { note: NOTE });
    expect(q.get('note')).toBe(NOTE);
    expect(q.get('tab')).toBe('notes');
  });
  it('another notebook closes the note; leaving the owner closes both', () => {
    const p = new URLSearchParams(`tab=agent-notes&owner=${OWNER}&nb=${NB}&note=${NOTE}`);
    expect(writeNotesUrl(p, { nb: NB2 }).get('note')).toBeNull();
    const out = writeNotesUrl(p, { owner: null });
    expect([out.get('owner'), out.get('nb'), out.get('note'), out.get('tab')]).toEqual([null, null, null, 'agent-notes']);
    // the same notebook keeps the note
    expect(writeNotesUrl(p, { nb: NB }).get('note')).toBe(NOTE);
  });
  it('the phone shows one pane: notebooks → notes → editor, and ← goes one up', () => {
    expect(mobileStep({ nb: null, note: null, owner: null })).toBe('notebooks');
    expect(mobileStep({ nb: NB, note: null, owner: null })).toBe('notes');
    expect(mobileStep({ nb: NB, note: NOTE, owner: null })).toBe('editor');
    expect(parentState({ nb: NB, note: NOTE, owner: null })).toEqual({ note: null });
    expect(parentState({ nb: NB, note: null, owner: null })).toEqual({ nb: null, note: null });
    expect(parentState({ nb: null, note: null, owner: null })).toEqual({});
  });
});

describe('the /personal-list tab', () => {
  const tab = (qs: string, staff: boolean) => personalListTab(new URLSearchParams(qs), staff);
  it('?tab= picks the tab; the staff tabs fall back to "mine" for an agent', () => {
    expect(tab('tab=notes', false)).toBe('notes');
    expect(tab('tab=agent-notes', true)).toBe('agent-notes');
    expect(tab('tab=agent-notes', false)).toBe('mine');
    expect(tab('tab=agents', false)).toBe('mine');
    expect(tab('tab=nonsense', true)).toBe('mine');
    expect(tab('', true)).toBe('mine');
  });
  it('the sidebar lights Личен дневник on ?tab=notes and Личен список otherwise — never both', () => {
    const sib = ['/calls', '/calls?queue=call-again', '/personal-list', '/personal-list?tab=notes'];
    expect(navItemActive('/personal-list?tab=notes', '/personal-list', `?tab=notes&nb=${NB}`, sib)).toBe(true);
    expect(navItemActive('/personal-list', '/personal-list', `?tab=notes&nb=${NB}`, sib)).toBe(false);
    expect(navItemActive('/personal-list', '/personal-list', '?tab=agents', sib)).toBe(true);
    expect(navItemActive('/personal-list?tab=notes', '/personal-list', '?tab=agent-notes', sib)).toBe(false);
  });
  it('the old ?expiring=1 link still opens Истекуваат', () => {
    expect(tab('expiring=1', true)).toBe('expiring');
    expect(tab('expiring=1', false)).toBe('mine');
    expect(tab('tab=notes&expiring=1', true)).toBe('notes');
  });
});

describe('the save status machine', () => {
  it('edit → saving → saved, or dirty again when typing went on', () => {
    let s = nextSaveStatus('idle', { type: 'edit' });
    expect(s).toBe('dirty');
    s = nextSaveStatus(s, { type: 'send' });
    expect(s).toBe('saving');
    expect(nextSaveStatus(s, { type: 'ok', pendingAfter: false })).toBe('saved');
    expect(nextSaveStatus(s, { type: 'ok', pendingAfter: true })).toBe('dirty');
  });
  it('a failure shows "not saved" until the next edit', () => {
    const s = nextSaveStatus('saving', { type: 'fail' });
    expect(s).toBe('error');
    expect(nextSaveStatus(s, { type: 'edit' })).toBe('dirty');
  });
  it('a conflict holds until the person chooses', () => {
    const s = nextSaveStatus('saving', { type: 'conflict' });
    expect(s).toBe('conflict');
    expect(nextSaveStatus(s, { type: 'edit' })).toBe('conflict');
    expect(nextSaveStatus(s, { type: 'send' })).toBe('conflict');
    expect(nextSaveStatus(s, { type: 'take_theirs' })).toBe('saved');
    expect(nextSaveStatus(s, { type: 'keep_mine' })).toBe('dirty');
  });
  it('maps to the save line', () => {
    expect(saveStatusKey('idle')).toBeNull();
    expect(saveStatusKey('saving')).toBe('personalNotes.save.saving');
    expect(saveStatusKey('saved')).toBe('personalNotes.save.saved');
    expect(saveStatusKey('error')).toBe('personalNotes.save.failed');
    expect(saveStatusKey('conflict')).toBe('personalNotes.save.conflict');
    expect(hhmm(Date.parse('2026-10-01T12:32:00Z'))).toBe('14:32');   // the Skopje clock (CEST)
    expect(hhmm(Date.parse('2026-12-01T08:05:00Z'))).toBe('09:05');   // CET
  });
});

describe('lists and counters', () => {
  it('pinned first, then newest', () => {
    const rows = [
      { id: 'a', pinned: false, updated_at: '2026-10-01T08:00:00Z' },
      { id: 'b', pinned: true, updated_at: '2026-09-01T08:00:00Z' },
      { id: 'c', pinned: false, updated_at: '2026-10-01T09:00:00Z' },
      { id: 'd', pinned: true, updated_at: '2026-09-02T08:00:00Z' },
    ];
    expect(sortNotes(rows).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a']);
  });
  it('↑ / ↓ move one place and stop at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a'], 'x', 1)).toEqual(['a']);
  });
  it('the counter: code points, grouped the Macedonian way', () => {
    expect(charCount('😀ж')).toBe(2);
    expect(groupThousands(1234)).toBe('1.234');
    expect(counterText(1234, 20000)).toBe('1.234 / 20.000');
    expect(counterText(0, 20000)).toBe('0 / 20.000');
  });
  it('the snippet is the twin of the server one', () => {
    const cases: Array<[string, string | null]> = [
      ['кратко\n\nтекст', null],
      [`${'а'.repeat(300)} КЛУЧ ${'б'.repeat(300)}`, 'клуч'],
      ['x'.repeat(500), 'missing'],
      [`${'x'.repeat(400)} крај`, 'крај'],
      [`почеток ${'x'.repeat(400)}`, 'почеток'],
      [`${'😀'.repeat(200)} emoji ${'😀'.repeat(200)}`, 'EMOJI'],
    ];
    for (const [body, q] of cases) expect(snippet(body, q)).toBe(serverSnippet(body, q));
    expect(snippet(`${'а'.repeat(300)} КЛУЧ ${'б'.repeat(300)}`, 'клуч')).toContain('КЛУЧ');
  });
});
