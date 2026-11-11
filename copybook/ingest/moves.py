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
from ingest.parse import ABOVE_20K, consensus_factor, consensus_prices, not_common

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
TOP = 10
MOVE_COLUMNS = ("ticker", "issuer", "cusip", "put_call", "shares", "prev_shares", "value", "value_delta", "change")
FULL_COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type", "prev_shares", "prev_value",
                "change", "share_change", "value_delta", "pct_of_book", "delta_pct_of_book", "prev_shares_as_filed",
                "split_ratio", "value_as_filed", "price_outlier", "suspect_units", "prev_cusip",
                "source_accession", "first_disclosed_at", "value_scale", "value_adjusted")


SECS: dict[str, dict] = {}
PERIOD: dict[str, str] = {}  # cik -> quarter of the book in LATEST when it is not the shard's own
LATEST: dict[str, list[dict]] = {}  # cik -> rows of its latest full book (with changes when the prior is on file)
EQUITY: dict[str, float] = {}  # cik -> value of its share positions (SH, no options, no PRN): the weight denominator
FILING: dict[str, dict] = {}  # cik -> the filing behind its LATEST book (accession, filing_date, accepted_at)
ACCEPTED: dict[str, str] = {}  # accession -> EDGAR acceptance time (accepted.py)


def filing(b: dict) -> dict:
    acc = b.get("accession")
    return {"accession": acc, "filing_date": b.get("filing_date"),
            "accepted_at": b.get("accepted_at") or ACCEPTED.get(acc or "")}
# Count blocks next to `counts` in hl/: smart = hedge funds and long-only managers, hedge_fund alone.
LENSES = {"smart": {"hedge_fund", "long_only", "active"}, "hedge_fund": {"hedge_fund"}}
HOLDERS_TOP = 25  # public rows per stock in hl/; the full list (hlf/, R2 hl/) is paid
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
    for cik, rows in LATEST.items():
        by_issuer: dict[str, float] = {}
        for r in rows:
            c = (r.get("cusip") or "").upper()
            if len(c) < 6 or c.startswith("000000") or r.get("put_call") or r.get("shares_type") == "PRN" \
                    or r.get("price_outlier") or not_common(r.get("title")):
                continue  # preferreds share the common stock's issuer code (BAC 060505682) but aren't its holders
            if r.get("suspect_units"):
                r = r | {"value_delta": 0}
            a = per.setdefault(c[:6], {}).setdefault(cik, [0, 0, 0, 0, False, 0])
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
    index, keep, written = {}, set(), set()
    cols = ["cik", "name", "slug", "type", "curated", "period", "shares", "prev_shares", "value", "prev_value", "change",
            "weight", "accession", "filing_date", "accepted_at"]
    for code, hs in per.items():
        blank = lambda: {"holders": 0, "new": 0, "added": 0, "trimmed": 0, "exited": 0, "unchanged": 0,
                         "no_prior": 0, "top10": 0, "over5pct": 0, "net": 0, "by_period": {}}
        rows, counts = [], blank()
        lenses = {name: blank() for name in LENSES}
        for cik, (sh, ps, v, pv, known, delta) in hs.items():
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
                c["net"] += round(delta) if known else 0
            m = curated.get(cik) or filers.get(cik) or {}
            fl = FILING.get(cik) or filing(meta[cik])
            rows.append([cik, meta[cik].get("name"), m.get("slug"), kind, cik in curated,
                         q, round(sh), round(ps) if known else None, round(v), round(pv) if known else None, change,
                         round(weight, 6) if weight is not None else None,
                         fl["accession"], fl["filing_date"], fl["accepted_at"]])
        if not counts["holders"]:
            continue
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
    for p in out.glob("*.json"):
        if p.name not in keep and p.name != "index.json":
            p.unlink()
    for p in full.glob("*.json"):
        if p.name not in written:
            p.unlink()
    write(out / "index.json", {"note": "ticker -> issuer code (first 6 of the CUSIP); one file per issuer in hl/",
                               "tickers": dict(sorted(index.items()))})
    return len(keep)


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
            continue
        summary, rows = got
        with_prev += 1
        # Every row names the filing that disclosed it: its own when the book says, else this book's filing
        # (an exited row is disclosed by the filing that left it out).
        acc_book = shard.get("accession")
        for r in rows:
            if not r.get("source_accession") or r.get("change") == "exited":
                r["source_accession"] = acc_book
            if not r.get("first_disclosed_at") or r.get("change") == "exited":
                r["first_disclosed_at"] = ACCEPTED.get(r["source_accession"] or "") or shard.get("accepted_at") \
                    or ACCEPTED.get(acc_book or "")
        cik = shard["cik"]
        meta = curated.get(cik) or filers.get(cik) or {}
        for r in rows:
            if r["change"] in ("new", "added", "trimmed", "exited") and r.get("shares_type") != "PRN" \
                    and not r.get("price_outlier") and not r.get("suspect_units"):
                per_quarter.setdefault(shard["quarter"], []).append([
                    cik, meta.get("slug"), shard.get("name"), cik in curated, (types.get(cik) or {}).get("type"), r["cusip"],
                    r.get("ticker"), r.get("issuer"), r.get("put_call"), r["change"], int(round(r.get("shares") or 0)),
                    int(round(r.get("prev_shares") or 0)), int(round(r.get("share_change") or 0)),
                    int(round(r.get("value") or 0)), int(round(r.get("value_delta") or 0)), shard.get("accession"),
                    shard.get("accepted_at") or ACCEPTED.get(shard.get("accession") or "")])
        if not shard.get("_fb_only"):
            write(path, base | summary)
        full = {k: v for k, v in base.items() if k not in ("rows", "columns", "truncated")} | {
            "accepted_at": base.get("accepted_at") or ACCEPTED.get(base.get("accession") or ""),
            "prev_quarter": summary["prev_quarter"],
            "equity_value": build.apply_weights({"holdings": [r for r in rows if r["change"] != "exited"]}).get("equity_value"),
            "columns": list(FULL_COLUMNS),
            "rows": [[(r.get("split") or {}).get("ratio") if k == "split_ratio" else
                      round(r.get("principal_amount") or 0) if k == "shares" and r.get("shares_type") == "PRN" else
                      round(r.get("prev_principal_amount") or 0) if k == "prev_shares" and r.get("shares_type") == "PRN" else
                      (round(r[k]) if k in ("shares", "value", "prev_shares", "prev_value", "value_delta", "share_change",
                                           "prev_shares_as_filed") and isinstance(r.get(k), float) else r.get(k))
                      for k in FULL_COLUMNS] for r in rows],
        }
        # Uploaded as R2 fb/{quarter}/{cik}.json in place of the plain book (upload_history.py).
        write(DATA / "fq" / shard["quarter"] / f"{shard['cik']}.json", full)
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
    print(f"moves: holder index for {write_holders(shards, types, curated, filers)} issuers", flush=True)
    print(f"moves: {write_combined_shards()} shards in fall/ for the site build", flush=True)
    print(f"moves: {with_prev}/{n} filers have a prior quarter on file; {FIXED[0]} lines rescaled by the "
          f"cross-filer unit check; changes for "
          + ", ".join(f"{q} {len(v)} rows" for q, v in sorted(per_quarter.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
