import { useState } from 'react'
import { useMember } from '../lib/account'
import { Button } from './ui'

/** The page URL to share: this page's address without tracking or someone else's referral, plus `code` as ?ref=. */
export function shareUrl(url: string, code: string | null | undefined) {
  const u = new URL(url, window.location.origin)
  for (const k of [...u.searchParams.keys()]) if (k === 'ref' || k.startsWith('utm_')) u.searchParams.delete(k)
  if (code) u.searchParams.set('ref', code)
  return u.toString()
}

/** A paying member's referral code (GET /me referral; null for seats, free and paused members). */
export function useRefCode() {
  const member = useMember()
  return member?.active ? (member.referral?.code ?? null) : null
}

export const REF_NOTE = 'Your link gives a friend a free month'

/**
 * Copy link and Post on X (and LinkedIn when `linkedin`). For a paying member every link carries their
 * referral code, and a line under the buttons says what it does. `copyOnly` where a share page sits next to it.
 */
export function Share({ url, text, linkedin = false, copyOnly = false, className = '' }: { url?: string; text?: string; linkedin?: boolean; copyOnly?: boolean; className?: string }) {
  const code = useRefCode()
  const [copied, setCopied] = useState(false)
  const link = shareUrl(url ?? window.location.href.split('#')[0], code)
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={linkedin ? 'primary' : 'outline'}
          onClick={() =>
            navigator.clipboard?.writeText(link).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }
        >
          {copied ? 'Link copied' : 'Copy link'}
        </Button>
        {!copyOnly && (
          <Button size="sm" variant="outline" href={`https://x.com/intent/post?${text ? `text=${encodeURIComponent(text)}&` : ''}url=${encodeURIComponent(link)}`}>
            Post on X
          </Button>
        )}
        {linkedin && (
          <Button size="sm" variant="outline" href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`}>
            LinkedIn
          </Button>
        )}
      </div>
      {code && <p className="text-[12px] text-ink-3">{REF_NOTE}</p>}
    </div>
  )
}
