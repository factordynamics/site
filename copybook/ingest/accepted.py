#!/usr/bin/env python3
"""EDGAR acceptance time (accepted_at, ISO UTC) for every filing in the f/ shards. SEC data only.

The SEC 13F data sets and older shards carry only the filing date. For each accession without an
acceptance time, the filer's submissions JSON (one request per CIK, every filing at once) gives it;
an accession outside that file's recent window falls back to the filing's own header (.hdr.sgml,
whose time is US Eastern). Results are cached in data/accepted.json ({accession: accepted_at}),
written into the f/ shards, and read by moves.py for the hl/ holder rows and fq/ books.
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

from ingest.edgar import fetch_submissions, get, iso_utc

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
CACHE = DATA / "accepted.json"
BUDGET = float(os.environ.get("COPYBOOK_ACCEPTED_BUDGET_S") or 1500)
EASTERN = ZoneInfo("America/New_York")


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
    for p in sorted((DATA / "f").glob("*.json")):
        try:
            s = json.loads(p.read_text())
        except ValueError:
            continue
        acc = s.get("accession")
        if not (s.get("ok") and acc) or s.get("accepted_at"):
            continue
        shards[p] = s
        if acc not in cache:
            need.setdefault(s.get("cik") or p.stem, set()).add(acc)
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
    print(f"accepted: {len(cache)} acceptance times on file; {patched} shards updated, {blank} still without one")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
