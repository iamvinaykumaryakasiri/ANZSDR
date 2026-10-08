/**
 * What Analyst can read. Everything here is a read; Analyst has no tool that writes
 * to the blackboard, sends anything or spends anything.
 */

import { z } from 'zod';
import type { Blackboard } from '../../blackboard/client.js';
import { campaignGoalSchema, decode } from '../../blackboard/schemas.js';
import type { KillSwitchStore } from '../../compliance/kill-switch.js';
import { refFor } from '../concierge/ref.js';
import type { CoachConfig } from '../../playbook/config.js';
import { loadTestEvidence } from '../../playbook/evidence.js';
import { armRates } from '../../playbook/gate.js';
import { PLAYBOOK_SLOTS } from '../../playbook/schema.js';
import type { PlaybookStore } from '../../playbook/store.js';
import type { AgentIdentity } from '../caller/identity.js';
import type { AgentTool } from '../contract.js';
import type { DailyDigest } from './contract.js';
import { loadCallFacts } from './facts.js';
import { openingTextsForContacts } from './opening-lines.js';
import { dayContaining, dayWindow, loadGateRejections, loadQueueCounts, loadSpend, shiftDays, OPERATOR_ZONE } from './metrics.js';
import { DateTime } from 'luxon';

export interface AnalystToolDeps {
  db: Blackboard;
  store: PlaybookStore;
  config: CoachConfig;
  identity: AgentIdentity;
  zone?: string;
  /** To say whether dialling is halted. Absent: the digest does not claim either way. */
  killSwitch?: KillSwitchStore;
}

const dayArgs = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const atArgs = z.object({ generatedAt: z.string().datetime() });
const HOUR_MS = 3_600_000;

