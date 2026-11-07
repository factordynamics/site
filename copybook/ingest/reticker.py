"""Re-apply CUSIP map to already ingested JSON without hitting EDGAR."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.cusips import KNOWN_CUSIPS
from ingest.pages import write_site

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"


def apply(obj: dict) -> None:
    if "holdings" in obj:
        for h in obj["holdings"]:
            known = KNOWN_CUSIPS.get(h.get("cusip") or "")
            if known and known[0]:
                h["ticker"] = known[0]
            elif h.get("ticker") == "CPNG" and h.get("cusip") == "136375102":
                h["ticker"] = "CNI"
    if "copycat" in obj and "holdings" in obj["copycat"]:
        apply(obj["copycat"])
    if "copycat_top" in obj:
        for h in obj["copycat_top"]:
            known = KNOWN_CUSIPS.get(h.get("cusip") or "")
            if known and known[0]:
                h["ticker"] = known[0]
    if "top" in obj:
        for h in obj["top"]:
            known = KNOWN_CUSIPS.get(h.get("cusip") or "")
            if known and known[0]:
                h["ticker"] = known[0]
    if "history" in obj:
        for q in obj["history"]:
            apply(q)


def main() -> int:
    index = json.loads((DATA / "index.json").read_text())
    copycat = json.loads((DATA / "copycat.json").read_text())
    apply(index)
    apply(copycat)
    managers = []
    for m in index["managers"]:
        path = DATA / f"{m['slug']}.json"
        full = json.loads(path.read_text())
        apply(full)
        path.write_text(json.dumps(full, indent=2) + "\n")
        managers.append(full)
        if m.get("top"):
            for h in m["top"]:
                known = KNOWN_CUSIPS.get(h.get("cusip") or "")
                if known and known[0]:
                    h["ticker"] = known[0]
    (DATA / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    (DATA / "copycat.json").write_text(json.dumps(copycat, indent=2) + "\n")
    payload = {
        **index,
        "managers": managers,
        "copycat": copycat,
    }
    write_site(payload)
    print("retickered and rewrote site")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
