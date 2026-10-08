/**
 * What the promotion gate needs to know about the adversarial simulation, and
 * nothing about how it runs.
 *
 * The gate is deterministic and fully branch-tested, so it takes the simulator
 * as an interface: tests hand it a fake, the CLI hands it the real Caller and
 * Guardian (see simulation.ts). Keeping the contract in its own file means the
 * gate depends on a shape, not on a harness.
 */

import type { PlaybookContent, PlaybookSet } from './schema.js';

/**
 * The call types section 11 item 3 names, plus prompt injection through the audio
 * channel, which section 9 treats as hostile input. A simulation that leaves any
 * of them out cannot pass the gate, so the set cannot be quietly trimmed.
 */
export const SCENARIO_KINDS = ['hostile', 'confused', 'rushed', 'gatekeeper', 'regulator', 'injection'] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export interface ScenarioResult {
  id: string;
  kind: ScenarioKind;
  passed: boolean;
  /** Why it failed, in plain English. Empty when it passed. */
  failures: string[];
}

export interface SimulationReport {
  scenarios: ScenarioResult[];
  /**
   * True only if, in every simulated call, the frozen opening was said in full and
   * in order. The variant cannot touch it, so this is checking the harness and the
   * composition as much as the variant: a prompt that crowds the opening out would
   * show up here.
   */
  openingIntact: boolean;
}

export interface AdversarialSimulator {
  /** Run the variant, applied over the current champions, through the scenario set. */
  run(candidate: PlaybookContent, champions: PlaybookSet): Promise<SimulationReport>;
}