export function analystTools(deps: AnalystToolDeps): AgentTool[] {
  const zone = deps.zone ?? OPERATOR_ZONE;

  return [
    {
      name: 'read-calls',
      description: 'The day\'s calls and the seven days before them, as facts.',
      input: dayArgs,
      usdPerCall: 0,
      handler: async (args) => {
        const { day } = dayArgs.parse(args);
        const w = dayWindow(day, zone);
        const before = shiftDays(w, -7);
        return {
          facts: await loadCallFacts(deps.db, { from: w.from, to: w.to }),
          baselineFacts: await loadCallFacts(deps.db, { from: before.from, to: w.from })
        };
      }
    },
    {
      name: 'read-queue',
      description: 'Who was queued, how many cleared the compliance gate, why it refused, and escalations on the day.',
      input: dayArgs,
      usdPerCall: 0,
      handler: async (args) => {
        const { day } = dayArgs.parse(args);
        const w = dayWindow(day, zone);
        const before = shiftDays(w, -7);
        const today = await loadQueueCounts(deps.db, { from: w.from, to: w.to }, zone);
        const baseline = await loadQueueCounts(deps.db, { from: before.from, to: w.from }, zone);
        return {
          queued: today.queued,
          gatePassed: today.gatePassed,
          baselineQueued: baseline.queued,
          baselineGatePassed: baseline.gatePassed,
          gateRejections: await loadGateRejections(deps.db, { from: w.from, to: w.to }),
          escalationsOnDay: await deps.db.escalation.count({ where: { createdAt: { gte: w.from, lt: w.to } } })
        };
      }
    },
    {
      name: 'read-spend',
      description: 'Spend on the day, over the last seven days and this month, with meeting requests for cost per meeting.',
      input: z.object({ day: dayArgs.shape.day, generatedAt: atArgs.shape.generatedAt }),
      usdPerCall: 0,
      handler: async (args) => {
        const { day, generatedAt } = z.object({ day: dayArgs.shape.day, generatedAt: atArgs.shape.generatedAt }).parse(args);
        const w = dayWindow(day, zone);
        const at = new Date(generatedAt);
        const sevenDaysAgo = new Date(at.getTime() - 7 * 24 * HOUR_MS);
        const monthStart = DateTime.fromJSDate(at, { zone }).startOf('month').toJSDate();

        const requests = (from: Date): Promise<number> =>
          deps.db.call.count({ where: { outcome: 'meeting_requested', startedAt: { gte: from, lt: at } } });

        const campaigns = await deps.db.campaign.findMany({ where: { status: 'active' } });
        const ceilings = campaigns.map((c) => decode(campaignGoalSchema, 'Campaign.goal', c.goal).maxUsdPerWeek);

        return {
          day: await loadSpend(deps.db, { from: w.from, to: w.to }),
          lastSevenDays: await loadSpend(deps.db, { from: sevenDaysAgo, to: at }),
          monthToDate: await loadSpend(deps.db, { from: monthStart, to: at }),
          requestsLastSevenDays: await requests(sevenDaysAgo),
          requestsMonthToDate: await requests(monthStart),
          weeklyCeilingUsd: ceilings.length === 0 ? null : ceilings.reduce((a, b) => a + b, 0)
        };
      }
    },
    {
      name: 'read-needs-you',
      description: 'Meeting requests and escalations waiting on the operator.',
      input: atArgs,
      usdPerCall: 0,
      handler: async (args): Promise<DailyDigest['figures']['needsYou']> => {
        const { generatedAt } = atArgs.parse(args);
        const at = new Date(generatedAt).getTime();
        const hours = (since: Date): number => Math.max(0, Math.round(((at - since.getTime()) / HOUR_MS) * 10) / 10);

        const requests = await deps.db.meetingRequest.findMany({
          where: { status: { in: ['requested', 'reschedule'] } },
          orderBy: { createdAt: 'asc' },
          include: { contact: { include: { account: true } } }
        });
        const open = requests.map((r) => ({
          ref: refFor(r.id),
          name: `${r.contact.firstName} ${r.contact.lastName}`.trim(),
          company: r.contact.account.name,
          status: r.status,
          waitingHours: hours(r.createdAt)
        }));
        const escalations = await deps.db.escalation.findMany({ where: { status: 'open' }, orderBy: { createdAt: 'asc' } });

        return {
          openMeetingRequests: open,
          waitingOver24h: open.filter((r) => r.waitingHours > 24).length,
          openEscalations: escalations.map((e) => ({ reason: e.reason, waitingHours: hours(e.createdAt) }))
        };
      }
    },
    {
      name: 'read-playbook-state',
      description: 'The champions, what changed in the last day, and how a running test is going.',
      input: atArgs,
      usdPerCall: 0,
      handler: async (args): Promise<DailyDigest['figures']['playbook']> => {
        const { generatedAt } = atArgs.parse(args);
        const at = new Date(generatedAt);
        const since = new Date(at.getTime() - 24 * HOUR_MS);

        const snapshot = await deps.store.snapshot();
        const changes = (await deps.store.history(undefined, 200)).filter((e) => e.at >= since && e.at <= at).map((e) => e.note);

        let test: DailyDigest['figures']['playbook']['test'] = null;
        if (snapshot.challenger !== null) {
          const { slot, version } = snapshot.challenger;
          const arms = await loadTestEvidence(deps.db, {
            slot,
            championVersion: snapshot.championVersions[slot] ?? null,
            challengerVersion: version,
            since: (await deps.store.get(slot, version))?.createdAt ?? since,
            until: at,
            thresholds: deps.config.promotion
          });
          test = {
            slot,
            version,
            championCompleted: arms.champion.completed,
            challengerCompleted: arms.challenger.completed,
            minimum: deps.config.promotion.minConversationsPerArm,
            championRequestRate: armRates(arms.champion).requestRate,
            challengerRequestRate: armRates(arms.challenger).requestRate
          };
        }

        return {
          champions: PLAYBOOK_SLOTS.flatMap((slot) => {
            const version = snapshot.championVersions[slot];
            return version === undefined ? [] : [{ slot, version }];
          }),
          changes,
          test
        };
      }
    },
    {
      name: 'read-plans',
      description: 'Today\'s call plans and whether dialling is halted.',
      input: atArgs,
      usdPerCall: 0,
      handler: async (args): Promise<DailyDigest['figures']['queue']> => {
        const { generatedAt } = atArgs.parse(args);
        const today = dayContaining(new Date(generatedAt), zone);

        const plans = await deps.db.callPlan.findMany({
          where: { planDate: today.date, status: { not: 'superseded' } },
          include: { entries: true }
        });
        const campaigns = await deps.db.campaign.findMany({ where: { id: { in: plans.map((p) => p.campaignId) } } });
        const nameOf = new Map(campaigns.map((c) => [c.id, c.name]));

        const state = deps.killSwitch === undefined ? null : await deps.killSwitch.read();
        return {
          plans: plans.map((p) => ({
            campaign: nameOf.get(p.campaignId) ?? p.campaignId,
            planDate: p.planDate,
            status: p.status,
            entries: p.entries.length,
            clearGate: p.entries.filter((e) => e.gateAllowed).length
          })),
          killSwitch: {
            engaged: state?.active ?? false,
            ...(state?.reason !== undefined ? { reason: state.reason } : {})
          }
        };
      }
    },
    {
      name: 'read-opening-lines',
      description: 'The lines the frozen opening is required to contain, for telling audit flags on them from real ones.',
      input: z.object({ contactIds: z.array(z.string()) }),
      usdPerCall: 0,
      handler: async (args) => {
        const { contactIds } = z.object({ contactIds: z.array(z.string()) }).parse(args);
        return openingTextsForContacts(deps.db, deps.identity, [...new Set(contactIds)]);
      }
    }
  ];
}
