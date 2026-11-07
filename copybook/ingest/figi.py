#!/usr/bin/env python3
"""CUSIP -> US ticker via OpenFIGI (identifier mapping only, no prices).

Results are cached in ingest/cusip_map.json as {cusip: ticker or ""}. An empty
string means OpenFIGI had no single US listing for that CUSIP, so the UI shows
a dash rather than a guess.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("COPYBOOK_CUSIP_MAP") or (HERE / "cusip_map.json"))
URL = "https://api.openfigi.com/v3/mapping"
BATCH = 10  # unauthenticated limit per request
INTERVAL = 2.6  # 25 requests per 60 s unauthenticated


def load_cache() -> dict[str, str]:
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {}


def save_cache(cache: dict[str, str]) -> None:
    CACHE.write_text(json.dumps(dict(sorted(cache.items())), indent=0) + "\n")


def pick(data: list[dict]) -> str:
    tickers = {d.get("ticker") for d in data if d.get("ticker")}
    if len(tickers) != 1:
        return ""
    return tickers.pop().replace("/", ".")


def _post(jobs: list[dict]) -> list[dict]:
    body = json.dumps(jobs).encode()
    req = Request(URL, data=body, headers={"Content-Type": "application/json"})
    backoff = 5.0
    for _ in range(6):
        try:
            with urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
                continue
            raise
        except URLError:
            time.sleep(backoff)
            backoff = min(backoff * 2, 120)
    raise RuntimeError("OpenFIGI unavailable")


def resolve(cusips: list[str], budget_s: float | None = None) -> dict[str, str]:
    """Look up uncached CUSIPs in the given order; returns the full cache."""
    cache = load_cache()
    todo = [c for c in dict.fromkeys(cusips) if c and c not in cache and c != "000000000"]
    start = time.monotonic()
    for i in range(0, len(todo), BATCH):
        if budget_s is not None and time.monotonic() - start > budget_s:
            break
        chunk = todo[i : i + BATCH]
        t0 = time.monotonic()
        try:
            out = _post([{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in chunk])
        except Exception as exc:  # keep what we have; next run continues
            print(f"figi: stopped early: {exc}", flush=True)
            break
        for c, res in zip(chunk, out):
            cache[c] = pick(res.get("data") or [])
        if (i // BATCH) % 20 == 0:
            save_cache(cache)
            print(f"figi: {i + len(chunk)}/{len(todo)}", flush=True)
        wait = INTERVAL - (time.monotonic() - t0)
        if wait > 0:
            time.sleep(wait)
    save_cache(cache)
    return cache


def collect_cusips(data_dir: Path) -> list[str]:
    """CUSIPs across published JSON, largest aggregate value first."""
    value: dict[str, float] = {}

    def add(holdings):
        for h in holdings or []:
            c = h.get("cusip")
            if c:
                value[c] = value.get(c, 0.0) + float(h.get("value") or h.get("total_value") or 0)

    cc = data_dir / "copycat.json"
    if cc.exists():
        add(json.loads(cc.read_text()).get("holdings"))
    for p in sorted((data_dir / "f").glob("*.json")) if (data_dir / "f").exists() else []:
        try:
            rec = json.loads(p.read_text())
            cols = rec.get("columns") or []
            add([dict(zip(cols, r)) for r in rec.get("rows") or []] or rec.get("holdings"))
        except ValueError:
            continue
    return sorted(value, key=lambda c: -value[c])


def main() -> int:
    data_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "web" / "data"
    budget = float(os.environ.get("COPYBOOK_FIGI_BUDGET_S", "0") or "0") or None
    cusips = collect_cusips(data_dir)
    cache = resolve(cusips, budget)
    have = sum(1 for c in cusips if cache.get(c))
    print(f"figi: {have}/{len(cusips)} CUSIPs have a US ticker; cache={len(cache)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
