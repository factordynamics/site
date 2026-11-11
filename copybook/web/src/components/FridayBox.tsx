import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TRIAL_DAYS, TRIAL_LINE } from '../config'
import { pricingTo } from '../lib/data'
import { track } from '../lib/track'
import { referredCheckout } from '../lib/attribution'
import { FollowSignup } from './FollowSignup'
import { Arrow, Button } from './ui'

// The signed-out landing box on /season/, investor pages and stock pages: the free Friday email first (one email
// field that follows `people`; `collapsed` names them with a Change link that adds `others`), "See last week's
// email", then the Copy trial below a divider as the quieter button. Post A: the trial-first box showed 151 times
// with 0 signups.
// The free Friday email's default follows on /season/ and home: names a newcomer knows, changeable before signing up.
export const FAMOUS = [
  { slug: 'warren-buffett', name: 'Berkshire Hathaway (Warren Buffett)' },
  { slug: 'bill-ackman', name: 'Bill Ackman' },
  { slug: 'stanley-druckenmiller', name: 'Stanley Druckenmiller' },
  { slug: 'seth-klarman', name: 'Seth Klarman' },
]

export function FridayBox({ title, people, others, collapsed = false, kind = 'investor', trial, checkout, top, after, className = '' }: { title: string; people: { slug: string; name: string }[]; others?: { slug: string; name: string }[]; collapsed?: boolean; kind?: 'investor' | 'stock'; trial: ReactNode; checkout?: string; top?: ReactNode; after?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-accent-soft px-4 py-3.5 text-[15px] leading-snug text-accent-2 ${className}`}>
      {top}
      <p className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</p>
      <FollowSignup people={people} others={others} collapsed={collapsed} kind={kind} cta="Get it free" label="Your email, for the free Friday email" quietLabel className="mt-3 text-[14.5px] text-ink" />
      <Link to="/weekly/" className="mt-1 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent hover:text-accent-2">
        See a sample email <Arrow className="size-3" />
      </Link>
      <div className="mt-4 border-t border-accent/20 pt-4">
        <p className="text-[14px] text-ink-2">{trial}</p>
        {/* One solid button per box: the free email's. The trial stays outline (retail, Nov 11). */}
        {/* `checkout`: a Payment Link to open directly (/season/), skipping /pricing/. */}
        <Button {...(checkout ? { href: checkout, onClick: referredCheckout('copy', 'monthly', checkout) } : { to: pricingTo(), onClick: () => track('trial_click') })} variant="outline" className="mt-2.5 shrink-0">
          Start {TRIAL_DAYS}-day free trial
        </Button>
        <p className="mt-1.5 text-[12.5px] text-ink-3">{TRIAL_LINE}</p>
        {after}
      </div>
    </div>
  )
}
