/**
 * `config/coach.yaml`, loaded through floors it cannot go below.
 *
 * The same idea as the compliance policy: configuration may make the promotion
 * gate stricter and may never loosen it past what the brief says. A file that
 * asks for fewer than 30 conversations per arm, an alpha that would promote on a
 * coin flip, or a hard-fail list without the disclosure does not load at all - a
 * refusal is louder than a silently clamped number.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { defectSchema } from '../blackboard/schemas.js';

/** Section 11 item 4. Not configurable below this. */
export const MIN_CONVERSATIONS_FLOOR = 30;
/** One-sided. 0.10 is already generous; anything above is a coin flip with extra steps. */
export const MAX_ALPHA = 0.1;
/** A lift smaller than two points is indistinguishable from noise at these sample sizes. */
export const MIN_LIFT_FLOOR = 0.02;

const defectKindSchema = defectSchema.shape.kind;
export type DefectKind = z.infer<typeof defectKindSchema>;

const fraction = z.number().min(0).max(1);

const rawSchema = z.object({
  models: z.object({
    proposer: z.string().min(1),
    reviewer: z.string().min(1),
    max_tokens: z.number().int().positive(),
    price_usd_per_mtok: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
  }),
  promotion: z.object({
    min_conversations_per_arm: z.number().int().min(MIN_CONVERSATIONS_FLOOR),
    max_conversations_per_arm: z.number().int().positive(),
    alpha: z.number().positive().max(MAX_ALPHA),
    min_absolute_lift: z.number().min(MIN_LIFT_FLOOR).max(1),
    min_sentiment_coverage: z.number().min(0.5).max(1),
    degradation: z.object({
      // Higher is MORE sensitive to harm, so the floor is on the low side.
      alpha: z.number().min(0.05).max(0.5),
      max_completion_drop: fraction.max(0.1),
      max_negative_sentiment_rise: fraction.max(0.1),
      max_defect_rate_rise: fraction.max(0.05)
    }),
    defect_kinds_counted: z.array(defectKindSchema).min(1),
    hard_fail_kinds: z.array(defectKindSchema).min(1)
  }),
  assignment: z.object({ challenger_share: z.number().min(0.05).max(0.5) }),
  monitoring: z.object({ post_promotion_min_conversations: z.number().int().min(MIN_CONVERSATIONS_FLOOR) }),
  proposals: z.object({
    max_per_run: z.number().int().min(1).max(5),
    min_eligible_conversations: z.number().int().min(1),
    lookback_days: z.number().int().min(7),
    cooldown_days: z.number().int().min(0),
    max_challenger_age_days: z.number().int().min(7)
  })
});

export interface PromotionThresholds {
  minConversationsPerArm: number;
  maxConversationsPerArm: number;
  alpha: number;
  minAbsoluteLift: number;
  minSentimentCoverage: number;
  degradationAlpha: number;
  maxCompletionDrop: number;
  maxNegativeSentimentRise: number;
  maxDefectRateRise: number;
  defectKindsCounted: DefectKind[];
  hardFailKinds: DefectKind[];
}

export interface CoachConfig {
  models: { proposer: string; reviewer: string; maxTokens: number; priceUsdPerMTok: { input: number; output: number } };
  promotion: PromotionThresholds;
  assignment: { challengerShare: number };
  monitoring: { postPromotionMinConversations: number };
  proposals: {
    maxPerRun: number;
    minEligibleConversations: number;
    lookbackDays: number;
    cooldownDays: number;
    maxChallengerAgeDays: number;
  };
}

export function loadCoachConfigFromObject(raw: unknown): CoachConfig {
  const parsed = rawSchema.parse(raw);
  const p = parsed.promotion;

  if (p.max_conversations_per_arm < p.min_conversations_per_arm) {
    throw new Error('promotion.max_conversations_per_arm cannot be below min_conversations_per_arm');
  }
  if (!p.hard_fail_kinds.includes('disclosure-missing')) {
    // The AI disclosure is rule two of the brief. A config that stops treating its
    // absence as an immediate withdrawal is a config that makes the rule optional.
    throw new Error('promotion.hard_fail_kinds must include disclosure-missing');
  }
  if (!p.defect_kinds_counted.includes('disclosure-missing')) {
    throw new Error('promotion.defect_kinds_counted must include disclosure-missing');
  }

  return {
    models: {
      proposer: parsed.models.proposer,
      reviewer: parsed.models.reviewer,
      maxTokens: parsed.models.max_tokens,
      priceUsdPerMTok: parsed.models.price_usd_per_mtok
    },
    promotion: {
      minConversationsPerArm: p.min_conversations_per_arm,
      maxConversationsPerArm: p.max_conversations_per_arm,
      alpha: p.alpha,
      minAbsoluteLift: p.min_absolute_lift,
      minSentimentCoverage: p.min_sentiment_coverage,
      degradationAlpha: p.degradation.alpha,
      maxCompletionDrop: p.degradation.max_completion_drop,
      maxNegativeSentimentRise: p.degradation.max_negative_sentiment_rise,
      maxDefectRateRise: p.degradation.max_defect_rate_rise,
      defectKindsCounted: p.defect_kinds_counted,
      hardFailKinds: p.hard_fail_kinds
    },
    assignment: { challengerShare: parsed.assignment.challenger_share },
    monitoring: { postPromotionMinConversations: parsed.monitoring.post_promotion_min_conversations },
    proposals: {
      maxPerRun: parsed.proposals.max_per_run,
      minEligibleConversations: parsed.proposals.min_eligible_conversations,
      lookbackDays: parsed.proposals.lookback_days,
      cooldownDays: parsed.proposals.cooldown_days,
      maxChallengerAgeDays: parsed.proposals.max_challenger_age_days
    }
  };
}

export function loadCoachConfig(path: string): CoachConfig {
  return loadCoachConfigFromObject(parseYaml(readFileSync(path, 'utf8')) as unknown);
}
