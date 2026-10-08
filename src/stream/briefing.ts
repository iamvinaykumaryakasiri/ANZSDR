/**
 * The morning briefing (section 14.3): what happened yesterday, what changed,
 * what needs him, what is queued today.
 *
 * Written to be listened to as well as read, because there is a button that reads
 * it aloud while he gets ready. So: whole sentences, words rather than symbols,
 * numbers he can say. And it is assembled from the same figures the rest of the
 * console shows, never re-derived, so what he hears cannot disagree with what he
 * sees.
 */

import type { briefingSchema, KillSwitchView, MeetingRequestView } from './contract.js';
import type { z } from 'zod';
import type { CallFact } from './facts.js';
import type { PlanSummary, QueueResult } from './queue.js';
import { money, plural, stamp } from './util.js';

type BriefingView = z.infer<typeof briefingSchema>;

export interface BriefingInput {
  now: Date;
  /** The operator's clock. */
  zone: string;
  /** The previous operational day. */
  yesterday: { label: string; facts: CallFact[] };
  meetings: MeetingRequestView[];
  escalations: Array<{ contact: string; company: string; reason: string }>;
  queue: QueueResult;
  killSwitch: KillSwitchView;
  /** Playbook versions created or changed in the last day. */
  playbookChanges: string[];
  spendThisWeekUsd: number;
  weeklyCeilingUsd: number | null;
  mode: 'demo' | 'live';
}

function planLine(plan: PlanSummary): string {
  switch (plan.status) {
    case 'approved':
      return `The plan for ${plan.campaign} is approved: ${plural(plan.entries, 'person', 'people')} on it.`;
    case 'pending_approval':
      return `The plan for ${plan.campaign} is waiting for your approval, with ${plural(plan.entries, 'person', 'people')} on it. Nothing will be dialled until you approve it.`;
    case 'draft':
      return `The plan for ${plan.campaign} is still a draft with ${plural(plan.entries, 'person', 'people')} on it, and has not been submitted to you.`;
    case 'rejected':
      return `You rejected the plan for ${plan.campaign}, so nothing will be dialled for it today.`;
    case 'superseded':
      return `The plan for ${plan.campaign} was superseded; a new one is needed.`;
    case 'none':
      return `No plan has been drawn up for ${plan.campaign} today, so nothing will be dialled for it.`;
  }
}

export function buildBriefing(input: BriefingInput): BriefingView {
  const { yesterday, meetings, escalations, queue, killSwitch } = input;
  const sections: BriefingView['sections'] = [];

  // Yesterday.
  const calls = yesterday.facts;
  const connected = calls.filter((f) => f.answered).length;
  const conversations = calls.filter((f) => f.realConversation).length;
  const requests = calls.filter((f) => f.outcome === 'meeting_requested').length;
  sections.push({
    title: 'Yesterday',
    body:
      calls.length === 0
        ? `No calls were placed on ${yesterday.label}.`
        : `On ${yesterday.label} Lexi dialled ${plural(calls.length, 'number')}. ${plural(connected, 'person', 'people')} picked up, ${plural(conversations, 'conversation')} ran past forty-five seconds, and ${plural(requests, 'meeting request')} came out of them.`
  });

  // What changed.
  const changed: string[] = [];
  if (killSwitch.engaged) {
    changed.push(`Dialling is halted${killSwitch.reason !== undefined ? `: ${killSwitch.reason}` : ''}.`);
  }
  for (const change of input.playbookChanges) changed.push(change);
  const spend =
    input.weeklyCeilingUsd === null
      ? `${money(input.spendThisWeekUsd)} spent this week.`
      : `${money(input.spendThisWeekUsd)} spent this week against a ceiling of ${money(input.weeklyCeilingUsd)}.`;
  changed.push(spend);
  sections.push({ title: 'What changed', body: changed.join(' ') });

  // Needs him.
  const needs: string[] = [];
  for (const e of escalations) needs.push(`An escalation from ${e.contact}${e.company !== '' ? ` at ${e.company}` : ''}: ${e.reason}.`);
  const pending = meetings.filter((m) => m.status === 'pending');
  for (const m of pending) {
    const first = m.windows[0];
    needs.push(
      `${m.name} at ${m.company} wants twenty minutes${first !== undefined ? `, free ${first.localLabel}, which is ${first.sydneyLabel}` : ''}.`
    );
  }
  const rescheduling = meetings.filter((m) => m.status === 'rescheduled');
  if (rescheduling.length > 0) {
    needs.push(`${plural(rescheduling.length, 'meeting')} marked for rescheduling still need${rescheduling.length === 1 ? 's' : ''} a new time from you.`);
  }
  sections.push({ title: 'Needs you', body: needs.length === 0 ? 'Nothing is waiting on you.' : needs.join(' ') });

  // Today.
  const today: string[] = input.queue.plans.map(planLine);
  if (queue.waiting === 0) {
    today.push('Nobody is queued.');
  } else {
    today.push(`${plural(queue.waiting, 'person', 'people')} queued, and ${queue.allowed} of them clear the compliance gate right now.`);
    const head = queue.head;
    if (head !== null && !head.allowed && head.retryAt !== null) {
      today.push(`The first can be rung from ${stamp(head.retryAt, input.zone)} Sydney time.`);
    }
  }
  if (killSwitch.engaged) today.push('Nothing will be dialled while the halt is on.');
  sections.push({ title: "Today's queue", body: today.join(' ') });

  const needCount = escalations.length + pending.length + rescheduling.length;
  const headline =
    `${calls.length === 0 ? 'No calls yesterday' : `Yesterday ${plural(calls.length, 'dial')}, ${plural(requests, 'meeting request')}`}. ` +
    (needCount === 0 ? 'Nothing needs you.' : `${plural(needCount, 'thing')} ${needCount === 1 ? 'needs' : 'need'} you.`);

  return {
    generatedAt: input.now.toISOString(),
    headline: input.mode === 'demo' ? `Demo data. ${headline}` : headline,
    sections
  };
}
