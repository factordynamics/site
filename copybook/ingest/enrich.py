#!/usr/bin/env python3
"""Apply data/securities.json (ticker, display_name, sector) to every published JSON file.

Raw SEC issuer names stay in `issuer`; `display_name` is the cleaned name.
Also writes the copycat sector mix to copycat_lite.json, every dollar labelled.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.figi import load_cache
from ingest.securities import UNCLASSIFIED

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
SKIP = {"universe.json", "filers.json", "alerts.json", "cusip_map.json", "securities.json", "issuers.json"}
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
    secs_path = DATA / "securities.json"
    secs = json.loads(secs_path.read_text()) if secs_path.exists() else {}
    figi = load_cache()
    n = 0
    for path in sorted(DATA.glob("*.json")) + sorted((DATA / "f").glob("*.json")):
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
    print(f"enrich: updated {n} files from {len(secs)} securities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
