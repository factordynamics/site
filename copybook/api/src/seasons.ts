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

/** A deadline as members read it: "Tue Feb 16, 2027". */
export const deadlineLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(',', '');

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

/** 13F season: from a quarter's end through its filing deadline plus 7 days (the after-deadline amendments). */
export function in13fSeason(now: number): boolean {
  return DEADLINES.some((d) => {
    const [y, q] = d.quarter.split('Q').map(Number);
    return now >= Date.UTC(y, q * 3, 1) && now <= endOf(d.date) + 7 * DAY;
  });
}

/** /speed/'s label for a filing EDGAR accepted after hours (the lead, Nov 19). */
export const AFTER_HOURS_LABEL = 'filed after hours; EDGAR publishes it the next morning';

/**
 * When EDGAR first lists a filing accepted after hours: one accepted from 17:30 ET (it carries the next business day's
 * filing date) or on a weekend is published at 06:00 ET on the next weekday. Null for one accepted in hours, whose
 * listing is its acceptance. Federal holidays aren't skipped (the next one in season is Thanksgiving, Nov 26).
 */
export function edgarListedAt(acceptedMs: number): number | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(acceptedMs)).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  if (!weekend && mins >= 6 * 60 && mins < 17 * 60 + 30) return null;
  // The ET calendar day to publish on: today if before 06:00 on a weekday, else the next weekday.
  let day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const wd = (t: number) => new Date(t).getUTCDay();
  if (weekend || mins >= 17 * 60 + 30) day += DAY;
  while (wd(day) === 0 || wd(day) === 6) day += DAY;
  // 06:00 in New York on that day: try EST then EDT, keeping the one that reads 06:00 there.
  for (const off of [5, 4]) {
    const t = day + (6 + off) * 3600_000;
    const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    if (Number(h) === 6) return t;
  }
  return day + 11 * 3600_000;
}
