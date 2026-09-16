/**
 * The Campaign Director.
 *
 * Runs on a tick. Decides what work matters now, dispatches it, handles what
 * comes back, and stops when budget or policy says stop. It is the only
 * component allowed to spend money without a specific instruction, so it logs a
 * one-line rationale for every decision it makes - including the decisions to do
 * nothing.
 *
 * It cannot dial. It can request a dial; the compliance gate decides. Nothing in
 * this file is permitted to reach around that.
 */

import { DateTime } from 'luxon';
import type { AgentJournal } from '../agents/journal.js';
import { runAgent } from '../agents/runner.js';
import type { Blackboard } from '../blackboard/client.js';
import type {
  EscalationRepository,
  SpendLedger,
  TaskRepository
} from '../blackboard/repositories.js';
import type { CallPlanRepository } from '../blackboard/call-plans.js';
import { campaignGoalSchema, decode } from '../blackboard/schemas.js';
import { evaluateAutoTrip, type KillSwitch, type SafetySignals } from '../compliance/kill-switch.js';
import type { CompliancePolicy } from '../compliance/policy.js';
import type { TaskRegistry } from './registry.js';
import { RESEARCH_CONTACT } from './kinds.js';

export interface CampaignDirectorDeps {
  db: Blackboard;
  tasks: TaskRepository;
  escalations: EscalationRepository;
  spend: SpendLedger;
  journal: AgentJournal;
  killSwitch: KillSwitch;
  policy: CompliancePolicy;
  registry: TaskRegistry;
  /** Reads the day's plan so the tick can say what is waiting on the operator. */
  plans?: CallPlanRepository;
  now?: () => Date;
  /** How much work one tick will take on. Keeps a tick bounded and interruptible. */
  maxTasksPerTick?: number;
  /**
   * Fallback weekly ceiling in USD, used only when no active campaign states one.
   * The real number comes from the campaign's goal, which the account desk edits.
   */
  weeklyUsdCeiling?: number;
}

export interface TickReport {
  startedAt: Date;
  ranTasks: number;
  succeeded: number;
  escalated: number;
  usdSpent: number;
  /** Set when the tick stopped early, with the reason in plain English. */
  stopped: string | null;
  /** Every decision, in order, one line each. */
  decisions: string[];
  /** Today's calling, per active campaign, and whether it is cleared to run. */
  plans: Array<{ campaignId: string; planDate: string; status: string; entries: number }>;
}

export class CampaignDirector {
  private readonly now: () => Date;
  private readonly maxTasksPerTick: number;
  private readonly weeklyUsdCeiling: number;

  constructor(private readonly deps: CampaignDirectorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxTasksPerTick = deps.maxTasksPerTick ?? 10;
    this.weeklyUsdCeiling = deps.weeklyUsdCeiling ?? 50;
  }

  /**
   * What we are allowed to spend this week.
   *
   * The number lives on the campaign, where the operator sets it, rather than in
   * a constructor argument. With several active campaigns the ceilings add up,
   * because the spend ledger is global. The constructor value is only a fallback
   * for when nothing is active.
   */
  private async resolveWeeklyCeiling(): Promise<number> {
    const campaigns = await this.deps.db.campaign.findMany({ where: { status: 'active' } });
    const stated = campaigns
      .map((c) => decode(campaignGoalSchema, 'Campaign.goal', c.goal).maxUsdPerWeek)
      .filter((n) => n > 0);
    return stated.length === 0 ? this.weeklyUsdCeiling : stated.reduce((a, b) => a + b, 0);
  }

  private startOfOperationalDay(at: Date): Date {
    return DateTime.fromJSDate(at, { zone: this.deps.policy.operational_timezone }).startOf('day').toJSDate();
  }

