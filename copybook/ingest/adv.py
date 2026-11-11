#!/usr/bin/env python3
"""SEC Form ADV adviser data for filer types (SEC data only).

The SEC's monthly "Information about Registered Investment Advisers and Exempt Reporting Advisers"
files carry each adviser's Form ADV Part 1A answers: CIK, names, regulatory AUM (5F(2)(c)), RAUM by
client type (5D), and Schedule D 7.B.1 private funds by type (any hedge funds, how many) with their
total gross assets. The newest registered and exempt files are downloaded each full run.

Hedge-fund gross assets: SEC publishes the total over all private funds, not per type, so when hedge
funds are the adviser's only private-fund type the total is theirs; otherwise the total is split by
fund count (marked as an estimate in the evidence).
"""

from __future__ import annotations

import csv
import io
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.edgar import get

PAGE = "https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers"
TYPES = ("Hedge", "Liquidity", "PE", "Real Estate", "Securitized", "VC", "Other")


def num(x: str | None) -> float:
    try:
        return float((x or "").replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def latest_files() -> tuple[str, str]:
    """(registered zip URL, exempt zip URL), newest first on the SEC page."""
    page = get(PAGE).decode("utf-8", "replace")
    hrefs = re.findall(r'href="(/files/investment/data/other/information-about-registered-investment-advisers'
                       r'-exempt-reporting-advisers/[^"]+\.zip)"', page)
    # Judge by the file name: the folder itself is "...-exempt-reporting-advisers".
    name = lambda h: h.rsplit("/", 1)[-1]
    reg = next(h for h in hrefs if "exempt" not in name(h))
    ex = next(h for h in hrefs if "exempt" in name(h))
    return "https://www.sec.gov" + reg, "https://www.sec.gov" + ex


def parse(raw: bytes, exempt: bool) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        text = z.read(name).decode("latin-1")
    rows = csv.reader(io.StringIO(text))
    head = next(rows)
    col = {c: i for i, c in enumerate(head)}
    g = lambda r, c: r[col[c]] if c in col and col[c] < len(r) else ""
    out = []
    for r in rows:
        counts = {t: int(num(g(r, f"Total number of {t} funds"))) for t in TYPES}
        out.append({
            "crd": g(r, "Organization CRD#").strip(),
            "cik": g(r, "CIK#").strip().zfill(10) if g(r, "CIK#").strip() else None,
            "names": [n for n in (g(r, "Legal Name").strip(), g(r, "Primary Business Name").strip()) if n],
            "exempt": exempt,
            "raum": num(g(r, "5F(2)(c)")),
            "raum_individuals": num(g(r, "5D(a)(3)")) + num(g(r, "5D(b)(3)")),
            "raum_investment_companies": num(g(r, "5D(d)(3)")),
            "private_funds": int(num(g(r, "Count of Private Funds - 7B(1)"))),
            "hedge_funds": counts["Hedge"] if g(r, "Any Hedge Funds").strip() == "Y" else 0,
            "fund_counts": {t: n for t, n in counts.items() if n},
            "private_gav": num(g(r, "Total Gross Assets of Private Funds")),
        })
    return out


def load() -> list[dict]:
    reg, ex = latest_files()
    advisers = parse(get(reg), False) + parse(get(ex), True)
    print(f"adv: {len(advisers)} advisers from {reg.rsplit('/', 1)[-1]} and {ex.rsplit('/', 1)[-1]}", flush=True)
    return advisers


def hedge_gav(a: dict) -> tuple[float, bool]:
    """(hedge-fund gross assets, estimated?)."""
    if not a["hedge_funds"] or not a["private_gav"]:
        return 0.0, False
    total = sum(a["fund_counts"].values()) or a["private_funds"] or a["hedge_funds"]
    if a["hedge_funds"] >= total:
        return a["private_gav"], False
    return a["private_gav"] * a["hedge_funds"] / total, True


def verdict(a: dict) -> tuple[str | None, dict]:
    """(type or None, evidence) from one adviser's Form ADV, by the reclass rule: hedge_fund when its hedge
    funds' gross assets are at least half its regulatory AUM, or $1B and more at a quarter of it or more; wealth when individual clients
    hold most of its RAUM; long_only when registered investment companies do."""
    gav, est = hedge_gav(a)
    base = a["raum"] or a["private_gav"]  # exempt advisers report no RAUM: their private funds are the book
    ev = {"source": "SEC Form ADV", "crd": a["crd"], "adviser": a["names"][0] if a["names"] else None,
          "exempt_reporting": a["exempt"], "raum": round(a["raum"]), "private_funds": a["private_funds"],
          "hedge_funds": a["hedge_funds"], "private_gav": round(a["private_gav"]),
          "hedge_gav": round(gav), "hedge_gav_estimated": est,
          "hedge_share": round(gav / base, 4) if base else None}
    # $1B of hedge funds counts only at a quarter of the book or more: a $6B wealth manager with one $1B fund
    # (Arnhold, by a count-based estimate) is not a hedge fund.
    share = gav / base if base else 0
    if gav and (share >= 0.5 or (gav >= 1e9 and share >= 0.25)):
        return "hedge_fund", ev
    if a["raum"] and a["raum_individuals"] >= 0.5 * a["raum"]:
        return "wealth", ev | {"individuals_share": round(a["raum_individuals"] / a["raum"], 4)}
    if a["raum"] and a["raum_investment_companies"] >= 0.5 * a["raum"]:
        return "long_only", ev | {"investment_companies_share": round(a["raum_investment_companies"] / a["raum"], 4)}
    return None, ev
