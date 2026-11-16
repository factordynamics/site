// The suite's clock: shifted to a fixed instant outside any 13F deadline week, launch week or other dated window, so
// results don't depend on the day it runs (gene's deployer runs it and refuses a red build, deadline day included).
// Time still advances, and vi.useRealTimers() returns to this clock, not the machine's.
const SUITE_START = Date.parse('2026-11-12T15:00:00Z');
const RealDate = Date;
const offset = SUITE_START - RealDate.now();
class SuiteDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...(args as [number]));
  }
  static now() {
    return RealDate.now() + offset;
  }
}
globalThis.Date = SuiteDate as DateConstructor;
