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

from ingest.figi import load_cache as load_cusip_map
from ingest.alerts import email_body, new_filings, previous_accessions, send_email
from ingest.edgar import (
    fetch_info_table,
    fetch_primary_doc,
    fetch_submissions,
    list_13f,
    table_value_total,
    unique_quarters,
)
from ingest.managers import MANAGERS, load_managers
from ingest.parse import (
    AggregatedHolding,
    aggregate_holdings,
    looks_like_thousands,
    parse_info_table,
    scale_if_thousands,
)

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
HISTORY_QUARTERS = int(os.environ.get("COPYBOOK_HISTORY_QUARTERS", "8"))
if os.environ.get("COPYBOOK_LATEST_ONLY") == "1":
    HISTORY_QUARTERS = 2  # latest plus prior quarter for changes
LITE_COUNT = 2000
LITE_HOLDERS = 8
_CUSIP_MAP: dict[str, str] | None = None


def quarter_label(report_date: str) -> str:
    if not report_date or len(report_date) < 7:
        return report_date or "—"
    year, month = int(report_date[:4]), int(report_date[5:7])
    q = (month - 1) // 3 + 1
    return f"{year}Q{q}"


def ticker_for(cusip: str) -> str | None:
    global _CUSIP_MAP
    if _CUSIP_MAP is None:
        _CUSIP_MAP = load_cusip_map()
    return _CUSIP_MAP.get(cusip) or None


def attach_tickers(holdings: list[AggregatedHolding]) -> None:
    for h in holdings:
        h.ticker = ticker_for(h.cusip)


def cached_quarters() -> dict[str, dict]:
    """Previously loaded filings by accession, so unchanged quarters are not refetched."""
    out: dict[str, dict] = {}
    for p in DATA.glob("*-history.json"):
        try:
            for q in json.loads(p.read_text()).get("history") or []:
                if q.get("accession"):
                    out[q["accession"]] = q
        except ValueError:
            continue
    return out


def with_changes(latest: dict, prev: dict | None) -> list[dict]:
    """Latest holdings with prior-quarter fields, plus exited positions as value-0 rows."""
    if prev is None:
        return [h | {"prev_shares": None, "prev_value": None, "change": None} for h in latest["holdings"]]
    before = {(h["cusip"], h["put_call"] or ""): h for h in prev["holdings"]}
    rows = []
    for h in latest["holdings"]:
        p = before.pop((h["cusip"], h["put_call"] or ""), None)
        if p is None:
            change = "new"
        elif h["shares"] > p["shares"]:
            change = "added"
        elif h["shares"] < p["shares"]:
            change = "trimmed"
        else:
            change = "unchanged"
        rows.append(
            h
            | {
                "prev_shares": p["shares"] if p else 0,
                "prev_value": p["value"] if p else 0,
                "change": change,
            }
        )
    for p in sorted(before.values(), key=lambda x: x["value"], reverse=True):
        rows.append(
            {
                "issuer": p["issuer"],
                "title": p["title"],
                "cusip": p["cusip"],
                "ticker": ticker_for(p["cusip"]),
                "value": 0,
                "shares": 0,
                "put_call": p["put_call"],
                "weight": 0.0,
                "prev_shares": p["shares"],
                "prev_value": p["value"],
                "change": "exited",
            }
        )
    return rows


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
    cache = cached_quarters()
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
                    loaded = cache.get(meta.accession) or load_filing(cik, meta)
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
            for q in history:
                for h in q["holdings"]:
                    h["ticker"] = ticker_for(h["cusip"])
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
    featured = featured_ciks()
    for m in managers_out:
        m["featured"] = m["cik"] in featured
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
                    "_holders": [(m["featured"], h["value"], m["slug"], m["manager"])],
                }
            else:
                b["total_value"] += h["value"]
                b["total_shares"] += h["shares"]
                b["num_investors"] += 1
                b["held_by"].append(m["slug"])
                b["held_by_names"].append(m["manager"])
                b["_holders"].append((m["featured"], h["value"], m["slug"], m["manager"]))
                if not b["ticker"] and h["ticker"]:
                    b["ticker"] = h["ticker"]

    grand_total = sum(b["total_value"] for b in buckets.values())
    copycat = []
    for b in buckets.values():
        n = b["num_investors"]
        weight = (b["total_value"] / grand_total) if grand_total else 0.0
        b["weight"] = weight
        b["conviction"] = n * weight
        holders = sorted(b.pop("_holders"), key=lambda x: (not x[0], -x[1]))
        b["held_by"] = [x[2] for x in holders]
        b["held_by_names"] = [x[3] for x in holders]
        b["held_by_featured"] = sum(1 for x in holders if x[0])
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
        "manager_count": len(ok),
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


