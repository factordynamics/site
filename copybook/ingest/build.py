#!/usr/bin/env python3
"""Ingest latest 13F-HR filings and generate the Copybook static site."""

from __future__ import annotations

import json
import sys
import traceback
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.cusips import KNOWN_CUSIPS
from ingest.alerts import email_body, new_filings, previous_accessions, send_email
from ingest.csvutil import holding_row, write_rows
from ingest.edgar import (
    fetch_info_table,
    fetch_primary_doc,
    fetch_submissions,
    list_13f,
    table_value_total,
    unique_quarters,
)
from ingest.managers import MANAGERS, load_managers
from ingest.pages import write_site
from ingest.parse import (
    AggregatedHolding,
    aggregate_holdings,
    looks_like_thousands,
    parse_info_table,
    scale_if_thousands,
)

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
CSV_DIR = WEB / "csv"
HISTORY_QUARTERS = int(os.environ.get("COPYBOOK_HISTORY_QUARTERS", "8"))
if os.environ.get("COPYBOOK_LATEST_ONLY") == "1":
    HISTORY_QUARTERS = 1


def quarter_label(report_date: str) -> str:
    if not report_date or len(report_date) < 7:
        return report_date or "—"
    year, month = int(report_date[:4]), int(report_date[5:7])
    q = (month - 1) // 3 + 1
    return f"{year}Q{q}"


def attach_tickers(holdings: list[AggregatedHolding]) -> None:
    for h in holdings:
        known = KNOWN_CUSIPS.get(h.cusip)
        if known and known[0]:
            h.ticker = known[0]


def filing_url(cik: str, accession: str) -> str:
    cik_stripped = str(int(cik))
    acc = accession.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_stripped}/{acc}/{accession}-index.html"


def load_filing(cik: str, meta) -> dict | None:
    xml = fetch_info_table(cik, meta.accession)
    rows = parse_info_table(xml)
    holdings = aggregate_holdings(rows)
    cover_total = table_value_total(fetch_primary_doc(cik, meta.accession))
    raw_total = sum(h.value for h in holdings)
    thousands = looks_like_thousands(raw_total, cover_total)
    scale_if_thousands(holdings, thousands)
    attach_tickers(holdings)
    holdings = [h for h in holdings if h.value > 0 and h.cusip != "000000000"]
    total = sum(h.value for h in holdings)
    if total <= 0 or not holdings:
        return None
    return {
        "form": meta.form,
        "accession": meta.accession,
        "filing_date": meta.filing_date,
        "report_date": meta.report_date,
        "quarter": quarter_label(meta.report_date),
        "sec_url": filing_url(cik, meta.accession),
        "line_count": len(rows),
        "position_count": len(holdings),
        "values_in_thousands": thousands,
        "total_value": total,
        "holdings": [
            {
                "issuer": h.issuer,
                "title": h.title,
                "cusip": h.cusip,
                "ticker": h.ticker,
                "value": h.value,
                "shares": h.shares,
                "put_call": h.put_call,
                "weight": (h.value / total) if total else 0.0,
            }
            for h in holdings
        ],
    }


def ingest() -> dict:
    managers_out = []
    errors = []
    roster = load_managers()
    for cik, name, manager, slug in roster:
        print(f"fetch {slug} ({cik})", flush=True)
        try:
            submissions = fetch_submissions(cik)
            metas = list_13f(submissions)
            if not metas:
                errors.append({"slug": slug, "error": "no 13F-HR found"})
                managers_out.append(
                    {
                        "cik": cik,
                        "name": name,
                        "manager": manager,
                        "slug": slug,
                        "ok": False,
                        "error": "No 13F-HR on EDGAR",
                    }
                )
                continue
            last_error = "No usable 13F information table"
            history = []
            for meta in unique_quarters(metas, HISTORY_QUARTERS):
                try:
                    loaded = load_filing(cik, meta)
                    if loaded is None:
                        last_error = f"Empty 13F information table for {meta.accession}"
                        continue
                    history.append(loaded)
                except Exception as inner:
                    last_error = str(inner)
                    continue
            if not history:
                raise FileNotFoundError(last_error)
            latest = history[0]
            managers_out.append(
                {
                    "cik": cik,
                    "name": name,
                    "manager": manager,
                    "slug": slug,
                    "ok": True,
                    **{k: latest[k] for k in latest if k != "holdings"},
                    "holdings": latest["holdings"],
                    "history": [
                        {k: q[k] for k in q if k != "holdings"} | {"holdings": q["holdings"]}
                        for q in history
                    ],
                    "history_quarters": [q["quarter"] for q in history],
                }
            )
        except Exception as exc:
            traceback.print_exc()
            errors.append({"slug": slug, "error": str(exc)})
            managers_out.append(
                {
                    "cik": cik,
                    "name": name,
                    "manager": manager,
                    "slug": slug,
                    "ok": False,
                    "error": str(exc),
                }
            )

    ok = [m for m in managers_out if m.get("ok")]
    buckets: dict[str, dict] = {}
    for m in ok:
        for h in m["holdings"]:
            key = h["cusip"] + "|" + (h["put_call"] or "")
            b = buckets.get(key)
            if b is None:
                buckets[key] = {
                    "issuer": h["issuer"],
                    "title": h["title"],
                    "cusip": h["cusip"],
                    "ticker": h["ticker"],
                    "put_call": h["put_call"],
                    "total_value": h["value"],
                    "total_shares": h["shares"],
                    "num_investors": 1,
                    "held_by": [m["slug"]],
                    "held_by_names": [m["manager"]],
                }
            else:
                b["total_value"] += h["value"]
                b["total_shares"] += h["shares"]
                b["num_investors"] += 1
                b["held_by"].append(m["slug"])
                b["held_by_names"].append(m["manager"])
                if not b["ticker"] and h["ticker"]:
                    b["ticker"] = h["ticker"]

    grand_total = sum(b["total_value"] for b in buckets.values())
    copycat = []
    for b in buckets.values():
        n = b["num_investors"]
        weight = (b["total_value"] / grand_total) if grand_total else 0.0
        b["weight"] = weight
        b["conviction"] = n * weight
        copycat.append(b)
    copycat.sort(key=lambda x: x["total_value"], reverse=True)

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "SEC EDGAR 13F-HR, as filed",
        "disclaimer": (
            "Holdings and values are taken from each filer's 13F information table. "
            "Values are quarter-end, reported about 45 days after quarter-end, and are "
            "not live prices. 13F omits shorts, many options, and filers under $100M AUM. "
            "Not investment advice."
        ),
        "manager_count": len(roster),
        "filed_count": len(ok),
        "errors": errors,
        "managers": managers_out,
        "copycat": {
            "total_value": grand_total,
            "num_positions": len(copycat),
            "num_investors": len(ok),
            "holdings": copycat,
        },
    }


