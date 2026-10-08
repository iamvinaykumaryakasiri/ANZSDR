/**
 * The raw material of the demo world.
 *
 * Everything here is invented, and meant to look it. Organisations are called
 * "Demo ..." and live on .example domains (a reserved TLD that cannot resolve);
 * people have surnames that are jokes about being test data; phone numbers are in
 * the ranges the regulators reserve for fiction. No real person, client or
 * company appears, so a screenshot of the demo console cannot be mistaken for a
 * statement about anyone.
 */

import type { ScriptStage } from '../contract.js';

/** A small deterministic generator, so the demo looks the same every time it is seeded. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlaceSpec {
  key: string;
  country: 'AU' | 'NZ';
  city: string;
  jurisdiction: string;
  timezone: string;
  /** National significant digits before the 5550 block, for a fictional number. */
  prefix: string;
}

export const PLACES: Record<string, PlaceSpec> = {
  sydney: { key: 'sydney', country: 'AU', city: 'Sydney', jurisdiction: 'au-nsw', timezone: 'Australia/Sydney', prefix: '+61255500' },
  melbourne: { key: 'melbourne', country: 'AU', city: 'Melbourne', jurisdiction: 'au-vic', timezone: 'Australia/Melbourne', prefix: '+61355500' },
  brisbane: { key: 'brisbane', country: 'AU', city: 'Brisbane', jurisdiction: 'au-qld', timezone: 'Australia/Brisbane', prefix: '+61755500' },
  perth: { key: 'perth', country: 'AU', city: 'Perth', jurisdiction: 'au-wa', timezone: 'Australia/Perth', prefix: '+61855500' },
  auckland: { key: 'auckland', country: 'NZ', city: 'Auckland', jurisdiction: 'nz-auckland', timezone: 'Pacific/Auckland', prefix: '+6495550' },
  wellington: { key: 'wellington', country: 'NZ', city: 'Wellington', jurisdiction: 'nz-wellington', timezone: 'Pacific/Auckland', prefix: '+6445550' },
  christchurch: { key: 'christchurch', country: 'NZ', city: 'Christchurch', jurisdiction: 'nz-canterbury', timezone: 'Pacific/Auckland', prefix: '+6435550' }
};

export interface AccountSpec {
  key: string;
  name: string;
  slug: string;
  country: 'AU' | 'NZ';
  industry: string;
  places: string[];
}

export const ACCOUNTS: AccountSpec[] = [
  { key: 'alpha', name: 'Demo Bank Alpha', slug: 'demo-bank-alpha', country: 'AU', industry: 'financial services', places: ['sydney', 'melbourne'] },
  { key: 'beta', name: 'Demo Bank Beta', slug: 'demo-bank-beta', country: 'NZ', industry: 'financial services', places: ['auckland', 'wellington'] },
  { key: 'gamma', name: 'Demo Insurer Gamma', slug: 'demo-insurer-gamma', country: 'AU', industry: 'insurance', places: ['sydney', 'brisbane'] },
  { key: 'delta', name: 'Demo Super Fund Delta', slug: 'demo-super-fund-delta', country: 'NZ', industry: 'financial services', places: ['wellington', 'auckland'] },
  { key: 'epsilon', name: 'Demo Building Society Epsilon', slug: 'demo-building-society-epsilon', country: 'AU', industry: 'financial services', places: ['melbourne', 'perth'] },
  { key: 'zeta', name: 'Demo Credit Union Zeta', slug: 'demo-credit-union-zeta', country: 'NZ', industry: 'financial services', places: ['christchurch', 'auckland'] },
  { key: 'eta', name: 'Demo Utilities Eta', slug: 'demo-utilities-eta', country: 'AU', industry: 'utilities', places: ['brisbane', 'perth'] },
  { key: 'theta', name: 'Demo Retail Theta', slug: 'demo-retail-theta', country: 'NZ', industry: 'retail', places: ['auckland', 'christchurch'] },
  { key: 'iota', name: 'Demo Wealth Iota', slug: 'demo-wealth-iota', country: 'AU', industry: 'financial services', places: ['sydney', 'brisbane'] },
  { key: 'kappa', name: 'Demo Finance Kappa', slug: 'demo-finance-kappa', country: 'NZ', industry: 'financial services', places: ['auckland', 'wellington'] },
  { key: 'lambda', name: 'Demo Mutual Lambda', slug: 'demo-mutual-lambda', country: 'AU', industry: 'insurance', places: ['melbourne', 'sydney'] },
  { key: 'mu', name: 'Demo Energy Mu', slug: 'demo-energy-mu', country: 'NZ', industry: 'utilities', places: ['wellington', 'auckland'] },
  { key: 'nu', name: 'Demo Health Nu', slug: 'demo-health-nu', country: 'NZ', industry: 'healthcare', places: ['christchurch', 'wellington'] },
  { key: 'xi', name: 'Demo Mining Xi', slug: 'demo-mining-xi', country: 'AU', industry: 'resources', places: ['perth', 'brisbane'] }
];

