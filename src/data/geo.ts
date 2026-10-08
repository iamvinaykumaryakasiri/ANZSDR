/**
 * Geo-tag a phone number at enrichment time (section 7.1).
 *
 * The compliance gate decides whether a call may happen on the recipient's own
 * clock. It can work out a great deal from the number itself, but a mobile
 * carries no geography at all, and a bare mobile is gated on the most
 * restrictive window in its market. Enrichment is where the system learns more:
 * Apollo says where the person is. This module turns that into the state,
 * timezone and market the gate takes as a hint, and into a line type.
 *
 * What a hint does is widen what the gate will allow, never narrow it, so a
 * hint is only given when it is worth trusting:
 *
 *   - it must name exactly one place, never a guess between two;
 *   - it must belong to the same market as the number, so an Australian mobile
 *     held by someone in Auckland is not pinned to Auckland's clock;
 *   - for a landline, it must agree with the area code. If the person's profile
 *     says Perth and the number is a 02 Sydney number, one of them is stale and
 *     the number is not pinned at all.
 *
 * Anything that fails those checks is left unpinned, which the gate reads as
 * "unknown" and treats as the most restrictive case.
 */

import { marketOf, parsePhoneNumber, resolveLocality, timezoneFor } from '../compliance/phone.js';
import {
  AU_JURISDICTIONS,
  NZ_JURISDICTIONS,
  type Jurisdiction,
  type LineType,
  type Market
} from '../compliance/types.js';
import type { PhoneNumberRecord } from './apollo-types.js';

/** direct: an office direct dial. hq: a switchboard. mobile and non-geographic as they say. */
export type PhoneKind = 'direct' | 'hq' | 'mobile' | 'non-geographic';

export interface PersonLocation {
  city?: string | undefined;
  state?: string | undefined;
  country?: string | undefined;
}

export interface GeoTag {
  e164: string;
  market: Market;
  /** What `Contact.phoneLine` holds: the compliance gate's own vocabulary. */
  lineType: LineType;
  kind: PhoneKind;
  /** Present only when the pin passed every check above. */
  jurisdiction?: Jurisdiction;
  timezone?: string;
  /** Plain English, kept with the contact so "why is she gated to Perth" has an answer. */
  basis: string;
}

export type GeoResult = ({ ok: true } & GeoTag) | { ok: false; reason: string };

const AU_STATES: Record<string, Jurisdiction> = {
  'new south wales': 'au-nsw',
  nsw: 'au-nsw',
  victoria: 'au-vic',
  vic: 'au-vic',
  queensland: 'au-qld',
  qld: 'au-qld',
  'south australia': 'au-sa',
  sa: 'au-sa',
  'western australia': 'au-wa',
  wa: 'au-wa',
  tasmania: 'au-tas',
  tas: 'au-tas',
  'northern territory': 'au-nt',
  nt: 'au-nt',
  'australian capital territory': 'au-act',
  act: 'au-act'
};

const AU_CITIES: Record<string, Jurisdiction> = {
  sydney: 'au-nsw',
  melbourne: 'au-vic',
  brisbane: 'au-qld',
  adelaide: 'au-sa',
  perth: 'au-wa',
  hobart: 'au-tas',
  darwin: 'au-nt',
  canberra: 'au-act'
};

/**
 * Only places that map to one anniversary province. Waikato, Bay of Plenty and
 * the like are left out on purpose: pinning them to a neighbour would be a guess.
 */
const NZ_REGIONS: Record<string, Jurisdiction> = {
  auckland: 'nz-auckland',
  wellington: 'nz-wellington',
  canterbury: 'nz-canterbury',
  otago: 'nz-otago',
  southland: 'nz-southland',
  taranaki: 'nz-taranaki',
  "hawke's bay": 'nz-hawkes-bay',
  'hawkes bay': 'nz-hawkes-bay',
  nelson: 'nz-nelson',
  tasman: 'nz-nelson',
  marlborough: 'nz-marlborough',
  'west coast': 'nz-westland'
};

const NZ_CITIES: Record<string, Jurisdiction> = {
  christchurch: 'nz-canterbury',
  dunedin: 'nz-otago',
  invercargill: 'nz-southland',
  'new plymouth': 'nz-taranaki',
  napier: 'nz-hawkes-bay',
  hastings: 'nz-hawkes-bay',
  blenheim: 'nz-marlborough'
};

