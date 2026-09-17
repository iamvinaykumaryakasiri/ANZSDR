/**
 * Guardian layer one: the deterministic filter on the outbound token stream.
 *
 * The hard part is that tokens arrive in fragments and a banned phrase does not
 * respect their boundaries. "I'm a per" + "son" is two harmless chunks and one
 * breach. So the filter never emits its own tail: it holds back the last few
 * characters - enough that any pattern still being formed is still inside the
 * buffer - and releases them only once more text has arrived to prove them
 * innocent.
 *
 * That hold-back is the whole latency cost of the layer, and it is bounded and
 * small. The alternative, emitting optimistically and apologising afterwards,
 * does not exist on a phone call: the words are already in the prospect's ear.
 *
 * Guardian is the only sub-agent that can override Caller (brief section 3.3),
 * and this is where that happens.
 */

import { BAN_RULES, DEFLECTIONS, INJECTION_PATTERNS, type BanCategory, type BanRule } from './banned.js';

export interface Breach {
  category: BanCategory;
  why: string;
  /** What Caller was in the middle of saying. Logged as a defect, never spoken. */
  offendingText: string;
  /** What the prospect hears instead. */
  deflection: string;
}

export interface FilterStep {
  /** Safe to speak now. May be empty while the filter is holding its tail. */
  emit: string;
  /** Set once. After this the turn is over; further pushes emit nothing. */
  breach?: Breach;
}

/**
 * What gets released, and when.
 *
 * Releasing on a fixed character count is the obvious design and the wrong one:
 * a typical turn here is one or two sentences, so a hold-back big enough to
 * contain any forming phrase is big enough to swallow the whole turn, and
 * nothing reaches the prospect until generation finishes. Phase 5 wants the
 * response to start inside 800ms; that design cannot do it.
 *
 * So the unit of release is a finished sentence. A sentence that has ended and
 * is clean can be spoken while the next one is still being written, which is
 * also how TTS wants to be fed. Anything still being formed is, by definition,
 * inside the held fragment - there is no need to reason about how long a
 * pattern might be.
 *
 * The cap is for a model that never reaches a full stop: past it, the tail is
 * released a chunk at a time, keeping back more than the longest pattern span.
 */
const RUNAWAY_SENTENCE = 400;
const RUNAWAY_HOLD_BACK = 160;

/** The end of a spoken sentence: terminator, then whitespace or nothing. */
const SENTENCE_END = /[.!?]["')\]]*(?=\s|$)/g;

/** Index just past the last completed sentence, or -1 if there isn't one. */
function lastSentenceEnd(text: string): number {
  SENTENCE_END.lastIndex = 0;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(text)) !== null) {
    end = match.index + match[0].length;
  }
  return end;
}

/** Only ever look at the tail: a breach in text already spoken is not undoable. */
const WINDOW = 400;

export class StreamFilter {
  private buffer = '';
  private emitted = '';
  private cut: Breach | null = null;

  /** Feed one chunk from the model. Returns what may be spoken. */
  push(chunk: string): FilterStep {
    if (this.cut !== null) return { emit: '' };

    this.buffer += chunk;

    const breach = firstBreach(this.recent());
    if (breach !== null) {
      this.cut = breach;
      // Nothing further is released. Whatever was already spoken stands, which
      // is exactly why the hold-back exists.
      return { emit: '', breach };
    }

    const cut = lastSentenceEnd(this.buffer);
    if (cut > 0) {
      const release = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      this.emitted += release;
      return { emit: release };
    }

    // A sentence that will not end. Fall back to a character hold-back so one
    // runaway turn does not sit silent forever.
    if (this.buffer.length > RUNAWAY_SENTENCE) {
      const release = this.buffer.slice(0, this.buffer.length - RUNAWAY_HOLD_BACK);
      this.buffer = this.buffer.slice(this.buffer.length - RUNAWAY_HOLD_BACK);
      this.emitted += release;
      return { emit: release };
    }

    return { emit: '' };
  }

  /**
   * The model has stopped. Release the tail, having checked it one last time.
   * A turn that is never closed is a turn the prospect hears the start of and
   * no end to, so this must always be called.
   */
  end(): FilterStep {
    if (this.cut !== null) return { emit: '' };
    const breach = firstBreach(this.recent());
    if (breach !== null) {
      this.cut = breach;
      return { emit: '', breach };
    }
    const release = this.buffer;
    this.buffer = '';
    this.emitted += release;
    return { emit: release };
  }

  /** Everything actually spoken. What Guardian's post-call audit reads. */
  spoken(): string {
    return this.emitted;
  }

  breached(): Breach | null {
    return this.cut;
  }

  /**
   * The tail of the turn. Scanning the whole turn every chunk is quadratic and
   * pointless - a breach can only be forming near the end.
   */
  private recent(): string {
    const all = this.emitted + this.buffer;
    return all.length <= WINDOW ? all : all.slice(all.length - WINDOW);
  }
}

/** The first rule this text trips, or null. Order follows `BAN_RULES`. */
export function firstBreach(text: string): Breach | null {
  const rule = matchingRule(text);
  if (rule === null) return null;
  return {
    category: rule.category,
    why: rule.why,
    offendingText: text.trim(),
    deflection: DEFLECTIONS[rule.category]
  };
}

export function matchingRule(text: string): BanRule | null {
  for (const rule of BAN_RULES) {
    if (rule.severity !== 'cut') continue;
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

export interface InjectionHit {
  why: string;
  matched: string;
}

/**
 * Hostile input from the prospect's side.
 *
 * This does not silence anyone - the prospect may say whatever they like. It
 * marks the turn so Caller is told, in its own context, that what it just heard
 * was an attempt to redirect it rather than a request to help with. Section 9
 * calls that hostile input, and a blocked turn is logged as a defect with full
 * context.
 */
export function detectInjection(prospectSaid: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const { pattern, why } of INJECTION_PATTERNS) {
    const match = pattern.exec(prospectSaid);
    if (match !== null) hits.push({ why, matched: match[0] });
  }
  return hits;
}
