import { Link } from 'react-router-dom'
import { Badge, Button, Panel, Skeleton } from '../components/ui'
import { ApiStatus } from '../components/ApiStatus'
import { probe, useApiBase } from '../lib/account'
import { useAsync, useTitle } from '../lib/data'
import { loadCoverage } from '../lib/stocks'

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

/** The info.description packs limits and error codes into one paragraph; split it for display. */
function parseInfo(d = '') {
  const [intro, codes = ''] = d.split(/Error codes:\s*/)
  const errors = [...codes.matchAll(/`([a-z_]+)`\s*\(([^)]*)\)/g)].map((m) => [m[1], m[2]] as const)
  const sentences = intro.split(/(?<=\.)\s+/).filter((s) => s && !/^Copy Pro only/.test(s))
  return { sentences, errors }
}

const METHOD_TONE: Record<string, 'up' | 'accent' | 'down' | 'neutral'> = { get: 'up', post: 'accent', delete: 'down' }

export function ApiDocs() {
  useTitle('API · Copybook')
  const cov = useAsync(loadCoverage, [])
  const spec = useAsync(() => fetch(SPEC).then((r) => (r.ok ? (r.json() as Promise<Spec>) : Promise.reject(new Error(String(r.status))))), [])
  const log = useAsync(loadChangelog, [])
  const s = spec.data
  // The live base from api.json, not the spec's servers entry, which names whichever host built it.
  const base = useApiBase()
  const info = parseInfo(s?.info.description)
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
          Coverage: the latest 13F for {cov.data ? cov.data.filers.toLocaleString('en-US') : 'every'} filers, the same count as /v1/filers, and 8 quarters of history for the {cov.data?.curated ?? 348} managers we track closely. Coming: the as_of parameter with per-row amendment lots by Nov 30, history back to 2013 by Dec 31, Parquet bulk files with no date yet. Use is covered by our{' '}
          <Link to="/terms/" className="font-medium text-accent hover:text-accent-2">
            terms
          </Link>
          .
        </p>
      </header>

      <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Quick start" sub={s ? `Version ${s.info.version}` : undefined}>
          <pre className="overflow-x-auto rounded-xl bg-night p-4 font-mono text-[13px] leading-relaxed text-white/90">
            <code>{`curl ${base}/v1/me \\\n  -H "Authorization: Bearer cbk_live_..."`}</code>
          </pre>
          <p className="mt-2 text-[12.5px] text-ink-3">Base URL: <code className="font-mono">{base}</code>. A dedicated api.copybook.factordynamics.com hostname is planned. Live API status: <Link to="/status/" className="text-accent hover:text-accent-2">/status/</Link>.</p>
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
              {op.description && <p className="mt-1 text-[14px] text-ink-3">{op.description}</p>}
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
                        <td className="py-2 text-ink-2">{p.description}</td>
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
