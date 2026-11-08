#!/usr/bin/env python3
"""Upload new or changed paid data to the Copy API's private R2 bucket.

- h/{slug}/{quarter}.(json|csv|v1.json) and h/{slug}/index.json: curated history (build.py)
- fb/{quarter}/{cik}.json: every filer's full book; for its latest quarter the copy with change
  columns from fq/{quarter}/{cik}.json (moves.py) is sent in place of the plain book
- s/{issuer}.json: per-issuer holder lists (stocks.py)
- bulk/{quarter}.csv.gz: one export per quarter of every filer's book (export.py)
- changes/{quarter}.json: every filer's moves per report period (moves.py)
- v/{cik}/{accession}.json: superseded 13F books, as that one filing reported them (build.py)

Auth is the GitHub Actions OIDC token (audience copybook-api); no stored secret.
A manifest of SHA-256 hashes (COPYBOOK_H_MANIFEST) records what R2 already has,
so each run only sends what changed. Exits non-zero on the first failed upload.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
HIST = WEB / "data" / "h"
API = os.environ.get("COPYBOOK_API", "https://copybook-api.factordynamics.workers.dev").rstrip("/")
MANIFEST = Path(os.environ.get("COPYBOOK_H_MANIFEST") or (HIST.parent / ".h-manifest.json"))
KEY = re.compile(r"^h/[a-z0-9][a-z0-9-]*/(\d{4}Q[1-4](\.json|\.csv|\.v1\.json)|index\.json)$"
                 r"|^fb/\d{4}Q[1-4]/\d{10}\.json$|^s/[0-9A-Z]{6}\.json$|^bulk/\d{4}Q[1-4](\.part\d+)?\.csv\.gz$"
                 r"|^changes/\d{4}Q[1-4]\.json$|^v/\d{10}/\d{10}-\d{2}-\d{6}\.json$")
# Keys the Worker may not accept yet: a failure warns instead of failing the run,
# and the rest of that kind are skipped until the next run.
OPTIONAL = re.compile(r"/index\.json$|\.v1\.json$|^fb/|^s/|^bulk/|^changes/|^v/")
WORKERS = 8
TOKEN_TTL = 240  # tokens last ~5 minutes; refresh well before
# Cloudflare rejects urllib's default User-Agent (error 1010), so name the client.
USER_AGENT = "Copybook-ingest/1.0 (+https://copybook.factordynamics.com)"


class Token:
    def __init__(self) -> None:
        self.value = ""
        self.at = 0.0
        self.lock = threading.Lock()

    def get(self) -> str:
        with self.lock:
            return self._get()

    def _get(self) -> str:
        if self.value and time.monotonic() - self.at < TOKEN_TTL:
            return self.value
        static = os.environ.get("COPYBOOK_INGEST_TOKEN")
        if static:  # local testing only
            self.value = static
        else:
            url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=copybook-api"
            req = Request(url, headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
            with urlopen(req, timeout=30) as resp:
                self.value = json.loads(resp.read())["value"]
        self.at = time.monotonic()
        return self.value


def put(key: str, body: bytes, token: Token) -> None:
    ctype = ("application/gzip" if key.endswith(".gz") else "text/csv; charset=utf-8" if key.endswith(".csv")
             else "application/json")
    last = ""
    for attempt in range(4):
        req = Request(
            f"{API}/ingest/{key}",
            data=body,
            method="PUT",
            headers={"Authorization": "Bearer " + token.get(), "Content-Type": ctype, "User-Agent": USER_AGENT},
        )
        try:
            with urlopen(req, timeout=120) as resp:
                if resp.status == 200:
                    return
                last = f"HTTP {resp.status}"
        except HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}"
            if e.code == 401 and attempt == 0:
                token.value = ""  # expired; fetch a new one and retry once
                continue
            if e.code < 500 and e.code != 429:
                break
        except URLError as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"upload {key} failed: {last}")


def main() -> int:
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    token = Token()
    root = HIST.parent
    sources: dict[str, Path] = {}
    for pattern in ("h/*/*.json", "h/*/*.csv", "v/*/*.json", "changes/*.json", "fb/*/*.json", "s/*.json",
                    "bulk/*.csv.gz"):
        for p in sorted(root.glob(pattern)):
            sources[p.relative_to(root).as_posix()] = p
    for p in sorted(root.glob("fq/*/*.json")):  # change rows replace the plain book for the same quarter
        sources["fb/" + p.relative_to(root / "fq").as_posix()] = p
    files = list(sources.values())
    todo = []
    for key, path in sorted(sources.items()):
        if KEY.match(key):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if manifest.get(key) != digest:
                todo.append((key, path, digest))
    print(f"upload: {len(todo)} new or changed of {len(files)} files", flush=True)
    refused: set[str] = set()
    lock = threading.Lock()
    sent = 0

    def one(item) -> None:
        nonlocal sent
        key, path, digest = item
        kind = OPTIONAL.search(key)
        if kind and kind.group() in refused:
            return
        try:
            put(key, path.read_bytes(), token)
        except RuntimeError as exc:
            if not kind:
                raise
            with lock:
                if kind.group() not in refused:
                    refused.add(kind.group())
                    print(f"::warning::{exc} (skipping the other {kind.group()} keys this run)", flush=True)
            return
        with lock:
            manifest[key] = digest
            sent += 1
            if sent % 200 == 0:
                MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
                print(f"upload: {sent}/{len(todo)} sent", flush=True)

    try:
        with ThreadPoolExecutor(WORKERS) as pool:
            for _ in pool.map(one, todo):  # re-raises the first required failure
                pass
    finally:
        MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"upload: {sent} new or changed files in R2")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)
