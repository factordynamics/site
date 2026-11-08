#!/usr/bin/env python3
"""Bulk export: every filer's full 13F book per quarter as data/bulk/{YYYYQn}.csv.gz.

Read from fb/{quarter}/{cik}.json (SEC Form 13F data sets and EDGAR, as filed). Paid: the
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
PART_RAW = 450_000_000  # uncompressed CSV per part; about 80 MB gzipped (one upload is capped near 100 MB)
HEADER = ("cik", "filer_name", "quarter", "report_date", "accession", "filing_date", "cusip", "ticker", "issuer",
          "title", "put_call", "shares", "shares_type", "value")


def rows(quarter: str):
    for path in sorted((DATA / "fb" / quarter).glob("*.json")):
        try:
            b = json.loads(path.read_text())
        except ValueError:
            continue
        if not b.get("ok"):
            continue
        cols = b["columns"]
        head = (b.get("cik") or path.stem, b.get("name") or "", b.get("quarter") or quarter, b.get("report_date") or "",
                b.get("accession") or "", b.get("filing_date") or "")
        for r in b.get("rows") or []:
            h = dict(zip(cols, r))
            yield head + (h.get("cusip") or "", h.get("ticker") or "", h.get("issuer") or "", h.get("title") or "",
                          h.get("put_call") or "", h.get("shares") or 0, h.get("shares_type") or "SH", h.get("value") or 0)


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
    quarters = argv or sorted(p.name for p in (DATA / "fb").iterdir() if p.is_dir())
    for q in quarters:
        paths = export(q)
        print(f"export: {q}: " + ", ".join(f"{p.name} {p.stat().st_size / 1e6:.1f} MB" for p in paths), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
