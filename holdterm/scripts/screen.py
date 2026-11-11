# Holdterm's universe screen: every 13F-HR filer in SEC's quarterly Form 13F data sets
# (https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets), filtered by the rule below.
# Nobody is hand-picked; the only manual input is the type exclusion list in roster-exclusions.json.
# Usage: python3 -I scripts/screen.py DIR_Q DIR_PRIOR_Q DIR_TWO_YEARS_AGO PERIOD PRIOR_PERIOD OLD_PERIOD > scripts/universe.json
#   e.g. 01jun2026-31aug2026 01mar2026-31may2026 01jun2024-31aug2024 30-JUN-2026 31-MAR-2026 30-JUN-2024
# Then, for search's "why isn't this fund followed" (src/not-followed.json), with the same arguments:
#   SCREEN_ALL=/tmp/screen-all.json python3 -I scripts/screen.py ... > /dev/null
#   python3 -I scripts/not-followed.py /tmp/screen-all.json index.json > src/not-followed.json
import collections, csv, json, os, re, sys

csv.field_size_limit(10**9)
RULE = dict(min_value=1e9, min_positions=5, max_positions=100, min_top10=0.5, max_top1=0.6, max_etf=0.1, max_turnover=0.25, min_years=2, incumbent_buffer=0.2)
# A filer whose 13F moved to a new entity: the new CIK inherits the old one's history, and in a quarter
# where both filed, their books are summed.
PRED = {'0002026053': '0001336528'}  # Pershing Square Inc. <- Pershing Square Capital Management
ETF = re.compile(r'\b(ETF|ISHARES|SPDR|VANGUARD|INVESCO QQQ|SELECT SECTOR|PROSHARES|DIREXION|WISDOMTREE|INDEX|TR UNIT)\b', re.I)
TYPE = re.compile(r'\b(bank|banco|bancorp|securities|insurance|assurance|life|pension|retirement|teachers|university|regents|college|endowment|foundation|trust co|trust company|national association|sovereign|investment board|wealth|family office|capital markets)\b', re.I)
# T-bill and money-market funds are cash: left out of the book before any test.
CASH = re.compile(r'TREASUR|T-BILL|TBILL|MONEY MKT|MONEY MARKET|ULTRA SHORT|0-3 M|1-3 M|0-1 Y', re.I)
HERE = os.path.dirname(os.path.abspath(__file__))
# Funds already on the roster stay until they miss a test by more than the buffer, so it doesn't churn on noise.
INCUMBENTS = set(json.load(open(os.path.join(HERE, 'incumbents.json')))['ciks'])
EXCLUDED = json.load(open(os.path.join(HERE, 'roster-exclusions.json')))
dq, dp, do, pq, pp, po = sys.argv[1:7]
# With SCREEN_ALL=path, also write every 13F-HR filer of the period with the tests it fails ('history', 'size' and
# 'positions' come first; the others only for filers that pass those), for scripts/not-followed.py. stdout is unchanged.
ALL = os.environ.get('SCREEN_ALL')
every = []


def rows(d, f):
    with open(os.path.join(d, f), newline='', errors='ignore') as fh:
        yield from csv.DictReader(fh, delimiter='\t')


def filers(d, period):
    out = collections.defaultdict(list)
    for r in rows(d, 'SUBMISSION.tsv'):
        if r['SUBMISSIONTYPE'] == '13F-HR' and r['PERIODOFREPORT'] == period:
            out[r['CIK']].append(r['ACCESSION_NUMBER'])
    return out


def books(d, accs):
    a2c = {a: c for c, al in accs.items() for a in al}
    b = collections.defaultdict(lambda: collections.defaultdict(lambda: [0.0, 0.0, '']))
    for r in rows(d, 'INFOTABLE.tsv'):
        c = a2c.get(r['ACCESSION_NUMBER'])
        if not c or r.get('PUTCALL') or r.get('SSHPRNAMTTYPE') == 'PRN':
            continue
        try:
            v, s = float(r['VALUE'] or 0), float(r['SSHPRNAMT'] or 0)
        except ValueError:
            continue
        h = b[c][r['CUSIP'][:9]]
        h[0] += v; h[1] += s; h[2] = r['NAMEOFISSUER'] + ' ' + r['TITLEOFCLASS']
    return b


