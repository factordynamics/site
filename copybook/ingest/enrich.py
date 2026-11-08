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
from ingest.parse import consensus_factor, consensus_prices
from ingest.securities import UNCLASSIFIED

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
SKIP = {"universe.json", "filers.json", "alerts.json", "cusip_map.json", "securities.json", "issuers.json", "amendments.json", "notices.json", "status.json"}
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
    "change", "prev_shares", "share_change", "value_delta_usd", "pct_of_book",
)


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
        ] + ["" if h.get(k) is None else num(h[k])
             for k in ("change", "prev_shares", "share_change", "value_delta", "pct_of_book")])
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


def fix_shards() -> int:
    """Consensus unit check for every filer shard, against curated books for the same quarter."""
    def quarters():
        for p in (DATA / "h").glob("*/*.json"):
            q = json.loads(p.read_text())
            yield q.get("quarter"), [(h["cusip"], h["value"], h["shares"], h["put_call"]) for h in q["holdings"]]
    cons = consensus_prices(quarters())
    n = 0
    for p in sorted((DATA / "f").glob("*.json")):
        r = json.loads(p.read_text())
        if not r.get("ok"):
            continue
        cols = r["columns"]
        ci, vi, si, pi = (cols.index(k) for k in ("cusip", "value", "shares", "put_call"))
        delta = 0
        for row in r["rows"]:
            if row[pi] or not row[si]:
                continue
            f = consensus_factor(row[vi] / row[si], cons.get((r.get("quarter"), row[ci])))
            if f != 1.0:
                new = int(row[vi] * f)
                delta += new - row[vi]
                row[vi] = new
        if delta:
            r["rows"].sort(key=lambda x: -x[vi])
            r["total_value"] = max(r["total_value"] + delta, sum(x[vi] for x in r["rows"]))
            p.write_text(json.dumps(r, separators=(",", ":")) + "\n")
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
