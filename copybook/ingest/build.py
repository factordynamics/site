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
from ingest.alerts import MAX_AGE_DAYS, age_days, email_body, new_filings, next_periods, previous_periods, send_email
from ingest.edgar import (
    fetch_info_table,
    fetch_primary_doc,
    fetch_submissions,
    list_13f,
    table_value_total,
    amendment_type,
    list_notices,
    notice_reporters,
    quarter_groups,
)
from ingest.managers import MANAGERS, load_managers
from ingest.parse import (
    AggregatedHolding,
    aggregate_holdings,
    looks_like_thousands,
    parse_info_table,
    scale_if_thousands,
    consensus_factor,
    consensus_prices,
    row_overstated,
    unit_fix,
)

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
HISTORY_QUARTERS = int(os.environ.get("COPYBOOK_HISTORY_QUARTERS", "8"))
if os.environ.get("COPYBOOK_LATEST_ONLY") == "1":
    HISTORY_QUARTERS = 2  # latest plus prior quarter for changes
LITE_COUNT = 2000
TOP_ROWS = 50  # preview rows per quarter in {slug}-history.json; full books are in h/
HIST = DATA / "h"
AMEND_PATH = DATA / "amendments.json"
NOTICE_PATH = DATA / "notices.json"
_NOTICES: dict[str, dict] | None = None
_SUBS: dict[str, dict] = {}
INACTIVE_AFTER = 4  # quarters behind the expected period before a filer is retired
_AMEND: dict[str, str] | None = None
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
    for p in HIST.glob("*/*.json"):
        try:
            q = json.loads(p.read_text())
        except ValueError:
            continue
        if q.get("accession") and not q.get("truncated"):
            for k in ("slug", "manager", "cik"):
                q.pop(k, None)
            out[q.get("filing_key") or q["accession"]] = q
    return out


def amend_type(cik: str, meta) -> str:
    """Cached cover-page amendmentType; it never changes for an accession."""
    global _AMEND
    if _AMEND is None:
        _AMEND = json.loads(AMEND_PATH.read_text()) if AMEND_PATH.exists() else {}
    if meta.accession not in _AMEND:
        _AMEND[meta.accession] = amendment_type(cik, meta.accession)
    return _AMEND[meta.accession]


def save_amend_types() -> None:
    if _AMEND is not None:
        AMEND_PATH.write_text(json.dumps(dict(sorted(_AMEND.items())), indent=0) + "\n")
    if _NOTICES is not None:
        NOTICE_PATH.write_text(json.dumps(dict(sorted(_NOTICES.items())), indent=1) + "\n")


def notice_info(cik: str, meta) -> dict:
    """Cached 13F-NT cover page: which manager reports this filer's holdings."""
    global _NOTICES
    if _NOTICES is None:
        _NOTICES = json.loads(NOTICE_PATH.read_text()) if NOTICE_PATH.exists() else {}
    if meta.accession not in _NOTICES:
        _NOTICES[meta.accession] = notice_reporters(cik, meta.accession)
    return _NOTICES[meta.accession]


def submissions_for(cik: str) -> dict:
    if cik not in _SUBS:
        _SUBS[cik] = fetch_submissions(cik)
    return _SUBS[cik]


def expected_report_date(today: str) -> str:
    """Latest quarter-end whose 13F deadline (45 days) has passed."""
    d = datetime.fromisoformat(today[:10]).date()
    y, q = d.year, (d.month - 1) // 3 + 1
    for _ in range(6):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        end = {1: f"{y}-03-31", 2: f"{y}-06-30", 3: f"{y}-09-30", 4: f"{y}-12-31"}[q]
        if (d - datetime.fromisoformat(end).date()).days >= 45:
            return end
    return end


