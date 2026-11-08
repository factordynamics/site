import { Link } from 'react-router-dom'
import { Badge, Button, Panel, Skeleton } from '../components/ui'
import { api } from '../config'
import { useAsync, useTitle } from '../lib/data'

// Renders the live OpenAPI document ({api}/v1/openapi.json), so new endpoints appear here as the API ships them.
type Op = { summary?: string; description?: string; parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string } }[]; responses?: Record<string, { description?: string }> }
type Param = NonNullable<Op['parameters']>[number]
type Spec = { info: { title: string; version: string; description?: string }; servers?: { url: string }[]; paths: Record<string, Record<string, Op>>; components?: { parameters?: Record<string, Param> } }

const SPEC = `${api}/v1/openapi.json`

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
  const spec = useAsync(() => fetch(SPEC).then((r) => (r.ok ? (r.json() as Promise<Spec>) : Promise.reject(new Error(String(r.status))))), [])
  const s = spec.data
  const base = s?.servers?.[0]?.url ?? api
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
      <header className="max-w-2xl">
        <p className="text-[13px] font-medium text-accent">Copybook API · Copy Pro and Copy Fund</p>
        <h1 className="mt-3 text-[38px] font-semibold leading-[1.05] tracking-[-0.04em] md:text-h1">13F, Form 4 and 13D/G data, as JSON.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-2">The same SEC EDGAR data behind every Copybook page, for your own models and tools. Create a key on your account page and send it as a Bearer token.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button to="/account/#api-keys">Create an API key</Button>
          <Button href={SPEC} variant="outline">
            OpenAPI spec
          </Button>
        </div>
      </header>

      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Quick start" sub={s ? `Version ${s.info.version}` : undefined}>
          <pre className="overflow-x-auto rounded-xl bg-night p-4 font-mono text-[13px] leading-relaxed text-white/90">
            <code>{`curl ${base}/v1/me \\\n  -H "Authorization: Bearer cbk_live_..."`}</code>
          </pre>
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
        <p className="mt-1 text-[14px] text-ink-3">Read live from the spec. Holdings, history, events and bulk export endpoints are rolling out this month and appear here as each ships.</p>
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
