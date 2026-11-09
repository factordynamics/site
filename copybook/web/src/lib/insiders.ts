import type { IssuerEvent } from './account'
import { displayName, money, sharesFmt } from './data'

// One Form 4 or 13D/G as a line for My book and the stock page's insider panel.

// The latest fund Form 4 or 13D/G on a name, in a line: "Warren Buffett bought $26.9M (+0.7%)".
export type Latest = {
  form: string
  date: string
  manager: string
  line: string
  url: string
  /** For the CSV: bought, sold, traded, 13D or 13G; the dollar size and % change in the holder's shares where known. */
  action: string
  value: number | null
  pct: number | null
  accession: string
  /** For the CSV: the trade's own date, the person or fund, their title, and an option exercise sold the same day. */
  tradeDate: string | null
  who: string
  title: string | null
  exSale: boolean
  /** A sale paired with a J distribution that leaves the holding about where it was. */
  distribution?: boolean
  /** 13D/G: the percent of the class after the filing. */
  ofClass: number | null
}
export const pctChange = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x) < 0.1 ? (Math.abs(x) * 100).toFixed(1) : Math.round(Math.abs(x) * 100)}%`
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
export const accNo = (s: string) => s.match(/\d{10}-?\d{2}-?\d{6}/)?.[0].replace(/-/g, '') ?? s

// Insider names arrive surname-first ("Jain Ajit"); people read first-last. Entities stay as filed.
const ENTITY = /\b(inc|llc|l\.?p|corp|co|ltd|plc|trust|fund|funds|capital|management|partners|group|holdings|hathaway|advisors|bank|n\.?a|sa|ag|se)\b\.?/i
function personName(raw: string) {
  const name = displayName(raw)
  const parts = name.split(/\s+/)
  return ENTITY.test(name) || parts.length < 2 || parts.length > 4 ? name : [...parts.slice(1), parts[0]].join(' ')
}
const VERB: Partial<Record<IssuerEvent['action'], string>> = { buy: 'bought', sell: 'sold', mixed: 'traded', grant: 'granted', option_exercise: 'exercised options on', tax_withholding: 'withheld for tax', gift: 'gifted', conversion: 'converted' }
/** An option exercise (M) and an open-market sale (S) on the same day in one Form 4. */
const exerciseAndSale = (e: IssuerEvent) => {
  const tx = (e.transactions ?? []).filter((t) => !t.derivative)
  return tx.some((m) => m.code === 'M' && tx.some((x) => x.code === 'S' && x.date === m.date))
}
const exSaleOf = (e: IssuerEvent) => e.exercise_and_sale ?? exerciseAndSale(e)
export function issuerLatest(e: IssuerEvent): Latest {
  const lead = e.filer_name.replace(/ and (\d+) others?$/i, '')
  const more = e.filer_name.slice(lead.length)
  const who = (e.role ? personName(lead) : displayName(lead)) + more
  const role = e.role ? `, ${e.role.split(',')[0].trim()}` : ''
  const sched = /13G/i.test(e.form) ? '13G' : '13D'
  let what: string
  let pct: number | null = null
  let distribution = false
  const f4 = /^4/.test(e.form)
  if (f4) {
    const verb = VERB[e.action] ?? 'filed a Form 4 on'
    const open = e.action === 'buy' || e.action === 'sell' || e.action === 'mixed'
    const size = open && e.value_usd ? money(Math.abs(e.value_usd)) : e.shares ? `${sharesFmt(Math.abs(e.shares))} shares` : ''
    // The API's pct_change counts only P and S against the holding just before them (gifts between
    // the owner's accounts don't move it); older rows fall back to the holding lines.
    const chg = e.pct_change !== undefined ? (e.pct_change == null ? null : e.pct_change / 100) : e.prev_shares_after && e.shares_after != null ? e.shares_after / e.prev_shares_after - 1 : null
    // A sale that went with a J distribution and leaves the holding about where it was (DASH's founders):
    // "distribution sale", not "0%".
    distribution = e.action === 'sell' && (e.has_other_codes ?? []).includes('J') && (chg == null || Math.abs(chg) < 0.005)
    if (open && !distribution && chg != null && Number.isFinite(chg) && chg !== 0) pct = chg
    // On an issuer with several classes the % is of the traded class (DASH Class A), and says so.
    const cls = (e.transactions ?? []).find((t) => !t.derivative && (t.code === 'P' || t.code === 'S'))?.security?.match(/\bclass\s+([A-Z])\b/i)?.[1]?.toUpperCase()
    what = `${cap(verb)}${size ? ` ${size}` : ''}${pct != null ? ` (${pctChange(pct)}${cls ? ` of Class ${cls} holding` : ''})` : ''}${distribution ? ' · distribution sale' : ''}${e.action === 'sell' && exSaleOf(e) ? ', exercise + sale' : ''}`
  } else {
    const p = e.percent_of_class
    what = e.action === 'new_stake' ? `New ${p != null ? `${p}% ` : ''}stake` : p != null ? `→ ${p}%` : 'Amended'
  }
  const action = f4 ? (e.action === 'buy' ? 'bought' : e.action === 'sell' ? 'sold' : (VERB[e.action] ?? 'other')) : sched
  // EDGAR dates filings in New York time; a 6:30 pm ET acceptance is the next day in UTC.
  return {
    form: e.form,
    date: e.filed_date ?? new Date(e.accepted_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    manager: who,
    line: `${what} · ${who}${role}`,
    url: e.url,
    action,
    value: f4 && (e.action === 'buy' || e.action === 'sell' || e.action === 'mixed') ? e.value_usd : null,
    pct,
    accession: accNo(e.accession),
    tradeDate: e.trade_date ?? e.event_date ?? null,
    who,
    title: e.role ? e.role.split(',')[0].trim() : null,
    exSale: f4 && e.action === 'sell' && exSaleOf(e),
    distribution: f4 && distribution,
    ofClass: f4 ? null : e.percent_of_class,
  }
}
