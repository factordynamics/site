import { Link } from 'react-router-dom'
import { BOOK_LITE, BOOK_PRO, plans } from '../config'
import type { Member } from '../lib/account'
import { Arrow, Button, Check, Lock } from './ui'

/** Copy → Pro, on /account/ and in My book lite: what Copy has, what Pro adds, one upgrade button. */
export function UpgradePro({ member, className = '' }: { member: Member; className?: string }) {
  const yearly = member.interval !== 'monthly'
  return (
    <section id="pro" className={`scroll-mt-24 rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6 ${className}`} aria-labelledby="pro-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 id="pro-title" className="text-[15px] font-semibold">
            Copy and Copy Pro
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">
            Pro is ${yearly ? `${plans.pro.yearly}/yr` : `${plans.pro.monthly}/mo`} at the founding price, on your {yearly ? 'yearly' : 'monthly'} billing. Upgrading is prorated for the rest of this period, and you see the amount before you confirm.
          </p>
        </div>
        <Button to="/upgrade/?plan=pro">
          Upgrade to Pro <Arrow />
        </Button>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-paper p-4">
          <p className="text-[12.5px] font-medium text-ink-3">In your Copy plan</p>
          <p className="mt-2 flex gap-2.5 text-[13.5px]">
            <Check className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="font-medium">{BOOK_LITE.t}</span>
              <span className="block text-[12.5px] text-ink-3">{BOOK_LITE.d}</span>
            </span>
          </p>
        </div>
        <div className="rounded-xl bg-accent-soft/60 p-4">
          <p className="text-[12.5px] font-medium text-accent-2">Copy Pro adds</p>
          <ul className="mt-2 space-y-2 text-[13.5px]">
            {(
              [
                [BOOK_PRO.t, BOOK_PRO.d],
                ['API keys and signed webhooks', 'Holdings for every filer, Form 4 and 13D/G as JSON, 60 requests a minute per key.'],
              ] as const
            ).map(([t, d]) => (
              <li key={t}>
                <Link to="/upgrade/?plan=pro" className="flex gap-2.5 text-left hover:text-accent-2">
                  <span className="mt-0.5 shrink-0 text-ink-3">
                    <Lock />
                  </span>
                  <span>
                    <span className="font-medium">{t}</span>
                    <span className="block text-[12.5px] text-ink-3">{d}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
