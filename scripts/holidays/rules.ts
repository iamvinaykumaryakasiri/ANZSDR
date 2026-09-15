/**
 * Public holiday rules for Australia and New Zealand.
 *
 * These rules exist at BUILD time only. The runtime compliance gate reads the
 * generated calendar in `config/holidays/`, never these rules, so a bug here can
 * never silently change a live dial decision - it has to go through a regenerated,
 * reviewable, diffable data file first.
 *
 * The rules are validated differentially against five years of official
 * `data.gov.au` holiday data (see `tests/holidays/rules.test.ts`). The invariant
 * is that the generated calendar is a SUPERSET of the official one: blocking a day
 * the government did not gazette costs us one dial slot, missing a day the
 * government did gazette is a breach of the Telemarketing Standard.
 */

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // 1 = Monday (ISO)

export type DateRule =
  | { kind: 'fixed'; month: number; day: number }
  | { kind: 'nth-weekday'; month: number; weekday: Weekday; n: number } // n = -1 for last
  | { kind: 'easter-offset'; offset: number }
  | { kind: 'weekday-on-or-after'; month: number; day: number; weekday: Weekday }
  /** The Monday closest to a given date: same-week Monday for Mon-Thu, next Monday otherwise. */
  | { kind: 'monday-nearest'; month: number; day: number }
  | { kind: 'weekday-before'; weekday: Weekday; before: DateRule }
  | { kind: 'weekday-after'; weekday: Weekday; after: DateRule }
  /** Explicit dates, for holidays proclaimed annually rather than defined by rule. */
  | { kind: 'listed'; dates: Record<number, string | null> };

export type Substitution =
  /** Observed only on the day it falls. */
  | 'none'
  /** Observed on the day it falls, plus the following Monday when that day is a weekend. */
  | 'add-monday-if-weekend'
  /**
   * Paired end-of-year holidays (Christmas/Boxing Day, New Year's Day/day after).
   * A weekend occurrence is observed two days later, which lands on the Monday for
   * a Saturday and on the Tuesday for a Sunday - the Monday being already taken by
   * the other half of the pair.
   */
  | 'weekend-plus-two'
  /** NZ Mondayisation of a standalone holiday: a weekend occurrence moves to the Monday. */
  | 'mondayise';

export interface HolidayRule {
  name: string;
  jurisdictions: string[];
  date: DateRule;
  substitution: Substitution;
  /**
   * Part-day holidays (Christmas Eve evening, New Year's Eve evening) do not block
   * business-hours calling. Recorded precisely so the window check stays honest at
   * the statutory 20:00 edge rather than over-blocking a whole day.
   */
  partDayFrom?: string;
  /** Set when the date is proclaimed annually and cannot be derived from a rule. */
  proclaimed?: boolean;
  /** First year the holiday exists at all. Earlier years are absent, not missing. */
  effectiveFrom?: number;
  source: string;
}

const AU_ALL = ['au-act', 'au-nsw', 'au-nt', 'au-qld', 'au-sa', 'au-tas', 'au-vic', 'au-wa'];

const DGA = 'data.gov.au australian-holidays-machine-readable-dataset';

