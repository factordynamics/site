import { API_OUTAGE, HOST_MOVE } from '../lib/hosting'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Panel, Skeleton } from '../components/ui'
import { ApiStatus } from '../components/ApiStatus'
import { probe } from '../lib/account'
import { useAsync, useTitle } from '../lib/data'
import { HISTORY_EXACT, loadCoverage } from '../lib/stocks'

// Renders the build's copy of the OpenAPI document (scripts/cards.mjs fetches {api}/v1/openapi.json), so new endpoints appear here with each build.
type Op = { summary?: string; description?: string; parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string } }[]; responses?: Record<string, { description?: string }> }
type Param = NonNullable<Op['parameters']>[number]
type Spec = { info: { title: string; version: string; description?: string }; servers?: { url: string }[]; paths: Record<string, Record<string, Op>>; components?: { parameters?: Record<string, Param> } }

// The build's copy of the spec (scripts/cards.mjs), so the docs never depend on the API answering.
const SPEC = `${import.meta.env.BASE_URL}api/openapi.json`
const SAMPLE = `${import.meta.env.BASE_URL}api/sample-holdings.json`

// GET /v1/changelog, newest first; the build's copy (scripts/cards.mjs) when the API isn't answering.
type Change = { id?: string | null; date: string; status: string; breaking: boolean; changes: string[] }
const loadChangelog = () =>
  probe<{ data: Change[] }>('/v1/changelog').catch(() => fetch(`${import.meta.env.BASE_URL}api/changelog.json`).then((r) => (r.ok ? (r.json() as Promise<{ data: Change[] }>) : Promise.reject(new Error(String(r.status))))))

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
const examples = (base: string) => ({
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
  -H "Authorization: Bearer cbk_live_..." -A "my-research/1.0"`,
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
    print(row["filer"]["name"], row["period"], row["value_usd"], row["change"])`,
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
  const [lang, setLang] = useState<'curl' | 'python'>('curl')
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
          Coverage: {cov.data ? cov.data.filers.toLocaleString('en-US') : 'every'} filers, the same count as /v1/filers. History: {HISTORY_EXACT} (<Link to="/methodology/#coverage" className="font-medium text-accent hover:text-accent-2">coverage</Link>). Coming: the as_of parameter with per-row amendment lots by Nov 30, Parquet bulk files with no date yet. Use is covered by our{' '}
          <Link to="/terms/" className="font-medium text-accent hover:text-accent-2">
            terms
          </Link>
          .
        </p>
      </header>

      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Quick start" sub={s ? `Version ${s.info.version}` : undefined}>
          <div role="tablist" aria-label="Example language" className="mb-2 flex gap-1 text-[13px]">
            {(['curl', 'python'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={lang === k} onClick={() => setLang(k)} className={`rounded-lg px-3 py-1.5 font-medium ${lang === k ? 'bg-night text-white' : 'text-ink-2 hover:bg-line/60'}`}>
                {k === 'curl' ? 'curl' : 'Python requests'}
              </button>
            ))}
          </div>
          <pre className="overflow-x-auto rounded-xl bg-night p-4 font-mono text-[12.5px] leading-relaxed text-white/90">
            <code>{examples(base)[lang]}</code>
          </pre>
          <p className="mt-2 text-[12.5px] text-ink-3">Base URL: <code className="font-mono">{base}</code>. {HOST_MOVE} {API_OUTAGE} Live API status: <Link to="/status/" className="text-accent hover:text-accent-2">/status/</Link>.</p>
          <p className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-[13.5px] leading-relaxed text-accent-2">
            <strong className="font-medium">Send a descriptive User-Agent</strong> that names your app, such as <code className="font-mono text-[12.5px]">my-research/1.0</code>. Full books for the largest filers (T. Rowe Price, Millennium) can take 15–25 s; use the bulk files for whole-universe pulls.
          </p>
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
                        <td className="py-2 pr-3 font-mono text-[12.5px]">
                          {p.name}
                          {p.required && <span className="text-down">*</span>}
                        </td>
                        <td className="py-2 pr-3 text-ink-3">{p.in}</td>
                        <td className="py-2 text-ink-2">{docText(p.description)}</td>
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
        <Panel title="Versioning" sub="How the API changes">
          <ul className="list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-ink-2">
            <li>All endpoints live under /v1. Every response carries <code className="font-mono text-[12.5px]">schema_version</code>, the date of the spec it follows.</li>
            <li>Additive changes, such as new fields, endpoints or optional parameters, ship at any time. Ignore fields you don’t know.</li>
            <li>Breaking changes are announced in the changelog at least 90 days before they take effect, for every paying key.</li>
            <li><code className="font-mono text-[12.5px]">weight</code> keeps its current meaning until Feb 8, 2027. <code className="font-mono text-[12.5px]">weight_equity</code> is the stable equity-only field, and <code className="font-mono text-[12.5px]">weight_incl_options</code> the explicit name for today’s meaning.</li>
          </ul>
        </Panel>
        <section id="changelog" className="scroll-mt-24">
          <Panel title="API changelog" sub="Newest first">
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
        .
      </p>
    </div>
  )
}
