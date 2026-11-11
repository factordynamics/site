#!/usr/bin/env python3
"""Quarter-over-quarter changes for every 13F filer's latest book (data/f shards).

Each filer shard f/{cik}.json holds its latest quarter q. Its full book (fb/{q}/{cik}.json,
or the shard itself when complete) is compared with the previous quarter's full book
fb/{q-1}/{cik}.json by the curated ingest's rules: split-adjusted prior shares, exited
positions as value-0 rows, value_delta at this quarter's price. fb/ keeps every quarter,
so when a filer's next 13F replaces its shard the quarter before stays the baseline.

Free (Pages, in the shard): prev_quarter, change counts and the top TOP buys and sells.
Paid (data/fq/{q}/{cik}.json, uploaded as R2 fb/{q}/{cik}.json and served by the Copy API
as /v1/filers/{cik}/holdings/{q}): the full book in the shard's columnar layout plus change
columns for every position, exited rows included.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest import build
from ingest import splits as sp
from ingest.datasets import prev_quarter
from ingest.filer_types import signature
from ingest.parse import ABOVE_20K, consensus_factor, consensus_prices, not_common

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
TOP = 10
MOVE_COLUMNS = ("ticker", "issuer", "cusip", "put_call", "shares", "prev_shares", "value", "value_delta", "change")
FULL_COLUMNS = ("row_type", "ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type", "prev_shares", "prev_value",
                "change", "share_change", "value_delta", "pct_of_book", "delta_pct_of_book", "prev_shares_as_filed",
                "split_ratio", "value_as_filed", "price_outlier", "suspect_units", "suspect_units_basis", "suspect_reason", "prev_cusip",
                "source_accession", "first_disclosed_at", "value_scale", "value_adjusted")


SECS: dict[str, dict] = {}
NO_PRIOR: dict[str, dict] = {}  # cik -> latest full book with no prior quarter (served with its unit check, no changes)
PERIOD: dict[str, str] = {}  # cik -> quarter of the book in LATEST when it is not the shard's own
LATEST: dict[str, list[dict]] = {}  # cik -> rows of its latest full book (with changes when the prior is on file)
EQUITY: dict[str, float] = {}  # cik -> value of its share positions (SH, no options, no PRN): the weight denominator
FILING: dict[str, dict] = {}  # cik -> the filing behind its LATEST book (accession, filing_date, accepted_at)
ACCEPTED: dict[str, str] = {}  # accession -> EDGAR acceptance time (accepted.py)


def filing(b: dict) -> dict:
    from ingest.export import original  # the quarter's original 13F-HR, as in bulk's original_accession
    acc = b.get("accession")
    return {"accession": acc, "filing_date": b.get("filing_date"),
            "accepted_at": b.get("accepted_at") or ACCEPTED.get(acc or ""), "original_accession": original(b) or acc}
# Count blocks next to `counts` in hl/: smart = hedge funds and long-only managers, hedge_fund alone.
LENSES = {"smart": {"hedge_fund", "long_only", "active"}, "hedge_fund": {"hedge_fund"}}
HOLDERS_TOP = 25  # public rows per stock in hl/; the full list (hlf/, R2 hl/) is paid
SITE_TOP = 500  # hlr/: rows per stock for the site's d/h pages (as before, now from full books), plus every
SITE_PARTS = 4  # hedge-fund and long-only holder, so the lens lists and counts are complete
CONS: dict[tuple[str, str], float] = {}  # (quarter, cusip) -> median implied price over every filer
FIXED = [0]


def books_of(q: str, b: dict):
    cols = b["columns"]
    ci, vi, si, pi = (cols.index(k) for k in ("cusip", "value", "shares", "put_call"))
    ti = cols.index("shares_type") if "shares_type" in cols else None
    yield q, [(r[ci], r[vi] or 0, r[si] or 0, r[pi]) for r in b["rows"] if ti is None or r[ti] != "PRN"]


def outlier(price: float, cusip: str, consensus: float | None) -> bool:
    """A line priced far from every other filer's (or absurdly high with nothing to compare): kept as filed,
    flagged, and left out of cross-filer rankings."""
    if consensus:
        return not (1 / 50 <= price / consensus <= 50)
    return price > 20_000 and cusip not in ABOVE_20K


def load_consensus(quarters: set[str]) -> None:
    """Median implied price per CUSIP from every filer's full book, for the cross-filer unit check."""
    def books():
        for q in sorted(quarters):
            have = set()
            for p in (DATA / "fb" / q).glob("*.json"):
                have.add(p.stem)
                b = read(p)
                if not b or not b.get("ok"):
                    continue
                cols = b["columns"]
                ci, vi, si, pi = (cols.index(k) for k in ("cusip", "value", "shares", "put_call"))
                ti = cols.index("shares_type") if "shares_type" in cols else None
                yield q, [(r[ci], r[vi] or 0, r[si] or 0, r[pi]) for r in b["rows"]
                          if ti is None or r[ti] != "PRN"]
            for p in (DATA / "f").glob("*.json"):  # filers of q with no full book yet (data set not out)
                if p.stem in have:
                    continue
                b = read(p)
                if b and b.get("ok") and b.get("quarter") == q:
                    yield from books_of(q, b)
    CONS.update(consensus_prices(books()))


def book(rec: dict | None) -> dict | None:
    if not rec or not rec.get("ok"):
        return None
    cols = rec["columns"]
    rows = [dict(zip(cols, r)) for r in rec.get("rows") or []]
    for h in rows:
        h.setdefault("put_call", None)
        h["shares_type"] = h.get("shares_type") or "SH"
        if h["shares_type"] == "PRN":  # notes: principal amount, never shares
            h["principal_amount"], h["shares"] = h.get("shares") or 0, 0
        h["ticker"] = h.get("ticker") or (SECS.get(h.get("cusip") or "") or {}).get("ticker")
        if not h["put_call"] and h["shares_type"] == "SH" and h.get("shares") and h.get("value"):
            f = consensus_factor(h["value"] / h["shares"], CONS.get((rec.get("quarter"), h.get("cusip"))))
            if f != 1.0:  # a line filed in thousands (or 1000x too large) against every other filer's price
                if h.get("value_as_filed") is None:  # the book's own as-filed value wins when it has one
                    h["value_as_filed"] = h["value"]
                h["value"], h["value_adjusted"] = h["value"] * f, True
                h["value_scale"] = float(f"{h['value'] / h['value_as_filed']:.6g}") if h["value_as_filed"] else None
                FIXED[0] += 1
            q = rec.get("quarter") or ""
            near = CONS.get((q, h.get("cusip"))) or CONS.get((prev_quarter(q) if q else "", h.get("cusip")))
            if outlier(h["value"] / h["shares"], h.get("cusip") or "", near):
                h["price_outlier"] = True
    q = {k: v for k, v in rec.items() if k not in ("rows", "columns")} | {"holdings": rows}
    return build.apply_weights(q)


