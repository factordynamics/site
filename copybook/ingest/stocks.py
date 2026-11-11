#!/usr/bin/env python3
"""Who holds, bought and sold each stock, across every 13F filer.

Public: data/stock_holders.json, one row per issuer with holder counts and
quarter-over-quarter changes for shares, calls and puts.
Paid (R2 via the Copy API, never on Pages): data/s/{ISSUER}.json, every holder
of one issuer with shares, prior shares, value and change.

Built from full books (data/fb/{quarter}/{cik}.json; see datasets.py and bulk.py)
for `period`, the newest quarter whose filing deadline has passed, compared with
the quarter before. A filer is a buyer or seller only when it filed both
quarters. Share classes of one issuer (same 6-character CUSIP issuer code, e.g.
GOOG and GOOGL) are rolled up; calls and puts are counted apart from shares;
notes and other debt are left out. Without full books it falls back to the
public shards (latest quarter per filer, top 500 positions, no changes).
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.datasets import prev_quarter, stock_period
from ingest.parse import not_common
from ingest.splits import load as split_table_doc, ratio_between, table as split_table

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
DEBT = re.compile(r"\b(NOTES?|BONDS?|DEBT|DBCV|DEB)\b", re.I)  # preferreds (BAC 060505682): parse.not_common
CLASS = re.compile(r"\s+(Class|Series|Cl)\s+[A-Z0-9]+$", re.I)
KINDS = ("equity", "calls", "puts")
MIN_FILERS = 1000  # a quarter needs this many full books before stock pages use it


def kind_of(h: dict) -> str | None:
    if h.get("shares_type") == "PRN":
        return None  # principal-amount notes are not shareholders
    pc = (h.get("put_call") or "").strip().lower() or (h.get("title") or "").strip().lower()
    kind = {"put": "puts", "puts": "puts", "call": "calls", "calls": "calls"}.get(pc, "equity")
    if kind == "equity" and (DEBT.search(h.get("title") or "") or not_common(h.get("title"))):
        return None  # notes and converts are not shareholders
    return kind


try:
    LINKS = json.loads((DATA / "cusip_links.json").read_text()).get("links") or {}
except (OSError, ValueError):
    from ingest.build import SEED_LINKS as LINKS


def positions(book: dict, ratio=None) -> dict[tuple[str, str], dict]:
    """(issuer code, kind) -> summed shares/value plus the classes behind it, for one filer.

    ratio(cusip, put_call) scales an earlier quarter's shares for splits since then."""
    cols = book.get("columns") or []
    out: dict[tuple[str, str], dict] = {}
    for r in book.get("rows") or []:
        h = dict(zip(cols, r))
        cusip = (h.get("cusip") or "").upper()
        cusip = (LINKS.get(cusip) or {}).get("new") or cusip  # reissued CUSIPs (cusip_links.json)
        if len(cusip) < 6 or cusip.startswith("000000"):
            continue
        kind = kind_of(h)
        if kind is None:
            continue
        p = out.setdefault((cusip[:6], kind), {"shares": 0, "value": 0, "classes": {}})
        p["shares"] += (h.get("shares") or 0) * (ratio(cusip, h.get("put_call")) if ratio else 1)
        p["value"] += h.get("value") or 0
        if kind == "equity":
            c = p["classes"].setdefault(cusip, {"ticker": h.get("ticker"), "title": h.get("title"), "value": 0,
                                                "issuer": h.get("issuer"), "display_name": h.get("display_name"),
                                                "sector": h.get("sector")})
            c["value"] += h.get("value") or 0
    return out


def empty() -> dict:
    return {"holders": 0, "shares": 0, "value": 0, "prev_holders": 0, "prev_shares": 0, "prev_value": 0,
            "new": 0, "exited": 0, "buyers": 0, "sellers": 0, "unchanged": 0}


