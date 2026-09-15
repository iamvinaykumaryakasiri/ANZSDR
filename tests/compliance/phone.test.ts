import { describe, expect, it } from 'vitest';
import {
  allJurisdictions,
  marketOf,
  parsePhoneNumber,
  resolveLocality,
  timezoneFor
} from '../../src/compliance/phone.js';
import type { ParsedNumber } from '../../src/compliance/types.js';

function parsed(raw: string, market: 'AU' | 'NZ' = 'AU'): ParsedNumber {
  const r = parsePhoneNumber(raw, market);
  if (!r.valid) throw new Error(`expected ${raw} to parse: ${r.reason}`);
  return { e164: r.e164, market: r.market, lineType: r.lineType, nsn: r.nsn, areaCode: r.areaCode };
}

describe('parsePhoneNumber', () => {
  it('normalises AU numbers written every way a human writes them', () => {
    for (const raw of ['+61 2 8000 1234', '0061 2 8000 1234', '(02) 8000 1234', '02-8000-1234']) {
      expect(parsed(raw).e164).toBe('+61280001234');
    }
  });

  it('classifies AU line types', () => {
    expect(parsed('+61280001234').lineType).toBe('fixed');
    expect(parsed('+61412345678').lineType).toBe('mobile');
    expect(parsed('+611300123456').lineType).toBe('non-geographic');
    expect(parsed('+611800123456').lineType).toBe('non-geographic');
    expect(parsed('+611312 34').lineType).toBe('non-geographic');
  });

  it('normalises NZ numbers written every way a human writes them', () => {
    for (const raw of ['+64 9 456 7890', '0064 9 456 7890', '(09) 456 7890']) {
      expect(parsed(raw, 'NZ').e164).toBe('+6494567890');
    }
  });

  it('classifies NZ line types', () => {
    expect(parsed('+6494567890', 'NZ').lineType).toBe('fixed');
    expect(parsed('+64211234567', 'NZ').lineType).toBe('mobile');
    expect(parsed('+64800123456', 'NZ').lineType).toBe('non-geographic');
    expect(parsed('+64508123456', 'NZ').lineType).toBe('non-geographic');
  });

  it('reads the market off the number, not off the request', () => {
    expect(parsed('+6494567890', 'AU').market).toBe('NZ');
    expect(parsed('+61280001234', 'NZ').market).toBe('AU');
  });

  it('interprets a national-format number using the declared market', () => {
    expect(parsed('09 456 7890', 'NZ').e164).toBe('+6494567890');
    expect(parsed('07 3000 1234', 'AU').e164).toBe('+61730001234');
  });

  it.each([
    ['', 'empty number'],
    ['   ', 'empty number'],
    ['+1 415 555 0100', 'unsupported country code'],
    ['8000 1234', 'not in E.164 or national format'],
    ['+61 2 8000', 'AU numbers must have 9 national digits'],
    ['+61 1300 12', 'AU 1300/1800 numbers must have 10 digits'],
    ['+61 13 1234567', 'AU 13 numbers must have 6 digits'],
    ['+61 5 8000 1234', 'unallocated AU area code 05'],
    ['+64 5 456 7890', 'unallocated NZ area code 05'],
    ['+64 9 456', 'NZ landline numbers must have 8 national digits'],
    ['+64 21 12', 'NZ mobile numbers must have 8-10 national digits']
  ])('rejects %s', (raw, reason) => {
    const r = parsePhoneNumber(raw, raw.includes('64') ? 'NZ' : 'AU');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe(reason);
  });

  it('rejects a plus-prefixed number with non-numeric junk after the country code', () => {
    const r = parsePhoneNumber('+61-2-8000-12ab', 'AU');
    expect(r.valid).toBe(false);
  });

  it('rejects an embedded plus in the subscriber part', () => {
    const r = parsePhoneNumber('+61+280001234', 'AU');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('non-numeric characters in subscriber number');
  });
});

describe('resolveLocality', () => {
  it('trusts an explicit enrichment hint outright', () => {
    const r = resolveLocality(parsed('+61412345678'), { jurisdiction: 'au-vic' });
    expect(r.confidence).toBe('exact');
    expect(r.candidates).toEqual([{ jurisdiction: 'au-vic', timezone: 'Australia/Melbourne' }]);
  });

  it('accepts a hinted timezone that differs from the jurisdiction default', () => {
    const r = resolveLocality(parsed('+61412345678'), {
      jurisdiction: 'au-nsw',
      timezone: 'Australia/Broken_Hill'
    });
    expect(r.candidates[0]?.timezone).toBe('Australia/Broken_Hill');
  });

  it('falls back to the jurisdiction timezone when the hint carries a nonsense zone', () => {
    const r = resolveLocality(parsed('+61412345678'), {
      jurisdiction: 'au-nsw',
      timezone: 'Mars/Olympus_Mons'
    });
    expect(r.candidates[0]?.timezone).toBe('Australia/Sydney');
  });

  it('narrows a fixed line to its area code candidates', () => {
    const r = resolveLocality(parsed('+61880001234'));
    expect(r.confidence).toBe('narrowed');
    expect(r.candidates.map((c) => c.jurisdiction).sort()).toEqual(['au-nt', 'au-sa', 'au-wa']);
    expect(r.basis).toContain('spans 3 jurisdictions');
  });

  it('treats a single-jurisdiction area code as exact', () => {
    const r = resolveLocality(parsed('+61730001234'));
    expect(r.confidence).toBe('exact');
    expect(r.candidates).toEqual([{ jurisdiction: 'au-qld', timezone: 'Australia/Brisbane' }]);
    expect(r.basis).toContain('only used in');
  });

  it('spreads a mobile across the whole market', () => {
    const r = resolveLocality(parsed('+61412345678'));
    expect(r.confidence).toBe('unknown');
    expect(r.candidates).toHaveLength(8);
    expect(r.basis).toContain('no geographic information');
  });

  it('spreads a non-geographic number across the whole market', () => {
    const r = resolveLocality(parsed('+611300123456'));
    expect(r.confidence).toBe('unknown');
    expect(r.basis).toContain('non-geographic');
  });

  it('puts a Chatham Islands number on Chatham time', () => {
    const r = resolveLocality(parsed('+6433051234', 'NZ'));
    expect(r.candidates).toEqual([{ jurisdiction: 'nz-chatham', timezone: 'Pacific/Chatham' }]);
  });

  it('keeps the rest of the South Island off Chatham time', () => {
    const r = resolveLocality(parsed('+6433771234', 'NZ'));
    expect(r.candidates.map((c) => c.jurisdiction)).not.toContain('nz-chatham');
    expect(r.candidates).toHaveLength(7);
  });
});

describe('jurisdiction helpers', () => {
  it('maps jurisdictions to markets and zones', () => {
    expect(marketOf('au-wa')).toBe('AU');
    expect(marketOf('nz-otago')).toBe('NZ');
    expect(timezoneFor('au-nt')).toBe('Australia/Darwin');
    expect(allJurisdictions('AU')).toHaveLength(8);
    expect(allJurisdictions('NZ')).toHaveLength(12);
  });
});
