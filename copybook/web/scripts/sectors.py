"""Build a CUSIP -> sector map from SEC data only (company_tickers + submissions SIC).

Usage: python3 -I sectors.py <copycat.json> <out.json>
"""
import json, re, sys, time, urllib.request

UA = {"User-Agent": "Copybook research copybook@factordynamics.com"}
SECTORS = ["Technology", "Communication", "Consumer", "Staples", "Health care", "Financials",
           "Industrials", "Energy", "Materials", "Utilities", "Real estate", "Funds & ETFs"]
# Overrides where SIC disagrees with how investors classify the business.
OVERRIDE = {"GOOGL": 1, "GOOG": 1, "META": 1, "NFLX": 1, "DIS": 1, "CMCSA": 1, "T": 1, "VZ": 1, "TMUS": 1,
            "V": 5, "MA": 5, "PYPL": 5, "AMZN": 2, "SPY": 11, "QQQ": 11, "IVV": 11, "VOO": 11}
STOP = {"INC", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "HLDGS", "HOLDINGS", "GROUP",
        "THE", "NEW", "DEL", "COM", "SA", "NV", "AG", "SE", "LP", "LLC", "TR", "TRUST", "CL", "A", "B", "&"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            time.sleep(1 + attempt)
    return None


def norm(s):
    s = re.sub(r"[^A-Z0-9 ]", " ", (s or "").upper())
    return " ".join(w for w in s.split() if w not in STOP)


def sic_sector(sic):
    s = int(sic)
    if 6798 == s or 6500 <= s <= 6553: return 10
    if 6000 <= s <= 6799: return 5
    if 4900 <= s <= 4999: return 9
    if 1300 <= s <= 1399 or 2900 <= s <= 2999 or 4610 <= s <= 4619: return 7
    if 4800 <= s <= 4899 or 7810 <= s <= 7829 or 2710 <= s <= 2741 or 7900 <= s <= 7999: return 1
    if 2830 <= s <= 2836 or 3841 <= s <= 3851 or 8000 <= s <= 8099 or s == 5122 or 8731 == s: return 4
    if 3570 <= s <= 3579 or 3660 <= s <= 3679 or 7370 <= s <= 7379 or 3825 <= s <= 3829 or s == 3577: return 0
    if 2000 <= s <= 2199 or 2840 <= s <= 2844 or 5400 <= s <= 5499 or 5140 <= s <= 5149 or s == 5912: return 3
    if 1000 <= s <= 1499 or 2600 <= s <= 2699 or 2800 <= s <= 2829 or 2850 <= s <= 2899 or 3300 <= s <= 3399 or 3200 <= s <= 3299: return 8
    if 5200 <= s <= 5999 or 3710 <= s <= 3716 or 7000 <= s <= 7099 or 2300 <= s <= 2399 or 3940 <= s <= 3949 or 2500 <= s <= 2599 or 3630 <= s <= 3652 or 1520 <= s <= 1531 or 8200 <= s <= 8299: return 2
    if 3400 <= s <= 3569 or 3580 <= s <= 3659 or 3680 <= s <= 3699 or 3717 <= s <= 3824 or 3830 <= s <= 3840 or 4000 <= s <= 4799 or 1500 <= s <= 1799 or 8700 <= s <= 8799 or 7380 <= s <= 7389 or 5000 <= s <= 5199: return 6
    return None


FUND = re.compile(r"\b(ISHARES|SPDR|VANGUARD|INVESCO QQQ|SELECT SECTOR|ETF|PROSHARES|SCHWAB STRATEGIC|WISDOMTREE|GLOBAL X|DIREXION|VANECK|FIRST TR|ISHARES TR|ISHARES INC|SPROTT|GRAYSCALE|ARK ETF)\b")


def main(src, out):
    book = json.load(open(src))["holdings"]
    book = sorted(book, key=lambda h: -h["total_value"])[:5000]
    tick = get("https://www.sec.gov/files/company_tickers.json")
    by_ticker, by_name = {}, {}
    for row in tick.values():
        t = row["ticker"].upper().replace("-", ".")
        by_ticker[t] = (row["cik_str"], row["title"])
        by_name.setdefault(norm(row["title"]), (row["cik_str"], row["title"], t))
    want, bad, cusip_cik = {}, [], {}
    for h in book:
        cusip, issuer, t = h["cusip"], h["issuer"], (h.get("ticker") or "").upper()
        if FUND.search(issuer.upper()):
            want[cusip] = 11
            continue
        if t in OVERRIDE:
            want[cusip] = OVERRIDE[t]
        hit = None
        if t and t in by_ticker:
            cik, title = by_ticker[t]
            a, b = norm(issuer).split(), norm(title).split()
            if a and b and a[0][:4] != b[0][:4]:
                bad.append({"cusip": cusip, "issuer": issuer, "ticker": t, "sec_title": title})
            else:
                hit = cik
        if hit is None:
            m = by_name.get(norm(issuer))
            if m:
                hit = m[0]
        if hit is not None:
            cusip_cik[cusip] = hit
    sic_cache = {}
    ciks = sorted({c for c in cusip_cik.values()})
    print("ciks", len(ciks), file=sys.stderr)
    for i, cik in enumerate(ciks):
        d = get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json")
        sic_cache[cik] = (d or {}).get("sic") or ""
        time.sleep(0.13)
        if i % 200 == 0:
            print(i, file=sys.stderr)
    for cusip, cik in cusip_cik.items():
        if cusip in want:
            continue
        sic = sic_cache.get(cik)
        if sic:
            sec = sic_sector(sic)
            if sec is not None:
                want[cusip] = sec
    json.dump({"source": "SEC EDGAR company tickers and SIC codes", "sectors": SECTORS,
               "map": want, "suspect_tickers": bad}, open(out, "w"), separators=(",", ":"))
    tot = sum(h["total_value"] for h in book)
    cov = sum(h["total_value"] for h in book if h["cusip"] in want)
    print("mapped", len(want), "value coverage", round(cov / tot, 3), "suspect", len(bad), file=sys.stderr)


main(sys.argv[1], sys.argv[2])
