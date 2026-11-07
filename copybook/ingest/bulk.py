#!/usr/bin/env python3
"""Latest-quarter 13F holdings for every 13F filer, one JSON shard per CIK.

Incremental: reads EDGAR's full-index for the current and previous filing
quarters, adds new filers to filers.json, and only re-ingests a CIK whose
newest 13F-HR in the index is newer than what its shard last checked.
Stops after COPYBOOK_BULK_BUDGET_S seconds so a scheduled run can commit and
the next run continues.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.build import WEB, load_period
from ingest.edgar import fetch_submissions, get, list_13f, quarter_groups
from ingest.universe import parse_index, slugify

DATA = WEB / "data"
OUT = DATA / "f"
LIMIT = int(os.environ.get("COPYBOOK_BULK_LIMIT", "0") or "0")
BUDGET = float(os.environ.get("COPYBOOK_BULK_BUDGET_S", "0") or "0")
MAX_ROWS = 500  # shard cap by value; position_count keeps the full count
SHARD_KEYS = (
    "ok", "cik", "name", "form", "accession", "filing_date", "report_date", "quarter",
    "sec_url", "position_count", "total_value", "values_in_thousands", "indexed_date", "error",
    "filing_key", "amendments", "unit_fix",
)
# Rows are arrays in this column order to keep 9k shards small.
COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value")


def numeric_cik(cik: str) -> bool:
    return cik.isdigit() and len(cik) == 10


def slim(rec: dict) -> dict:
    out = {k: rec[k] for k in SHARD_KEYS if k in rec}
    if rec.get("ok"):
        rows = rec.get("holdings") or rec.get("rows") or []
        if rows and isinstance(rows[0], list):
            rows = [dict(zip(rec.get("columns") or COLUMNS, r)) for r in rows]
        out["truncated"] = len(rows) > MAX_ROWS
        out["columns"] = list(COLUMNS)
        out["rows"] = [
            [int(h[k]) if k in ("value", "shares") else h[k] for k in COLUMNS]
            for h in rows[:MAX_ROWS]
        ]
    return out


def write_shard(dest: Path, rec: dict) -> None:
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(slim(rec), separators=(",", ":")) + "\n")
    tmp.replace(dest)


def ingest_one(cik: str) -> dict:
    submissions = fetch_submissions(cik)
    metas = list_13f(submissions)
    if not metas:
        return {"ok": False, "cik": cik, "error": "no 13F-HR"}
    last_error = "no usable table"
    # Latest period whose original (or restated) book parses; falls back one quarter.
    for group in quarter_groups(metas, 2):
        try:
            loaded = load_period(cik, group, {})
            if loaded is None:
                last_error = f"empty {group[0].report_date}"
                continue
            return {"ok": True, "cik": cik, "name": submissions.get("name") or "", **loaded}
        except Exception as exc:
            last_error = str(exc)
    return {"ok": False, "cik": cik, "error": last_error}


def filing_quarters(today: date) -> list[tuple[int, int]]:
    q = (today.month - 1) // 3 + 1
    prev = (today.year, q - 1) if q > 1 else (today.year - 1, 4)
    return [prev, (today.year, q)]


def index_filings() -> dict[str, dict]:
    """Newest 13F-HR(/A) per CIK across the previous and current filing quarters."""
    merged: dict[str, dict] = {}
    tmp = Path(os.environ.get("RUNNER_TEMP") or "/tmp")
    for year, q in filing_quarters(date.today()):
        url = f"https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{q}/form.idx"
        path = tmp / f"copybook-form-{year}Q{q}.idx"
        try:
            path.write_bytes(get(url))
        except FileNotFoundError:
            continue
        for cik, rec in parse_index(path).items():
            if cik not in merged or rec["filing_date"] >= merged[cik]["filing_date"]:
                merged[cik] = rec
    return merged


def main() -> int:
    filers_path = DATA / "filers.json"
    catalog = json.loads(filers_path.read_text()) if filers_path.exists() else {"filers": []}
    by_cik = {f["cik"]: f for f in catalog["filers"]}
    indexed = {} if os.environ.get("COPYBOOK_BULK_NO_INDEX") == "1" else index_filings()
    for cik, rec in indexed.items():
        f = by_cik.get(cik)
        if f is None:
            by_cik[cik] = f = {
                "cik": cik,
                "name": rec["name"],
                "slug": slugify(rec["name"]) + "-" + cik[-4:],
                "filing_date": rec["filing_date"],
            }
            catalog["filers"].append(f)
        elif rec["filing_date"] > (f.get("filing_date") or ""):
            f["filing_date"] = rec["filing_date"]
    catalog["filers"].sort(key=lambda f: f["name"].lower())
    filers = [f for f in catalog["filers"] if numeric_cik(f["cik"])]
    if LIMIT:
        filers = filers[:LIMIT]
    order = filers[::-1] if os.environ.get("COPYBOOK_BULK_REVERSE") == "1" else filers
    OUT.mkdir(parents=True, exist_ok=True)

    todo = []
    for f in order:
        dest = OUT / f"{f['cik']}.json"
        try:
            rec = json.loads(dest.read_text()) if dest.exists() else None
        except ValueError:  # partial write; refetch
            rec = None
        if rec is not None:
            f["ok"] = bool(rec.get("ok"))
            f["position_count"] = rec.get("position_count")
            f["quarter"] = rec.get("quarter")
            checked = rec.get("indexed_date") or rec.get("filing_date") or ""
            # Shards built from a 13F-HR/A before amendment handling are refetched once.
            stale_amend = rec.get("form") == "13F-HR/A" and "filing_key" not in rec
            if (f.get("filing_date") or "") <= checked and not stale_amend:
                continue
        todo.append(f)

    print(f"bulk: {len(filers)} filers, {len(todo)} to fetch", flush=True)
    start = time.monotonic()
    done = 0

    def checkpoint() -> None:
        oks = [f for f in filers if f.get("ok")]
        catalog["count"] = len(catalog["filers"])
        catalog["holdings_ok"] = len(oks)
        catalog["holdings_fail"] = sum(1 for f in filers if f.get("ok") is False)
        catalog["source"] = "SEC EDGAR 13F-HR full-index"
        filers_path.write_text(json.dumps(catalog, separators=(",", ":")) + "\n")

    for f in todo:
        if BUDGET and time.monotonic() - start > BUDGET:
            print("bulk: time budget reached; next run continues", flush=True)
            break
        cik = f["cik"]
        dest = OUT / f"{cik}.json"
        if dest.exists():  # another worker may have fetched it since this run started
            try:
                rec = json.loads(dest.read_text())
                fresh = not (rec.get("form") == "13F-HR/A" and "filing_key" not in rec)
                if fresh and (f.get("filing_date") or "") <= (rec.get("indexed_date") or rec.get("filing_date") or ""):
                    f["ok"], f["position_count"], f["quarter"] = bool(rec.get("ok")), rec.get("position_count"), rec.get("quarter")
                    continue
            except ValueError:
                pass
        print(f"{done + 1}/{len(todo)} {cik} {f.get('name', '')[:40]}", flush=True)
        try:
            rec = ingest_one(cik)
        except Exception as exc:
            traceback.print_exc()
            rec = {"ok": False, "cik": cik, "error": str(exc)}
        transient = any(x in str(rec.get("error") or "") for x in ("GET failed", "timed out", "Connection"))
        if not transient:  # transient failures retry next run
            rec["indexed_date"] = f.get("filing_date") or ""
        write_shard(OUT / f"{cik}.json", rec)
        f["ok"] = bool(rec.get("ok"))
        f["position_count"] = rec.get("position_count")
        f["quarter"] = rec.get("quarter")
        done += 1
        if done % 50 == 0:
            checkpoint()
    checkpoint()
    print(f"bulk: fetched {done}; ok={catalog['holdings_ok']} fail={catalog['holdings_fail']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
