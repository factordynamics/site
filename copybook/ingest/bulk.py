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

from ingest.build import WEB, load_period, quarter_label
from ingest.edgar import fetch_submissions, get, list_13f, quarter_groups
from ingest.universe import parse_index, slugify

DATA = WEB / "data"
OUT = DATA / "f"
FB = DATA / "fb"  # full books per quarter; see datasets.py
LIMIT = int(os.environ.get("COPYBOOK_BULK_LIMIT", "0") or "0")
BUDGET = float(os.environ.get("COPYBOOK_BULK_BUDGET_S", "0") or "0")
MAX_ROWS = 500  # public shard cap by value; the full book is in fb/ (paid, R2)
SHARD_KEYS = (
    "ok", "cik", "name", "form", "accession", "filing_date", "report_date", "quarter",
    "sec_url", "position_count", "total_value", "values_in_thousands", "indexed_date", "error",
    "filing_key", "amendments", "unit_fix", "accepted_at", "empty_latest", "backfill_checked",
    "cover_total",  # tableValueTotal: enrich.py's in-dollars test (parse.unit_verdict)
)
# Rows are arrays in this column order to keep 9k shards small.
# shares is SSHPRNAMT as filed: a share count, or a principal amount where shares_type is PRN.
COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type")
# The full book (fb/, paid) adds per-row point-in-time provenance: the filing (original or amendment) that first
# disclosed the row and its EDGAR acceptance time. accepted.py fills them on books written without them.
# Unit fields: the value as filed, the factor to whole dollars (1000 for a book filed in thousands) and whether a
# unit fix changed it. Rescaled books written without them are fetched again (has_full_book).
FB_COLUMNS = COLUMNS + ("source_accession", "first_disclosed_at", "value_as_filed", "value_scale", "value_adjusted")


def numeric_cik(cik: str) -> bool:
    return cik.isdigit() and len(cik) == 10


def slim(rec: dict, max_rows: int | None = MAX_ROWS, columns: tuple = COLUMNS) -> dict:
    out = {k: rec[k] for k in SHARD_KEYS if k in rec}
    if rec.get("ok"):
        rows = rec.get("holdings") or rec.get("rows") or []
        if rows and isinstance(rows[0], list):
            rows = [dict(zip(rec.get("columns") or COLUMNS, r)) for r in rows]
        out["truncated"] = max_rows is not None and len(rows) > max_rows
        out["columns"] = list(columns)
        def cell(h: dict, k: str):
            if k == "shares_type":
                return h.get("shares_type") or "SH"
            if k == "shares" and h.get("shares_type") == "PRN":
                return int(h.get("principal_amount") or h.get("shares") or 0)
            if k == "source_accession":
                return h.get(k) or rec.get("accession")
            if k == "first_disclosed_at":
                return h.get(k) or rec.get("accepted_at")
            if k in ("value_scale", "value_adjusted"):
                filed, v = h.get("value_as_filed"), h.get("value") or 0
                if filed is None:
                    return None
                if k == "value_adjusted":
                    return abs(v - filed) > 0.5
                return float(f"{v / filed:.6g}") if filed else 1.0 if not v else None
            return int(h.get(k) or 0) if k in ("value", "shares") else h.get(k)

        out["rows"] = [[cell(h, k) for k in columns] for h in rows[:max_rows]]
    return out


def full_path(rec: dict) -> Path:
    return FB / rec["quarter"] / f"{rec['cik']}.json"


