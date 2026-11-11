# Why a well-known 13F filer isn't one of the investors Holdterm follows, for search (src/not-followed.json).
# Inputs: screen.py's SCREEN_ALL output (every 13F-HR filer of the screened period with the tests it fails) and
# Copybook's public index.json (its tracked funds and the people they're known by), plus scripts/well-known.json.
# Usage: python3 -I scripts/not-followed.py SCREEN_ALL.json index.json > src/not-followed.json
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'src')
screened = {r['cik']: r for r in json.load(open(sys.argv[1]))}
index = json.load(open(sys.argv[2]))['managers']
roster = json.load(open(os.path.join(SRC, 'roster.json')))
known = {c: v for c, v in json.load(open(os.path.join(HERE, 'well-known.json'))).items() if c != '_'}
p = roster['period']  # e.g. 30-JUN-2026
period = f"{p[-4:]}Q{['MAR', 'JUN', 'SEP', 'DEC'].index(p[3:6]) + 1}"

followed = {f['cik'] for f in roster['funds']} | {f['predecessor'] for f in roster['funds'] if f['predecessor']}
followed_slugs = {f['slug'] for f in roster['funds']} | {f['filer_slug'] for f in roster['funds']}
held = {h['cik']: h['fails'] for h in roster['held']}
who = {}  # cik -> (slug, name, person)
for m in index:
    if m['cik'] not in followed and m['slug'] not in followed_slugs:
        who[m['cik']] = (m['slug'], m['name'], m['manager'] if m['manager'] != m['name'] else None, m['quarter'])
for c, v in known.items():
    s = who.get(c)
    who[c] = (s[0] if s else None, s[1] if s else v['name'], v['manager'], v.get('last_13f') or (s[3] if s else None))
for r in roster['near_misses']:
    who.setdefault(r['cik'], (r['slug'], r['firm'], None, period))

out = []
for c, (slug, name, person, last) in sorted(who.items()):
    if c in followed:
        continue
    e = {'c': c, 's': slug, 'n': name}
    if person: e['p'] = person
    r = screened.get(c)
    if c in held:
        e['h'] = held[c]  # passed the screen; held back by a data check, already in plain words
    elif r and r['fails']:
        e['f'] = r['fails']
        for k, kk in [('value', 'v'), ('positions', 'k'), ('top10', 't10'), ('top1', 't1'), ('etf', 'etf'), ('turnover', 'to'), ('kind', 'kind'), ('excluded', 'x')]:
            if k in r: e[kk] = r[k]
    elif not r and last and last < period:
        e['last'] = last  # no 13F in the screened period
    else:
        continue  # no reason we can state
    out.append(e)
json.dump(dict(period=period, filers=out), sys.stdout, separators=(',', ':'))
print()
