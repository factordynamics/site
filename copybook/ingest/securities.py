#!/usr/bin/env python3
"""Per-CUSIP security reference: ticker, clean display name, sector.

Sources, in priority order:
1. ingest/securities_overrides.json (hand-checked fixes, by CUSIP or ticker)
2. OpenFIGI CUSIP -> ticker (ingest/figi.py cache)
3. SEC company_tickers.json (ticker -> issuer CIK and name)
4. SEC submissions (issuer CIK -> SIC code), mapped to GICS-style sectors
Bonds, notes and options that share an issuer's 6-character CUSIP prefix
inherit that issuer's name and sector, never its ticker. Anything still
unknown is labelled "Unclassified" rather than left blank.

Writes data/securities.json ({cusip: {ticker, name, sector}}) and caches
issuer SIC codes in data/issuers.json so reruns only hit EDGAR for new ones.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.edgar import fetch_submissions, get
from ingest.parse import real_cusip
from ingest.figi import collect_cusips, load_cache as load_figi

HERE = Path(__file__).resolve().parent
OVERRIDES = HERE / "securities_overrides.json"
UNCLASSIFIED = "Unclassified"
FUNDS = "Funds & ETFs"
SECTORS = (
    "Information Technology", "Communication Services", "Consumer Discretionary",
    "Consumer Staples", "Health Care", "Financials", "Industrials", "Energy",
    "Materials", "Utilities", "Real Estate", FUNDS, UNCLASSIFIED,
)

FUND_RE = re.compile(
    r"\bETFS?\b|\bISHARES\b|\bSPDR\b|\bPROSHARES\b|\bDIREXION\b|\bINVESCO QQQ\b|SELECT SECTOR"
    r"|\bINDEX F(UN)?D\b|\bVANGUARD (INDEX|WORLD|SPECIALIZED|ADMIRAL|BD|MALVERN|SCOTTSDALE|TAX|WHITEHALL|STAR|INTL)"
    r"|\bWISDOMTREE\b|\bGLOBAL X\b|\bVANECK\b|\bJ ?P ?MORGAN EXCHANGE|\bSCHWAB STRATEGIC\b|\bFIRST TR\b"
    r"|\bUNIT SER\b|\bTRUST UNIT\b|\bCLOSED[- ]END\b",
    re.I,
)


def sic_sector(sic: int) -> str | None:
    """SEC SIC code -> GICS-style sector. None when SIC is missing."""
    if not sic:
        return None
    exact = {
        1311: "Energy", 1381: "Energy", 1382: "Energy", 1389: "Energy",
        1531: "Consumer Discretionary", 2111: "Consumer Staples",
        2834: "Health Care", 2835: "Health Care", 2836: "Health Care", 2833: "Health Care",
        2840: "Consumer Staples", 2842: "Consumer Staples", 2844: "Consumer Staples",
        3011: "Consumer Discretionary", 3630: "Consumer Discretionary", 3634: "Consumer Discretionary",
        3651: "Consumer Discretionary", 3711: "Consumer Discretionary", 3713: "Industrials",
        3714: "Consumer Discretionary", 3716: "Consumer Discretionary", 3751: "Consumer Discretionary",
        3812: "Industrials", 3873: "Consumer Discretionary",
        5122: "Health Care", 5140: "Consumer Staples", 5141: "Consumer Staples", 5150: "Consumer Staples",
        5171: "Energy", 5172: "Energy", 5180: "Consumer Staples",
        5331: "Consumer Staples", 5399: "Consumer Staples", 5411: "Consumer Staples", 5412: "Consumer Staples",
        5912: "Consumer Staples",
        6798: "Real Estate",
        7310: "Communication Services", 7311: "Communication Services", 7319: "Communication Services",
        7320: "Financials", 7374: "Information Technology", 7389: "Industrials",
        7812: "Communication Services", 7819: "Communication Services", 7822: "Communication Services",
        7829: "Communication Services", 7830: "Communication Services", 7841: "Communication Services",
        8731: "Health Care", 8734: "Health Care",
    }
    if sic in exact:
        return exact[sic]
    ranges = (
        (100, 999, "Consumer Staples"), (1000, 1499, "Materials"), (1500, 1799, "Industrials"),
        (2000, 2199, "Consumer Staples"), (2200, 2399, "Consumer Discretionary"),
        (2400, 2499, "Materials"), (2500, 2599, "Consumer Discretionary"), (2600, 2699, "Materials"),
        (2700, 2799, "Communication Services"), (2800, 2899, "Materials"), (2900, 2999, "Energy"),
        (3000, 3399, "Materials"), (3400, 3569, "Industrials"), (3570, 3579, "Information Technology"),
        (3580, 3599, "Industrials"), (3600, 3699, "Information Technology"),
        (3700, 3799, "Industrials"), (3820, 3839, "Information Technology"),
        (3840, 3859, "Health Care"), (3860, 3869, "Information Technology"),
        (3800, 3899, "Industrials"), (3900, 3999, "Consumer Discretionary"),
        (4000, 4799, "Industrials"), (4800, 4899, "Communication Services"), (4900, 4999, "Utilities"),
        (5000, 5199, "Industrials"), (5200, 5999, "Consumer Discretionary"),
        (6500, 6599, "Real Estate"), (6000, 6799, "Financials"),
        (7000, 7299, "Consumer Discretionary"), (7370, 7379, "Information Technology"),
        (7300, 7399, "Industrials"), (7500, 7599, "Consumer Discretionary"),
        (7800, 7899, "Communication Services"), (7900, 7999, "Consumer Discretionary"),
        (8000, 8099, "Health Care"), (8200, 8299, "Consumer Discretionary"),
        (8000, 8999, "Industrials"),
    )
    for lo, hi, sector in ranges:
        if lo <= sic <= hi:
            return sector
    return None


SUFFIX = re.compile(
    r"(,?\s+(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|PL|LLC|L\.?\s?P|N\.?\s?V|S\.?\s?A|SA|AG|SE|ASA|AB|NV|"
    r"S\.?P\.?A|SPA|OYJ|A/S|AS|TR|TRUST CO)\.?)+$",
    re.I,
)
STATE = re.compile(r"\s*/[A-Z.]{1,4}/?\s*$")
SMALL = {"of", "and", "the", "for", "in", "on", "at", "a", "an", "&"}
UPPER = {
    "AT&T", "IBM", "KKR", "LHX", "RBC", "TD", "BMO", "CIBC", "MSC", "IAC", "AMC", "CVR", "AMD", "UBS", "HSBC", "BP", "ASML", "SAP", "TSMC", "KLA", "NXP", "UPS", "CVS", "HCA", "AES",
    "CSX", "CME", "EOG", "NRG", "PPG", "PPL", "RTX", "TJX", "WEC", "XPO", "NVR", "EPAM", "ICON", "ADT", "AGCO",
    "CBRE", "CF", "CH", "CRH", "DR", "DTE", "ESAB", "FMC", "GE", "GXO", "HP", "II", "III", "IV", "LKQ", "MSCI",
    "NCR", "NI", "NOV", "ON", "PG&E", "PNC", "PTC", "QXO", "SBA", "SEI", "STAG", "TE", "TPG", "UDR", "UGI",
    "US", "USA", "VF", "WW", "XM", "ZTO", "JD", "NIO", "BHP", "ING", "ABB", "AON", "ARM", "AXA", "BNY", "LPL",
    "MGM", "NVIDIA", "ETF", "REIT", "SPDR", "ADR", "ASA", "CNA", "EQT", "FTAI", "HEICO", "IDEXX", "IQVIA",
}
ABBREV = {
    "PETE": "Petroleum", "NATL": "National", "INTL": "International", "HLDGS": "Holdings", "HLDNGS": "Holdings", "HLDS": "Holdings",
    "HLDG": "Holding", "MGMT": "Management", "FINL": "Financial", "SVCS": "Services", "SYS": "Systems",
    "TECHNOLOGIE": "Technologies", "TECH": "Technologies", "PHARMACEUTICALS": "Pharmaceuticals",
    "RY": "Railway", "BK": "Bank", "COMMUNICATIONS": "Communications", "INDS": "Industries",
    "LABS": "Laboratories", "SOLUTIONS": "Solutions", "ENTMT": "Entertainment", "PPTYS": "Properties",
    "RLTY": "Realty", "INVT": "Investment", "INVTS": "Investments", "BANCORPORATION": "Bancorporation",
    "MTRS": "Motors", "AMERN": "American", "CDA": "Canada", "GRP": "Group", "ELEC": "Electric",
    "MFG": "Manufacturing", "RES": "Resources", "SEMICONDUCTOR": "Semiconductor", "BANCORP": "Bancorp",
    "STL": "Steel", "COS": "Companies", "SCIENTIFIC": "Scientific", "INSTRS": "Instruments",
}


def clean_name(raw: str, expand: bool = False) -> str:
    """'BANK OF AMERICA CORP /DE/' -> 'Bank of America'. Mixed-case names keep their casing."""
    s = STATE.sub("", (raw or "").strip())
    s = re.sub(r"\s+", " ", s).strip(" ,.")
    s = re.sub(r"\s*&\s*CO\.?$", "", s, flags=re.I)
    prev = None
    while prev != s:
        prev = s
        s = SUFFIX.sub("", s).strip(" ,.")
        s = re.sub(r"\s*&\s*CO\.?$", "", s, flags=re.I).strip(" ,.")
    s = re.sub(r"\s*&$", "", s)
    words = s.split(" ")
    if expand:
        words = [
            ("America" if i == len(words) - 1 and i and words[i - 1].upper() == "OF" else "American")
            if w.upper() == "AMER"
            else ABBREV.get(w.upper(), w)
            for i, w in enumerate(words)
        ]
    if any(c.islower() for c in s) and not expand:
        return s or (raw or "").strip()
    out = []
    for i, w in enumerate(words):
        up = w.upper()
        if up in UPPER or any(ch.isdigit() for ch in w) or ("&" in w and len(w) > 1):
            out.append(up)
        elif i and w.lower() in SMALL:
            out.append(w.lower())
        elif any(c.islower() for c in w):
            out.append(w)
        else:
            out.append("-".join(p[:1].upper() + p[1:].lower() for p in w.split("-")))
    return " ".join(out) or (raw or "").strip()


COMMON_RE = re.compile(r"^(COM|COMMON|SHS|ORD|SHARES|CAP STK|COM STK)\b|^(COM|ORD|SHS) (NEW|PAR|USD|EUR|SHS)", re.I)


def name_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", clean_name(name, expand=True).lower().removeprefix("the "))


def load_overrides() -> dict:
    return json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {"by_cusip": {}, "by_ticker": {}}


def sec_tickers(tmp: Path) -> dict[str, dict]:
    path = tmp / "copybook-company_tickers.json"
    path.write_bytes(get("https://www.sec.gov/files/company_tickers.json"))
    out = {}
    for row in json.loads(path.read_text()).values():
        out[row["ticker"].upper().replace("-", ".")] = {"cik": str(row["cik_str"]).zfill(10), "title": row["title"]}
    return out


def issuers_detail(ciks: list[str], cache_path: Path, budget_s: float | None) -> dict[str, dict]:
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    start = time.monotonic()
    todo = [c for c in dict.fromkeys(ciks) if c not in cache]
    for i, cik in enumerate(todo):
        if budget_s and time.monotonic() - start > budget_s:
            print(f"securities: issuer budget reached at {i}/{len(todo)}", flush=True)
            break
        try:
            sub = fetch_submissions(cik)
            cache[cik] = {"sic": int(sub.get("sic") or 0), "name": sub.get("name") or ""}
        except FileNotFoundError:
            cache[cik] = {"sic": 0, "name": ""}
        except Exception as exc:
            print(f"securities: {cik} {exc}", flush=True)
        if i % 200 == 0:
            cache_path.write_text(json.dumps(cache, separators=(",", ":")) + "\n")
            print(f"securities: issuers {i}/{len(todo)}", flush=True)
    cache_path.write_text(json.dumps(cache, separators=(",", ":")) + "\n")
    return cache


def raw_issuers(data_dir: Path) -> dict[str, tuple[str, str]]:
    """cusip -> (raw issuer, title class) from published JSON."""
    out: dict[str, tuple[str, str]] = {}
    cc = data_dir / "copycat.json"
    if cc.exists():
        for h in json.loads(cc.read_text()).get("holdings") or []:
            out.setdefault(h["cusip"], (h.get("issuer") or "", h.get("title") or ""))
    for p in sorted((data_dir / "f").glob("*.json")) if (data_dir / "f").exists() else []:
        rec = json.loads(p.read_text())
        cols = rec.get("columns") or []
        if "cusip" not in cols:
            continue
        ci, ii, ti = cols.index("cusip"), cols.index("issuer"), cols.index("title")
        for r in rec.get("rows") or []:
            out.setdefault(r[ci], (r[ii] or "", r[ti] or ""))
    return out


def build(data_dir: Path, budget_s: float | None = None) -> dict[str, dict]:
    tmp = Path(os.environ.get("RUNNER_TEMP") or "/tmp")
    figi = load_figi()
    over = load_overrides()
    by_cusip, by_ticker = over.get("by_cusip") or {}, over.get("by_ticker") or {}
    order = [c for c in collect_cusips(data_dir) if real_cusip(c)]  # largest aggregate value first
    raws = raw_issuers(data_dir)
    sec = sec_tickers(tmp)

    # SEC name -> ticker, only where the name maps to exactly one ticker (skips share classes).
    by_name: dict[str, set[str]] = {}
    for t, row in sec.items():
        by_name.setdefault(name_key(row["title"]), set()).add(t)

    def ticker_of(c: str) -> str | None:
        if c in by_cusip and "ticker" in by_cusip[c]:
            return by_cusip[c]["ticker"]
        if figi.get(c):
            return figi[c]
        raw, title = raws.get(c, ("", ""))
        hits = by_name.get(name_key(raw)) or set()
        if len(hits) == 1 and COMMON_RE.match(title or ""):
            return next(iter(hits))
        return None

    tickers = {c: ticker_of(c) for c in order}
    ciks = [sec[t]["cik"] for c in order if (t := tickers[c]) and t in sec]
    issuers = issuers_detail(ciks, data_dir / "issuers.json", budget_s)

    out: dict[str, dict] = {}
    for c in order:
        raw, title = raws.get(c, ("", ""))
        t = tickers[c]
        rec = {"ticker": t, "name": None, "sector": None}
        if t and t in sec:
            info = issuers.get(sec[t]["cik"]) or {}
            rec["name"] = clean_name(sec[t]["title"])
            rec["sector"] = sic_sector(info.get("sic") or 0)
        if FUND_RE.search(f"{raw} {title}") or FUND_RE.search(rec["name"] or ""):
            rec["sector"] = FUNDS
        if t and t in by_ticker:
            rec.update({k: v for k, v in by_ticker[t].items() if k != "ticker"})
        if c in by_cusip:
            rec.update(by_cusip[c])
        out[c] = rec
    # Bonds, notes, warrants: inherit name/sector from a mapped CUSIP of the same issuer.
    issuer6: dict[str, dict] = {}
    for c in order:
        r = out[c]
        if r["ticker"] and r["name"] and c[:6] not in issuer6:
            issuer6[c[:6]] = r
    for c in order:
        r = out[c]
        base = issuer6.get(c[:6])
        if base and not r["name"]:
            r["name"] = base["name"]
        if base and not r["sector"]:
            r["sector"] = base["sector"]
        if not r["name"]:
            r["name"] = clean_name(raws.get(c, ("", ""))[0], expand=True)
        if not r["sector"]:
            r["sector"] = UNCLASSIFIED
    (data_dir / "securities.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
    return out


def main() -> int:
    data_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "web" / "data"
    budget = float(os.environ.get("COPYBOOK_SEC_BUDGET_S", "0") or "0") or None
    out = build(data_dir, budget)
    named = sum(1 for r in out.values() if r["sector"] != UNCLASSIFIED)
    print(f"securities: {len(out)} CUSIPs, {named} with a sector")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