def read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text()) if path.exists() else None
    except ValueError:
        return None


def write(path: Path, body: dict) -> bool:
    text = json.dumps(body, separators=(",", ":")) + "\n"
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return True


def changes(shard: dict) -> tuple[dict, list[dict]] | None:
    """(public summary, full change rows) for one shard, or None without a prior quarter."""
    q = shard.get("quarter")
    if not (shard.get("ok") and q):
        return None
    pq = prev_quarter(q)
    cur = book(read(DATA / "fb" / q / f"{shard['cik']}.json") or (None if shard.get("truncated") else shard))
    if cur is not None and cur.get("equity_value"):
        EQUITY[shard["cik"]] = round(cur["equity_value"])
    prev = book(read(DATA / "fb" / pq / f"{shard['cik']}.json"))
    if cur is None:  # latest book only as a truncated public shard: its newest full book stands in
        if prev is not None:
            LATEST[shard["cik"]] = [h | {"change": None, "prev_shares": None, "prev_value": None} for h in prev["holdings"]]
            PERIOD[shard["cik"]] = pq
            FILING[shard["cik"]] = filing(prev)
        return None
    if prev is None:  # holdings only: still counted as holders, with no change
        LATEST[shard["cik"]] = [h | {"change": None, "prev_shares": None, "prev_value": None} for h in cur["holdings"]]
        NO_PRIOR[shard["cik"]] = cur
        FILING[shard["cik"]] = filing(cur | {k: shard[k] for k in ("accession", "filing_date", "accepted_at") if shard.get(k)})
        return None
    rows = build.with_changes(cur, prev)
    odd = {(h["cusip"], h["put_call"] or "") for h in cur["holdings"] + prev["holdings"] if h.get("price_outlier")}
    for r in rows:
        # A trade bigger than 5x both the old and the new position can only come from a mis-filed line.
        big = 5 * max(r.get("value") or 0, r.get("prev_value") or 0)
        if (r["cusip"], r.get("put_call") or "") in odd or abs(r.get("value_delta") or 0) > big:
            r["price_outlier"] = True
    moved = [r for r in rows if r["change"] not in ("unchanged", None) and not r.get("put_call")
             and not r.get("price_outlier")]
    counts = {c: sum(1 for r in rows if r["change"] == c and not r.get("put_call"))
              for c in ("new", "added", "trimmed", "exited", "unchanged")}
    pick = lambda r: [r.get(k) if k not in ("shares", "prev_shares", "value", "value_delta") else int(round(r.get(k) or 0))
                      for k in MOVE_COLUMNS]
    buys = sorted((r for r in moved if r["change"] in ("new", "added")), key=lambda r: -r["value_delta"])[:TOP]
    sells = sorted((r for r in moved if r["change"] in ("trimmed", "exited")), key=lambda r: r["value_delta"])[:TOP]
    LATEST[shard["cik"]] = rows
    FILING[shard["cik"]] = filing(cur | {k: shard[k] for k in ("accession", "filing_date", "accepted_at") if shard.get(k)})
    summary = {
        "prev_quarter": pq,
        "changes": counts,
        "moves": {"columns": list(MOVE_COLUMNS), "bought": [pick(r) for r in buys], "sold": [pick(r) for r in sells]},
    }
    return summary, rows


CHANGE_COLUMNS = ("cik", "slug", "filer_name", "curated", "type", "cusip", "ticker", "issuer", "put_call", "change",
                  "shares", "prev_shares", "share_change", "value", "value_delta", "accession", "accepted_at")
CHANGES_MAX = 20_000  # largest |value_delta| per quarter; the Worker parses the whole file


def write_changes(per_quarter: dict[str, list[list]]) -> None:
    """changes/{quarter}.json: every filer's moves in a report period (paid; R2 for /v1/changes)."""
    for q, rows in per_quarter.items():
        rows.sort(key=lambda r: -abs(r[14] or 0))
        write(DATA / "changes" / f"{q}.json", {
            "quarter": q, "rows_total": len(rows), "rows_kept": min(len(rows), CHANGES_MAX),
            "note": "new, added, trimmed and exited positions of every 13F filer against its previous quarter, "
                    "split-adjusted, whole USD; the largest by |value_delta| when rows_total exceeds rows_kept",
            "columns": list(CHANGE_COLUMNS), "rows": rows[:CHANGES_MAX]})


HF_TOP = 100  # tickers per ranking in hedge_flow.json
RECENT_HOURS = 72  # recent_filings.json: hedge-fund 13F filings accepted in this window
RECENT_MOVES = 10  # largest moves per filing


def median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def linked(cusip: str) -> str:
    """A reissued CUSIP's new one (cusip_links.json), so a filer still on the old CUSIP counts under the stock."""
    c = (cusip or "").upper()
    return (build.cusip_links().get(c) or {}).get("new") or c


PAIRS: dict[tuple[str, str], set] = {}  # (old, new) -> filers whose rows show the reissue
MIN_LINK_FILERS = 10


def collect_reissues(cik: str, rows: list[dict]) -> None:
    """Evidence for a reissue in one filer's changes: a row linked by ticker (prev_cusip), or an exited line and a
    new line with the same shares and the same ticker or issuer name."""
    for r in rows:
        if r.get("prev_cusip") and not r.get("put_call"):
            PAIRS.setdefault((r["prev_cusip"], r["cusip"]), set()).add(cik)
    word = lambda r: (r.get("ticker") or "", ((r.get("issuer") or "").upper().split() or [""])[0])
    gone = [r for r in rows if r.get("change") == "exited" and not r.get("put_call") and (r.get("prev_shares") or 0) > 0]
    if not gone:
        return
    new = {}
    for r in rows:
        if r.get("change") == "new" and not r.get("put_call") and (r.get("shares") or 0) > 0:
            new.setdefault(round(r["shares"]), []).append(r)
    by_ticker = {}
    for ns in new.values():
        for n in ns:
            if word(n)[0]:
                by_ticker.setdefault(word(n)[0], []).append(n)
    for g in gone:
        tg, wg = word(g)
        # the same shares and ticker or issuer word, or the same ticker at any share count (a reverse split that
        # came with a new CUSIP); same class only: SPAC units or rights becoming ordinary shares are not one position.
        # Evidence only: write_links links a pair when the SEC's 13(f) list confirms it, and its units are checked.
        cands = [n for n in new.get(round(g["prev_shares"]), []) if (tg and tg == word(n)[0]) or (wg and wg == word(n)[1])]
        cands += by_ticker.get(tg, []) if tg else []
        for n in cands:
            if n["cusip"] != g["cusip"] and build.same_class(g, n):
                PAIRS.setdefault((g["cusip"], n["cusip"]), set()).add(cik)


