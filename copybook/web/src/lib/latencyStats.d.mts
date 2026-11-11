export type GapRow = { form: string; accession: string; accepted_at: string; seconds: number }
export type GapStats = { count: number; median_seconds: number | null; p90_seconds: number | null }
export type SpeedRow<T = Record<string, unknown>> = T & { form: string; accession: string; accepted_at: string; seconds: number | null; excluded: boolean; missed: boolean; later: boolean; preFix: boolean; counted: boolean }
export declare function speedRows<T = Record<string, unknown>>(l: unknown): SpeedRow<T>[]
export declare function seasonGaps(l: unknown): GapRow[]
export declare function gapStats(values: number[]): GapStats
export declare function thirteenFStats(l: unknown): GapStats | null
