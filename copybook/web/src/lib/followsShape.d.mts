export function readFollows<T extends object>(res: { follows?: Partial<T>; limit?: number } | null | undefined, empty: T, prevLimit?: number): T & { limit?: number }