  async tick(): Promise<TickReport> {
    const startedAt = this.now();
    const report: TickReport = {
      startedAt,
      ranTasks: 0,
      succeeded: 0,
      escalated: 0,
      usdSpent: 0,
      stopped: null,
      decisions: [],
      plans: []
    };

    // Every decision is attached to the task it is about, so the console's agent
    // trace can answer "what did the orchestrator decide about this task, and why"
    // without the operator having to correlate timestamps by eye.
    const decide = async (
      summary: string,
      opts: { taskId?: string; detail?: Record<string, unknown> } = {}
    ): Promise<void> => {
      report.decisions.push(summary);
      await this.deps.journal.trace({
        actor: 'campaign-director',
        kind: 'decided',
        summary,
        ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
        ...(opts.detail !== undefined ? { detail: opts.detail } : {})
      });
    };

    const reachable = await this.blackboardReachable();
    if (!reachable) {
      // Nothing else can be trusted, so this is decided before anything is read.
      await this.deps.killSwitch.trip(
        'blackboard-unreachable',
        'the Campaign Director lost contact with the blackboard',
        startedAt
      );
      report.stopped = 'the blackboard is unreachable; dialling halted and nothing dispatched';
      report.decisions.push(report.stopped);
      return report;
    }

    const killSwitch = await this.deps.killSwitch.state();
    if (killSwitch.active) {
      report.stopped = `holding: the kill switch is tripped (${killSwitch.reason ?? 'no reason recorded'})`;
      await decide(report.stopped);
      return report;
    }

    const ceiling = await this.resolveWeeklyCeiling();
    const spentThisWeek = await this.deps.spend.totalThisWeek(startedAt);
    if (spentThisWeek >= ceiling) {
      report.stopped = `holding: $${spentThisWeek.toFixed(2)} spent this week against a $${ceiling.toFixed(2)} ceiling`;
      await decide(report.stopped);
      return report;
    }

    await this.queueResearchForUnresearchedContacts(decide);
    await this.reportPlans(report, decide);

    let budgetRemaining = ceiling - spentThisWeek;

    for (let dispatched = 0; dispatched < this.maxTasksPerTick; dispatched++) {
      const now = this.now();
      const task = await this.deps.tasks.nextRunnable(now);
      if (task === null) {
        await decide('nothing runnable; standing by');
        break;
      }

      const kind = this.deps.registry.get(task.kind);
      if (kind === undefined) {
        await this.deps.tasks.markStopped(task.id, 'failed', `no agent registered for "${task.kind}"`, now);
        await this.deps.escalations.open(
          {
            level: 'human',
            reason: `no agent is registered for task kind "${task.kind}"`,
            detail: { known: this.deps.registry.known() },
            taskId: task.id
          },
          now
        );
        report.escalated += 1;
        await decide(`escalating ${task.id}: nothing knows how to do "${task.kind}"`, { taskId: task.id });
        continue;
      }

      const headroom = kind.agent.contract.budget.maxUsd;
      if (headroom > budgetRemaining) {
        report.stopped = `holding: ${task.kind} could cost up to $${headroom.toFixed(2)} and only $${budgetRemaining.toFixed(2)} remains this week`;
        await decide(report.stopped, { taskId: task.id });
        break;
      }

      await decide(
        `running ${task.kind} for ${task.contactId ?? task.accountId ?? 'the campaign'} at priority ${task.priority}; its dependencies are satisfied and it is the oldest work of that priority`,
        { taskId: task.id }
      );
      await this.deps.tasks.markRunning(task.id, now);
      report.ranTasks += 1;

      const outcome = await runAgent(kind.agent, task.payload, {
        taskId: task.id,
        journal: this.deps.journal,
        now: () => this.now().getTime()
      });

      await this.deps.spend.record('llm', outcome.spend.usd, this.now(), task.id, kind.agent.contract.name);
      report.usdSpent += outcome.spend.usd;
      budgetRemaining -= outcome.spend.usd;

      if (outcome.status === 'escalated') {
        await this.deps.tasks.markStopped(
          task.id,
          'escalated',
          `${outcome.failure.kind}: ${outcome.failure.message}`,
          this.now()
        );
        await this.deps.escalations.open(
          {
            level: outcome.escalatesTo,
            reason: `${kind.agent.contract.name} could not complete ${task.kind}: ${outcome.failure.message}`,
            detail: { kind: outcome.failure.kind, ...outcome.failure.detail },
            taskId: task.id,
            ...(task.contactId !== null ? { contactId: task.contactId } : {})
          },
          this.now()
        );
        report.escalated += 1;
        await decide(
          `${task.kind} escalated to ${outcome.escalatesTo} rather than continuing: ${outcome.failure.message}`,
          { taskId: task.id }
        );
        continue;
      }

      const followOn = await kind.apply(outcome.output, { db: this.deps.db, task, now: this.now() });
      for (const spec of followOn) await this.deps.tasks.create(spec);
      await this.deps.tasks.markDone(task.id, outcome.output, this.now());
      report.succeeded += 1;
      await decide(
        followOn.length === 0
          ? `${task.kind} finished; nothing follows from it`
          : `${task.kind} finished; queued ${followOn.length} ${followOn[0]?.kind} task(s)`,
        { taskId: task.id, detail: { usd: outcome.spend.usd } }
      );
    }

    await this.evaluateSafety(report, decide);
    return report;
  }