LIST_PAGE = ("https://www.sec.gov/rules-regulations/staff-guidance/division-investment-management-frequently-asked-"
             "questions/official-list-section-13f-securities")
NOT_SHARE = re.compile(r"\bUNITS?\b|\bRIGHTS?\b|\bRTS?\b|\*W\b|\bWTS?\b|WARRANT")


LIST_URLS: dict[str, str] = {}  # quarter -> the SEC 13(f) list file read


def sec_13f_lists(quarters: list[str]) -> dict[str, dict[str, tuple[str, str]]]:
    """SEC's Official List of Section 13(f) Securities per quarter: {cusip: (status A/D/'', description)}. Lists that
    can't be read are left out."""
    from ingest.edgar import ARCHIVE_BASE, get
    try:
        page = get(LIST_PAGE).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        print(f"::warning::moves: SEC 13(f) list page: {e}", flush=True)
        return {}
    out = {}
    for q in quarters:
        name = f"13flist{q.lower()}"
        href = next((h for h in re.findall(r'href="([^"]*' + name + r'[^"]*\.txt)"', page)), None)
        if not href:
            continue
        try:
            text = get(href if href.startswith("http") else ARCHIVE_BASE + href).decode("latin-1")
        except Exception as e:  # noqa: BLE001
            print(f"::warning::moves: SEC 13(f) list {q}: {e}", flush=True)
            continue
        rows = {}
        for line in text.splitlines():
            if len(line) > 40 and re.match(r"^[0-9A-Z]{9}", line):
                rest = line[40:]
                rows[line[:9]] = ("A" if "*A*" in rest else "D" if "*D*" in rest else "",
                                  re.split(r"\s{2,}|\*[AD]\*", rest.strip())[0])
        out[q] = rows
        LIST_URLS[q] = href if href.startswith("http") else ARCHIVE_BASE + href
    return out


def on_list(old: str, new: str, lists: dict) -> str | None:
    """The list quarter in which SEC deleted old and added new, neither a unit, right or warrant; else None."""
    for q, rows in sorted(lists.items(), reverse=True):
        a, b = rows.get(old), rows.get(new)
        if a and b and a[0] == "D" and b[0] == "A" and not NOT_SHARE.search(a[1]) and not NOT_SHARE.search(b[1]):
            return q
    return None


def write_links(quarter: str | None) -> list[str]:
    """cusip_links.json: reissues seen in at least MIN_LINK_FILERS filers' books that the SEC's Official 13(f) List
    confirms (old CUSIP deleted in the list that adds the new one, the link's quarter or the one before; no units,
    rights or warrants). A detected pair without that confirmation is never linked (SPAC units became their class A
    shares in 23 filers' books on Nov 11, but both still trade). Earlier confirmed links stay."""
    quarters = [quarter, prev_quarter(quarter)] if quarter else []
    lists = sec_13f_lists(quarters)
    links = {o: v for o, v in (build.cusip_links() | build.HELD_LINKS).items() if v.get("basis") == "sec_13f_list"}
    for o, v in build.SEED_LINKS.items():  # seeds are kept only when the list confirms them (or no list was readable)
        if o not in links and (not lists or on_list(o, v["new"], lists)):
            links[o] = v | {"basis": "sec_13f_list", "list_quarter": on_list(o, v["new"], lists) if lists else None}
    added, refused = [], []
    for (old, new), ciks in sorted(PAIRS.items(), key=lambda kv: -len(kv[1])):
        if len(ciks) < MIN_LINK_FILERS or old in links or old == new:
            continue
        lq = on_list(old, new, lists) if lists else None
        if not lq:
            refused.append(f"{old}->{new}")
            continue
        links[old] = {"new": new, "ticker": (SECS.get(new) or {}).get("ticker"), "quarter": quarter,
                      "basis": "sec_13f_list", "list_quarter": lq}
        added.append(old)
    print(f"moves: CUSIP reissues not on the SEC 13(f) list (not linked): {len(refused)}: {', '.join(refused[:40])}",
          flush=True)
    for old, v in links.items():
        if (old, v["new"]) in PAIRS:
            v["filers"] = len(PAIRS[(old, v["new"])])
        v["name"] = v.get("name") or (SECS.get(v["new"]) or SECS.get(old) or {}).get("name")
        v["ticker"] = v.get("ticker") or (SECS.get(v["new"]) or {}).get("ticker")
    for o, v in links.items():
        v["old"] = o
        v["list_url"] = LIST_URLS.get(v.get("list_quarter") or "") or v.get("list_url")
    # Found this run, so not yet unit-checked (the next run's split detection checks it before any book): held.
    held = {o: v if v.get("units_basis") else v | {"units_reason": v.get("units_reason") or "units unchecked: found "
            "this run; checked on the holders next run"} for o, v in links.items() if not v.get("units_basis")}
    links = {o: v for o, v in links.items() if o not in held}
    from datetime import datetime, timezone
    write(DATA / "cusip_links.json", {
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "note": "Reissued CUSIPs, old -> new. Found in 13F filings (filers = how many showed it this run) and confirmed "
                "by the SEC's Official List of Section 13(f) Securities, which deletes the old CUSIP in the list that "
                "adds the new one (list_quarter, list_url); units, rights and warrants never link. Each link's share "
                "units are checked on the holders that reported the old CUSIP one quarter and the new one the next "
                "(units_check): ratio is the prior shares' multiplier. units_basis split_confirmed: the issuer's own "
                "SEC filing states the ratio (units_check.evidence names it; HON 2026Q2 1-for-2, 8-K "
                "0000773840-26-000084; a 1:1 re-domicile such as TGLS counts too), or a split found on the pair and "
                "confirmed by SEC XBRL shares outstanding. units_basis holders_1to1: at least 5 holders and at least "
                "10% of them at exactly 1:1, more than at any other ratio, with the median ratio within 1% of 1:1 "
                "(holders trade through a reissue, so the median carries the evidence: XOM 514 of 2,333 at exactly "
                "1:1, median 1.00). Otherwise the pair is held. A filer that kept its pre-split count under the new "
                "CUSIP is flagged suspect_units (reissue_ratio_not_applied), with no change. "
                "Changes, holder counts, bulk and /v1 treat a link as one position. `held` lists SEC-confirmed "
                "reissues whose units don't check out or weren't checked yet (units_reason); they are not applied.",
        "links": links, "held": sorted(held.values(), key=lambda v: -(v.get("filers") or 0))})
    build.cusip_links().clear()
    build.cusip_links().update(links)
    build.HELD_LINKS.clear()
    build.HELD_LINKS.update(held)
    return added


