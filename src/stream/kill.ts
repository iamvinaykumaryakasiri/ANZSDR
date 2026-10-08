/**
 * Stop all, and its undoing.
 *
 * One function, used by the button's route and by a confirmed Jarvis command, so
 * there is exactly one way the console touches the kill switch and it is the real
 * one: the `KillSwitch` the compliance gate reads on every dial request. Tripping
 * it needs no confirmation by design (it is the safe direction, and it has to be
 * quick); lifting it is a person's deliberate act and the routes put a second
 * press in front of it.
 */

import type { KillSwitchView } from './contract.js';
import type { ConsoleDeps } from './deps.js';
import { killSwitchView } from './snapshot.js';

export async function setKillSwitch(deps: ConsoleDeps, engage: boolean, reason?: string): Promise<KillSwitchView> {
  const now = deps.now();
  if (engage) {
    const given = reason?.trim() ?? '';
    await deps.killSwitch.trip('operator', given === '' ? 'stopped from the console' : given, now);
  } else {
    await deps.killSwitch.reset('operator (console)', now);
  }
  const view = await killSwitchView(deps);
  deps.bus.publish({ type: 'kill_switch', killSwitch: view });
  return view;
}
