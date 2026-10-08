/**
 * Counting what each arm of a test actually did.
 *
 * This turns calls into the `ArmEvidence` the gate decides on. The gate does the
 * judging; this module only counts, and it counts conservatively: a call whose
 * defects column cannot be read is counted as defective, because "I could not
 * tell" is not "it was clean".
 *
 * Population. Every rate is over *eligible* conversations: a person answered and
 * the call survived the opener. The opener is frozen and identical in both arms, so
 * a call that ended inside it says nothing about the slot under test, and counting
 * it would only dilute the difference. A variant that makes people hang up at
 * twenty seconds is still counted - at twenty seconds the opener has been survived.
 *
 * Arms. A call belongs to an arm by the version of the slot under test that it ran
 * with, read from its recorded assignment (falling back to the version name on the
 * call). A call whose version cannot be established belongs to neither: it is left
 * out, not guessed into one.
 */

import { isOpeningLine, quoteOf, versionRunWith } from '../agents/analyst/metrics.js';
import { loadCallFacts, type CallFact } from '../agents/analyst/facts.js';
import type { Blackboard } from '../blackboard/client.js';
import type { PromotionThresholds } from './config.js';
import type { ArmEvidence } from './gate.js';
import type { PlaybookSlot } from './schema.js';

export interface ArmSelector {
  slot: PlaybookSlot;
  /** The version of the slot, or null for calls that ran with no content in it. */
  version: number | null;
  thresholds: PromotionThresholds;
  /** Only calls that started at or after this. A test counts only calls made during it. */
  since?: Date;
  until?: Date;
  /** The frozen opening's lines, so audit flags quoting them are not counted against a variant. */
  openingTexts?: string[];
}

export const EMPTY_ARM: ArmEvidence = Object.freeze({
  eligible: 0,
  completed: 0,
  requests: 0,
  sentimentKnown: 0,
  negative: 0,
  defective: 0,
  hardFailures: 0
});

function inKinds(kinds: readonly string[], kind: string): boolean {
  return kinds.includes(kind);
}

function isDefective(fact: CallFact, t: PromotionThresholds, openingTexts: string[]): boolean {
  if (fact.unreadable.length > 0) return true;
  return fact.defects.some(
    (d) =>
      inKinds(t.defectKindsCounted, d.kind) && !(d.kind === 'unsupported-claim' && isOpeningLine(quoteOf(d.detail), openingTexts))
  );
}

export function armMembers(facts: CallFact[], selector: ArmSelector): CallFact[] {
  return facts.filter((f) => {
    if (selector.since !== undefined && f.startedAt < selector.since) return false;
    if (selector.until !== undefined && f.startedAt >= selector.until) return false;
    return versionRunWith(f, selector.slot) === selector.version;
  });
}

export function armEvidenceFromFacts(facts: CallFact[], selector: ArmSelector): ArmEvidence {
  const t = selector.thresholds;
  const openingTexts = selector.openingTexts ?? [];
  const members = armMembers(facts, selector);

  const eligible = members.filter((f) => f.survivedOpener);
  const known = eligible.filter((f) => f.sentiment !== 'unknown');

  return {
    eligible: eligible.length,
    completed: eligible.filter((f) => f.outcome !== null).length,
    requests: eligible.filter((f) => f.outcome === 'meeting_requested').length,
    sentimentKnown: known.length,
    negative: known.filter((f) => f.sentiment === 'negative').length,
    defective: eligible.filter((f) => isDefective(f, t, openingTexts)).length,
    // A missing disclosure matters on any answered call, not only one that lasted.
    hardFailures: members.filter((f) => f.answered && f.defects.some((d) => inKinds(t.hardFailKinds, d.kind))).length
  };
}

export interface TestWindow {
  slot: PlaybookSlot;
  championVersion: number | null;
  challengerVersion: number;
  /** When the challenger started: the test counts only calls made since. */
  since: Date;
  until: Date;
  thresholds: PromotionThresholds;
  openingTexts?: string[];
}

export async function loadTestEvidence(db: Blackboard, window: TestWindow): Promise<{ champion: ArmEvidence; challenger: ArmEvidence }> {
  const facts = await loadCallFacts(db, { from: window.since, to: window.until });
  const common = {
    slot: window.slot,
    thresholds: window.thresholds,
    since: window.since,
    until: window.until,
    ...(window.openingTexts !== undefined ? { openingTexts: window.openingTexts } : {})
  };
  return {
    champion: armEvidenceFromFacts(facts, { ...common, version: window.championVersion }),
    challenger: armEvidenceFromFacts(facts, { ...common, version: window.challengerVersion })
  };
}

/** A promoted champion's calls since it was promoted, for the post-promotion watch. */
export async function loadWatchEvidence(
  db: Blackboard,
  window: { slot: PlaybookSlot; version: number; since: Date; until: Date; thresholds: PromotionThresholds; openingTexts?: string[] }
): Promise<ArmEvidence> {
  const facts = await loadCallFacts(db, { from: window.since, to: window.until });
  return armEvidenceFromFacts(facts, {
    slot: window.slot,
    version: window.version,
    thresholds: window.thresholds,
    since: window.since,
    until: window.until,
    ...(window.openingTexts !== undefined ? { openingTexts: window.openingTexts } : {})
  });
}
