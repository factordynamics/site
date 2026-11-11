export declare function displayName(s?: string): string
export declare function possessive(name: string): string
export declare function shortName(name: string): string
export declare const RENAME: Record<string, string>
export declare const SEO_NAME: Record<string, string>
export declare const BY_SLUG: Record<string, string>
export declare function renamed<T extends { managers: { slug: string; manager: string }[] }>(index: T): T
export declare const MARQUEE: string[]