def issuer_rows(rows: list[dict]):
    """(issuer6, row) for share lines a holder count can use: no options, notes, preferreds or mis-scaled lines."""
    for r in rows:
        c = linked(r.get("cusip"))
        if len(c) < 6 or c.startswith("000000") or r.get("put_call") or r.get("shares_type") == "PRN" \
                or r.get("price_outlier") or r.get("suspect_duplicate") or not_common(r.get("title")):
            continue
        yield c[:6], r


def write_hedge_flow(shards: list[dict], types: dict, curated: dict) -> tuple[int, int]:
    """hedge_flow.json (public): per report period, every hedge_fund filer (filer_types.json) that filed it and the
    quarter before, per stock. recent_filings.json (public): hedge-fund 13F filings accepted in the last
    RECENT_HOURS hours with their largest moves. Returns (periods, recent filings)."""
    meta = {s["cik"]: s for s in shards}
    hf = [c for c in LATEST if (types.get(c) or {}).get("type") == "hedge_fund"]
    period_of = lambda c: PERIOD.get(c) or (meta.get(c) or {}).get("quarter")
    agg: dict[str, dict[str, dict[str, list]]] = {}  # period -> issuer6 -> cik -> [shares, prev, value, prev_value, delta]
    names: dict[str, dict[str, float]] = {}  # issuer6 -> ticker -> value
    cusip_of: dict[str, str] = {}  # issuer6 -> a CUSIP, for its display name
    known: set[str] = set()  # filers whose latest book has a prior quarter on file (changes known)
    for cik in hf:
        q = period_of(cik)
        if not q:
            continue
        for code, r in issuer_rows(LATEST[cik]):
            if r.get("suspect_units"):
                r = r | {"value_delta": 0}
            a = agg.setdefault(q, {}).setdefault(code, {}).setdefault(cik, [0, 0, 0, 0, 0, r.get("change") is not None])
            a[0] += r.get("shares") or 0
            a[1] += r.get("prev_shares") or 0
            a[2] += r.get("value") or 0
            a[3] += r.get("prev_value") or 0
            a[4] += r.get("value_delta") or 0
            if r.get("change") is not None:
                known.add(cik)
            cusip_of.setdefault(code, r.get("cusip") or "")
            t = r.get("ticker") or (SECS.get(r.get("cusip") or "") or {}).get("ticker")
            if t:
                names.setdefault(code, {})[t] = names.setdefault(code, {}).get(t, 0) + (r.get("value") or 0)
    periods = sorted(agg, reverse=True)[:2]
    out = {}
    for q in periods:
        pq = prev_quarter(q)
        filed = {c for c in known if period_of(c) == q}
        stocks = {}
        for code, hs in agg[q].items():
            t = max(names[code], key=names[code].get) if names.get(code) else None
            if not t:
                continue
            both = {c: x for c, x in hs.items() if x[5]}  # filed both quarters: a known change
            buyers = [c for c, x in both.items() if x[0] > x[1] + 0.5]
            sellers = [c for c, x in both.items() if x[0] < x[1] - 0.5]
            if not buyers and not sellers:
                continue
            held_prev = sum(1 for x in both.values() if x[1] > 0)
            # Hedge funds that held it last quarter and have not filed this one yet: their latest book is pq.
            waiting = sum(1 for c, x in agg.get(pq, {}).get(code, {}).items() if x[0] > 0 and period_of(c) == pq)
            holders = [c for c, x in both.items() if x[0] > 0]  # same funds as holders_prev, so the change adds up
            stocks[t] = {
                "ticker": t,
                "name": (SECS.get(cusip_of.get(code) or "") or {}).get("name"),
                "issuer6": code,
                "buyers": len(buyers), "sellers": len(sellers), "breadth": len(buyers) - len(sellers),
                "new_count": sum(1 for c in buyers if both[c][1] <= 0),
                "exited_count": sum(1 for c in sellers if both[c][0] <= 0),
                "holders": len(holders), "holders_prev": held_prev,
                "holder_change": len(holders) - held_prev,
                "median_pct_of_book": (lambda m: round(m, 6) if m is not None else None)(
                    median([hs[c][2] / EQUITY[c] for c in holders if EQUITY.get(c)])),
                "bought_usd": round(sum(both[c][4] for c in buyers)),
                "sold_usd": round(sum(both[c][4] for c in sellers)),
                "net_usd": round(sum(x[4] for x in both.values())),
                "gross_usd": round(sum(abs(x[4]) for x in both.values())),
                # "Filed N of M hedge funds that held it last quarter"
                "filed_of_prev_holders": [held_prev, held_prev + waiting],
            }
        rank = lambda key, cond=lambda s: True, rev=True: [s["ticker"] for s in sorted(
            (s for s in stocks.values() if cond(s)), key=key, reverse=rev)][:HF_TOP]
        lists = {
            "breadth_up": rank(lambda s: (s["breadth"], s["net_usd"]), lambda s: s["breadth"] > 0),
            "breadth_down": rank(lambda s: (s["breadth"], s["net_usd"]), lambda s: s["breadth"] < 0, False),
            "new_3plus": rank(lambda s: (s["new_count"], s["bought_usd"]), lambda s: s["new_count"] >= 3),
            "exited_3plus": rank(lambda s: (s["exited_count"], -s["sold_usd"]), lambda s: s["exited_count"] >= 3),
            "holder_change_up": rank(lambda s: (s["holder_change"], s["net_usd"]), lambda s: s["holder_change"] > 0),
            "holder_change_down": rank(lambda s: (s["holder_change"], s["net_usd"]), lambda s: s["holder_change"] < 0, False),
            "net_bought": rank(lambda s: s["net_usd"], lambda s: s["net_usd"] > 0),
            "net_sold": rank(lambda s: s["net_usd"], lambda s: s["net_usd"] < 0, False),
        }
        keep = {t for v in lists.values() for t in v}
        out[q] = {"quarter": q, "prev_quarter": pq, "funds_filed": len(filed),
                  "funds_total": sum(1 for c in hf if period_of(c) in (q, pq)),
                  "lists": lists, "stocks": {t: stocks[t] for t in sorted(keep)}}
    write(DATA / "hedge_flow.json", {
        "generated_at": (read(DATA / "index.json") or {}).get("generated_at"),
        "types_sig": signature(types),
        "note": "Hedge funds (filer_types.json type hedge_fund) across every 13F filer, per report period, counting only "
                "funds that filed the period and the quarter before. Split-adjusted; options, notes and mis-scaled lines "
                "left out. breadth = buyers - sellers; filed_of_prev_holders = [N, M]: N of the M hedge funds that held "
                "it last quarter have filed this one. Lists name the top tickers; stocks has each one's figures.",
        "periods": [out[q] for q in periods]})
    # Filings accepted in the last RECENT_HOURS hours.
    from datetime import datetime, timedelta, timezone
    since = (datetime.now(timezone.utc) - timedelta(hours=RECENT_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    recent = []
    for cik in hf:
        f = FILING.get(cik) or {}
        at = f.get("accepted_at") or ""
        if at < since:
            continue
        rows = [r for r in LATEST[cik] if r.get("change") in ("new", "added", "trimmed", "exited")
                and not r.get("put_call") and r.get("shares_type") != "PRN" and not r.get("price_outlier")
                and not r.get("suspect_units")]
        rows.sort(key=lambda r: -abs(r.get("value_delta") or 0))
        eq = EQUITY.get(cik)
        m = curated.get(cik) or {}
        recent.append({
            "cik": cik, "name": (meta.get(cik) or {}).get("name") or m.get("name"), "slug": m.get("slug"),
            "curated": cik in curated, "quarter": period_of(cik), "accession": f.get("accession"),
            "accepted_at": at, "has_prior": any(r.get("change") is not None for r in LATEST[cik]),
            "moves": [{"ticker": r.get("ticker") or (SECS.get(r.get("cusip") or "") or {}).get("ticker"),
                       "cusip": r.get("cusip"), "issuer": r.get("issuer"), "change": r["change"],
                       "share_change": int(round(r.get("share_change") or 0)),
                       "value_delta": int(round(r.get("value_delta") or 0)),
                       "pct_of_book": round((r.get("value") or 0) / eq, 6) if eq else None,
                       "prev_pct_of_book": round((r.get("prev_value") or 0) / eq, 6) if eq else None}
                      for r in rows[:RECENT_MOVES]]})
    recent.sort(key=lambda x: x["accepted_at"], reverse=True)
    write(DATA / "recent_filings.json", {
        "generated_at": (read(DATA / "index.json") or {}).get("generated_at"), "since": since, "hours": RECENT_HOURS,
        "note": "Hedge-fund 13F-HR filings accepted since `since` (EDGAR acceptance, UTC), newest first, each with its "
                "largest moves against its prior quarter (split-adjusted; pct_of_book over the filer's share book).",
        "filings": recent})
    return len(periods), len(recent)


def fill_provenance(rows: list[dict], shard: dict) -> None:
    """Every row names the filing that disclosed it: its own when the book says, else this book's filing (an exited
    row is disclosed by the filing that left it out)."""
    acc_book = shard.get("accession")
    for r in rows:
        if not r.get("source_accession") or r.get("change") == "exited":
            r["source_accession"] = acc_book
        if not r.get("first_disclosed_at") or r.get("change") == "exited":
            r["first_disclosed_at"] = ACCEPTED.get(r["source_accession"] or "") or shard.get("accepted_at") \
                or ACCEPTED.get(acc_book or "")


def write_full(base: dict, prev_q: str | None, rows: list[dict]) -> None:
    """fq/{quarter}/{cik}.json: the full book with change columns, uploaded as R2 fb/{quarter}/{cik}.json in place
    of the plain book (upload_history.py)."""
    full = {k: v for k, v in base.items() if k not in ("rows", "columns", "truncated", "_fb_only")} | {
        "accepted_at": base.get("accepted_at") or ACCEPTED.get(base.get("accession") or ""),
        "prev_quarter": prev_q,
        # The rows' total after per-line unit fixes (Regions 78468R622 filed $1, served $1,000), not the filed total.
        "total_value": round(sum(r.get("value") or 0 for r in rows if r.get("change") != "exited")),
        "equity_value": build.apply_weights({"holdings": [r for r in rows if r["change"] != "exited"]}).get("equity_value"),
        "columns": list(FULL_COLUMNS),
        "rows": [[(r.get("split") or {}).get("ratio") if k == "split_ratio" else
                  round(r.get("principal_amount") or 0) if k == "shares" and r.get("shares_type") == "PRN" else
                  round(r.get("prev_principal_amount") or 0) if k == "prev_shares" and r.get("shares_type") == "PRN" else
                  (round(r[k]) if k in ("shares", "value", "prev_shares", "prev_value", "value_delta", "share_change",
                                       "prev_shares_as_filed") and isinstance(r.get(k), float) else r.get(k))
                  for k in FULL_COLUMNS] for r in rows],
    }
    write(DATA / "fq" / base["quarter"] / f"{base['cik']}.json", full)


PRIOR = DATA / "fb" / "_prior"  # {quarter}.json.gz: the quarter before the oldest stored one (never uploaded)


def prior_books(q: str) -> dict[str, dict]:
    """Every filer's book for q, the quarter before the oldest one in fb/, from the SEC 13F data set. Read once
    and kept in the fb/ cache as one gzipped file; it only supplies prior-quarter fields, never a served book."""
    import gzip
    path = PRIOR / f"{q}.json.gz"
    if path.exists():
        try:
            books = json.loads(gzip.decompress(path.read_bytes()))
            if books:  # an empty cached file (LSV 2026Q1 had no changes on /v1) is refetched
                print(f"moves: prior quarter {q}: {len(books)} books (cached)", flush=True)
                return books
        except (OSError, ValueError):
            pass
    from ingest import datasets
    urls = datasets.sets_for(q, datasets.windows())
    if not urls:
        print(f"::warning::moves: no SEC 13F data set covers {q}; the oldest stored quarter gets no changes", flush=True)
        return {}
    books = {c: b for c, b in datasets.read_period(q, [datasets.fetch_set(u) for u in urls]).items() if b.get("ok")}
    print(f"moves: prior quarter {q}: {len(books)} books from {len(urls)} SEC data set(s)", flush=True)
    if not books:
        print(f"::warning::moves: no books for prior quarter {q}; not cached", flush=True)
        return books
    PRIOR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps(books, separators=(",", ":")).encode(), 6, mtime=0))
    return books


