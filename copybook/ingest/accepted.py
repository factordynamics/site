#!/usr/bin/env python3
"""EDGAR acceptance time (accepted_at, ISO UTC) for every filing in the f/ shards. SEC data only.

The SEC 13F data sets and older shards carry only the filing date. For each accession without an
acceptance time, the filer's submissions JSON (one request per CIK, every filing at once) gives it;
an accession outside that file's recent window falls back to the filing's own header (.hdr.sgml,
whose time is US Eastern). Results are cached in data/accepted.json ({accession: accepted_at}),
written into the f/ shards, and read by moves.py for the hl/ holder rows and fq/ books.

Full books (fb/, fq/) also get per-row provenance where missing: `source_accession`, the filing that first
disclosed the row (the book's own filing; for a book with amendments, the first of its filings whose information
table lists the row), and `first_disclosed_at`, that filing's acceptance time.
Stops after COPYBOOK_ACCEPTED_BUDGET_S seconds; the next run continues.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.edgar import fetch_info_table, fetch_submissions, get, iso_utc
from ingest.parse import parse_info_table

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
CACHE = DATA / "accepted.json"
BUDGET = float(os.environ.get("COPYBOOK_ACCEPTED_BUDGET_S") or 1500)
EASTERN = ZoneInfo("America/New_York")
PROV = ("source_accession", "first_disclosed_at")


def load() -> dict[str, str]:
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def from_header(cik: str, accession: str) -> str:
    raw = get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{accession}.hdr.sgml")
    m = re.search(rb"<ACCEPTANCE-DATETIME>(\d{14})", raw)
    if not m:
        return ""
    local = datetime.strptime(m.group(1).decode(), "%Y%m%d%H%M%S").replace(tzinfo=EASTERN)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    cache = load()
    shards: dict[Path, dict] = {}
    need: dict[str, set[str]] = {}  # cik -> accessions
    quarter_of: dict[str, str | None] = {}  # accession -> its report quarter, for the S6 count
    quarters: set[str] = set()  # every quarter a shard or full book covers
    for p in sorted((DATA / "f").glob("*.json")):
        try:
            s = json.loads(p.read_text())
        except ValueError:
            continue
        acc = s.get("accession")
        quarters.add(s.get("quarter") or "")
        if not (s.get("ok") and acc) or s.get("accepted_at"):
            continue
        shards[p] = s
        if acc not in cache:
            need.setdefault(s.get("cik") or p.stem, set()).add(acc)
            quarter_of[acc] = s.get("quarter")
    for p in full_books():  # full books' own filings and amendments
        try:
            b = json.loads(p.read_text())
        except ValueError:
            continue
        quarters.add(b.get("quarter") or (p.parent.name if p.parent.parent.name == "fq" else ""))
        for a in [b.get("accession")] + list(b.get("amendments") or []):
            if a and isinstance(a, str) and a not in cache:
                need.setdefault(b.get("cik") or p.stem, set()).add(a)
                quarter_of[a] = quarter_of.get(a) or b.get("quarter") or (p.parent.name if p.parent.parent.name == "fq" else None)
    started, looked = time.monotonic(), 0
    try:
        for cik, accs in sorted(need.items()):
            if time.monotonic() - started > BUDGET:
                print(f"::warning::accepted: budget reached; {len(need) - looked} filers wait for the next run")
                break
            looked += 1
            try:
                recent = fetch_submissions(cik).get("filings", {}).get("recent", {})
                for a, t in zip(recent.get("accessionNumber", []), recent.get("acceptanceDateTime", [])):
                    if a in accs and t:
                        cache[a] = iso_utc(t)
                for a in accs - cache.keys():
                    cache[a] = from_header(cik, a)
            except Exception as e:  # noqa: BLE001 - retried next run
                print(f"accepted: {cik} {e}")
            if looked % 500 == 0:
                CACHE.write_text(json.dumps(cache, separators=(",", ":"), sort_keys=True))
                print(f"accepted: {looked}/{len(need)} filers", flush=True)
    finally:
        cache = {a: t for a, t in cache.items() if t}
        CACHE.write_text(json.dumps(cache, separators=(",", ":"), sort_keys=True))
    patched = 0
    for p, s in shards.items():
        if cache.get(s["accession"]):
            s["accepted_at"] = cache[s["accession"]]
            p.write_text(json.dumps(s, separators=(",", ":")) + "\n")
            patched += 1
    blank = len(shards) - patched
    # S6 (Jan 4-6) publishes available_at for ownership momentum: each filer's latest quarter against the one before.
    qs = sorted(q for q in quarters if re.fullmatch(r"\d{4}Q[1-4]", q))[-2:]
    s6 = {cik for cik, accs in need.items() if any(quarter_of.get(a) in qs and not cache.get(a) for a in accs)}
    print(f"accepted: S6 needs acceptance times still missing for {len(s6)} filers in {', '.join(qs) or 'no quarter'}")
    print(f"accepted: {len(cache)} acceptance times on file; {patched} shards updated, {blank} still without one")
    books, rows_blank = fill_rows(cache, started)
    print(f"accepted: per-row provenance written on {books} full books; first_disclosed_at blank on {rows_blank} rows")
    return 0


def full_books() -> list[Path]:
    return sorted((DATA / "fb").glob("*/*.json")) + sorted((DATA / "fq").glob("*/*.json"))


def first_listed(cik: str, accessions: list[str]) -> dict[tuple[str, str], str]:
    """(cusip, put/call) -> the first of these filings, in order, whose information table lists it."""
    out: dict[tuple[str, str], str] = {}
    for a in accessions:
        for r in parse_info_table(fetch_info_table(cik, a)):
            out.setdefault((r.cusip, (r.put_call or "").lower()), a)
    return out


def fill_rows(cache: dict[str, str], started: float) -> tuple[int, int]:
    """Adds source_accession and first_disclosed_at to full books written without them, and fills a blank
    first_disclosed_at from the acceptance cache. Returns (books written, rows still blank)."""
    written = blank = 0
    for p in full_books():
        try:
            b = json.loads(p.read_text())
        except ValueError:
            continue
        cols, acc = b.get("columns"), b.get("accession")
        if not (b.get("ok") and cols and acc):
            continue
        dirty = False
        if "source_accession" not in cols:
            amends = [a for a in b.get("amendments") or [] if isinstance(a, str) and a]
            first: dict[tuple[str, str], str] = {}
            if amends:  # which filing listed each row first: a few requests, so only within the budget
                if time.monotonic() - started > BUDGET:
                    continue
                try:
                    first = first_listed(b.get("cik") or p.stem, [acc] + amends)
                except Exception as e:  # noqa: BLE001 - retried next run
                    print(f"accepted: {p.parent.name}/{p.name} amendments {e}")
                    continue
            ci, pi = cols.index("cusip"), cols.index("put_call")
            for r in b.get("rows") or []:
                r += [first.get((r[ci], (r[pi] or "").lower()), acc), None]
            cols += list(PROV)
            dirty = True
        if "first_disclosed_at" not in cols:  # data-set books name each row's filing but not its time
            si = cols.index("source_accession")
            for r in b.get("rows") or []:
                r.insert(si + 1, None)
            cols.insert(si + 1, "first_disclosed_at")
            dirty = True
        si, fi = cols.index("source_accession"), cols.index("first_disclosed_at")
        for r in b.get("rows") or []:
            if not r[si]:
                r[si], dirty = acc, True
            if not r[fi]:
                if cache.get(r[si]):
                    r[fi], dirty = cache[r[si]], True
                else:
                    blank += 1
        if dirty:
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(b, separators=(",", ":")) + "\n")
            tmp.replace(p)
            written += 1
    return written, blank


if __name__ == "__main__":
    raise SystemExit(main())
