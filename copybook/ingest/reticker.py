#!/usr/bin/env python3
"""Re-apply the cached CUSIP -> ticker map to published JSON without hitting EDGAR."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.figi import load_cache

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"


def walk(obj, cmap: dict[str, str]) -> bool:
    changed = False
    if isinstance(obj, dict):
        cols = obj.get("columns")
        if cols and "cusip" in cols and "ticker" in cols:
            ci, ti = cols.index("cusip"), cols.index("ticker")
            for row in obj.get("rows") or []:
                want = cmap.get(row[ci]) or None
                if row[ti] != want:
                    row[ti] = want
                    changed = True
        cusip = obj.get("cusip")
        if isinstance(cusip, str) and "ticker" in obj:
            want = cmap.get(cusip) or None
            if obj["ticker"] != want:
                obj["ticker"] = want
                changed = True
        for v in obj.values():
            if isinstance(v, (dict, list)):
                changed |= walk(v, cmap)
    elif isinstance(obj, list):
        for v in obj:
            if isinstance(v, (dict, list)):
                changed |= walk(v, cmap)
    return changed


def main() -> int:
    cmap = load_cache()
    files = list(DATA.glob("*.json")) + list((DATA / "f").glob("*.json"))
    skip = {"universe.json", "filers.json", "alerts.json", "cusip_map.json"}
    n = 0
    for path in files:
        if path.name in skip:
            continue
        text = path.read_text()
        obj = json.loads(text)
        if walk(obj, cmap):
            compact = "\n" not in text.strip()
            path.write_text(
                (json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=1)) + "\n"
            )
            n += 1
    print(f"reticker: updated {n} files with {sum(1 for v in cmap.values() if v)} mapped CUSIPs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