def featured_ciks() -> set[str]:
    path = DATA / "universe.json"
    cur = json.loads(path.read_text()).get("curated") or [] if path.exists() else []
    found = {r["cik"] for r in cur if r.get("featured")}
    return found or {cik for cik, _, _, _ in MANAGERS}


def manager_json(m: dict) -> dict:
    out = {k: v for k, v in m.items() if k not in {"history", "holdings"}}
    hist = m.get("history") or []
    prev = hist[1] if len(hist) > 1 else None
    out["prev_quarter"] = prev["quarter"] if prev else None
    out["prev_report_date"] = prev["report_date"] if prev else None
    out["prev_accession"] = prev["accession"] if prev else None
    out["prev_total_value"] = prev["total_value"] if prev else None
    rows = with_changes({"holdings": m["holdings"]}, prev)
    out["changes"] = {
        c: sum(1 for r in rows if r["change"] == c)
        for c in ("new", "added", "trimmed", "exited", "unchanged")
    }
    out["holdings"] = rows
    return out


def write_json(payload: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    slim_managers = []
    for m in payload["managers"]:
        if not m.get("ok"):
            continue
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
        if not m.get("ok"):
            continue
        (DATA / f"{m['slug']}.json").write_text(json.dumps(manager_json(m), indent=1) + "\n")
        if m.get("history"):
            (DATA / f"{m['slug']}-history.json").write_text(
                json.dumps(
                    {
                        "slug": m["slug"],
                        "manager": m["manager"],
                        "cik": m["cik"],
                        "history_quarters": m.get("history_quarters") or [],
                        "history": m["history"],
                    },
                    separators=(",", ":"),
                )
                + "\n"
            )
    names = {m["slug"]: m["manager"] for m in payload["managers"]}
    (DATA / "copycat.json").write_text(json.dumps(payload["copycat"], separators=(",", ":")) + "\n")
    lite = [
        {
            "ticker": h["ticker"],
            "issuer": h["issuer"],
            "cusip": h["cusip"],
            "title": h["title"],
            "put_call": h["put_call"],
            "total_value": h["total_value"],
            "weight": h["weight"],
            "num_investors": h["num_investors"],
            "held_by": [{"slug": s, "name": names[s]} for s in h["held_by"][:LITE_HOLDERS]],
        }
        for h in payload["copycat"]["holdings"][:LITE_COUNT]
    ]
    (DATA / "copycat_lite.json").write_text(
        json.dumps(
            {
                "total_value": payload["copycat"]["total_value"],
                "num_positions": payload["copycat"]["num_positions"],
                "num_investors": payload["copycat"]["num_investors"],
                "holdings": lite,
            },
            separators=(",", ":"),
        )
        + "\n"
    )


def write_alerts(payload: dict) -> None:
    """alerts.json: this run's new filings plus a rolling feed keyed by accession.

    A mailer (Copy subscribers) diffs `recent` by accession, so a missed run
    never drops an alert.
    """
    prev = previous_accessions(DATA)
    filings = new_filings(payload["managers"], prev) if prev else []
    path = DATA / "alerts.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    seen = {f["accession"] for f in old.get("recent") or []}
    recent = [
        f | {"detected_at": payload["generated_at"]}
        for f in filings
        if f["accession"] not in seen and not f["is_first_seen"]
    ] + (old.get("recent") or [])
    status = None
    if filings:
        subject, body = email_body(filings, payload["generated_at"])
        status = send_email(subject, body)
    DATA.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "generated_at": payload["generated_at"],
                "new_filings": filings,
                "recent": recent[:500],
                "email_status": status,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"alerts: {len(filings)} new filings, email={status}")


def main() -> int:
    payload = ingest()
    write_alerts(payload)
    write_json(payload)
    print(
        f"wrote {payload['filed_count']}/{payload['manager_count']} managers, "
        f"{payload['copycat']['num_positions']} copycat names"
    )
    return 0 if payload["filed_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
