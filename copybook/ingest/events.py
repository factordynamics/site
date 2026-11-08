#!/usr/bin/env python3
"""Between-quarter moves for curated managers: Form 4 and Schedule 13D/13G.

SEC data only. Reads each curated manager's EDGAR submissions, keeps Form 4
filings where the manager is a reporting owner and Schedule 13D/13G filings
(structured XML since Dec 2024) about other issuers, filed after the period
end of the manager's latest 13F. Writes:

  data/events/{slug}.json   "since last 13F" feed per manager
  data/events.json          stream of the last STREAM_DAYS days for the alert mailer

Parsed filings are reused from the previous events/{slug}.json by accession,
so a refresh only fetches filings it has not seen.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.edgar import ARCHIVE_BASE, fetch_submissions, get

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
EVENTS = DATA / "events"
BUDGET_S = float(os.environ.get("COPYBOOK_EVENTS_BUDGET_S", "900"))
MAX_PER_MANAGER = 100  # newest filings parsed per manager per window
STREAM_DAYS = 30
LOOKBACK_DAYS = 200  # window start when a manager has no recent 13F
PARSER = 2  # bump to reparse every cached filing after a parser change

FORM4 = {"4", "4/A"}
SCHEDULE = {"SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A"}
CODES = {
    "P": "open-market purchase",
    "S": "open-market sale",
    "A": "grant or award",
    "M": "option exercise",
    "X": "option exercise",
    "C": "conversion",
    "D": "disposition to issuer",
    "F": "tax withholding",
    "G": "gift",
    "J": "other",
    "W": "will or inheritance",
}
RULE = (
    "Form 4 filings where the manager is a reporting owner, and Schedule 13D/13G filings "
    "(new and amended) the manager filed about another company, filed after the period end "
    "of the manager's latest 13F. Values are as reported on the filing; Copybook adds no prices."
)


def _tag(xml: str, name: str) -> str | None:
    m = re.search(rf"<(?:\w+:)?{name}\b[^>]*>\s*([^<]*?)\s*<", xml, re.I)
    return m.group(1) if m else None


def _tags(xml: str, name: str) -> list[str]:
    return [v.strip() for v in re.findall(rf"<(?:\w+:)?{name}\b[^>]*>\s*([^<]*?)\s*<", xml, re.I)]


def _blocks(xml: str, name: str) -> list[str]:
    return re.findall(rf"<(?:\w+:)?{name}\b[^>]*>(.*?)</(?:\w+:)?{name}>", xml, re.S | re.I)


def _num(s: str | None) -> float | None:
    if s is None:
        return None
    try:
        return float(s.replace(",", "").strip())
    except ValueError:
        return None


def _value(block: str, name: str) -> str | None:
    """Form 4 wraps most fields as <name><value>x</value></name>."""
    inner = _blocks(block, name)
    if not inner:
        return None
    v = _tag(inner[0], "value")
    return v if v is not None else inner[0].strip() or None


def _mdy(s: str | None) -> str | None:
    if not s:
        return None
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", s)
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else s[:10]


def holdings_after(xml: str) -> float | None:
    """Total common shares owned after the filing, across every holding entity.

    Each row reports what one owner line (direct, or indirect through a named
    subsidiary) holds afterwards, so take the last figure per line and add them up.
    """
    last: dict[tuple, float] = {}
    for table in ("nonDerivativeTransaction", "nonDerivativeHolding"):
        for b in _blocks(xml, table):
            v = _num(_value(b, "sharesOwnedFollowingTransaction"))
            if v is None:
                continue
            nature = _value(b, "natureOfOwnership") or ""
            direct = _value(b, "directOrIndirectOwnership") or ""
            last[((_value(b, "securityTitle") or "").lower(), direct, nature.lower())] = v
    return sum(last.values()) if last else None


def clean_ticker(raw: str | None) -> str | None:
    t = (raw or "").strip().upper()
    return t if re.fullmatch(r"[A-Z][A-Z0-9.\-]{0,6}", t) and t not in ("NA", "NONE", "N") else None


def parse_form4(xml: str, cik: str) -> dict | None:
    """One Form 4, or None when the manager is not a reporting owner (e.g. its own insiders)."""
    owners = [c.zfill(10) for c in _tags(xml, "rptOwnerCik")]
    if cik.zfill(10) not in owners:
        return None
    txs = []
    for table, derivative in (("nonDerivativeTransaction", False), ("derivativeTransaction", True)):
        for b in _blocks(xml, table):
            code = _tag(_blocks(b, "transactionCoding")[0], "transactionCode") if _blocks(b, "transactionCoding") else None
            shares = _num(_value(b, "transactionShares"))
            price = _num(_value(b, "transactionPricePerShare"))
            ad = _value(b, "transactionAcquiredDisposedCode")
            txs.append(
                {
                    "date": (_value(b, "transactionDate") or "")[:10] or None,
                    "code": code,
                    "code_label": CODES.get(code or "", "other"),
                    "security": _value(b, "securityTitle"),
                    "derivative": derivative,
                    "acquired": ad == "A" if ad else None,
                    "shares": shares,
                    "price": price,
                    "shares_after": _num(_value(b, "sharesOwnedFollowingTransaction")),
                }
            )
    common = [t for t in txs if not t["derivative"]]
    trades = [t for t in common if t["code"] in ("P", "S") and t["shares"]]
    bought = sum(t["shares"] for t in trades if t["code"] == "P")
    sold = sum(t["shares"] for t in trades if t["code"] == "S")
    value = sum(t["shares"] * t["price"] for t in trades if t["price"] is not None)
    net = bought - sold
    if trades:
        action = "buy" if net > 0 else "sell" if net < 0 else "mixed"
    else:
        action = "other"
    after = holdings_after(xml)
    dates = sorted(t["date"] for t in txs if t["date"])
    return {
        "kind": "form4",
        "issuer": _tag(xml, "issuerName"),
        "issuer_cik": (_tag(xml, "issuerCik") or "").zfill(10) or None,
        "ticker": clean_ticker(_tag(xml, "issuerTradingSymbol")),
        "cusip": None,
        "event_date": dates[-1] if dates else _tag(xml, "periodOfReport"),
        "action": action,
        "shares": net if trades else None,
        "value_usd": round(value, 2) if trades and value else None,
        "avg_price": round(value / (bought + sold), 4) if trades and value and (bought + sold) else None,
        "shares_after": after,
        "percent_of_class": None,
        "ten_percent_owner": "true" in [v.lower() for v in _tags(xml, "isTenPercentOwner")],
        "transactions": txs,
    }


def parse_schedule(xml: str, cik: str) -> dict | None:
    """One Schedule 13D/13G (XML). None when it is about the manager itself."""
    issuer_cik = (_tag(xml, "issuerCIK") or _tag(xml, "issuerCik") or "").zfill(10)
    if issuer_cik == cik.zfill(10):
        return None
    form = (_tag(xml, "submissionType") or "").upper()
    is_d = "13D" in form
    owned = _tags(xml, "aggregateAmountOwned") or _tags(xml, "reportingPersonBeneficiallyOwnedAggregateNumberOfShares")
    pct = _tags(xml, "percentOfClass") or _tags(xml, "classPercent")
    # Joint filings list every reporting person; the group's largest figure is the stake.
    shares = max((v for v in (_num(s) for s in owned) if v is not None), default=None)
    percent = max((v for v in (_num(s) for s in pct) if v is not None), default=None)
    amendment = form.endswith("/A")
    if shares == 0 or (percent is not None and percent < 5 and amendment):
        action = "below_threshold"
    else:
        action = "stake_update" if amendment else "new_stake"
    return {
        "kind": "13d" if is_d else "13g",
        "issuer": _tag(xml, "issuerName"),
        "issuer_cik": issuer_cik if issuer_cik.strip("0") else None,
        "ticker": None,
        "cusip": (_tag(xml, "issuerCusipNumber") or "").upper() or None,
        "event_date": _mdy(_tag(xml, "dateOfEvent") or _tag(xml, "eventDateRequiresFilingThisStatement")),
        "action": action,
        "shares": None,
        "value_usd": None,
        "avg_price": None,
        "shares_after": shares,
        "percent_of_class": percent,
        "amendment_no": int(_num(_tag(xml, "amendmentNo")) or 0) or None,
        "transactions": [],
    }


def doc_url(cik: str, accession: str, primary: str) -> str:
    raw = primary.rsplit("/", 1)[-1]  # drop the xsl rendering directory to get the raw XML
    return f"{ARCHIVE_BASE}/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{raw}"


def candidate_filings(submissions: dict, since: str, limit: int | None = MAX_PER_MANAGER) -> list[dict]:
    r = submissions.get("filings", {}).get("recent", {})
    out = []
    for i, form in enumerate(r.get("form", [])):
        if form not in FORM4 and form not in SCHEDULE:
            continue
        if r["filingDate"][i] <= since:
            continue
        out.append(
            {
                "form": form,
                "accession": r["accessionNumber"][i],
                "filing_date": r["filingDate"][i],
                "primary": r.get("primaryDocument", [""] * (i + 1))[i] or "",
            }
        )
    out.sort(key=lambda f: (f["filing_date"], f["accession"]), reverse=True)
    return out[:limit] if limit else out


def parse_filing(cik: str, f: dict) -> dict | None:
    if not f["primary"].lower().endswith(".xml"):
        return None
    xml = get(doc_url(cik, f["accession"], f["primary"])).decode("utf-8", errors="replace")
    return parse_form4(xml, cik) if f["form"] in FORM4 else parse_schedule(xml, cik)


def load_securities() -> tuple[dict, dict]:
    path = DATA / "securities.json"
    by_cusip = json.loads(path.read_text()) if path.exists() else {}
    by_ticker = {}
    for cusip, row in by_cusip.items():
        if row.get("ticker"):
            by_ticker.setdefault(row["ticker"], (cusip, row))
    return by_cusip, by_ticker


def enrich(ev: dict, book: dict[str, dict], by_cusip: dict, by_ticker: dict) -> None:
    """Fill ticker, clean name and sector, and compare with the latest 13F position."""
    row = by_cusip.get(ev.get("cusip") or "")
    if row is None and ev.get("cusip"):
        # 13D/G cover pages give the issuer CUSIP; 13F lines may use any 9-char class CUSIP.
        row = next((r for c, r in by_cusip.items() if c[:6] == ev["cusip"][:6] and r.get("ticker")), None)
    if row is None and ev.get("ticker") in by_ticker:
        ev["cusip"], row = by_ticker[ev["ticker"]]
    row = row or {}
    ev["ticker"] = ev.get("ticker") or row.get("ticker")
    ev["display_name"] = row.get("name") or (ev.get("issuer") or "").title() or None
    ev["sector"] = row.get("sector")
    held = None
    if ev.get("cusip"):
        held = [h for h in book.values() if h["cusip"][:6] == ev["cusip"][:6] and not h.get("put_call")]
    if not held and ev.get("ticker"):
        held = [h for h in book.values() if h.get("ticker") == ev["ticker"] and not h.get("put_call")]
    shares_13f = sum(h.get("shares") or 0 for h in held) if held else 0
    ev["shares_in_13f"] = shares_13f
    after = ev.get("shares_after")
    ev["change_vs_13f"] = after - shares_13f if after is not None and shares_13f else None


def manager_events(m: dict, submissions: dict, previous: dict, deadline: float) -> tuple[list[dict], str]:
    report_date = m.get("report_date") or ""
    floor = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    since = max(report_date, floor)
    events = []
    found = candidate_filings(submissions, since, None)
    truncated = len(found) > MAX_PER_MANAGER
    for f in found[:MAX_PER_MANAGER]:
        key = f["accession"]
        parsed = previous.get(key)
        if parsed is None:
            if time.monotonic() > deadline:
                continue
            try:
                parsed = parse_filing(m["cik"], f) or {"skip": True}
            except Exception as e:  # noqa: BLE001 - one bad filing must not drop the feed
                print(f"  events {m['slug']} {key}: {e}", file=sys.stderr)
                continue
        if parsed.get("skip"):
            events.append({"id": key, "skip": True, "filing_date": f["filing_date"]})
            continue
        ev = {k: v for k, v in parsed.items() if k not in ("id", "slug", "manager", "form", "filing_date", "url")}
        events.append(
            {
                "id": key,
                "slug": m["slug"],
                "manager": m.get("manager"),
                "form": f["form"],
                "filing_date": f["filing_date"],
                "url": f"{ARCHIVE_BASE}/Archives/edgar/data/{int(m['cik'])}/{key.replace('-', '')}/{key}-index.html",
                **ev,
            }
        )
    return events, since, truncated


def main() -> int:
    index_path = DATA / "index.json"
    if not index_path.exists():
        print("events: no index.json", file=sys.stderr)
        return 1
    managers = [m for m in json.loads(index_path.read_text()).get("managers", []) if m.get("cik")]
    by_cusip, by_ticker = load_securities()
    EVENTS.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + BUDGET_S
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    stream_floor = (date.today() - timedelta(days=STREAM_DAYS)).isoformat()
    stream, summary = [], {}
    for m in managers:
        slug = m["slug"]
        path = EVENTS / f"{slug}.json"
        old = json.loads(path.read_text()) if path.exists() else {}
        previous = {e["id"]: e for e in old.get("events", []) + old.get("skipped", [])} if old.get("parser") == PARSER else {}
        try:
            submissions = fetch_submissions(m["cik"])
        except Exception as e:  # noqa: BLE001
            print(f"events {slug}: submissions failed: {e}", file=sys.stderr)
            continue
        rows, since, truncated = manager_events(m, submissions, previous, deadline)
        book_path = DATA / f"{slug}.json"
        book = {}
        if book_path.exists():
            for h in json.loads(book_path.read_text()).get("holdings") or []:
                book[f"{h.get('cusip')}:{h.get('put_call')}"] = h
        events = [e for e in rows if not e.get("skip")]
        for ev in events:
            enrich(ev, book, by_cusip, by_ticker)
        payload = {
            "slug": slug,
            "manager": m.get("manager"),
            "cik": m["cik"],
            "updated_at": now,
            "parser": PARSER,
            "since_report_date": since,
            "latest_13f_report_date": m.get("report_date"),
            "latest_13f_quarter": m.get("quarter"),
            "rule": RULE,
            "truncated": truncated,  # more than MAX_PER_MANAGER filings since the 13F; newest kept
            "events": events,
            "skipped": [{"id": e["id"], "skip": True, "filing_date": e["filing_date"]} for e in rows if e.get("skip")],
        }
        path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
        summary[slug] = {
            "count": len(events),
            "latest_filing_date": max((e["filing_date"] for e in events), default=None),
        }
        stream.extend(e for e in events if e["filing_date"] >= stream_floor)
    stream.sort(key=lambda e: (e["filing_date"], e["id"]), reverse=True)
    for ev in stream:
        ev.pop("transactions", None)  # full detail stays in events/{slug}.json
    (DATA / "events.json").write_text(
        json.dumps(
            {
                "updated_at": now,
                "rule": RULE,
                "window_days": STREAM_DAYS,
                "managers": summary,
                "events": stream,
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    print(f"events: {sum(s['count'] for s in summary.values())} since-13F events, {len(stream)} in the {STREAM_DAYS}-day stream")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
