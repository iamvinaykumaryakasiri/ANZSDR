/**
 * Guardian layer three: the post-call audit.
 *
 * Section 6: Guardian re-checks the transcript afterwards and logs any
 * unsupported assertion as a defect in the daily digest. Nothing here can undo
 * a call - it is already over. What it produces is the record that says what
 * actually happened, which is what the kill switch's auto-trip reads and what
 * Coach's promotion gate is measured against.
 *
 * Two halves, and the split is deliberate.
 *
 * The deterministic half needs no model and cannot be talked out of anything:
 * was the disclosure actually spoken, did a banned phrase survive, was a time
 * presented as booked. These are the findings that matter most and they are the
 * ones a model is least needed for.
 *
 * The model half reads the transcript for assertions that trip no pattern and
 * are still unsupported - a capability claimed in passing, a number rounded
 * into existence, a client implied without being named. It runs on a stronger
 * model than the call itself, because it has no latency budget and one job.
 */

import { z } from 'zod';
import type { ClaimIndex } from '../../knowledge/claims.js';
import { matchingRule } from './stream-filter.js';
import { missingSegments, type OpeningSegment, type SegmentId } from '../caller/opening.js';

export interface TranscriptTurn {
  speaker: 'lexi' | 'prospect';
  text: string;
  atSecond: number;
}

export type AuditFindingKind =
  | 'disclosure-missing'
  | 'banned-topic'
  | 'unsupported-claim'
  | 'over-commitment'
  | 'injection-attempt';

export interface AuditFinding {
  kind: AuditFindingKind;
  detail: string;
  atSecond?: number;
  /** Deterministic findings are certain. Model findings are not. */
  certainty: 'certain' | 'likely';
}

export interface AuditResult {
  findings: AuditFinding[];
  /** True when nothing was found. What the digest reports as a clean call. */
  clean: boolean;
  /** Set when the model half could not run. The audit is then partial. */
  modelUnavailable?: string;
}

export const assertionFindingSchema = z.object({
  findings: z
    .array(
      z.object({
        quote: z.string().min(1),
        why: z.string().min(1)
      })
    )
    .default([])
});

export interface AuditModel {
  review(prompt: string): Promise<unknown>;
}

export interface AuditOptions {
  transcript: TranscriptTurn[];
  claims: ClaimIndex;
  /** What the opening was meant to contain. */
  openingSaid: OpeningSegment[];
  model?: AuditModel;
}

/** Everything Lexi said, in order. */
function lexiTurns(transcript: TranscriptTurn[]): TranscriptTurn[] {
  return transcript.filter((t) => t.speaker === 'lexi');
}

/**
 * Was the disclosure actually spoken, rather than merely composed?
 *
 * A turn cut mid-stream can contain a disclosure that never reached the
 * prospect, so this reads the transcript rather than the plan. Section 0's
 * second rule is about what the prospect heard.
 */
export function auditDisclosure(transcript: TranscriptTurn[], openingSaid: OpeningSegment[]): AuditFinding[] {
  const missing: SegmentId[] = missingSegments(openingSaid);
  const spoken = lexiTurns(transcript).map((t) => t.text).join(' ');

  const findings: AuditFinding[] = [];
  for (const segment of missing) {
    findings.push({
      kind: 'disclosure-missing',
      detail: `the opening never reached its "${segment}" segment`,
      certainty: 'certain'
    });
  }

  // Belt and braces: the segment list says it was planned, the transcript says
  // whether it was said. Disagreement is itself the finding.
  if (!/\bAI\b/i.test(spoken) && !missing.includes('ai-disclosure')) {
    findings.push({
      kind: 'disclosure-missing',
      detail: 'the AI disclosure was in the plan but does not appear anywhere in what was actually said',
      certainty: 'certain'
    });
  }
  return findings;
}

/** A banned phrase that survived into the transcript. Layer one failing. */
export function auditBannedTopics(transcript: TranscriptTurn[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const turn of lexiTurns(transcript)) {
    const rule = matchingRule(turn.text);
    if (rule === null) continue;
    findings.push({
      kind: rule.category === 'commitment' ? 'over-commitment' : 'banned-topic',
      detail: `${rule.why}: "${turn.text.slice(0, 140)}"`,
      atSecond: turn.atSecond,
      certainty: 'certain'
    });
  }
  return findings;
}

export function auditPrompt(transcript: TranscriptTurn[], assertable: string[]): string {
  const claims =
    assertable.length === 0
      ? '(none — Lexi was permitted to state no fact about Hexaware at all)'
      : assertable.map((c) => `- ${c}`).join('\n');

  const lines = transcript
    .map((t) => `[${t.atSecond}s] ${t.speaker === 'lexi' ? 'LEXI' : 'PROSPECT'}: ${t.text}`)
    .join('\n');

  return `Read this call transcript. Lexi is an AI assistant calling on behalf of Hexaware.

THE ONLY FACTS LEXI WAS PERMITTED TO ASSERT:
${claims}

Find every factual assertion Lexi made that is not supported by that list. Count
as assertions: capabilities, numbers, client references, certifications,
partnerships, comparisons, and anything stated as true about Hexaware or its
work. Do not count questions, pleasantries, or things the prospect said.

TRANSCRIPT:
${lines}

Reply with JSON only: {"findings":[{"quote":"...","why":"..."}]}
Quote Lexi's exact words. If everything Lexi asserted is on the list, return an
empty findings array.`;
}

export async function auditCall(options: AuditOptions): Promise<AuditResult> {
  const findings: AuditFinding[] = [
    ...auditDisclosure(options.transcript, options.openingSaid),
    ...auditBannedTopics(options.transcript)
  ];

  let modelUnavailable: string | undefined;

  if (options.model !== undefined) {
    const assertable = options.claims.assertable().map((c) => c.text);
    try {
      const raw = await options.model.review(auditPrompt(options.transcript, assertable));
      const parsed = assertionFindingSchema.safeParse(raw);
      if (parsed.success) {
        for (const finding of parsed.data.findings) {
          findings.push({
            kind: 'unsupported-claim',
            detail: `"${finding.quote}" — ${finding.why}`,
            certainty: 'likely'
          });
        }
      } else {
        modelUnavailable = 'the audit model returned something that was not a findings list';
      }
    } catch (error) {
      modelUnavailable = `the audit model did not return: ${(error as Error).message}`;
    }
  } else {
    modelUnavailable = 'no audit model was configured, so only the deterministic checks ran';
  }

  const result: AuditResult = { findings, clean: findings.length === 0 };
  if (modelUnavailable !== undefined) result.modelUnavailable = modelUnavailable;
  return result;
}