def roll_up(now: dict[str, dict], prev: dict[str, dict] | None = None, names: dict[str, dict] | None = None,
            ratio=None):
    """Per-issuer stats and holder lists from {cik: book} for this quarter and the one before.

    Returns (issuers, holders): issuers[code] is the public row; holders[code] lists
    [cik, name, slug, kind, shares, prev_shares, value, prev_value, change, accession] per filer.
    """
    prev = prev or {}
    names = names or {}
    issuers: dict[str, dict] = {}
    holders: dict[str, list] = {}

    def issuer(code: str) -> dict:
        return issuers.setdefault(code, {"issuer": code, "ticker": None, "display_name": None, "sector": None,
                                         "classes": {}, **{k: empty() for k in KINDS}})

    for cik in sorted(set(now) | set(prev)):
        cur = positions(now[cik]) if cik in now else {}
        old = positions(prev[cik], ratio) if cik in prev else {}
        comparable = cik in now and cik in prev
        meta = names.get(cik) or {}
        name = meta.get("name") or (now.get(cik) or prev.get(cik) or {}).get("name") or cik
        for key in set(cur) | set(old):
            code, kind = key
            c, o = cur.get(key), old.get(key)
            it = issuer(code)
            s = it[kind]
            if c:
                s["holders"] += 1
                s["shares"] += c["shares"]
                s["value"] += c["value"]
                for cusip, cl in c["classes"].items():
                    agg = it["classes"].setdefault(cusip, {"ticker": cl["ticker"], "title": cl["title"], "value": 0})
                    agg["value"] += cl["value"]
                    for f in ("display_name", "sector"):
                        if cl.get(f) and not it[f]:
                            it[f] = CLASS.sub("", cl[f]) if f == "display_name" else cl[f]
            if o:
                s["prev_holders"] += 1
                s["prev_shares"] += o["shares"]
                s["prev_value"] += o["value"]
            change = None
            if c and o and abs(c["shares"] - o["shares"]) < 0.5:
                o["shares"] = c["shares"]  # split-adjusted counts are not always whole
            if comparable:
                if c and not o:
                    change = "new"
                elif o and not c:
                    change = "exited"
                elif c["shares"] > o["shares"]:
                    change = "added"
                elif c["shares"] < o["shares"]:
                    change = "trimmed"
                else:
                    change = "unchanged"
                s[{"new": "new", "exited": "exited", "added": "buyers", "trimmed": "sellers"}.get(change, "unchanged")] += 1
            if c or comparable:
                holders.setdefault(code, []).append([
                    cik, name, meta.get("slug"), kind, round((c or {}).get("shares", 0)),
                    round(o["shares"]) if o else (0 if comparable else None), round((c or {}).get("value", 0)),
                    round(o["value"]) if o else (0 if comparable else None), change,
                    (now.get(cik) or {}).get("accession"),
                ])
    for code, it in issuers.items():
        classes = sorted(it["classes"].items(), key=lambda kv: kv[1]["value"], reverse=True)
        it["classes"] = [{"cusip": c, **v} for c, v in classes]
        it["ticker"] = next((c["ticker"] for c in it["classes"] if c["ticker"]), None)
        for k in KINDS:
            s = it[k]
            s["net_shares"] = s["shares"] - s["prev_shares"] if s["prev_holders"] or s["holders"] else 0
    return issuers, holders


def load_books(folder: Path) -> dict[str, dict]:
    out = {}
    for p in sorted(folder.glob("*.json")):
        try:
            b = json.loads(p.read_text())
        except ValueError:
            continue
        if b.get("ok"):
            out[p.stem] = b
    return out


def filer_names() -> dict[str, dict]:
    names = {}
    path = DATA / "filers.json"
    if path.exists():
        for f in json.loads(path.read_text()).get("filers") or []:
            names[f["cik"]] = {"name": f.get("name")}
    path = DATA / "index.json"
    if path.exists():
        for m in json.loads(path.read_text()).get("managers") or []:
            names[m["cik"]] = {"name": m.get("manager") or m.get("name"), "slug": m["slug"]}
    return names


def fill_names(issuers: dict[str, dict]) -> None:
    """Ticker, display name and sector from securities.json where the books lack them (SEC data sets)."""
    path = DATA / "securities.json"
    secs = json.loads(path.read_text()) if path.exists() else {}
    for it in issuers.values():
        for cl in it["classes"]:  # largest class first
            sec = secs.get(cl["cusip"]) or {}
            cl["ticker"] = cl.get("ticker") or sec.get("ticker")
            it["ticker"] = it["ticker"] or cl["ticker"]
            if not it["display_name"] and sec.get("name"):
                it["display_name"] = CLASS.sub("", sec["name"])
            it["sector"] = it["sector"] or sec.get("sector")