def write_json(payload: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    slim_managers = []
    for m in payload["managers"]:
        entry = {
            k: v
            for k, v in m.items()
            if k not in {"holdings", "history"}
        }
        if m.get("ok"):
            entry["top"] = m["holdings"][:8]
        slim_managers.append(entry)
    (DATA / "index.json").write_text(
        json.dumps(
            {
                "generated_at": payload["generated_at"],
                "source": payload["source"],
                "disclaimer": payload["disclaimer"],
                "filed_count": payload["filed_count"],
                "manager_count": payload["manager_count"],
                "copycat_total_value": payload["copycat"]["total_value"],
                "managers": slim_managers,
                "copycat_top": payload["copycat"]["holdings"][:20],
            },
            indent=2,
        )
        + "\n"
    )
    for m in payload["managers"]:
        slim = {k: v for k, v in m.items() if k != "history"}
        (DATA / f"{m['slug']}.json").write_text(json.dumps(slim, indent=2) + "\n")
        if m.get("ok") and m.get("history"):
            (DATA / f"{m['slug']}-history.json").write_text(
                json.dumps(
                    {
                        "slug": m["slug"],
                        "manager": m["manager"],
                        "cik": m["cik"],
                        "history_quarters": m.get("history_quarters") or [],
                        "history": m["history"],
                    },
                    indent=2,
                )
                + "\n"
            )
    (DATA / "copycat.json").write_text(json.dumps(payload["copycat"], indent=2) + "\n")


def write_csv(payload: dict) -> None:
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    latest_rows = []
    history_rows = []
    for m in payload["managers"]:
        if not m.get("ok"):
            continue
        for h in m.get("holdings") or []:
            latest_rows.append(holding_row(m, h))
        for q in m.get("history") or [{"holdings": m.get("holdings") or [], **m}]:
            for h in q.get("holdings") or []:
                history_rows.append(holding_row(m, h, q))
    write_rows(CSV_DIR / "latest.csv", latest_rows)
    write_rows(CSV_DIR / "history.csv", history_rows)
    copycat_rows = [
        {
            "manager": "copycat",
            "slug": "copycat",
            "cik": "",
            "quarter": "",
            "report_date": "",
            "filing_date": payload.get("generated_at"),
            "accession": "",
            "ticker": h.get("ticker") or "",
            "issuer": h.get("issuer") or "",
            "cusip": h.get("cusip") or "",
            "title": h.get("title") or "",
            "put_call": h.get("put_call") or "",
            "shares": h.get("total_shares", 0),
            "value_usd": h.get("total_value", 0),
            "weight": h.get("weight", 0),
        }
        for h in payload["copycat"].get("holdings") or []
    ]
    write_rows(CSV_DIR / "copycat.csv", copycat_rows)
    (CSV_DIR / "README.txt").write_text(
        "Copybook CSV exports. Ready for Copy ($9/mo). Not linked on the free site.\n"
        "Source: SEC EDGAR 13F-HR, as filed. Not investment advice.\n"
    )


def write_alerts(payload: dict) -> None:
    prev = previous_accessions(DATA)
    filings = new_filings(payload["managers"], prev)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "alerts.json").write_text(
        json.dumps(
            {
                "generated_at": payload["generated_at"],
                "new_filings": filings,
                "email_status": None,
            },
            indent=2,
        )
        + "\n"
    )
    if not filings:
        print("alerts: no new filings")
        return
    subject, body = email_body(filings, payload["generated_at"])
    status = send_email(subject, body)
    alert = json.loads((DATA / "alerts.json").read_text())
    alert["email_status"] = status
    (DATA / "alerts.json").write_text(json.dumps(alert, indent=2) + "\n")
    print(f"alerts: {len(filings)} new filings, email={status}")


def main() -> int:
    payload = ingest()
    write_alerts(payload)
    write_json(payload)
    write_csv(payload)
    if os.environ.get("COPYBOOK_JSON_ONLY") != "1":
        write_site(payload)
    print(
        f"wrote {payload['filed_count']}/{payload['manager_count']} managers, "
        f"{payload['copycat']['num_positions']} copycat names"
    )
    return 0 if payload["filed_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
