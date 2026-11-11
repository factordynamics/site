import { API_LIMITS, API_OUTAGE, API_TIMING, API_UNIVERSE, HOST_MOVE } from '../lib/hosting'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Panel, Skeleton } from '../components/ui'
import { ApiStatus } from '../components/ApiStatus'
import { Stale } from '../components/Stale'
import { probe } from '../lib/account'
import { useAsync, useTitle } from '../lib/data'
import { HISTORY_EXACT, loadCoverage } from '../lib/stocks'

// Renders the build's copy of the OpenAPI document (scripts/cards.mjs fetches {api}/v1/openapi.json), so new endpoints appear here with each build.
type Op = { summary?: string; description?: string; parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string } }[]; responses?: Record<string, { description?: string }> }
type Param = NonNullable<Op['parameters']>[number]
type Spec = {
  info: { title: string; version: string; description?: string }
  servers?: { url: string }[]
  paths: Record<string, Record<string, Op>>
  components?: { parameters?: Record<string, Param>; schemas?: Record<string, { properties?: Record<string, { description?: string }> }> }
  'x-versioning'?: { current?: string; pin_header?: string; notice_days?: number }
}

// The build's copy of the spec (scripts/cards.mjs), so the docs never depend on the API answering.
const SPEC = `${import.meta.env.BASE_URL}api/openapi.json`
const SAMPLE = `${import.meta.env.BASE_URL}api/sample-holdings.json`

// GET /v1/changelog, newest first; the build's copy (scripts/cards.mjs) when the API isn't answering.
type Change = { id?: string | null; date: string; status: string; breaking: boolean; changes: string[] }
const loadChangelog = () =>
  probe<{ data: Change[]; stale?: boolean; stale_as_of?: string }>('/v1/changelog').catch(() => fetch(`${import.meta.env.BASE_URL}api/changelog.json`).then((r) => (r.ok ? (r.json() as Promise<{ data: Change[]; stale?: boolean; stale_as_of?: string }>) : Promise.reject(new Error(String(r.status))))))

const TERM = /`([a-z_]+)`\s*\(([^)]*)\)/g
// One definition for the fields the spec defines in several places, and query parameters the glossary isn't for.
const GLOSSARY_FIX: Record<string, string | null> = {
  truncated: 'true when the full list isn’t loaded yet and a shorter public list is served instead: the top 500 positions by value for a filer’s holdings, the top 25 holders for a stock; false once the full list is in',
  limit: null,
  offset: null,
}

/** The info.description packs limits, error codes and then field notes into one string; split them for display. */
function parseInfo(d = '') {
  const [intro, rest = ''] = d.split(/Error codes:\s*/)
  // The error codes are the paragraph right after "Error codes:"; `field` (definition) pairs after it are the glossary.
  const cut = rest.search(/\n\s*\n/)
  const [codes, notes] = cut < 0 ? [rest, ''] : [rest.slice(0, cut), rest.slice(cut)]
  const errors = [...codes.matchAll(TERM)].map((m) => [m[1], m[2]] as const)
  const seen = new Map<string, string>()
  for (const m of notes.matchAll(TERM)) if (!seen.has(m[1]) && !errors.some(([c]) => c === m[1])) seen.set(m[1], m[2])
  for (const [k, v] of Object.entries(GLOSSARY_FIX)) if (v === null) seen.delete(k); else seen.set(k, v)
  const glossary = [...seen].filter(([, v]) => v !== 'additive')
  const sentences = intro.split(/(?<=\.)\s+/).filter((s) => s && !/^Copy Pro only/.test(s))
  return { sentences, errors, glossary }
}

/** The spec's titled paragraphs ("**Versioning policy.** ..."), by title. A bold run ending in a period starts a section;
 *  other bold runs ("**Copy Fund teams:**") stay inline. */
