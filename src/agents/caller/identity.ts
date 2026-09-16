/**
 * Who Lexi is.
 *
 * Read from `config/agent.yaml`, validated here, and handed to the opening in
 * `opening.ts`. The separation matters: config supplies names, and that is all
 * it can do. It cannot reshape the opening, drop the AI disclosure, or add a
 * sentence - those live in frozen code that Coach has no write access to.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const agentIdentitySchema = z.object({
  agent: z.object({
    /**
     * Empty is a legitimate state for the file to be in, and a fatal one for a
     * call: `buildOpening` refuses rather than improvising a name. An agent that
     * introduces itself as "" has failed its very first obligation.
     */
    name: z.string(),
    gender: z.enum(['female', 'male', 'neutral']),
    accent: z.string().min(1)
  }),
  operator: z.object({
    name: z.string().min(1),
    title: z.string().min(1),
    company: z.string().min(1),
    team: z.string().min(1)
  }),
  callback: z.object({
    number: z.string()
  })
});

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export function loadIdentityFromObject(raw: unknown): AgentIdentity {
  return agentIdentitySchema.parse(raw);
}

export function loadIdentity(path: string): AgentIdentity {
  return loadIdentityFromObject(parseYaml(readFileSync(path, 'utf8')) as unknown);
}

/** Everything that stops this identity being usable on a live call. */
export function identityGaps(identity: AgentIdentity): string[] {
  const gaps: string[] = [];
  if (identity.agent.name.trim() === '') {
    gaps.push('the agent has no name, so it cannot introduce itself (brief section 15 item 1)');
  }
  if (identity.callback.number.trim() === '') {
    gaps.push(
      'no callback number is configured; section 7.3 requires a real, contactable number answerable for 30 days (brief section 15 item 3)'
    );
  }
  return gaps;
}
