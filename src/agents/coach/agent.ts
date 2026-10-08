/**
 * Coach: reads the week, picks the leak, drafts wording for it.
 *
 * Deterministic where it can be (what the evidence says, which slot that points
 * at, what failed before), a model only for the one thing a model is for (the
 * wording), and every word the model returns is validated against the strict slot
 * schema before it leaves this function. Anything that does not validate, or that
 * tries to carry part of the immutable module, is dropped and listed - never
 * returned, never passed to the gate as if it were a proposal.
 */

import { AgentFailure } from '../errors.js';
import { z } from 'zod';
import { COACH_MAY_NOT_EDIT } from '../caller/opening.js';
import type { CoachConfig } from '../../playbook/config.js';
import type { FailureEntry } from '../../playbook/failure-memory.js';
import { findImmutableKeys, type PlaybookContent, type PlaybookSlot, type SlotVersions } from '../../playbook/schema.js';
import { defineAgent, type Agent, type AgentTool } from '../contract.js';
import { coachContract, proposalSchema, type CoachInput, type CoachOutput, type Proposal } from './contract.js';
import { proposerPrompt, type CoachModel } from './model.js';
import { chooseFocus, observedFailures, type WeeklyOutcomes } from './outcomes.js';

interface PlaybookView {
  champions: Partial<Record<PlaybookSlot, PlaybookContent>>;
  championVersions: SlotVersions;
  challenger: { slot: PlaybookSlot; version: number; content: PlaybookContent } | null;
}

interface ClaimView {
  id: string;
  text: string;
}

export interface CoachDeps {
  model: CoachModel;
  config: CoachConfig;
  /** From `coachTools`, or fixtures in a test. The contract declares exactly these. */
  tools: AgentTool[];
  now?: () => Date;
}

const DAY_MS = 86_400_000;
const VARIANT_FAILURES = ['variant-rejected', 'variant-withdrawn', 'variant-inconclusive'];

const replySchema = z.object({ proposals: z.array(z.unknown()) });