export const AU_RULES: HolidayRule[] = [
  { name: "New Year's Day", jurisdictions: AU_ALL, date: { kind: 'fixed', month: 1, day: 1 }, substitution: 'add-monday-if-weekend', source: DGA },
  { name: 'Australia Day', jurisdictions: AU_ALL, date: { kind: 'fixed', month: 1, day: 26 }, substitution: 'add-monday-if-weekend', source: DGA },
  { name: 'Good Friday', jurisdictions: AU_ALL, date: { kind: 'easter-offset', offset: -2 }, substitution: 'none', source: DGA },
  { name: 'Easter Saturday', jurisdictions: ['au-act', 'au-nsw', 'au-nt', 'au-qld', 'au-sa', 'au-vic'], date: { kind: 'easter-offset', offset: -1 }, substitution: 'none', source: DGA },
  { name: 'Easter Sunday', jurisdictions: ['au-act', 'au-nsw', 'au-nt', 'au-qld', 'au-sa', 'au-vic', 'au-wa'], date: { kind: 'easter-offset', offset: 0 }, substitution: 'none', source: DGA },
  { name: 'Easter Monday', jurisdictions: AU_ALL, date: { kind: 'easter-offset', offset: 1 }, substitution: 'none', source: DGA },
  { name: 'Easter Tuesday', jurisdictions: ['au-tas'], date: { kind: 'easter-offset', offset: 2 }, substitution: 'none', source: DGA },
  { name: 'Anzac Day', jurisdictions: AU_ALL, date: { kind: 'fixed', month: 4, day: 25 }, substitution: 'none', source: DGA },
  // ACT, NT, QLD move Anzac Day off a weekend; SA and WA add a day. Modelled as
  // "add" for all five, which is the conservative reading of both.
  { name: 'Anzac Day (additional day)', jurisdictions: ['au-act', 'au-nt', 'au-qld', 'au-sa', 'au-wa'], date: { kind: 'fixed', month: 4, day: 25 }, substitution: 'add-monday-if-weekend', source: DGA },
  { name: "King's Birthday", jurisdictions: ['au-act', 'au-nsw', 'au-nt', 'au-sa', 'au-tas', 'au-vic'], date: { kind: 'nth-weekday', month: 6, weekday: 1, n: 2 }, substitution: 'none', source: DGA },
  { name: "King's Birthday", jurisdictions: ['au-qld'], date: { kind: 'nth-weekday', month: 10, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  // Western Australia proclaims the King's Birthday each year; it is usually the
  // last Monday in September but has moved. Listed explicitly, not derived.
  { name: "King's Birthday", jurisdictions: ['au-wa'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-09-27', 2022: '2022-09-26', 2023: '2023-09-25', 2024: '2024-09-23', 2025: '2025-09-29', 2026: '2026-09-28', 2027: null } }, substitution: 'none', source: 'WA Department of Mines, Industry Regulation and Safety - proclaimed annually' },
  { name: 'Labour Day', jurisdictions: ['au-act', 'au-nsw', 'au-sa'], date: { kind: 'nth-weekday', month: 10, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Labour Day', jurisdictions: ['au-qld'], date: { kind: 'nth-weekday', month: 5, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'May Day', jurisdictions: ['au-nt'], date: { kind: 'nth-weekday', month: 5, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Labour Day', jurisdictions: ['au-vic'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 2 }, substitution: 'none', source: DGA },
  { name: 'Eight Hours Day', jurisdictions: ['au-tas'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 2 }, substitution: 'none', source: DGA },
  { name: 'Labour Day', jurisdictions: ['au-wa'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Canberra Day', jurisdictions: ['au-act'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 2 }, substitution: 'none', source: DGA },
  { name: 'Reconciliation Day', jurisdictions: ['au-act'], date: { kind: 'weekday-on-or-after', month: 5, day: 27, weekday: 1 }, substitution: 'none', source: DGA },
  { name: 'Adelaide Cup Day', jurisdictions: ['au-sa'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 2 }, substitution: 'none', source: DGA },
  { name: 'Western Australia Day', jurisdictions: ['au-wa'], date: { kind: 'nth-weekday', month: 6, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Melbourne Cup', jurisdictions: ['au-vic'], date: { kind: 'nth-weekday', month: 11, weekday: 2, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Bank Holiday', jurisdictions: ['au-nsw'], date: { kind: 'nth-weekday', month: 8, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  { name: 'Picnic Day', jurisdictions: ['au-nt'], date: { kind: 'nth-weekday', month: 8, weekday: 1, n: 1 }, substitution: 'none', source: DGA },
  // Proclaimed annually: show days and the AFL Grand Final Friday.
  { name: 'Royal Queensland Show (Brisbane area only)', jurisdictions: ['au-qld'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-10-29', 2022: '2022-08-10', 2023: '2023-08-16', 2024: '2024-08-14', 2025: '2025-08-13', 2026: '2026-08-12', 2027: null } }, substitution: 'none', source: 'Queensland Government - proclaimed annually' },
  { name: 'Friday before the AFL Grand Final', jurisdictions: ['au-vic'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-09-24', 2022: '2022-09-23', 2023: '2023-09-29', 2024: '2024-09-27', 2025: '2025-09-26', 2026: null, 2027: null } }, substitution: 'none', source: 'Victorian Government - proclaimed annually, date depends on the AFL fixture' },
  { name: 'Alice Springs Show Day', jurisdictions: ['au-nt'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-07-02', 2022: '2022-07-01', 2023: '2023-07-07', 2024: '2024-07-05', 2025: '2025-07-04', 2026: '2026-07-03', 2027: null } }, substitution: 'none', source: 'NT Government - proclaimed annually' },
  { name: 'Tennant Creek Show Day', jurisdictions: ['au-nt'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-07-09', 2022: '2022-07-08', 2023: '2023-07-14', 2024: '2024-07-12', 2025: '2025-07-11', 2026: '2026-07-10', 2027: null } }, substitution: 'none', source: 'NT Government - proclaimed annually' },
  { name: 'Katherine Show Day', jurisdictions: ['au-nt'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-07-16', 2022: '2022-07-15', 2023: '2023-07-21', 2024: '2024-07-19', 2025: '2025-07-18', 2026: '2026-07-17', 2027: null } }, substitution: 'none', source: 'NT Government - proclaimed annually' },
  { name: 'Darwin Show Day', jurisdictions: ['au-nt'], proclaimed: true, date: { kind: 'listed', dates: { 2021: '2021-07-23', 2022: '2022-07-22', 2023: '2023-07-28', 2024: '2024-07-26', 2025: '2025-07-25', 2026: '2026-07-24', 2027: null } }, substitution: 'none', source: 'NT Government - proclaimed annually' },
  { name: 'Christmas Day', jurisdictions: AU_ALL, date: { kind: 'fixed', month: 12, day: 25 }, substitution: 'weekend-plus-two', source: DGA },
  { name: 'Boxing Day', jurisdictions: AU_ALL, date: { kind: 'fixed', month: 12, day: 26 }, substitution: 'weekend-plus-two', source: DGA },
  { name: 'Christmas Eve (part day)', jurisdictions: ['au-qld'], date: { kind: 'fixed', month: 12, day: 24 }, substitution: 'none', partDayFrom: '18:00', source: DGA },
  { name: 'Christmas Eve (part day)', jurisdictions: ['au-nt', 'au-sa'], date: { kind: 'fixed', month: 12, day: 24 }, substitution: 'none', partDayFrom: '19:00', source: DGA },
  { name: "New Year's Eve (part day)", jurisdictions: ['au-nt', 'au-sa'], date: { kind: 'fixed', month: 12, day: 31 }, substitution: 'none', partDayFrom: '19:00', source: DGA }
];

const NZ_ALL_REGIONS = [
  'nz-auckland', 'nz-canterbury', 'nz-chatham', 'nz-hawkes-bay', 'nz-marlborough',
  'nz-nelson', 'nz-otago', 'nz-south-canterbury', 'nz-southland', 'nz-taranaki',
  'nz-wellington', 'nz-westland'
];

const NZ_ACT = 'Holidays Act 2003 (NZ)';

export const NZ_RULES: HolidayRule[] = [
  { name: "New Year's Day", jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 1, day: 1 }, substitution: 'weekend-plus-two', source: NZ_ACT },
  { name: "Day after New Year's Day", jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 1, day: 2 }, substitution: 'weekend-plus-two', source: NZ_ACT },
  { name: 'Waitangi Day', jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 2, day: 6 }, substitution: 'mondayise', source: NZ_ACT },
  { name: 'Good Friday', jurisdictions: ['nz-national'], date: { kind: 'easter-offset', offset: -2 }, substitution: 'none', source: NZ_ACT },
  { name: 'Easter Monday', jurisdictions: ['nz-national'], date: { kind: 'easter-offset', offset: 1 }, substitution: 'none', source: NZ_ACT },
  { name: 'Anzac Day', jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 4, day: 25 }, substitution: 'mondayise', source: NZ_ACT },
  { name: "King's Birthday", jurisdictions: ['nz-national'], date: { kind: 'nth-weekday', month: 6, weekday: 1, n: 1 }, substitution: 'none', source: NZ_ACT },
  // Matariki moves with the lunar calendar; the dates are scheduled in legislation.
  { name: 'Matariki', jurisdictions: ['nz-national'], proclaimed: true, effectiveFrom: 2022, date: { kind: 'listed', dates: { 2022: '2022-06-24', 2023: '2023-07-14', 2024: '2024-06-28', 2025: '2025-06-20', 2026: '2026-07-10', 2027: '2027-06-25' } }, substitution: 'none', source: 'Te Kahui o Matariki Public Holiday Act 2022, Schedule' },
  { name: 'Labour Day', jurisdictions: ['nz-national'], date: { kind: 'nth-weekday', month: 10, weekday: 1, n: 4 }, substitution: 'none', source: NZ_ACT },
  { name: 'Christmas Day', jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 12, day: 25 }, substitution: 'weekend-plus-two', source: NZ_ACT },
  { name: 'Boxing Day', jurisdictions: ['nz-national'], date: { kind: 'fixed', month: 12, day: 26 }, substitution: 'weekend-plus-two', source: NZ_ACT },

  { name: 'Auckland Anniversary Day', jurisdictions: ['nz-auckland'], date: { kind: 'monday-nearest', month: 1, day: 29 }, substitution: 'none', source: NZ_ACT },
  { name: 'Wellington Anniversary Day', jurisdictions: ['nz-wellington'], date: { kind: 'monday-nearest', month: 1, day: 22 }, substitution: 'none', source: NZ_ACT },
  { name: 'Nelson Anniversary Day', jurisdictions: ['nz-nelson'], date: { kind: 'monday-nearest', month: 2, day: 1 }, substitution: 'none', source: NZ_ACT },
  { name: 'Taranaki Anniversary Day', jurisdictions: ['nz-taranaki'], date: { kind: 'nth-weekday', month: 3, weekday: 1, n: 2 }, substitution: 'none', source: NZ_ACT },
  { name: 'Otago Anniversary Day', jurisdictions: ['nz-otago'], date: { kind: 'monday-nearest', month: 3, day: 23 }, substitution: 'none', source: NZ_ACT },
  { name: 'Southland Anniversary Day', jurisdictions: ['nz-southland'], date: { kind: 'easter-offset', offset: 2 }, substitution: 'none', source: NZ_ACT },
  { name: 'South Canterbury Anniversary Day', jurisdictions: ['nz-south-canterbury'], date: { kind: 'nth-weekday', month: 9, weekday: 1, n: 4 }, substitution: 'none', source: NZ_ACT },
  { name: "Hawke's Bay Anniversary Day", jurisdictions: ['nz-hawkes-bay'], date: { kind: 'weekday-before', weekday: 5, before: { kind: 'nth-weekday', month: 10, weekday: 1, n: 4 } }, substitution: 'none', source: NZ_ACT },
  { name: 'Marlborough Anniversary Day', jurisdictions: ['nz-marlborough'], date: { kind: 'weekday-after', weekday: 1, after: { kind: 'nth-weekday', month: 10, weekday: 1, n: 4 } }, substitution: 'none', source: NZ_ACT },
  { name: 'Canterbury Anniversary Day', jurisdictions: ['nz-canterbury'], date: { kind: 'weekday-after', weekday: 5, after: { kind: 'weekday-after', weekday: 5, after: { kind: 'nth-weekday', month: 11, weekday: 2, n: 1 } } }, substitution: 'none', source: NZ_ACT },
  { name: 'Chatham Islands Anniversary Day', jurisdictions: ['nz-chatham'], date: { kind: 'monday-nearest', month: 11, day: 30 }, substitution: 'none', source: NZ_ACT },
  { name: 'Westland Anniversary Day', jurisdictions: ['nz-westland'], date: { kind: 'monday-nearest', month: 12, day: 1 }, substitution: 'none', source: NZ_ACT }
];

export const NZ_REGIONS = NZ_ALL_REGIONS;
