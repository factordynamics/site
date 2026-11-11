#!/usr/bin/env python3
"""Apply data/securities.json (ticker, display_name, sector) to every published JSON file.

Raw SEC issuer names stay in `issuer`; `display_name` is the cleaned name.
Also writes the copycat sector mix to copycat_lite.json, every dollar labelled.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.figi import load_cache
from ingest.bulk import MAX_ROWS
from ingest.parse import consensus_prices, in_dollars, unit_verdict
from ingest.securities import UNCLASSIFIED

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
SKIP = {"books.json", "universe.json", "filers.json", "alerts.json", "cusip_map.json", "securities.json", "issuers.json", "amendments.json", "notices.json", "status.json"}
FIELDS = ("ticker", "display_name", "sector")


def lookup(secs: dict, figi: dict, cusip: str) -> tuple:
    s = secs.get(cusip)
    if s:
        return s["ticker"], s["name"], s["sector"]
    return figi.get(cusip) or None, None, UNCLASSIFIED


def walk(obj, secs: dict, figi: dict) -> bool:
    changed = False
    if isinstance(obj, dict):
        cols = obj.get("columns")
        if isinstance(cols, list) and "cusip" in cols and isinstance(obj.get("rows"), list):
            for f in FIELDS:
                if f not in cols:
                    cols.append(f)
                    for r in obj["rows"]:
                        r.append(None)
                    changed = True
            ci = cols.index("cusip")
            idx = [cols.index(f) for f in FIELDS]
            for r in obj["rows"]:
                for i, v in zip(idx, lookup(secs, figi, r[ci])):
                    if r[i] != v:
                        r[i] = v
                        changed = True
        cusip = obj.get("cusip")
        if isinstance(cusip, str) and ("ticker" in obj or "issuer" in obj):
            for f, v in zip(FIELDS, lookup(secs, figi, cusip)):
                if obj.get(f) != v:
                    obj[f] = v
                    changed = True
        for v in obj.values():
            if isinstance(v, (dict, list)):
                changed |= walk(v, secs, figi)
    elif isinstance(obj, list):
        for v in obj:
            if isinstance(v, (dict, list)):
                changed |= walk(v, secs, figi)
    return changed


CSV_FIELDS = (
    "manager", "slug", "cik", "quarter", "report_date", "filing_date", "accession", "ticker",
    "issuer", "cusip", "title", "put_call", "shares", "value_usd", "weight",
    # Change vs the prior quarter in this history; exited positions are listed with shares 0.
    "change", "prev_shares", "share_change", "value_delta_usd", "delta_pct_of_book",
    # Row detail: weight == pct_of_book (share positions only; options and PRN notes are blank).
    "pct_of_book", "shares_type", "principal_amount", "split_ratio", "prev_shares_as_filed",
    "source_accession", "first_disclosed_at", "late_disclosure",
    "discretion", "other_managers", "vote_sole", "vote_shared", "vote_none",
)
ROW_FIELDS = ("change", "prev_shares", "share_change", "value_delta", "delta_pct_of_book", "pct_of_book",
              "shares_type", "principal_amount")


def num(v):
    return int(v) if isinstance(v, float) and v.is_integer() else v


def quarter_csv(q: dict) -> str:
    """One quarter's full book as RFC 4180 CSV (CRLF) for the Copy API to pass through."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(CSV_FIELDS)
    meta = [q.get(k) or "" for k in ("manager", "slug", "cik", "quarter", "report_date", "filing_date", "accession")]
    for h in (q.get("holdings") or []) + (q.get("exited") or []):
        w.writerow(meta + [
            h.get("ticker") or "", h.get("issuer") or "", h.get("cusip") or "", h.get("title") or "",
            h.get("put_call") or "", num(h.get("shares") or 0), num(h.get("value") or 0), h.get("weight") or 0,
        ] + ["" if h.get(k) is None else num(h[k]) for k in ROW_FIELDS] + [
            (h.get("split") or {}).get("ratio") or "", "" if h.get("prev_shares_as_filed") is None else num(h["prev_shares_as_filed"]),
            h.get("source_accession") or "", h.get("first_disclosed_at") or "", "true" if h.get("late_disclosure") else "",
            h.get("discretion") or "", " ".join(h.get("other_managers") or []),
            *("" if h.get(k) is None else num(h[k]) for k in ("vote_sole", "vote_shared", "vote_none")),
        ])
    return buf.getvalue()