function key(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isKnown(j: Jurisdiction): boolean {
  return (AU_JURISDICTIONS as readonly string[]).includes(j) || (NZ_JURISDICTIONS as readonly string[]).includes(j);
}

/** The single jurisdiction a person's profile location names, or undefined if it names none or several. */
export function jurisdictionFromLocation(location: PersonLocation): Jurisdiction | undefined {
  const country = key(location.country);
  const state = key(location.state);
  const city = key(location.city);
  const inAu = country === '' || country === 'australia';
  const inNz = country === '' || country === 'new zealand';

  const candidates = new Set<Jurisdiction>();
  if (inAu) {
    const s = AU_STATES[state];
    if (s !== undefined) candidates.add(s);
    else if (state === '' && AU_CITIES[city] !== undefined) candidates.add(AU_CITIES[city] as Jurisdiction);
  }
  if (inNz) {
    const r = NZ_REGIONS[state];
    if (r !== undefined) candidates.add(r);
    else if (state === '' && NZ_CITIES[city] !== undefined) candidates.add(NZ_CITIES[city] as Jurisdiction);
  }
  // Both markets matched (no country given and an ambiguous word): do not guess.
  if (candidates.size !== 1) return undefined;
  const only = [...candidates][0] as Jurisdiction;
  return isKnown(only) ? only : undefined;
}

export function geoTagPhone(
  phone: PhoneNumberRecord,
  location: PersonLocation,
  fallbackMarket: Market
): GeoResult {
  // A home number is a personal line. It is not a business contact detail and
  // is not kept (sections 7.2 and 7.4).
  if (phone.kind === 'home') return { ok: false, reason: 'a home number is a personal line and is not kept' };

  const parsed = parsePhoneNumber(phone.number, fallbackMarket);
  if (!parsed.valid) return { ok: false, reason: `not a dialable AU/NZ number: ${parsed.reason}` };

  // The stricter reading wins: if either the numbering plan or Apollo says it is
  // a mobile, it is treated as one.
  const kind: PhoneKind =
    parsed.lineType === 'mobile' || phone.kind === 'mobile'
      ? 'mobile'
      : parsed.lineType === 'non-geographic'
        ? 'non-geographic'
        : phone.kind === 'work_hq'
          ? 'hq'
          : 'direct';
  const lineType: LineType = kind === 'mobile' ? 'mobile' : parsed.lineType === 'non-geographic' ? 'non-geographic' : 'fixed';

  const base: GeoTag = { e164: parsed.e164, market: parsed.market, lineType, kind, basis: '' };

  const pin = jurisdictionFromLocation(location);
  if (pin === undefined) {
    return {
      ok: true,
      ...base,
      basis: 'no single state could be read from the profile location; the gate resolves it from the number'
    };
  }
  if (marketOf(pin) !== parsed.market) {
    return {
      ok: true,
      ...base,
      basis: `profile location is in ${pin} but the number is a ${parsed.market} number; not pinned, and the number's market governs`
    };
  }
  if (parsed.lineType === 'fixed') {
    const fromNumber = resolveLocality(parsed).candidates.map((c) => c.jurisdiction);
    if (!fromNumber.includes(pin)) {
      return {
        ok: true,
        ...base,
        basis: `profile location (${pin}) disagrees with the area code (${fromNumber.join(', ')}); not pinned`
      };
    }
  }
  return {
    ok: true,
    ...base,
    jurisdiction: pin,
    timezone: timezoneFor(pin),
    basis: `profile location pins this to ${pin}${parsed.lineType === 'fixed' ? ', consistent with the area code' : ''}`
  };
}

const KIND_PREFERENCE: PhoneKind[] = ['direct', 'hq', 'mobile', 'non-geographic'];

/**
 * Which number to put on the contact. An office direct dial beats a switchboard,
 * which beats a mobile: a business line is the one we may call today, and a
 * mobile is the one that needs the Do Not Call register washed first.
 */
export function chooseBestPhone(tags: GeoTag[]): GeoTag | undefined {
  return [...tags].sort((a, b) => KIND_PREFERENCE.indexOf(a.kind) - KIND_PREFERENCE.indexOf(b.kind))[0];
}
