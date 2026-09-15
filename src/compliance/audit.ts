/**
 * Append-only compliance audit log.
 *
 * Every dial decision, every kill-switch transition and every suppression is
 * written here with the inputs that produced it. If a regulator, a prospect or
 * Vinay asks why a particular number was called at a particular minute, the
 * answer is a row in this log, not a reconstruction.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DialDecision, DialRequest, KillSwitchState, SuppressionEntry } from './types.js';

export type AuditKind =
  | 'dial-decision'
  | 'kill-switch'
  | 'suppression-added'
  | 'dnc-wash-recorded'
  | 'policy-loaded';

export interface AuditRecord {
  id: string;
  at: string;
  kind: AuditKind;
  actor: string;
  /** Contact, number, account or subsystem the record is about. */
  subject: string;
  /** One line, written to be read in the console without decoding. */
  summary: string;
  data: unknown;
}

export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
  /** Newest last. Reading is for the console and for tests; nothing mutates. */
  read(): Promise<AuditRecord[]>;
}

let sequence = 0;
function nextId(at: Date): string {
  sequence += 1;
  return `${at.toISOString()}-${sequence.toString(36).padStart(4, '0')}`;
}

export function dialDecisionRecord(request: DialRequest, decision: DialDecision): AuditRecord {
  const verdict = decision.allowed
    ? 'allowed'
    : `denied (${decision.reasons.map((r) => r.code).join(', ')})`;
  return {
    id: nextId(decision.evaluatedAt),
    at: decision.evaluatedAt.toISOString(),
    kind: 'dial-decision',
    actor: request.source,
    subject: request.contactId,
    summary: `dial to ${request.phone} for ${request.contactId} ${verdict}`,
    data: { request: { ...request, at: request.at.toISOString() }, decision }
  };
}

export function killSwitchRecord(state: KillSwitchState, actor: string, at: Date): AuditRecord {
  return {
    id: nextId(at),
    at: at.toISOString(),
    kind: 'kill-switch',
    actor,
    subject: 'kill-switch',
    summary: state.active
      ? `kill switch TRIPPED by ${state.trippedBy ?? actor}: ${state.reason ?? 'no reason given'}`
      : 'kill switch reset; dialling may resume',
    data: state
  };
}

export function suppressionRecord(entry: SuppressionEntry, actor: string): AuditRecord {
  return {
    id: nextId(entry.createdAt),
    at: entry.createdAt.toISOString(),
    kind: 'suppression-added',
    actor,
    subject: `${entry.scope}:${entry.key}`,
    summary: `suppressed ${entry.scope} ${entry.key} permanently (${entry.source}): ${entry.reason}`,
    data: entry
  };
}

export class InMemoryAuditLog implements AuditLog {
  private readonly records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async read(): Promise<AuditRecord[]> {
    return [...this.records];
  }
}

/** JSON Lines on disk: append-only by construction, greppable, trivially shippable. */
export class JsonlAuditLog implements AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  async append(record: AuditRecord): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async read(): Promise<AuditRecord[]> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as AuditRecord);
  }
}
