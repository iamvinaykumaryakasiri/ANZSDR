/**
 * The kill switch, from a terminal.
 *
 *   npm run kill -- stop "reason"     halt all dialling
 *   npm run kill -- status            show current state
 *   npm run kill -- resume            allow dialling again (a human only)
 */

import { resolve } from 'node:path';
import { JsonlAuditLog } from '../compliance/audit.js';
import { KillSwitch } from '../compliance/kill-switch.js';
import { FileKillSwitchStore } from './kill-switch-store.js';

const ROOT = resolve(import.meta.dirname, '../..');
const STATE_PATH = process.env.KILL_SWITCH_PATH ?? resolve(ROOT, 'data/kill-switch.json');
const AUDIT_PATH = process.env.COMPLIANCE_AUDIT_PATH ?? resolve(ROOT, 'data/compliance-audit.jsonl');

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const killSwitch = new KillSwitch(new FileKillSwitchStore(STATE_PATH), new JsonlAuditLog(AUDIT_PATH));

  switch (command) {
    case 'stop': {
      const reason = rest.join(' ').trim();
      const state = await killSwitch.trip('operator', reason === '' ? 'stopped from the command line' : reason, new Date());
      console.log(`dialling HALTED - ${state.reason ?? ''}`);
      console.log(`state: ${STATE_PATH}`);
      break;
    }
    case 'resume': {
      await killSwitch.reset(process.env.USER ?? 'operator', new Date());
      console.log('kill switch reset - dialling may resume');
      break;
    }
    case 'status':
    case undefined: {
      const state = await killSwitch.state();
      if (state.active) {
        console.log(`HALTED since ${state.trippedAt?.toISOString() ?? 'unknown'} (${state.trippedBy ?? 'unknown'})`);
        console.log(`reason: ${state.reason ?? 'none recorded'}`);
      } else {
        console.log('dialling permitted');
      }
      break;
    }
    default:
      console.error(`unknown command "${command}". Use: stop | resume | status`);
      process.exit(2);
  }
}

await main();