function excerptOf(raw: unknown): string {
  const text = JSON.stringify(raw) ?? String(raw);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

export function createCoach(deps: CoachDeps): Agent<CoachInput, CoachOutput> {
  const now = deps.now ?? (() => new Date());

  return defineAgent(coachContract(deps.tools, deps.config.models.proposer), async (ctx): Promise<CoachOutput> => {
    const { weekEnding, maxProposals } = ctx.input;
    const { config } = deps;

    const outcomes = await ctx.call<WeeklyOutcomes>('read-outcomes', { weekEnding, lookbackDays: config.proposals.lookbackDays });
    const playbook = await ctx.call<PlaybookView>('read-playbook', {});
    const failures = await ctx.call<FailureEntry[]>('read-failure-memory', {});
    const claims = await ctx.call<ClaimView[]>('read-approved-claims', {});

    const cooldownSince = new Date(now().getTime() - config.proposals.cooldownDays * DAY_MS);
    const cooldownSlots = [
      ...new Set(
        failures.flatMap((f) => (VARIANT_FAILURES.includes(f.kind) && f.slot !== null && f.lastAt >= cooldownSince ? [f.slot] : []))
      )
    ];

    const failureFacts = observedFailures(outcomes);
    const common = {
      weekEnding,
      variantPerformance: outcomes.variants.filter((r) => r.slot === 'hook' || r.slot === ctx.input.slot),
      failures: failureFacts.map((f) => ({ kind: f.kind, key: f.key, summary: f.summary, ...(f.slot !== undefined ? { slot: f.slot } : {}) }))
    };

    // Which slot: the evidence decides, unless the operator has said otherwise.
    const focus =
      ctx.input.slot !== undefined && playbook.challenger === null
        ? { slot: ctx.input.slot as PlaybookSlot | null, reason: `The operator asked for work on the ${ctx.input.slot}.`, scores: [] }
        : chooseFocus(outcomes, {
            championSlots: Object.keys(playbook.champions) as PlaybookSlot[],
            hasApprovedClaims: claims.length > 0,
            cooldownSlots,
            challengerRunning: playbook.challenger !== null,
            minimumEligible: config.proposals.minEligibleConversations
          });

    const stop = (reason: string): CoachOutput => {
      ctx.note(`proposing nothing: ${reason}`);
      return {
        ...common,
        variantPerformance: outcomes.variants.filter((r) => r.slot === 'hook'),
        slot: null,
        focusReason: reason,
        proposals: [],
        discarded: [],
        changeNote: `Week ending ${weekEnding}. No change to the script: ${reason}`,
        noProposalReason: reason
      };
    };

    if (focus.slot === null) return stop(focus.reason);
    const slot = focus.slot;
    if (slot === 'value-statement' && claims.length === 0) {
      return stop('A value statement has to rest on an approved claim, and none is approved yet.');
    }
    ctx.note(`working on the ${slot}: ${focus.reason}`, { scores: focus.scores });

    const prompt = proposerPrompt({
      slot,
      focusReason: focus.reason,
      maxProposals,
      champion: playbook.champions[slot] ?? null,
      outcomes,
      failures,
      claims
    });
    const reply = await deps.model.propose(prompt);
    ctx.charge(reply.usage ?? {});

    // Rule three: the model's answer is untrusted until it parses.
    const parsedReply = replySchema.safeParse(reply.output);
    if (!parsedReply.success) {
      throw new AgentFailure('output-contract', 'the proposer returned something that was not a list of proposals', {
        issues: parsedReply.error.issues
      });
    }

    const proposals: Proposal[] = [];
    const discarded: CoachOutput['discarded'] = [];
    for (const raw of parsedReply.data.proposals) {
      const excerpt = excerptOf(raw);

      const touched = findImmutableKeys(raw);
      if (touched.length > 0) {
        discarded.push({
          reason: `tries to set ${touched.map((k) => `"${k}"`).join(', ')}, which Coach may never touch (${COACH_MAY_NOT_EDIT.join(', ')}, termination on request, the banned-topic list, the approved-claims boundary)`,
          excerpt
        });
        continue;
      }
      const parsed = proposalSchema.safeParse(raw);
      if (!parsed.success) {
        discarded.push({
          reason: `is not a well-formed ${slot} variant: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(proposal)'}: ${i.message}`).slice(0, 3).join('; ')}`,
          excerpt
        });
        continue;
      }
      if (parsed.data.content.slot !== slot) {
        discarded.push({ reason: `is for the "${parsed.data.content.slot}" slot, and this run is about the "${slot}"; one slot at a time`, excerpt });
        continue;
      }
      if (proposals.length < maxProposals) proposals.push(parsed.data);
    }
    ctx.note(`${proposals.length} proposal(s) well-formed, ${discarded.length} discarded before the gate`);

    const lines = [`Week ending ${weekEnding}. ${focus.reason}`];
    if (proposals.length > 0) {
      lines.push(
        `Coach drafted ${proposals.length} variant(s) for the ${slot}. ${proposals.map((p, i) => `(${i + 1}) ${p.rationale}`).join(' ')} They go through the promotion gate before any call hears them.`
      );
    } else {
      lines.push('No usable variant came back, so nothing goes forward.');
    }
    if (discarded.length > 0) lines.push(`${discarded.length} proposal(s) were thrown out before the gate: ${discarded.map((d) => d.reason).join('; ')}.`);

    return {
      ...common,
      variantPerformance: outcomes.variants.filter((r) => r.slot === 'hook' || r.slot === slot),
      slot,
      focusReason: focus.reason,
      proposals,
      discarded,
      changeNote: lines.join(' '),
      noProposalReason: proposals.length > 0 ? null : 'the proposer returned no variant that survived validation'
    };
  });
}