def notice_periods(cik: str, metas: list, notices: list, cache: dict) -> tuple[list[dict], list[dict]]:
    """Quarters where the filer sent a 13F-NT, loaded from the manager that reports for it.

    After the newest notice the original filer often goes quiet (a CIK succession),
    so later quarters of the reporting manager are carried on as well.
    """
    own = {m.report_date for m in metas}
    loaded, skipped, done = [], [], set()
    newest = None
    for nt in sorted(notices, key=lambda m: (m.report_date, m.filing_date), reverse=True):
        if nt.report_date in own or nt.report_date in done:
            continue
        done.add(nt.report_date)
        info = notice_info(cik, nt)
        rep = next((r for r in info["reporters"] if r.get("cik")), None)
        base = {
            "quarter": quarter_label(nt.report_date),
            "report_date": nt.report_date,
            "notice_accession": nt.accession,
            "notice_filing_date": nt.filing_date,
            "notice_note": info.get("note") or "",
            "reported_by": {"cik": rep["cik"], "name": rep["name"]} if rep else None,
        }
        if rep is None:
            skipped.append(base | {"reason": "notice", "detail": "13F-NT names no other manager"})
            continue
        groups = {g[0].report_date: g for g in quarter_groups(list_13f(submissions_for(rep["cik"])), 12)}
        if newest is None:
            newest = (nt, rep, base, groups)
        g = groups.get(nt.report_date)
        q = load_period(rep["cik"], g, cache) if g else None
        if q is None:
            skipped.append(base | {"reason": "notice", "detail": "reporting manager has no holdings for this quarter yet"})
            continue
        loaded.append(q | base | {"status": "notice"})
    if newest and newest[0].report_date > max(own, default=""):
        nt, rep, base, groups = newest
        for period in sorted(groups, reverse=True):
            if period <= nt.report_date or period in own:
                continue
            q = load_period(rep["cik"], groups[period], cache)
            if q is not None:
                loaded.append(q | {"status": "successor", "reported_by": base["reported_by"],
                                   "notice_accession": nt.accession, "notice_note": base["notice_note"]})
    return loaded, skipped


def manager_status(history: list[dict], skipped: list[dict], today: str) -> dict:
    """Why the latest book is what it is, for the front end to explain."""
    latest = history[0]
    expected = expected_report_date(today)
    q = latest["quarter"]
    newer = [s for s in skipped if s["report_date"] > latest["report_date"]]
    who = (latest.get("reported_by") or {}).get("name")
    if newer:
        s = max(newer, key=lambda x: x["report_date"])
        if s["reason"] == "empty":
            filed = f" on {s['filing_date']}" if s.get("filing_date") else ""
            return {"status": "empty_latest", "status_note":
                    f"The {s['quarter']} 13F filed{filed} lists no holdings (a blank or placeholder "
                    f"information table); showing {q}."}
        if s["reason"] == "notice":
            return {"status": "notice_pending", "status_note":
                    f"Filed a 13F notice for {s['quarter']} ({s.get('detail')}); showing {q}."}
        return {"status": "unreadable_latest", "status_note":
                f"The {s['quarter']} 13F could not be read; showing {q}."}
    if latest["report_date"] < expected:
        behind = (int(expected[:4]) - int(latest["report_date"][:4])) * 4 + (
            int(expected[5:7]) - int(latest["report_date"][5:7])) // 3
        if behind >= INACTIVE_AFTER:
            return {"status": "inactive", "status_note":
                    f"No 13F since {q}; this filer appears to have stopped filing and is left out of Consensus."}
        return {"status": "stale", "status_note":
                f"No 13F for {quarter_label(expected)} yet; showing {q}."}
    if latest.get("status") in ("notice", "successor") and who:
        return {"status": "reported_by_other", "status_note":
                f"Holdings for {q} are reported by {who.title() if who.isupper() else who} "
                f"(this filer filed a 13F notice)."}
    return {"status": "current", "status_note": ""}


