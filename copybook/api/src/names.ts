// The site's display-name overrides, one copy shared with the front end (web/src/lib/display-names.json): the firm where
// the person no longer runs it ("Kahn Brothers", not "Irving Kahn"), the firm and person otherwise ("Bridgewater (Ray Dalio)").
import overrides from '../../web/src/lib/display-names.json';

const DISPLAY = overrides as Record<string, string>;

/** The site's name for a filer when it overrides EDGAR's, else null. */
export const siteName = (slug: string | null | undefined): string | null => (slug ? (DISPLAY[slug] ?? null) : null);
/** The same without the person in parentheses, for possessives and firm-first spots ("Berkshire Hathaway"). */
export const siteFirm = (slug: string | null | undefined): string | null => siteName(slug)?.replace(/\s*\([^)]*\)$/, '') ?? null;