def older_changes(shards: list[dict], curated: dict, per_quarter: dict[str, list[list]], row_of) -> int:
    """Full runs only: change columns for every stored quarter that is not a filer's latest (its latest is done
    above), against the quarter before: from fb/, or for the oldest stored quarter from prior_books. Curated
    funds are served from h/ and skipped. Returns the books written."""
    latest = {s["cik"]: s.get("quarter") for s in shards}
    folders = sorted(p for p in (DATA / "fb").glob("*Q?") if p.is_dir())
    if not folders:
        return 0
    oldest = folders[0].name
    prior: dict[str, dict] | None = None
    n = 0
    for folder in folders:
        q, pq = folder.name, prev_quarter(folder.name)
        for p in sorted(folder.glob("*.json")):
            cik = p.stem
            if cik in curated or latest.get(cik) == q:
                continue
            rec = read(p)
            cur = book(rec)
            if cur is None:
                continue
            prev_rec = read(DATA / "fb" / pq / f"{cik}.json")
            if prev_rec is None and q == oldest:
                if prior is None:
                    try:
                        prior = prior_books(pq)
                    except Exception as e:  # noqa: BLE001 - the next full run tries again
                        print(f"::warning::moves: prior quarter {pq} from the SEC data set failed: {e}", flush=True)
                        prior = {}
                prev_rec = prior.get(cik)
            prev = book(prev_rec)  # None: no prior anywhere; the book still gets its unit check and provenance
            rows = build.with_changes(cur, prev)
            for r in rows:
                if not r.get("source_accession") or r.get("change") == "exited":
                    r["source_accession"] = rec.get("accession")
                if not r.get("first_disclosed_at") or r.get("change") == "exited":
                    r["first_disclosed_at"] = ACCEPTED.get(r["source_accession"] or "") or rec.get("accepted_at")
                if r["change"] in ("new", "added", "trimmed", "exited") and r.get("shares_type") != "PRN" \
                        and not r.get("price_outlier") and not r.get("suspect_units"):
                    per_quarter.setdefault(q, []).append(row_of(cik, rec, r))
            write_full(rec | {"cik": cik, "quarter": q}, pq if prev is not None else None, rows)
            n += 1
    return n