def pick_filings(group: list, types: dict[str, str]):
    """Which filings make up one period's book: (base, additions) or (None, []).

    The original 13F-HR is the book. A RESTATEMENT amendment replaces it.
    NEW HOLDINGS amendments (often confidential positions disclosed later) are
    added on top and never replace it. An amendment of unknown type is only
    used when nothing else exists for the period.
    """
    by_date = lambda m: m.filing_date
    originals = sorted((m for m in group if m.form == "13F-HR"), key=by_date)
    amends = sorted((m for m in group if m.form != "13F-HR"), key=by_date)
    restated = [m for m in amends if types.get(m.accession) == "RESTATEMENT"]
    unknown = [m for m in amends if not types.get(m.accession)]
    base = (restated or originals or unknown or [None])[-1]
    if base is None:
        return None, []
    additions = [
        m for m in amends
        if types.get(m.accession) == "NEW HOLDINGS" and m.filing_date >= base.filing_date
    ]
    return base, additions


def fix_cached(q: dict) -> dict:
    """Re-run the implied-price unit checks on a stored quarter (idempotent)."""
    hs = q["holdings"]
    factor = unit_fix([(h["value"], h["shares"]) for h in hs if not h["put_call"]])
    changed = factor != 1.0
    for h in hs:
        h["value"] *= factor
        if not h["put_call"] and row_overstated(h["cusip"], h["value"], h["shares"]):
            h["value"] /= 1000
            changed = True
    if changed:
        hs.sort(key=lambda h: h["value"], reverse=True)
        total = sum(h["value"] for h in hs)
        for h in hs:
            h["weight"] = (h["value"] / total) if total else 0.0
        q["total_value"] = total
        if factor > 1:
            q["values_in_thousands"] = True
    return q | {"unit_fix": (q.get("unit_fix") or 1.0) * factor}


def fix_with_consensus(managers: list[dict]) -> int:
    """Rescale single lines filed ~1000x off the price other filers report that quarter."""
    quarters = [q for m in managers for q in m["history"]]
    cons = consensus_prices(
        (q["quarter"], [(h["cusip"], h["value"], h["shares"], h["put_call"]) for h in q["holdings"]])
        for q in quarters
    )
    n = 0
    for q in quarters:
        changed = False
        for h in q["holdings"]:
            if h["put_call"] or h["shares"] <= 0:
                continue
            f = consensus_factor(h["value"] / h["shares"], cons.get((q["quarter"], h["cusip"])))
            if f != 1.0:
                h["value"] *= f
                changed = True
                n += 1
        if changed:
            q["holdings"].sort(key=lambda h: h["value"], reverse=True)
            q["total_value"] = sum(h["value"] for h in q["holdings"])
            for h in q["holdings"]:
                h["weight"] = (h["value"] / q["total_value"]) if q["total_value"] else 0.0
    for m in managers:
        m["holdings"] = m["history"][0]["holdings"]
        m["total_value"] = m["history"][0]["total_value"]
    return n


def merge_quarter(base: dict, extras: list[dict]) -> dict:
    rows: dict[tuple, dict] = {}
    for q in [base, *extras]:
        for h in q["holdings"]:
            key = (h["cusip"], h["put_call"] or "")
            if key in rows:
                rows[key]["value"] += h["value"]
                rows[key]["shares"] += h["shares"]
            else:
                rows[key] = dict(h)
    holdings = sorted(rows.values(), key=lambda h: h["value"], reverse=True)
    total = sum(h["value"] for h in holdings)
    for h in holdings:
        h["weight"] = (h["value"] / total) if total else 0.0
    return base | {
        "holdings": holdings,
        "total_value": total,
        "position_count": len(holdings),
        "line_count": sum(q.get("line_count") or 0 for q in [base, *extras]),
        "amendments": [q["accession"] for q in extras],
    }


def load_period(cik: str, group: list, cache: dict) -> dict | None:
    """One period's book from its original filing plus additive amendments."""
    types = {m.accession: amend_type(cik, m) for m in group if m.form != "13F-HR"}
    base, additions = pick_filings(group, types)
    if base is None:
        return None
    key = "|".join([base.accession] + [m.accession for m in additions])
    if key in cache:
        return fix_cached(cache[key])
    loaded = load_filing(cik, base)
    if loaded is None:
        return None
    extras = []
    for m in additions:
        try:
            x = load_filing(cik, m)
        except Exception as exc:
            print(f"  skip amendment {m.accession}: {exc}", flush=True)
            continue
        if x:
            extras.append(x)
    return merge_quarter(loaded, extras) | {"filing_key": key}


