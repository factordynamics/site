import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { call, isPro, openPortal, type Member } from '../lib/account'
import { checkout } from '../config'
import { Button } from './ui'

// API keys: GET/POST /keys, DELETE /keys/{id} (session auth; Copy members get 403 pro_required).
type Key = { id: string; name: string; prefix: string; created: number | string; requests_today: number; usage: { day: string; requests: number }[] }

/** created arrives as unix seconds, milliseconds or an ISO string; never print Invalid Date. */
function when(c: number | string | undefined) {
  const d = typeof c === 'number' ? new Date(c < 1e12 ? c * 1000 : c) : c ? new Date(c) : null
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'just now'
}

function Spark({ usage }: { usage: Key['usage'] }) {
  const max = Math.max(1, ...usage.map((u) => u.requests))
  return (
    <span className="flex h-6 items-end gap-[2px]" aria-hidden="true">
      {usage.map((u) => (
        <span key={u.day} className="w-[3px] rounded-sm bg-accent/60" style={{ height: `${Math.max(6, (u.requests / max) * 100)}%` }} />
      ))}
    </span>
  )
}

export function ApiKeys({ member }: { member: Member }) {
  const pro = isPro(member)
  const [keys, setKeys] = useState<Key[] | null>(null)
  const [max, setMax] = useState(10)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!pro) return
    call<{ keys: Key[]; max?: number }>('/keys', { auth: true }).then(
      (r) => {
        setKeys(r.keys)
        if (r.max) setMax(r.max)
      },
      () => setKeys([]),
    )
  }, [pro])

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await call<Key & { key: string }>('/keys', { body: { name: name.trim() || 'Default' }, auth: true })
      setFresh({ key: r.key, name: r.name })
      setCopied(false)
      setName('')
      setKeys((k) => [...(k ?? []), { ...r, requests_today: r.requests_today ?? 0, usage: r.usage ?? [] }])
    } catch {
      setError('The key wasn’t created. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (k: Key) => {
    if (!confirm(`Revoke “${k.name}”? Requests using it will fail straight away.`)) return
    await call(`/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE', auth: true }).then(
      () => setKeys((l) => (l ?? []).filter((x) => x.id !== k.id)),
      () => setError('That key wasn’t revoked. Please try again.'),
    )
  }

  return (
    <section id="api-keys" className="mt-5 scroll-mt-24 rounded-[var(--radius-card)] bg-card p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">API keys</h2>
          <p className="mt-1 text-[14px] text-ink-2">
            For the <Link to="/api/" className="font-medium text-accent hover:text-accent-2">Copybook API</Link>. Each key allows 60 requests a minute and 20,000 a day.
          </p>
        </div>
        {pro && keys && <span className="text-[13px] text-ink-3">{keys.length} of {max} keys</span>}
      </div>

      {!pro ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-accent-soft px-4 py-3">
          <p className="text-[13.5px] text-accent-2">API access is part of Copy Pro. Upgrading is prorated from your current plan.</p>
          <Button
            size="sm"
            onClick={() =>
              openPortal().catch(() => {
                if (checkout.portal) window.location.href = checkout.portal
              })
            }
          >
            Upgrade to Pro
          </Button>
        </div>
      ) : (
        <>
          {fresh && (
            <div role="status" className="mt-4 rounded-xl bg-[#e6f4ec] p-4 text-[13.5px] text-[#14532d]">
              <p className="font-medium">Copy your new key “{fresh.name}” now. You won’t be able to see it again.</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-3 py-2 font-mono text-[12.5px] text-ink">{fresh.key}</code>
                <Button
                  size="sm"
                  variant="dark"
                  onClick={() => navigator.clipboard.writeText(fresh.key).then(() => setCopied(true), () => null)}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
                  Done
                </Button>
              </div>
            </div>
          )}
          {keys && keys.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-[14px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{k.name}</span>
                    <span className="block font-mono text-[12px] text-ink-3">
                      {k.prefix}… · created {when(k.created)}
                    </span>
                  </span>
                  {k.usage?.length > 0 && <Spark usage={k.usage} />}
                  <span className="num w-28 text-right text-[13px] text-ink-2">{k.requests_today.toLocaleString('en-US')} today</span>
                  <Button size="sm" variant="ghost" onClick={() => revoke(k)} className="text-down hover:text-down">
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {keys && keys.length < max && (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                create()
              }}
            >
              <label htmlFor="key-name" className="sr-only">
                Key name
              </label>
              <input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Key name, e.g. Research notebook"
                className="h-9 min-w-0 flex-1 rounded-full bg-paper px-4 text-[14px] shadow-[0_0_0_1px_var(--color-line-2)] outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_2px_var(--color-accent)]"
              />
              <Button type="submit" size="sm" className="h-9" disabled={busy}>
                {busy ? 'Creating…' : 'Create key'}
              </Button>
            </form>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[13.5px] text-down">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
