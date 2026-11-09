// Self-hosted copybook-api: runs the Worker bundle (wrangler deploy --dry-run --outdir) in workerd through Miniflare,
// with KV, R2 and SQLite Durable Objects persisted under STATE_DIR, an in-process "* * * * *" cron, and a plain HTTP
// front door on 127.0.0.1 that Tailscale Funnel proxies to. Nothing else is exposed: no /cdn-cgi or /__scheduled routes.
//
// Env: SITE_API_DIR (copybook/api checkout, for wrangler.toml), BUILD_DIR (bundle), STATE_DIR, PORT, PUBLIC_API_URL,
// PUBLIC_ORIGIN, CRON_FLAG (cron runs only while this file exists), and the Worker secrets.
import { makeMiniflare } from './mf.mjs';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';

const env = process.env;
const mf = makeMiniflare();
await mf.ready;
const PORT = Number(env.PORT ?? 8787);
const ORIGIN = env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${PORT}`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    // Served directly by cloudflared on a machine without gene's proxy: the public paths carry the /copybook prefix.
    if (url.pathname === '/copybook' || url.pathname.startsWith('/copybook/')) url.pathname = url.pathname.slice('/copybook'.length) || '/';
    if (url.pathname.startsWith('/cdn-cgi/') || url.pathname.startsWith('/__')) {
      res.writeHead(404).end();
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || k === 'host' || k.startsWith('cf-') || k.startsWith('mf-') || k.startsWith('x-copybook-')) continue;
      for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
    }
    // Funnel is the only way in (we listen on loopback), and it sets X-Forwarded-For to the client.
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress;
    headers.set('cf-connecting-ip', ip);
    // The entry point for short-lived links (CSV links, /v1/bulk): the proxy reports the public host; any client copy
    // of x-copybook-* was dropped above. Only the tunnel and Funnel hosts count.
    const host = String(req.headers['x-copybook-host'] ?? req.headers.host ?? '');
    if (/^[a-z0-9-]+\.(trycloudflare\.com|tail70ba3\.ts\.net)$/.test(host)) headers.set('x-copybook-public-base', `https://${host}/copybook`);
    // Buffered, so the Worker sees a body of known length: R2 put() rejects a stream without one, and on Cloudflare
    // request bodies carry their length. Uploads are bounded (ingest bundles of ≤500 files).
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
      headers.set('content-length', String(body.length));
      headers.delete('transfer-encoding');
    }
    const r = await mf.dispatchFetch(url.toString(), { method: req.method, headers, body, redirect: 'manual' });
    const out = {};
    // fetch() has already decoded a compressed body, so its encoding and length no longer apply.
    const decoded = r.headers.has('content-encoding');
    r.headers.forEach((v, k) => {
      if (k.startsWith('mf-') || k === 'content-encoding' || k === 'transfer-encoding' || k === 'connection' || (decoded && k === 'content-length')) return;
      out[k] = k in out ? [].concat(out[k], v) : v;
    });
    res.writeHead(r.status, out);
    if (r.body) Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    else res.end();
  } catch (e) {
    // Path only (query strings carry signed tokens), emails masked: agents read this journal into session logs.
    console.error(`request ${req.method} ${String(req.url).split('?')[0].replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@|%40)/g, '$1***$2')} failed: ${e?.stack ?? e}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end('{"ok":false,"error":"upstream"}');
    else res.destroy();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`copybook-api listening on 127.0.0.1:${PORT} as ${env.PUBLIC_API_URL}`));

// Cron "* * * * *": fire at each UTC minute boundary with that minute as scheduledTime, like Cloudflare does.
// Runs never block each other; a slow run overlaps the next, as on Cloudflare.
function nextMinute() {
  const now = Date.now();
  const at = Math.floor(now / 60000) * 60000 + 60000;
  setTimeout(() => {
    nextMinute();
    if (!existsSync(env.CRON_FLAG)) return;
    const t0 = Date.now();
    mf.getWorker()
      .then((w) => w.scheduled({ cron: '* * * * *', scheduledTime: new Date(at) }))
      .then((r) => console.log(`cron ${new Date(at).toISOString()} ${r.outcome} in ${Date.now() - t0} ms`))
      .catch((e) => console.error(`cron ${new Date(at).toISOString()} failed: ${e?.stack ?? e}`));
  }, at - now);
}
nextMinute();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await mf.dispose().catch(() => {});
    process.exit(0);
  });
}
