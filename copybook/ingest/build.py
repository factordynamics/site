#!/usr/bin/env python3
"""Ingest latest 13F-HR filings and generate the Copybook static site."""

from __future__ import annotations

import json
import math
import re
import sys
import traceback
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.figi import load_cache as load_cusip_map
from ingest.alerts import MAX_AGE_DAYS, age_days, email_body, new_filings, next_periods, previous_periods, send_email
from ingest.edgar import (
    amendment_cover,
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
from ingest.splits import FILED as FILED_SPLITS, ratio_between
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
TOP_ROWS = 50  # preview rows per quarter in h/{slug}/index.json (R2); full books are in h/
HIST = DATA / "h"
AMEND_PATH = DATA / "amendments.json"
NOTICE_PATH = DATA / "notices.json"
_NOTICES: dict[str, dict] | None = None
_SUBS: dict[str, dict] = {}
INACTIVE_AFTER = 4  # quarters behind the expected period before a filer is retired
# Filers known to have closed (checked by hand on EDGAR and IAPD): status inactive whatever their latest filing shows.
CLOSED = {
    "0000947996": "Olstein Capital Management's SEC registration has been terminated since Jul 10, 2026, and its 2026Q2 "
                  "13F lists one $0 line; it has stopped filing and is left out of Consensus and alerts.",
}
_AMEND: dict[str, str] | None = None
LITE_HOLDERS = 8
CACHE_FORMAT = 5  # bump when stored quarters lack fields the build now needs (forces a refetch)
# Curated refreshes must stay quick, so they keep quarters back to format 3; full runs refetch older ones.
MIN_CACHE_FORMAT = CACHE_FORMAT if os.environ.get("SCOPE") == "full" else 3
# Curated runs also refetch up to this many quarters stored in an older format, the last few report periods
# first: a curated run that restored the cache before a full run saved it would otherwise put the old quarters
# back, so the full run's refetch alone never sticks.
UPGRADE = [int(os.environ.get("COPYBOOK_UPGRADE_PER_RUN") or 120)]
UPGRADE_FROM = [""]  # report dates before this wait until no newer stale quarter is left
OWN_BOOKS: dict[tuple[str, str], dict] = {}  # (cik, report_date) -> a fund's own book before combining
SPLITS: dict[str, dict[str, float]] = {}  # cusip -> to_quarter -> ratio; see splits.py
# (quarter, cusip) -> median value per share over every filer's full book (moves.py writes consensus.json).
CONSENSUS: dict[tuple[str, str], float] = {}
OFF_MEDIAN = 3.0  # a line priced over 3x off every other filer's is mis-scaled (AllianceBernstein KLAC 2026Q2)


def consensus() -> dict[tuple[str, str], float]:
    if not CONSENSUS and (DATA / "consensus.json").exists():
        for q, prices in (json.loads((DATA / "consensus.json").read_text()).get("quarters") or {}).items():
            CONSENSUS.update({(q, c): px for c, px in prices.items()})
    return CONSENSUS
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


_SEC_TICKERS: dict[str, str] | None = None


def security_ticker(cusip: str) -> str | None:
    """Ticker from the CUSIP map, else data/securities.json (overrides and CINS lookups that enrich.py applies later)."""
    global _SEC_TICKERS
    if _SEC_TICKERS is None:
        try:
            _SEC_TICKERS = {c: v["ticker"] for c, v in json.loads((DATA / "securities.json").read_text()).items()
                            if isinstance(v, dict) and v.get("ticker")}
        except (OSError, ValueError):
            _SEC_TICKERS = {}
    return ticker_for(cusip) or _SEC_TICKERS.get(cusip)


def cached_quarters() -> dict[str, dict]:
    """Previously loaded filings by accession, so unchanged quarters are not refetched."""
    out: dict[str, dict] = {}
    for p in HIST.glob("*/*.json"):
        if p.name.endswith(".v1.json"):
            continue
        try:
            q = json.loads(p.read_text())
        except ValueError:
            continue
        # A combined book (combined_with) is two filers' books summed: never reuse it as the filing itself.
        if q.get("accession") and not q.get("truncated") and not q.get("combined_with") \
                and (q.get("format") or 0) >= MIN_CACHE_FORMAT:
            # Drop what write_history derives (prior-quarter fields, exits): a cached quarter is the filing only.
            for k in ("slug", "manager", "cik", "prev_quarter", "prev_combined_with", "exited"):
                q.pop(k, None)
            out[q.get("filing_key") or q["accession"]] = q
    recent = expected_report_date((datetime.now(timezone.utc) - timedelta(days=92)).isoformat())
    stale_recent = any((q.get("format") or 0) < CACHE_FORMAT and (q.get("report_date") or "") >= recent
                       for q in out.values())
    UPGRADE_FROM[0] = recent if stale_recent else ""
    return out


def amend_cover(cik: str, meta) -> dict:
    """Cached amendment cover page (type, number, confidential treatment); it never changes."""
    global _AMEND
    if _AMEND is None:
        _AMEND = json.loads(AMEND_PATH.read_text()) if AMEND_PATH.exists() else {}
    cur = _AMEND.get(meta.accession)
    if not isinstance(cur, dict):  # older caches stored the type string only
        cover = amendment_cover(cik, meta.accession)
        _AMEND[meta.accession] = cur = cover
    return cur


def amend_type(cik: str, meta) -> str:
    return amend_cover(cik, meta)["type"]


def save_amend_types() -> None:
    if _AMEND is not None:
        AMEND_PATH.write_text(json.dumps(dict(sorted(_AMEND.items())), separators=(",", ":")) + "\n")
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


PAGES_PATH = DATA / "submission_pages.json"  # 13F rows of EDGAR's older submission pages (edgar.fetch_submissions)
_PAGES: dict | None = None


def submissions_for(cik: str) -> dict:
    global _PAGES
    if cik not in _SUBS:
        if _PAGES is None:
            _PAGES = json.loads(PAGES_PATH.read_text()) if PAGES_PATH.exists() else {}
        before = len(_PAGES)
        since = (datetime.now(timezone.utc) - timedelta(days=92 * (max(HISTORY_QUARTERS, 12) + 2))).date().isoformat()
        _SUBS[cik] = fetch_submissions(cik, since, _PAGES)
        if len(_PAGES) != before:
            PAGES_PATH.write_text(json.dumps(_PAGES, separators=(",", ":")) + "\n")
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
    reporter_groups: dict[str, tuple[dict, dict]] = {}  # report_date of a notice -> (reporter, its 13F groups)
    for nt in sorted(notices, key=lambda m: (m.report_date, m.filing_date), reverse=True):
        if nt.report_date in own or nt.report_date in done:
            continue
        done.add(nt.report_date)
        info = notice_info(cik, nt)
        named = [r for r in info["reporters"] if r.get("cik")]
        if len(named) > 1:  # each named manager reports part of the book (MFG's notices name 9): none of them is it
            skipped.append({"quarter": quarter_label(nt.report_date), "report_date": nt.report_date,
                            "notice_accession": nt.accession, "notice_filing_date": nt.filing_date,
                            "notice_note": info.get("note") or "", "reported_by": None, "reason": "notice",
                            "detail": f"13F-NT names {len(named)} other managers, each reporting part of its holdings"})
            continue
        rep = named[0] if named else None
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
        reporter_groups[nt.report_date] = (rep, groups)
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
    # The reporter's own books for quarters the fund also filed itself (Pershing Square Inc. filed
    # beside Pershing Square Capital before reporting for it): the fund's book there is both. Only for a
    # succession, where the fund's newest notice is later than its last own 13F-HR. A parent named on an
    # old notice while the fund still files its own book (Amundi's 2020-21 notices naming Credit Agricole,
    # which files its own 13F too) is a separate filer, and its book is never merged in.
    extra: dict[str, dict] = {}
    if reporter_groups and own and newest and newest[0].report_date > max(own):
        rep, groups = reporter_groups[min(reporter_groups)]
        for d in sorted(own):
            if not groups.get(d):
                continue
            try:
                book = load_period(rep["cik"], groups[d], cache)
            except Exception as exc:  # noqa: BLE001 - fall back to the fund's own book
                print(f"  combined {rep['cik']} {d}: {exc}", flush=True)
                book = None
            if book:
                extra[d] = book | {"cik": rep["cik"], "name": rep["name"]}
    return loaded, skipped, extra


def manager_status(history: list[dict], skipped: list[dict], today: str, cik: str = "") -> dict:
    """Why the latest book is what it is, for the front end to explain."""
    if cik in CLOSED:
        return {"status": "inactive", "status_note": CLOSED[cik]}
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
    by_date = lambda m: (m.filing_date, getattr(m, "accepted_at", "") or "", m.accession)  # same-day amendments in order
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


def is_equity(h: dict) -> bool:
    """A share position: not an option (notional) and not a principal-amount note."""
    return not h.get("put_call") and h.get("shares_type", "SH") != "PRN"


def apply_weights(q: dict) -> dict:
    """pct_of_book = value / value of share positions (options and PRN notes excluded).

    `weight` is the same number. Options and notes get pct_of_book null and their
    notional over the same base in notional_pct_of_book.
    """
    hs = q["holdings"]
    eq = sum(h["value"] for h in hs if is_equity(h))
    for h in hs:
        pct = round(h["value"] / eq, 6) if eq else 0.0
        h["weight"] = pct
        if is_equity(h):
            h["pct_of_book"] = pct
            h.pop("notional_pct_of_book", None)
        else:
            h["pct_of_book"] = None
            h["notional_pct_of_book"] = pct
    q["total_value"] = sum(h["value"] for h in hs)
    q["equity_value"] = eq
    q["options_notional"] = sum(h["value"] for h in hs if h.get("put_call"))
    q["prn_value"] = sum(h["value"] for h in hs if h.get("shares_type") == "PRN" and not h.get("put_call"))
    return q


def fix_cached(q: dict) -> dict:
    """Re-run the implied-price unit checks on a stored quarter (idempotent)."""
    hs = q["holdings"]
    factor = unit_fix([(h["value"], h["shares"]) for h in hs if is_equity(h)])
    changed = factor != 1.0
    for h in hs:
        h["value"] *= factor
        if is_equity(h) and row_overstated(h["cusip"], h["value"], h["shares"]):
            h["value"] /= 1000
            changed = True
    if changed:
        hs.sort(key=lambda h: h["value"], reverse=True)
        apply_weights(q)
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
            if not is_equity(h) or h["shares"] <= 0:
                continue
            f = consensus_factor(h["value"] / h["shares"], cons.get((q["quarter"], h["cusip"])))
            if f != 1.0:
                h["value"] *= f
                changed = True
                n += 1
        if changed:
            q["holdings"].sort(key=lambda h: h["value"], reverse=True)
            apply_weights(q)
    for m in managers:
        m["holdings"] = m["history"][0]["holdings"]
        m["total_value"] = m["history"][0]["total_value"]
    return n


def stamp_units(managers: list[dict]) -> int:
    """value_scale (value_usd / value_as_filed: 1000 for a book filed in thousands) and value_adjusted (a unit fix
    changed the value) on every row of every quarter, after all unit checks. Rows stored before value_as_filed
    was kept leave all three null. Returns the rows whose value differs from their filed value."""
    n = 0
    for m in managers:
        for q in m.get("history") or []:
            for h in q["holdings"]:
                filed = h.get("value_as_filed")
                if filed is None:
                    h.pop("value_scale", None), h.pop("value_adjusted", None)
                    continue
                h["value_scale"] = float(f"{h['value'] / filed:.6g}") if filed else 1.0 if not h["value"] else None
                h["value_adjusted"] = abs(h["value"] - filed) > 0.5
                n += h["value_adjusted"]
    return n


SUMMED = ("value", "value_as_filed", "shares", "principal_amount", "vote_sole", "vote_shared", "vote_none", "lines")


def add_row(rows: dict, h: dict, layer: dict | None = None) -> None:
    """Sum h into rows by (cusip, put/call). Rows first seen in a later layer keep that layer's
    accession and acceptance time and are marked late_disclosure."""
    key = (h["cusip"], h["put_call"] or "")
    cur = rows.get(key)
    if cur is None:
        rows[key] = dict(h) | ({"late_disclosure": True} if layer else {})
        return
    for k in SUMMED:
        if h.get(k) is not None:
            cur[k] = (cur.get(k) or 0) + h[k]
    if layer:
        cur.setdefault("parts", [{"accession": cur.get("source_accession"), "accepted_at": cur.get("first_disclosed_at"),
                                  "shares": cur["shares"] - h["shares"], "value": cur["value"] - h["value"]}])
        cur["parts"].append({"accession": layer["accession"], "accepted_at": layer.get("accepted_at"),
                             "shares": h["shares"], "value": h["value"]})


def merge_quarter(base: dict, extras: list[dict]) -> dict:
    rows: dict[tuple, dict] = {}
    for h in base["holdings"]:
        add_row(rows, h)
    for q in extras:
        for h in q["holdings"]:
            add_row(rows, h, q)
    holdings = sorted(rows.values(), key=lambda h: h["value"], reverse=True)
    return apply_weights(base | {
        "holdings": holdings,
        "position_count": len(holdings),
        "line_count": sum(q.get("line_count") or 0 for q in [base, *extras]),
        "amendments": [q["accession"] for q in extras],
    })


def combine_books(own: dict, other: dict) -> dict:
    """One period's book across two filers (a 13F-NT successor and the filer it replaced)."""
    rows: dict[tuple, dict] = {}
    for h in own["holdings"] + other["holdings"]:
        add_row(rows, h)
    holdings = sorted(rows.values(), key=lambda h: h["value"], reverse=True)
    cover = (own.get("cover_total") or 0) + (other.get("cover_total") or 0)
    return apply_weights(own | {"holdings": holdings, "cover_total": cover or None, "combined_with": {
        "cik": other.get("cik"), "accession": other.get("accession"), "name": other.get("name")}})


def load_period(cik: str, group: list, cache: dict) -> dict | None:
    """One period's book from its original filing plus additive amendments, with its version trail."""
    types = {m.accession: amend_type(cik, m) for m in group if m.form != "13F-HR"}
    base, additions = pick_filings(group, types)
    if base is None:
        return None
    trail = []
    for m in sorted(group, key=lambda m: (m.filing_date, m.accession)):
        row = {"accession": m.accession, "form": m.form, "filing_date": m.filing_date, "accepted_at": m.accepted_at or None,
               "role": "base" if m is base else "addition" if m in additions else
                       "superseded" if m.filing_date <= base.filing_date else "ignored"}
        if m.form != "13F-HR":
            cover = amend_cover(cik, m)
            row |= {"amendment_type": cover["type"] or None, "amendment_no": cover["no"],
                    "confidential_treatment_expired": cover["confidential_treatment_expired"]}
        trail.append(row)
    key = "|".join([base.accession] + [m.accession for m in additions])
    stale = key in cache and (cache[key].get("format") or 0) < CACHE_FORMAT \
        and (cache[key].get("report_date") or "") >= UPGRADE_FROM[0] and UPGRADE[0] > 0
    if stale:  # refetched below; counted against this run's budget
        UPGRADE[0] -= 1
    if key in cache and not stale:
        q = fix_cached(cache[key])
        return original_disclosure(cik, q, base, group, cache) | {"filings": mark_refiled(trail, q.get("refiled") or [])}
    loaded = load_filing(cik, base)
    while loaded is None and additions:
        # A placeholder base (Norges Bank's Q1/Q3 13F-HRs omit the table under confidential treatment): the first
        # NEW HOLDINGS amendment that discloses the book becomes the book.
        loaded, additions = load_filing(cik, additions[0]), additions[1:]
    if loaded is None:
        return None
    extras = []
    refiled: list[dict] = []  # NEW HOLDINGS amendments that re-filed the whole book
    for m in additions:
        try:
            x = load_filing(cik, m)
        except Exception as exc:
            print(f"  skip amendment {m.accession}: {exc}", flush=True)
            continue
        if not x:
            continue
        if is_refiled_book(loaded, extras, x):
            print(f"  {m.accession}: NEW HOLDINGS amendment re-files the whole book; it replaces "
                  f"{loaded['accession']} (${loaded['total_value'] / 1e9:.2f}B -> ${x['total_value'] / 1e9:.2f}B)", flush=True)
            refiled.append({"accession": m.accession, "replaces": [loaded["accession"], *(e["accession"] for e in extras)],
                            "replaced_total": round(merge_quarter(loaded, extras)["total_value"]),
                            "total": round(x["total_value"])})
            known = {(h["cusip"], h.get("put_call") or ""): h for h in merge_quarter(loaded, extras)["holdings"]}
            for h in x["holdings"]:  # positions the replaced book already showed were public since then
                k = known.get((h["cusip"], h.get("put_call") or ""))
                if k and k.get("first_disclosed_at") and k["first_disclosed_at"] < (h.get("first_disclosed_at") or "~"):
                    h["source_accession"], h["first_disclosed_at"] = k.get("source_accession"), k["first_disclosed_at"]
            loaded, extras = x, []
            continue
        extras.append(x)
    q = merge_quarter(loaded, extras) | {"filing_key": key, "format": CACHE_FORMAT, "refiled": refiled}
    q["cover_total"] = sum(b.get("cover_total") or 0 for b in [loaded, *extras]) or None
    return original_disclosure(cik, q, base, group, cache) | {"filings": mark_refiled(trail, refiled)}


def original_disclosure(cik: str, q: dict, base, group: list, cache: dict) -> dict:
    """A RESTATEMENT book's positions that the original 13F-HR already listed were public from the original's
    acceptance: they keep its source_accession and first_disclosed_at. Otherwise every row reads as disclosed on the
    restatement's date, and the next quarter's point-in-time diff sees no prior at all (FMR 2025Q1, restated
    2026-11-05, made all 5,316 lines of 2025Q2 'new'). Checked once per book (disclosure_from_original)."""
    if base.form == "13F-HR" or "disclosure_from_original" in q:
        return q
    orig = min((m for m in group if m.form == "13F-HR" and m.filing_date <= base.filing_date),
               key=lambda m: (m.filing_date, m.accession), default=None)
    if orig is None:
        return q | {"disclosure_from_original": None}
    try:
        o = cache.get(orig.accession) or load_filing(cik, orig)
    except Exception as exc:  # noqa: BLE001 - the next run tries again
        print(f"  original {orig.accession}: {exc}", flush=True)
        return q
    was = {(h["cusip"], h.get("put_call") or ""): h for h in (o or {}).get("holdings") or []}
    at = orig.accepted_at or (o or {}).get("accepted_at")
    for h in q["holdings"]:
        k = was.get((h["cusip"], h.get("put_call") or ""))
        if k and at and at < (h.get("first_disclosed_at") or "~"):
            h["source_accession"], h["first_disclosed_at"] = orig.accession, k.get("first_disclosed_at") or at
    return q | {"disclosure_from_original": orig.accession}


def is_refiled_book(base: dict, extras: list[dict], x: dict) -> bool:
    """A NEW HOLDINGS amendment that is really a full re-filing (some filers mislabel restatements).

    It repeats most of the book: over half the book's positions (CUSIP and put/call), or a total
    within 20% of the book's with at least half as many positions, or with at least 80% of its own
    positions already in the book. Adding it would double-count.
    """
    book = merge_quarter(base, extras) if extras else base
    keys = {(h["cusip"], h.get("put_call") or "") for h in book["holdings"]}
    new = {(h["cusip"], h.get("put_call") or "") for h in x["holdings"]}
    if not keys or not new:
        return False
    if len(keys & new) > 0.5 * len(keys):
        return True
    ratio = (x.get("total_value") or 0) / (book.get("total_value") or 1)
    # Same total and nothing new (Check Capital 2026Q2 A#2 re-filed its 53 positions consolidated as 17).
    return 0.8 <= ratio <= 1.25 and (len(new) >= 0.5 * len(keys) or len(keys & new) >= 0.8 * len(new))


def mark_refiled(trail: list[dict], refiled: list[dict]) -> list[dict]:
    """Version trail with mislabeled full re-filings as the base and what they replaced superseded."""
    if not refiled:
        return trail
    last = refiled[-1]
    replaced = {a for r in refiled for a in r["replaces"]} | {r["accession"] for r in refiled[:-1]}
    for f in trail:
        if f["accession"] == last["accession"]:
            f["role"], f["mislabeled_amendment"] = "base", True
        elif f["accession"] in replaced:
            f["role"] = "superseded"
            if any(f["accession"] == r["accession"] for r in refiled):
                f["mislabeled_amendment"] = True
    return trail


CHANGE_FIELDS = ("prev_shares", "prev_value", "prev_weight", "change", "share_change", "value_delta", "delta_pct_of_book")
# Set by with_changes only when they apply; a row read back from an earlier build must not keep them.
STALE = ("split", "prev_shares_as_filed", "suspect_units", "suspect_units_basis", "suspect_reason", "row_type", "prev_cusip", "suspect_duplicate",
         "prev_principal_amount")
MOVE_ROWS = 10  # per bucket in {slug}.json `moves`; alerts carry the top 5
CHANGE_KINDS = ("new", "added", "trimmed", "exited", "unchanged", "disclosed_later")


def amount(h: dict) -> float:
    """Shares, or the principal amount of a note (PRN rows)."""
    return (h.get("principal_amount") or 0) if h.get("shares_type") == "PRN" else (h.get("shares") or 0)


COMMON = re.compile(r"\b(COM|COMMON|CMN|SHS|ORD|ORDINARY|CL\s?[A-C]|CLASS\s?[A-C]|CAP STK|STOCK)\b")


NOT_COMMON = re.compile(r"%|\b(PFD|PREF\w*|DEP\w*|NOTES?|WTS?|WARRANTS?|RTS?|RIGHTS?|UNITS?|DEB\w*|BONDS?)\b")


def same_class(a: dict, b: dict) -> bool:
    """Same security class across a CUSIP change of one ticker: equal titles, or neither a preferred, note, warrant,
    right or unit. Titles are free text (XOM 2026Q3 came as "cs", "EQUITY", "XOM", "EXXONMOBIL HOLDINGS CORP" or a
    date beside "COM"), so a common-stock word isn't required; share classes carry their own tickers."""
    ta, tb = (a.get("title") or "").upper().strip(), (b.get("title") or "").upper().strip()
    return ta == tb or not (NOT_COMMON.search(ta) or NOT_COMMON.search(tb))


LINKS_PATH = DATA / "cusip_links.json"  # reissued CUSIPs, old -> new (moves.py detects and writes it)
_LINKS: dict[str, dict] | None = None


HELD_LINKS: dict[str, dict] = {}  # SEC-confirmed reissues whose share units don't check out: never applied


def cusip_links() -> dict[str, dict]:
    """{old_cusip: {new, ticker, quarter, filers, basis, ...}}: the reissues applied everywhere. Candidates are
    cusip_links.json's links and held links plus SEED_LINKS, all confirmed by the SEC's Official 13(f) List. One is
    applied only when its share units check out on the holders (splits.py link checks, run before any book): a split
    found on the linked pair (HON 2026Q2 1-for-2, applied as a split), or holders at exactly 1:1 (XOM, TEVA ADS to
    ordinary). Any other goes to HELD_LINKS with units_reason: netting mismatched units would invent trades."""
    global _LINKS
    if _LINKS is None:
        try:
            doc = json.loads(LINKS_PATH.read_text())
        except (OSError, ValueError):
            doc = {}
        held = doc.get("held") or []
        if isinstance(held, dict):  # Nov 11 12:0x files: a map keyed by the old CUSIP
            held = [v | {"old": o} for o, v in held.items()]
        cand = {v["old"]: dict(v) for v in held if v.get("old") and v.get("basis") == "sec_13f_list"}
        cand.update({o: dict(v) for o, v in (doc.get("links") or {}).items() if v.get("basis") == "sec_13f_list"})
        for old, v in SEED_LINKS.items():
            cand.setdefault(old, dict(v))
        from ingest.splits import load as split_doc
        checks = split_doc().get("links") or {}
        _LINKS = {}
        HELD_LINKS.clear()
        for o, v in cand.items():
            v = {k: x for k, x in v.items() if k not in ("units_reason", "ratio", "units_basis", "units_check")}
            v["old"] = o
            c = checks.get(o)
            if not (c and c.get("new") == v["new"]):
                HELD_LINKS[o] = v | {"units_reason": "units unchecked: no filer has reported the old CUSIP one "
                                                     "quarter and the new one the next"}
                continue
            v["units_check"] = {k: c.get(k) for k in ("to_quarter", "holders", "exact_at_1", "exact_at_ratio",
                                                     "median_ratio", "split_ratio", "evidence")}
            if not c.get("units_ok"):
                HELD_LINKS[o] = v | {"units_reason": c.get("reason")}
                continue
            # The prior quarter's shares times ratio are this quarter's (DD 1-for-3: 1/3); with_changes applies it
            # through the split table, which holds the split found on the linked pair.
            v["ratio"] = c.get("split_ratio") or 1
            v["units_basis"] = "split_confirmed" if c.get("split_ratio") else "holders_1to1"
            _LINKS[o] = v
    return _LINKS


def reload_links() -> None:
    global _LINKS
    _LINKS = None
    HELD_LINKS.clear()


# Reissues of 2026Q2-Q3 that the SEC's Official 13(f) List confirms (old CUSIP deleted in the list that adds the new
# one; no units, rights or warrants), found in every filer's books on Nov 11. Seeded so a run applies them before it
# builds any book. Detection in moves.py adds later ones to cusip_links.json on its own.
SEED_LINKS = {
    "30231G102": {"new": "30233Q108", "ticker": "XOM", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "682680103": {"new": "30609A109", "ticker": "OKE", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "438516106": {"new": "438516205", "ticker": "HON", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "26614N102": {"new": "26614N201", "ticker": "DD", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "881624209": {"new": "M8769Q102", "ticker": "TEVA", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "04351P101": {"new": "K08588103", "ticker": "ASND", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "811916105": {"new": "811927102", "ticker": "SA", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "G5S37H101": {"new": "G5T40M104", "ticker": "MRX", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "Y95308105": {"new": "94352A104", "ticker": "WVE", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "415864107": {"new": "29390K102", "ticker": "NVRI", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "G87264100": {"new": "87877F103", "ticker": "TGLS", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "08862E109": {"new": "08862E307", "ticker": "BYND", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "197641103": {"new": "197914104", "ticker": "CLBK", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "05601U105": {"new": "05601U204", "ticker": "BRCC", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "G39108108": {"new": "G39104107", "ticker": "GTES", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "143658300": {"new": "G2004J103", "ticker": "CCL", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "02462A104": {"new": "02462A203", "ticker": "ABTC", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "682310875": {"new": "68237V103", "ticker": "ONCY", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "89788C104": {"new": "89790E106", "ticker": "TRLV", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "38341P102": {"new": "38341P201", "ticker": "GOSS", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "68622E104": {"new": "68622E203", "ticker": "BARK", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "91544A109": {"new": "91544A208", "ticker": "UPLD", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "14161W105": {"new": "14161W303", "ticker": "CDLX", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "36322Q206": {"new": "G2646Y104", "ticker": "DMRA", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "762093102": {"new": "762093201", "ticker": "RBKB", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "67623L307": {"new": "67623L505", "ticker": "OPAD", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "91702V101": {"new": "91703D100", "ticker": "UROY", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "36254L308": {"new": "36254L407", "ticker": "GTBP", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "09077B104": {"new": "09077B203", "ticker": "BCAB", "quarter": "2026Q2", "basis": "sec_13f_list", "list_quarter": "2026Q2"},
    "N3144W105": {"new": "G3314M109", "ticker": "XPRO", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
    "226718104": {"new": "L20675101", "ticker": "CRTO", "quarter": "2026Q3", "basis": "sec_13f_list", "list_quarter": "2026Q3"},
}


def units(h: dict, p: dict | None, r: float, k: float, q: str | None, q_prev: str | None) -> dict:
    """suspect_units and suspect_units_basis for one row. Share lines only (notes and options: null, basis none).
    filers: this line or its prior priced over OFF_MEDIAN x off the CUSIP's median across every filer that quarter
    (AllianceBernstein 2026Q2 KLAC at $1,472 a share, peers $301.71), plus the own-prior check when it can run.
    own_prior: no median for the CUSIP, so only the filer's own value per share against its prior quarter (over
    5x apart with no split on file: GuardCap BKNG). none: neither could run; suspect_units stays null.
    suspect_reason, when true: cross_filer (this line off this quarter's median), cross_filer_prior (the prior
    quarter's line off that quarter's median, so the change is unreliable though this line is priced like its peers:
    Geode SION at $5.26), or own_prior (value per share over 5x from the filer's own prior quarter)."""
    if h.get("shares_type") == "PRN" or h.get("put_call"):
        return {"suspect_units": None, "suspect_units_basis": "none", "suspect_reason": None}

    def off(row: dict, quarter: str | None, kk: float = 1.0) -> bool | None:
        m, n = consensus().get((quarter or "", row["cusip"])), amount(row)
        if not (m and n and row["value"] > 0):
            return None
        # A prior already in post-split shares (Amundi CRWD 2026Q2 at ~$190 against a $763 median) sits at the
        # median over the split ratio.
        return not any(1 / OFF_MEDIAN <= row["value"] / n / (m / s) <= OFF_MEDIAN for s in {1.0, kk})

    here, before = off(h, q), (off(p, q_prev, k) if p is not None else None)
    own = None
    now, was = amount(h), (amount(p) * r if p is not None else 0)
    if p is not None and now and was and h["value"] > 0 and p["value"] > 0:
        jump = (h["value"] / now) / (p["value"] / was)
        own = jump > 5 or jump < 0.2
    reason = "cross_filer" if here else "cross_filer_prior" if before else "own_prior" if own else None
    if here is not None or before is not None:
        # basis names the check that tripped when flagged (own_prior only: own_prior), else the strongest that ran
        return {"suspect_units": bool(here or before or own), "suspect_reason": reason,
                "suspect_units_basis": "own_prior" if reason == "own_prior" else "filers"}
    if own is not None:
        return {"suspect_units": own, "suspect_units_basis": "own_prior", "suspect_reason": reason}
    return {"suspect_units": None, "suspect_units_basis": "none", "suspect_reason": None}


def with_changes(latest: dict, prev: dict | None) -> list[dict]:
    """Holdings with prior-quarter fields, plus exited positions as value-0 rows.

    Point in time: the prior quarter is taken as it was known when this quarter's
    filing was accepted, so positions disclosed later (confidential-treatment
    amendments) are neither new nor exited here. Rows of this quarter that a later
    amendment disclosed get change "disclosed_later" and no trade size.

    Splits: the prior quarter's shares are multiplied by the split ratio (splits.py);
    prev_shares is adjusted and prev_shares_as_filed keeps the filed number. Without a split prev_shares_as_filed
    is still the prior's filed share count (then equal to prev_shares), so the field has one meaning.

    value_delta is the trade in dollars at this filing's own value per share (new:
    +value, exited: -prior value), so price moves alone are 0. delta_pct_of_book is
    value_delta over the share-position book (equity_value). PRN notes compare
    principal amounts and never count as shares (share_change null).
    """
    if prev is None:  # no prior quarter: the cross-filer check still runs on each share line
        return [{f: v for f, v in h.items() if f not in STALE} | {f: None for f in CHANGE_FIELDS} | {"row_type": "holding"}
                | units(h, None, 1.0, 1.0, latest.get("quarter"), None) for h in latest["holdings"]]
    eq = latest.get("equity_value") or sum(h["value"] for h in latest["holdings"] if is_equity(h)) or None
    q_from, q_to = prev.get("quarter"), latest.get("quarter")
    known_by = latest.get("accepted_at")
    before = {
        (h["cusip"], h["put_call"] or ""): h for h in prev["holdings"]
        if not (known_by and h.get("first_disclosed_at") and h["first_disclosed_at"] > known_by)
    }
    rows = []
    # Reissued CUSIPs (Exxon 30231G102 -> 30233Q108): a position whose CUSIP is new this quarter continues one whose
    # CUSIP is gone when cusip_links() links the two (never on a shared ticker alone: SPAC units share one).
    renamed: dict[tuple, tuple] = {}
    now_keys = {(h["cusip"], h["put_call"] or "") for h in latest["holdings"]}
    olds: dict[str, list[str]] = {}
    for old, v in cusip_links().items():
        olds.setdefault(v["new"], []).append(old)
    # A book that reports both codes of a linked pair (IFP Advisors 2026Q3: a stale 881624209 line of 143,891 sh beside
    # M8769Q102 143,876 sh): the new code is the position; the old line is suspect_duplicate, with no change, in no sum.
    dup = {(o, pc) for c, pc in now_keys for o in olds.get(c, ()) if (o, pc) in now_keys}
    gone = {k: p for k, p in before.items() if k not in now_keys or k in dup}
    for h in latest["holdings"]:
        k = (h["cusip"], h["put_call"] or "")
        if k in before:
            continue
        pk = next(((o, k[1]) for o in olds.get(h["cusip"], ()) if (o, k[1]) in gone and (o, k[1]) not in renamed.values()), None)
        if pk:  # a known reissue (cusip_links.json): SEC-confirmed, units checked; a split on it applies below
            renamed[k] = pk

    def ratio(h):
        if not (q_from and q_to) or h.get("shares_type") == "PRN":
            return 1.0
        return ratio_between(SPLITS, h["cusip"], q_from, q_to, h.get("put_call"))

    def extra(p, change, delta, ds, r, prn):
        out = {
            "prev_shares": 0 if prn or not p else p["shares"] * r,
            "prev_value": p["value"] if p else 0,
            "prev_weight": (p.get("weight") or 0.0) if p else 0.0,
            "change": change,
            "share_change": None if prn or ds is None else ds,
            "value_delta": round(delta),
            "delta_pct_of_book": round(delta / eq, 6) if eq else None,
        }
        if prn:
            out["prev_principal_amount"] = amount(p) if p else 0
        if p and not prn:
            out["prev_shares_as_filed"] = p["shares"]
        if p and r != 1.0:
            out["split"] = {"ratio": r, "from_quarter": q_from, "to_quarter": q_to}
        return out

    for h in latest["holdings"]:
        h = {f: v for f, v in h.items() if f not in STALE}
        k = (h["cusip"], h["put_call"] or "")
        if k in dup:
            rows.append(h | {"row_type": "holding", "suspect_duplicate": True} | {f: None for f in CHANGE_FIELDS}
                        | units(h, None, 1.0, 1.0, q_to, None))
            continue
        p = before.pop(k, None) or before.pop(renamed.get(k), None)
        if p is not None and p["cusip"] != h["cusip"]:
            h = h | {"prev_cusip": p["cusip"]}
        prn = h.get("shares_type") == "PRN"
        r = k = ratio(h)
        # Per filer: a prior position already reported in post-split shares (its value per share is at
        # today's level, not k times it; Amundi and 1832 on CRWD 2026Q2) is not multiplied again.
        if r != 1.0 and (h["cusip"], q_to) not in FILED_SPLITS and p is not None and not prn and p["value"] > 0 and amount(p) > 0 and h["value"] > 0 and amount(h) > 0:
            was, now_px = p["value"] / amount(p), h["value"] / amount(h)
            if abs(math.log(was / now_px)) < abs(math.log(was / (now_px * r))):
                r = 1.0
        if h.get("late_disclosure"):
            rows.append(h | {"row_type": "holding"} | units(h, p, r, k, q_to, q_from) | extra(p, "disclosed_later", 0, None, r, prn))
            continue
        now = amount(h)
        if p is None:
            change, delta, ds = "new", h["value"], now
        else:
            ds = now - amount(p) * r
            if abs(ds) < 0.5:  # split-adjusted share counts are not always whole
                ds = 0
            change = "added" if ds > 0 else "trimmed" if ds < 0 else "unchanged"
            delta = ds * h["value"] / now if now else 0
            # Value per share moved over 5x with no split on file: one of the two filings is mis-scaled
            # (GuardCap BKNG 646,216 sh $121.6M -> 1,304 sh $6.7M). The move is then the value change,
            # a trim never more than the prior position, and the row is kept out of flow and alerts.
            was = amount(p) * r
            if not prn and now and was and h["value"] > 0 and p["value"] > 0:
                jump = (h["value"] / now) / (p["value"] / was)
                if jump > 5 or jump < 0.2:
                    delta = max(h["value"] - p["value"], -p["value"])
                    h = h | {"suspect_units": True}
                elif abs(delta) > 1.5 * max(h["value"], p["value"]):  # no trade is worth more than that
                    delta = h["value"] - p["value"]
        rows.append(h | {"row_type": "holding"} | units(h, p, r, k, q_to, q_from) | extra(p, change, delta, ds, r, prn))
    for key in dup:  # the duplicate's own prior line is the new code's position, not a sale
        before.pop(key, None)
    for p in sorted(before.values(), key=lambda x: x["value"], reverse=True):
        prn = p.get("shares_type") == "PRN"
        r = ratio(p)
        gone_row = {"cusip": p["cusip"], "put_call": p["put_call"], "shares_type": p.get("shares_type"), "value": 0, "shares": 0}
        rows.append(units(gone_row, p, r, r, q_to, q_from) |
            {
                "issuer": p["issuer"],
                "title": p["title"],
                "cusip": p["cusip"],
                "ticker": p.get("ticker") or ticker_for(p["cusip"]),
                "row_type": "exited",  # sold out: shares and value 0, the old position in prev_shares/prev_value
                "value": 0,
                "shares": 0,
                "put_call": p["put_call"],
                "weight": 0.0,
                "pct_of_book": 0.0 if is_equity(p) else None,
                **{k: p[k] for k in ("display_name", "sector", "shares_type") if k in p},
                **extra(p, "exited", -p["value"], -amount(p) * r, r, prn),
            }
        )
    return rows


def moves(rows: list[dict], limit: int = MOVE_ROWS) -> dict | None:
    """Biggest new, exited, added and trimmed positions by dollar size of the trade."""
    if not rows or rows[0].get("change") is None:
        return None
    keep = ("ticker", "display_name", "issuer", "cusip", "title", "put_call", "shares_type", "sector", "shares",
            "prev_shares", "share_change", "value", "prev_value", "value_delta", "delta_pct_of_book",
            "pct_of_book", "weight", "prev_weight", "split")
    suspect = sum(1 for r in rows if r.get("suspect_units"))
    rows = [r for r in rows if not r.get("suspect_units")]  # mis-scaled lines stay out of flow and alerts
    out: dict = {
        "suspect_units": suspect,
        "bought_usd": round(sum(r["value_delta"] for r in rows if r["value_delta"] > 0)),
        "sold_usd": round(-sum(r["value_delta"] for r in rows if r["value_delta"] < 0)),
    }
    for c in ("new", "exited", "added", "trimmed"):
        bucket = sorted((r for r in rows if r["change"] == c), key=lambda r: abs(r["value_delta"]), reverse=True)
        out[c] = [{k: r.get(k) for k in keep if k in r} for r in bucket[:limit]]
    return out


def filing_url(cik: str, accession: str) -> str:
    cik_stripped = str(int(cik))
    acc = accession.replace("-", "")
    return f"https://www.sec.gov/Archives/edgar/data/{cik_stripped}/{acc}/{accession}-index.html"


def load_filing(cik: str, meta) -> dict | None:
    xml = fetch_info_table(cik, meta.accession)
    rows = parse_info_table(xml)
    holdings = aggregate_holdings(rows)
    as_filed = {id(h): h.value for h in holdings}  # the value column as filed, before any unit fix
    cover_total = table_value_total(fetch_primary_doc(cik, meta.accession))
    raw_total = sum(h.value for h in holdings)
    thousands = looks_like_thousands(raw_total, cover_total)
    scale_if_thousands(holdings, thousands)
    share_rows = lambda h: not h.put_call and h.shares_type != "PRN"
    factor = unit_fix([(h.value, h.shares) for h in holdings if share_rows(h)])
    for h in holdings:
        h.value *= factor
        if share_rows(h) and row_overstated(h.cusip, h.value, h.shares):
            h.value /= 1000
    if factor > 1:
        thousands = True
    attach_tickers(holdings)
    # $0 lines with shares or principal stay (as filed); lines with neither and placeholder CUSIPs go.
    holdings = [h for h in holdings if (h.value > 0 or h.shares > 0) and h.cusip != "000000000"]
    total = sum(h.value for h in holdings)
    if total <= 0 or not holdings:
        return None
    disclosed = meta.accepted_at or meta.filing_date
    cover = (cover_total * (1000 if thousands and cover_total and total / cover_total > 300 else 1)) if cover_total else None
    return apply_weights({
        "cover_total": cover,
        "format": CACHE_FORMAT,
        "form": meta.form,
        "accession": meta.accession,
        "filing_date": meta.filing_date,
        "accepted_at": meta.accepted_at,
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
                "value_as_filed": as_filed[id(h)],
                # Principal-amount rows (notes) are never shares: shares 0, amount in principal_amount.
                "shares": 0 if h.shares_type == "PRN" else h.shares,
                "put_call": h.put_call,
                "shares_type": h.shares_type,
                "principal_amount": h.shares if h.shares_type == "PRN" else None,
                "discretion": ",".join(sorted(h.discretion)) or None,
                "other_managers": sorted(h.other_managers, key=lambda x: (len(x), x)),
                "vote_sole": int(h.vote_sole),
                "vote_shared": int(h.vote_shared),
                "vote_none": int(h.vote_none),
                "lines": h.lines,
                "source_accession": meta.accession,
                "first_disclosed_at": disclosed,
            }
            for h in holdings
        ],
    })


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
            via, gaps, extra = notice_periods(cik, metas, notices, cache)
            for i, q in enumerate(history):  # quarters both filers filed: the fund's book is the sum
                other = extra.get(q["report_date"])
                # Only a reporter's slice beside the fund's own book (Pershing Square Inc., $0.6B next to
                # $13.7B) is the same fund; a parent's whole combination report (Fiera Capital, $27.6B next
                # to Wilkinson's $1.3B) is not.
                if other and q.get("status") == "filed" and other["total_value"] <= q["total_value"]:
                    OWN_BOOKS[(cik, q["report_date"])] = q
                    history[i] = combine_books(q, other) | {"total_value": q["total_value"] + other["total_value"]}
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
                    **manager_status(history, skipped, datetime.now(timezone.utc).isoformat(), cik),
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
    print(f"unit fields: {stamp_units([m for m in managers_out if m.get('ok')])} rows rescaled from their filed value",
          flush=True)
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


def baseline(m: dict, i: int) -> dict | None:
    """The quarter before history[i], as the book to compare against.

    When history[i] is reported by another filer (13F-NT succession) and the quarter
    before was the fund's own filing, the reporting filer's own book for that earlier
    quarter is added in: the successor's book covers both, so comparing it with only
    one of them would show the other's positions as buys.
    """
    hist = m.get("history") or []
    if i + 1 >= len(hist):
        return None
    from ingest.datasets import prev_quarter
    cur, prev = hist[i], hist[i + 1]
    # Only the quarter right before (FMR 2025Q3 skipped to 2025Q1), and only when the filer whose 13F-HR is this
    # quarter's book is in that quarter's book too: MFG's own 2026Q2 against Mizuho Bank's 2026Q1 13F-HR showed
    # Mizuho Bank's positions as MFG's exits. (Pershing Square Inc. reporting in 2026Q2 against the 2026Q1 book it
    # was combined into passes.)
    if prev_quarter(cur["quarter"]) != prev["quarter"] or book_filer(m, cur) not in book_sources(m, prev):
        return None
    # Point in time: a prior book none of whose lines was public when this quarter was filed (Norges Bank's Q1
    # disclosed a year late by amendment; Allianz's 2024Q3 filed after its 2024Q4) is no prior: changes unknown,
    # not every line "new".
    known_by = cur.get("accepted_at")
    if known_by and prev.get("holdings") and all((h.get("first_disclosed_at") or "") > known_by for h in prev["holdings"]):
        return None
    return prev  # quarters two filers both filed are already combined (ingest, share_reporter_books)


def book_filer(m: dict, q: dict) -> int | str | None:
    """The CIK whose 13F-HR is a quarter's book: the reporting manager's for a 13F-NT quarter, else the fund's."""
    rep = (q.get("reported_by") or {}).get("cik") if q.get("status") in ("notice", "successor") else None
    c = rep or m.get("cik")
    return int(c) if str(c).isdigit() else c


def book_sources(m: dict, q: dict) -> set:
    """Every CIK in a quarter's book: book_filer plus a filer combined into it."""
    c = (q.get("combined_with") or {}).get("cik")
    return {book_filer(m, q)} | ({int(c) if str(c).isdigit() else c} if c else set())


def manager_json(m: dict) -> dict:
    out = {k: v for k, v in m.items() if k not in {"history", "holdings"}}
    hist = m.get("history") or []
    prev = baseline(m, 0)
    out["prev_quarter"] = prev["quarter"] if prev else None
    out["prev_report_date"] = prev["report_date"] if prev else None
    out["prev_accession"] = prev["accession"] if prev else None
    out["prev_total_value"] = prev["total_value"] if prev else None
    out["prev_combined_with"] = prev.get("combined_with") if prev else None
    rows = with_changes(hist[0] if hist else {"holdings": m["holdings"], "total_value": m.get("total_value")}, prev)
    out["changes"] = {c: sum(1 for r in rows if r["change"] == c) for c in CHANGE_KINDS}
    out["moves"] = moves(rows)
    out["holdings"] = rows
    return out


def compact_row(h: dict) -> dict:
    """Whole-dollar values and share counts, 6-digit weights: keeps full books small on Pages."""
    ints = ("value", "shares", "prev_shares", "prev_value", "share_change", "principal_amount",
            "prev_principal_amount", "prev_shares_as_filed", "value_as_filed")
    fracs = ("weight", "pct_of_book", "prev_weight", "notional_pct_of_book", "delta_pct_of_book")
    return {
        k: (round(v) if k in ints and isinstance(v, float) else round(v, 6) if k in fracs and isinstance(v, float) else v)
        for k, v in h.items()
    }


V1_EXTRA = ("pct_of_book", "notional_pct_of_book", "delta_pct_of_book", "display_name", "late_disclosure", "parts",
            "split", "prev_shares_as_filed", "suspect_duplicate", "discretion", "other_managers", "vote_sole", "vote_shared", "vote_none")


def v1_position(h: dict) -> dict:
    """One row in the Copy API /v1 Position shape (openapi.json), plus Copybook extras."""
    prn = h.get("shares_type") == "PRN"
    out = {
        "cusip": h["cusip"], "ticker": h.get("ticker"), "issuer": h.get("issuer"), "title_of_class": h.get("title"),
        "put_call": {"PUT": "Put", "CALL": "Call"}.get((h.get("put_call") or "").upper()),
        "sector": h.get("sector"),
        "shares": h.get("principal_amount") or 0 if prn else h.get("shares") or 0,
        "shares_type": h.get("shares_type") or "SH",
        "value_usd": int(round(h.get("value") or 0)),
        "weight": h.get("weight"),
        "change": h.get("change"),
        "prev_shares": h.get("prev_principal_amount") if prn else h.get("prev_shares"),
        "share_change": h.get("share_change"),
        "value_delta_usd": h.get("value_delta"),
        "source_accession": h.get("source_accession"),
        "first_disclosed_at": h.get("first_disclosed_at"),
        "value_scale": h.get("value_scale"),
        "value_as_filed": h.get("value_as_filed"),
        "value_adjusted": h.get("value_adjusted"),
        "prev_cusip": h.get("prev_cusip"),
    }
    return out | {k: h[k] for k in V1_EXTRA if h.get(k) is not None}


def v1_holdings(m: dict, q: dict, prev: dict | None, rows: list[dict]) -> dict:
    trail = q.get("filings") or []
    base = next((f for f in trail if f["role"] == "base"), None) or {}
    original = next((f for f in trail if f["form"] == "13F-HR"), None) or {}
    return {
        "filer": {"slug": m["slug"], "cik": m["cik"], "name": m.get("name"), "manager": m.get("manager")},
        "quarter": q["quarter"],
        "report_date": q["report_date"],
        "filing": {
            "accession": q["accession"], "form": q.get("form"), "filing_date": q.get("filing_date"),
            "accepted_at": q.get("accepted_at") or base.get("accepted_at"), "sec_url": q.get("sec_url"),
            "original_accession": original.get("accession"),
            "amendments": [
                {"accession": f["accession"], "filed_on": f["filing_date"], "accepted_at": f.get("accepted_at"),
                 "amendment_type": f.get("amendment_type"), "amendment_no": f.get("amendment_no"),
                 "confidential_treatment_expired": f.get("confidential_treatment_expired"), "role": f["role"],
                 "mislabeled_amendment": bool(f.get("mislabeled_amendment"))}
                for f in trail if f["form"] != "13F-HR"
            ],
            "mislabeled_amendment": any(f.get("mislabeled_amendment") for f in trail),
            "versions": trail,
        },
        "status": q.get("status"),
        "reported_by": q.get("reported_by"),
        "prev_quarter": prev["quarter"] if prev else None,
        "prev_combined_with": prev.get("combined_with") if prev else None,
        "total_value_usd": int(round(q.get("total_value") or 0)),
        "equity_value_usd": int(round(q.get("equity_value") or 0)),
        "options_notional_usd": int(round(q.get("options_notional") or 0)),
        "prn_value_usd": int(round(q.get("prn_value") or 0)),
        "position_count": q.get("position_count"),
        "holdings": [v1_position(r) for r in rows if r["change"] != "exited"],
        "exited": [v1_position(r) for r in rows if r["change"] == "exited"],
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
        meta = {k: v for k, v in q.items() if k not in {"holdings", "truncated", "refiled"}}
        meta["long_value"] = round(sum(h["value"] for h in q["holdings"] if not h.get("put_call")))
        # A NEW HOLDINGS amendment that re-filed the whole book (mark_refiled): the quarter's book is that refile.
        meta["mislabeled_amendment"] = any(f.get("mislabeled_amendment") for f in q.get("filings") or [])
        prev = baseline(m, i)
        rows = [compact_row(h) for h in with_changes(q, prev)]
        # `holdings` stays the filed book; positions sold out since the prior quarter go in `exited`.
        body = {
            "slug": m["slug"], "manager": m["manager"], "cik": m["cik"], **meta,
            "prev_quarter": prev["quarter"] if prev else None,
            "prev_combined_with": prev.get("combined_with") if prev else None,
            "holdings": [r for r in rows if r["change"] != "exited"],
            "exited": [r for r in rows if r["change"] == "exited"],
        }
        for fname, doc in ((name, body), (name[:-5] + ".v1.json", v1_holdings(m, q, prev, rows))):
            text = json.dumps(doc, separators=(",", ":")) + "\n"
            path = folder / fname
            keep.add(fname)
            if not path.exists() or path.read_text() != text:
                path.write_text(text)
        url = f"h/{m['slug']}/{name}"
        index.append(meta | {"holdings_url": url, "csv_url": url[:-5] + ".csv", "top_holdings": q["holdings"][:TOP_ROWS]})
    keep.add("index.json")
    for old in folder.glob("*.json"):
        if old.name not in keep:
            old.unlink()
    head = {
        "slug": m["slug"],
        "manager": m["manager"],
        "cik": m["cik"],
        "history_quarters": m.get("history_quarters") or [],
    }
    # Paid: the index with each quarter's preview rows goes to R2 (served by the Copy API's /history).
    (folder / "index.json").write_text(json.dumps(head | {"history": index}, separators=(",", ":")) + "\n")
    # Public: quarter metadata only, so Pages gives away no past holdings.
    public = [{k: v for k, v in q.items() if k != "top_holdings"} for q in index]
    (DATA / f"{m['slug']}-history.json").write_text(json.dumps(head | {"history": public}, separators=(",", ":")) + "\n")


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


try:
    from ingest.filer_types import load as _load_types
    FILER_TYPES = _load_types()  # from the previous full run's filer_types.py
except Exception:  # noqa: BLE001
    FILER_TYPES = {}

# Preview rows in index.json: display fields only (row detail stays in {slug}.json and R2).
TOP_FIELDS = ("issuer", "title", "cusip", "ticker", "display_name", "sector", "value", "shares", "shares_type",
              "put_call", "weight", "pct_of_book", "prev_shares", "prev_value", "prev_weight", "change",
              "share_change", "value_delta", "delta_pct_of_book", "split")


COUNT_DEFINITIONS = {
    "filers": "13F filers with holdings on file: every filer whose latest 13F-HR parsed, plus every tracked fund",
    "tracked": "Tracked funds with a 13F for the newest quarter any of them filed or the quarter before; "
               "excludes inactive funds and funds whose holdings another manager reports",
    "superinvestors": "Featured superinvestors, excluding inactive ones",
}


def types_as_of() -> str | None:
    try:
        return json.loads((DATA / "filer_types.json").read_text()).get("as_of")
    except (OSError, ValueError):
        return None


def coverage_counts(managers: list[dict]) -> dict:
    """The one set of coverage numbers every page and the API show (index.json `counts`)."""
    qn = lambda q: int(q[:4]) * 4 + int(q[5]) - 1 if q else -1
    live = [m for m in managers if m.get("ok") and (m.get("total_value") or 0) > 0
            and m.get("status") not in ("inactive", "reported_by_other")]
    newest = max((qn(m.get("quarter")) for m in live), default=-1)
    try:
        catalog = json.loads((DATA / "filers.json").read_text()).get("filers") or []
    except (OSError, ValueError):
        catalog = []
    cik = lambda c: str(c).lstrip("0")
    filers = {cik(f["cik"]) for f in catalog if f.get("ok") and f.get("cik")} | {cik(m["cik"]) for m in managers if m.get("cik")}
    return {
        "filers": len(filers),
        "tracked": sum(1 for m in live if qn(m.get("quarter")) >= newest - 1),
        "superinvestors": sum(1 for m in managers if m.get("featured") and m.get("ok") is not False
                              and m.get("status") != "inactive"),
        "definitions": COUNT_DEFINITIONS,
    }


def write_json(payload: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    slim_managers = []
    for m in payload["managers"]:
        if not m.get("ok"):
            continue
        entry = {
            k: v
            for k, v in m.items()
            if k not in {"holdings", "history", "exited", "top_holdings", "moves", "filings"}
            and not (isinstance(v, list) and v and isinstance(v[0], dict) and "cusip" in v[0])
        }
        t = FILER_TYPES.get(m["cik"]) or {}
        entry["type"], entry["activist"] = t.get("type"), bool(t.get("activist"))
        # Long book (shares and notes) apart from option notional, so lists need not load every book.
        hs = m.get("holdings") or []
        entry["long_value"] = round(sum(h["value"] for h in hs if not h.get("put_call")))
        entry["options_value"] = round(sum(h["value"] for h in hs if h.get("put_call")))
        entry["long_positions"] = sum(1 for h in hs if not h.get("put_call"))
        # Every filing behind the latest book (original, amendments, superseded), so /f/{accession} finds the fund.
        entry["filing_accessions"] = [f["accession"] for f in m.get("filings") or [] if f.get("accession")]
        if m.get("ok"):
            entry["top"] = [{k: h[k] for k in TOP_FIELDS if k in h} for h in m["holdings"][:8]]
        slim_managers.append(entry)
    (DATA / "index.json").write_text(
        json.dumps(
            {
                "generated_at": payload["generated_at"],
                **{k: (payload.get("build") or {}).get(k) for k in ("data_built_at", "build_id")},
                "source": payload["source"],
                "disclaimer": payload["disclaimer"],
                "filed_count": payload["filed_count"],
                "manager_count": payload["manager_count"],
                "counts": coverage_counts(slim_managers),
                # The day the current filer-type set was published (filer_types.py), for "Fund types as of" labels.
                "types_as_of": types_as_of(),
                "copycat_total_value": payload["copycat"]["total_value"],
                "managers": slim_managers,
                "copycat_top": [{k: h[k] for k in TOP_FIELDS if k in h} for h in payload["copycat"]["holdings"][:20]],
            },
            separators=(",", ":"),
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


def detect_splits(payload: dict) -> int:
    """Fill SPLITS from curated histories plus every filer's books (splits.py)."""
    from ingest import splits as sp
    from ingest.datasets import prev_quarter

    transitions = sp.all_filer_transitions()
    for m in payload["managers"]:
        hist = m.get("history") or [] if m.get("ok") else []
        for a, b in zip(hist[1:], hist):
            if a.get("quarter") and prev_quarter(b["quarter"]) == a["quarter"]:
                pair = ({"columns": ["cusip", "shares", "value", "put_call", "shares_type"],
                         "rows": [[h["cusip"], h["shares"], h["value"], h["put_call"], h.get("shares_type")]
                                  for h in q["holdings"]]} for q in (a, b))
                transitions.setdefault((a["quarter"], b["quarter"]), {})[m["cik"]] = tuple(sp.book_shares(x) for x in pair)
    path = DATA / "securities.json"
    issuers = json.loads(path.read_text()) if path.exists() else {}
    links = {o: v["new"] for o, v in (cusip_links() | HELD_LINKS).items()}
    SPLITS.clear()
    SPLITS.update(sp.update(transitions, issuers, links))
    reload_links()
    print(f"splits: CUSIP reissues: {len(cusip_links())} applied, {len(HELD_LINKS)} held: "
          + "; ".join(f"{v.get('ticker') or o} {v['units_reason']}" for o, v in HELD_LINKS.items()), flush=True)
    return sum(len(v) for v in SPLITS.values())


CHANGELOG = Path(__file__).with_name("changelog.json")


def write_build_info() -> dict:
    """data/build.json (when and which build made this data) and data/changelog.json."""
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    run = os.environ.get("GITHUB_RUN_ID")
    info = {
        "data_built_at": now,
        "build_id": f"gh-{run}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}" if run else f"local-{now}",
        "scope": os.environ.get("SCOPE") or "local",
    }
    (DATA / "build.json").write_text(json.dumps(info, separators=(",", ":")) + "\n")
    log = json.loads(CHANGELOG.read_text())
    (DATA / "changelog.json").write_text(json.dumps(
        {"updated_at": max(e["date"] for e in log["entries"]), "entries": log["entries"]},
        separators=(",", ":"), ensure_ascii=False) + "\n")
    return info


VERSION_COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type",
                   "discretion", "vote_sole", "vote_shared", "vote_none")


def write_versions(payload: dict) -> int:
    """v/{cik10}/{accession}.json: each superseded 13F book (an original replaced by a RESTATEMENT,
    or an earlier restatement) exactly as that one filing reported it, in whole dollars. Paid; R2 only.
    A filing never changes, so a book is fetched once."""
    from ingest.edgar import FilingMeta

    n = 0
    for m in payload["managers"]:
        for q in (m.get("history") or []) if m.get("ok") else []:
            for f in q.get("filings") or []:
                if f.get("role") != "superseded":
                    continue
                cik = (q.get("reported_by") or {}).get("cik") or m["cik"]
                path = DATA / "v" / cik.zfill(10) / f"{f['accession']}.json"
                if path.exists():
                    continue
                meta = FilingMeta(cik=cik, accession=f["accession"], form=f["form"], filing_date=f["filing_date"],
                                  report_date=q["report_date"], primary_document="", accepted_at=f.get("accepted_at") or "")
                try:
                    book = load_filing(cik, meta)
                except Exception as exc:  # noqa: BLE001 - retried next run
                    print(f"  version {f['accession']}: {exc}", flush=True)
                    continue
                if not book:
                    continue
                rows = [[round(h.get("principal_amount") or 0) if k == "shares" and h.get("shares_type") == "PRN" else
                         round(h[k]) if k in ("shares", "value") else h.get(k) for k in VERSION_COLUMNS]
                        for h in book["holdings"]]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({
                    "cik": cik.zfill(10), "slug": m["slug"], "accession": f["accession"], "form": f["form"],
                    "amendment_type": f.get("amendment_type"), "amendment_no": f.get("amendment_no"),
                    "filing_date": f["filing_date"], "accepted_at": f.get("accepted_at"), "quarter": q["quarter"],
                    "report_date": q["report_date"], "role": "superseded", "superseded_by": q.get("accession"),
                    "sec_url": book.get("sec_url"), "values_in_thousands": book.get("values_in_thousands"),
                    "unit_fix": book.get("unit_fix"), "total_value": round(book["total_value"]),
                    "position_count": len(rows), "columns": list(VERSION_COLUMNS), "rows": rows,
                }, separators=(",", ":")) + "\n")
                n += 1
    return n


def share_reporter_books(payload: dict) -> None:
    """A curated filer that later reports another curated fund's holdings (13F-NT) shows the same
    combined book for quarters both filed, so its own changes are not the other fund's book."""
    by_cik = {m["cik"]: m for m in payload["managers"] if m.get("ok")}
    for m in list(by_cik.values()):
        for q in m.get("history") or []:
            other = by_cik.get((q.get("combined_with") or {}).get("cik") or "")
            own = OWN_BOOKS.get((m["cik"], q["report_date"]))
            if not other or not own:
                continue
            for j, rq in enumerate(other["history"]):
                if rq["report_date"] == q["report_date"] and not rq.get("combined_with") and rq.get("status") == "filed":
                    other["history"][j] = combine_books(rq, own | {"cik": m["cik"], "name": own.get("name") or m.get("name")}) \
                        | {"total_value": rq["total_value"] + own["total_value"]}
        for other in by_cik.values():
            if other["history"] and other["history"][0].get("combined_with"):
                other["holdings"] = other["history"][0]["holdings"]


def main() -> int:
    payload = ingest()
    share_reporter_books(payload)
    payload["build"] = write_build_info()
    print(f"splits: {detect_splits(payload)} known", flush=True)
    save_amend_types()
    write_alerts(payload)
    write_json(payload)
    print(f"versions: {write_versions(payload)} superseded books written", flush=True)
    print(
        f"wrote {payload['filed_count']}/{payload['manager_count']} managers, "
        f"{payload['copycat']['num_positions']} copycat names"
    )
    return 0 if payload["filed_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
