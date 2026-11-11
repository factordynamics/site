import { describe, expect, it } from 'vitest';
import { asOfTime, epochAt, latestAt, leaksAfter, prevSharesAt, rowsAt, type PitLot } from '../src/pit';

// Point-in-time rules against the acceptance test's EDGAR-checked cases
// (https://ampcode.com/artifacts/copybook-acceptance-test-per-row-point-in-time-and-as-of-61766e26-46f1-48d1-a59e-febf0a269501).
// Figures marked "verified" are the acceptance test's; HSBC and Aquamarine give EDGAR filing dates only, so their times
// of day are placeholders, and the HHH share counts are illustrative (the rule, not the figures, is under test). These
// move to ingest's own pit fixtures when its curated pit/ build lands (Nov 20).
const lot = (o: Partial<PitLot> & Pick<PitLot, 'cik' | 'quarter' | 'cusip' | 'accession' | 'accepted_at' | 'shares' | 'value_usd'>): PitLot => ({
  put_call: null,
  shares_type: 'SH',
  superseded_at: null,
  kind: 'original',
  value_as_filed: o.value_usd,
  value_scale: 1,
  split_factor_next: 1,
  prev_cusip: null,
  unreliable: null,
  suspect_reason: null,
  ...o,
});
const T = (s: string) => Date.parse(s);
const row = (rows: ReturnType<typeof rowsAt>, cusip: string) => rows.find((r) => r.cusip === cusip);

