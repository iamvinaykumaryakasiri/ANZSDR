/**
 * The claim-index check: every factual statement in a variant maps to an
 * APPROVED claim (section 6, section 11 item 3).
 *
 * The check is possible because of how facts get into a variant at all. A
 * template can carry a fact only as `{{claim:<id>}}`, which renders the claim's
 * approved text verbatim. So "does every factual statement map to an approved
 * claim?" decomposes into two questions a program can answer:
 *
 *   1. Does every claim the variant references exist, and is it approved - and
 *      approved for the market(s) it will be spoken in, and not in a live
 *      conflict with another approved claim?
 *   2. Is there any factual-sounding statement in the words Coach wrote itself,
 *      outside a placeholder? There must not be, because nothing supports it.
 *
 * Question 2 is pattern-based and therefore blunt by design. What it cannot see,
 * the separate-instance compliance review and the adversarial simulation are
 * there for.
 */

import type { Market } from '../compliance/types.js';
import type { ClaimIndex } from '../knowledge/claims.js';
import { textFields, type PlaybookContent } from './schema.js';
import { claimIdsIn, parseTemplate } from './template.js';

export type ClaimRule =
  | 'unknown-claim'
  | 'claim-not-approved'
  | 'claim-wrong-market'
  | 'claim-in-live-conflict'
  | 'unsourced-assertion'
  | 'named-entity';

export interface ClaimFinding {
  rule: ClaimRule;
  field: string;
  message: string;
  claimId?: string;
  matched?: string;
}

/** Statements of fact in words Coach wrote. Each needs a claim behind it, and has none. */
const ASSERTIONS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern:
      /\b(?:we|hexaware)\s+(?:have|has|are|is|do|does|did|built|build|deliver(?:ed|s)?|serve[sd]?|work(?:ed|s)?|help(?:ed|s)?|support(?:ed|s)?|offer(?:ed|s)?|provide[sd]?|run|ran|manage[sd]?|specialis[ez]\w*|lead|led|own(?:ed|s)?)\b/i,
    message: 'states what Hexaware has or does'
  },
  {
    pattern:
      /\bour\s+(?:team|people|engineers|consultants|clients|customers|platform|practice|experience|track record|work|expertise|approach|methodology|framework|offering|services|solutions)\b/i,
    message: "states something about Hexaware's people, clients or work"
  },
  {
    pattern:
      /\b(?:leading|largest|biggest|best|number one|#1|world[- ]class|award[- ]winning|proven|trusted by|market[- ]leader|industry[- ]leading)\b/i,
    message: 'a superlative or ranking'
  },
  {
    pattern: /\b(?:certified|accredited|partner(?:ed|ship)?s? with|iso|soc ?2|gold partner|premier partner|compliant with)\b/i,
    message: 'a certification or partnership'
  },
  { pattern: /\b(?:clients?|customers?)\s+(?:like|such as|including)\b/i, message: 'refers to clients' },
  {
    pattern: /\b(?:similar|other)\s+(?:banks?|organi[sz]ations?|clients?|customers?|companies)\b/i,
    message: 'refers to work with other organisations'
  }
];

/** Words that may appear capitalised mid-sentence without being a name we cannot stand behind. */
const NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  'I',
  "I'm",
  "I'll",
  "I've",
  "I'd",
  'Vinay',
  'Hexaware',
  'Lexi',
  'Technologies',
  'ANZ',
  'NZ',
  'AU',
  'Australia',
  'Australian',
  'New',
  'Zealand',
  'Kiwi',
  'Sydney',
  'Auckland'
]);

/** Capitalised words that are not the start of a sentence, and not on the allowlist. */
function unexplainedNames(literal: string): string[] {
  const found: string[] = [];
  for (const sentence of literal.split(/(?<=[.!?])\s+/)) {
    const words = sentence.match(/[A-Za-z][A-Za-z&'-]*/g) ?? [];
    words.slice(1).forEach((word) => {
      const capitalised = /^[A-Z]/.test(word);
      if (capitalised && !NAME_ALLOWLIST.has(word)) found.push(word);
    });
  }
  return [...new Set(found)];
}

export function checkClaims(content: PlaybookContent, index: ClaimIndex, markets: Market[]): ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  const liveConflicts = index.conflicts().filter((c) => c.live);

  for (const { field, text } of textFields(content)) {
    for (const id of new Set(claimIdsIn(text))) {
      const claim = index.find(id);
      if (claim === undefined) {
        findings.push({ rule: 'unknown-claim', field, claimId: id, message: `claim "${id}" is not in the claim index` });
        continue;
      }
      if (claim.status !== 'approved') {
        findings.push({
          rule: 'claim-not-approved',
          field,
          claimId: id,
          message: `claim "${id}" is ${claim.status}, and only an approved claim may be asserted`
        });
        continue;
      }
      const uncovered = markets.filter((m) => !claim.markets.includes(m));
      if (uncovered.length > 0) {
        findings.push({
          rule: 'claim-wrong-market',
          field,
          claimId: id,
          message: `claim "${id}" is not approved for ${uncovered.join(' and ')}`
        });
      }
      if (liveConflicts.some((c) => c.a.id === id || c.b.id === id)) {
        findings.push({
          rule: 'claim-in-live-conflict',
          field,
          claimId: id,
          message: `claim "${id}" contradicts another approved claim; which one Lexi said would depend on nothing`
        });
      }
    }

    const { literal } = parseTemplate(text);
    for (const { pattern, message } of ASSERTIONS) {
      const hit = pattern.exec(literal);
      if (hit !== null) {
        findings.push({
          rule: 'unsourced-assertion',
          field,
          matched: hit[0],
          message: `${message}; that has to arrive through an approved claim, not through wording`
        });
      }
    }
    for (const name of unexplainedNames(literal)) {
      findings.push({
        rule: 'named-entity',
        field,
        matched: name,
        message: `names "${name}"; a client or organisation may only be named through an approved, nameable claim`
      });
    }
  }

  return findings;
}

/** The text of any approved claim, whatever its markets. For rendering a variant to be read, not spoken. */
export function approvedTextAnyMarket(index: ClaimIndex): (id: string) => string | undefined {
  return (id) => {
    const claim = index.find(id);
    return claim !== undefined && claim.status === 'approved' ? claim.text : undefined;
  };
}

/**
 * The text of a claim if, and only if, it may be asserted now. Used at render
 * time as well as at the gate, so a claim that is un-approved after a variant
 * passes silences that variant rather than leaving it to say something stale.
 */
export function approvedClaimText(index: ClaimIndex, market: Market): (id: string) => string | undefined {
  return (id) => {
    const claim = index.find(id);
    if (claim === undefined || claim.status !== 'approved' || !claim.markets.includes(market)) return undefined;
    return claim.text;
  };
}
