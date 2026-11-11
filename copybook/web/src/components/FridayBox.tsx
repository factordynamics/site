import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { TRIAL_DAYS } from '../config'
import { pricingTo } from '../lib/data'
import { track } from '../lib/track'
import { FollowSignup } from './FollowSignup'
import { Arrow, Button } from './ui'

// The signed-out landing box on /season/, investor pages and stock pages: the free Friday email first (one email
// field that follows `people`; `collapsed` names them with a Change link that adds `others`), "See last week's
// email", then the Copy trial below a divider as the quieter button. Post A: the trial-first box showed 151 times
// with 0 signups.
export function FridayBox({ title, people, others, collapsed = false, kind = 'investor', trial, top, className = '' }: { title: string; people: { slug: string; name: string }[]; others?: { slug: string; name: string }[]; collapsed?: boolean; kind?: 'investor' | 'stock'; trial: string; top?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-accent-soft px-4 py-3.5 text-[15px] leading-snug text-accent-2 ${className}`}>
      {top}
      <p className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</p>
      <FollowSignup people={people} others={others} collapsed={collapsed} kind={kind} cta="Get it free" label="Your email, for the free Friday email" quietLabel className="mt-3 text-[14.5px] text-ink" />
      <Link to="/weekly/" className="mt-1 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent hover:text-accent-2">
        See last week’s email <Arrow className="size-3" />
      </Link>
      <div className="mt-4 border-t border-accent/20 pt-4">
        <p className="text-[14px] text-ink-2">{trial}</p>
        <Button to={pricingTo()} variant="outline" onClick={() => track('trial_click')} className="mt-2.5 shrink-0">
          Start {TRIAL_DAYS}-day free trial
        </Button>
        <p className="mt-1.5 text-[12.5px] text-ink-3">Card required, nothing charged before day {TRIAL_DAYS + 1}.</p>
      </div>
    </div>
  )
}
