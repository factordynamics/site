// Miniflare instance for the copybook-api Worker, configured from wrangler.toml, shared by server.mjs and import.mjs.
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

export function makeMiniflare() {
  const env = process.env;
  const toml = parse(readFileSync(`${env.SITE_API_DIR}/wrangler.toml`, 'utf8'));
  const SECRETS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SESSION_SECRET', 'RESEND_API_KEY', 'HEALTH_TOKEN', 'GITHUB_DISPATCH_TOKEN', 'SEC_BUDGET', 'CF_API_TOKEN'];
  const bindings = { ...toml.vars, API_URL: env.PUBLIC_API_URL };
  for (const k of SECRETS) if (env[k]) bindings[k] = env[k];
  // The commit the bundle was built from (update.sh writes BUILD_DIR/BUILD_SHA): /health's api_build.
  const sha = env.BUILD_SHA || (existsSync(`${env.BUILD_DIR}/BUILD_SHA`) ? readFileSync(`${env.BUILD_DIR}/BUILD_SHA`, 'utf8').trim() : '');
  if (/^[0-9a-f]{7,40}$/.test(sha)) bindings.BUILD_SHA = sha;

  return new Miniflare(convertV4MiniflareOptions({
    name: toml.name,
    modules: true,
    scriptPath: `${env.BUILD_DIR}/index.js`,
    modulesRoot: env.BUILD_DIR,
    compatibilityDate: toml.compatibility_date,
    compatibilityFlags: toml.compatibility_flags ?? [],
    bindings,
    kvNamespaces: Object.fromEntries((toml.kv_namespaces ?? []).map((n) => [n.binding, n.id])),
    r2Buckets: Object.fromEntries((toml.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name])),
    durableObjects: Object.fromEntries((toml.durable_objects?.bindings ?? []).map((d) => [d.name, { className: d.class_name, useSQLite: true }])),
    resourcePersistencePath: env.STATE_DIR,
    cf: false,
    host: '127.0.0.1',
    port: 0,
    log: new Log(LogLevel.INFO),
  }));
}
