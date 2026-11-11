import { apiBase, type Env } from './env';

/**
 * Automatic failover A, run by Cloudflare's minute cron (Cloudflare only: MOVED_TO is set there).
 *
 * gene's front doors (the quick tunnel named in api.json, and Funnel = MOVED_TO) share gene's uplink, so when that
 * stalls gene can't move members anywhere itself: writing api.json needs the same link. Cloudflare can.
 *  - Both front doors fail /health on FAIL_CHECKS minutes in a row: api.json → this Worker (members are served here, with
 *    the state synced through R2; see HOSTING.md). Refused when the day's Workers requests are near the free quota.
 *  - The base it replaced answers /health on OK_CHECKS minutes in a row: api.json → that base again.
 *  - It never acts on an api.json it didn't write: a manual `failover-a.sh to-worker` pin is left alone, and when gene's
 *    watcher (or anyone) publishes another base during an automatic failover, that base wins and the failover ends.
 * While gene is healthy it costs no subrequests (the status probe already checked api.json's base); it reads its state
 * from R2 each minute. Each flip emails CONTACT_EMAIL.
 */
const STATE = 'status/auto-failover.json';
export const FAIL_CHECKS = 2;
export const OK_CHECKS = 3;
const PROBE_MS = 10_000;
/** Don't move members onto the Worker past this share of the free plan's 100k requests a day. */
const QUOTA_STOP = 0.95;

export interface AutoState {
  /** Set while api.json points here because this cron put it there. */
  active: { prev: string; at: string } | null;
  fails: number;
  oks: number;
  events: { at: string; kind: 'failover' | 'failback' | 'superseded' | 'refused'; base: string; note?: string }[];
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const trim = (u: string) => u.replace(/\/+$/, '');
const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

async function healthy(base: string): Promise<boolean> {
  try {
    // probe=1: up and serving, without /health's slower reads (status.json from r2.dev), which a slow round trip from
    // gene could fail although the front door is fine.
    const r = await fetch(`${base}/health?probe=1`, { signal: AbortSignal.timeout(PROBE_MS), headers: { 'user-agent': 'copybook-auto-failover' } });
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** api.json as published now (cache-busted: the status probe's copy may be 10 minutes old). */
async function readApi(env: Env, now: number): Promise<string | null> {
  try {
    const r = await fetch(`${env.PUBLIC_URL}api.json?t=${now}`, { signal: AbortSignal.timeout(5000) });
    const api = r.ok ? ((await r.json()) as { api?: string }).api : undefined;
    return api ? trim(api) : null;
  } catch {
    return null;
  }
}

async function writeApi(env: Env, base: string, now: number): Promise<boolean> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${env.PUBLIC_BUCKET}/objects/api.json`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ api: base, at: iso(now), by: 'cloudflare auto-failover' }),
  }).catch(() => null);
  return !!res?.ok;
}

async function notify(env: Env, subject: string, text: string) {
  await (await import('./email')).sendMail(env, [{ to: env.CONTACT_EMAIL ?? 'hello@factordynamics.com', subject, text }]).catch(() => null);
}

/** One minute's check. `probeOk`: the status probe's result for api.json's base this minute. */
export async function runAutoFailover(env: Env, now: number, probeOk: boolean): Promise<string> {
  if (!env.MOVED_TO || !env.PUBLIC_URL || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.PUBLIC_BUCKET) return 'not configured';
  const self = apiBase(env);
  const funnel = trim(env.MOVED_TO);
  const raw = await env.HIST.get(STATE);
  const s: AutoState = raw ? JSON.parse(await new Response(raw.body).text()) : { active: null, fails: 0, oks: 0, events: [] };
  const before = JSON.stringify(s);
  const event = (kind: AutoState['events'][number]['kind'], base: string, note?: string) => {
    s.events = [{ at: iso(now), kind, base, ...(note ? { note } : {}) }, ...s.events].slice(0, 50);
  };
  let out: string;

  if (!s.active) {
    s.oks = 0;
    const base = probeOk ? null : await readApi(env, now);
    if (probeOk || !base || origin(base) === origin(self)) {
      // Healthy, api.json unreadable, or already on this Worker by hand (failover-a.sh): nothing to do.
      s.fails = 0;
      out = probeOk ? 'ok' : !base ? 'api.json unreadable' : 'api.json names the Worker (manual)';
    } else {
      const [a, b] = await Promise.all([healthy(base), base === funnel ? Promise.resolve(false) : healthy(funnel)]);
      if (a || b) {
        s.fails = 0;
        out = `base ${a ? 'up' : 'down'}, funnel ${b ? 'up' : 'down'}`;
      } else if (++s.fails < FAIL_CHECKS) {
        out = `both front doors down (${s.fails}/${FAIL_CHECKS})`;
      } else {
        const used = await (await import('./revenue')).requestsToday(env, now);
        const { DAILY_REQUESTS } = await import('./revenue');
        if (used && used.total >= QUOTA_STOP * DAILY_REQUESTS) {
          if (s.events[0]?.kind !== 'refused') event('refused', base, `${used.total} requests today`);
          out = `both down; not failing over: ${used.total} Workers requests today`;
        } else if (await writeApi(env, self, now)) {
          s.active = { prev: base, at: iso(now) };
          s.fails = 0;
          event('failover', self, `replaced ${base}`);
          out = `failed over: api.json -> ${self}`;
          await notify(env, 'Copybook API: members moved to the Cloudflare Worker (automatic)', `Both of gene's front doors (${base} and ${funnel}) failed /health on ${FAIL_CHECKS} minute checks in a row, so Cloudflare's cron pointed api.json at ${self} at ${iso(now)}. Members are served by the Worker now. It moves them back on its own after ${OK_CHECKS} healthy minutes of ${base}; nothing to do by hand.`);
        } else out = 'both down; api.json write failed';
      }
    }
  } else {
    const cur = await readApi(env, now);
    if (cur && origin(cur) !== origin(self)) {
      // Someone published another base (gene's watcher after a tunnel URL change, or by hand): it wins.
      event('superseded', cur);
      s.active = null;
      s.oks = 0;
      out = `failover ended: api.json now ${cur}`;
    } else if (!(await healthy(s.active.prev))) {
      s.oks = 0;
      out = `failed over since ${s.active.at}; ${s.active.prev} still down`;
    } else if (++s.oks < OK_CHECKS) {
      out = `failed over; ${s.active.prev} healthy (${s.oks}/${OK_CHECKS})`;
    } else if (await writeApi(env, s.active.prev, now)) {
      const { prev, at } = s.active;
      event('failback', prev, `failed over at ${at}`);
      s.active = null;
      s.oks = 0;
      out = `failed back: api.json -> ${prev}`;
      await notify(env, 'Copybook API: members back on gene (automatic)', `gene's front door ${prev} answered /health for ${OK_CHECKS} minutes in a row, so api.json points there again (${iso(now)}). The automatic failover started at ${at}.`);
    } else out = 'failing back; api.json write failed';
  }
  if (JSON.stringify(s) !== before) await env.HIST.put(STATE, JSON.stringify(s));
  return out;
}
