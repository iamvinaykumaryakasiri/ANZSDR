/**
 * Claude behind Coach's two seams: the proposer and the compliance reviewer.
 *
 * Two clients' worth of separation, not one: the proposer and the reviewer are
 * different objects with different instance ids, each call is a fresh single-turn
 * conversation, and the reviewer is handed the variant's rendered wording and the
 * rules and nothing the proposer said about it. This is the only file in the Coach
 * build that knows about the Anthropic SDK; everything else runs on scripted models
 * with no key and no network.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import type { CoachConfig } from '../../playbook/config.js';
import type { ComplianceReviewer } from '../../playbook/review.js';
import { extractJson } from '../../playbook/util.js';
import type { CoachModel } from './model.js';
import { costUsd } from './usage.js';

const ROLE = resolve(dirname(fileURLToPath(import.meta.url)), 'role.md');

async function askForJson(
  client: Anthropic,
  model: string,
  maxTokens: number,
  prompt: string,
  system?: string
): Promise<{ output: unknown; tokensIn: number; tokensOut: number }> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system !== undefined ? { system } : {}),
    messages: [{ role: 'user', content: prompt }]
  });
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  return { output: extractJson(text), tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens };
}

export function claudeCoachModel(client: Anthropic, config: CoachConfig): CoachModel {
  const system = readFileSync(ROLE, 'utf8');
  return {
    instanceId: 'coach-proposer',
    async propose(prompt) {
      const r = await askForJson(client, config.models.proposer, config.models.maxTokens, prompt, system);
      return {
        output: r.output,
        usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, usd: costUsd(r.tokensIn, r.tokensOut, config.models.priceUsdPerMTok) }
      };
    }
  };
}

export function claudeComplianceReviewer(client: Anthropic, config: CoachConfig): ComplianceReviewer {
  return {
    instanceId: 'coach-compliance-reviewer',
    async review(prompt) {
      return (await askForJson(client, config.models.reviewer, config.models.maxTokens, prompt)).output;
    }
  };
}
