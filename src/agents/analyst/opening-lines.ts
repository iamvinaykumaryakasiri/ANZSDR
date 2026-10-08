/**
 * The lines the frozen opening is required to contain, as text.
 *
 * Needed to tell a genuine unsupported-claim defect from the audit flagging the
 * opening's own mandated lines (see `isOpeningLine` in metrics.ts). The fixed
 * segments depend only on the identity config; the reason segment varies by call
 * (it is the dossier's hypothesis, or a generic sentence when confidence is low),
 * so it is rebuilt the way the briefing builds it, from `reasonFor` itself.
 */

import type { Blackboard } from '../../blackboard/client.js';
import { reasonFor, type BriefingDossier, type BriefingProspect } from '../caller/briefing.js';
import type { AgentIdentity } from '../caller/identity.js';
import { buildOpening, renderOpening } from '../caller/opening.js';

const MARKETS = ['AU', 'NZ'] as const;

function prospectFor(market: 'AU' | 'NZ'): BriefingProspect {
  return { contactId: '', name: '', firstName: '', title: '', accountName: '', market };
}

const GENERIC_DOSSIER: BriefingDossier = { hypothesis: '', confidence: 'low', hooks: [], landmines: [], unverified: [] };

/**
 * Every line the opening could have contained for these reasons: each segment on
 * its own, and the whole as one utterance (the audit often quotes it whole).
 */
export function openingTexts(identity: AgentIdentity, reasons: string[]): string[] {
  const texts = new Set<string>();
  for (const reason of reasons) {
    const opening = buildOpening({ identity, reason });
    for (const segment of opening) texts.add(segment.text);
    texts.add(renderOpening(opening));
  }
  return [...texts];
}

/** The generic reason for each market, which is what a low-confidence dossier opens with. */
export function genericReasons(): string[] {
  return MARKETS.map((m) => reasonFor(GENERIC_DOSSIER, prospectFor(m)));
}

/**
 * The opening text for a day's calls: the generic reasons, plus the hypothesis
 * of each called contact's latest dossier where that is what their opening used.
 */
export async function openingTextsForContacts(
  db: Blackboard,
  identity: AgentIdentity,
  contactIds: string[]
): Promise<string[]> {
  const reasons = new Set<string>(genericReasons());

  if (contactIds.length > 0) {
    const dossiers = await db.dossier.findMany({ where: { contactId: { in: contactIds } }, orderBy: { createdAt: 'desc' } });
    const seen = new Set<string>();
    for (const d of dossiers) {
      if (seen.has(d.contactId)) continue;
      seen.add(d.contactId);
      const confidence = d.confidence === 'high' || d.confidence === 'medium' ? d.confidence : 'low';
      const reason = reasonFor({ ...GENERIC_DOSSIER, hypothesis: d.hypothesis, confidence }, prospectFor('NZ'));
      reasons.add(reason);
    }
  }
  return openingTexts(identity, [...reasons]);
}
