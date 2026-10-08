/**
 * ICP scoring (section 5.2): how well does this person fit the campaign.
 *
 * A pure function of the person, the ICP and the weights, with no I/O and no
 * model, because the score decides whether a credit is spent. It is explainable
 * line by line, which is what lets the operator tune the title list and the
 * minimum score on the account desk and see why someone did or did not clear it.
 *
 * Matching is by word, not by substring. The Phase 2 scorer used substrings, and
 * "cto" is a substring of "dire-cto-r", so a Marketing Director cleared the bar
 * as a Chief Technology Officer. A phrase here must start and end on a word
 * boundary (a trailing plural "s" is tolerated). "head of data" still catches
 * "Group Head of Data & Analytics", which is what the title list relies on.
 */

import type { Icp } from '../blackboard/schemas.js';
import type { ScoringWeights } from './config.js';

export const DEFAULT_WEIGHTS: ScoringWeights = { title: 55, seniority: 35, profile: 10 };

/** Highest first. Used to break ties between equal scores. */
export const SENIORITY_RANK: Record<string, number> = {
  owner: 9,
  founder: 9,
  c_suite: 8,
  partner: 7,
  vp: 6,
  head: 5,
  director: 4,
  manager: 3,
  senior: 2,
  entry: 1,
  intern: 0
};

export interface ScorablePerson {
  title: string;
  /** Apollo's seniority band, when the search returned one. */
  seniority?: string | undefined;
  linkedinUrl?: string | undefined;
}

export interface ScoreResult {
  /** 0 to 100, normalised against the weights in use. */
  score: number;
  rationale: string;
  disqualified: boolean;
  /** The seniority the score used, which may have been read off the title. */
  seniority: string;
  seniorityInferred: boolean;
  matchedTitle?: string;
}

function words(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Whole-word, whole-phrase containment, tolerating a trailing plural. */
export function containsPhrase(title: string, phrase: string): boolean {
  const needle = words(phrase).trim();
  if (needle === '') return false;
  const haystack = words(title);
  return haystack.includes(` ${needle} `) || haystack.includes(` ${needle}s `);
}

function normaliseBand(band: string): string {
  return band.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Read a seniority band off a title, for when Apollo did not say. The current
 * People Search omits seniority, so without this every search result would score
 * as if it had none.
 */
export function inferSeniority(title: string): string | undefined {
  const t = words(title);
  if (/ (chief|ceo|cio|cto|cdo|cfo|coo|ciso|cro|cmo) /.test(t)) return 'c_suite';
  if (/ (vp|svp|evp|vice president) /.test(t)) return 'vp';
  if (/ (head|general manager|gm) /.test(t)) return 'head';
  if (/ (director|directors) /.test(t)) return 'director';
  if (/ (manager|managers|lead) /.test(t)) return 'manager';
  if (/ (senior|principal|architect) /.test(t)) return 'senior';
  if (/ (intern|graduate|trainee) /.test(t)) return 'intern';
  return undefined;
}

export function scorePerson(
  person: ScorablePerson,
  icp: Pick<Icp, 'titles' | 'seniorities' | 'disqualifiers'>,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ScoreResult {
  const total = weights.title + weights.seniority + weights.profile;
  if (total <= 0) throw new Error('scoring weights must add up to more than zero');

  const reported = person.seniority === undefined || person.seniority.trim() === '' ? undefined : normaliseBand(person.seniority);
  const inferred = reported === undefined ? inferSeniority(person.title) : undefined;
  const seniority = reported ?? inferred ?? 'unknown';
  const seniorityInferred = reported === undefined && inferred !== undefined;

  const disqualifier = icp.disqualifiers.find((d) => containsPhrase(person.title, d));
  if (disqualifier !== undefined) {
    return {
      score: 0,
      rationale: `disqualified by "${disqualifier}"`,
      disqualified: true,
      seniority,
      seniorityInferred
    };
  }

  const reasons: string[] = [];
  let earned = 0;

  const titleHit = icp.titles.find((t) => containsPhrase(person.title, t));
  if (titleHit !== undefined) {
    earned += weights.title;
    reasons.push(`title matches "${titleHit}"`);
  }
  if (icp.seniorities.some((s) => normaliseBand(s) === seniority)) {
    earned += weights.seniority;
    reasons.push(`${seniority}${seniorityInferred ? ' (read from the title)' : ''} is a target seniority`);
  }
  if (person.linkedinUrl !== undefined && person.linkedinUrl.trim() !== '') {
    earned += weights.profile;
    reasons.push('has a public profile to research');
  }

  return {
    score: Math.min(100, Math.round((earned / total) * 100)),
    rationale: reasons.length > 0 ? reasons.join('; ') : 'nothing in the ICP matched',
    disqualified: false,
    seniority,
    seniorityInferred,
    ...(titleHit !== undefined ? { matchedTitle: titleHit } : {})
  };
}

/** Best first: score, then seniority, then name, so the order never depends on search order. */
export function rankCandidates<T extends { score: number; seniority: string; sortName: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) =>
      b.score - a.score ||
      (SENIORITY_RANK[b.seniority] ?? -1) - (SENIORITY_RANK[a.seniority] ?? -1) ||
      a.sortName.localeCompare(b.sortName)
  );
}
