/**
 * The deterministic validator: the reason a dossier can be trusted.
 *
 * A model writes the dossier. This decides what of it survives, and it does so
 * with no model in the loop. A claim is kept only if all of these hold:
 *
 *   1. it names a source URL;
 *   2. that URL is a page Scout actually retrieved in this run, so a model
 *      cannot cite a page it never saw;
 *   3. it carries a verbatim quote, and that quote is in the retrieved text of
 *      that page, so a model cannot attach a real URL to an invented fact;
 *   4. its wording is plain: short, one line, no markup, no URLs and nothing
 *      that reads as an instruction. Dossier text ends up in Caller's prompt,
 *      and a web page is untrusted input.
 *
 * Everything else is dropped and recorded, in `unverified`, as dropped. Nothing
 * is repaired, softened or guessed at.
 *
 * Confidence is computed here too, from what survived. The model's own opinion
 * can lower the result and never raise it. Low confidence means no hooks: a wrong
 * specific is worse than a right generic (section 5.3).
 */

import { z } from 'zod';
import type { SourcedFact } from '../../blackboard/schemas.js';
import type { EvidenceDoc } from './sources.js';

export const MAX_TEXT_CHARS = 240;
export const MIN_QUOTE_CHARS = 15;
export const MIN_QUOTE_SEGMENT = 8;
export const MAX_HOOKS = 3;

/* ------------------------------------------------------------------ */
/* What the model is asked to return                                   */
/* ------------------------------------------------------------------ */

const text = z.string().nullish();

export const claimSchema = z.object({
  text,
  sourceUrl: text,
  /** A verbatim excerpt from the page that supports `text`. */
  quote: text
});
export type RawClaim = z.infer<typeof claimSchema>;

const claimList = z.array(claimSchema).nullish().transform((v) => v ?? []);

export const scoutDraftSchema = z.object({
  hypothesis: text,
  /** The source URLs the hypothesis rests on. At least one must belong to a surviving claim. */
  hypothesisSources: z.array(z.string()).nullish().transform((v) => v ?? []),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
  person: z
    .object({
      tenure: claimSchema.nullish(),
      priorEmployers: claimList,
      likelyRemit: claimSchema.nullish(),
      signals: claimList
    })
    .nullish()
    .transform((v) => v ?? { tenure: null, priorEmployers: [], likelyRemit: null, signals: [] }),
  account: z
    .object({
      whatTheyDo: claimSchema.nullish(),
      size: claimSchema.nullish(),
      techSignals: claimList,
      announcements: claimList,
      pressures: claimList
    })
    .nullish()
    .transform((v) => v ?? { whatTheyDo: null, size: null, techSignals: [], announcements: [], pressures: [] }),
  hooks: claimList,
  landmines: claimList
});
export type ScoutDraft = z.infer<typeof scoutDraftSchema>;

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_|ref$)/i;

/** One spelling per page: lower-cased host, no fragment, no tracking parameters, no trailing slash. */
export function normaliseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const query = url.searchParams.toString();
  return `${url.protocol}//${url.host.toLowerCase()}${path}${query === '' ? '' : `?${query}`}`;
}

