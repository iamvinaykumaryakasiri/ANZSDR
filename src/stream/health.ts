/**
 * Health: is the plumbing up, what has it cost, and what is the gate refusing.
 *
 * A provider shown "ok" here means "configured", not "answered a ping a moment
 * ago", and the detail says so. A health page that claimed more would be the one
 * place in the console that guessed.
 */

import { z } from 'zod';
import { campaignGoalSchema, decode } from '../blackboard/schemas.js';
import type { healthSchema } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { DAY_MS, readJson, usd } from './util.js';

type HealthView = z.infer<typeof healthSchema>;
type Provider = HealthView['providers'][number];

const set = (env: Record<string, string | undefined>, ...names: string[]): boolean =>
  names.some((n) => (env[n] ?? '').trim() !== '');

export async function providerStatuses(deps: ConsoleDeps): Promise<Provider[]> {
  const { env } = deps;
  const out: Provider[] = [];

  try {
    await deps.db.$queryRaw`SELECT 1`;
    out.push({ name: 'Blackboard (database)', status: 'ok' });
  } catch (error) {
    out.push({ name: 'Blackboard (database)', status: 'down', detail: (error as Error).message });
  }

  const unverified = deps.calendar.unverifiedYears();
  const years = [...new Set(unverified.map((u) => u.year))].sort();
  out.push(
    deps.policy.holidays.require_verified_calendar && years.length > 0
      ? {
          name: 'Holiday calendar',
          status: 'degraded',
          detail: `${years.join(' and ')} dates are not signed off, so dials on them are refused until npm run holidays:verify is run`
        }
      : { name: 'Holiday calendar', status: 'ok' }
  );

  const callerIds = deps.policy.caller_id;
  out.push(
    callerIds.au_number.trim() === '' && callerIds.nz_number.trim() === ''
      ? { name: 'Caller ID numbers', status: 'not_configured', detail: 'none set in config/policy.yaml, so the gate refuses every dial' }
      : callerIds.au_number.trim() === '' || callerIds.nz_number.trim() === ''
        ? { name: 'Caller ID numbers', status: 'degraded', detail: 'only one market has a number set' }
        : { name: 'Caller ID numbers', status: 'ok' }
  );

  out.push(
    set(env, 'ANTHROPIC_API_KEY', 'LEXI_ANTHROPIC_API_KEY')
      ? { name: 'Anthropic', status: 'ok', detail: 'key present; not checked live' }
      : { name: 'Anthropic', status: 'not_configured', detail: 'no API key set' }
  );
  out.push(
    set(env, 'APOLLO_API_KEY')
      ? { name: 'Apollo', status: 'ok', detail: 'key present; not checked live' }
      : { name: 'Apollo', status: 'not_configured', detail: 'no API key set' }
  );
  out.push(
    set(env, 'VAPI_API_KEY')
      ? { name: 'Voice provider', status: 'ok', detail: 'key present; not checked live' }
      : { name: 'Voice provider', status: 'not_configured', detail: 'no API key set' }
  );
  out.push(
    set(env, 'TWILIO_ACCOUNT_SID') && set(env, 'TWILIO_AUTH_TOKEN')
      ? { name: 'Twilio', status: 'ok', detail: 'credentials present; not checked live' }
      : { name: 'Twilio', status: 'not_configured', detail: 'no credentials set' }
  );
  out.push(
    deps.operator.email === ''
      ? { name: 'Meeting-request mail', status: 'not_configured', detail: 'no operator email set, so requests are recorded but not sent' }
      : { name: 'Meeting-request mail', status: 'ok', detail: 'operator address set' }
  );

  return out;
}

/** How many times the gate said no, by reason, over the last `days` days. */
export async function gateRejections(deps: ConsoleDeps, now: Date, days = 7): Promise<HealthView['gateRejections']> {
  const rows = await deps.db.auditRecord.findMany({
    where: { kind: 'dial-decision', at: { gte: new Date(now.getTime() - days * DAY_MS) } },
    select: { data: true },
    take: 5000
  });
  const shape = z.object({ decision: z.object({ allowed: z.boolean(), reasons: z.array(z.object({ code: z.string() })) }) });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const parsed = readJson(row.data, shape.passthrough(), null);
    if (parsed === null || parsed.decision.allowed) continue;
    for (const { code } of parsed.decision.reasons) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 12);
}

/**
 * The monthly ceiling the console shows.
 *
 * The Director enforces a weekly ceiling (the campaign goal, edited on the
 * account desk), and nothing in the brief fixes a monthly one yet (section 15
 * item 8). So: an explicit `MONTHLY_SPEND_CEILING_USD` if one is set, otherwise
 * the weekly ceilings of the active campaigns scaled to a month. Null when there
 * is neither, rather than a number with nothing behind it.
 */
export async function monthlyCeiling(deps: ConsoleDeps): Promise<number | null> {
  const explicit = Number(deps.env.MONTHLY_SPEND_CEILING_USD ?? '');
  if (Number.isFinite(explicit) && explicit > 0) return usd(explicit);

  const campaigns = await deps.db.campaign.findMany({ where: { status: 'active' } });
  const weekly = campaigns
    .map((c) => decode(campaignGoalSchema, 'Campaign.goal', c.goal).maxUsdPerWeek)
    .reduce((a, b) => a + b, 0);
  return weekly > 0 ? usd((weekly * 52) / 12) : null;
}
