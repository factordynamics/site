#!/usr/bin/env python3
"""data/books.json: Holdterm's funds' books in one file, so its list pages make one request, not ~184.

{"generated_at", "books": {"<slug>": <exactly the object in data/<slug>.json>}} for every manager in
index.json whose slug is a `slug` or `filer_slug` of holdterm/src/roster.json `funds[]`, read at publish
time (the roster changes when its rule is re-run). Run last, after every step that writes {slug}.json,
so books.json, index.json and the per-fund files never disagree. Without a roster nothing is written.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
ROSTER = Path(os.environ.get("COPYBOOK_ROSTER") or (ROOT.parent / "holdterm" / "src" / "roster.json"))


def main() -> int:
    if not ROSTER.exists():
        print(f"books: no roster at {ROSTER}; books.json not written")
        return 0
    funds = json.loads(ROSTER.read_text()).get("funds") or []
    wanted = {f.get(k) for f in funds for k in ("slug", "filer_slug") if f.get(k)}
    managers = json.loads((DATA / "index.json").read_text()).get("managers") or []
    slugs = [m["slug"] for m in managers if m.get("slug") in wanted and (DATA / f"{m['slug']}.json").exists()]
    # The per-fund files' own bytes, so each object is exactly what {slug}.json serves.
    parts = [f"{json.dumps(s)}:{(DATA / f'{s}.json').read_text().strip()}" for s in slugs]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = '{"generated_at":' + json.dumps(stamp) + ',"books":{' + ",".join(parts) + "}}\n"
    json.loads(body)  # never publish a broken file
    tmp = DATA / "books.json.tmp"
    tmp.write_text(body)
    tmp.replace(DATA / "books.json")
    missing = sorted(wanted - set(slugs))
    print(f"books: {len(slugs)} of {len(wanted)} roster slugs, {len(body) / 1e6:.1f} MB"
          + (f"; not in index.json: {', '.join(missing[:10])}" if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
