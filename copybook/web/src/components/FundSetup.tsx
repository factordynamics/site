import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { call, type Member } from '../lib/account'
import { useFollows } from '../lib/follows'
import { Button, Check } from './ui'

// First-run setup for Copy Fund: invite seats, bring in the book, pick peers, connect Slack.
// Each step's state comes from the API, so the list stays right after edits made elsewhere;
// Team and Channels announce changes with the 'copybook:setup' event.
const KEY = 'copybook.fundSetupHidden'

export function FundSetup({ member, welcome }: { member: Member; welcome?: boolean }) {
  const { follows, status } = useFollows()
  const owner = !member.seat
  const [seats, setSeats] = useState<number | null>(null)
  const [slack, setSlack] = useState<boolean | null>(null)
  const [hidden, setHidden] = useState(() => !welcome && localStorage.getItem(KEY) === '1')

  const load = useCallback(() => {
    if (owner) call<{ seats: unknown[] }>('/seats', { auth: true }).then((r) => setSeats(r.seats.length), () => setSeats(null))
    call<{ channels: { slack: string | null } }>('/channels', { auth: true }).then((r) => setSlack(Boolean(r.channels.slack)), () => setSlack(null))
  }, [owner])
  useEffect(() => {
    load()
    window.addEventListener('copybook:setup', load)
    return () => window.removeEventListener('copybook:setup', load)
  }, [load])

  type Act = { label: string; to?: string; href?: string }
  const steps: { done: boolean; title: string; body: ReactNode; act: Act; alt?: Act }[] = [
    ...(owner
      ? [
          {
            done: Boolean(seats),
            title: 'Invite your team',
            body: seats ? `${seats} of 5 seats invited. Each colleague signs in with their own email.` : 'Up to 5 colleagues, each with their own sign-in and alert settings.',
            act: { label: seats ? 'Manage seats' : 'Invite seats', href: '#team' },
          },
        ]
      : []),
    {
      done: Boolean(follows.book || follows.owned.length),
      title: 'Bring in your book',
      body: follows.book
        ? `Linked to ${follows.book.name}’s 13F (${follows.book.tickers.length} names). It updates each time it files.`
        : follows.owned.length
          ? `${follows.owned.length} owned ${follows.owned.length === 1 ? 'name' : 'names'}. Link your fund’s 13F to keep it in step with each filing.`
          : 'Paste tickers or a broker CSV, or link your fund’s own 13F so it updates with each filing.',
      act: { label: follows.owned.length ? 'Edit book' : 'Import', to: '/my-book/#book-import' },
      alt: follows.book ? undefined : { label: 'Link your 13F', to: '/my-book/#link-fund' },
    },
    {
      done: follows.peers.length > 0,
      title: 'Pick your peers',
      body: follows.peers.length ? `${follows.peers.length} ${follows.peers.length === 1 ? 'peer' : 'peers'}. See where your book overlaps theirs.` : 'Funds you benchmark against, to see where your books overlap.',
      act: { label: follows.peers.length ? 'Edit peers' : 'Pick peers', to: '/my-book/#peers' },
    },
    {
      done: Boolean(slack),
      title: 'Connect Slack',
      body: slack ? 'Alerts post to your Slack channel as they happen.' : 'Post every alert to a team channel as it happens.',
      act: { label: slack ? 'Slack settings' : 'Connect Slack', href: '#channels' },
    },
  ]
  const left = steps.filter((s) => !s.done).length
  const next = steps.findIndex((s) => !s.done)
  if (status !== 'ready' || hidden || (!left && !welcome)) return null

  return (
    <section className="mt-10 rounded-[18px] bg-card p-6 shadow-[var(--shadow-card)] md:p-8" aria-labelledby="fund-setup-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-accent">Set up Copy Fund · {left ? `${steps.length - left} of ${steps.length} done` : 'all set'}</p>
          <h2 id="fund-setup-title" className="mt-2 text-[26px] font-semibold tracking-[-0.03em]">
            {owner ? 'Get your team running.' : 'Your team’s setup.'}
          </h2>
          {!owner && <p className="mt-1.5 text-[15px] text-ink-2">The book and peers are shared with your team; Slack is yours to connect.</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(KEY, '1')
            setHidden(true)
          }}
          className="text-[13px] text-ink-3 hover:text-ink"
        >
          Hide
        </button>
      </div>
      <ol className="mt-6 divide-y divide-line">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
            <span
              className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${s.done ? 'bg-up text-white' : 'text-ink-2 shadow-[0_0_0_1px_var(--color-line-2)]'}`}
              aria-label={s.done ? 'Done' : `Step ${i + 1}`}
            >
              {s.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1 basis-60">
              <span className={`block text-[15px] font-medium ${s.done ? 'text-ink-2' : ''}`}>{s.title}</span>
              <span className="mt-0.5 block text-[13.5px] text-ink-2">{s.body}</span>
            </span>
            <span className="flex shrink-0 flex-wrap gap-2">
              {s.alt && (
                <Button size="sm" variant="ghost" to={s.alt.to} href={s.alt.href}>
                  {s.alt.label}
                </Button>
              )}
              <Button size="sm" variant={i === next ? 'primary' : 'outline'} to={s.act.to} href={s.act.href}>
                {s.act.label}
              </Button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
