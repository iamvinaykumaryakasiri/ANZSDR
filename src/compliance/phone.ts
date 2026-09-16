/**
 * Number parsing and locality resolution.
 *
 * Australia spans five UTC offsets and only some states observe daylight saving,
 * so a dial decision made on the server's clock is a decision made on the wrong
 * clock. Every number is resolved to the set of places the recipient might be,
 * and the calling window must be open in *all* of them. A mobile carries no
 * geographic information at all, so it resolves to the whole market and is
 * therefore gated on the most restrictive window available.
 */

import { IANAZone } from 'luxon';
import type {
  GeoConfidence,
  Jurisdiction,
  Locality,
  LocalityHint,
  Market,
  ParsedNumber,
  PhoneParseResult,
  ResolvedLocality
} from './types.js';
import { AU_JURISDICTIONS, NZ_JURISDICTIONS } from './types.js';

const TIMEZONE_BY_JURISDICTION: Record<Jurisdiction, string> = {
  'au-act': 'Australia/Sydney',
  'au-nsw': 'Australia/Sydney',
  'au-nt': 'Australia/Darwin',
  'au-qld': 'Australia/Brisbane',
  'au-sa': 'Australia/Adelaide',
  'au-tas': 'Australia/Hobart',
  'au-vic': 'Australia/Melbourne',
  'au-wa': 'Australia/Perth',
  'nz-auckland': 'Pacific/Auckland',
  'nz-canterbury': 'Pacific/Auckland',
  'nz-chatham': 'Pacific/Chatham',
  'nz-hawkes-bay': 'Pacific/Auckland',
  'nz-marlborough': 'Pacific/Auckland',
  'nz-nelson': 'Pacific/Auckland',
  'nz-otago': 'Pacific/Auckland',
  'nz-south-canterbury': 'Pacific/Auckland',
  'nz-southland': 'Pacific/Auckland',
  'nz-taranaki': 'Pacific/Auckland',
  'nz-wellington': 'Pacific/Auckland',
  'nz-westland': 'Pacific/Auckland',
  'nz-national': 'Pacific/Auckland'
};

export function timezoneFor(jurisdiction: Jurisdiction): string {
  return TIMEZONE_BY_JURISDICTION[jurisdiction];
}

export function marketOf(jurisdiction: Jurisdiction): Market {
  return jurisdiction.startsWith('au-') ? 'AU' : 'NZ';
}

/**
 * Which market's rules govern a dial.
 *
 * The market of a *dial* is a property of the number being rung, not of where
 * the employer is headquartered. A New Zealand bank can perfectly well employ
 * someone carrying an Australian mobile, and section 7.1 gates on the clock
 * where the recipient actually is - so the number decides, and the account's
 * country is only the fallback for reading a number written in national form
 * (a leading zero, no country code) or one that will not parse at all.
 *
 * An unparseable number keeps the fallback deliberately: the gate should reject
 * it as an invalid number and say so, not as a market mismatch, which would
 * point the reader at the wrong problem.
 */
export function marketForDial(raw: string, fallback: Market): Market {
  const parsed = parsePhoneNumber(raw, fallback);
  return parsed.valid ? parsed.market : fallback;
}

/** Every place a contact in this market might be. Used for mobiles and unknowns. */
export function allJurisdictions(market: Market): Jurisdiction[] {
  return market === 'AU' ? [...AU_JURISDICTIONS] : [...NZ_JURISDICTIONS];
}

/**
 * Australian geographic area codes. An area code spans more than one state in
 * both the 02 and 08 cases, and 08 spans three different UTC offsets, so these
 * stay as candidate sets rather than being collapsed to one guess.
 */
const AU_AREA_JURISDICTIONS: Record<string, Jurisdiction[]> = {
  '2': ['au-nsw', 'au-act'],
  '3': ['au-vic', 'au-tas'],
  '7': ['au-qld'],
  '8': ['au-sa', 'au-wa', 'au-nt']
};

/**
 * New Zealand area codes mapped to anniversary-day provinces. The South Island
 * 03 code covers seven provinces with seven different anniversary days, which is
 * why an unhinted 03 number is conservative by construction.
 */
const NZ_AREA_JURISDICTIONS: Record<string, Jurisdiction[]> = {
  '3': [
    'nz-nelson',
    'nz-marlborough',
    'nz-westland',
    'nz-canterbury',
    'nz-south-canterbury',
    'nz-otago',
    'nz-southland'
  ],
  '4': ['nz-wellington'],
  '6': ['nz-taranaki', 'nz-hawkes-bay', 'nz-wellington'],
  '7': ['nz-auckland'],
  '9': ['nz-auckland']
};

const NZ_MOBILE_PREFIXES = ['20', '21', '22', '27', '28', '29'];

function digitsOnly(input: string): string {
  return input.replace(/[^\d+]/g, '');
}

/**
 * Parse a raw number into E.164 plus the numbering-plan facts the gate needs.
 * `defaultMarket` interprets numbers written in national format (leading 0).
 */
export function parsePhoneNumber(raw: string, defaultMarket: Market): PhoneParseResult {
  const cleaned = digitsOnly(raw);
  if (cleaned === '') {
    return { valid: false, reason: 'empty number', input: raw };
  }

  let rest: string;
  let market: Market;

  if (cleaned.startsWith('+61') || cleaned.startsWith('0061')) {
    market = 'AU';
    rest = cleaned.startsWith('+61') ? cleaned.slice(3) : cleaned.slice(4);
  } else if (cleaned.startsWith('+64') || cleaned.startsWith('0064')) {
    market = 'NZ';
    rest = cleaned.startsWith('+64') ? cleaned.slice(3) : cleaned.slice(4);
  } else if (cleaned.startsWith('+')) {
    return { valid: false, reason: 'unsupported country code', input: raw };
  } else if (cleaned.startsWith('0')) {
    market = defaultMarket;
    rest = cleaned.slice(1);
  } else {
    return { valid: false, reason: 'not in E.164 or national format', input: raw };
  }

  if (!/^\d+$/.test(rest)) {
    return { valid: false, reason: 'non-numeric characters in subscriber number', input: raw };
  }

  return market === 'AU' ? parseAu(rest, raw) : parseNz(rest, raw);
}

