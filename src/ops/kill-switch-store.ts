/**
 * File-backed kill-switch state.
 *
 * Deliberately a plain file rather than a row in the database: if the database
 * is the thing that has gone wrong, the stop button still has to work. Any
 * process - the dialler, the console's API, the CLI - reads the same file, so a
 * trip takes effect everywhere within one poll interval.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KillSwitchState } from '../compliance/types.js';
import type { KillSwitchStore } from '../compliance/kill-switch.js';

interface Serialised {
  active: boolean;
  trippedAt?: string;
  trippedBy?: KillSwitchState['trippedBy'];
  reason?: string;
}

export class FileKillSwitchStore implements KillSwitchStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  async read(): Promise<KillSwitchState> {
    if (!existsSync(this.path)) return { active: false };
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Serialised;
    const state: KillSwitchState = { active: raw.active };
    if (raw.trippedAt !== undefined) state.trippedAt = new Date(raw.trippedAt);
    if (raw.trippedBy !== undefined) state.trippedBy = raw.trippedBy;
    if (raw.reason !== undefined) state.reason = raw.reason;
    return state;
  }

  async write(state: KillSwitchState): Promise<void> {
    const out: Serialised = { active: state.active };
    if (state.trippedAt !== undefined) out.trippedAt = state.trippedAt.toISOString();
    if (state.trippedBy !== undefined) out.trippedBy = state.trippedBy;
    if (state.reason !== undefined) out.reason = state.reason;
    writeFileSync(this.path, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  }
}
