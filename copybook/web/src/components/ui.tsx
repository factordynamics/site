import { Component, type MouseEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { initials } from '../lib/data'

export function Mark({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect x="1.5" y="5" width="14" height="17.5" rx="3.2" fill="#0c0e13" />
      <rect x="8" y="1.5" width="14.5" height="17.5" rx="3.2" fill="#2b44d6" stroke="#fbfaf7" strokeWidth="1.4" />
      <rect x="11" y="6" width="8.5" height="1.8" rx=".9" fill="#fff" />
      <rect x="11" y="9.6" width="6" height="1.8" rx=".9" fill="#fff" opacity=".85" />
      <rect x="11" y="13.2" width="3.6" height="1.8" rx=".9" fill="#fff" opacity=".7" />
    </svg>
  )
}

export function Wordmark({ className = '', dark = false }: { className?: string; dark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark />
      <span className={`text-[17px] font-semibold tracking-[-0.035em] ${dark ? 'text-white' : 'text-ink'}`}>Copybook</span>
    </span>
  )
}

type BtnProps = {
  children: ReactNode
  to?: string
  href?: string
  variant?: 'primary' | 'dark' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  onClick?: (e: MouseEvent<HTMLElement>) => void
  type?: 'button' | 'submit'
  disabled?: boolean
}

export function Button({ children, to, href, variant = 'primary', size = 'md', className = '', onClick, type = 'button', disabled }: BtnProps) {
  const base =
    'inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap rounded-full transition-[background,box-shadow,transform,color] duration-150 active:scale-[0.98] disabled:opacity-60 disabled:pointer-events-none'
  const sizes = { sm: 'h-8 px-3.5 text-[13px]', md: 'h-10 px-4.5 text-sm', lg: 'h-12 px-6 text-[15px]' }
  const variants = {
    primary: 'bg-accent text-white hover:bg-accent-2 shadow-[0_1px_0_rgb(255_255_255/0.2)_inset,0_1px_2px_rgb(12_14_19/0.2)]',
    dark: 'bg-ink text-white hover:bg-ink-2',
    ghost: 'text-ink-2 hover:text-ink hover:bg-ink/5',
    outline: 'bg-card text-ink shadow-[0_0_0_1px_var(--color-line-2)] hover:shadow-[0_0_0_1px_var(--color-ink-3)]',
  }
  const cls = `${base} ${sizes[size]} ${variants[variant]} ${className}`
  if (to) return <Link to={to} className={cls}>{children}</Link>
  if (href) return <a href={href} onClick={onClick} className={cls}>{children}</a>
  return <button type={type} onClick={onClick} className={cls} disabled={disabled}>{children}</button>
}

export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'up' | 'down' | 'warn'; className?: string }) {
  const tones = {
    neutral: 'bg-ink/[0.05] text-ink-2',
    accent: 'bg-accent-soft text-accent-2',
    up: 'bg-up/10 text-up',
    down: 'bg-down/10 text-down',
    warn: 'bg-[#f6ead2] text-[#7a5410]',
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium leading-5 ${tones[tone]} ${className}`}>{children}</span>
}

const AV = ['#2b44d6', '#0f6e6e', '#7a4fb0', '#b0552c', '#2f6f4f', '#8a6d1d', '#3f5f8f', '#a33f5f']
export function Monogram({ name, size = 40, className = '' }: { name: string; size?: number; className?: string }) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const bg = AV[h % AV.length]
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{ width: size, height: size, background: bg, fontSize: size * 0.36, letterSpacing: '-0.02em' }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

export function Ticker({ t, className = '' }: { t: string | null; className?: string }) {
  return t ? (
    <span className={`font-mono text-[12.5px] font-medium tracking-tight text-ink ${className}`}>{t}</span>
  ) : (
    <span className={`font-mono text-[12.5px] text-ink-3 ${className}`} title="No public ticker in the filing">—</span>
  )
}

export function SectionHead({ kicker, title, sub, right }: { kicker?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {kicker && <p className="mb-3 text-[13px] font-medium text-accent">{kicker}</p>}
        <h2 className="text-[30px] font-semibold leading-[1.1] tracking-[-0.035em] md:text-h2">{title}</h2>
        {sub && <p className="mt-3 text-[16px] leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {right}
    </div>
  )
}

export function Panel({ title, sub, right, children, className = '' }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius-card)] bg-card p-5 shadow-[var(--shadow-card)] md:p-6 ${className}`}>
      {(title || right) && (
        <header className="mb-5 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>}
            {sub && <p className="mt-0.5 text-[13px] text-ink-3">{sub}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className="num mt-1 text-[24px] font-semibold tracking-[-0.03em]">{value}</p>
      {/* The sub line is always there, so the card keeps its height while data loads. */}
      <p className="mt-0.5 text-[12px] text-ink-3">{sub ?? '\u00a0'}</p>
    </div>
  )
}

/** Under a page's dollar totals: how many flagged lines (ingest's unreliable rows) were left out, and why. */
export function NotCounted({ n, className = 'mt-3' }: { n: number; className?: string }) {
  if (!n) return null
  return (
    <p className={`${className} text-[12.5px] leading-relaxed text-ink-3`}>
      <Link to="/methodology/#unreliable" className="underline decoration-line-2 underline-offset-2 hover:text-accent">
        {n.toLocaleString('en-US')} {n === 1 ? 'line' : 'lines'} with unreliable filings not counted
      </Link>
    </p>
  )
}

/** Keeps one bad section (a null in a data file) from blanking the page: it shows a line in its place instead.
 *  data-boundary-error lets the smoke test fail the build on it. */
export class Boundary extends Component<{ children: ReactNode; full?: boolean }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.error(e)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p data-boundary-error className={`text-[14px] text-ink-3 ${this.props.full ? 'container-x py-16' : ''}`}>
        This part of the page didn’t load. Refresh to try again.
      </p>
    )
  }
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-ink/[0.06] ${className}`} />
}

export function Arrow({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export function Lock({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={className}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export function Check({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}

/** Up to three readable avatars, then a +N count. */
export function AvatarStack({ names, max = 3, size = 22 }: { names: { slug: string; name: string }[]; max?: number; size?: number }) {
  const shown = names.slice(0, max)
  const more = names.length - shown.length
  return (
    <span className="flex items-center">
      {shown.map((h, i) => (
        <span key={h.slug} title={h.name} className="rounded-full" style={{ marginLeft: i ? 3 : 0 }}>
          <Monogram name={h.name} size={size} />
        </span>
      ))}
      {more > 0 && (
        <span className="num ml-1 rounded-full bg-ink/[0.06] px-1.5 text-[11.5px] font-medium leading-5 text-ink-2">+{more}</span>
      )}
    </span>
  )
}

/** Ref for a seg-fade row: marks it data-end when it doesn't overflow or is scrolled to its end, so the
 *  right-edge fade only shows while there's more to scroll to. */
export function edgeFade(el: HTMLElement | null) {
  if (!el) return
  const update = () => el.toggleAttribute('data-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)
  update()
  el.addEventListener('scroll', update, { passive: true })
  new ResizeObserver(update).observe(el)
}