def write_holders(shards: list[dict], types: dict, curated: dict, filers: dict) -> int:
    """hl/{issuer6}.json: every 13F filer holding the stock in its latest full book (never the top-500
    public shard), with the period of that book and its change against the filer's prior quarter.
    Public (Pages): hl/{issuer6}.json with counts over all holders and the HOLDERS_TOP largest rows, for
    issuers with a ticker; hl/index.json maps tickers. Paid: hlf/{issuer6}.json, every holder (R2 hl/)."""
    meta = {s["cik"]: s for s in shards}
    per: dict[str, dict[str, list]] = {}
    tick: dict[str, dict[str, float]] = {}
    book: dict[str, float] = {}  # cik -> value of its share positions (the weight denominator)
    top10: dict[str, set] = {}  # cik -> issuer codes among its ten largest share positions
    held_codes = {c for o, v in build.HELD_LINKS.items() for c in (o, v["new"])}
    for cik, rows in LATEST.items():
        by_issuer: dict[str, float] = {}
        for r in rows:
            c = linked(r.get("cusip"))
            if r.get("suspect_duplicate"):  # the filer is counted once, on the new code; its row says so
                if len(c) >= 6:
                    per.setdefault(c[:6], {}).setdefault(cik, [0, 0, 0, 0, False, 0, False, None, False, False])[8] = True
                continue
            if len(c) < 6 or c.startswith("000000") or r.get("put_call") or r.get("shares_type") == "PRN" \
                    or not_common(r.get("title")):
                continue  # preferreds share the common stock's issuer code (BAC 060505682) but aren't its holders
            if r.get("suspect_units"):
                r = r | {"value_delta": 0}
            # A mis-valued line (BMO 2026Q3 TEVA at ~$4,005 a share, 101x every other filer): its shares still make
            # it a holder, but its value stays out of weights and $ and its change is unknown.
            bad_value = bool(r.get("price_outlier"))
            if bad_value:
                r = r | {"value": 0, "prev_value": 0, "value_delta": 0}
            a = per.setdefault(c[:6], {}).setdefault(cik, [0, 0, 0, 0, False, 0, False, None, False, False])
            a[6] = a[6] or bad_value
            a[9] = a[9] or bad_value
            a[7] = a[7] or r.get("prev_cusip")
            # A held reissue (units unconfirmed) whose codes share an issuer prefix (BYND 08862E109 -> 08862E307):
            # its exit and new line would net to a false trim at mismatched units, so the change is unknown.
            if r.get("change") in ("new", "exited") and (r.get("cusip") or "").upper() in held_codes:
                a[6] = True
            a[0] += r.get("shares") or 0
            a[1] += r.get("prev_shares") or 0
            a[2] += r.get("value") or 0
            a[3] += r.get("prev_value") or 0
            a[4] = a[4] or r.get("change") is not None
            a[5] += r.get("value_delta") or 0
            by_issuer[c[:6]] = by_issuer.get(c[:6], 0) + (r.get("value") or 0)
            t = r.get("ticker") or (SECS.get(c) or {}).get("ticker")
            if t:
                tick.setdefault(c[:6], {})[t] = tick.setdefault(c[:6], {}).get(t, 0) + (r.get("value") or 0)
        book[cik] = EQUITY.get(cik) or sum(by_issuer.values())  # the SH book, as on stock pages
        top10[cik] = {k for k, v in sorted(by_issuer.items(), key=lambda kv: -kv[1])[:10] if v > 0}
    out, full = DATA / "hl", DATA / "hlf"
    out.mkdir(exist_ok=True)
    full.mkdir(exist_ok=True)
    index, keep, written, site = {}, set(), set(), {}
    cols = ["cik", "name", "slug", "type", "curated", "period", "shares", "prev_shares", "value", "prev_value", "change",
            "weight", "accession", "filing_date", "accepted_at", "original_accession", "prev_cusip", "suspect_duplicate",
            "price_outlier", "value_basis"]
    for code, hs in per.items():
        blank = lambda: {"holders": 0, "new": 0, "added": 0, "trimmed": 0, "exited": 0, "unchanged": 0,
                         "no_prior": 0, "top10": 0, "over5pct": 0, "net": 0, "net_by_period": {}, "by_period": {}}
        rows, counts, deltas = [], blank(), {}
        lenses = {name: blank() for name in LENSES}
        for cik, (sh, ps, v, pv, known, delta, unsure, prev_cusip, dup, bad_value) in hs.items():
            known = known and not unsure
            change = None
            if known:
                change = ("exited" if sh <= 0 else "new" if ps <= 0 else "added" if sh > ps + 0.5
                          else "trimmed" if sh < ps - 0.5 else "unchanged")
            q = PERIOD.get(cik) or meta[cik].get("quarter")
            kind = (types.get(cik) or {}).get("type")
            weight = v / book[cik] if book.get(cik) else None
            for c in [counts] + [lenses[n] for n, kinds in LENSES.items() if kind in kinds]:
                if sh > 0:
                    c["holders"] += 1
                    c["by_period"][q] = c["by_period"].get(q, 0) + 1
                    c["top10"] += code in top10.get(cik, ())
                    c["over5pct"] += bool(weight and weight > 0.05)
                c[change or "no_prior"] += 1
                if known:
                    c["net_by_period"][q] = c["net_by_period"].get(q, 0) + round(delta)
            deltas[cik] = round(delta) if known else None
            m = curated.get(cik) or filers.get(cik) or {}
            fl = FILING.get(cik) or filing(meta[cik])
            rows.append([cik, meta[cik].get("name"), m.get("slug"), kind, cik in curated,
                         q, round(sh), round(ps) if known else None, round(v), round(pv) if known else None, change,
                         round(weight, 6) if weight is not None else None,
                         fl["accession"], fl["filing_date"], fl["accepted_at"],
                         fl.get("original_accession") or fl["accession"], prev_cusip, dup,
                         bad_value, "filed_price_outlier" if bad_value else "filed"])
        if not counts["holders"]:
            continue
        # net is one quarter's trades, as /v1: the latest quarter any holder reports (net_quarter); net_by_period
        # keeps each quarter's sum, since holders' latest books span quarters during filing season.
        nq = max((PERIOD.get(cik) or meta[cik].get("quarter") or "" for cik in hs), default=None)
        for c in [counts] + list(lenses.values()):
            c["net_quarter"], c["net"] = nq, c["net_by_period"].get(nq, 0)
        rows.sort(key=lambda r: -(r[8] or r[9] or 0))
        tickers = sorted(tick.get(code, {}), key=lambda t: -tick[code][t])
        for t in tickers:
            index.setdefault(t, code)
        name = f"{code}.json"
        body = {"issuer": code, "tickers": tickers, "counts": counts, **lenses, "columns": cols, "rows_total": len(rows)}
        written.add(name)
        write(full / name, {**body, "rows": rows})
        if tickers:
            keep.add(name)
            write(out / name, {**body, "rows": rows[:HOLDERS_TOP]})
            top = {r[0] for r in [r for r in rows if r[6] > 0][:SITE_TOP]}
            site[code] = [[r[0], r[5], r[6], r[8], r[11], r[10], deltas[r[0]], int(code in top10.get(r[0], ()))]
                          for r in rows if r[0] in top or r[3] in LENSES["smart"]]
    for p in out.glob("*.json"):
        if p.name not in keep and p.name != "index.json":
            p.unlink()
    for p in full.glob("*.json"):
        if p.name not in written:
            p.unlink()
    write(out / "index.json", {"note": "ticker -> issuer code (first 6 of the CUSIP); one file per issuer in hl/",
                               "types_sig": signature(types), "tickers": dict(sorted(index.items()))})
    write_site_holders(site, signature(types))
    return len(keep)


