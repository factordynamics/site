#!/usr/bin/env python3
"""Filer type for every 13F filer, from EDGAR-only signals.

type is one of:
  hedge_fund  hedge funds, multi-strategy and activist managers (activist: true on known activists)
  active      other active, concentrated or long-only stock pickers
  index       index, passive and ETF sponsors (Vanguard, BlackRock, State Street, Geode, ...)
  bank        banks, brokers, dealers and insurers
  wealth      wealth managers, RIAs and family offices running diversified client books
  pension     pensions, endowments, foundations and sovereign funds
  other       not enough signal
"Smart money" on the site is hedge_fund + active.

Order of evidence: the hand-checked OVERRIDES below, then name rules, then book shape from the
filer's latest full book (position count, top-10 weight, options use, ETF weight) and its
turnover against the previous quarter's book. Each row carries `type_basis` saying which.

Writes data/filer_types.json ({cik: {type, basis, activist?}}) and stamps `type` into
filers.json and every f/{cik}.json shard. build.py, stocks.py and moves.py read the json.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.datasets import prev_quarter

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
TYPES = ("hedge_fund", "active", "index", "bank", "wealth", "pension", "other")
SMART = ("hedge_fund", "active")

# Hand-checked: (cik, type). Large index/bank/insurer filers whose names are ambiguous, and
# well-known hedge funds whose books (thousands of lines, heavy options) look like banks.
OVERRIDES = {
    # index / passive / ETF sponsors
    "0002012383": "index", "0000093751": "index", "0001214717": "index", "0000073124": "index",
    "0000354204": "index", "0000914208": "index", "0001330387": "index", "0000884546": "index",
    # long-only active managers that name rules would miss
    "0000315066": "active", "0001422848": "active", "0001562230": "active", "0001422849": "active",
    "0000080255": "active", "0001897612": "active", "0000902219": "active", "0001067983": "active",
    # banks, brokers, insurers
    "0000019617": "bank", "0000895421": "bank", "0000886982": "bank", "0000072971": "bank",
    "0000831001": "bank", "0000312069": "bank", "0000948046": "bank", "0000070858": "bank",
    "0001000275": "bank", "0001610520": "bank", "0000861177": "bank",
    # sovereign
    "0001374170": "pension",
    # hedge funds and multi-strategy managers
    "0001423053": "hedge_fund", "0001273087": "hedge_fund", "0001179392": "hedge_fund",
    "0001603466": "hedge_fund", "0001037389": "hedge_fund", "0001167557": "hedge_fund",
    "0001009207": "hedge_fund", "0001350694": "hedge_fund", "0001029160": "hedge_fund",
    "0001637460": "hedge_fund", "0001318757": "hedge_fund", "0001218710": "hedge_fund",
    "0001736225": "hedge_fund", "0001665241": "hedge_fund", "0001393825": "hedge_fund",
    "0001656456": "hedge_fund", "0001040273": "hedge_fund", "0001336528": "hedge_fund",
    "0001135730": "hedge_fund", "0001103804": "hedge_fund", "0001167483": "hedge_fund",
    "0001747057": "hedge_fund", "0001061165": "hedge_fund", "0001647251": "hedge_fund",
    "0000921669": "hedge_fund", "0001345471": "hedge_fund", "0001418814": "hedge_fund",
    "0001358706": "hedge_fund", "0001489933": "hedge_fund", "0001061768": "hedge_fund",
    "0001536411": "hedge_fund", "0001791786": "hedge_fund", "0001387322": "hedge_fund",
    "0001798849": "hedge_fund", "0001541617": "hedge_fund", "0001517137": "hedge_fund",
    "0001998597": "hedge_fund", "0001535472": "hedge_fund", "0001582090": "hedge_fund",
}
ACTIVISTS = {"0000921669", "0001345471", "0001418814", "0001336528", "0001040273", "0001791786",
             "0001517137", "0001998597", "0001535472", "0001582090"}

RULES: list[tuple[str, re.Pattern]] = [
    ("active", re.compile(r"\b(MASSACHUSETTS FINANCIAL SERVICES|FRANKLIN RESOURCES|AMERICAN CENTURY|NUVEEN|"
                          r"ALLIANCEBERNSTEIN|JANUS HENDERSON|DODGE & COX|PRIMECAP|BAILLIE GIFFORD|"
                          r"FIDELITY MANAGEMENT|PUTNAM|LOOMIS SAYLES|HARRIS ASSOCIATES|SOUTHEASTERN ASSET)\b", re.I)),
    ("index", re.compile(r"\b(VANGUARD|BLACKROCK|STATE STREET|GEODE|DIMENSIONAL FUND|SSGA|ISHARES|SPDR|"
                         r"PROSHARES|DIREXION|WISDOMTREE|GLOBAL X|VAN ?ECK|INDEX|ETF|INVESCO|AMUNDI|"
                         r"LEGAL & GENERAL|CHARLES SCHWAB|NORTHERN TRUST|RUSSELL INVESTMENTS|"
                         r"PARAMETRIC|QUANTITATIVE MANAGEMENT ASSOC|MELLON INVESTMENTS)\b", re.I)),
    ("pension", re.compile(r"\b(RETIREMENT|PENSION|TEACHERS|PUBLIC EMPLOYEES|EMPLOYEES'? RETIREMENT|"
                           r"ENDOWMENT|UNIVERSITY|COLLEGE|FOUNDATION|BOARD OF ADMINISTRATION|INVESTMENT BOARD|"
                           r"NORGES BANK|SOVEREIGN|STATE OF [A-Z]+|COMMONWEALTH|COUNTY OF|CITY OF|"
                           r"PERMANENT FUND|SUPERANNUATION|MASTER TRUST)\b", re.I)),
    ("bank", re.compile(r"\b(BANK|BANCORP|BANCSHARES|BANCORPORATION|BANQUE|BANCO|N\.?A\.?$|NATIONAL ASSOCIATION|"
                        r"SECURITIES|BROKERAGE|INSURANCE|ASSURANCE|REINSURANCE|LIFE|MUTUAL|ASSUR|"
                        r"MORGAN STANLEY|GOLDMAN SACHS|JPMORGAN|CITIGROUP|WELLS FARGO|UBS|BARCLAYS|HSBC|"
                        r"BNP PARIBAS|CREDIT SUISSE|MIZUHO|NOMURA|MITSUBISHI UFJ|SUMITOMO|RAYMOND JAMES|"
                        r"STIFEL|LPL FINANCIAL|AMERIPRISE|EDWARD JONES|TRUST CO(MPANY)?|SAVINGS|CREDIT UNION|"
                        r"DEKABANK|DZ BANK|LANDESBANK|SPARKASSE|JANE STREET|SUSQUEHANNA|OPTIVER|IMC|"
                        r"VIRTU|FLOW TRADERS|HUDSON RIVER TRADING|JUMP TRADING|CITADEL SECURITIES)\b", re.I)),
    ("wealth", re.compile(r"\b(WEALTH|FINANCIAL PLANNING|FINANCIAL ADVISORS?|PLANNING|RETIREMENT PLANNING|"
                          r"FAMILY OFFICE|PRIVATE CLIENT|INVESTMENT COUNSEL|FINANCIAL SERVICES|"
                          r"FINANCIAL GROUP|FINANCIAL NETWORK|ADVISORY SERVICES|FINANCIAL PARTNERS|"
                          r"FINANCIAL CORP)\b", re.I)),
    ("hedge_fund", re.compile(r"\b(MASTER FUND|OFFSHORE|HEDGE|ARBITRAGE|MULTI-?STRATEGY|"
                              r"OPPORTUNITIES FUND|GLOBAL MACRO|ACTIVIST)\b", re.I)),
]


def read(path: Path):
    try:
        return json.loads(path.read_text()) if path.exists() else None
    except ValueError:
        return None


def shape(book: dict | None, prev: dict | None) -> dict:
    """Book-shape signals from a full book (columnar, as in f/ and fb/)."""
    if not book or not book.get("ok"):
        return {}
    cols = book["columns"]
    rows = [dict(zip(cols, r)) for r in book.get("rows") or []]
    eq = [h for h in rows if not h.get("put_call") and h.get("shares_type", "SH") != "PRN"]
    total = sum(h.get("value") or 0 for h in eq) or 1
    vals = sorted((h.get("value") or 0 for h in eq), reverse=True)
    opts = sum(h.get("value") or 0 for h in rows if h.get("put_call"))
    etf = sum(h.get("value") or 0 for h in eq if re.search(r"\bETF\b|\bTR UNIT\b|ISHARES|SPDR",
                                                              f"{h.get('issuer') or ''} {h.get('title') or ''}", re.I))
    out = {"positions": book.get("position_count") or len(rows), "top10": sum(vals[:10]) / total,
           "options": opts / total, "etf": etf / total, "aum": total}
    if prev and prev.get("ok"):
        pc = prev["columns"]
        a = {r[pc.index("cusip")] for r in prev.get("rows") or []}
        b = {h["cusip"] for h in eq}
        if a or b:
            out["turnover"] = len(a ^ b) / max(1, (len(a) + len(b)) / 2)
    return out


def classify(cik: str, name: str, s: dict) -> tuple[str, str]:
    if cik in OVERRIDES:
        return OVERRIDES[cik], "override"
    for kind, rx in RULES:
        if rx.search(name or ""):
            return kind, "name"
    if not s:
        return "other", "none"
    n, top10, opts, etf = s["positions"], s["top10"], s["options"], s["etf"]
    if etf > 0.5:
        return "wealth", "shape: mostly ETFs"
    if n <= 150 and top10 >= 0.4 and etf <= 0.2:
        if opts > 0.05 or s.get("turnover", 0) > 0.6:
            return "hedge_fund", "shape: concentrated, options or high turnover"
        return "active", "shape: concentrated"
    if opts > 0.25 and n <= 1500:
        return "hedge_fund", "shape: heavy options"
    if n > 1500 and top10 < 0.25:
        return "index", "shape: broad and diversified"
    if etf > 0.2:
        return "wealth", "shape: ETF-heavy"
    return "active", "shape: diversified active"


def main() -> int:
    filers_doc = read(DATA / "filers.json") or {"filers": []}
    curated = {m["cik"]: m for m in (read(DATA / "index.json") or {}).get("managers") or []}
    out: dict[str, dict] = {}
    counts: dict[str, int] = {}
    for f in filers_doc["filers"] + [{"cik": c, "name": m.get("name") or m.get("manager")} for c, m in curated.items()]:
        cik = f["cik"]
        if cik in out:
            continue
        shard = read(DATA / "f" / f"{cik}.json")
        q = (shard or {}).get("quarter")
        book = read(DATA / "fb" / q / f"{cik}.json") if q else None
        prev = read(DATA / "fb" / prev_quarter(q) / f"{cik}.json") if q else None
        s = shape(book or shard, prev)
        kind, basis = classify(cik, f.get("name") or "", s)
        row = {"type": kind, "basis": basis}
        if cik in ACTIVISTS:
            row["activist"] = True
        if s.get("aum"):
            row["aum"] = round(s["aum"])
        out[cik] = row
        counts[kind] = counts.get(kind, 0) + 1
    (DATA / "filer_types.json").write_text(json.dumps({
        "types": list(TYPES), "smart_money": list(SMART),
        "note": "EDGAR-only: hand overrides, then name rules, then the latest 13F book's shape and turnover.",
        "filers": out}, separators=(",", ":")) + "\n")
    for f in filers_doc["filers"]:
        f["type"] = out.get(f["cik"], {}).get("type")
    (DATA / "filers.json").write_text(json.dumps(filers_doc, separators=(",", ":")) + "\n")
    for p in (DATA / "f").glob("*.json"):
        shard = read(p)
        t = out.get(p.stem, {}).get("type")
        if shard is not None and shard.get("type") != t:
            shard["type"] = t
            p.write_text(json.dumps(shard, separators=(",", ":")) + "\n")
    print("filer types: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    return 0


def load() -> dict[str, dict]:
    return (read(DATA / "filer_types.json") or {}).get("filers") or {}


if __name__ == "__main__":
    raise SystemExit(main())
