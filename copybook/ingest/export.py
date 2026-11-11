#!/usr/bin/env python3
"""Bulk export: every filer's full 13F book per quarter as data/bulk/{YYYYQn}.csv.gz.

Every row /v1 serves: fq/{quarter}/{cik}.json (moves.py: per-line unit fixes, exited and zero-value lines,
per-row source filing and change) where present, else fb/{quarter}/{cik}.json (SEC Form 13F data sets and EDGAR,
as filed); a curated fund's quarter comes from h/{slug}/{quarter}.json, the same book /v1 serves (restatements,
unit fixes and NEW HOLDINGS amendments applied, per-row source filing). Paid: the
files go to R2 as bulk/{quarter}.csv.gz (upload_history.py) for the Copy API's /v1/bulk.
Output is deterministic (gzip mtime 0, rows sorted), so an unchanged quarter is not re-sent.
A quarter larger than PART_RAW is written as bulk/{quarter}.part{N}.csv.gz instead,
each part with the header row, since one upload request is limited in size.

    python ingest/export.py            # every quarter in fb/
    python ingest/export.py 2026Q2     # given quarters
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
OUT = DATA / "bulk"
MIN_BOOKS = 5000
PART_RAW = 450_000_000  # uncompressed CSV per part; about 80 MB gzipped (one upload is capped near 100 MB)
HEADER = ("cik", "filer_name", "quarter", "report_date", "accession", "filing_date", "cusip", "ticker", "issuer",
          "title", "put_call", "shares", "shares_type", "value", "accepted_at", "source_accession", "first_disclosed_at",
          "change")


def curated_books(quarter: str) -> dict[str, dict]:
    """cik -> the curated fund's book for the quarter (h/{slug}/{quarter}.json), as /v1 serves it."""
    try:
        managers = json.loads((DATA / "index.json").read_text())["managers"]
    except (OSError, ValueError, KeyError):
        return {}
    out = {}
    for m in managers:
        path = DATA / "h" / (m.get("slug") or "") / f"{quarter}.json"
        if m.get("cik") and path.exists():
            try:
                out[m["cik"]] = json.loads(path.read_text())
            except ValueError:
                continue
    return out


def rows(quarter: str):
    curated = curated_books(quarter)
    paths = {p.stem: p for p in (DATA / "fb" / quarter).glob("*.json")}
    paths |= {p.stem: p for p in (DATA / "fq" / quarter).glob("*.json")}  # the book /v1 serves
    for cik in sorted(set(paths) | set(curated)):
        if cik in curated:
            b = curated[cik]
            head = (cik, b.get("manager") or "", quarter, b.get("report_date") or "", b.get("accession") or "",
                    b.get("filing_date") or "")
            for h in b.get("holdings") or []:
                yield head + (h.get("cusip") or "", h.get("ticker") or "", h.get("issuer") or "", h.get("title") or "",
                              h.get("put_call") or "", h.get("shares") or h.get("principal_amount") or 0,
                              h.get("shares_type") or "SH", h.get("value") or 0, b.get("accepted_at") or "",
                              h.get("source_accession") or b.get("accession") or "",
                              h.get("first_disclosed_at") or b.get("accepted_at") or "", h.get("change") or "")
            continue
        try:
            b = json.loads(paths[cik].read_text())
        except ValueError:
            continue
        if b.get("ok") is False or not b.get("columns"):
            continue
        cols = b["columns"]
        head = (b.get("cik") or cik, b.get("name") or "", b.get("quarter") or quarter, b.get("report_date") or "",
                b.get("accession") or "", b.get("filing_date") or "")
        for r in b.get("rows") or []:
            h = dict(zip(cols, r))
            yield head + (h.get("cusip") or "", h.get("ticker") or "", h.get("issuer") or "", h.get("title") or "",
                          h.get("put_call") or "", h.get("shares") or 0, h.get("shares_type") or "SH", h.get("value") or 0,
                          b.get("accepted_at") or "", h.get("source_accession") or b.get("accession") or "",
                          h.get("first_disclosed_at") or b.get("accepted_at") or "", h.get("change") or "")


def export(quarter: str) -> list[Path]:
    OUT.mkdir(parents=True, exist_ok=True)
    parts: list[bytes] = []
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")

    def flush() -> None:
        raw = buf.getvalue().encode("utf-8")
        parts.append(gzip.compress(raw, compresslevel=9, mtime=0))
        buf.seek(0)
        buf.truncate()

    w.writerow(HEADER)
    for row in rows(quarter):
        w.writerow(row)
        if buf.tell() > PART_RAW:
            flush()
            w.writerow(HEADER)
    flush()
    names = [f"{quarter}.csv.gz"] if len(parts) == 1 else [f"{quarter}.part{i + 1}.csv.gz" for i in range(len(parts))]
    for old in OUT.glob(f"{quarter}.*csv.gz"):
        if old.name not in names:
            old.unlink()
    out = []
    for name, body in zip(names, parts):
        path = OUT / name
        if not path.exists() or path.read_bytes() != body:
            path.write_bytes(body)
        out.append(path)
    return out


def main(argv: list[str]) -> int:
    # Complete quarters only: a full SEC data set behind it (.complete) or most filers' books. Folders with a
    # handful of live-EDGAR books (written as single filers refresh) would publish as stubs.
    quarters = argv or sorted(p.name for p in (DATA / "fb").iterdir() if p.is_dir() and (
        (p / ".complete").exists() or sum(1 for _ in p.glob("*.json")) >= MIN_BOOKS))
    for q in quarters:
        paths = export(q)
        print(f"export: {q}: " + ", ".join(f"{p.name} {p.stat().st_size / 1e6:.1f} MB" for p in paths), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