  /**
   * Queue research for anyone who has arrived without it.
   *
   * A contact found by Prospector already gets a research task as a consequence
   * of that run. A contact the operator entered by hand does not, so without
   * this they would sit at `enriched` forever and never reach a call plan. The
   * Director notices them rather than the import queueing its own work, because
   * deciding what happens next is the Director's job.
   */
  private async queueResearchForUnresearchedContacts(
    decide: (summary: string, opts?: { taskId?: string }) => Promise<void>
  ): Promise<void> {
    const waiting = await this.deps.db.contact.findMany({
      where: { status: 'enriched', dossiers: { none: {} } },
      include: { account: true },
      orderBy: [{ icpScore: 'desc' }, { createdAt: 'asc' }],
      take: 25
    });
    if (waiting.length === 0) return;

    let queued = 0;
    for (const contact of waiting) {
      // Do not stack a second research task on someone already waiting for one.
      const pending = await this.deps.db.task.findFirst({
        where: { kind: RESEARCH_CONTACT, contactId: contact.id, status: { in: ['pending', 'blocked', 'running'] } }
      });
      if (pending !== null) continue;

      await this.deps.tasks.create({
        kind: RESEARCH_CONTACT,
        priority: contact.icpScore >= 85 ? 1 : 2,
        campaignId: contact.campaignId,
        accountId: contact.accountId,
        contactId: contact.id,
        payload: {
          contactId: contact.id,
          contactName: `${contact.firstName} ${contact.lastName}`,
          title: contact.title,
          accountId: contact.accountId,
          accountName: contact.account.name,
          domain: contact.account.domain,
          ...(contact.linkedinUrl !== null ? { linkedinUrl: contact.linkedinUrl } : {})
        }
      });
      queued += 1;
    }

    if (queued > 0) {
      await decide(`${queued} contact(s) arrived without research; queued a dossier for each`);
    }
  }

  /**
   * Say where today's calling stands for each active campaign.
   *
   * This does not stop research or prospecting - neither of those is a call. It
   * exists so that "nothing is dialling because nobody has approved today's list"
   * appears in the tick, rather than being something the operator has to deduce
   * from an absence.
   */
  private async reportPlans(
    report: TickReport,
    decide: (summary: string, opts?: { taskId?: string }) => Promise<void>
  ): Promise<void> {
    const plans = this.deps.plans;
    if (plans === undefined || !this.deps.policy.approval.require_daily_plan) return;

    const today = DateTime.fromJSDate(this.now(), { zone: this.deps.policy.operational_timezone }).toFormat(
      'yyyy-MM-dd'
    );
    const campaigns = await this.deps.db.campaign.findMany({ where: { status: 'active' } });

    for (const campaign of campaigns) {
      const plan = await plans.live(campaign.id, today);
      if (plan === null) {
        report.plans.push({ campaignId: campaign.id, planDate: today, status: 'none', entries: 0 });
        await decide(`no call plan for ${today} on ${campaign.name}; nothing will dial until one is drawn up and approved`);
        continue;
      }
      report.plans.push({
        campaignId: campaign.id,
        planDate: plan.planDate,
        status: plan.status,
        entries: plan.entries.length
      });
      await decide(
        plan.status === 'approved'
          ? `${campaign.name}: ${plan.entries.length} contact(s) approved for ${today} by ${plan.decidedBy ?? 'the operator'}`
          : `${campaign.name}: the plan for ${today} is ${plan.status.replace('_', ' ')}; nothing will dial until it is approved`
      );
    }
  }

  /**
   * Section 7.6. The director feeds the signals; the compliance engine decides
   * whether to trip. The decision is not the director's to make.
   */
  private async evaluateSafety(
    report: TickReport,
    decide: (summary: string) => Promise<void>
  ): Promise<void> {
    const at = this.now();
    const dayStart = this.startOfOperationalDay(at);
    const [escalationsToday, callsToday] = await Promise.all([
      this.deps.escalations.openCount(dayStart),
      this.deps.db.call.count({ where: { startedAt: { gte: dayStart } } })
    ]);

    const signals: SafetySignals = {
      callsToday,
      escalationsToday,
      claimDefectsToday: 0,
      errorRate: 0,
      negativeSentimentRate: 0,
      blackboardReachable: true
    };

    const verdict = evaluateAutoTrip(signals, this.deps.policy);
    if (verdict.trip) {
      await this.deps.killSwitch.trip(
        verdict.source as NonNullable<typeof verdict.source>,
        verdict.reason as string,
        at
      );
      report.stopped = `kill switch tripped automatically: ${verdict.reason}`;
      await decide(report.stopped);
    }
  }

  private async blackboardReachable(): Promise<boolean> {
    try {
      await this.deps.db.$queryRawUnsafe('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
