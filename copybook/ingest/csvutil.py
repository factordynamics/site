"""CSV writers for Copy (paywalled exports)."""

from __future__ import annotations

import csv
from pathlib import Path


HOLDING_FIELDS = [
    "manager",
    "slug",
    "cik",
    "quarter",
    "report_date",
    "filing_date",
    "accession",
    "ticker",
    "issuer",
    "cusip",
    "title",
    "put_call",
    "shares",
    "value_usd",
    "weight",
]


def write_rows(path: Path, rows: list[dict], fields: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = fields or HOLDING_FIELDS
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in cols})


def holding_row(manager: dict, holding: dict, quarter: dict | None = None) -> dict:
    src = quarter or manager
    return {
        "manager": manager.get("manager"),
        "slug": manager.get("slug"),
        "cik": manager.get("cik"),
        "quarter": src.get("quarter"),
        "report_date": src.get("report_date"),
        "filing_date": src.get("filing_date"),
        "accession": src.get("accession"),
        "ticker": holding.get("ticker") or "",
        "issuer": holding.get("issuer") or "",
        "cusip": holding.get("cusip") or "",
        "title": holding.get("title") or "",
        "put_call": holding.get("put_call") or "",
        "shares": holding.get("shares", 0),
        "value_usd": holding.get("value", 0),
        "weight": holding.get("weight", 0),
    }