CHANGE_FIELDS = ("prev_shares", "prev_value", "prev_weight", "change", "share_change", "value_delta", "pct_of_book")
MOVE_ROWS = 10  # per bucket in {slug}.json `moves`; alerts carry the top 5


def with_changes(latest: dict, prev: dict | None) -> list[dict]:
    """Holdings with prior-quarter fields, plus exited positions as value-0 rows.

    value_delta is the trade in dollars at this filing's own reported value per share
    (new: +value, exited: -prior value, added/trimmed: share change x value/shares), so
    price moves between quarters do not count as buying or selling. pct_of_book is
    value_delta over this filing's total value. All figures come from the two 13Fs.
    """
    if prev is None:
        return [h | {f: None for f in CHANGE_FIELDS} for h in latest["holdings"]]
    total = latest.get("total_value") or sum(h["value"] for h in latest["holdings"]) or None
    prev_total = prev.get("total_value") or sum(h["value"] for h in prev["holdings"]) or None
    before = {(h["cusip"], h["put_call"] or ""): h for h in prev["holdings"]}
    rows = []

    def extra(p, change, delta, share_change):
        return {
            "prev_shares": p["shares"] if p else 0,
            "prev_value": p["value"] if p else 0,
            "prev_weight": round(p["value"] / prev_total, 6) if p and prev_total else 0.0,
            "change": change,
            "share_change": share_change,
            "value_delta": round(delta),
            "pct_of_book": round(delta / total, 6) if total else None,
        }

    for h in latest["holdings"]:
        p = before.pop((h["cusip"], h["put_call"] or ""), None)
        if p is None:
            change, delta, ds = "new", h["value"], h["shares"]
        else:
            ds = h["shares"] - p["shares"]
            change = "added" if ds > 0 else "trimmed" if ds < 0 else "unchanged"
            delta = ds * h["value"] / h["shares"] if h["shares"] else 0
        rows.append(h | extra(p, change, delta, ds))
    for p in sorted(before.values(), key=lambda x: x["value"], reverse=True):
        rows.append(
            {
                "issuer": p["issuer"],
                "title": p["title"],
                "cusip": p["cusip"],
                "ticker": p.get("ticker") or ticker_for(p["cusip"]),
                "value": 0,
                "shares": 0,
                "put_call": p["put_call"],
                "weight": 0.0,
                **{k: p[k] for k in ("display_name", "sector") if k in p},
                **extra(p, "exited", -p["value"], -p["shares"]),
            }
        )
    return rows