/** Accounts that have been called. The rest hold the queue, so the gate's weekly caps stay predictable. */
export const WORKED_ACCOUNT_KEYS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];

export const FIRST_NAMES = [
  'Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Jamie', 'Quinn', 'Avery', 'Robin', 'Drew',
  'Kai', 'Reese', 'Skyler', 'Emerson', 'Rowan', 'Sage', 'Blair', 'Dana', 'Harper', 'Logan', 'Parker', 'Remy',
  'Shea', 'Toby', 'Wren', 'Zion', 'Ari', 'Bryn', 'Cleo', 'Devon', 'Eden', 'Finn', 'Gale', 'Hollis'
];

export const SURNAMES = [
  'Sampleton', 'Placeholder', 'Mockford', 'Fixture', 'Testwell', 'Dummerson', 'Specimen', 'Faux', 'Illustrate', 'Prototype',
  'Simulacrum', 'Stand-in', 'Exemplar', 'Pretend', 'Nominal', 'Hypothetical', 'Notional', 'Staged', 'Replica', 'Mockup',
  'Sandbox', 'Dryrun', 'Trialman', 'Stubb', 'Imagined', 'Fabricato', 'Synthe', 'Samplerton', 'Demoski', 'Testaroo',
  'Illustro', 'Modelle', 'Facsimile', 'Pilotson', 'Rehearse', 'Showcase', 'Madeup', 'Canned'
];

export const TITLES: Array<{ title: string; seniority: string }> = [
  { title: 'Chief Information Officer', seniority: 'c_suite' },
  { title: 'Chief Data Officer', seniority: 'c_suite' },
  { title: 'Chief Technology Officer', seniority: 'c_suite' },
  { title: 'General Manager Technology', seniority: 'vp' },
  { title: 'Head of Data', seniority: 'director' },
  { title: 'Head of Engineering', seniority: 'director' },
  { title: 'Head of Architecture', seniority: 'director' },
  { title: 'Director of Digital', seniority: 'director' },
  { title: 'Technology Manager', seniority: 'manager' }
];

/** Hypotheses, written generically so none reads as a claim about a real organisation. */
export const HYPOTHESES = [
  'Demo hypothesis: mid-way through a core platform rebuild and likely to want a second view on delivery risk.',
  'Demo hypothesis: hiring several data platform engineers, which usually means a data estate being consolidated.',
  'Demo hypothesis: a recent leadership change in technology, so the roadmap may be open to challenge.',
  'Demo hypothesis: a public modernisation programme that is likely to need delivery capacity in the second half.',
  'Demo hypothesis: expanding into the New Zealand market and standing up local engineering.'
];

export const HOOKS = [
  'the data platform roles open since early in the year',
  'the modernisation programme announced in the half-year update',
  'the new technology leadership team',
  'the expansion into a second market'
];

/** What was said back, by the kind of objection it was. */
export const OBJECTIONS: Array<{ kind: string; saidAs: string; handledAs: string }> = [
  { kind: 'no-time-now', saidAs: 'We are right in the middle of a release, honestly.', handledAs: 'Said it was a short permission call and offered twenty minutes later in the month.' },
  { kind: 'no-time-now', saidAs: 'Not a good week for me.', handledAs: 'Offered to take two windows for the following week instead.' },
  { kind: 'has-a-partner', saidAs: 'We already have a partner for that.', handledAs: 'Accepted it, and asked whether a second view would be unwelcome. They said it would.' },
  { kind: 'has-a-partner', saidAs: 'We use a panel of vendors already.', handledAs: 'Closed warmly; no rebuttal.' },
  { kind: 'send-email', saidAs: 'Can you just send me an email?', handledAs: 'Offered to have Vinay send a short note, and took the address.' },
  { kind: 'send-email', saidAs: 'Put it in an email and I will have a look.', handledAs: 'Confirmed the address and said Vinay would write today.' },
  { kind: 'not-the-right-person', saidAs: 'That sits with someone else, not me.', handledAs: 'Asked who the right person is and the best way to reach them.' },
  { kind: 'no-budget', saidAs: 'There is no budget for anything new this year.', handledAs: 'Accepted it and closed politely.' },
  { kind: 'wants-pricing', saidAs: 'What does it cost?', handledAs: "Said she did not want to give a half answer and that Vinay would come back with specifics." },
  { kind: 'asked-if-human', saidAs: 'Wait, am I talking to a robot?', handledAs: 'Confirmed plainly that she is an AI assistant, and offered to end the call.' }
];

export interface ScriptLine {
  stage: ScriptStage;
  speaker: 'lexi' | 'prospect';
  text: string;
}

export interface LiveProspect {
  name: string;
  firstName: string;
  title: string;
  company: string;
  market: 'AU' | 'NZ';
  hypothesis: string;
  confidence: 'high' | 'medium' | 'low';
  variant: string;
  hook: string;
  email: string;
  timezoneLabel: string;
  ends: 'meeting_requested' | 'not_interested' | 'callback_requested';
}

