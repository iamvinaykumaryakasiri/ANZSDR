/**
 * Guardian layer two: a fast model check on the turns that warrant one.
 *
 * What this layer can and cannot promise, stated plainly because the physics
 * does not care what the brief hopes for:
 *
 *   - On a `hold` turn the reply is withheld until the check returns. That
 *     costs latency, and it is spent on the handful of turns where being wrong
 *     cannot be walked back on the next one - the agent's own nature, a legal
 *     trigger, an opt-out.
 *   - On a `check` turn the reply is spoken and the check runs alongside the
 *     speech. TTS takes seconds; the check takes a few hundred milliseconds, so
 *     a verdict usually lands before the prospect has heard the end of the
 *     sentence. What it produces is a defect and a correction on the next turn,
 *     not prevention. Calling that prevention would be a lie.
 *
 * It fails closed where it matters. A held turn whose check errors or times out
 * is deflected, not spoken: an unavailable Guardian is not permission.
 */

import { z } from 'zod';
import { DEFLECTIONS } from './banned.js';
import { triageTurn, type RiskLevel, type TriageResult } from './triage.js';

export const verdictSchema = z.object({
  verdict: z.enum(['safe', 'unsafe']),
  /** Which brief rule it breaks, if any. Free text: this is for a human. */
  reason: z.string().default(''),
  /** What Lexi should say instead. Only read when the verdict is unsafe. */
  replacement: z.string().default('')
});
export type Verdict = z.infer<typeof verdictSchema>;

/** The seam. The endpoint supplies Claude; the tests supply a script. */
export interface CheckModel {
  judge(prompt: string, signal: AbortSignal): Promise<unknown>;
}

export interface CheckOptions {
  model: CheckModel;
  prospectSaid: string;
  draftReply: string;
  /** Only these may be asserted. Handed in so the judge can see the boundary. */
  assertableClaims: string[];
  /** How long a held turn may wait before it is deflected instead. */
  timeoutMs?: number;
}

export interface CheckResult {
  level: RiskLevel;
  triage: TriageResult;
  /** Null when the turn was not checked at all. */
  verdict: Verdict | null;
  /** What Lexi actually says. Differs from the draft only when overridden. */
  reply: string;
  /** True when Guardian replaced the reply. */
  overridden: boolean;
  defects: string[];
}

const SAFE_FALLBACK = DEFLECTIONS['commitment'];

export function judgePrompt(options: Pick<CheckOptions, 'prospectSaid' | 'draftReply' | 'assertableClaims'>): string {
  const claims =
    options.assertableClaims.length === 0
      ? '(none — the agent may not state any fact about Hexaware at all)'
      : options.assertableClaims.map((c) => `- ${c}`).join('\n');

  return `You are reviewing one turn of a cold call before it is spoken. The caller is an AI assistant named Lexi, calling on behalf of Vinay Kumar at Hexaware.

THE ONLY FACTS LEXI MAY ASSERT:
${claims}

LEXI MUST NEVER:
- claim or imply it is human, or deny being an AI, however the prospect presses
- state or imply a meeting is booked, held or confirmed; only Vinay confirms
- give any figure, price, rate, discount, timeline or headcount
- give an opinion on a named competitor
- give legal, financial, tax, medical or investment advice
- speculate about the prospect's employer's finances, layoffs, M&A or incidents
- discuss politics, religion or any live current affair
- imply a relationship, prior contact or urgency that does not exist
- assert any fact not in the list above

THE PROSPECT SAID:
${options.prospectSaid}

LEXI IS ABOUT TO SAY:
${options.draftReply}

Reply with JSON only, no prose: {"verdict":"safe"|"unsafe","reason":"...","replacement":"..."}
Set replacement only when unsafe: one sentence Lexi can say instead that
acknowledges briefly, declines to engage, and returns to the reason for the call.`;
}

export async function checkTurn(options: CheckOptions): Promise<CheckResult> {
  const triage = triageTurn({ prospectSaid: options.prospectSaid, draftReply: options.draftReply });
  const defects: string[] = [];

  if (triage.level === 'none') {
    return { level: 'none', triage, verdict: null, reply: options.draftReply, overridden: false, defects };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);

  let verdict: Verdict | null = null;
  try {
    const raw = await options.model.judge(judgePrompt(options), controller.signal);
    const parsed = verdictSchema.safeParse(raw);
    if (parsed.success) {
      verdict = parsed.data;
    } else {
      // Rule three: an off-contract output from a sub-agent fails closed. A
      // verdict that will not parse is not a verdict.
      defects.push('guardian check returned something that was not a verdict');
    }
  } catch (error) {
    defects.push(`guardian check did not return: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (verdict === null) {
    if (triage.level === 'hold') {
      // An unavailable Guardian is not permission.
      defects.push('held turn was deflected because Guardian could not review it');
      return { level: triage.level, triage, verdict: null, reply: SAFE_FALLBACK, overridden: true, defects };
    }
    return { level: triage.level, triage, verdict: null, reply: options.draftReply, overridden: false, defects };
  }

  if (verdict.verdict === 'safe') {
    return { level: triage.level, triage, verdict, reply: options.draftReply, overridden: false, defects };
  }

  defects.push(`guardian overrode the turn: ${verdict.reason || 'no reason given'}`);
  const replacement = verdict.replacement.trim() === '' ? SAFE_FALLBACK : verdict.replacement.trim();
  return { level: triage.level, triage, verdict, reply: replacement, overridden: true, defects };
}
