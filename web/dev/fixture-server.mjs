#!/usr/bin/env node
/**
 * DEV ONLY. A stand-in for the console backend so the frontend can be built and
 * screenshotted on its own. It speaks the wire contract in src/stream/contract.ts
 * over plain node:http with invented data. It is not part of the production
 * bundle (nothing under web/src imports it), it is never deployed, and the real
 * backend (`npm run console:demo`, or the live server) replaces it.
 *
 *   node dev/fixture-server.mjs                 # port 8081, token "demo"
 *   PORT=8081 FIXTURE_TOKEN=demo node ...
 *   FIXTURE_STATE=live|idle   which state to start in (default idle)
 *   FIXTURE_LOOP=0            freeze the scripted call loop (for screenshots)
 *
 * Every person and company below is made up.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8081);
const TOKEN = process.env.FIXTURE_TOKEN ?? 'demo';
const LOOP = process.env.FIXTURE_LOOP !== '0';
const START_LIVE = (process.env.FIXTURE_STATE ?? 'idle') === 'live';

/* ------------------------------------------------------------------ helpers */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261007);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const iso = (ms) => new Date(ms).toISOString();
const NOW = () => Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

function label(ms, tz, endMs) {
  const day = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
  const t = (m) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(m);
  const zone = new Intl.DateTimeFormat('en-AU', { timeZone: tz, timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${day}, ${t(ms)} to ${t(endMs)} ${zone}`;
}

/** The next occurrence (from now) of a weekday (0 Sun .. 6 Sat) at a given local hour in a zone, as epoch ms. */
function nextAt(weekday, hour, tz, minute = 0, skip = 0) {
  for (let d = 1; d < 21; d++) {
    const probe = NOW() + d * 24 * HOUR;
    const wd = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short' }).format(probe);
    const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    if (idx !== weekday) continue;
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(probe);
    // Walk by hour until the wall clock reads the requested time.
    let guess = Date.parse(`${parts}T00:00:00Z`) - 14 * HOUR;
    for (let i = 0; i < 90; i++) {
      const h = Number(new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', hour12: false }).format(guess));
      const mm = Number(new Intl.DateTimeFormat('en-AU', { timeZone: tz, minute: '2-digit' }).format(guess));
      const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(guess) === parts;
      if (sameDay && h === hour && mm === minute) return guess;
      guess += 30 * MIN;
    }
  }
  return NOW() + 3 * 24 * HOUR;
}

function windowFor(weekday, hour, tz, said, minutes = 30, skip = 0) {
  const start = nextAt(weekday, hour, tz, 0, skip);
  const end = start + minutes * MIN;
  return { startsAt: iso(start), endsAt: iso(end), said, localLabel: label(start, tz, end), sydneyLabel: label(start, 'Australia/Sydney', end) };
}

/* -------------------------------------------------------------------- people */

const COMPANIES = [
  { name: 'Harbourline Bank', market: 'AU' },
  { name: 'Banksia Capital', market: 'AU' },
  { name: 'Ironbark Super', market: 'AU' },
  { name: 'Coolabah Insurance', market: 'AU' },
  { name: 'Tasman Mutual', market: 'NZ' },
  { name: 'Kōwhai Financial', market: 'NZ' },
  { name: 'Waitemata Credit Union', market: 'NZ' },
  { name: 'Pōhutukawa Payments', market: 'NZ' }
];
const FIRST = ['Meera', 'Daniel', 'Aroha', 'Callum', 'Sienna', 'Tane', 'Imogen', 'Rohan', 'Hana', 'Marcus', 'Leilani', 'Owen', 'Priya', 'Jack', 'Mere', 'Elliot'];
const LAST = ['Chandran', 'Whitlock', 'Parata', 'Brennan', 'Okafor', 'Ngata', 'Hartley', 'Desai', 'Kereama', 'Lindqvist', 'Tuhoro', 'Fairweather', 'Raman', 'Doyle', 'Wiremu', 'Castellano'];
const TITLES = ['Chief Data Officer', 'Head of Data and AI', 'Chief Technology Officer', 'GM Digital Engineering', 'Head of Enterprise Architecture', 'Chief Information Officer', 'Director of Platforms', 'Head of Data Engineering'];
const SENIORITY = { 'Chief Data Officer': 'C-suite', 'Chief Technology Officer': 'C-suite', 'Chief Information Officer': 'C-suite' };
const VARIANTS = ['v12 (champion)', 'v13 (challenger)'];

const person = (i) => ({ name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`, title: TITLES[(i * 3 + 1) % TITLES.length] });

/* --------------------------------------------------------------------- calls */

const OUTCOMES_SHORT = ['not_interested', 'gatekeeper_blocked', 'wrong_person', 'do_not_contact'];

function buildCalls() {
  const calls = [];
  const total = 64;
  for (let i = 0; i < total; i++) {
    const co = COMPANIES[Math.floor(rand() * COMPANIES.length)];
    const p = person(i + 2);
    const r = rand();
    let duration;
    let outcome;
    if (r < 0.1) {
      duration = 0;
      outcome = 'no_answer';
    } else if (r < 0.17) {
      duration = 22;
      outcome = 'voicemail';
    } else if (r < 0.2) {
      duration = 0;
      outcome = 'invalid_number';
    } else if (r < 0.42) {
      // lost in the opener
      duration = 4 + Math.floor(rand() * 11);
      outcome = pick(['not_interested', 'not_interested', 'gatekeeper_blocked', 'wrong_person']);
    } else if (r < 0.62) {
      // lost around the reason and the hook
      duration = 15 + Math.floor(rand() * 30);
      outcome = pick(['not_interested', 'not_interested', 'gatekeeper_blocked', 'callback_requested']);
    } else if (r < 0.79) {
      duration = 45 + Math.floor(rand() * 22);
      outcome = pick(['not_interested', 'callback_requested', 'not_interested']);
    } else {
      duration = 62 + Math.floor(rand() * 40);
      outcome = pick(['meeting_requested', 'meeting_requested', 'callback_requested', 'not_interested']);
    }
    const hoursAgo = 2 + (total - i) * 1.7 + rand();
    const variant = i % 3 === 0 ? VARIANTS[1] : VARIANTS[0];
    const defects = outcome === 'not_interested' && duration > 40 && i % 5 === 0 ? 1 : 0;
    calls.push({
      id: `call-${String(1000 + i)}`,
      startedAt: iso(NOW() - hoursAgo * HOUR),
      durationSeconds: duration,
      name: p.name,
      title: p.title,
      company: co.name,
      market: co.market,
      outcome,
      variant,
      defects,
      industry: 'Banking and finance',
      seniority: SENIORITY[p.title] ?? 'Head of'
    });
  }
  // A few more specific ones so the log has a story.
  return calls.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

const CALLS = buildCalls();
// Pin four meeting requests to real calls in the log.
const MR_CALLS = CALLS.filter((c) => c.outcome === 'meeting_requested').slice(0, 4);
while (MR_CALLS.length < 4) {
  const c = CALLS.find((x) => x.durationSeconds > 70 && !MR_CALLS.includes(x));
  if (!c) break;
  c.outcome = 'meeting_requested';
  MR_CALLS.push(c);
}

/* ------------------------------------------------------------ meeting requests */

const DRAFT = (first, when) => `Hi ${first},

Thanks for taking the time to speak with Lexi, our AI assistant, earlier today. I'm Vinay Kumar, Sales Director at Hexaware for ANZ.

You mentioned the platform renewal and the reporting debt sitting on top of it. I'd value twenty minutes to hear how you're thinking about it, and to share what we've seen work with other financial services teams in the region.

Would ${when} suit? If another time is better, tell me and I'll work around you.

Kind regards,
Vinay

Vinay Kumar
Sales Director, ANZ, Hexaware Technologies`;

const SUMMARY = [
  'Lexi disclosed that she is an AI assistant and that the call was recorded.',
  'The prospect confirmed the platform renewal is underway and the reporting backlog is a worry.',
  'Lexi asked for twenty minutes with Vinay; the prospect asked whether it would be a pitch.',
  'Lexi said Vinay listens first. The prospect named two windows and gave a work email.',
  'Lexi said Vinay would send a confirmation and an invite today.'
];

const MEETINGS = [
  {
    ref: 'MR-4F2A91C0',
    status: 'pending',
    createdAt: iso(NOW() - 38 * MIN),
    name: 'Meera Chandran',
    title: 'Chief Data Officer',
    company: 'Tasman Mutual',
    email: 'meera.chandran@tasmanmutual.example',
    phone: '+64 21 555 0142',
    linkedinUrl: 'https://www.linkedin.com/in/example-meera-chandran',
    windows: [windowFor(2, 10, 'Pacific/Auckland', 'Tuesday or Wednesday morning, after nine thirty', 30, 0), windowFor(3, 10, 'Pacific/Auckland', 'Tuesday or Wednesday morning, after nine thirty', 30, 0)],
    attendees: ['Their head of reporting, Aroha Parata'],
    hypothesis: 'A core platform renewal was announced in August; a data leader inheriting it is likely weighing migration and reporting risk.',
    hookThatWorked: 'Opening on the August renewal announcement rather than a generic cloud line.',
    summary: SUMMARY,
    objections: ['Is this going to be a pitch?'],
    draftReply: DRAFT('Meera', 'Tuesday at 10:00 New Zealand time'),
    callId: MR_CALLS[0]?.id ?? 'call-1000'
  },
  {
    ref: 'MR-9B7E03D1',
    status: 'pending',
    createdAt: iso(NOW() - 3 * HOUR),
    name: 'Daniel Whitlock',
    title: 'Head of Data and AI',
    company: 'Harbourline Bank',
    email: 'daniel.whitlock@harbourline.example',
    phone: '+61 2 5550 0187',
    linkedinUrl: null,
    windows: [windowFor(4, 15, 'Australia/Perth', 'After three any day next week, Perth time', 30, 0)],
    attendees: [],
    hypothesis: 'Hiring for a lakehouse engineering lead suggests a data platform consolidation is in flight.',
    hookThatWorked: 'The open lakehouse engineering role.',
    summary: SUMMARY,
    objections: ["We already have a partner for that.", 'Send me something first.'],
    draftReply: DRAFT('Daniel', 'Thursday at 3:00pm Perth time'),
    callId: MR_CALLS[1]?.id ?? 'call-1001'
  },
  {
    ref: 'MR-1C55AA42',
    status: 'pending',
    createdAt: iso(NOW() - 20 * HOUR),
    name: 'Aroha Parata',
    title: 'GM Digital Engineering',
    company: 'Kōwhai Financial',
    email: null,
    phone: '+64 9 555 0166',
    linkedinUrl: 'https://www.linkedin.com/in/example-aroha-parata',
    windows: [windowFor(5, 14, 'Pacific/Auckland', 'Friday afternoon, my time', 30, 0)],
    attendees: [],
    hypothesis: 'Public commentary on engineering capacity during the digital banking build-out.',
    hookThatWorked: null,
    summary: SUMMARY,
    objections: [],
    draftReply: DRAFT('Aroha', 'Friday at 2:00pm New Zealand time'),
    callId: MR_CALLS[2]?.id ?? 'call-1002'
  },
  {
    ref: 'MR-77D0E1B9',
    status: 'confirmed',
    createdAt: iso(NOW() - 30 * HOUR),
    name: 'Callum Brennan',
    title: 'Chief Technology Officer',
    company: 'Banksia Capital',
    email: 'callum.brennan@banksia.example',
    phone: '+61 3 5550 0129',
    linkedinUrl: null,
    windows: [windowFor(3, 11, 'Australia/Melbourne', 'Wednesday late morning', 30, 0)],
    attendees: ['CFO, for the last ten minutes'],
    hypothesis: 'Investor update mentioned a modernisation programme with a hard deadline.',
    hookThatWorked: 'The modernisation deadline in the investor update.',
    summary: SUMMARY,
    objections: [],
    draftReply: DRAFT('Callum', 'Wednesday at 11:00am Melbourne time'),
    callId: MR_CALLS[3]?.id ?? 'call-1003'
  }
];

const ESCALATIONS = [
  {
    id: 'esc-1',
    contact: 'Richard Aubrey',
    company: 'Ironbark Super',
    reason: 'Said Ironbark is already a Hexaware client and asked for their account manager. Lexi ended the call politely.',
    at: iso(NOW() - 95 * MIN)
  }
];

/* ------------------------------------------------------------------- queue */

function queueItem(i, company, market, allowed, reasons, earliestMinutes) {
  const p = person(i + 20);
  return {
    contactId: `c-${i}`,
    name: p.name,
    title: p.title,
    company,
    market,
    hypothesis: pick([
      'Their annual report names data platform consolidation as a priority for the year.',
      'Three open roles in data engineering suggest a build-out ahead of a migration.',
      'A recent conference talk covered reporting latency across legacy cores.',
      'A leadership change in March often precedes a review of the technology estate.'
    ]),
    earliestLawfulAt: earliestMinutes === null ? null : iso(NOW() + earliestMinutes * MIN),
    gate: { allowed, reasons }
  };
}

const QUEUE = [
  queueItem(1, 'Waitemata Credit Union', 'NZ', true, [], 11),
  queueItem(2, 'Harbourline Bank', 'AU', true, [], 11),
  queueItem(3, 'Pōhutukawa Payments', 'NZ', true, [], 14),
  queueItem(4, 'Ironbark Super', 'AU', false, ['OUTSIDE_STATUTORY_WINDOW'], 190),
  queueItem(5, 'Coolabah Insurance', 'AU', false, ['MOBILE_DIALLING_DISABLED'], null),
  queueItem(6, 'Banksia Capital', 'AU', false, ['MIN_INTERVAL_NOT_ELAPSED', 'ACCOUNT_WEEKLY_CAP'], 2900)
];

/* ----------------------------------------------------------------- aggregates */

function buildAggregates() {
  const answered = CALLS.filter((c) => c.durationSeconds > 0 && !['no_answer', 'voicemail', 'invalid_number'].includes(c.outcome));
  const dialled = CALLS.length;
  const opener = answered.filter((c) => c.durationSeconds >= 15);
  const conv = answered.filter((c) => c.durationSeconds >= 45);
  const ask = answered.filter((c) => c.durationSeconds >= 62 || c.outcome === 'meeting_requested');
  const req = CALLS.filter((c) => c.outcome === 'meeting_requested');
  const confirmedIds = new Set(MEETINGS.filter((m) => m.status === 'confirmed').map((m) => m.callId));
  const conf = req.filter((c) => confirmedIds.has(c.id));
  const stages = [
    ['queued', 'Queued', dialled + 17, 1, 1],
    ['gate_passed', 'Passed the compliance gate', dialled, null, 0.8],
    ['dialled', 'Dialled', dialled, null, 1],
    ['answered', 'Answered', answered.length, null, 0.7],
    ['survived_opener', 'Survived the opener (15s)', opener.length, null, 0.9],
    ['real_conversation', 'Real conversation (45s and over)', conv.length, null, 0.64],
    ['ask_made', 'Ask made', ask.length, null, 0.7],
    ['meeting_requested', 'Meeting requested', req.length, null, 0.42],
    ['confirmed', 'Confirmed by Vinay', conf.length, null, 0.55]
  ];
  const funnel = stages.map(([id, lbl, count], i) => {
    const prev = i === 0 ? count : stages[i - 1][2];
    const rate = i === 0 ? 1 : prev === 0 ? 0 : count / prev;
    // The seven-day baseline: mostly close to today, with the opener visibly worse today.
    const wobble = { survived_opener: 0.1, real_conversation: 0.03, answered: -0.02, ask_made: 0.01 }[id] ?? 0;
    return { id, label: lbl, count, rate, loss: i === 0 ? 0 : Math.max(0, prev - count), baselineRate: i === 0 ? 1 : Math.min(1, Math.max(0, rate + wobble)) };
  });

  const binSeconds = 5;
  const bins = [];
  for (let from = 0; from < 120; from += binSeconds) {
    const ids = answered.filter((c) => c.durationSeconds >= from && c.durationSeconds < from + binSeconds).map((c) => c.id);
    bins.push({ fromSecond: from, count: ids.length, callIds: ids });
  }
  const sections = [
    { id: 'disclosure', label: 'Disclosure', fromSecond: 0, toSecond: 14 },
    { id: 'reason', label: 'Reason for call', fromSecond: 14, toSecond: 24 },
    { id: 'hook', label: 'Hook', fromSecond: 24, toSecond: 42 },
    { id: 'value', label: 'Value', fromSecond: 42, toSecond: 62 },
    { id: 'ask', label: 'The ask', fromSecond: 62, toSecond: 88 },
    { id: 'close', label: 'Close', fromSecond: 88, toSecond: 120 }
  ];
  return { funnel, hangupCurve: { binSeconds, bins, sections } };
}

const AGG = buildAggregates();

const PLAYBOOK = {
  champion: { version: 'v12', summary: 'Opens on a dated, public announcement, then bridges to data movement risk.', requestRate: 0.092, conversations: 118 },
  challenger: { version: 'v13', summary: 'Same opening; the value statement leads with reporting backlog instead of migration risk.', requestRate: 0.118, conversations: 22, minConversations: 30 },
  history: [
    { version: 'v13', at: iso(NOW() - 2 * 24 * HOUR), note: 'Challenger started: value statement now leads with reporting backlog. Passed the linter, the compliance review, the claim check and the adversarial set.', outcome: 'running' },
    { version: 'v12', at: iso(NOW() - 9 * 24 * HOUR), note: 'Promoted after 34 conversations: request rate rose 3.1 points with no loss in completion, sentiment or defects.', outcome: 'promoted' },
    { version: 'v11b', at: iso(NOW() - 12 * 24 * HOUR), note: 'Rejected before running: the variant dropped the recording announcement. The gate refuses any change to the opening.', outcome: 'rejected' },
    { version: 'v11', at: iso(NOW() - 16 * 24 * HOUR), note: 'Rolled back after nine conversations: more hang-ups in the first fifteen seconds than the champion.', outcome: 'rolled_back' },
    { version: 'v10', at: iso(NOW() - 30 * 24 * HOUR), note: 'The original champion, written by hand.', outcome: 'champion' }
  ]
};

const HEALTH = {
  queueDepth: 17,
  providers: [
    { name: 'Voice provider', status: 'ok', detail: 'Last call connected in 410 ms.' },
    { name: 'Twilio voice', status: 'ok' },
    { name: 'Twilio SMS', status: 'degraded', detail: 'Delivery receipts are arriving about four minutes late.' },
    { name: 'Apollo', status: 'ok', detail: 'Phone reveals arrive by webhook, usually within ten minutes.' },
    { name: 'Anthropic API', status: 'ok' },
    { name: 'Redis queue', status: 'ok' },
    { name: 'Mail transport', status: 'not_configured', detail: 'Mail is being written to data/outbox for now.' }
  ],
  apolloCreditsRemaining: 3412,
  spendMonthUsd: 18.4,
  spendCeilingUsd: 25,
  gateRejections: [
    { reason: 'DAY_PLAN_NOT_APPROVED', count: 31 },
    { reason: 'OUTSIDE_STATUTORY_WINDOW', count: 22 },
    { reason: 'MOBILE_DIALLING_DISABLED', count: 17 },
    { reason: 'MIN_INTERVAL_NOT_ELAPSED', count: 9 },
    { reason: 'ACCOUNT_WEEKLY_CAP', count: 6 },
    { reason: 'SUPPRESSED', count: 3 }
  ]
};

const TRACE = [
  ['campaign_director', 'Started the tick. Four contacts are cleared and one account is capped for the week, so work goes to the cleared four.', 'Queued four dials behind the approved plan.', 0.0],
  ['prospector', 'Searched Apollo for heads of data at Kōwhai Financial because the account had no contact above manager level.', 'Found six people, scored three above the threshold, enriched emails for those three. No credits spent on people already held.', 0.0312],
  ['scout', 'Built a dossier for Meera Chandran ahead of her slot, because she passed the research gate.', 'Dossier of medium confidence: two sourced hooks, one landmine (a pending restructure announcement) to avoid.', 0.2144],
  ['caller', 'Took the call with Meera Chandran on the challenger script.', 'Meeting requested for Tuesday or Wednesday morning; email captured and read back.', 0.1306],
  ['guardian', 'Audited the call transcript against the approved claims.', 'No unsupported assertions. One turn was held for a second check and cleared.', 0.0457],
  ['scribe', 'Wrote up the outcome from the tool calls Lexi made.', 'Outcome: meeting requested. Summary written. Workbook updated.', 0.0198],
  ['concierge', 'Sent the meeting request to Vinay two minutes after the call ended.', 'Email with the .ics and a draft reply written to the outbox. A confirmation text to the prospect was planned and sent.', 0.0089],
  ['campaign_director', 'Held the Ironbark Super dial because it is 08:20 in Perth and the legal window opens at 09:00 there.', 'Re-queued for 09:00 Perth time. Nothing was dialled.', 0.0],
  ['coach', 'Reviewed the week and proposed one variant for the value statement only.', 'Variant v13 passed all four gate stages and started as challenger.', 0.5412],
  ['analyst', 'Compiled the morning briefing and the daily digest.', 'Briefing ready. Cost per meeting is down on last week.', 0.0733]
].map((row, i) => ({ id: `t-${i}`, at: iso(NOW() - (i * 47 + 6) * MIN), agent: row[0], decision: row[1], result: row[2], costUsd: row[3] }));

const BRIEFING = () => ({
  generatedAt: iso(NOW() - 12 * MIN),
  headline: 'Three meeting requests are waiting, and one escalation needs a call from you.',
  sections: [
    { title: 'Yesterday', body: 'Fourteen dials, nine connected, five real conversations and three meeting requests. The opener lost more people than usual: nine of the fourteen that answered were gone inside fifteen seconds.' },
    { title: 'What changed', body: 'Challenger v13 is running with twenty-two of the thirty conversations it needs. It is ahead by two and a half points, which is too early to call.' },
    { title: 'What needs you', body: 'Three meeting requests, one from Auckland and one from Perth, are waiting for a decision.\n\nRichard Aubrey at Ironbark Super said they are already a Hexaware client. Lexi ended the call politely and has stopped calling the account.' },
    { title: 'Today', body: 'Six people are queued. Three are cleared. One Perth dial waits for 09:00 local time and two are held by the gate.' }
  ]
});

/* ------------------------------------------------------------------ live call */

const LIVE_PROSPECT = { name: 'Meera Chandran', title: 'Chief Data Officer', company: 'Tasman Mutual', market: 'NZ' };
const LIVE_SCRIPT = [
  { atSecond: 0, speaker: 'lexi', text: "Hi Meera, it's Lexi. I'm an AI assistant on the ANZ sales team at Hexaware, working with Vinay Kumar." },
  { atSecond: 7, speaker: 'lexi', text: "I'm calling because Tasman Mutual's platform renewal came up in your August announcement, and I wanted to ask you about it. This call is being recorded. Do you have thirty seconds?" },
  { atSecond: 15, speaker: 'prospect', text: "Sure. Go on, but I've only got a few minutes." },
  { atSecond: 19, speaker: 'lexi', text: "Thanks, I'll keep it brief. When a data leader inherits a platform renewal, the risk usually sits in how the data moves, not in the platform itself." },
  { atSecond: 28, speaker: 'lexi', text: 'Is that something you are thinking about at the moment?' },
  { atSecond: 33, speaker: 'prospect', text: "It is, actually. We've got about three years of reporting debt sitting on top of that core." },
  { atSecond: 44, speaker: 'lexi', text: 'That is useful to know. Hexaware works with financial services teams across ANZ on data modernisation, and Vinay would value twenty minutes to hear how you are approaching it.' },
  { atSecond: 58, speaker: 'prospect', text: 'Maybe. Is this going to be a pitch?' },
  { atSecond: 64, speaker: 'lexi', text: 'No deck. Twenty minutes, and Vinay listens first. What days suit you over the next fortnight?' },
  { atSecond: 77, speaker: 'prospect', text: 'Tuesday or Wednesday morning, after half past nine.' },
  { atSecond: 83, speaker: 'lexi', text: 'Tuesday or Wednesday morning, after nine thirty. And what is the best email for you?' },
  { atSecond: 91, speaker: 'prospect', text: 'meera dot chandran at tasman mutual dot co dot nz.' },
  { atSecond: 97, speaker: 'lexi', text: 'Thank you, Meera. Vinay will send you a confirmation and an invite today. Have a good afternoon.' }
];
const STAGES = [
  [0, 'disclosure'],
  [14, 'reason'],
  [24, 'hook'],
  [42, 'value'],
  [62, 'ask'],
  [88, 'close']
];
const stageAt = (s) => [...STAGES].reverse().find(([from]) => s >= from)?.[1] ?? 'disclosure';
const CALL_LENGTH = 102;

const state = {
  killSwitch: { engaged: false },
  live: null,
  nextDialAt: NOW() + 11 * MIN,
  loopNextStartAt: NOW() + 12_000,
  emitted: 0,
  lastStage: 'disclosure',
  calls: CALLS,
  meetings: MEETINGS
};

function startLive(offset) {
  state.live = {
    callId: 'call-live-1',
    prospect: LIVE_PROSPECT,
    hypothesis: "Tasman Mutual announced a core platform renewal in August; a data leader inheriting it is likely weighing migration and reporting risk.",
    startedAt: iso(NOW() - offset * 1000),
    elapsedSeconds: offset,
    stage: stageAt(offset),
    confidence: 'medium',
    variant: 'v13 (challenger)',
    transcript: LIVE_SCRIPT.filter((t) => t.atSecond <= offset)
  };
  state.emitted = state.live.transcript.length;
  state.lastStage = state.live.stage;
}

if (START_LIVE) startLive(47);

function snapshot() {
  const live = state.live ? { ...state.live, elapsedSeconds: LOOP ? Math.floor((NOW() - Date.parse(state.live.startedAt)) / 1000) : state.live.elapsedSeconds } : null;
  const next = QUEUE[0];
  const today = { dialled: 14, connected: 9, conversations: 5, requests: state.meetings.filter((m) => Date.parse(m.createdAt) > NOW() - 24 * HOUR).length, spendUsd: 4.62, costPerMeetingUsd: 1.54 };
  return {
    generatedAt: iso(NOW()),
    mode: 'demo',
    killSwitch: state.killSwitch,
    live,
    standingBy: {
      next,
      nextDialAt: iso(state.nextDialAt),
      note: "Today's plan is approved for six people. The next dial waits for the Auckland window to be open and no other call to be live."
    },
    needsYou: { meetingRequests: state.meetings, escalations: ESCALATIONS },
    upNext: QUEUE,
    today,
    funnel: AGG.funnel,
    hangupCurve: AGG.hangupCurve,
    objections: [
      { label: 'We already have a partner for that.', count: 9 },
      { label: 'Just send me an email.', count: 7 },
      { label: "I'm not sure I want to talk to an AI.", count: 5 },
      { label: "That's not my area.", count: 4 },
      { label: 'No budget this year.', count: 3 }
    ],
    gatekeeperByAccount: [
      { company: 'Harbourline Bank', blocks: 4, calls: 7 },
      { company: 'Banksia Capital', blocks: 2, calls: 5 },
      { company: 'Kōwhai Financial', blocks: 1, calls: 6 },
      { company: 'Tasman Mutual', blocks: 0, calls: 4 }
    ],
    wrongNumberRate: 0.043,
    playbook: PLAYBOOK,
    health: HEALTH,
    briefing: BRIEFING()
  };
}

/* --------------------------------------------------------------- SSE plumbing */

const clients = new Set();
function send(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function broadcast(event) {
  for (const res of clients) send(res, event);
}

if (LOOP) {
  setInterval(() => {
    if (state.killSwitch.engaged) return;
    if (state.live) {
      const elapsed = Math.floor((NOW() - Date.parse(state.live.startedAt)) / 1000);
      while (state.emitted < LIVE_SCRIPT.length && (LIVE_SCRIPT[state.emitted]?.atSecond ?? Infinity) <= elapsed) {
        const turn = LIVE_SCRIPT[state.emitted];
        state.live.transcript.push(turn);
        state.emitted += 1;
        broadcast({ type: 'transcript', callId: state.live.callId, turn });
      }
      const stage = stageAt(elapsed);
      if (stage !== state.lastStage) {
        state.lastStage = stage;
        state.live.stage = stage;
        broadcast({ type: 'stage', callId: state.live.callId, stage });
      }
      if (elapsed >= CALL_LENGTH) {
        broadcast({ type: 'call_ended', callId: state.live.callId, outcome: 'meeting_requested' });
        state.live = null;
        state.loopNextStartAt = NOW() + 15_000;
        state.nextDialAt = state.loopNextStartAt;
      }
    } else if (NOW() >= state.loopNextStartAt) {
      startLive(0);
      broadcast({ type: 'call_started', call: state.live });
    }
  }, 1000);
}

setInterval(() => {
  for (const res of clients) res.write(': keepalive\n\n');
}, 15_000);

/* ------------------------------------------------------------------- the rest */

function detail(id) {
  const c = state.calls.find((x) => x.id === id);
  if (!c) return null;
  const first = c.name.split(' ')[0];
  const t = [
    { speaker: 'lexi', text: `Hi ${first}, it's Lexi. I'm an AI assistant on the ANZ sales team at Hexaware, working with Vinay Kumar. I'm calling about ${c.company}'s data platform plans. This call is being recorded. Do you have thirty seconds?`, atSecond: 0 }
  ];
  if (c.durationSeconds > 12) t.push({ speaker: 'prospect', text: c.outcome === 'gatekeeper_blocked' ? "He's not available. Can I take a message?" : 'Go on, but I am short on time.', atSecond: 12 });
  if (c.durationSeconds > 26) t.push({ speaker: 'lexi', text: 'Thanks. I will keep it brief. Is the consolidation of reporting data something you are looking at this year?', atSecond: 22 });
  if (c.durationSeconds > 40) t.push({ speaker: 'prospect', text: c.outcome === 'not_interested' ? "We already have a partner for that, so I'll pass." : 'It is on the list, yes.', atSecond: 36 });
  if (c.durationSeconds > 62) t.push({ speaker: 'lexi', text: 'Understood. Vinay would value twenty minutes to hear how you are approaching it. What days suit you?', atSecond: 58 });
  const defectDetails =
    c.defects > 0
      ? [{ kind: 'Unsupported claim', detail: 'Lexi said Hexaware has "hundreds of banking clients in the region". No approved claim supports a number, so the audit logged it.', atSecond: Math.min(36, c.durationSeconds) }]
      : [];
  return {
    id: c.id,
    startedAt: c.startedAt,
    durationSeconds: c.durationSeconds,
    name: c.name,
    company: c.company,
    market: c.market,
    outcome: c.outcome,
    variant: c.variant,
    defects: c.defects,
    transcript: c.durationSeconds === 0 ? [] : t,
    recordingUrl: c.durationSeconds === 0 || c.id.endsWith('7') ? null : `/api/console/recordings/${c.id}.wav`,
    dossierSummary: `${c.title ?? 'Senior technology leader'} at ${c.company}. Dossier confidence: medium. Two sourced hooks; one landmine to avoid (a leadership announcement still pending).`,
    defectDetails
  };
}

function wav(seconds) {
  const rate = 8000;
  const n = Math.max(1, Math.floor(seconds * rate));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = (Math.sin(t * 2.2) + 1) / 2 > 0.55 ? 1 : 0.08;
    const v = Math.sin(2 * Math.PI * (180 + 40 * Math.sin(t * 0.7)) * t) * 0.12 * env;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

function jarvis(query) {
  const q = query.toLowerCase();
  if (/delete|erase|wipe|forget/.test(q)) {
    return { kind: 'refused', text: 'Suppression is permanent by design and records are not deleted from here. A deletion request under the Privacy Act goes through the privacy process, not this bar.', sources: ['compliance policy: suppression list'] };
  }
  if (/pause|resume|suppress|requeue|roll ?back|stop calling/.test(q)) {
    return {
      kind: 'needs_confirmation',
      text: 'I can do that, but it changes the state of the system, so I need you to confirm.',
      sources: ['blackboard: campaigns', 'blackboard: playbook history'],
      action: {
        actionId: 'act-' + Math.floor(rand() * 1e6),
        description: /roll ?back/.test(q)
          ? 'Roll the live script back from v13 (challenger) to v12 (champion). The challenger stops taking calls; its 22 conversations are kept as evidence. Calls in progress finish on v13.'
          : "Pause the NZ banking pilot campaign. 4 queued contacts are held until you resume it. A call that is already live is not interrupted."
      }
    };
  }
  if (/cost per meeting|spend/.test(q)) {
    return { kind: 'answer', text: 'Cost per meeting is US$1.54 today (US$4.62 spent, 3 meeting requests). This month it is US$3.07 across 6 requests, with US$18.40 of the US$25 ceiling used.', sources: ['blackboard: spend ledger, October', 'blackboard: meeting requests, October'] };
  }
  if (/hook|new zealand|nz/.test(q)) {
    return { kind: 'answer', text: 'In New Zealand the hook that names a dated, public announcement is converting at 14% to a meeting request over 29 conversations. The generic cloud-migration hook is at 6% over 17. The sample is small, so treat it as a lead, not a result.', sources: ['blackboard: calls, last 30 days, market NZ', 'blackboard: playbook v12, v13'] };
  }
  if (/ten seconds|died|first/.test(q)) {
    return { kind: 'answer', text: 'Eleven calls ended inside ten seconds this week. Seven were gatekeepers, three said "not interested" straight away, and one was a wrong number.', sources: ['blackboard: calls, this week, duration under 10s'] };
  }
  return { kind: 'answer', text: 'I read the last seven days of calls and the queue. Nothing in them answers that directly. Try asking about a company, a market, a script or a cost.', sources: ['blackboard: calls, last 7 days', 'blackboard: queue'] };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, fixture: true });
  if (!url.pathname.startsWith('/api/console')) return json(res, 404, { error: 'not found' });

  const auth = req.headers.authorization ?? '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-admin-token'] ?? '');
  if (supplied !== TOKEN) return json(res, 401, { error: 'unauthorised' });

  const path = url.pathname.replace('/api/console', '') || '/';

  if (req.method === 'GET' && path === '/snapshot') return json(res, 200, snapshot());

  if (req.method === 'GET' && path === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive' });
    clients.add(res);
    send(res, { type: 'snapshot', snapshot: snapshot() });
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/kill') {
    const body = await readBody(req);
    state.killSwitch = body.engage ? { engaged: true, reason: body.reason ?? 'Stopped from the console', since: iso(NOW()) } : { engaged: false };
    json(res, 200, state.killSwitch);
    broadcast({ type: 'kill_switch', killSwitch: state.killSwitch });
    return;
  }

  const meeting = path.match(/^\/meetings\/([^/]+)$/);
  if (req.method === 'POST' && meeting) {
    const body = await readBody(req);
    const m = state.meetings.find((x) => x.ref === decodeURIComponent(meeting[1]));
    if (!m) return json(res, 404, { error: 'unknown meeting request' });
    if (m.status !== 'pending') return json(res, 409, { error: `already ${m.status}` });
    m.status = { CONFIRMED: 'confirmed', RESCHEDULE: 'rescheduled', REJECT: 'rejected' }[body.decision] ?? 'pending';
    return json(res, 200, m);
  }

  if (req.method === 'GET' && path === '/calls') return json(res, 200, state.calls.map(({ title, ...c }) => c));
  const call = path.match(/^\/calls\/([^/]+)$/);
  if (req.method === 'GET' && call) {
    const d = detail(decodeURIComponent(call[1]));
    return d ? json(res, 200, d) : json(res, 404, { error: 'unknown call' });
  }
  const rec = path.match(/^\/recordings\/([^/]+)\.wav$/);
  if (req.method === 'GET' && rec) {
    const c = state.calls.find((x) => x.id === rec[1]);
    const data = wav(Math.max(8, c?.durationSeconds ?? 20));
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': data.length, 'accept-ranges': 'none' });
    return res.end(data);
  }
  if (req.method === 'GET' && path === '/trace') return json(res, 200, TRACE);

  if (req.method === 'POST' && path === '/jarvis') {
    const body = await readBody(req);
    return json(res, 200, jarvis(String(body.query ?? '')));
  }
  if (req.method === 'POST' && path === '/jarvis/confirm') {
    const body = await readBody(req);
    if (!body.actionId) return json(res, 400, { error: 'actionId is required' });
    return json(res, 200, { kind: 'done', text: 'Done. The change is made and logged in the agent trace.', sources: ['agent trace: just now'] });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`DEV ONLY fixture console backend on http://localhost:${PORT}/api/console  (token: ${TOKEN}, loop: ${LOOP ? 'on' : 'frozen'}, start: ${START_LIVE ? 'live' : 'idle'})`);
});
