import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, downloadCsv } from '../lib/account'
import { CopyFeature } from './Signup'
import { Button } from './ui'

/** Fetches a single-use download link on click. 401 sends to sign-in; a 402 says it's a Copy feature. */
export function CsvButton({ slug, download, label = 'Download CSV', variant = 'dark', className }: { slug?: string; download?: () => Promise<unknown>; label?: string; variant?: 'dark' | 'outline'; className?: string }) {
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  const [paid, setPaid] = useState(false)
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
    <Button
      variant={variant}
      size="sm"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        ;(download ? download() : downloadCsv(slug!))
          .catch((e) => {
            if (e instanceof ApiError && e.status === 401) nav('/account/')
            else if (e instanceof ApiError && e.status === 402) setPaid(true)
            else alert('The download didn’t start. Please try again.')
          })
          .finally(() => setBusy(false))
      }}
    >
      {busy ? 'Preparing…' : label}
    </Button>
    {paid && <CopyFeature what="CSV export" />}
    </span>
  )
}