def write_csvs() -> int:
    """h/{slug}/{quarter}.csv next to each quarter file, and csv_url in both history indexes."""
    n = 0
    for path in sorted((DATA / "h").glob("*/*Q?.json")):
        text = quarter_csv(json.loads(path.read_text()))
        out = path.with_suffix(".csv")
        data = text.encode("utf-8")
        if not out.exists() or out.read_bytes() != data:
            out.write_bytes(data)
            n += 1
    for path in (DATA / "h").glob("*/*.csv"):
        if not path.with_suffix(".json").exists():
            path.unlink()
    for path in sorted(DATA.glob("*-history.json")) + sorted((DATA / "h").glob("*/index.json")):
        idx = json.loads(path.read_text())
        changed = False
        for q in idx.get("history") or []:
            url = q.get("holdings_url")
            if url and url.endswith(".json") and q.get("csv_url") != url[:-5] + ".csv":
                q["csv_url"] = url[:-5] + ".csv"
                changed = True
        if changed:
            path.write_text(json.dumps(idx, separators=(",", ":")) + "\n")
    return n


COVER_FETCH_MAX = int(os.environ.get("COPYBOOK_COVER_FETCH_MAX", "300"))  # cover pages fetched per run (once a filing)


def cover_total(r: dict, budget: list[int]) -> float | None:
    """The filing's cover-page tableValueTotal: on shards from Nov 11 on, else fetched once and kept on the shard."""
    if r.get("cover_total") is not None or r.get("amendments") or budget[0] <= 0 or not r.get("accession"):
        return r.get("cover_total")
    budget[0] -= 1
    try:
        from ingest.edgar import fetch_primary_doc, table_value_total
        c = table_value_total(fetch_primary_doc(r["cik"], r["accession"]))
        # as build.load_filing: a cover in thousands for a book scaled to dollars
        r["cover_total"] = c * 1000 if c and r.get("values_in_thousands") and (r.get("total_value") or 0) / c > 300 else c
    except Exception as exc:  # optional: without it the shard just isn't judged in dollars
        print(f"::warning::enrich: cover page {r.get('accession')}: {exc}")
    return r.get("cover_total")