/**
 * The live-call script. Lexi's lines are what Lexi is allowed to say: no fact
 * about Hexaware that is not an approved claim, and the standard deflection when
 * asked for something she cannot answer. The opening comes from the real frozen
 * opening module, not from here.
 */
export function bodyScript(p: LiveProspect): ScriptLine[] {
  const lines: ScriptLine[] = [
    { stage: 'reason', speaker: 'prospect', text: "Sure, go on. I've only got a minute though." },
    { stage: 'hook', speaker: 'lexi', text: `I noticed ${p.hook}. I'd guess that is keeping your team busy.` },
    { stage: 'hook', speaker: 'prospect', text: "Yes, it's been a big year for us." },
    { stage: 'value', speaker: 'lexi', text: "What I can say is that Vinay works with technology leaders who are in exactly that position, and the call is really about whether a second view would be useful to you." },
    { stage: 'value', speaker: 'prospect', text: 'What would that actually look like, though?' },
    { stage: 'value', speaker: 'lexi', text: "I don't want to give you a half answer on that. Vinay will come back to you with specifics." }
  ];

  if (p.ends === 'not_interested') {
    return [
      ...lines,
      { stage: 'ask', speaker: 'lexi', text: 'Would twenty minutes with Vinay be useful?' },
      { stage: 'ask', speaker: 'prospect', text: "Honestly, no. We have it covered and I'd rather not." },
      { stage: 'close', speaker: 'lexi', text: `Understood, ${p.firstName}. Thank you for your time, and I won't call again. Goodbye.` },
      { stage: 'close', speaker: 'prospect', text: 'Thanks. Bye.' }
    ];
  }

  if (p.ends === 'callback_requested') {
    return [
      ...lines,
      { stage: 'ask', speaker: 'lexi', text: 'Would twenty minutes with Vinay be useful?' },
      { stage: 'ask', speaker: 'prospect', text: 'Possibly, but not this week. Try me Thursday afternoon.' },
      { stage: 'close', speaker: 'lexi', text: `Thursday afternoon it is, ${p.firstName}. I'll note that, and Vinay can follow up. Thank you.` },
      { stage: 'close', speaker: 'prospect', text: 'Good. Bye.' }
    ];
  }

  return [
    ...lines,
    { stage: 'ask', speaker: 'lexi', text: 'Would twenty minutes with Vinay be useful? I can take two or three windows that suit you.' },
    { stage: 'ask', speaker: 'prospect', text: 'Tuesday or Wednesday morning would work.' },
    { stage: 'ask', speaker: 'lexi', text: `Which timezone should I note, and what's the best email for you?` },
    { stage: 'ask', speaker: 'prospect', text: `${p.timezoneLabel} time. It's ${p.email.replace('@', ' at ').replace(/\./g, ' dot ').replace(/-/g, ' dash ')}.` },
    { stage: 'ask', speaker: 'lexi', text: `Let me read that back: ${p.email.replace('@', ' at ').replace(/\./g, ' dot ').replace(/-/g, ' dash ')}. Is that right?` },
    { stage: 'ask', speaker: 'prospect', text: "That's right." },
    { stage: 'close', speaker: 'lexi', text: `Thank you, ${p.firstName}. Vinay will send you a confirmation and an invite today.` },
    { stage: 'close', speaker: 'prospect', text: 'Great, thanks. Bye.' }
  ];
}

export const LIVE_PROSPECTS: LiveProspect[] = [
  {
    name: 'Cleo Sampleton',
    firstName: 'Cleo',
    title: 'Head of Data',
    company: 'Demo Bank Beta',
    market: 'NZ',
    hypothesis: HYPOTHESES[0] as string,
    confidence: 'high',
    variant: 'hook v4',
    hook: HOOKS[0] as string,
    email: 'cleo.sampleton@demo-bank-beta.example',
    timezoneLabel: 'Auckland',
    ends: 'meeting_requested'
  },
  {
    name: 'Rowan Mockford',
    firstName: 'Rowan',
    title: 'Chief Technology Officer',
    company: 'Demo Insurer Gamma',
    market: 'AU',
    hypothesis: HYPOTHESES[3] as string,
    confidence: 'medium',
    variant: 'hook v3',
    hook: HOOKS[1] as string,
    email: 'rowan.mockford@demo-insurer-gamma.example',
    timezoneLabel: 'Sydney',
    ends: 'not_interested'
  },
  {
    name: 'Quinn Fixture',
    firstName: 'Quinn',
    title: 'Director of Digital',
    company: 'Demo Credit Union Zeta',
    market: 'NZ',
    hypothesis: HYPOTHESES[2] as string,
    confidence: 'medium',
    variant: 'hook v3',
    hook: HOOKS[2] as string,
    email: 'quinn.fixture@demo-credit-union-zeta.example',
    timezoneLabel: 'Auckland',
    ends: 'callback_requested'
  }
];
