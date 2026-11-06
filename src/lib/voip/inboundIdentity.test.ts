import { describe, expect, it } from 'vitest';
import { normalizeMkCaller, parseInboundIdentity, prettyMkPhone, TV_DIDS } from './inboundIdentity';

describe('inboundIdentity — the caller', () => {
  it('normalises the Macedonian forms to E.164', () => {
    expect(normalizeMkCaller('+38970123456')).toBe('+38970123456');
    expect(normalizeMkCaller('38970123456')).toBe('+38970123456');
    expect(normalizeMkCaller('070123456')).toBe('+38970123456');
    expect(normalizeMkCaller('070 123 456')).toBe('+38970123456');
    expect(normalizeMkCaller('023118813')).toBe('+38923118813');
    expect(normalizeMkCaller('70123456')).toBe('+38970123456');
  });
  it('keeps a foreign caller recognisable and never invents a number', () => {
    expect(normalizeMkCaller('+359888123456')).toBe('+359888123456');
    expect(normalizeMkCaller('anonymous')).toBe('');
    expect(normalizeMkCaller(null)).toBe('');
  });
  it('writes a number the way staff do', () => {
    expect(prettyMkPhone('+38970123456')).toBe('070 123 456');
    expect(prettyMkPhone('+38925128888')).toBe('02 512 8888');
    expect(prettyMkPhone('+38926202515')).toBe('02 620 2515');
    expect(prettyMkPhone('+38931234567')).toBe('031 234 567');
    expect(prettyMkPhone('+359888123456')).toBe('+359888123456');
    expect(prettyMkPhone('')).toBe('');
  });
});

describe('inboundIdentity — the TV number', () => {
  it('reads the caller-ID name prefix the PBX sets', () => {
    expect(parseInboundIdentity('+38970123456', 'TV8888')).toEqual({
      phone: '+38970123456', did_label: 'TV8888', did_number: '+38925128888', did_pretty: '02 512 8888',
    });
    expect(parseInboundIdentity('070123456', 'TV2515 070123456').did_number).toBe(TV_DIDS.TV2515.number);
    expect(parseInboundIdentity('070123456', 'tv8888').did_label).toBe('TV8888');
  });
  it('an unknown or missing name → no TV number, the caller still parsed', () => {
    expect(parseInboundIdentity('+38970123456', '')).toEqual({ phone: '+38970123456', did_label: null, did_number: null, did_pretty: null });
    expect(parseInboundIdentity('+38970123456', null).did_label).toBeNull();
    expect(parseInboundIdentity('+38970123456', 'TV9999').did_number).toBeNull();
    expect(parseInboundIdentity('+38970123456', '070123456').did_label).toBeNull();
  });
});