def write_site_holders(site: dict[str, list], sig: str) -> None:
    """hlr/{i}.json.gz + hlr/index.json: per issuer with a ticker, the holder rows the site's stock pages list
    (d/h/{TICKER}.json, stocks.mjs): the SITE_TOP largest holders by value plus every hedge-fund and long-only
    holder (exits too, for the lens moves), from each filer's full latest book like hl/. Pages used each filer's
    top-500 public shard before, which left multi-strategy funds out of mid- and small-cap pages."""
    import gzip

    out = DATA / "hlr"
    out.mkdir(exist_ok=True)
    codes = sorted(site)
    parts = []
    for i in range(SITE_PARTS):
        name = f"{i}.json.gz"
        raw = json.dumps({"issuers": {c: site[c] for c in codes[i::SITE_PARTS]}}, separators=(",", ":")).encode()
        (out / name).write_bytes(gzip.compress(raw, 9, mtime=0))
        parts.append({"file": name, "issuers": len(codes[i::SITE_PARTS]), "bytes": (out / name).stat().st_size})
    write(out / "index.json", {
        "generated_at": (read(DATA / "index.json") or {}).get("generated_at"), "types_sig": sig,
        "columns": ["cik", "period", "shares", "value", "weight", "change", "value_delta", "top10"],
        "note": "Per issuer: its SITE_TOP largest holders plus every hedge_fund and long_only holder, from full books "
                "(hl/). Rows with shares 0 are exits. For the site build.", "parts": parts})


FALL_PARTS = 4


def write_combined_shards() -> int:
    """fall/{i}.json.gz: every f/ shard in FALL_PARTS gzipped files, for the site build, which otherwise
    fetches ~9,000 shards one by one from Pages and gets rate-limited. Each part is
    {"shards": {cik: shard}}; fall/index.json lists the parts. The f/{cik}.json files stay as they are."""
    import gzip

    out = DATA / "fall"
    out.mkdir(exist_ok=True)
    paths = sorted((DATA / "f").glob("*.json"))
    parts = []
    for i in range(FALL_PARTS):
        body = {}
        for path in paths[i::FALL_PARTS]:
            shard = read(path)
            if shard is not None:
                body[path.stem] = shard
        name = f"{i}.json.gz"
        raw = json.dumps({"shards": body}, separators=(",", ":")).encode()
        (out / name).write_bytes(gzip.compress(raw, 9, mtime=0))
        parts.append({"file": name, "shards": len(body), "bytes": (out / name).stat().st_size})
    write(out / "index.json", {
        "generated_at": (read(DATA / "index.json") or {}).get("generated_at"),
        "note": "Every f/{cik}.json shard, gzipped, in parts: {\"shards\": {cik: shard}} each. Built with the all-filer data.",
        "parts": parts, "shards": sum(x["shards"] for x in parts)})
    return sum(x["shards"] for x in parts)


