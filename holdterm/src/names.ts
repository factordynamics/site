import ROSTER from './roster.json'
// Display names. Funds lead with the firm; a person is shown only when they currently run the
// portfolio. `aka` is search-only (people historically tied to the firm), never displayed as the PM.
type FundName = { firm: string; pm?: string; aka?: string[] }
export const FUNDS: Record<string, FundName> = {
  'warren-buffett': { firm: 'Berkshire Hathaway', aka: ['Warren Buffett', 'Greg Abel', 'Todd Combs', 'Ted Weschler'] },
  'chris-hohn': { firm: 'TCI Fund Management', pm: 'Chris Hohn' },
  'philippe-laffont': { firm: 'Coatue Management', pm: 'Philippe Laffont' },
  'chase-coleman': { firm: 'Tiger Global', pm: 'Chase Coleman' },
  'elliott-investment-management-l-p': { firm: 'Elliott Investment Management', aka: ['Paul Singer'] },
  'bill-ackman': { firm: 'Pershing Square', pm: 'Bill Ackman' },
  'egerton-capital-uk-llp': { firm: 'Egerton Capital', pm: 'John Armitage' },
  'carl-icahn': { firm: 'Carl C. Icahn', aka: ['Icahn Enterprises'] },
  'steven-romick': { firm: 'First Pacific Advisors', pm: 'Steven Romick' },
  'david-tepper': { firm: 'Appaloosa', pm: 'David Tepper' },
  'acr-alpine-capital-research-llc': { firm: 'ACR Alpine Capital Research' },
  'ruane-cunniff': { firm: 'Ruane, Cunniff & Goldfarb', aka: ['Sequoia Fund'] },
  'mason-morfit': { firm: 'ValueAct Capital', pm: 'Mason Morfit' },
  'david-abrams': { firm: 'Abrams Capital', pm: 'David Abrams' },
  'seth-klarman': { firm: 'Baupost Group', pm: 'Seth Klarman' },
  'starboard-value-lp': { firm: 'Starboard Value', pm: 'Jeff Smith' },
  'nicolai-tangen': { firm: 'AKO Capital' },
  'nelson-peltz': { firm: 'Trian Fund Management', pm: 'Nelson Peltz' },
  'david-einhorn': { firm: 'DME Capital (Greenlight)', pm: 'David Einhorn' },
  'li-lu': { firm: 'Himalaya Capital', pm: 'Li Lu' },
  'corvex-management-lp': { firm: 'Corvex Management', pm: 'Keith Meister' },
  'dev-kantesaria': { firm: 'Valley Forge Capital', pm: 'Dev Kantesaria' },
  'francois-rochon': { firm: 'Giverny Capital', pm: 'François Rochon' },
  'paulson-co-inc': { firm: 'Paulson & Co.', pm: 'John Paulson' },
  'lansdowne-partners-uk-llp': { firm: 'Lansdowne Partners' },
  'lindsell-train-ltd': { firm: 'Lindsell Train', pm: 'Nick Train' },
  'mason-hawkins': { firm: 'Southeastern Asset Management', aka: ['Longleaf Partners', 'Mason Hawkins'] },
  'jana-partners-management-lp': { firm: 'JANA Partners', pm: 'Barry Rosenstein' },
  'tweedy-browne': { firm: 'Tweedy, Browne' },
  'stuart-mclaughlin': { firm: 'Triple Frond Partners', pm: 'Stuart McLaughlin' },
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
/** Fund URLs use the firm (/m/ako-capital), not the data slug, which can be a person's name. */
// Funds in FUNDS use their firm; other roster funds use their data slug without legal suffixes or the
// numeric tie-breaker (owl-creek-asset-management-l-p -> owl-creek-asset-management).
const bare = (slug: string) => slug.replace(/(-(llc|l-l-c|lp|l-p|llp|l-l-p|inc|ltd|co|corp|plc|ag|sa|se|nv|n-v|gmbh|limited))+(-\d+)?$/, '').replace(/-\d+$/, '')
const PUBLIC: Record<string, string> = Object.fromEntries([
  ...(ROSTER as unknown as { funds: { slug: string }[]; pending: { slug: string | null }[] }).funds.concat((ROSTER as unknown as { pending: { slug: string }[] }).pending.filter((f) => f.slug)).map((f) => [f.slug, bare(f.slug)]),
  ...Object.entries(FUNDS).map(([slug, f]) => [slug, slugify(f.firm)]),
])
const DATA_SLUG: Record<string, string> = Object.fromEntries(Object.entries(PUBLIC).map(([a, b]) => [b, a]))
export const fundPath = (slug: string) => `/m/${PUBLIC[slug] ?? slug}`
/** Data slug for a URL slug; old person-named URLs resolve too. */
export const dataSlug = (urlSlug: string) => DATA_SLUG[urlSlug] ?? urlSlug
export const publicSlug = (slug: string) => PUBLIC[slug] ?? slug

const SUFFIX = /[\s,]+(L\.?L\.?C\.?|L\.?P\.?|LLP|Inc\.?|Ltd\.?|Limited|Corp\.?|Co\.?|plc|S\.A\.|AG|N\.?V\.?|GmbH|\(UK\)|\/[A-Z]{2}\/?)$/i
const titleCase = (s: string) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()))
/** Firm name for any filer: our map first, else the EDGAR name without legal suffixes. */
export function firmName(slug: string, edgarName: string): string {
  if (FUNDS[slug]) return FUNDS[slug].firm
  let n = edgarName.trim().replace(/\/[A-Z]{2,3}\/?$/i, '')
  for (let i = 0; i < 3; i++) n = n.replace(SUFFIX, '').replace(/[\s,&]+$/, '')
  // EDGAR all-caps: title case, but keep vowel-less tokens (YCG, RWWM, MHR, JV) as acronyms.
  if (!/[a-z]/.test(n)) n = n.toLowerCase().replace(/\b[a-z][a-z']*/g, (w) => (/[aeiou]/.test(w) && w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
  else n = n.replace(/\b([A-Z][a-z]{1,3})\b/g, (w) => (/[aeiou]/i.test(w) ? w : w.toUpperCase()))
  return n.replace(/\bMc([a-z])/g, (_, c) => `Mc${c.toUpperCase()}`).replace(/\bIi\b/g, 'II').replace(/\bIii\b/g, 'III')
}
export const pmName = (slug: string) => FUNDS[slug]?.pm ?? null

// Issuer display names: fix EDGAR abbreviations and casing that leak through ("Cnh Indl", "Pvh",
// "Accenture Plc Ireland").
const WORDS: Record<string, string> = { Cgi: 'CGI', Adi: 'ADI', Indl: 'Industrial', Hldgs: 'Holdings', Hldg: 'Holding', Intl: 'International', Grp: 'Group', Cos: 'Companies', Tech: 'Technologies', Svcs: 'Services', Corp: 'Corp', Pptys: 'Properties', Bancorp: 'Bancorp' }
const KEEP = new Set(['Ltd', 'Inc', 'St', 'Mr', 'Dr', 'Jr', 'Sr', 'Mfg', 'Bros'])
export function issuerName(n: string | null | undefined): string {
  if (!n) return ''
  let s = n.replace(/\s+Public(\s+(Ltd|Limited)(\s+(Co|Company))?)?\.?$/i, '').replace(/\s+(Plc|PLC)\s+(Ireland|Jersey|Bermuda|Jersey\s+Ltd)$/i, '').replace(/\s+(Ireland|Bermuda|Jersey|Cayman Islands)$/i, '').replace(/\s+Ltd\.?\s+Bermuda$/i, '')
  s = s
    .split(' ')
    .map((w) => {
      if (WORDS[w]) return WORDS[w]
      if (/^(Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi)$/.test(w)) return w.toUpperCase()
      if (KEEP.has(w)) return w
      // "Abm", "Pvh", "Cnh": a capitalised 2-4 letter word with no vowel after the first letter is an acronym.
      if (/^[A-Z][a-z]{1,3}$/.test(w) && !/[aeiouy]/.test(w.slice(1))) return w.toUpperCase()
      return w
    })
    .join(' ')
  return s
}
