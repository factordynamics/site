import { dupesBlocked } from './alerts';
import type { Env } from './env';

/**
 * The public /status/ data (PUBLIC_URL/status.json, written by the cron like latency.json, so pages read it without a
 * Worker request): the 13F alert path's health, a 1-minute probe of the members' API from Cloudflare's cron with 24 h
 * and 7 d uptime and daily bars, data freshness, and a restart log.
 */

/** The probe's state, in R2 only (Cloudflare's side; gene never needs it, so it isn't synced). */
const PROBE = 'status/probe.json';
const PROBE_MS = 10_000;
/** A restart whose gap is under this and that a deploy explains is labelled `deploy` and left out of the unplanned count. */
const DEPLOY_GAP_S = 60;

interface ProbeState {
  /** Per UTC hour (YYYY-MM-DDTHH): [ok, checks], 8 days kept. */
  hours: Record<string, [number, number]>;
  last?: { at: string; ok: boolean; ms: number; up_since: string | null; build: string | null; host?: string | null };
  /** Each host's boot time and build when access last moved away from it (gene and the Worker's failover copy). */
  hosts?: Record<string, { up_since: string | null; build: string | null }>;
  /** The last outage the probe saw end: first failed check to the first answer (from either host). */
  gap?: { from: string; to: string } | null;
  /** The last 50 failed checks, newest first: when, how long it waited, and the base it probed. */
  failures?: { at: string; ms: number; host: string | null }[];
  /** The members' API's count of alerts its sent record kept from going out twice (from /health?probe=1). */
  api_dupes?: { total: number; last_7d: number } | null;
  api_mail?: Kinds | null;
  /** The first failed check of the current outage. */
  fail_since?: string | null;
  restarts: Restart[];
}