function specSections(d = '') {
  const out = new Map<string, string>()
  const marks = [...d.matchAll(/\*\*([^*]+?\.)\*\*/g)]
  marks.forEach((m, i) => out.set(m[1].replace(/\.$/, ''), d.slice(m.index! + m[0].length, marks[i + 1]?.index ?? d.length).trim()))
  return out
}
/** Spec text with its **bold** and `code` runs. */
function md(t: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((x, i) =>
    x.startsWith('**') ? (
      <strong key={i} className="font-medium text-ink">
        {x.slice(2, -2).replace(/`/g, '')}
      </strong>
    ) : x.startsWith('`') ? (
      <code key={i} className="font-mono text-[12.5px]">
        {x.slice(1, -1)}
      </code>
    ) : (
      x
    ),
  )
}

/** Display fixes for spec text that is behind the API (payments owns api/src/openapi.ts): the finished type rename and the full filer type list. */
const TYPES = 'hedge_fund, long_only, index, bank, wealth, pension, sovereign, insurance, other'
const docText = (t = '') =>
  t
    .replace(/long_only \(still `active` in some rows during ingest's rename; the two match each other in `type=`\), index, bank, wealth, pension, sovereign, insurance, other/, TYPES)
    .replace(/ \(or `hedge_fund,active`\)/, '')
    .replace(/long_only \(or active\)/, 'long_only')
    .replace(/\(hedge_fund, active, index, bank, wealth, pension, other\)/, `(${TYPES})`)
    .replace(/true while only the public top-500 shard is available for a filer/, GLOSSARY_FIX.truncated!)

/** Quick-start calls: who am I, a filer's latest book, and every 13F holder of a stock. */
const examples = (base: string, parquet: boolean) => ({
  curl: `# Your key and plan
curl ${base}/v1/me \\
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"

# A filer's latest 13F book (slug or CIK)
curl --compressed \\
  ${base}/v1/filers/warren-buffett/holdings/latest \\
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"

# Every 13F holder of a stock, largest first
curl --compressed \\
  "${base}/v1/stocks/AAPL/holders?type=hedge_fund,long_only&limit=100" \\
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"

# A whole quarter as one gzip CSV; check it against the sha256 in /v1/bulk
curl ${base}/v1/bulk -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"
curl -L -o 2026Q3.csv.gz ${base}/v1/bulk/2026Q3.csv.gz \\
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"
shasum -a 256 2026Q3.csv.gz${
    parquet
      ? `

# The same rows as Parquet (sha256 in /v1/bulk too)
curl -L -o 2026Q3.parquet ${base}/v1/bulk/2026Q3.parquet \\
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"`
      : ''
  }`,
  python: `import requests

API = "${base}"
s = requests.Session()
s.headers["Authorization"] = "Bearer cbk_live_..."
s.headers["User-Agent"] = "my-research/1.0"

# A filer's latest 13F book (slug or CIK)
r = s.get(f"{API}/v1/filers/warren-buffett/holdings/latest", timeout=60)
book = r.json()["data"]
print(book["quarter"], book["filing"]["accepted_at"])
for h in book["holdings"][:10]:
    print(h["ticker"], h["value_usd"], h["weight"], h["change"])

# Every 13F holder of a stock, largest first
params = {"type": "hedge_fund,long_only", "limit": 100}
r = s.get(f"{API}/v1/stocks/AAPL/holders", params=params, timeout=60)
for row in r.json()["data"]["holders"]:
    print(row["filer"]["name"], row["period"], row["value_usd"], row["change"])

# A whole quarter as one gzip CSV, checked against the sha256 in /v1/bulk
# (requests drops Authorization on the redirect to the presigned link)
import hashlib
files = {f["file"]: f for f in s.get(f"{API}/v1/bulk", timeout=60).json()["data"]}
h = hashlib.sha256()
with s.get(f"{API}/v1/bulk/2026Q3.csv.gz", stream=True, timeout=300) as r, open("2026Q3.csv.gz", "wb") as out:
    r.raise_for_status()
    for chunk in r.iter_content(1 << 20):
        h.update(chunk)
        out.write(chunk)
assert h.hexdigest() == files["2026Q3.csv.gz"]["sha256"]`,
  urllib: `import hashlib, json, urllib.request

API = "${base}"
KEY = {"Authorization": "Bearer cbk_live_...", "User-Agent": "my-research/1.0"}

def get(url, headers):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=300)

# urllib forwards Authorization on a redirect, which the presigned link refuses,
# so ask for the link as JSON with redirect=false
link = json.load(get(f"{API}/v1/bulk/2026Q3.csv.gz?redirect=false", KEY))["data"]
# auth "none": a presigned link, valid 300 s, that takes no Authorization
headers = KEY if link["auth"] == "required" else {"User-Agent": KEY["User-Agent"]}
h = hashlib.sha256()
with get(link["url"], headers) as r, open("2026Q3.csv.gz", "wb") as out:
    for chunk in iter(lambda: r.read(1 << 20), b""):
        h.update(chunk)
        out.write(chunk)
assert h.hexdigest() == link["sha256"]`,
})

const METHOD_TONE: Record<string, 'up' | 'accent' | 'down' | 'neutral'> = { get: 'up', post: 'accent', delete: 'down' }

export function ApiDocs() {
  useTitle('API · Copybook')
  const cov = useAsync(loadCoverage, [])
  const spec = useAsync(() => fetch(SPEC).then((r) => (r.ok ? (r.json() as Promise<Spec>) : Promise.reject(new Error(String(r.status))))), [])
  const log = useAsync(loadChangelog, [])
  const s = spec.data
  // The published /v1 base (api.config.mjs API_DOCS_BASE), never the quick tunnel member pages use.
  const base = import.meta.env.VITE_API_DOCS_BASE as string
  const info = parseInfo(s?.info.description)
  const sections = specSections(s?.info.description)
  const xv = s?.['x-versioning']
  // Bulk files the spec says the API serves (csv.gz, and parquet once its pattern lists it).
  const parquet = /parquet/.test(JSON.stringify(s?.paths['/v1/bulk/{file}'] ?? ''))
  // Fields on every response, errors included: the spec's Error envelope without `error`.
  const envelopeFields = Object.entries(s?.components?.schemas?.Error?.properties ?? {}).filter(([k]) => k !== 'error')
  const versioning = [...sections].filter(([t]) => /^(Versioning|Share classes|Weight)/.test(t))
  const announced = (log.data?.data ?? []).filter((c) => c.status === 'announced')
  const [lang, setLang] = useState<'curl' | 'python' | 'urllib'>('curl')
  // Parameters are often $refs into components.parameters; resolve them so the table has names.
  const resolve = (x: Param | { $ref?: string }): Param | null => {
    const ref = (x as { $ref?: string }).$ref
    return ref ? (s?.components?.parameters?.[ref.split('/').pop()!] ?? null) : (x as Param)
  }
  const ops = s
    ? Object.entries(s.paths).flatMap(([path, m]) =>
        Object.entries(m)
          .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
          .map(([method, op]) => ({ path, method, op: { ...op, parameters: (op.parameters ?? []).map(resolve).filter((x): x is Param => Boolean(x?.name)) } })),
      )
    : []
  return (
    <div className="container-x pt-12 md:pt-16">
      <ApiStatus className="mb-6 max-w-3xl" />
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Copybook API · Copy Pro and Copy Fund</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">13F, Form 4 and 13D/G data, as JSON.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">The same SEC EDGAR data behind every Copybook page, for your own models and tools. Create a key on your account page and send it as a Bearer token.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button to="/account/#api-keys">Create an API key</Button>
          <Button href={SPEC} variant="outline">
            OpenAPI spec
          </Button>
          <Button href={SAMPLE} variant="outline">
            Sample response
          </Button>
        </div>
        <p className="mt-4 text-[14px] text-ink-3">
          Coverage: {cov.data ? cov.data.filers.toLocaleString('en-US') : 'every'} filers, the same count as /v1/filers. History: {HISTORY_EXACT} (<Link to="/methodology/#coverage" className="font-medium text-accent hover:text-accent-2">coverage</Link>). Bulk files: a gzip CSV per quarter{parquet ? ', and Parquet with the same columns, built from each quarter’s CSV (sha256 in /v1/bulk)' : ''}.{announced.length > 0 && <> {announced.length} announced changes are listed under <a href="#versioning" className="font-medium text-accent hover:text-accent-2">versioning</a>.</>} Use is covered by our{' '}
          <Link to="/terms/" className="font-medium text-accent hover:text-accent-2">
            terms
          </Link>
          .
        </p>
      </header>

      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Quick start" sub={s ? `Version ${s.info.version}` : undefined}>
          <div role="tablist" aria-label="Example language" className="mb-2 flex gap-1 text-[13px]">
            {(['curl', 'python', 'urllib'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={lang === k} onClick={() => setLang(k)} className={`rounded-lg px-3 py-1.5 font-medium ${lang === k ? 'bg-night text-white' : 'text-ink-2 hover:bg-line/60'}`}>
                {{ curl: 'curl', python: 'Python requests', urllib: 'Python urllib' }[k]}
              </button>
            ))}
          </div>
          <pre className="overflow-x-auto rounded-xl bg-night p-4 font-mono text-[12.5px] leading-relaxed text-white/90">
            <code>{examples(base, parquet)[lang]}</code>
          </pre>
          <p className="mt-2 text-[12.5px] text-ink-3">Base URL: <code className="font-mono">{base}</code>. {HOST_MOVE} {API_OUTAGE} Live API status: <Link to="/status/" className="text-accent hover:text-accent-2">/status/</Link>.</p>
          <p className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed text-accent-2">
            <strong className="font-medium">Send a descriptive User-Agent</strong> that names your app, such as <code className="font-mono text-[12.5px]">my-research/1.0</code>.
          </p>
          <ul className="mt-3 space-y-1.5 text-[13.5px] leading-relaxed text-ink-2">
            <li><strong className="font-medium text-ink">Timing.</strong> {API_TIMING}</li>
            <li><strong className="font-medium text-ink">Rate limits.</strong> {API_LIMITS}</li>
            <li><strong className="font-medium text-ink">Whole universe.</strong> {API_UNIVERSE}</li>
          </ul>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">
            <strong className="font-medium text-ink">Holders CSV</strong> (<code className="font-mono text-[12.5px]">/stocks/{'{ticker}'}/holders.csv</code>) matches <code className="font-mono text-[12.5px]">/v1</code> holders: share (SH) positions by default. Add <code className="font-mono text-[12.5px]">?include=options,exited</code> for call and put rows and exits; the <code className="font-mono text-[12.5px]">kind</code> column (equity, calls, puts) and <code className="font-mono text-[12.5px]">change</code> say which, and the <code className="font-mono text-[12.5px]">x-copybook-rows</code> response header lists what’s included. An unknown <code className="font-mono text-[12.5px]">include</code> value returns 400. A 503 busy reply carries <code className="font-mono text-[12.5px]">Retry-After</code>.
          </p>
          {s ? (
            <ul className="mt-5 space-y-2 text-[14px] leading-relaxed text-ink-2">
              {info.sentences.map((x) => (
                <li key={x}>{x.replace(/`/g, '')}</li>
              ))}
            </ul>
          ) : (
            <Skeleton className="mt-5 h-20 w-full" />
          )}
        </Panel>
        <div className="flex flex-col gap-6">
        <Panel title="Errors" sub="Every error response is JSON with one of these codes">
          {s ? (
            <dl className="divide-y divide-line text-[13.5px]">
              {info.errors.map(([code, what]) => (
                <div key={code} className="flex gap-4 py-2">
                  <dt className="w-40 shrink-0 font-mono text-[12.5px] text-ink">{code}</dt>
                  <dd className="text-ink-2">{what}</dd>
                </div>
              ))}
            </dl>
          ) : spec.error ? (
            <p className="text-[14px] text-ink-2">The spec didn’t load. Open it directly with the button above.</p>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </Panel>
        {s && (envelopeFields.length > 0 || xv?.pin_header) && (
          <Panel title="Every response" sub="On successes and errors alike, generated from the spec">
            <dl className="divide-y divide-line text-[13.5px]">
              {envelopeFields.map(([field, f]) => (
                <div key={field} className="flex gap-4 py-2">
                  <dt className="w-40 shrink-0 font-mono text-[12.5px] text-ink">{field}</dt>
                  <dd className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">{md(f.description ?? '')}</dd>
                </div>
              ))}
              {xv?.pin_header && (
                <div className="flex gap-4 py-2">
                  <dt className="w-40 shrink-0 font-mono text-[12.5px] text-ink [overflow-wrap:anywhere]">{xv.pin_header}</dt>
                  <dd className="min-w-0 text-ink-2">Response header: the schema served, your pin when valid, otherwise the default{xv.current ? ` (${xv.current})` : ''}. See versioning.</dd>
                </div>
              )}
            </dl>
          </Panel>
        )}
        {info.glossary.length > 0 && (
          <Panel title="Field glossary" sub="Response fields that need more than their name">
            <dl className="divide-y divide-line text-[13.5px]">
              {info.glossary.map(([field, what]) => (
                <div key={field} className="flex gap-4 py-2">
                  <dt className="w-40 shrink-0 font-mono text-[12.5px] text-ink">{field}</dt>
                  <dd className="text-ink-2">{what.replace(/`/g, '')}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        )}
        </div>
      </div>

      <section className="mt-6" aria-labelledby="endpoints">
        <h2 id="endpoints" className="text-[22px] font-semibold tracking-[-0.02em]">
          Endpoints
        </h2>
        <p className="mt-1 text-[14px] text-ink-3">From the OpenAPI spec; a new endpoint appears here when it ships. The changelog below says what changed.</p>
        <div className="mt-4 space-y-4">
          {!s && !spec.error && <Skeleton className="h-32 w-full" />}
          {ops.map(({ path, method, op }) => (
            <Panel key={`${method} ${path}`}>
              <p className="flex flex-wrap items-center gap-2.5">
                <Badge tone={METHOD_TONE[method] ?? 'neutral'}>{method.toUpperCase()}</Badge>
                <code className="font-mono text-[14px] font-medium">{path}</code>
              </p>
              {op.summary && <p className="mt-2 text-[14.5px] text-ink-2">{op.summary}</p>}
              {op.description && <p className="mt-1 text-[14px] text-ink-3">{docText(op.description)}</p>}
              {op.parameters?.length ? (
                <table className="mt-4 w-full text-[13.5px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[12px] text-ink-3">
                      <th className="py-2 pr-3 font-medium">Parameter</th>
                      <th className="py-2 pr-3 font-medium">In</th>
                      <th className="py-2 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {op.parameters.map((p) => (
                      <tr key={p.name} className="border-b border-line last:border-0">
                        <td className="py-2 pr-3 font-mono text-[12.5px] [overflow-wrap:anywhere]">
                          {p.name}
                          {p.required && <span className="text-down">*</span>}
                        </td>
                        <td className="py-2 pr-3 text-ink-3">{p.in}</td>
                        <td className="py-2 text-ink-2 [overflow-wrap:anywhere]">{docText(p.description)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {op.responses && (
                <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
                  {Object.entries(op.responses).map(([code, r]) => (
                    <span key={code}>
                      <span className={`num font-medium ${code.startsWith('2') ? 'text-up' : 'text-ink-2'}`}>{code}</span> {r.description}
                    </span>
                  ))}
                </p>
              )}
            </Panel>
          ))}
        </div>
      </section>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
        <section id="versioning" className="scroll-mt-24">
          <Panel title="Versioning" sub={xv?.current ? `Current schema ${xv.current}${xv.pin_header ? ` · pin one with ${xv.pin_header}` : ''}${xv.notice_days ? ` · ${xv.notice_days} days’ notice before a breaking change` : ''}` : 'How the API changes'}>
            {s ? (
              <div className="space-y-3 text-[14px] leading-relaxed text-ink-2">
                {versioning.map(([title, text]) => (
                  <p key={title}>
                    <strong className="font-medium text-ink">{title}.</strong> {md(text)}
                  </p>
                ))}
              </div>
            ) : spec.error ? (
              <p className="text-[14px] text-ink-2">The spec didn’t load. Open it directly with the button above.</p>
            ) : (
              <Skeleton className="h-32 w-full" />
            )}
            {announced.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="text-[13px] font-medium text-ink">Announced, not live yet</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-ink-2">
                  {announced.map((c, i) => (
                    <li key={c.id ?? `${c.date}-${i}`}>
                      <span className="num text-ink-3">{c.date}</span> {md(c.changes[0] ?? '')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        </section>
        <section id="changelog" className="scroll-mt-24">
          <Panel title="API changelog" sub="Newest first">
            <Stale asOf={log.data?.stale ? log.data.stale_as_of : null} onRetry={log.retry} className="mb-3" />
            {log.data ? (
              <ol className="divide-y divide-line text-[14px]">
                {log.data.data.map((c, i) => (
                  <li key={c.id ?? `${c.date}-${i}`} className="py-3 first:pt-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="num text-ink-3">{c.date}</span>
                      {c.status !== 'shipped' && <Badge tone="neutral">{c.status === 'announced' ? 'Not live yet' : c.status}</Badge>}
                      {c.breaking && <Badge tone="down">Breaking</Badge>}
                    </p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-ink-2">
                      {c.changes.map((x) => (
                        <li key={x}>{x.replace(/`/g, '')}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            ) : log.error ? (
              <p className="text-[14px] text-ink-2">The changelog didn’t load. Reload the page to try again.</p>
            ) : (
              <Skeleton className="h-32 w-full" />
            )}
          </Panel>
        </section>
      </div>

      <p className="mt-10 text-[14px] text-ink-3">
        The API is included with <Link to="/pricing/" className="font-medium text-accent hover:text-accent-2">Copy Pro and Copy Fund</Link>. How the data is built is on the{' '}
        <Link to="/methodology/" className="font-medium text-accent hover:text-accent-2">
          methodology page
        </Link>
        ; the gates every publish passes, and the lines they hold, are on{' '}
        <Link to="/data-quality/" className="font-medium text-accent hover:text-accent-2">
          data quality
        </Link>
        .
      </p>
    </div>
  )
}