/** Fold case, quote styles, dashes and punctuation, so a quote survives being retyped. */
export function foldForQuote(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class EvidenceIndex {
  private readonly docs = new Map<string, { doc: EvidenceDoc; folded: string }>();

  add(doc: EvidenceDoc): void {
    const key = normaliseUrl(doc.url);
    if (key === undefined || this.docs.has(key)) return;
    this.docs.set(key, { doc, folded: foldForQuote(doc.text) });
  }

  get(url: string): { doc: EvidenceDoc; folded: string } | undefined {
    const key = normaliseUrl(url);
    return key === undefined ? undefined : this.docs.get(key);
  }

  all(): EvidenceDoc[] {
    return [...this.docs.values()].map((d) => d.doc);
  }

  get size(): number {
    return this.docs.size;
  }
}

/**
 * Is `quote` in the page? An ellipsis splits the quote into pieces that must
 * each appear. Every piece has to be long enough to mean something, and the
 * whole quote long enough to be specific: "the" is in every page.
 */
export function quoteSupported(quote: string, foldedDoc: string): boolean {
  const pieces = quote
    .split(/\.{3}|…/)
    .map(foldForQuote)
    .filter((p) => p !== '');
  if (pieces.length === 0) return false;
  if (pieces.some((p) => p.length < MIN_QUOTE_SEGMENT)) return false;
  if (pieces.reduce((n, p) => n + p.length, 0) < MIN_QUOTE_CHARS) return false;
  return pieces.every((p) => foldedDoc.includes(p));
}

/* ------------------------------------------------------------------ */
/* Wording                                                             */
/* ------------------------------------------------------------------ */

const INSTRUCTION_LIKE: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,50}\b(instruction|prompt|rule|guideline|previous|above|system)/i,
  /\bsystem prompt\b/i,
  /\b(you are|act as|pretend to be|from now on|new instructions?)\b/i,
  /\b(assistant|system|user)\s*:/i,
  /<\/?[a-z][^>]*>/i,
  /https?:\/\//i,
  /```/
];

/** Collapse to one line and cap the length. For text that is recorded but not trusted. */
export function sanitizeLine(value: string, max = 200): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function screenText(value: string): { ok: true; text: string } | { ok: false; reason: string } {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { ok: false, reason: 'empty' };
  if (/[\u0000-\u001f\u007f]/.test(value.replace(/[\t\n\r]/g, ' '))) return { ok: false, reason: 'control characters' };
  if (cleaned.length > MAX_TEXT_CHARS) return { ok: false, reason: `longer than ${MAX_TEXT_CHARS} characters` };
  if (INSTRUCTION_LIKE.some((p) => p.test(cleaned))) return { ok: false, reason: 'reads as an instruction or contains markup or a link' };
  return { ok: true, text: cleaned };
}

/**
 * Words that mark something as a thing to stay away from rather than a thing to
 * open with (section 5.3's landmines, and section 9's ban on speculating about
 * an employer's layoffs, incidents or leadership). A fact or a hook containing
 * one is moved to the landmines. Regulators are deliberately not on this list:
 * a bank's compliance programme is a perfectly good reason to take a call.
 */
export const LANDMINE_TERMS =
  /\b(layoffs?|laid off|redundanc(?:y|ies)|retrench\w*|job cuts?|breach(?:ed|es)?|cyber ?(?:attack|incident|security incident)|data leak|ransomware|outage|lawsuit|litigation|sued|class action|investigation|infringement notice|insolven\w*|receivership|takeover|merger|acquir(?:ed|es|ing)|acquisition|divest\w*|profit warning|write-?down|resign(?:ed|ation|s)|stood down|dismiss(?:ed|al))\b/i;

/* ------------------------------------------------------------------ */
/* Verifying one claim                                                 */
/* ------------------------------------------------------------------ */

export type ClaimVerdict =
  | { ok: true; text: string; sourceUrl: string }
  | { ok: false; text: string; reason: string };

export function verifyClaim(claim: RawClaim, index: EvidenceIndex): ClaimVerdict {
  const raw = claim.text ?? '';
  const shown = sanitizeLine(raw, 120);
  const screened = screenText(raw);
  if (!screened.ok) return { ok: false, text: shown, reason: screened.reason };

  const url = (claim.sourceUrl ?? '').trim();
  if (url === '') return { ok: false, text: shown, reason: 'no source URL' };
  const evidence = index.get(url);
  if (evidence === undefined) return { ok: false, text: shown, reason: 'the source was not retrieved in this run' };

  const quote = (claim.quote ?? '').trim();
  if (quote === '') return { ok: false, text: shown, reason: 'no supporting quote' };
  if (!quoteSupported(quote, evidence.folded)) return { ok: false, text: shown, reason: 'the quote is not in the source' };

  return { ok: true, text: screened.text, sourceUrl: evidence.doc.url };
}

/* ------------------------------------------------------------------ */
/* Validating a whole draft                                            */
/* ------------------------------------------------------------------ */

export interface ValidationContext {
  contactName: string;
  title: string;
  accountName: string;
  evidence: EvidenceIndex;
}

export interface Dropped {
  section: string;
  text: string;
  reason: string;
}

export interface ValidatedDossier {
  hypothesis: string;
  confidence: 'high' | 'medium' | 'low';
  person: {
    tenure?: string;
    priorEmployers: string[];
    likelyRemit?: string;
    signals: SourcedFact[];
  };
  account: {
    whatTheyDo: string;
    size?: string;
    techSignals: SourcedFact[];
    announcements: SourcedFact[];
    pressures: SourcedFact[];
  };
  hooks: Array<{ text: string; sourceUrl: string; slot: 'hook' }>;
  landmines: SourcedFact[];
  sources: string[];
  dropped: Dropped[];
  /** Why confidence is what it is, one line each, for the trace. */
  reasons: string[];
}

const RANK = { low: 0, medium: 1, high: 2 } as const;
type Confidence = keyof typeof RANK;

function lower(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

export function validateDraft(draft: ScoutDraft, ctx: ValidationContext): ValidatedDossier {
  const dropped: Dropped[] = [];
  const reasons: string[] = [];
  const landmines: SourcedFact[] = [];
  let proposed = 0;

  const addLandmine = (fact: SourcedFact): void => {
    if (!landmines.some((l) => l.fact === fact.fact && l.sourceUrl === fact.sourceUrl)) landmines.push(fact);
  };

  /** Verify a list of claims, divert anything that reads as a landmine, return the rest. */
  const facts = (section: string, claims: RawClaim[]): SourcedFact[] => {
    const kept: SourcedFact[] = [];
    for (const claim of claims) {
      proposed += 1;
      const verdict = verifyClaim(claim, ctx.evidence);
      if (!verdict.ok) {
        dropped.push({ section, text: verdict.text, reason: verdict.reason });
        continue;
      }
      const fact = { fact: verdict.text, sourceUrl: verdict.sourceUrl };
      if (LANDMINE_TERMS.test(fact.fact)) {
        addLandmine(fact);
        reasons.push(`"${sanitizeLine(fact.fact, 60)}" reads as something to avoid, so it is a landmine rather than a ${section}`);
        continue;
      }
      if (!kept.some((k) => k.fact === fact.fact)) kept.push(fact);
    }
    return kept;
  };

  // Landmines the model reported. A verified one is kept; an unverifiable one is
  // not asserted, but it is a reason to be careful, so it lowers confidence.
  let suspectedLandmine = false;
  for (const claim of draft.landmines) {
    proposed += 1;
    const verdict = verifyClaim(claim, ctx.evidence);
    if (verdict.ok) addLandmine({ fact: verdict.text, sourceUrl: verdict.sourceUrl });
    else {
      suspectedLandmine = true;
      dropped.push({ section: 'landmine', text: verdict.text, reason: verdict.reason });
    }
  }

  const signals = facts('person signal', draft.person.signals);
  const techSignals = facts('tech signal', draft.account.techSignals);
  const announcements = facts('announcement', draft.account.announcements);
  const pressures = facts('pressure', draft.account.pressures);

  // Single-value person fields are plain strings in the schema, which has nowhere
  // to put a URL, so each is also recorded as a sourced signal.
  const single = (section: string, claim: RawClaim | null | undefined): string | undefined => {
    if (claim === null || claim === undefined || (claim.text ?? '').trim() === '') return undefined;
    const [kept] = facts(section, [claim]);
    if (kept === undefined) return undefined;
    if (!signals.some((s) => s.fact === kept.fact)) signals.push(kept);
    return kept.fact;
  };
  const tenure = single('tenure', draft.person.tenure);
  const likelyRemit = single('remit', draft.person.likelyRemit);
  const priorEmployers: string[] = [];
  for (const claim of draft.person.priorEmployers) {
    const employer = single('prior employer', claim);
    if (employer !== undefined && !priorEmployers.includes(employer)) priorEmployers.push(employer);
  }

  let whatTheyDo = `${ctx.accountName} (not described in any source we verified)`;
  const described = draft.account.whatTheyDo;
  if (described !== null && described !== undefined && (described.text ?? '').trim() !== '') {
    proposed += 1;
    const verdict = verifyClaim(described, ctx.evidence);
    if (verdict.ok) whatTheyDo = verdict.text;
    else dropped.push({ section: 'what they do', text: verdict.text, reason: verdict.reason });
  }
  let size: string | undefined;
  if (draft.account.size !== null && draft.account.size !== undefined && (draft.account.size.text ?? '').trim() !== '') {
    proposed += 1;
    const verdict = verifyClaim(draft.account.size, ctx.evidence);
    if (verdict.ok) size = verdict.text;
    else dropped.push({ section: 'size', text: verdict.text, reason: verdict.reason });
  }

  // Hooks are verified like any other claim, and a hook that is really a landmine
  // never reaches the opener.
  const hooks: ValidatedDossier['hooks'] = [];
  for (const hook of facts('hook', draft.hooks)) {
    if (hooks.length >= MAX_HOOKS) {
      dropped.push({ section: 'hook', text: sanitizeLine(hook.fact, 120), reason: `beyond the limit of ${MAX_HOOKS} hooks` });
      continue;
    }
    hooks.push({ text: hook.fact, sourceUrl: hook.sourceUrl, slot: 'hook' });
  }

  /* ---- confidence, from what survived ---- */

  const hookSources = new Set(hooks.map((h) => normaliseUrl(h.sourceUrl)));
  let computed: Confidence;
  if (hooks.length === 0) {
    computed = 'low';
    reasons.push('no hook survived verification, so the opening is generic');
  } else if (hookSources.size >= 2 && signals.length >= 1) {
    computed = 'high';
    reasons.push(`${hooks.length} hooks from ${hookSources.size} independent sources, and the person is corroborated`);
  } else {
    computed = 'medium';
    reasons.push(
      hookSources.size < 2
        ? 'the hooks rest on a single source'
        : 'nothing public corroborates this person\'s own role or remit'
    );
  }

  let confidence = lower(computed, draft.confidence);
  if (confidence !== computed) reasons.push(`the model rated its own work ${draft.confidence}, which lowers it`);

  if (suspectedLandmine) {
    const capped = lower(confidence, 'medium');
    if (capped !== confidence) reasons.push('the model reported something to avoid that could not be verified, so confidence is capped at medium');
    confidence = capped;
  }
  const droppedClaims = dropped.filter((d) => d.section !== 'hook' || !d.reason.startsWith('beyond')).length;
  if (proposed >= 4 && droppedClaims / proposed > 0.5) {
    const capped = lower(confidence, 'medium');
    if (capped !== confidence) reasons.push(`more than half of what the model proposed (${droppedClaims} of ${proposed}) could not be verified, so confidence is capped at medium`);
    confidence = capped;
  }

  // The hypothesis must rest on something that survived.
  const keptSources = new Set<string>();
  for (const f of [...signals, ...techSignals, ...announcements, ...pressures, ...landmines]) {
    const key = normaliseUrl(f.sourceUrl);
    if (key !== undefined) keptSources.add(key);
  }
  for (const h of hooks) {
    const key = normaliseUrl(h.sourceUrl);
    if (key !== undefined) keptSources.add(key);
  }

  const claimedHypothesis = screenText(draft.hypothesis ?? '');
  const grounded =
    claimedHypothesis.ok && draft.hypothesisSources.some((u) => {
      const key = normaliseUrl(u);
      return key !== undefined && keptSources.has(key);
    });

  let hypothesis: string;
  if (grounded && claimedHypothesis.ok) {
    hypothesis = claimedHypothesis.text;
  } else if (hooks[0] !== undefined) {
    hypothesis = `As ${ctx.title} at ${ctx.accountName}, ${ctx.contactName} is plausibly interested in ${hooks[0].text.replace(/[.!]+$/, '')}`;
    const capped = lower(confidence, 'medium');
    if (capped !== confidence) reasons.push('the model\'s hypothesis did not rest on a verified source, so confidence is capped at medium');
    confidence = capped;
  } else {
    hypothesis = `No specific trigger found; ${ctx.contactName} is a plausible owner of the problem we solve at ${ctx.accountName}`;
    confidence = 'low';
  }

  // Low confidence means no hooks: the pack would not use them, so the dossier does not offer them.
  let finalHooks = hooks;
  if (confidence === 'low' && hooks.length > 0) {
    for (const h of hooks) dropped.push({ section: 'hook', text: sanitizeLine(h.text, 120), reason: 'withheld: confidence is low' });
    finalHooks = [];
  }

  const sources = new Set<string>();
  const cite = (u: string): void => {
    const doc = ctx.evidence.get(u);
    if (doc !== undefined) sources.add(doc.doc.url);
  };
  for (const f of [...signals, ...techSignals, ...announcements, ...pressures, ...landmines]) cite(f.sourceUrl);
  for (const h of finalHooks) cite(h.sourceUrl);
  if (whatTheyDo !== `${ctx.accountName} (not described in any source we verified)`) {
    const d = draft.account.whatTheyDo;
    if (d?.sourceUrl) cite(d.sourceUrl);
  }
  if (size !== undefined && draft.account.size?.sourceUrl) cite(draft.account.size.sourceUrl);

  return {
    hypothesis,
    confidence,
    person: {
      ...(tenure !== undefined ? { tenure } : {}),
      priorEmployers,
      ...(likelyRemit !== undefined ? { likelyRemit } : {}),
      signals
    },
    account: {
      whatTheyDo,
      ...(size !== undefined ? { size } : {}),
      techSignals,
      announcements,
      pressures
    },
    hooks: finalHooks,
    landmines,
    sources: [...sources],
    dropped,
    reasons
  };
}