export interface Restart {
  /** The API's new boot time. */
  at: string;
  prev_up_since: string;
  /** Seconds the probe couldn't reach the API around the restart (0 when no minute check failed). */
  down_seconds: number;
  /** deploy: a new build (gene's BUILD_SHA changed) with a gap under 60 s, excluded from the unplanned count.
   *  unplanned: the same build (watchdog or crash), or a gap of 60 s or more. short_unconfirmed: under 60 s, build unknown. */
  kind: 'deploy' | 'unplanned' | 'short_unconfirmed' | 'planned';
  build?: string | null;
  prev_build?: string | null;
  /** An operator's label for a restart the probe couldn't classify. */
  note?: string;
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Restarts we caused on purpose: a restart booting in the window is `planned`, with the note, and not counted unplanned. */
const PLANNED: { from: string; to: string; row: Restart }[] = [
  // The runner stopped gene's API at 08:53:19 to test automatic failover A: api.json went to the Worker at 08:55:13, gene
  // booted again at 08:56:00, and access moved back at 08:58:13. The probe logged the Worker's isolates as restarts
  // (fixed since: a host switch isn't one); the window's rows are this one row.
  {
    from: '2026-11-11T08:53:00Z',
    to: '2026-11-11T08:59:00Z',
    row: { at: '2026-11-11T08:56:00Z', prev_up_since: '2026-11-11T08:40:00Z', down_seconds: 114, kind: 'planned', build: 'caad4f5b6df5', prev_build: 'caad4f5b6df5', note: 'Planned failover test, 08:53–08:58 UTC. Member pages and the API returned errors for about 2 minutes until access moved to the backup automatically (1 min 54 s). Pages already open kept failing until reloaded. Alerts were not affected.' },
  },
];
/** The restart log as shown: a planned window's rows as its one row, newest first. */
const shownRestarts = (rows: Restart[]): Restart[] => {
  const out: Restart[] = [];
  for (const r of rows) {
    const p = PLANNED.find((x) => r.at >= x.from && r.at < x.to);
    if (!p) out.push(r);
    else if (!out.includes(p.row)) out.push(p.row);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
};
const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13);

let apiBase: { at: number; url: string } | null = null;
/** The members' API base the site uses (api.json, re-read every 10 minutes). */
export async function membersApi(env: Env, now: number): Promise<string | null> {
  if (apiBase && now - apiBase.at < 600_000) return apiBase.url;
  if (!env.PUBLIC_URL) return null;
  const r = await fetch(`${env.PUBLIC_URL}api.json`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  const url = r?.ok ? ((await r.json().catch(() => ({}))) as { api?: string }).api : undefined;
  if (url) apiBase = { at: now, url: url.replace(/\/$/, '') };
  return apiBase?.url ?? null;
}

/** One check of the members' API from Cloudflare: GET {api}/health?probe=1 within 10 s. */
type Kinds = { day: string; used?: number; real: number; test: number; account: number; preview: number; since?: string; used_at_since?: number };
type Probe = { ok: boolean; ms: number; up_since: string | null; build: string | null; host?: string | null; dupes?: { total: number; last_7d: number } | null; mail?: Kinds | null };
export async function probeOnce(env: Env, now: number): Promise<Probe> {
  const base = await membersApi(env, now);
  const t0 = Date.now();
  if (!base) return { ok: false, ms: 0, up_since: null, build: null };
  try {
    const r = await fetch(`${base}/health?probe=1`, { signal: AbortSignal.timeout(PROBE_MS), headers: { 'user-agent': 'copybook-status-probe' } });
    const b = r.ok ? ((await r.json()) as { ok?: boolean; api_host?: string; api_up_since?: string; api_build?: string | null; dupes_blocked?: { total: number; last_7d: number }; mail_kinds?: Kinds | null }) : null;
    return { ok: !!b?.ok, ms: Date.now() - t0, up_since: b?.api_up_since ?? null, build: b?.api_build ?? null, host: b?.api_host ?? null, dupes: b?.dupes_blocked ?? null, mail: b?.mail_kinds ?? null };
  } catch {
    return { ok: false, ms: Date.now() - t0, up_since: null, build: null };
  }
}

/** Adds one check to the state: the hour's counts, the outage start, and a restart when the boot time moved. */
export function recordProbe(s: ProbeState, now: number, p: Probe): ProbeState {
  if (p.dupes) s.api_dupes = p.dupes;
  if (p.mail) s.api_mail = p.mail;
  const h = (s.hours[hourKey(now)] ??= [0, 0]);
  h[0] += p.ok ? 1 : 0;
  h[1] += 1;
  const keep = hourKey(now - 8 * 86400_000);
  for (const k of Object.keys(s.hours)) if (k < keep) delete s.hours[k];
  if (!p.ok) {
    s.fail_since ??= iso(now);
    s.failures = [{ at: iso(now), ms: p.ms, host: s.last?.host ?? null }, ...(s.failures ?? [])].slice(0, 50);
  } else {
    if (s.fail_since) s.gap = { from: s.fail_since, to: iso(now) };
    // Access moved to the other host (failover, or back): not a restart. Compare with that host's own last boot.
    let prev = s.last?.up_since ?? null;
    let prevBuild = s.last?.build ?? null;
    const switched = !!p.host && !!s.last?.host && p.host !== s.last.host;
    if (switched) {
      (s.hosts ??= {})[s.last!.host!] = { up_since: s.last!.up_since, build: s.last!.build };
      prev = s.hosts[p.host!]?.up_since ?? null;
      prevBuild = s.hosts[p.host!]?.build ?? null;
    }
    // The Worker's "boot" is an isolate's, recycled at will: only the API host's own boots are restarts.
    if (prev && p.up_since && p.up_since !== prev && p.host !== 'cloudflare') {
      // The gap: from the first failed check (if any) to the new boot; after a failover, the members' outage (first
      // failed check to the backup's first answer).
      const down = switched ? (s.gap && s.gap.from >= prev ? Math.round((Date.parse(s.gap.to) - Date.parse(s.gap.from)) / 1000) : 0) : s.fail_since ? Math.max(0, Math.round((Date.parse(p.up_since) - Date.parse(s.fail_since)) / 1000)) : 0;
      const newBuild = !!p.build && !!prevBuild && p.build !== prevBuild;
      const sameBuild = !!p.build && !!prevBuild && p.build === prevBuild;
      const kind: Restart['kind'] = down >= DEPLOY_GAP_S || sameBuild ? 'unplanned' : newBuild ? 'deploy' : 'short_unconfirmed';
      s.restarts = [{ at: p.up_since, prev_up_since: prev, down_seconds: down, kind, build: p.build, prev_build: prevBuild }, ...s.restarts].slice(0, 100);
    }
    s.fail_since = null;
  }
  s.last = { at: iso(now), ok: p.ok, ms: p.ms, up_since: p.up_since ?? s.last?.up_since ?? null, build: p.build ?? s.last?.build ?? null, host: p.host ?? s.last?.host ?? null };
  return s;
}

/** Uptime over the last `hours` hours of checks, as a fraction (null with no checks), and the check count. */
function uptime(s: ProbeState, now: number, hours: number) {
  let ok = 0;
  let n = 0;
  for (let i = 0; i < hours; i++) {
    const v = s.hours[hourKey(now - i * 3600_000)];
    if (v) [ok, n] = [ok + v[0], n + v[1]];
  }
  return { uptime: n ? Math.round((ok / n) * 1e5) / 1e5 : null, checks: n, failed: n - ok };
}

/**
 * The 13F alert path: amber when a 13F alert waits for its moves over 10 minutes, a row the publish gate held has
 * waited over 30 minutes for its check, or alert mail waits for the daily reset.
 */
export async function alertHealth(env: Env, now: number) {
  const pending = JSON.parse((await env.DB.get('alerts:pending-moves')) ?? '[]') as { accepted?: string }[];
  const ages = pending.map((p) => (p.accepted ? Math.round((now - Date.parse(p.accepted)) / 1000) : 0));
  const oldest = ages.length ? Math.max(...ages) : null;
  const reset = (JSON.parse((await env.DB.get('host:mail-delayed')) ?? '[]') as unknown[]).length;
  const held = JSON.parse((await env.DB.get('alerts:pending-check')) ?? '[]') as { accepted?: string; filing_date?: string; held?: unknown[] }[];
  const heldAges = held.map((a) => Math.round((now - Date.parse(a.accepted ?? a.filing_date ?? '')) / 1000)).filter((x) => Number.isFinite(x));
  const oldestHeld = heldAges.length ? Math.max(...heldAges) : null;
  const reasons = [
    ...(oldest != null && oldest > 600 ? ['a 13F alert has waited over 10 minutes for its moves'] : []),
    ...(oldestHeld != null && oldestHeld > 1800 ? ['a 13F move held by the publish gate has waited over 30 minutes for its check'] : []),
    ...(reset ? ['alert emails are waiting for the daily email reset'] : []),
  ];
  return { state: reasons.length ? 'amber' : 'ok', reasons, pending_moves: pending.length, oldest_pending_seconds: oldest, held_rows: held.reduce((s, a) => s + (a.held?.length ?? 0), 0), oldest_held_seconds: oldestHeld, reset_queue: reset };
}

/** 13F alerts waiting for their moves, and gene's last fallback send; the same shape on /health and status.json. */
export async function movesQueue(env: Env, health: { pending_moves: number; oldest_pending_seconds: number | null }) {
  const fallback = JSON.parse((await env.DB.get('host:moves-sent-last')) ?? 'null') as { at: string; accession: string } | null;
  return { pending: health.pending_moves, oldest_wait_seconds: health.oldest_pending_seconds, last_fallback_send_at: fallback?.at ?? null };
}

/** The status object: the probe's state plus what this host knows. */
export async function buildStatus(env: Env, now: number, s: ProbeState) {
  const daily = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now - (6 - i) * 86400_000).toISOString().slice(0, 10);
    let ok = 0;
    let n = 0;
    for (const [k, v] of Object.entries(s.hours)) if (k.startsWith(day)) [ok, n] = [ok + v[0], n + v[1]];
    return { day, uptime: n ? Math.round((ok / n) * 1e5) / 1e5 : null, checks: n, failed: n - ok };
  });
  const week = now - 7 * 86400_000;
  const recent = shownRestarts(s.restarts).filter((r) => Date.parse(r.at) >= week);
  const fresh = JSON.parse((await env.DB.get('status:fresh')) ?? 'null') as { data_built_at: string | null; build_id: string | null; last_13f: { slug: string; manager: string; accession: string; accepted_at: string } | null } | null;
  // Written by Cloudflare's cron at the end of its run, which runs this only while it is the poller.
  const poller = { host: 'cloudflare', last_run_at: iso(Date.now()) };
  const health = await alertHealth(env, now);
  const dupes = await dupesBlocked(env, now);
  return {
    ok: true,
    generated_at: iso(Math.floor(now / 60_000) * 60_000),
    alerts_13f: health,
    // gene's fallback for 13Fs sent without their moves (tables too big for the Worker, or no prior book on Cloudflare).
    // Alerts each host's per-member sent record kept from going out twice: the members' API (gene) and Cloudflare.
    dupes_blocked: { since: dupes.since, api: s.api_dupes ?? null, cloudflare: { total: dupes.total, last_7d: dupes.last_7d } },
    moves_queue: await movesQueue(env, health),
    mail_quota: await mailQuotaStatus(env, s.api_mail ?? null),
    // ingest's index.json against the fields alert routing reads (contract.ts): ok, build, problems, checked_at.
    index_contract: JSON.parse((await env.DB.get('index:contract')) ?? 'null'),
    // Ingest's filer-type publish guard (types_guard.json): checked_at, status (published, accepted, held, kept), reason, moved.
    types_guard: JSON.parse((await env.DB.get('types:guard')) ?? 'null'),
    // Bulk downloads: each listed file against what its link serves (size, sha256, ETag), hourly.
    bulk_check: JSON.parse((await env.DB.get('bulk:check')) ?? 'null'),
    // Each poller's build (commit, 12 characters): Cloudflare's own, our server's from the probe of its /health.
    poller_builds: { cloudflare: env.BUILD_SHA?.slice(0, 12) ?? null, server: s.last?.build ?? null },
    probe: {
      target: 'members API /health, from Cloudflare cron',
      interval_seconds: 60,
      last_at: s.last?.at ?? null,
      last_ok: s.last?.ok ?? null,
      last_ms: s.last?.ms ?? null,
      down_since: s.fail_since ?? null,
      '24h': uptime(s, now, 24),
      '7d': uptime(s, now, 168),
      daily,
    },
    freshness: {
      data_built_at: fresh?.data_built_at ?? null,
      build_id: fresh?.build_id ?? null,
      last_13f: fresh?.last_13f ?? null,
      // Acceptance of the newest 13F in the data build to that build.
      last_13f_lag_seconds: fresh?.last_13f && fresh.data_built_at ? Math.max(0, Math.round((Date.parse(fresh.data_built_at) - Date.parse(fresh.last_13f.accepted_at)) / 1000)) : null,
      data_age_seconds: fresh?.data_built_at ? Math.round((now - Date.parse(fresh.data_built_at)) / 1000) : null,
      poller_host: poller?.host ?? null,
      poller_last_run: poller?.last_run_at ?? null,
    },
    restarts: {
      unplanned_7d: recent.filter((r) => r.kind === 'unplanned').length,
      deploys_7d: recent.filter((r) => r.kind === 'deploy').length,
      short_unconfirmed_7d: recent.filter((r) => r.kind === 'short_unconfirmed').length,
      planned_7d: recent.filter((r) => r.kind === 'planned').length,
      // The API host's own boot (while the Worker serves a failover, the host's last one, not an isolate's).
      api_up_since: (s.last?.host === 'cloudflare' ? s.hosts?.gene?.up_since : s.last?.up_since) ?? null,
      rows: shownRestarts(s.restarts).slice(0, 30),
      // The last failed checks (newest first), so each one in probe.24h can be told apart.
      failed_checks: (s.failures ?? []).filter((f) => Date.parse(f.at) >= now - 86400_000),
    },
  };
}