describe('point in time (as_of)', () => {
  it('case 8, Invesco 2026Q1: an additive NEW HOLDINGS adds lots on existing CUSIPs, never before its acceptance (verified)', () => {
    const o = { cik: '0000914208', quarter: '2026Q1', accession: '0000914208-26-000193', accepted_at: '2026-05-12T20:11:18Z' };
    const a = { cik: '0000914208', quarter: '2026Q1', accession: '0000914208-26-000216', accepted_at: '2026-07-15T19:29:41Z', kind: 'new_holdings' as const };
    const lots = [
      lot({ ...o, cusip: '482480100', shares: 1_661_786, value_usd: 2_446_829_984 }),
      lot({ ...a, cusip: '482480100', shares: 2_750_991, value_usd: 4_050_586_658 }),
      lot({ ...o, cusip: '09857L108', shares: 353_550, value_usd: 1_488_557_753 }),
      lot({ ...a, cusip: '09857L108', shares: 664_716, value_usd: 2_798_667_069 }),
    ];
    const june = rowsAt(lots, T('2026-06-01T23:59:59Z'));
    expect([row(june, '482480100')?.shares, row(june, '09857L108')?.shares, row(june, '482480100')?.lots.length]).toEqual([1_661_786, 353_550, 1]);
    const after = rowsAt(lots, T('2026-07-15T19:29:41Z'));
    const klac = row(after, '482480100')!;
    expect([klac.shares, klac.lots.length, klac.first_disclosed_at, klac.last_changed_accession]).toEqual([4_412_777, 2, '2026-05-12T20:11:18Z', '0000914208-26-000216']);
    expect(row(after, '09857L108')!.shares).toBe(1_018_266);
    // One second before the amendment's acceptance it isn't there yet (accepted_at <= T is inclusive).
    expect(row(rowsAt(lots, T('2026-07-15T19:29:40Z')), '482480100')!.shares).toBe(1_661_786);
  });

  it('case 5, Citadel 2026Q2: a RESTATEMENT replaces the book; dropped rows vanish, a changed row keeps its first disclosure (verified)', () => {
    const o = { cik: '0001423053', quarter: '2026Q2', accession: '0001104659-26-097200', accepted_at: '2026-08-14T20:18:47Z', superseded_at: '2026-09-01T22:14:00Z' };
    const r = { cik: '0001423053', quarter: '2026Q2', accession: '0001104659-26-104387', accepted_at: '2026-09-01T22:14:00Z', kind: 'restatement' as const };
    const lots = [
      lot({ ...o, cusip: 'G2131A108', shares: 3_253_289, value_usd: 53_934_268 }),
      lot({ ...o, cusip: '75120L209', shares: 7_705_787, value_usd: 12_732_490 }),
      lot({ ...r, cusip: '75120L209', shares: 72_200, value_usd: 1_155_200 }),
    ];
    const aug = rowsAt(lots, T('2026-08-20T23:59:59Z'));
    expect([row(aug, 'G2131A108')?.shares, row(aug, '75120L209')?.shares]).toEqual([3_253_289, 7_705_787]);
    const sep = rowsAt(lots, T('2026-09-02T23:59:59Z'));
    const r75 = row(sep, '75120L209')!;
    // Never the sum of both filings: the original's lot is superseded.
    expect([row(sep, 'G2131A108'), r75.shares, r75.value_usd, r75.source_accession, r75.first_disclosed_at, r75.last_changed_at, r75.lots.map((l) => l.kind)]).toEqual([undefined, 72_200, 1_155_200, '0001104659-26-097200', '2026-08-14T20:18:47Z', '2026-09-01T22:14:00Z', ['restatement']]);
  });

  it('case 7, JPMorgan 2026Q1: the epoch at 14:00Z is the 13:30:42Z original, from 15:36:31Z the same-day RESTATEMENT (verified)', () => {
    const index = { quarters: { '2026Q1': ['2026-05-13T13:30:42Z', '2026-05-13T15:36:31Z'] } };
    expect([epochAt(index, '2026Q1', T('2026-05-13T13:30:41Z')), epochAt(index, '2026Q1', T('2026-05-13T14:00:00Z')), epochAt(index, '2026Q1', T('2026-05-13T15:36:31Z'))]).toEqual([null, '2026-05-13T13:30:42Z', '2026-05-13T15:36:31Z']);
  });

  it('case 10, late filers: no version by T is not_yet_filed, and latest is the quarter before (filing dates verified; times are placeholders)', () => {
    const hsbc = { cik: '0000873630', index: { quarters: { '2025Q3': ['2025-11-14T21:00:00Z'], '2025Q4': ['2026-03-06T21:00:00Z', '2026-03-20T21:00:00Z'] } } };
    expect(epochAt(hsbc.index, '2025Q4', T('2026-02-20T23:59:59Z'))).toBeNull();
    expect(latestAt([hsbc], T('2026-02-20T23:59:59Z'))).toMatchObject({ quarter: '2025Q3' });
    expect(latestAt([hsbc], T('2026-03-07T00:00:00Z'))).toMatchObject({ quarter: '2025Q4', epoch: '2026-03-06T21:00:00Z', current: false });
    // Aquamarine's 2025Q3, filed 104 days late, isn't dated to the 45-day deadline.
    const aqua = { cik: '0001493152', index: { quarters: { '2025Q2': ['2025-08-14T21:00:00Z'], '2025Q3': ['2026-01-12T21:00:00Z'] } } };
    expect([epochAt(aqua.index, '2025Q3', T('2025-11-20T23:59:59Z')), latestAt([aqua], T('2025-11-20T23:59:59Z'))?.quarter]).toEqual([null, '2025Q2']);
  });

  it('a CIK lineage: latest at T comes from whichever CIK filed it (Appaloosa 1006438, then 1656456; dates illustrative)', () => {
    const old = { cik: '0001006438', index: { quarters: { '2015Q3': ['2015-11-16T20:00:00Z'] } } };
    const now = { cik: '0001656456', index: { quarters: { '2015Q4': ['2016-02-12T20:00:00Z'] } } };
    expect([latestAt([old, now], T('2016-01-01T00:00:00Z'))?.cik, latestAt([old, now], T('2016-03-01T00:00:00Z'))?.cik]).toEqual(['0001006438', '0001656456']);
  });

  it('the analyst\'s blocker: a lot carries its held side, so a row rebuilt from bulk is held as /v1 holds it (GuardCap BKNG 2026Q3, verified)', () => {
    const g = lot({ cik: '0001732008', quarter: '2026Q3', cusip: '09857L108', accession: 'gc-q3', accepted_at: '2026-11-10T20:00:00Z', shares: 1_304, value_usd: 6_676_571, unreliable: 'shares', suspect_reason: 'reissue_ratio_not_applied' });
    const r = rowsAt([g], T('2026-11-11T00:00:00Z'))[0];
    expect([r.unreliable, r.suspect_reason, r.lots[0].unreliable]).toEqual(['shares', 'reissue_ratio_not_applied', 'shares']);
    // Lots that disagree on the side hold the whole row.
    const v = { ...g, accession: 'gc-q3-a', accepted_at: '2026-11-10T21:00:00Z', kind: 'new_holdings' as const, unreliable: 'value' as const };
    expect(rowsAt([g, v], T('2026-11-11T00:00:00Z'))[0].unreliable).toBe('both');
  });

  it('a combined prior (prev_combined_with): a late Q-1 filing by any CIK in the set changes prev at T only from its acceptance (HHH; shares illustrative)', () => {
    const q1 = { quarter: '2026Q1', cusip: '44267T102' };
    const prev = [
      lot({ ...q1, cik: '0001336528', accession: 'psca-q1', accepted_at: '2026-05-15T20:00:00Z', shares: 9_000_000, value_usd: 1 }),
      lot({ ...q1, cik: '0001172661', accession: '0001172661-26-002339', accepted_at: '2026-06-10T20:00:00Z', shares: 1_000_000, value_usd: 1 }),
    ];
    const key = { cusip: '44267T102', put_call: null, shares_type: 'SH' as const };
    const ciks = ['0001336528', '0001172661'];
    expect([prevSharesAt(prev, T('2026-06-01T00:00:00Z'), key, ciks), prevSharesAt(prev, T('2026-06-11T00:00:00Z'), key, ciks), prevSharesAt(prev, T('2026-06-11T00:00:00Z'), key, ['0001336528'])]).toEqual([9_000_000, 10_000_000, 9_000_000]);
  });

  it('SH and PRN lots of one CUSIP stay separate rows (Sprott XOM 2026Q2)', () => {
    const base = { cik: '0001512920', quarter: '2026Q2', cusip: '30231G102', accession: 'sp', accepted_at: '2026-08-14T20:00:00Z', value_usd: 1 };
    expect(rowsAt([lot({ ...base, shares: 10 }), lot({ ...base, shares: 20, shares_type: 'PRN' })], T('2026-09-01T00:00:00Z')).map((r) => [r.shares_type, r.shares])).toEqual([['SH', 10], ['PRN', 20]]);
  });

  it('invariant 3 and the as_of echo: nothing accepted after T; a date is 23:59:59Z; a future T is now', () => {
    const book = { filing: { versions: [{ accession: 'A', accepted_at: '2026-05-12T20:11:18Z' }, { accession: 'B', accepted_at: '2026-07-15T19:29:41Z' }] }, holdings: [{ lots: [{ accession: 'B', accepted_at: '2026-07-15T19:29:41Z' }] }] };
    expect([leaksAfter(book, T('2026-06-01T00:00:00Z')), leaksAfter(book, T('2026-08-01T00:00:00Z'))]).toEqual([['B'], []]);
    expect(asOfTime('2025-06-01', T('2026-01-01T00:00:00Z'))).toEqual({ T: T('2025-06-01T23:59:59Z'), echo: '2025-06-01T23:59:59Z', future: false });
    expect(asOfTime('2030-01-01', T('2026-11-11T21:00:00Z'))).toMatchObject({ echo: '2026-11-11T21:00:00Z', future: true });
  });
});
