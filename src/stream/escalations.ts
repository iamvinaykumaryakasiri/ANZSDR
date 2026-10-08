/**
 * What has been escalated to a person.
 *
 * Two sources, because escalations arrive two ways. The Escalation table holds
 * the ones the system raised formally (a task nothing could run, a budget
 * breach). A call that ended `escalated` is the other: Scribe records the
 * outcome and Concierge emails him, and the call row is what remains. Both
 * belong under "needs you", and one escalation must not appear twice.
 */

import { z } from 'zod';
import type { escalationSchema } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { DAY_MS, readJson } from './util.js';

type EscalationView = z.infer<typeof escalationSchema>;

/** A call-level escalation stops being news after a day; the formal ones stay until resolved. */
const CALL_ESCALATION_WINDOW_MS = DAY_MS;

const detailSchema = z.object({ callId: z.string().optional() }).passthrough();
const followUpSchema = z.object({
  plan: z.object({ actions: z.array(z.object({ kind: z.string(), detail: z.string() })) }).optional()
});

export async function loadEscalations(deps: ConsoleDeps, now: Date): Promise<EscalationView[]> {
  const formal = await deps.db.escalation.findMany({
    where: { level: 'human', status: 'open' },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  const contactIds = formal.flatMap((e) => (e.contactId === null ? [] : [e.contactId]));
  const contacts = await deps.db.contact.findMany({ where: { id: { in: contactIds } }, include: { account: true } });
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const covered = new Set<string>();
  const out: EscalationView[] = formal.map((e) => {
    const contact = e.contactId === null ? undefined : contactById.get(e.contactId);
    const callId = readJson(e.detail, detailSchema, {}).callId;
    if (callId !== undefined) covered.add(callId);
    return {
      id: e.id,
      contact: contact === undefined ? 'The system' : `${contact.firstName} ${contact.lastName}`.trim(),
      company: contact?.account.name ?? '',
      reason: e.reason,
      at: e.createdAt.toISOString()
    };
  });

  const calls = await deps.db.call.findMany({
    where: { outcome: 'escalated', startedAt: { gte: new Date(now.getTime() - CALL_ESCALATION_WINDOW_MS) } },
    orderBy: { startedAt: 'desc' },
    take: 10,
    include: { contact: { include: { account: true } }, record: true }
  });
  for (const call of calls) {
    if (covered.has(call.id)) continue;
    const followUp = readJson(call.record?.followUp, followUpSchema, {});
    const alert = followUp.plan?.actions.find((a) => a.kind === 'alert-operator');
    out.push({
      id: `call-${call.id}`,
      contact: `${call.contact.firstName} ${call.contact.lastName}`.trim(),
      company: call.contact.account.name,
      reason: alert?.detail ?? 'the call was escalated; read the transcript',
      at: (call.endedAt ?? call.startedAt).toISOString()
    });
  }

  return out.sort((a, b) => b.at.localeCompare(a.at));
}