/**
 * Today's email sends (UTC day) by kind, both hosts together: real members, test and critic members (previews, replays
 * and samples included, also counted on their own against their cap), and account mail; against Resend's daily cap.
 */
async function mailQuotaStatus(env: Env, gene: Kinds | null) {
  const { mailQuota, PREVIEW_DAILY_CAP, kindsView } = await import('./email');
  const m = (JSON.parse((await env.DB.get('host:mail-meter')) ?? 'null') ?? mailQuota) as typeof mailQuota;
  const day = new Date().toISOString().slice(0, 10);
  const add = (k: 'real' | 'test' | 'account' | 'preview') => (m.day === day ? (m.kinds?.[k] ?? 0) : 0) + (gene?.day === day && gene.since ? (gene[k] ?? 0) : 0);
  const used = Math.max(m.day === day ? m.used : 0, gene?.day === day ? (gene.used ?? 0) : 0);
  // The host whose counters started first today sets since and before_since.
  const first = [m.day === day ? m.kinds : null, gene?.day === day ? gene : null].filter((k): k is NonNullable<typeof k> => !!k?.since).sort((a, b) => a.since!.localeCompare(b.since!))[0] ?? null;
  return {
    day,
    // Resend's own count for the UTC day, account-wide: the later of the two hosts' readings.
    resend_used: used,
    daily_cap: 100,
    reserve_for_account_mail: 15,
    // Adds up to resend_used: before_since + real + test + account + other (see kindsView). Both hosts' tallies, from the
    // earlier host's `since`.
    by_kind: { ...kindsView(used, first ? { ...first, real: add('real'), test: add('test'), account: add('account'), preview: add('preview') } : null) },
    previews: { sent: add('preview'), cap_per_host: PREVIEW_DAILY_CAP },
    test_member_alert_cap: 3,
    mailgun_used: m.day === day ? m.mailgun : 0,
  };
}

/** Cloudflare's cron, every minute: one probe, then status.json (only when the minute isn't busy, like latency.json). */
export async function runStatus(env: Env, now: number, probe: Promise<Awaited<ReturnType<typeof probeOnce>>>, publish: boolean): Promise<string> {
  const raw = await env.HIST.get(PROBE);
  const s = recordProbe(raw ? (JSON.parse(await new Response(raw.body).text()) as ProbeState) : { hours: {}, restarts: [] }, now, await probe);
  await env.HIST.put(PROBE, JSON.stringify(s));
  if (!publish || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.PUBLIC_BUCKET) return s.last?.ok ? 'probe ok' : 'probe failed';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/buckets/${env.PUBLIC_BUCKET}/objects/status.json`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json', 'cache-control': 'public, max-age=10' },
    body: JSON.stringify(await buildStatus(env, now, s)),
  });
  return `${s.last?.ok ? 'probe ok' : 'probe failed'}; status.json ${res.ok ? 'written' : `error ${res.status}`}`;
}
