/**
 * Writing what enrichment learned onto the contact (and recording where it came
 * from).
 *
 * Section 7.4: "Log source and lawful basis for every contact record held."
 * `Contact.source` and `Contact.lawfulBasis` carry the headline; a provenance
 * record in contact memory carries the detail - which endpoint, when, what was
 * acquired - so a Privacy Act access request ("where did you get my number?",
 * section 7.3) has a one-query answer.
 */

import type { Blackboard } from '../blackboard/client.js';
import type { Market } from '../compliance/types.js';
import type { EnrichedPerson } from './apollo-types.js';
import { storeApolloEmail, type EmailVerifier, type StoreEmailResult } from './email.js';
import type { PhoneRequest } from './enrichment-ledger.js';
import { chooseBestPhone, geoTagPhone, type GeoTag } from './geo.js';

export const LAWFUL_BASIS = 'legitimate business interest - B2B professional capacity';

export interface Provenance {
  source: string;
  endpoint: string;
  retrievedAt: string;
  lawfulBasis: string;
  acquired: string[];
  detail?: string;
}

async function writeProvenance(db: Blackboard, contactId: string, kind: string, p: Provenance): Promise<void> {
  const id = `provenance:${contactId}:${kind}`;
  const content = JSON.stringify(p);
  const summary = `${p.source} via ${p.endpoint}: ${p.acquired.join(', ') || 'nothing'}`;
  await db.memory.upsert({
    where: { id },
    create: { id, scope: 'contact', key: contactId, kind, summary, content },
    update: { summary, content }
  });
}

export interface EmailStageApplied {
  email: StoreEmailResult;
}

/**
 * Apply stage one to an existing contact: the real name, the work email (after
 * verification), and the provenance. Never lowers the contact's progress.
 */
export async function applyEmailStage(
  db: Blackboard,
  contactId: string,
  person: EnrichedPerson,
  verifier: EmailVerifier,
  at: Date
): Promise<EmailStageApplied> {
  const current = await db.contact.findUniqueOrThrow({ where: { id: contactId } });

  await db.contact.update({
    where: { id: contactId },
    data: {
      // Search returns a masked surname; enrichment is where the real one arrives.
      ...(person.firstName !== '' ? { firstName: person.firstName } : {}),
      ...(person.lastName !== '' && !person.lastNameObfuscated ? { lastName: person.lastName } : {}),
      ...(person.title !== '' ? { title: person.title } : {}),
      ...(current.seniority === 'unknown' && person.seniority !== undefined ? { seniority: person.seniority } : {}),
      ...(current.linkedinUrl === null && person.linkedinUrl !== undefined ? { linkedinUrl: person.linkedinUrl } : {}),
      ...(['discovered', 'scored'].includes(current.status) ? { status: 'enriched' } : {}),
      source: 'apollo',
      lawfulBasis: LAWFUL_BASIS,
      updatedAt: at
    }
  });

  const acquired: string[] = ['name'];
  let email: EmailStageApplied['email'] = { stored: false, reason: 'Apollo returned no email' };
  if (person.email !== undefined) {
    email = await storeApolloEmail(
      db,
      contactId,
      { address: person.email, kind: 'apollo_work', apolloStatus: person.emailStatus },
      verifier
    );
    if (email.stored) acquired.push(`work email (${email.verified ? 'verified' : 'unverified'})`);
  }
  // Present only if a client was explicitly permitted to reveal personal emails.
  const personal = person.personalEmails[0];
  if (personal !== undefined) {
    const stored = await storeApolloEmail(
      db,
      contactId,
      { address: personal, kind: 'apollo_personal', apolloStatus: person.emailStatus },
      verifier
    );
    if (stored.stored) acquired.push('personal email');
  }

  await writeProvenance(db, contactId, 'provenance-email', {
    source: 'Apollo.io',
    endpoint: '/people/bulk_match',
    retrievedAt: at.toISOString(),
    lawfulBasis: LAWFUL_BASIS,
    acquired
  });
  return { email };
}

export interface PhoneStageApplied {
  chosen?: GeoTag;
  rejected: string[];
}

/**
 * Apply the numbers Apollo delivered. Each is geo-tagged and line-typed; the best
 * one goes on the contact.
 *
 * A contact the operator entered as a `test` number is never touched: that
 * number is one Vinay controls and put there deliberately, and a prospect's
 * data must not be able to replace it.
 */
export async function applyPhoneStage(
  db: Blackboard,
  contactId: string,
  request: PhoneRequest,
  location: { city?: string | undefined; state?: string | undefined; country?: string | undefined },
  fallbackMarket: Market,
  at: Date
): Promise<PhoneStageApplied> {
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } });
  const tags: GeoTag[] = [];
  const rejected: string[] = [];
  for (const number of request.numbers) {
    const tag = geoTagPhone(number, location, fallbackMarket);
    if (tag.ok) tags.push(tag);
    else rejected.push(`${number.number}: ${tag.reason}`);
  }
  const best = chooseBestPhone(tags);

  if (best !== undefined && contact.kind !== 'test') {
    await db.contact.update({
      where: { id: contactId },
      data: {
        phoneE164: best.e164,
        phoneLine: best.lineType,
        // A pin that failed its checks is cleared rather than left over from an older number.
        jurisdiction: best.jurisdiction ?? null,
        timezone: best.timezone ?? null,
        updatedAt: at
      }
    });
  }

  await writeProvenance(db, contactId, 'provenance-phone', {
    source: 'Apollo.io',
    endpoint: '/people/bulk_match (reveal_phone_number, delivered by webhook)',
    retrievedAt: at.toISOString(),
    lawfulBasis: LAWFUL_BASIS,
    acquired: best === undefined ? [] : [`${best.kind} number`],
    detail:
      best === undefined
        ? rejected.join('; ') || 'Apollo delivered no usable number'
        : `${best.kind}, ${best.lineType}, ${best.market}; ${best.basis}${contact.kind === 'test' ? ' (test contact: number not replaced)' : ''}`
  });

  return { ...(best !== undefined ? { chosen: best } : {}), rejected };
}
