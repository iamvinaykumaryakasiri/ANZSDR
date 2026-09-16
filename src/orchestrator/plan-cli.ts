/**
 * The day's calling, for approval.
 *
 *   npm run plan -- draft     draw up today's plan and submit it
 *   npm run plan -- show      print the current plan
 *   npm run plan -- approve "optional note"
 *   npm run plan -- reject "why"
 *
 * Nothing dials until `approve` has been run for today. Approval covers the
 * people on that list on that day and does not carry over.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlackboard } from '../blackboard/client.js';
import { CallPlanRepository } from '../blackboard/call-plans.js';
import {
  PrismaAttemptStore,
  PrismaAuditLog,
  PrismaCallStateStore,
  PrismaDncStore,
  PrismaSuppressionStore
} from '../blackboard/compliance-stores.js';
import { HolidayCalendar } from '../compliance/holidays.js';
import { KillSwitch } from '../compliance/kill-switch.js';
import { loadPolicy } from '../compliance/policy.js';
import { ComplianceGate } from '../compliance/service.js';
import { FileKillSwitchStore } from '../ops/kill-switch-store.js';
import { DailyCallPlanner, renderPlan } from './planner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const db = createBlackboard();
  const policy = loadPolicy(resolve(ROOT, 'config/policy.yaml'));
  const calendar = HolidayCalendar.fromFiles([
    resolve(ROOT, 'config/holidays/au.json'),
    resolve(ROOT, 'config/holidays/nz.json')
  ]);
  const plans = new CallPlanRepository(db);
  const audit = new PrismaAuditLog(db);

  const gate = new ComplianceGate({
    policy,
    calendar,
    killSwitch: new KillSwitch(
      new FileKillSwitchStore(process.env.KILL_SWITCH_PATH ?? resolve(ROOT, 'data/kill-switch.json')),
      audit
    ),
    suppression: new PrismaSuppressionStore(db),
    dnc: new PrismaDncStore(db),
    attempts: new PrismaAttemptStore(db),
    calls: new PrismaCallStateStore(db),
    dayPlans: plans,
    audit
  });

  const planner = new DailyCallPlanner({ db, plans, gate, policy, calendar });
  const campaign = await db.campaign.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
  if (campaign === null) {
    console.error('no active campaign; nothing to plan');
    process.exit(1);
  }

  const timezone = policy.calling_windows[campaign.market === 'NZ' ? 'NZ' : 'AU'].timezone;
  const finish = async (): Promise<void> => {
    await db.$disconnect();
  };

  switch (command) {
    case 'draft': {
      const plan = await planner.draft({ campaignId: campaign.id });
      await planner.submit(plan.id);
      const submitted = await plans.get(plan.id);
      console.log(renderPlan(submitted as NonNullable<typeof submitted>, timezone));
      console.log('Approve with:  npm run plan -- approve');
      break;
    }
    case 'show':
    case undefined: {
      const plan = await plans.live(campaign.id, planner.today());
      if (plan === null) {
        console.log(`no plan for ${planner.today()}. Draw one up with:  npm run plan -- draft`);
        break;
      }
      console.log(renderPlan(plan, timezone));
      break;
    }
    case 'approve':
    case 'reject': {
      const plan = await plans.live(campaign.id, planner.today());
      if (plan === null) {
        console.error(`no plan for ${planner.today()} to ${command}`);
        await finish();
        process.exit(1);
      }
      const by = process.env.OPERATOR ?? process.env.USER ?? 'operator';
      const note = rest.join(' ').trim();
      if (command === 'approve') {
        await plans.approve(plan.id, by, new Date(), note);
        console.log(`approved ${plan.entries.length} contact(s) for ${plan.planDate} as ${by}`);
        console.log('This approval covers these people, today only.');
      } else {
        if (note === '') {
          console.error('reject needs a reason: npm run plan -- reject "why"');
          await finish();
          process.exit(2);
        }
        await plans.reject(plan.id, by, new Date(), note);
        console.log(`rejected the plan for ${plan.planDate}: ${note}`);
      }
      break;
    }
    default:
      console.error(`unknown command "${command}". Use: draft | show | approve | reject`);
      await finish();
      process.exit(2);
  }

  await finish();
}

await main();