q, p, o = filers(dq, pq), filers(dp, pp), filers(do, po)
names = {r['ACCESSION_NUMBER']: r['FILINGMANAGER_NAME'].strip() for r in rows(dq, 'COVERPAGE.tsv')}
B, P = books(dq, q), books(dp, p)
med = lambda xs: sorted(xs)[len(xs) // 2]
px = collections.defaultdict(list)
for bk in B.values():
    for k, h in bk.items():
        if h[1] > 0: px[k].append(h[0] / h[1])
price = {k: med(v) for k, v in px.items()}
for bb in (B, P):  # some filers still report values in thousands
    for bk in bb.values():
        r = [(h[0] / h[1]) / price[k] for k, h in bk.items() if h[1] > 0 and price.get(k)]
        if r and med(r) < 0.01:
            for h in bk.values(): h[0] *= 1000
for new, old in PRED.items():
    if old in o: o[new] = o[old]
    if old in p:
        p.setdefault(new, [])
        for k, h in P[old].items():
            x = P[new][k]; x[0] += h[0]; x[1] += h[1]; x[2] = h[2]

out = []
for c, bk in B.items():
    live = {k: h for k, h in bk.items() if h[0] > 0 and not CASH.search(h[2])}
    tot = sum(h[0] for h in live.values())
    b = RULE['incumbent_buffer'] if c in INCUMBENTS else 0
    lo, hi = 1 - b, 1 + b
    pre = [k for k, bad in [('history', c not in o or c not in p), ('size', tot < RULE['min_value'] * lo), ('positions', not RULE['min_positions'] <= len(live) <= RULE['max_positions'] * hi)] if bad]
    if pre:
        if ALL: every.append(dict(cik=c, name=names.get(q[c][-1], ''), value=round(tot), positions=len(live), fails=pre))
        continue
    name = names.get(q[c][-1], '')
    w = sorted((h[0] / tot for h in live.values()), reverse=True)
    etf = sum(h[0] for h in live.values() if ETF.search(h[2])) / tot
    prev = {k: h for k, h in P[c].items() if not CASH.search(h[2])}
    traded = sum(abs(live.get(k, [0, 0])[1] - prev.get(k, [0, 0])[1]) * (price.get(k) or 0) for k in set(live) | set(prev))
    row = dict(cik=c, name=name, value=round(tot), positions=len(live), top10=round(sum(w[:10]), 4), top1=round(w[0], 4), etf=round(etf, 4), turnover=round(traded / 2 / tot, 4))
    fails = [k for k, bad in [('top10', row['top10'] < RULE['min_top10'] * lo), ('top1', row['top1'] > RULE['max_top1'] * hi), ('etf', etf > RULE['max_etf'] * hi), ('turnover', row['turnover'] > RULE['max_turnover'] * hi), ('type', bool(TYPE.search(name)) or c in EXCLUDED)] if bad]
    if b: row['incumbent'] = True
    if c in EXCLUDED: row['excluded'] = EXCLUDED[c]
    row['fails'] = fails
    out.append(row)
    if ALL: every.append(row)
out.sort(key=lambda r: -r['value'])
json.dump(dict(period=pq, source='SEC Form 13F data sets', rule=RULE, screened=len(out), funds=[r for r in out if not r['fails']], near_misses=[r for r in out if len(r['fails']) == 1 and r['fails'] != ['type']]), sys.stdout, indent=1)
print()
if ALL:
    for r in every:  # what kind of filer the name says it is, for the 'type' reason
        m = 'type' in r['fails'] and 'excluded' not in r and TYPE.search(r['name'])
        if m: r['kind'] = m.group(0).lower()
    json.dump(sorted(every, key=lambda r: -r['value']), open(ALL, 'w'), indent=0)