def main() -> int:
    build.SPLITS.clear()
    build.SPLITS.update(sp.table())
    SECS.update(read(DATA / "securities.json") or {})
    ACCEPTED.update(read(DATA / "accepted.json") or {})
    shards = [s for p in sorted((DATA / "f").glob("*.json")) if (s := read(p))]
    # Filers with a full book but no public shard yet: their newest full book, for the holder index
    # and change files only (no public shard is written for them).
    have = {s.get("cik") for s in shards}
    for folder in sorted((DATA / "fb").glob("*Q?"), reverse=True):
        for p in folder.glob("*.json"):
            if p.stem not in have:
                b = read(p)
                if b and b.get("ok"):
                    have.add(p.stem)
                    shards.append(b | {"cik": p.stem, "quarter": b.get("quarter") or folder.name, "_fb_only": True})
    qs = {s["quarter"] for s in shards if s.get("ok") and s.get("quarter")}
    load_consensus(qs | {prev_quarter(q) for q in qs})
    build.CONSENSUS.clear()
    build.CONSENSUS.update(CONS)  # the cross-filer price check in with_changes; build.py reads consensus.json
    keep = sorted({q for q, _ in CONS})[-3:]
    write(DATA / "consensus.json", {
        "note": "Median value per share of each CUSIP across every 13F filer's full book, per quarter (SEC 13F only). "
                "A line over 3x off is flagged suspect_units and kept out of flows and alerts.",
        "quarters": {q: {c: float(f"{px:.6g}") for (qq, c), px in sorted(CONS.items()) if qq == q} for q in keep}})
    n = with_prev = 0
    index = read(DATA / "index.json") or {}
    curated = {m["cik"]: m for m in index.get("managers") or []}
    filers = {f["cik"]: f for f in (read(DATA / "filers.json") or {}).get("filers") or []}
    from ingest.filer_types import load as load_types
    types = load_types()
    per_quarter: dict[str, list[list]] = {}

    def row_of(cik: str, rec: dict, r: dict) -> list:
        meta = curated.get(cik) or filers.get(cik) or {}
        return [cik, meta.get("slug"), rec.get("name") or meta.get("name"), cik in curated, (types.get(cik) or {}).get("type"),
                r["cusip"], r.get("ticker"), r.get("issuer"), r.get("put_call"), r["change"], int(round(r.get("shares") or 0)),
                int(round(r.get("prev_shares") or 0)), int(round(r.get("share_change") or 0)),
                int(round(r.get("value") or 0)), int(round(r.get("value_delta") or 0)), rec.get("accession"),
                rec.get("accepted_at") or ACCEPTED.get(rec.get("accession") or "")]

    for shard in shards:
        path = DATA / "f" / f"{shard['cik']}.json"
        n += 1
        got = changes(shard)
        base = {k: v for k, v in shard.items() if k not in ("prev_quarter", "changes", "moves", "equity_value")}
        if EQUITY.get(shard["cik"]):  # weights on the share (SH) book, never the total with notes and options
            base["equity_value"] = EQUITY[shard["cik"]]
        if got is None:
            if not shard.get("_fb_only"):
                write(path, base)
            if shard["cik"] in NO_PRIOR:  # /v1 still gets suspect_units (cross-filer) and provenance on every row
                rows = build.with_changes(NO_PRIOR[shard["cik"]], None)
                fill_provenance(rows, shard)
                write_full(base, None, rows)
            continue
        summary, rows = got
        with_prev += 1
        fill_provenance(rows, shard)
        cik = shard["cik"]
        collect_reissues(cik, rows)
        for r in rows:
            if r["change"] in ("new", "added", "trimmed", "exited") and r.get("shares_type") != "PRN" \
                    and not r.get("price_outlier") and not r.get("suspect_units"):
                per_quarter.setdefault(shard["quarter"], []).append(row_of(cik, shard, r))
        if not shard.get("_fb_only"):
            write(path, base | summary)
        write_full(base, summary["prev_quarter"], rows)
    if os.environ.get("SCOPE", "full") == "full":  # curated runs must stay quick on filing days
        print(f"moves: changes for {older_changes(shards, curated, per_quarter, row_of)} books of earlier quarters",
              flush=True)
    write_changes(per_quarter)
    # A curated fund's own book ({slug}.json, full and point-in-time) is its latest when at least as new.
    for cik, m in curated.items():
        b = read(DATA / f"{m['slug']}.json")
        if not b or not b.get("quarter"):
            continue
        if cik not in {s["cik"] for s in shards}:
            shards.append({"cik": cik, "name": b.get("name") or m.get("name"), "quarter": b["quarter"], "_fb_only": True})
        cur = next(s for s in shards if s["cik"] == cik)
        if b["quarter"] >= (PERIOD.get(cik) or cur.get("quarter") or ""):
            LATEST[cik] = [h | {"shares_type": h.get("shares_type") or "SH"} for h in (b.get("holdings") or []) + (b.get("exited") or [])]
            PERIOD[cik] = b["quarter"]
            FILING[cik] = filing(b)
            if b.get("equity_value"):
                EQUITY[cik] = round(b["equity_value"])
    added = write_links(max((s.get("quarter") or "" for s in shards), default=None))
    print(f"moves: CUSIP reissues: {len(build.cusip_links())} linked ({', '.join(added) or 'none'} new this run): "
          + "; ".join(f"{o}->{v['new']} {v.get('ticker')} {v.get('filers')} filers" for o, v in build.cusip_links().items()),
          flush=True)
    print(f"moves: holder index for {write_holders(shards, types, curated, filers)} issuers", flush=True)
    print("moves: hedge_flow.json %d periods, recent_filings.json %d filings" % write_hedge_flow(shards, types, curated),
          flush=True)
    print(f"moves: {write_combined_shards()} shards in fall/ for the site build", flush=True)
    print(f"moves: {with_prev}/{n} filers have a prior quarter on file; {FIXED[0]} lines rescaled by the "
          f"cross-filer unit check; changes for "
          + ", ".join(f"{q} {len(v)} rows" for q, v in sorted(per_quarter.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
