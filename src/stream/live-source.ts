/**
 * Where the console learns that a call is on air.
 *
 * Behind an interface because there are two honest answers. On a real system the
 * blackboard knows: a call row with no end time, and the events written as it
 * unfolded. In demo mode a simulator knows, and there is no call row at all, so
 * the gate's concurrency count is never disturbed by a pretend call.
 */

import { z } from 'zod';
import type { Blackboard } from '../blackboard/client.js';
import { confidenceSchema, sectionMarkSchema } from '../blackboard/schemas.js';
import { marketForDial } from '../compliance/phone.js';
import type { Market } from '../compliance/types.js';
import type { LiveCallView, ScriptStage, TranscriptTurnView } from './contract.js';
import { LIVE_MAX_MS } from './facts.js';
import { readJson } from './util.js';

export interface LiveCallSource {
  /** The call on air right now, or null. */
  current(now: Date): Promise<LiveCallView | null>;
  /** When the next dial is due, if this source is the one deciding. Null defers to the queue. */
  nextDialAt?(now: Date): Date | null;
}

const STAGE_OF_SECTION: Record<string, ScriptStage> = {
  disclosure: 'disclosure',
  reason: 'reason',
  hook: 'hook',
  'value-statement': 'value',
  value: 'value',
  ask: 'ask',
  close: 'close'
};

/** The transcript of a call, in order, as the console shows it. */
export async function loadTranscript(db: Blackboard, callId: string): Promise<TranscriptTurnView[]> {
  const rows = await db.callEvent.findMany({ where: { callId, kind: 'turn' }, orderBy: { id: 'asc' } });
  return rows.flatMap((row) => {
    if (row.speaker !== 'lexi' && row.speaker !== 'prospect') return [];
    return [{ speaker: row.speaker, text: row.text, atSecond: row.atSecond ?? 0 }];
  });
}

export class DbLiveCallSource implements LiveCallSource {
  constructor(private readonly db: Blackboard) {}

  async current(now: Date): Promise<LiveCallView | null> {
    const row = await this.db.call.findFirst({
      where: { endedAt: null, startedAt: { gt: new Date(now.getTime() - LIVE_MAX_MS) } },
      orderBy: { startedAt: 'desc' },
      include: {
        contact: { include: { dossiers: { orderBy: { createdAt: 'desc' }, take: 1 } } },
        account: true
      }
    });
    if (row === null) return null;

    const marks = readJson(row.sectionMarks, z.array(sectionMarkSchema), []);
    const last = marks.reduce<{ section: string; atSecond: number } | null>(
      (best, m) => (best === null || m.atSecond >= best.atSecond ? m : best),
      null
    );
    const stage = (last === null ? undefined : STAGE_OF_SECTION[last.section]) ?? 'disclosure';

    const dossier = row.contact.dossiers[0];
    const confidence = confidenceSchema.safeParse(dossier?.confidence);
    const accountMarket: Market = row.account.country === 'NZ' ? 'NZ' : 'AU';

    return {
      callId: row.id,
      prospect: {
        name: `${row.contact.firstName} ${row.contact.lastName}`.trim(),
        title: row.contact.title,
        company: row.account.name,
        market: marketForDial(row.contact.phoneE164 ?? '', accountMarket)
      },
      hypothesis: dossier?.hypothesis ?? '',
      startedAt: row.startedAt.toISOString(),
      elapsedSeconds: Math.max(0, Math.round((now.getTime() - row.startedAt.getTime()) / 1000)),
      stage,
      // No dossier means no specific to lean on, which is what "low" means (section 5.3).
      confidence: confidence.success ? confidence.data : 'low',
      variant: row.playbookVersion ?? 'unversioned',
      transcript: await loadTranscript(this.db, row.id)
    };
  }
}

/** A source with nothing on air. */
export const NO_LIVE_CALL: LiveCallSource = { current: async () => null };
