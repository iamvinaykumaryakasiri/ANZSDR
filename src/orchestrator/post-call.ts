/**
 * What happens when a call ends.
 *
 * Scribe writes the record, Concierge carries out the follow-up the record
 * calls for, and the workbook is refreshed so the CRM shows it. Three steps,
 * each one a module of its own; this is only the order they run in and what
 * happens when one of them fails.
 *
 * The order is not arbitrary. The follow-up needs the record, so a Scribe
 * failure stops everything: acting on a call nobody has written down would
 * mean suppressing, emailing or texting off the back of an unrecorded
 * outcome. The workbook is last and is allowed to fail, because it is a view:
 * a locked file must never hold up the email that Vinay is waiting for.
 *
 * Phase 5 calls this from the voice provider's end-of-call webhook. Nothing
 * here knows about the provider.
 */

import { runFollowUp, type FollowUpRun, type RunDeps } from '../agents/concierge/run.js';
import { scribeCall, type ScribeDeps, type ScribeInput, type ScribeResult } from '../agents/scribe/scribe.js';
import { syncWorkbook, type WorkbookCounts } from '../crm/workbook.js';

export interface PostCallDeps {
  scribe: ScribeDeps;
  followUp: RunDeps;
  /** Where the CRM workbook lives. Without one, no workbook is written. */
  workbookPath?: string | undefined;
}

export type WorkbookStatus =
  | { status: 'synced'; counts: WorkbookCounts }
  | { status: 'failed'; detail: string }
  | { status: 'not-configured' };

export interface PostCallResult {
  scribe: ScribeResult;
  followUp: FollowUpRun;
  workbook: WorkbookStatus;
}

export async function processEndedCall(deps: PostCallDeps, input: ScribeInput): Promise<PostCallResult> {
  const scribe = await scribeCall(deps.scribe, input);
  const followUp = await runFollowUp(deps.followUp, scribe);

  let workbook: WorkbookStatus = { status: 'not-configured' };
  if (deps.workbookPath !== undefined) {
    try {
      workbook = { status: 'synced', counts: await syncWorkbook(deps.followUp.db, deps.workbookPath, deps.followUp.now()) };
    } catch (error) {
      workbook = { status: 'failed', detail: (error as Error).message };
    }
  }

  return { scribe, followUp, workbook };
}