def moves(rows: list[dict], limit: int = MOVE_ROWS) -> dict | None:
    """Biggest new, exited, added and trimmed positions by dollar size of the trade."""
    if not rows or rows[0].get("change") is None:
        return None
    keep = ("ticker", "display_name", "issuer", "cusip", "title", "put_call", "sector", "shares", "prev_shares",
            "share_change", "value", "prev_value", "value_delta", "pct_of_book", "weight", "prev_weight")
    out: dict = {
        "bought_usd": round(sum(r["value_delta"] for r in rows if r["value_delta"] > 0)),
        "sold_usd": round(-sum(r["value_delta"] for r in rows if r["value_delta"] < 0)),
    }
    for c in ("new", "exited", "added", "trimmed"):
        bucket = sorted((r for r in rows if r["change"] == c), key=lambda r: abs(r["value_delta"]), reverse=True)
        out[c] = [{k: r.get(k) for k in keep} for r in bucket[:limit]]
    return out


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
    factor = unit_fix([(h.value, h.shares) for h in holdings if not h.put_call])
    for h in holdings:
        h.value *= factor
        if not h.put_call and row_overstated(h.cusip, h.value, h.shares):
            h.value /= 1000
    if factor > 1:
        thousands = True
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
        "unit_fix": factor,
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
            submissions = submissions_for(cik)
            metas = list_13f(submissions)
            notices = list_notices(submissions)
            if not metas and not notices:
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
            history, skipped = [], []
            for group in quarter_groups(metas, HISTORY_QUARTERS):
                gap = {"quarter": quarter_label(group[0].report_date), "report_date": group[0].report_date,
                       "accession": group[0].accession}
                try:
                    loaded = load_period(cik, group, cache)
                    if loaded is None:
                        last_error = f"Empty 13F information table for {group[0].report_date}"
                        skipped.append(gap | {"reason": "empty", "filing_date": group[0].filing_date})
                        continue
                    history.append(loaded | {"status": "filed"})
                except Exception as inner:
                    last_error = str(inner)
                    skipped.append(gap | {"reason": "unreadable"})
                    continue
            via, gaps = notice_periods(cik, metas, notices, cache)
            history = sorted(history + via, key=lambda q: q["report_date"], reverse=True)[:HISTORY_QUARTERS]
            skipped = sorted(skipped + gaps, key=lambda q: q["report_date"], reverse=True)
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
                    "skipped_quarters": skipped,
                    **manager_status(history, skipped, datetime.now(timezone.utc).isoformat()),
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

    fixed = fix_with_consensus([m for m in managers_out if m.get("ok")])
    print(f"consensus unit check: rescaled {fixed} lines", flush=True)
    ok = [m for m in managers_out if m.get("ok")]
    featured = featured_ciks()
    for m in managers_out:
        m["featured"] = m["cik"] in featured
    buckets: dict[str, dict] = {}
    # A filer whose book is reported by another curated filer would be counted twice.
    curated_ok = {m["cik"] for m in ok}
    slug_by_cik = {m["cik"]: m["slug"] for m in ok}
    for m in ok:
        for row in [m] + (m.get("history") or []):
            if row.get("reported_by"):
                row["reported_by"]["slug"] = slug_by_cik.get(row["reported_by"].get("cik"))
    in_book = [
        m for m in ok
        if (m.get("reported_by") or {}).get("cik") not in curated_ok and m.get("status") != "inactive"
    ]
    for m in in_book:
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
            "num_investors": len(in_book),
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
    rows = with_changes({"holdings": m["holdings"], "total_value": m.get("total_value")}, prev)
    out["changes"] = {
        c: sum(1 for r in rows if r["change"] == c)
        for c in ("new", "added", "trimmed", "exited", "unchanged")
    }
    out["moves"] = moves(rows)
    out["holdings"] = rows
    return out


def compact_row(h: dict) -> dict:
    """Whole-dollar values and share counts, 6-digit weights: keeps full books small on Pages."""
    return {
        k: (int(v) if k in ("value", "shares") and isinstance(v, float) else round(v, 6) if k == "weight" else v)
        for k, v in h.items()
    }


def write_history(m: dict) -> None:
    """Full holdings per quarter in h/{slug}/{quarter}.json; {slug}-history.json is the index."""
    folder = HIST / m["slug"]
    folder.mkdir(parents=True, exist_ok=True)
    keep = set()
    index = []
    hist = m["history"]  # newest first
    for i, q in enumerate(hist):
        name = f"{q['quarter']}.json"
        keep.add(name)
        meta = {k: v for k, v in q.items() if k not in {"holdings", "truncated"}}
        prev = hist[i + 1] if i + 1 < len(hist) else None
        rows = [compact_row(h) for h in with_changes(q, prev)]
        # `holdings` stays the filed book; positions sold out since the prior quarter go in `exited`.
        body = {
            "slug": m["slug"], "manager": m["manager"], "cik": m["cik"], **meta,
            "prev_quarter": prev["quarter"] if prev else None,
            "holdings": [r for r in rows if r["change"] != "exited"],
            "exited": [r for r in rows if r["change"] == "exited"],
        }
        text = json.dumps(body, separators=(",", ":")) + "\n"
        path = folder / name
        if not path.exists() or path.read_text() != text:
            path.write_text(text)
        index.append(meta | {"holdings_url": f"h/{m['slug']}/{name}", "top_holdings": q["holdings"][:TOP_ROWS]})
    for old in folder.glob("*.json"):
        if old.name not in keep:
            old.unlink()
    (DATA / f"{m['slug']}-history.json").write_text(
        json.dumps(
            {
                "slug": m["slug"],
                "manager": m["manager"],
                "cik": m["cik"],
                "history_quarters": m.get("history_quarters") or [],
                "history": index,
            },
            separators=(",", ":"),
        )
        + "\n"
    )


