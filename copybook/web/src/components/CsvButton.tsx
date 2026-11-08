import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, downloadCsv } from '../lib/account'
import { Button } from './ui'

/** Fetches a single-use download link on click. 401 sends to sign-in, 402 to pricing. */
export function CsvButton({ slug, label = 'Download CSV', variant = 'dark', className }: { slug: string; label?: string; variant?: 'dark' | 'outline'; className?: string }) {
  const [busy, setBusy] = useState(false)
  const nav = useNavigate()
  return (
    <Button
      variant={variant}
      size="sm"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        downloadCsv(slug)
          .catch((e) => {
            if (e instanceof ApiError && e.status === 401) nav('/account/')
            else if (e instanceof ApiError && e.status === 402) nav('/pricing/')
            else alert('The download didn’t start. Please try again.')
          })
          .finally(() => setBusy(false))
      }}
    >
      {busy ? 'Preparing…' : label}
    </Button>
  )
}
