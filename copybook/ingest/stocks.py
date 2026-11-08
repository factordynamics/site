#!/usr/bin/env python3
"""All-filer holder counts per stock: data/stock_holders.json.

Built from every filer shard (f/{cik}.json, each filer's latest 13F as filed).
Share classes of one issuer (same 6-character CUSIP issuer code, e.g. GOOG and
GOOGL) are rolled up; calls and puts are counted apart from shares. Shards keep
each filer's 500 largest positions, so small holders of a stock inside very large
books can be missing; `filers_truncated` says how many such books there are.
Curated funds' buyers, sellers and quarter-over-quarter changes are in {slug}.json.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
DEBT = re.compile(r"\b(NOTES?|BONDS?|DEBT|DBCV|DEB)\b|%", re.I)
CLASS = re.compile(r"\s+(Class|Series|Cl)\s+[A-Z0-9]+$", re.I)


def roll_up(shards: list[dict]) -> dict[str, dict]:
    issuers: dict[str, dict] = {}
    for s in shards:
        if not s.get("ok"):
            continue
        cols = s.get("columns") or []
        seen: set[tuple[str, str]] = set()
        for r in s.get("rows") or []:
            h = dict(zip(cols, r))
            cusip = (h.get("cusip") or "").upper()
            if len(cusip) < 6 or cusip.startswith("000000"):
                continue
            code = cusip[:6]
            pc = (h.get("put_call") or "").strip().lower() or (h.get("title") or "").strip().lower()
            kind = {"put": "puts", "puts": "puts", "call": "calls", "calls": "calls"}.get(pc, "equity")
            if kind == "equity" and DEBT.search(h.get("title") or ""):
                continue  # notes and converts are not shareholders
            it = issuers.setdefault(code, {
                "issuer": code, "ticker": None, "display_name": None, "sector": None,
                "classes": {}, "equity": {"holders": 0, "shares": 0, "value": 0},
                "calls": {"holders": 0, "value": 0}, "puts": {"holders": 0, "value": 0},
            })
            if kind == "equity":
                cls = it["classes"].setdefault(cusip, {"ticker": h.get("ticker"), "title": h.get("title"), "value": 0})
                cls["value"] += h.get("value") or 0
                it["equity"]["shares"] += h.get("shares") or 0
            it[kind]["value"] += h.get("value") or 0
            if (code, kind) not in seen:  # a filer holding GOOG and GOOGL is one holder
                seen.add((code, kind))
                it[kind]["holders"] += 1
            if h.get("display_name") and not it["display_name"]:
                it["display_name"] = CLASS.sub("", h["display_name"])
            if h.get("sector") and not it["sector"]:
                it["sector"] = h["sector"]
    for it in issuers.values():
        classes = sorted(it["classes"].items(), key=lambda kv: kv[1]["value"], reverse=True)
        it["classes"] = [{"cusip": c, **v} for c, v in classes]
        it["ticker"] = next((c["ticker"] for c in it["classes"] if c["ticker"]), None)
    return issuers


def main() -> int:
    shards = []
    for p in sorted((DATA / "f").glob("*.json")):
        try:
            shards.append(json.loads(p.read_text()))
        except ValueError:
            continue
    ok = [s for s in shards if s.get("ok")]
    issuers = roll_up(ok)
    # Keep stocks someone could look up: a ticker or at least two holders.
    rows = sorted(
        (i for i in issuers.values() if i["ticker"] or i["equity"]["holders"] + i["calls"]["holders"] + i["puts"]["holders"] >= 2),
        key=lambda i: i["equity"]["value"], reverse=True,
    )
    quarters: dict[str, int] = {}
    for s in ok:
        quarters[s.get("quarter") or "?"] = quarters.get(s.get("quarter") or "?", 0) + 1
    (DATA / "stock_holders.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Each filer's latest 13F-HR on SEC EDGAR, as filed",
        "filers": len(ok),
        "filer_quarters": dict(sorted(quarters.items(), reverse=True)),
        "filers_truncated": sum(1 for s in ok if s.get("truncated")),
        "note": "Values are as filed (options at notional). Share classes are rolled up by issuer CUSIP.",
        "stocks": rows,
    }, separators=(",", ":")) + "\n")
    print(f"stocks: {len(rows)} issuers from {len(ok)} filers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