function parseAu(nsn: string, raw: string): PhoneParseResult {
  const e164 = `+61${nsn}`;

  if (nsn.startsWith('1300') || nsn.startsWith('1800')) {
    if (nsn.length !== 10) {
      return { valid: false, reason: 'AU 1300/1800 numbers must have 10 digits', input: raw };
    }
    return { valid: true, e164, market: 'AU', lineType: 'non-geographic', nsn, areaCode: nsn.slice(0, 4) };
  }
  if (nsn.startsWith('13')) {
    if (nsn.length !== 6) {
      return { valid: false, reason: 'AU 13 numbers must have 6 digits', input: raw };
    }
    return { valid: true, e164, market: 'AU', lineType: 'non-geographic', nsn, areaCode: '13' };
  }

  if (nsn.length !== 9) {
    return { valid: false, reason: 'AU numbers must have 9 national digits', input: raw };
  }

  const areaCode = nsn.slice(0, 1);
  if (areaCode === '4') {
    return { valid: true, e164, market: 'AU', lineType: 'mobile', nsn, areaCode };
  }
  if (AU_AREA_JURISDICTIONS[areaCode] !== undefined) {
    return { valid: true, e164, market: 'AU', lineType: 'fixed', nsn, areaCode };
  }
  return { valid: false, reason: `unallocated AU area code 0${areaCode}`, input: raw };
}

function parseNz(nsn: string, raw: string): PhoneParseResult {
  const e164 = `+64${nsn}`;

  if (nsn.startsWith('800') || nsn.startsWith('508')) {
    return { valid: true, e164, market: 'NZ', lineType: 'non-geographic', nsn, areaCode: nsn.slice(0, 3) };
  }

  const mobilePrefix = NZ_MOBILE_PREFIXES.find((p) => nsn.startsWith(p));
  if (mobilePrefix !== undefined) {
    if (nsn.length < 8 || nsn.length > 10) {
      return { valid: false, reason: 'NZ mobile numbers must have 8-10 national digits', input: raw };
    }
    return { valid: true, e164, market: 'NZ', lineType: 'mobile', nsn, areaCode: mobilePrefix };
  }

  const areaCode = nsn.slice(0, 1);
  if (NZ_AREA_JURISDICTIONS[areaCode] === undefined) {
    return { valid: false, reason: `unallocated NZ area code 0${areaCode}`, input: raw };
  }
  if (nsn.length !== 8) {
    return { valid: false, reason: 'NZ landline numbers must have 8 national digits', input: raw };
  }
  return { valid: true, e164, market: 'NZ', lineType: 'fixed', nsn, areaCode };
}

function toLocalities(jurisdictions: Jurisdiction[]): Locality[] {
  return jurisdictions.map((jurisdiction) => ({ jurisdiction, timezone: timezoneFor(jurisdiction) }));
}

/**
 * Work out every place the recipient might be.
 *
 * A trusted hint wins outright. Otherwise the numbering plan narrows it as far
 * as it can, and anything it cannot narrow resolves to the entire market, which
 * makes the window check the intersection of every window in that market.
 */
export function resolveLocality(number: ParsedNumber, hint?: LocalityHint): ResolvedLocality {
  if (hint?.jurisdiction !== undefined) {
    const jurisdiction = hint.jurisdiction;
    // An unusable timezone in enrichment data falls back to the jurisdiction's own
    // zone rather than propagating an invalid zone into the window check.
    const hinted = hint.timezone;
    const timezone =
      hinted !== undefined && IANAZone.isValidZone(hinted) ? hinted : timezoneFor(jurisdiction);
    return {
      candidates: [{ jurisdiction, timezone }],
      confidence: 'exact',
      basis: `enrichment pinned the contact to ${jurisdiction} (${timezone})`
    };
  }

  if (number.lineType === 'fixed') {
    const table = number.market === 'AU' ? AU_AREA_JURISDICTIONS : NZ_AREA_JURISDICTIONS;
    const code = number.areaCode as string;
    const narrowed = chathamOverride(number) ?? table[code];
    if (narrowed !== undefined) {
      const confidence: GeoConfidence = narrowed.length === 1 ? 'exact' : 'narrowed';
      return {
        candidates: toLocalities(narrowed),
        confidence,
        basis:
          narrowed.length === 1
            ? `area code 0${code} is only used in ${narrowed[0]}`
            : `area code 0${code} spans ${narrowed.length} jurisdictions; the window must be open in all of them`
      };
    }
  }

  const all = allJurisdictions(number.market);
  return {
    candidates: toLocalities(all),
    confidence: 'unknown',
    basis:
      number.lineType === 'mobile'
        ? 'mobile numbers carry no geographic information; gated on the most restrictive window in the market'
        : 'non-geographic number; gated on the most restrictive window in the market'
  };
}

/** The Chatham Islands sit 45 minutes ahead of the rest of New Zealand on the 03 5 prefix. */
function chathamOverride(number: ParsedNumber): Jurisdiction[] | undefined {
  if (number.market === 'NZ' && number.nsn.startsWith('3305')) {
    return ['nz-chatham'];
  }
  return undefined;
}
