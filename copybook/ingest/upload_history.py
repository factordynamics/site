#!/usr/bin/env python3
"""Upload new or changed data/h/{slug}/{quarter}.(json|csv) to the Copy API's private R2 bucket.

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
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
HIST = WEB / "data" / "h"
API = os.environ.get("COPYBOOK_API", "https://copybook-api.factordynamics.workers.dev").rstrip("/")
MANIFEST = Path(os.environ.get("COPYBOOK_H_MANIFEST") or (HIST.parent / ".h-manifest.json"))
KEY = re.compile(r"^h/[a-z0-9][a-z0-9-]*/\d{4}Q[1-4]\.(json|csv)$")
TOKEN_TTL = 240  # tokens last ~5 minutes; refresh well before
# Cloudflare rejects urllib's default User-Agent (error 1010), so name the client.
USER_AGENT = "Copybook-ingest/1.0 (+https://copybook.factordynamics.com)"


class Token:
    def __init__(self) -> None:
        self.value = ""
        self.at = 0.0

    def get(self) -> str:
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
    ctype = "text/csv; charset=utf-8" if key.endswith(".csv") else "application/json"
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
    files = sorted(p for p in HIST.glob("*/*") if p.suffix in (".json", ".csv"))
    sent = 0
    for i, path in enumerate(files):
        key = path.relative_to(HIST.parent).as_posix()
        if not KEY.match(key):
            continue
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if manifest.get(key) == digest:
            continue
        put(key, body, token)
        manifest[key] = digest
        sent += 1
        if sent % 100 == 0:
            MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
            print(f"upload: {sent} sent ({i + 1}/{len(files)} checked)", flush=True)
    MANIFEST.write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"upload: {sent} new or changed of {len(files)} files in R2")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)
