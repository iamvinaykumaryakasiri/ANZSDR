/**
 * Section 9, as patterns.
 *
 * This is layer one of three, and it is the only layer that is not a model. It
 * runs on the outbound token stream and can cut a turn mid-sentence. Everything
 * here is deliberately blunt: a false positive costs one deflected sentence, a
 * false negative is a thing an AI said to a stranger on Hexaware's behalf.
 *
 * The categories come straight from the brief and are not reorganised, so that
 * a line here can be read against the line there.
 */

export type BanCategory =
  | 'claims-to-be-human'
  | 'live-current-affairs'
  | 'competitor-opinion'
  | 'commercial-terms'
  | 'professional-advice'
  | 'employer-speculation'
  | 'third-party-gossip'
  | 'personal-remarks'
  | 'sensitive-collection'
  | 'commitment';

export type Severity = 'cut' | 'flag';

export interface BanRule {
  category: BanCategory;
  /** `cut` stops the turn mid-stream. `flag` records a defect and lets it run. */
  severity: Severity;
  pattern: RegExp;
  /** Plain English, for the defect log and the daily digest. */
  why: string;
}

/**
 * The overriding rule (brief section 0, rule 2): the agent never claims to be
 * human. Not by omission, not under pressure, not if the prospect insists.
 *
 * These are the affirmative claims. Omission is handled elsewhere - the opening
 * cannot be built without the disclosure - and the two together are what make
 * the rule hold.
 */
