export type CardMove = { ticker: string | null; name: string; cusip: string; change: 'new' | 'added' | 'trimmed' | 'exited'; value_delta: number; shares: number; prev_shares: number; weight?: number }
export type FilingCard = {
  accession: string
  slug: string
  manager: string
  firm: string
  featured: boolean
  quarter: string
  prev_quarter: string
  report_date?: string
  filing_date: string
  sec_url: string
  total_value: number
  position_count: number
  changes?: { new: number; added: number; trimmed: number; exited: number }
  bought_usd: number
  sold_usd: number
  moves_total: number
  moves: CardMove[]
}
export declare function buildCard(b: unknown): FilingCard | null
export declare function cardSvg(c: FilingCard, sans?: string, mono?: string): string
export declare function qn(q?: string): number
export declare function qLabel(q: string): string
export declare function dLabel(d: string): string
export declare function money(v: number): string
export declare function x(s: unknown): string
export declare function cut(s: string, n: number): string