def fix_shards() -> int:
    """The x1000 unit rule for every filer shard, the same as curated books (parse.unit_verdict), against curated
    books' prices for the quarter. A shard is rebuilt from its full book (fb/, same accession) when there is one: the
    full book keeps each line's value before any consensus rescale, so an earlier build's x1000 is judged again (Mizuho
    Securities USA 2026Q3 read $11.91B with ON and AKAM x1000; its lines sum to the $6.30B cover). Lines that keep
    their filed value are listed in value_rescale_rejected (moves.py holds them: price_outlier, not counted)."""
    def quarters():
        for p in (DATA / "h").glob("*/*Q?.json"):
            q = json.loads(p.read_text())
            yield q.get("quarter"), [(h["cusip"], h["value"], h["shares"], h["put_call"]) for h in q["holdings"]]
    cons = consensus_prices(quarters())
    curated = set()  # (cik, quarter, cusip) a curated book (build.py, with its cover total) refused to rescale
    for m in (json.loads((DATA / "index.json").read_text()) if (DATA / "index.json").exists() else {}).get("managers") or []:
        b = DATA / f"{m.get('slug')}.json"
        if b.exists():
            bk = json.loads(b.read_text())
            curated.update((m.get("cik"), bk.get("quarter"), h.get("cusip")) for h in bk.get("holdings") or []
                           if h.get("value_rescale") == "rejected")
    budget, n = [COVER_FETCH_MAX], 0
    for p in sorted((DATA / "f").glob("*.json")):
        r = json.loads(p.read_text())
        if not r.get("ok"):
            continue
        cols = r["columns"]
        fbp = DATA / "fb" / str(r.get("quarter")) / p.name
        full = json.loads(fbp.read_text()) if fbp.exists() else None
        if not (full and full.get("ok") and full.get("accession") == r.get("accession") and full.get("rows")
                and all(k in full["columns"] for k in cols)):
            full = None
        src = full or r
        sc = src["columns"]
        rows = [[row[sc.index(k)] for k in cols] for row in src["rows"]]
        ci, vi, si, pi = (cols.index(k) for k in ("cusip", "value", "shares", "put_call"))
        ti = cols.index("shares_type") if "shares_type" in cols else None
        if full:  # keep the tickers enrich and figi wrote on the shard
            tick = {row[ci]: row[cols.index("ticker")] for row in r["rows"] if row[cols.index("ticker")]}
            for row in rows:
                row[cols.index("ticker")] = row[cols.index("ticker")] or tick.get(row[ci])
        equity = [row for row in rows if not row[pi] and row[si] and row[vi] and (ti is None or row[ti] != "PRN")]
        price = lambda row: row[vi] / row[si]
        dollars = False
        if any(f == 1000.0 for row in equity
               for f in [unit_verdict(price(row), cons.get((r.get("quarter"), row[ci])))[0]]):
            whole = full is not None or not r.get("truncated")
            dollars = whole and in_dollars(sum(row[vi] or 0 for row in rows), cover_total(r, budget))
        rejected, changed = [], full is not None
        for row in equity:
            f, rej = unit_verdict(price(row), cons.get((r.get("quarter"), row[ci])),
                                  dollars or (r.get("cik"), r.get("quarter"), row[ci]) in curated)
            if rej:
                rejected.append(row[ci])
            elif f != 1.0:
                row[vi] = int(row[vi] * f)
                changed = True
        if sorted(set(rejected)) != (r.get("value_rescale_rejected") or []):
            changed = True
        if not changed:
            continue
        rows.sort(key=lambda x: -(x[vi] or 0))
        total = sum(x[vi] or 0 for x in rows)
        out = r | {"rows": rows[:MAX_ROWS] if full else rows, "value_rescale_rejected": sorted(set(rejected)) or None}
        out["total_value"] = total if full else max(r["total_value"] + total - sum(x[vi] or 0 for x in r["rows"]), total)
        if full:
            out["truncated"] = len(rows) > MAX_ROWS
        if out != r:
            p.write_text(json.dumps(out, separators=(",", ":")) + "\n")
            n += 1
    return n


def sector_mix(copycat: dict) -> list[dict]:
    total = copycat.get("total_value") or 0
    by: dict[str, float] = {}
    for h in copycat.get("holdings") or []:
        key = h.get("sector") or UNCLASSIFIED
        by[key] = by.get(key, 0.0) + (h.get("total_value") or 0)
    return [
        {"sector": k, "value": v, "weight": (v / total) if total else 0.0}
        for k, v in sorted(by.items(), key=lambda x: -x[1])
    ]


def main() -> int:
    print(f"enrich: consensus unit check rescaled {fix_shards()} filer shards")
    secs_path = DATA / "securities.json"
    secs = json.loads(secs_path.read_text()) if secs_path.exists() else {}
    figi = load_cache()
    n = 0
    for path in sorted(DATA.glob("*.json")) + sorted((DATA / "f").glob("*.json")) + sorted((DATA / "h").glob("*/*.json")):
        if path.name in SKIP:
            continue
        text = path.read_text()
        obj = json.loads(text)
        if walk(obj, secs, figi):
            compact = "\n" not in text.strip()
            path.write_text((json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=1)) + "\n")
            n += 1
    cc, lite_path = DATA / "copycat.json", DATA / "copycat_lite.json"
    if cc.exists() and lite_path.exists():
        lite = json.loads(lite_path.read_text())
        lite["sectors"] = sector_mix(json.loads(cc.read_text()))
        lite_path.write_text(json.dumps(lite, separators=(",", ":")) + "\n")
    print(f"enrich: updated {n} files from {len(secs)} securities; wrote {write_csvs()} quarter CSVs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