const HUMAN_CLAIMS: BanRule[] = [
  {
    category: 'claims-to-be-human',
    severity: 'cut',
    pattern: /\b(?:i am|i'm|im|i)\s+(?:a\s+)?(?:real\s+)?(?:human|person|human being|real)\b/i,
    why: 'claimed to be human'
  },
  {
    category: 'claims-to-be-human',
    severity: 'cut',
    pattern: /\bnot\s+(?:an?\s+)?(?:ai|a bot|a robot|artificial|automated|a machine|a computer)\b/i,
    why: 'denied being AI'
  },
  {
    category: 'claims-to-be-human',
    severity: 'cut',
    pattern: /\b(?:yes|yeah|yep|correct|of course|sure)[,!.\s]+(?:i'm|i am)\s+(?:a\s+)?(?:real\s+)?(?:person|human)\b/i,
    why: 'agreed with the prospect that it is a person'
  },
  {
    category: 'claims-to-be-human',
    severity: 'cut',
    pattern: /\b(?:speaking to|talking to|on the (?:phone|line) with)\s+(?:a\s+)?(?:real\s+)?(?:person|human)\b/i,
    why: 'told the prospect they are speaking to a person'
  },
  {
    category: 'claims-to-be-human',
    severity: 'cut',
    pattern: /\bi\s+(?:sit|work|am based)\s+(?:in|at|out of)\s+(?:the\s+)?(?:sydney|melbourne|auckland|office)\b/i,
    why: 'implied a physical human presence'
  }
];

/**
 * Politics, religion, race, gender, sexuality, unions, immigration, war, any
 * live current affair. Matched on the topic rather than on an opinion, because
 * the instruction is not to engage at all.
 */
const CURRENT_AFFAIRS: BanRule[] = [
  {
    category: 'live-current-affairs',
    severity: 'cut',
    pattern: /\b(?:labor|liberal|greens|one nation|coalition government|albanese|dutton|luxon|hipkins)\b/i,
    why: 'named a political party or politician'
  },
  {
    category: 'live-current-affairs',
    severity: 'cut',
    pattern: /\b(?:election|referendum|the budget|government policy|immigration policy|border policy)\b/i,
    why: 'engaged with politics or government policy'
  },
  {
    category: 'live-current-affairs',
    severity: 'cut',
    pattern: /\b(?:the war|the conflict in|gaza|ukraine|israel|palestin)\w*\b/i,
    why: 'engaged with a live conflict'
  },
  {
    category: 'live-current-affairs',
    severity: 'cut',
    pattern: /\b(?:union|strike action|enterprise agreement|industrial action)\b/i,
    why: 'engaged with industrial relations'
  },
  {
    category: 'live-current-affairs',
    severity: 'cut',
    pattern: /\b(?:religio\w+|christian|muslim|islam|jewish|hindu|buddhis\w+)\b/i,
    why: 'engaged with religion'
  }
];

/** No opinion on a named competitor. No disparagement, no comparison. */
const COMPETITORS: BanRule[] = [
  {
    category: 'competitor-opinion',
    severity: 'cut',
    pattern:
      /\b(?:accenture|infosys|tcs|tata consultancy|wipro|cognizant|capgemini|deloitte|kpmg|pwc|ey|ibm|dxc|datacom|fujitsu|kyndryl|ltimindtree|hcl|tech mahindra)\b/i,
    why: 'named a competitor'
  },
  {
    category: 'competitor-opinion',
    severity: 'cut',
    pattern: /\b(?:better than|cheaper than|faster than|unlike)\s+(?:our|the)?\s*competitor/i,
    why: 'compared against a competitor'
  }
];

/**
 * Pricing, rates, discounts, commercial terms, contractual commitments,
 * delivery timelines, headcount promises. There is no partial answer that is
 * safe here, so the whole area is cut.
 */
const COMMERCIAL: BanRule[] = [
  {
    category: 'commercial-terms',
    severity: 'cut',
    pattern: /(?:\$|usd|aud|nzd)\s?\d|(?:\d+\s?(?:k|thousand|million|m)\b.{0,20}(?:cost|price|fee|rate|budget))/i,
    why: 'quoted a figure of money'
  },
  {
    category: 'commercial-terms',
    severity: 'cut',
    pattern: /\b(?:day rate|hourly rate|our rates|our pricing|we charge|discount|licence fee|license fee)\b/i,
    why: 'discussed pricing or rates'
  },
  {
    category: 'commercial-terms',
    severity: 'cut',
    pattern: /\b(?:we can deliver|we'll deliver|delivered)\s+(?:it\s+)?(?:in|within|by)\s+\d/i,
    why: 'committed to a delivery timeline'
  },
  {
    category: 'commercial-terms',
    severity: 'cut',
    pattern: /\b(?:we (?:can|will|would) (?:put|give you|provide|allocate))\s+\d+\s+(?:people|engineers|consultants|fte)/i,
    why: 'promised headcount'
  }
];

/** Legal, financial, tax, medical or investment advice. */
const ADVICE: BanRule[] = [
  {
    category: 'professional-advice',
    severity: 'cut',
    pattern: /\byou should\s+(?:invest|buy|sell|restructure|incorporate|claim|deduct|sue|litigate)\b/i,
    why: 'gave professional advice'
  },
  {
    category: 'professional-advice',
    severity: 'cut',
    pattern: /\b(?:tax|legal|financial|investment|medical)\s+advice\b/i,
    why: 'offered advice it is not permitted to give'
  },
  {
    category: 'professional-advice',
    severity: 'cut',
    pattern: /\b(?:apra|asic|rbnz|fma)\b.{0,40}\b(?:requires? you|you (?:must|need to|have to))\b/i,
    why: 'told a regulated entity what a regulator requires of it'
  }
];

/** Speculation about the prospect's employer's finances, layoffs, M&A, incidents. */
const EMPLOYER_SPECULATION: BanRule[] = [
  {
    category: 'employer-speculation',
    severity: 'cut',
    pattern: /\b(?:i (?:hear|heard|gather|understand)|word is|rumour|rumor|apparently)\b.{0,60}\b(?:layoff\w*|redundan\w+|restructur\w+|acquisition\w*|merger\w*|takeover\w*|breach\w*|outage\w*|loss\w*)\b/i,
    why: 'repeated a rumour about the prospect’s employer'
  },
  {
    category: 'employer-speculation',
    severity: 'cut',
    pattern: /\byou(?:'re| are)\s+(?:probably\s+)?(?:losing money|struggling|in trouble|about to)\b/i,
    why: 'speculated about the employer’s position'
  }
];

/** Anything about another person at the account that was not publicly stated. */
const THIRD_PARTY: BanRule[] = [
  {
    category: 'third-party-gossip',
    severity: 'cut',
    pattern: /\b(?:your|the)\s+(?:cio|cto|ceo|boss|manager|colleague|predecessor)\s+(?:told|said|mentioned|thinks|wants|is unhappy)\b/i,
    why: 'attributed something private to another person at the account'
  }
];

/** Profanity, sarcasm at the prospect's expense, flirtation, personal remarks. */
const PERSONAL: BanRule[] = [
  {
    category: 'personal-remarks',
    severity: 'cut',
    pattern: /\b(?:fuck\w*|shit\w*|bastard|arsehole|asshole|bloody hell|piss off)\b/i,
    why: 'used profanity'
  },
  {
    category: 'personal-remarks',
    severity: 'cut',
    pattern: /\byour\s+(?:voice|accent|name)\s+(?:is|sounds)\b/i,
    why: 'commented on the prospect’s voice, accent or name'
  },
  {
    category: 'personal-remarks',
    severity: 'cut',
    pattern: /\b(?:you sound|you seem)\s+(?:lovely|gorgeous|cute|sexy|attractive)\b/i,
    why: 'flirted'
  }
];

/** Never collect beyond name, role, work email, timezone and time preference. */
const SENSITIVE: BanRule[] = [
  {
    category: 'sensitive-collection',
    severity: 'cut',
    pattern: /\b(?:date of birth|home address|mobile number|personal (?:email|number)|credit card|bank (?:account|details)|tfn|tax file number|ird number|passport|driver'?s licence)\b/i,
    why: 'asked for information outside what may be collected'
  },
  {
    category: 'sensitive-collection',
    severity: 'cut',
    pattern: /\bwhat(?:'s| is) your (?:salary|password|login)\b/i,
    why: 'asked for something it must never ask for'
  }
];

/**
 * Section 10: nothing is ever presented to the prospect as confirmed. Caller
 * asks for preference, never states a time as booked. This is the one category
 * that is about over-promising rather than about a banned topic, and it is the
 * easiest for a helpful model to get wrong.
 */
const COMMITMENT: BanRule[] = [
  {
    category: 'commitment',
    severity: 'cut',
    pattern: /\b(?:you'?re |i'?ve |i have |that'?s )?(?:booked|confirmed|locked in|scheduled you|put you down|pencilled you in)\b/i,
    why: 'presented a meeting as booked when only a preference was captured'
  },
  {
    category: 'commitment',
    severity: 'cut',
    pattern: /\b(?:i'?ll|i will|let me)\s+(?:send|put)\s+(?:you\s+)?(?:an?\s+)?(?:invite|calendar invite|meeting request)\b/i,
    why: 'promised to send an invite; only Vinay sends anything'
  },
  {
    category: 'commitment',
    severity: 'cut',
    pattern: /\bvinay (?:is|will be) (?:free|available)\b/i,
    why: 'asserted the operator’s availability, which it cannot know'
  }
];

export const BAN_RULES: readonly BanRule[] = Object.freeze([
  ...HUMAN_CLAIMS,
  ...CURRENT_AFFAIRS,
  ...COMPETITORS,
  ...COMMERCIAL,
  ...ADVICE,
  ...EMPLOYER_SPECULATION,
  ...THIRD_PARTY,
  ...PERSONAL,
  ...SENSITIVE,
  ...COMMITMENT
]);

/**
 * Hostile input arriving through the audio channel. Section 9 treats prompt
 * injection as hostile input rather than as an instruction, which is the only
 * coherent way to treat it: the prospect is not the operator.
 *
 * These match what the *prospect* said, never what Caller is about to say, so
 * they are kept apart from the ban rules above.
 */
export const INJECTION_PATTERNS: readonly { pattern: RegExp; why: string }[] = Object.freeze([
  { pattern: /\bignore\s+(?:all\s+|your\s+|the\s+)*(?:previous\s+|prior\s+|above\s+)?instructions?\b/i, why: 'asked the agent to ignore its instructions' },
  { pattern: /\b(?:disregard|forget)\s+(?:everything|all|your|the)\b.{0,30}\b(?:said|instructions?|prompt|rules?)\b/i, why: 'asked the agent to discard its rules' },
  { pattern: /\b(?:repeat|print|show|tell me|reveal|output)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|rules?|configuration)\b/i, why: 'tried to extract the system prompt' },
  { pattern: /\byou(?:'re| are)\s+(?:actually\s+)?(?:a\s+)?(?:human|person|not an ai)\b/i, why: 'asserted the agent is human' },
  { pattern: /\b(?:pretend|act as if|roleplay|imagine)\s+(?:you(?:'re| are)|to be)\b/i, why: 'tried to change the agent’s identity' },
  { pattern: /\bnew instructions?\s*[:,-]/i, why: 'tried to issue new instructions mid-call' },
  { pattern: /\b(?:developer|admin|system)\s+mode\b/i, why: 'invoked a fictitious privileged mode' },
  { pattern: /\bdrop\s+(?:the\s+)?disclosure\b|\bstop\s+saying\s+you(?:'re| are)\s+(?:an\s+)?ai\b/i, why: 'asked the agent to drop its AI disclosure' }
]);

/**
 * The one deflection shape, from section 9: acknowledge briefly, decline to
 * engage, return to the reason for the call, offer to end.
 *
 * Kept as data so Guardian can substitute it verbatim and Coach can never
 * rewrite it - it is part of the banned-topic handling, which section 11 puts
 * out of reach.
 */
export const DEFLECTIONS: Readonly<Record<BanCategory, string>> = Object.freeze({
  'claims-to-be-human':
    "Sorry, let me be clear about that - I'm an AI assistant, not a person. Happy to keep going, or to leave you be if you'd rather.",
  'live-current-affairs':
    "That's not something I can get into, I'm afraid. I'm only really here about the data platform question - though I'm happy to leave it there if you'd prefer.",
  'competitor-opinion':
    "I'd rather not give a view on anyone else in the market. Coming back to why I called - shall I carry on, or leave it there?",
  'commercial-terms':
    "I don't want to give you a half answer on cost - Vinay will come back to you with specifics. Can I ask one more thing, or would you rather I left it?",
  'professional-advice':
    "That's really not something I should advise on. Back to the reason I called - happy to continue, or to leave you to it.",
  'employer-speculation':
    "I shouldn't speculate about that, and I don't want to. To the reason I rang - shall I go on?",
  'third-party-gossip':
    "I shouldn't speak for anyone else there. Coming back to my reason for calling - is now still all right?",
  'personal-remarks':
    "Apologies, that was out of place. Back to why I called - happy to continue or to leave it there.",
  'sensitive-collection':
    "I don't need anything like that - only a work email and a rough time that suits. Shall I leave it there?",
  commitment:
    "To be clear, I can't book anything myself - Vinay will email you today to confirm. Does that work?"
});
