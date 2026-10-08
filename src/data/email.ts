/**
 * Email quality (section 5.2): up to three addresses per contact, and a rule for
 * which one is used.
 *
 * `confirmed_on_call` always wins. Asking the prospect directly is both the
 * highest-quality source and the cheapest, and it outranks anything Apollo says
 * about their address, verified or not. Beneath it, an Apollo address is only
 * used once deliverability has been checked.
 *
 * The check is an interface because Apollo's own `email_status` is the best
 * thing available today and is not the best thing there will ever be. A real
 * verification provider is one class that implements `EmailVerifier`.
 */

import { randomUUID } from 'node:crypto';
import type { Blackboard } from '../blackboard/client.js';
import { EMAIL_PRECEDENCE, emailKindSchema, type EmailKind } from '../blackboard/schemas.js';

export type Deliverability = 'valid' | 'risky' | 'invalid' | 'unknown';

export interface VerificationResult {
  status: Deliverability;
  provider: string;
  checkedAt: Date;
}

export interface EmailVerifier {
  readonly name: string;
  verify(address: string, hints: { apolloStatus?: string | undefined }): Promise<VerificationResult>;
}

/**
 * Apollo's words for how sure it is. Only "verified" is treated as valid: the
 * rest are Apollo saying it has not confirmed the mailbox, and an address we
 * cannot stand behind is not one Vinay should be handed to write to.
 */
export function deliverabilityFromApollo(status: string | undefined): Deliverability {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'verified':
      return 'valid';
    case 'unavailable':
    case 'invalid':
    case 'bounced':
      return 'invalid';
    case 'unverified':
    case 'likely to engage':
    case 'extrapolated':
    case 'catch-all':
    case 'catch_all':
      return 'risky';
    default:
      return 'unknown';
  }
}

export class ApolloStatusVerifier implements EmailVerifier {
  readonly name = 'apollo-email-status';

  constructor(private readonly now: () => Date = () => new Date()) {}

  async verify(_address: string, hints: { apolloStatus?: string | undefined }): Promise<VerificationResult> {
    return { status: deliverabilityFromApollo(hints.apolloStatus), provider: this.name, checkedAt: this.now() };
  }
}

export interface EmailRow {
  address: string;
  kind: EmailKind;
  verified: boolean;
}

/**
 * Which address to use for this contact, or null if there is none we may use.
 *
 * With `requireVerified` (the default), an Apollo address that has not been
 * verified is passed over rather than used.
 */
export function selectEmail(rows: EmailRow[], options: { requireVerified?: boolean } = {}): EmailRow | null {
  const requireVerified = options.requireVerified ?? true;
  for (const kind of EMAIL_PRECEDENCE) {
    const row = rows.find((r) => r.kind === kind);
    if (row === undefined) continue;
    if (kind === 'confirmed_on_call') return row;
    if (requireVerified && !row.verified) continue;
    return row;
  }
  return null;
}

export type StoreEmailResult =
  | { stored: true; kind: EmailKind; verified: boolean }
  | { stored: false; reason: string };

/**
 * Write an Apollo address to the contact, verifying it first.
 *
 * An address verification calls invalid is not stored: holding a dead address
 * only invites someone to use it. A `confirmed_on_call` row is never touched
 * here, whatever Apollo says.
 */
export async function storeApolloEmail(
  db: Blackboard,
  contactId: string,
  input: { address: string; kind: Extract<EmailKind, 'apollo_work' | 'apollo_personal'>; apolloStatus?: string | undefined },
  verifier: EmailVerifier
): Promise<StoreEmailResult> {
  const address = input.address.trim().toLowerCase();
  const verdict = await verifier.verify(address, { apolloStatus: input.apolloStatus });
  if (verdict.status === 'invalid') {
    return { stored: false, reason: `${verifier.name} calls ${address} undeliverable` };
  }
  const verified = verdict.status === 'valid';
  const data = {
    address,
    verified,
    verifiedAt: verified ? verdict.checkedAt : null
  };
  await db.contactEmail.upsert({
    where: { contactId_kind: { contactId, kind: input.kind } },
    create: { id: randomUUID(), contactId, kind: input.kind, ...data },
    update: data
  });
  return { stored: true, kind: input.kind, verified };
}

/** The address in use for a contact, read from the blackboard. */
export async function emailInUse(
  db: Blackboard,
  contactId: string,
  options: { requireVerified?: boolean } = {}
): Promise<EmailRow | null> {
  const rows = await db.contactEmail.findMany({ where: { contactId } });
  return selectEmail(
    rows.map((r) => ({ address: r.address, kind: emailKindSchema.parse(r.kind), verified: r.verified })),
    options
  );
}
