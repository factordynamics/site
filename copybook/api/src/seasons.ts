/**
 * 13F filing seasons. A 13F is due 45 days after the quarter ends; when that falls on a weekend or a
 * federal holiday, the next business day. Filing week is the 7 days up to the deadline and the day after.
 */
export const DEADLINES = [
  { quarter: '2026Q3', date: '2026-11-16' }, // Nov 14 is a Saturday
  { quarter: '2026Q4', date: '2027-02-16' }, // Feb 14 is a Sunday, Feb 15 Presidents' Day
  { quarter: '2027Q1', date: '2027-05-17' }, // May 15 is a Saturday
  { quarter: '2027Q2', date: '2027-08-16' }, // Aug 14 is a Saturday
  { quarter: '2027Q3', date: '2027-11-15' }, // Nov 14 is a Sunday
  { quarter: '2027Q4', date: '2028-02-14' },
] as const;

const DAY = 86400_000;
/** The deadline's end, 22:00 ET (EDGAR closes), as UTC ms. */
const endOf = (date: string) => Date.parse(`${date}T22:00:00-05:00`);

/** The next deadline not yet passed at `now`. */
export function nextDeadline(now: number): (typeof DEADLINES)[number] {
  return DEADLINES.find((d) => endOf(d.date) >= now) ?? DEADLINES[DEADLINES.length - 1];
}

/** The most recent deadline already passed at `now`, if any. */
export function lastDeadline(now: number): (typeof DEADLINES)[number] | null {
  return [...DEADLINES].reverse().find((d) => endOf(d.date) < now) ?? null;
}

/** Filing week: from 7 days before a deadline through the day after it. */
export function inFilingWeek(now: number): boolean {
  return DEADLINES.some((d) => now >= endOf(d.date) - 7 * DAY && now <= endOf(d.date) + DAY);
}

export const deadlineMs = endOf;

/**
 * Where issuer insider history starts: the first day of the quarter whose 13Fs are due next (Jul 1 until
 * the Nov 16 deadline, then Oct 1), so every Form 4 and 13D/G since the latest 13F's quarter began is kept.
 */
export function quarterStart(now: number): string {
  const [y, q] = nextDeadline(now).quarter.split('Q').map(Number);
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00Z`;
}

/**
 * Where a pause between seasons ends: 14 days before the next 13F deadline that is still more than 14 days
 * away (Nov 9, 2026 -> Feb 2, 2027, two weeks before the Feb 16 deadline). Unix seconds.
 */
export function pauseResumesAt(now: number): { at: number; quarter: string; deadline: string } {
  const d = DEADLINES.find((x) => endOf(x.date) - 14 * DAY > now) ?? DEADLINES[DEADLINES.length - 1];
  return { at: Math.floor((endOf(d.date) - 14 * DAY) / 1000), quarter: d.quarter, deadline: d.date };
}
