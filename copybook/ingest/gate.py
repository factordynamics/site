#!/usr/bin/env python3
"""Publish gate: refuse to publish a build that lost ticker coverage against the live data.

Compares the curated books ({slug}.json for every manager in index.json) in the data
directory with the same files at the git revision that is live (HEAD of the Pages repo).
Fails when the share of value with a ticker drops by more than 0.5 percentage points, when
any CUSIP among the 1,000 largest by value had a ticker and no longer has one, or when a
book's pct_of_book over its share (SH equity) rows does not sum to 1 within 0.001, or when a
curated quarter's book (h/) is over 1.5x the cover-page tableValueTotal of the filings merged
into it, or over 1.5x its previous quarter after merging a NEW HOLDINGS amendment (a re-filed
book added on top of the original).

Usage: python gate.py <data dir> [git revision, default HEAD]
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

MAX_DROP = 0.005
TOP_N = 1000


def books(read) -> dict[str, dict]:
    index = read("index.json")
    if not index:
        return {}
    out = {}
    for m in index.get("managers") or []:
        b = read(f"{m['slug']}.json")
        if b:
            out[m["slug"]] = b
    return out


def coverage(bs: dict[str, dict]) -> tuple[float, dict[str, float], dict[str, str | None]]:
    """(share of value with a ticker, value per CUSIP, ticker per CUSIP)."""
    total = mapped = 0.0
    value: dict[str, float] = {}
    ticker: dict[str, str | None] = {}
    for b in bs.values():
        for h in b.get("holdings") or []:
            v = float(h.get("value") or 0)
            total += v
            if h.get("ticker"):
                mapped += v
            c = h.get("cusip")
            if c:
                value[c] = value.get(c, 0.0) + v
                ticker[c] = ticker.get(c) or h.get("ticker")
    return (mapped / total if total else 1.0), value, ticker


def holder_counts(data: Path, books: dict[str, dict]) -> list[str]:
    """hl/{issuer}.json counts every filer's full book, so it can never be below the curated funds' count."""
    folder = data / "hlf" if (data / "hlf").exists() else data / "hl"  # full lists in CI, public top rows otherwise
    if not folder.exists():
        return []
    tracked: dict[str, set] = {}
    for b in books.values():
        for h in b.get("holdings") or []:
            c = h.get("cusip") or ""
            if len(c) >= 6 and not h.get("put_call") and h.get("shares_type", "SH") != "PRN" and h.get("shares"):
                tracked.setdefault(c[:6], set()).add(b.get("cik"))
    bad = []
    for code, ciks in tracked.items():
        p = folder / f"{code}.json"
        if not p.exists() and folder.name == "hl":
            continue  # public hl/ only has issuers with a ticker
        n = json.loads(p.read_text())["counts"]["holders"] if p.exists() else 0
        if n < len(ciks):
            bad.append(f"{code} {n} < {len(ciks)}")
    return bad


def book_totals(hist: Path) -> list[str]:
    bad = []
    for folder in sorted(hist.glob("*")) if hist.exists() else []:
        qs = {}
        for p in folder.glob("*Q?.json"):
            try:
                qs[p.stem] = json.loads(p.read_text())
            except ValueError:
                continue
        for name, q in qs.items():
            total, cover = q.get("total_value") or 0, q.get("cover_total") or 0
            if cover and total > 1.5 * cover:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B vs filed ${cover / 1e9:.1f}B")
                continue
            prev = qs.get(q.get("prev_quarter") or "")
            merged = any(f.get("role") == "addition" for f in q.get("filings") or [])
            if merged and prev and prev.get("total_value") and total > 1.5 * prev["total_value"]:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B after an amendment vs ${prev['total_value'] / 1e9:.1f}B")
    return bad


def main() -> int:
    data = Path(sys.argv[1])
    rev = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    top = subprocess.run(["git", "-C", str(data), "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    rel = data.resolve().relative_to(Path(top).resolve()).as_posix() if top else None

    def live(name: str):
        if not rel:
            return None
        r = subprocess.run(["git", "-C", top, "show", f"{rev}:{rel}/{name}"], capture_output=True, text=True)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None

    def new(name: str):
        p = data / name
        return json.loads(p.read_text()) if p.exists() else None

    before, after = books(live), books(new)
    if not before:
        print("gate: no live data to compare against; pass")
        return 0
    cov_b, val_b, tick_b = coverage(before)
    cov_a, _, tick_a = coverage(after)
    top_cusips = sorted(val_b, key=val_b.get, reverse=True)[:TOP_N]
    lost = [c for c in top_cusips if tick_b.get(c) and c in tick_a and not tick_a[c]]
    print(f"gate: value with a ticker {cov_b:.2%} live -> {cov_a:.2%} new ({len(before)} -> {len(after)} books); "
          f"{len(lost)} of the top {TOP_N} CUSIPs lost their ticker")
    failed = False
    off = []
    for slug, b in after.items():
        eq = [h for h in b.get("holdings") or [] if not h.get("put_call") and h.get("shares_type", "SH") != "PRN"]
        if eq and "pct_of_book" in eq[0] and "delta_pct_of_book" in eq[0]:  # the equity-weight definition
            total = sum(h.get("pct_of_book") or 0 for h in eq)
            if abs(total - 1) > 0.001:
                off.append(f"{slug} {total:.4f}")
    if off:
        print(f"::error::pct_of_book does not sum to 1 over equity rows: {', '.join(off[:20])}; not publishing.")
        failed = True
    index = new("index.json") or {}
    lagging = [f"{m['slug']} {m.get('quarter')} < {q['quarter']} ({q['reason']} {q.get('accession') or ''})"
               for m in index.get("managers") or [] for q in m.get("skipped_quarters") or []
               if q["report_date"] > (m.get("report_date") or "") and q["reason"] not in ("empty", "notice")]
    if lagging:
        print(f"::error::Curated funds behind a newer 13F-HR on EDGAR that was not loaded: {'; '.join(lagging[:20])}; "
              f"not publishing.")
        failed = True
    short = holder_counts(data, after)
    if short:
        print(f"::error::All-filer holder counts below the tracked funds holding the stock: {'; '.join(short[:20])}; "
              f"not publishing.")
        failed = True
    doubled = book_totals(data / "h")
    if doubled:
        print(f"::error::Books larger than their filings: {'; '.join(doubled[:20])}; not publishing.")
        failed = True
    if cov_a < cov_b - MAX_DROP:
        print(f"::error::Ticker coverage fell {100 * (cov_b - cov_a):.2f} points (limit {100 * MAX_DROP:.1f}); not publishing.")
        failed = True
    if lost:
        print(f"::error::Previously mapped CUSIPs lost their ticker: "
              + ", ".join(f"{c} ({tick_b[c]})" for c in lost[:40]) + "; not publishing.")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