def latest_quarters() -> dict[str, int]:
    """How many filers have each quarter as their latest 13F-HR (data/f shards)."""
    out: dict[str, int] = {}
    for p in (DATA / "f").glob("*.json"):
        try:
            q = json.loads(p.read_text()).get("quarter")
        except ValueError:
            continue
        if q:
            out[q] = out.get(q, 0) + 1
    return out


def main() -> int:
    period = stock_period(date.today())
    now = load_books(DATA / "fb" / period)
    if len(now) < MIN_FILERS:  # deadline just passed and the books are still loading
        period = prev_quarter(period)
        now = load_books(DATA / "fb" / period)
    prior = prev_quarter(period)
    prev = load_books(DATA / "fb" / prior) if now else {}
    source = f"Full 13F books for {period} and {prior} (SEC Form 13F data sets and EDGAR)"
    if len(now) < MIN_FILERS:
        now = {p.stem: b for p in sorted((DATA / "f").glob("*.json")) if (b := json.loads(p.read_text())).get("ok")}
        prev, period, prior = {}, None, None
        source = "Each filer's latest 13F-HR on SEC EDGAR (top 500 positions per filer)"
    names = filer_names()
    splits = split_table()
    ratio = (lambda c, pc: ratio_between(splits, c, prior, period, pc)) if period else None
    from ingest.filer_types import SMART, load as load_types
    types = load_types()
    issuers, holders = roll_up(now, prev, names, ratio)
    for code, hs in holders.items():  # type per holder, and how many smart-money (hedge_fund/active) holders
        for h in hs:
            h.append((types.get(h[0]) or {}).get("type"))
        eq = issuers.get(code, {}).get("equity")
        if eq is not None:
            eq["hf_holders"] = sum(1 for h in hs if h[3] == "equity" and h[4] and h[-1] == "hedge_fund")
            eq["smart_holders"] = sum(1 for h in hs if h[3] == "equity" and h[4] and h[-1] in SMART)
    fill_names(issuers)
    latest = latest_quarters()
    rows = sorted(
        (i for i in issuers.values()
         if i["ticker"] or sum(i[k]["holders"] + i[k]["prev_holders"] for k in KINDS) >= 2),
        key=lambda i: i["equity"]["value"], reverse=True,
    )
    (DATA / "stock_holders.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": source,
        "period": period,
        "prev_period": prior,
        "filers": len(now),
        "prev_filers": len(prev),
        "comparable_filers": len(set(now) & set(prev)),
        # Filing season: each filer's latest 13F-HR quarter (data/f), e.g. "N of M have reported Q3".
        "filer_quarters": dict(sorted(latest.items(), reverse=True)),
        "season": {"period": max(latest) if latest else None, "filers_reported": latest[max(latest)] if latest else 0,
                   "filers_total": sum(latest.values())},
        "filers_truncated": sum(1 for b in now.values() if b.get("truncated")),
        "note": ("Values are as filed (options at notional). Share classes are rolled up by issuer CUSIP. "
                 "new/exited/buyers/sellers count filers that filed both quarters. prev_shares are split-adjusted "
                 "(see splits.json)."),
        "splits": [s for s in (split_table_doc().get("splits") or []) if s.get("to_quarter") == period],
        "stocks": rows,
    }, separators=(",", ":")) + "\n")
    out = DATA / "s"
    if period:
        out.mkdir(exist_ok=True)
        keep = set()
        for it in rows:
            code = it["issuer"]
            hs = sorted(holders.get(code, []), key=lambda h: (h[6], h[7] or 0), reverse=True)
            body = json.dumps({
                "issuer": code, "ticker": it["ticker"], "display_name": it["display_name"], "period": period,
                "prev_period": prior,
                "columns": ["cik", "name", "slug", "kind", "shares", "prev_shares", "value", "prev_value", "change",
                            "accession", "type"],
                "holders": hs,
            }, separators=(",", ":")) + "\n"
            path = out / f"{code}.json"
            keep.add(path.name)
            if not path.exists() or path.read_text() != body:
                path.write_text(body)
        for p in out.glob("*.json"):
            if p.name not in keep:
                p.unlink()
    print(f"stocks: {len(rows)} issuers, period {period} vs {prior}, {len(now)} filers ({len(set(now) & set(prev))} comparable)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
