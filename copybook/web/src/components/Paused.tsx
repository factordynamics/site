import { useState } from 'react'
import { ApiError, fetchMe, resumePlan, type Member } from '../lib/account'
import { Arrow, Button } from './ui'

// A YYYY-MM-DD day as given; a unix time (paused_until) on New York's calendar, like the 13F deadlines.
export const dayLabel = (v: string | number) => new Date(typeof v === 'number' ? v * 1000 : v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'UTC' : 'America/New_York' })

/** Paused (Stripe pause_collection): no charges or alerts until the date; follows and settings stay. */
export function Paused({ until, digest, onChange }: { until: number; digest: boolean; onChange: (m: Member) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  return (
    <div className="mt-4">
      <p className="rounded-xl bg-[#fdf3e1] px-3.5 py-2.5 text-[14px] text-[#7a4b06]">
        <span className="font-medium">Paused until {dayLabel(until)}</span> · No charges and no real-time alerts until then.{digest ? ' The weekly digest of your names keeps coming, and your' : ' Your'} follows and settings are kept.
      </p>
      <Button
        variant="dark"
        className="mt-4"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setErr('')
          try {
            await resumePlan()
            onChange(await fetchMe())
          } catch (e) {
            setErr(e instanceof ApiError && e.detail ? e.detail : 'That didn’t go through. Please try again.')
          }
          setBusy(false)
        }}
      >
        {busy ? 'Resuming…' : 'Resume now'} <Arrow />
      </Button>
      {err && <p role="alert" className="mt-2 text-[13px] text-down">{err}</p>}
    </div>
  )
}