def write_json(dest: Path, body: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(json.dumps(body, separators=(",", ":")) + "\n")
    tmp.replace(dest)


def write_shard(dest: Path, rec: dict) -> None:
    """Public shard (top MAX_ROWS) plus the full book in fb/{quarter}/ (paid; R2 only)."""
    write_json(dest, slim(rec))
    if rec.get("ok") and rec.get("quarter"):
        write_json(full_path(rec), slim(rec, None, FB_COLUMNS) | {"source": "SEC EDGAR"})


def has_full_book(rec: dict) -> bool:
    """A shard with every position, or one whose full book is already in fb/ (copied there if needed)."""
    if not rec.get("ok") or not rec.get("quarter"):
        return True
    path = full_path(rec)
    if path.exists():
        try:  # every row needs its unit fields (1 and false when unscaled): a book written before them is fetched again
            return "value_as_filed" in (json.loads(path.read_text()).get("columns") or [])
        except ValueError:
            return False
    if rec.get("truncated"):
        return False
    write_json(path, rec | {"source": "SEC EDGAR"})
    return True


def ingest_one(cik: str) -> dict:
    submissions = fetch_submissions(cik)
    metas = list_13f(submissions)
    if not metas:
        return {"ok": False, "cik": cik, "error": "no 13F-HR"}
    last_error = "no usable table"
    empty = None  # a newer 13F-HR that lists no holdings (Presima and Redwood 2026Q2: one "None", $0 line)
    # Latest period whose original (or restated) book parses; falls back one quarter.
    for group in quarter_groups(metas, 2):
        try:
            loaded = load_period(cik, group, {})
            if loaded is None:
                last_error = f"empty {group[0].report_date}"
                empty = empty or {"quarter": quarter_label(group[0].report_date), "accession": group[0].accession,
                                  "filing_date": group[0].filing_date}
                continue
            return {"ok": True, "cik": cik, "name": submissions.get("name") or "", **loaded,
                    **({"empty_latest": empty} if empty else {})}
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
            if (f.get("filing_date") or "") <= checked and not stale_amend and has_full_book(rec):
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
                fresh = not (rec.get("form") == "13F-HR/A" and "filing_key" not in rec) and has_full_book(rec)
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
    print(f"bulk: late filings backfilled: {backfill_late(order, time.monotonic())}", flush=True)
    return 0


BACKFILL_BUDGET_S = float(os.environ.get("COPYBOOK_BACKFILL_BUDGET_S", "600"))


def backfill_late(order: list[dict], start: float) -> str:
    """fb/ books for stored quarters a filer filed on EDGAR after the SEC data set that covers them (Nordflint's 2026Q1
    and Q2, both filed Sep 4, after the Jun-Aug set). Each shard is checked once per set of stored quarters
    (backfill_checked); only filers missing a stored quarter before their latest are looked up."""
    stored = sorted(p.name for p in FB.glob("*Q?") if p.is_dir())
    key = ",".join(stored)
    looked = added = 0
    for f in order:
        if time.monotonic() - start > BACKFILL_BUDGET_S:
            break
        dest = OUT / f"{f['cik']}.json"
        try:
            rec = json.loads(dest.read_text()) if dest.exists() else None
        except ValueError:
            continue
        if not rec or not rec.get("ok") or not rec.get("quarter") or rec.get("backfill_checked") == key:
            continue
        missing = [q for q in stored if q < rec["quarter"] and not (FB / q / f"{f['cik']}.json").exists()]
        if missing:
            looked += 1
            try:
                subs = fetch_submissions(f["cik"])
                for group in quarter_groups(list_13f(subs), 8):
                    q = quarter_label(group[0].report_date)
                    if q not in missing:
                        continue
                    loaded = load_period(f["cik"], group, {})
                    if loaded:
                        book = {"ok": True, "cik": f["cik"], "name": subs.get("name") or rec.get("name") or "", **loaded}
                        write_json(FB / q / f"{f['cik']}.json", slim(book, None, FB_COLUMNS) | {"source": "SEC EDGAR"})
                        added += 1
            except Exception as exc:  # noqa: BLE001 - the next run tries again
                print(f"bulk: backfill {f['cik']}: {exc}", flush=True)
                continue
        write_json(dest, rec | {"backfill_checked": key})
    return f"{added} books for {looked} filers looked up"


if __name__ == "__main__":
    raise SystemExit(main())
