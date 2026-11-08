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
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest import build
from ingest import splits as sp
from ingest.datasets import prev_quarter

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
TOP = 10
MOVE_COLUMNS = ("ticker", "issuer", "cusip", "put_call", "shares", "prev_shares", "value", "value_delta", "change")
FULL_COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type", "prev_shares", "prev_value",
                "change", "share_change", "value_delta", "pct_of_book", "delta_pct_of_book", "prev_shares_as_filed",
                "split_ratio")


SECS: dict[str, dict] = {}


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
    prev = book(read(DATA / "fb" / pq / f"{shard['cik']}.json"))
    if cur is None or prev is None:
        return None
    rows = build.with_changes(cur, prev)
    moved = [r for r in rows if r["change"] not in ("unchanged", None) and not r.get("put_call")]
    counts = {c: sum(1 for r in rows if r["change"] == c and not r.get("put_call"))
              for c in ("new", "added", "trimmed", "exited", "unchanged")}
    pick = lambda r: [r.get(k) if k not in ("shares", "prev_shares", "value", "value_delta") else int(round(r.get(k) or 0))
                      for k in MOVE_COLUMNS]
    buys = sorted((r for r in moved if r["change"] in ("new", "added")), key=lambda r: -r["value_delta"])[:TOP]
    sells = sorted((r for r in moved if r["change"] in ("trimmed", "exited")), key=lambda r: r["value_delta"])[:TOP]
    summary = {
        "prev_quarter": pq,
        "changes": counts,
        "moves": {"columns": list(MOVE_COLUMNS), "bought": [pick(r) for r in buys], "sold": [pick(r) for r in sells]},
    }
    return summary, rows


def main() -> int:
    build.SPLITS.clear()
    build.SPLITS.update(sp.table())
    SECS.update(read(DATA / "securities.json") or {})
    n = with_prev = 0
    for path in sorted((DATA / "f").glob("*.json")):
        shard = read(path)
        if not shard:
            continue
        n += 1
        got = changes(shard)
        base = {k: v for k, v in shard.items() if k not in ("prev_quarter", "changes", "moves")}
        if got is None:
            write(path, base)
            continue
        summary, rows = got
        with_prev += 1
        write(path, base | summary)
        full = {k: v for k, v in base.items() if k not in ("rows", "columns", "truncated")} | {
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
    print(f"moves: {with_prev}/{n} filers have a prior quarter on file")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
