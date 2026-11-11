export type GapRow = { form: string; accession: string; accepted_at: string; seconds: number }
export type GapStats = { count: number; median_seconds: number | null; p90_seconds: number | null }
export declare function seasonGaps(l: unknown): GapRow[]
export declare function gapStats(values: number[]): GapStats
export declare function firstAlertMedian(l: unknown): GapStats | null
