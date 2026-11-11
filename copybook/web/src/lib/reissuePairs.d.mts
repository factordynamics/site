export function pairReissues<M extends { key: string; change: string; h: { shares: number; value: number }; delta: number; shares: number; prevShares: number }>(moves: M[]): M[]
