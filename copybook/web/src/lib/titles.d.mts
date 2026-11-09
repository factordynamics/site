export function qLabel(q?: string | null): string
export function stockTitle(x: { ticker: string; superinvestors?: number; hedge?: number; filers?: number; quarter?: string | null }): string
export function investorTitle(x: { who: string; quarter?: string | null; value?: number | null; positions?: number }): string
export function seasonTitle(x: { quarter: string; filed: number; total: number }): string
export function recapTitle(x: { quarter: string; filed: number; total: number; names?: string[]; final?: boolean }): string
