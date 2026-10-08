import { describe, expect, it } from 'vitest';
import { chooseBestPhone, geoTagPhone, jurisdictionFromLocation, type GeoTag } from '../../src/data/geo.js';

function tag(number: string, kind: 'work_direct' | 'work_hq' | 'mobile' | 'home' | 'other' | 'unknown', where = {}, market: 'AU' | 'NZ' = 'AU') {
  return geoTagPhone({ number, kind }, where, market);
}

describe('reading a state from a profile location', () => {
  it.each([
    [{ state: 'New South Wales', country: 'Australia' }, 'au-nsw'],
    [{ state: 'NSW' }, 'au-nsw'],
    [{ state: 'Western Australia' }, 'au-wa'],
    [{ state: 'Australian Capital Territory' }, 'au-act'],
    [{ city: 'Perth' }, 'au-wa'],
    [{ state: 'Auckland', country: 'New Zealand' }, 'nz-auckland'],
    [{ state: "Hawke's Bay", country: 'New Zealand' }, 'nz-hawkes-bay'],
    [{ city: 'Christchurch', country: 'New Zealand' }, 'nz-canterbury'],
    [{ state: 'West Coast', country: 'New Zealand' }, 'nz-westland']
  ])('%o is %s', (location, expected) => {
    expect(jurisdictionFromLocation(location)).toBe(expected);
  });

  it('does not guess for a region that maps to no single anniversary province', () => {
    expect(jurisdictionFromLocation({ state: 'Waikato', country: 'New Zealand' })).toBeUndefined();
    expect(jurisdictionFromLocation({ city: 'Hamilton', country: 'New Zealand' })).toBeUndefined();
  });

  it('does not read an Australian state out of a New Zealand profile, or the reverse', () => {
    expect(jurisdictionFromLocation({ state: 'Victoria', country: 'New Zealand' })).toBeUndefined();
    expect(jurisdictionFromLocation({ state: 'Auckland', country: 'Australia' })).toBeUndefined();
  });

  it('says nothing when there is nothing to read', () => {
    expect(jurisdictionFromLocation({})).toBeUndefined();
  });
});

describe('geo-tagging a number', () => {
  it('pins a landline to the state the profile names when the area code agrees', () => {
    const t = tag('+61290001234', 'work_direct', { state: 'New South Wales' });
    expect(t).toMatchObject({ ok: true, e164: '+61290001234', market: 'AU', lineType: 'fixed', kind: 'direct', jurisdiction: 'au-nsw', timezone: 'Australia/Sydney' });
  });

  it('pins an 08 number to Western Australia when the profile says Perth', () => {
    expect(tag('+61892001234', 'work_direct', { city: 'Perth' })).toMatchObject({ ok: true, jurisdiction: 'au-wa', timezone: 'Australia/Perth' });
  });

  it('does NOT pin when the profile disagrees with the area code: one of them is stale', () => {
    const t = tag('+61290001234', 'work_direct', { state: 'Western Australia' });
    expect(t).toMatchObject({ ok: true, kind: 'direct' });
    expect(t.ok && t.jurisdiction).toBeFalsy();
    expect(t.ok && t.basis).toContain('disagrees with the area code');
  });

  it('pins a mobile from the profile, since a mobile carries no geography of its own', () => {
    expect(tag('+61412345678', 'mobile', { state: 'Victoria' })).toMatchObject({ ok: true, lineType: 'mobile', kind: 'mobile', jurisdiction: 'au-vic', timezone: 'Australia/Melbourne' });
  });

  it('does not pin an Australian mobile to a New Zealand city: the number\'s market governs', () => {
    const t = tag('+61412345678', 'mobile', { state: 'Auckland', country: 'New Zealand' });
    expect(t).toMatchObject({ ok: true, market: 'AU', kind: 'mobile' });
    expect(t.ok && t.jurisdiction).toBeFalsy();
    expect(t.ok && t.basis).toContain("number's market governs");
  });

  it('treats a number as a mobile if either the numbering plan or Apollo says so', () => {
    expect(tag('+61290001234', 'mobile')).toMatchObject({ ok: true, kind: 'mobile', lineType: 'mobile' });
    expect(tag('+64211234567', 'work_direct', {}, 'NZ')).toMatchObject({ ok: true, kind: 'mobile', market: 'NZ' });
  });

  it('tags a New Zealand landline', () => {
    expect(tag('+6495551234', 'work_direct', { state: 'Auckland', country: 'New Zealand' }, 'NZ')).toMatchObject({
      ok: true,
      market: 'NZ',
      jurisdiction: 'nz-auckland',
      timezone: 'Pacific/Auckland'
    });
  });

  it('calls a switchboard a switchboard, and 1300 a non-geographic number', () => {
    expect(tag('+61290001234', 'work_hq')).toMatchObject({ ok: true, kind: 'hq' });
    expect(tag('+611300123456', 'work_hq')).toMatchObject({ ok: true, kind: 'non-geographic', lineType: 'non-geographic' });
  });

  it('keeps no home number', () => {
    expect(tag('+61290001234', 'home')).toEqual({ ok: false, reason: 'a home number is a personal line and is not kept' });
  });

  it('rejects what the gate could not dial anyway', () => {
    expect(tag('+442071234567', 'work_direct')).toMatchObject({ ok: false });
    expect(tag('not a number', 'work_direct')).toMatchObject({ ok: false });
  });

  it('reads a national-format number using the account\'s market', () => {
    expect(tag('02 9000 1234', 'work_direct', {}, 'AU')).toMatchObject({ ok: true, e164: '+61290001234' });
  });

  it('leaves a number unpinned, and says why, when the profile gives nothing usable', () => {
    const t = tag('+61290001234', 'work_direct', { state: 'Atlantis' });
    expect(t.ok && t.jurisdiction).toBeFalsy();
    expect(t.ok && t.basis).toContain('no single state');
  });
});

describe('choosing the number to keep', () => {
  const base = { market: 'AU', basis: '' } as const;
  const t = (kind: GeoTag['kind'], e164: string): GeoTag => ({ ...base, e164, kind, lineType: kind === 'mobile' ? 'mobile' : 'fixed' });

  it('prefers an office direct dial, then a switchboard, then a mobile', () => {
    expect(chooseBestPhone([t('mobile', '+61412345678'), t('hq', '+61290000000'), t('direct', '+61290001234')])?.e164).toBe('+61290001234');
    expect(chooseBestPhone([t('mobile', '+61412345678'), t('hq', '+61290000000')])?.kind).toBe('hq');
    expect(chooseBestPhone([t('mobile', '+61412345678')])?.kind).toBe('mobile');
    expect(chooseBestPhone([])).toBeUndefined();
  });
});