def write_status(payload: dict) -> None:
    """status.json: staleness monitor for curated funds (anything not 'current')."""
    ok = [m for m in payload["managers"] if m.get("ok")]
    expected = expected_report_date(payload["generated_at"])
    counts: dict[str, int] = {}
    for m in ok:
        counts[m["status"]] = counts.get(m["status"], 0) + 1
    flagged = [
        {k: m.get(k) for k in ("slug", "manager", "cik", "quarter", "report_date", "status", "status_note")}
        for m in sorted(ok, key=lambda m: m["report_date"])
        if m["status"] != "current"
    ]
    failed = [{"slug": m["slug"], "manager": m["manager"], "error": m.get("error")}
              for m in payload["managers"] if not m.get("ok")]
    (DATA / "status.json").write_text(json.dumps({
        "generated_at": payload["generated_at"],
        "expected_quarter": quarter_label(expected),
        "counts": counts,
        "flagged": flagged,
        "failed": failed,
    }, indent=1) + "\n")
    behind = sum(1 for f in flagged if f["status"] in ("stale", "empty_latest", "unreadable_latest", "notice_pending"))
    if behind or failed:
        print(f"::warning::{behind} curated funds behind {quarter_label(expected)}, {len(failed)} failed; see status.json")


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
        (DATA / f"{m['slug']}.json").write_text(json.dumps(manager_json(m), separators=(",", ":")) + "\n")
        if m.get("history"):
            write_history(m)
    write_status(payload)
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
    """alerts.json: this run's new filings, a rolling `recent` feed, and the
    latest period recorded per fund (`periods`), which is what makes a filing new.

    Only a fresh original 13F-HR for a later period counts; see alerts.is_alertable.
    """
    now = payload["generated_at"]
    prev = previous_periods(DATA)
    filings = new_filings(payload["managers"], prev, now)
    by_slug = {m["slug"]: m for m in payload["managers"] if m.get("ok")}
    for f in filings:
        mv = manager_json(by_slug[f["slug"]]).get("moves") if f["slug"] in by_slug else None
        f["moves"] = {k: (v[:5] if isinstance(v, list) else v) for k, v in mv.items()} if mv else None
    path = DATA / "alerts.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    seen = {(f["slug"], f.get("report_date")) for f in old.get("recent") or []}
    # Drop anything already in the feed that would fail today's rule (old filings, amendments).
    kept = [
        f for f in old.get("recent") or []
        if f.get("filing_date") and f.get("detected_at")
        and age_days(f["filing_date"], f["detected_at"]) <= MAX_AGE_DAYS
        and f.get("form", "13F-HR") == "13F-HR"
    ]
    recent = [f | {"detected_at": now} for f in filings if (f["slug"], f["report_date"]) not in seen] + kept
    status = None
    if filings:
        subject, body = email_body(filings, now)
        status = send_email(subject, body)
    DATA.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "generated_at": now,
                "rule": (
                    f"New = original 13F-HR for a report period later than any recorded for the fund, "
                    f"filed within {MAX_AGE_DAYS} days. Amendments, restatements, 13F-NT notices and "
                    "accession changes on old periods never alert."
                ),
                "new_filings": filings,
                "recent": recent[:500],
                "periods": next_periods(payload["managers"], prev),
                "email_status": status,
            },
            indent=1,
        )
        + "\n"
    )
    print(f"alerts: {len(filings)} new filings, dropped {len(old.get('recent') or []) - len(kept)} stale, email={status}")


def main() -> int:
    payload = ingest()
    save_amend_types()
    write_alerts(payload)
    write_json(payload)
    print(
        f"wrote {payload['filed_count']}/{payload['manager_count']} managers, "
        f"{payload['copycat']['num_positions']} copycat names"
    )
    return 0 if payload["filed_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
