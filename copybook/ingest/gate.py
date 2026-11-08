#!/usr/bin/env python3
"""Publish gate: refuse to publish a build that lost ticker coverage against the live data.

Compares the curated books ({slug}.json for every manager in index.json) in the data
directory with the same files at the git revision that is live (HEAD of the Pages repo).
Fails when the share of value with a ticker drops by more than 0.5 percentage points, when
any CUSIP among the 1,000 largest by value had a ticker and no longer has one, or when a
book's pct_of_book over its share (SH equity) rows does not sum to 1 within 0.001.

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
