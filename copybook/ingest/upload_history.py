#!/usr/bin/env python3
"""Upload new or changed paid data to the Copy API's private R2 bucket.

- h/{slug}/{quarter}.(json|csv|v1.json) and h/{slug}/index.json: curated history (build.py)
- fb/{quarter}/{cik}.json: every filer's full book; for its latest quarter the copy with change
  columns from fq/{quarter}/{cik}.json (moves.py) is sent in place of the plain book
- s/{issuer}.json: per-issuer holder lists (stocks.py)
- bulk/{quarter}.csv.gz: one export per quarter of every filer's book (export.py)
- changes/{quarter}.json: every filer's moves per report period (moves.py)
- v/{cik}/{accession}.json: superseded 13F books, as that one filing reported them (build.py)
- hl/{issuer}.json: every 13F filer holding an issuer in its latest full book (moves.py hlf/)

Auth is the GitHub Actions OIDC token (audience copybook-api); no stored secret.
A manifest of SHA-256 hashes (COPYBOOK_H_MANIFEST) records what R2 already has,
so each run only sends what changed, as tar bundles (PUT /ingest/bundle, up to 500 files
each), never one request per file. Exits non-zero when a required key is refused or fails.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import tarfile
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
HIST = WEB / "data" / "h"
API = os.environ.get("COPYBOOK_API", "https://copybook-api.factordynamics.workers.dev").rstrip("/")
MANIFEST = Path(os.environ.get("COPYBOOK_H_MANIFEST") or (HIST.parent / ".h-manifest.json"))
BUILD = json.loads((HIST.parent / "build.json").read_text()) if (HIST.parent / "build.json").exists() else {}  # names R2 objects
KEY = re.compile(r"^h/[a-z0-9][a-z0-9-]*/(\d{4}Q[1-4](\.json|\.csv|\.v1\.json)|index\.json)$"
                 r"|^fb/\d{4}Q[1-4]/\d{10}\.json$|^s/[0-9A-Z]{6}\.json$|^bulk/\d{4}Q[1-4](\.part\d+)?\.csv\.gz$"
                 r"|^changes/\d{4}Q[1-4]\.json$|^v/\d{10}/\d{10}-\d{2}-\d{6}\.json$|^hl/[0-9A-Z]{6}\.json$")
# Keys the Worker may not accept yet: a failure warns instead of failing the run,
# and the rest of that kind are skipped until the next run.
OPTIONAL = re.compile(r"/index\.json$|\.v1\.json$|^fb/|^s/|^bulk/|^changes/|^v/|^hl/")
BUNDLE_ENTRIES = 500  # PUT /ingest/bundle limits: 500 entries, 90 MB
BUNDLE_BYTES = 85_000_000
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
    for p in sorted(root.glob("hlf/*.json")):  # every holder per issuer; Pages keeps counts and the top rows
        sources["hl/" + p.name] = p
    files = list(sources.values())
    todo = []
    for key, path in sorted(sources.items()):
        if KEY.match(key):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if manifest.get(key) != digest:
                todo.append((key, path, digest))
    print(f"upload: {len(todo)} new or changed of {len(files)} files, in bundles of up to {BUNDLE_ENTRIES}", flush=True)
    sent = 0
    try:
        for batch in bundles(todo):
            written, refused = put_bundle(batch, token)
            for key, _, digest in batch:
                if key in written:
                    manifest[key] = digest
            sent += len(written)
            required = [k for k in refused if not OPTIONAL.search(k)]
            if required:
                raise RuntimeError(f"bundle refused {len(required)} required keys, e.g. {required[:3]}")
            if refused:
                print(f"::warning::bundle refused {len(refused)} optional keys, e.g. {refused[:3]}", flush=True)
            MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
            print(f"upload: {sent}/{len(todo)} in R2", flush=True)
    finally:
        MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"upload: {sent} new or changed files in R2")
    return 0


def bundles(todo: list[tuple[str, Path, str]]):
    """Groups of up to BUNDLE_ENTRIES files and BUNDLE_BYTES (one larger file goes alone)."""
    batch, size = [], 0
    for item in todo:
        n = item[1].stat().st_size + 1024
        if batch and (len(batch) >= BUNDLE_ENTRIES or size + n > BUNDLE_BYTES):
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += n
    if batch:
        yield batch


def put_bundle(batch: list[tuple[str, Path, str]], token: Token) -> tuple[set[str], list[str]]:
    """One PUT /ingest/bundle: an uncompressed tar whose entry names are the R2 keys."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for key, path, _ in batch:
            body = path.read_bytes()
            info = tarfile.TarInfo(key)
            info.size, info.mtime = len(body), 0
            tar.addfile(info, io.BytesIO(body))
    body = buf.getvalue()
    last = ""
    for attempt in range(5):
        req = Request(f"{API}/ingest/bundle", data=body, method="PUT", headers={
            "Authorization": "Bearer " + token.get(), "Content-Type": "application/x-tar", "User-Agent": USER_AGENT,
            "x-copybook-build-id": BUILD.get("build_id") or "", "x-copybook-built-at": BUILD.get("data_built_at") or ""})
        try:
            with urlopen(req, timeout=300) as resp:
                out = json.loads(resp.read())
                refused = list(out.get("refused") or [])
                return {k for k, _, _ in batch} - set(refused), refused
        except HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}"
            if e.code == 401 and attempt == 0:
                token.value = ""
                continue
            if e.code < 500 and e.code != 429:
                break
            wait = int(e.headers.get("retry-after") or 0) if e.code == 429 else 0
            time.sleep(max(wait, 5 * (attempt + 1)))
            continue
        except URLError as e:
            last = str(e)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"bundle of {len(batch)} files ({len(body) / 1e6:.1f} MB) failed: {last}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)
