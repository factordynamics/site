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
The API base is read from API_JSON (field `api`) at the start of each run, because the self-hosted
API's tunnel URL can change; COPYBOOK_API overrides it, and FALLBACK is used when neither answers.
A manifest of SHA-256 hashes (COPYBOOK_H_MANIFEST) records what the API's store already has, under
TARGET: a manifest written for another store is discarded, so everything is sent again once.
Each run sends only what changed, curated h/ first, then hl/, then fb/, then the rest, as tar
bundles (PUT /ingest/bundle) one at a time, at most 100 files or 20 MB each, never one request per
file. Bundles are gzipped (content-encoding: gzip, ~4x fewer bytes through gene's slow Funnel relay); an API
that answers 400 to gzip gets plain tars for the rest of the run.

gene serves members over the same link, so the backlog yields to them:
- Before each bundle, GET {api}/health is timed; over PROBE_MAX_S, wait 30 s and probe again, and a second
  slow probe stops the run cleanly (the next run continues).
- In EDGAR hours (weekdays 11:00-03:00 UTC, from Thu Nov 12 2026) only curated books of a fund whose index
  changed this run are sent (a new filing), at most FRESH_MAX files; everything else waits for the night. A failed bundle is retried once after 30 s; a second failure stops the run (non-zero exit),
as does a refused required key. UPLOAD_BUDGET_S stops cleanly; the next run continues.
"""

from __future__ import annotations

import gzip
from datetime import datetime, timedelta, timezone
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
API_JSON = "https://pub-c691ec38c5cd4db6acb8e6bfef337500.r2.dev/api.json"
FALLBACK = "https://gene.tail70ba3.ts.net/copybook"  # Tailscale Funnel: slow, but stable
TARGET = os.environ.get("COPYBOOK_UPLOAD_TARGET", "gene-2026-11-09")  # the store the manifest describes
UPLOAD_BUDGET_S = float(os.environ.get("COPYBOOK_UPLOAD_BUDGET_S") or 3600)
MANIFEST = Path(os.environ.get("COPYBOOK_H_MANIFEST") or (HIST.parent / ".h-manifest.json"))
BUILD = json.loads((HIST.parent / "build.json").read_text()) if (HIST.parent / "build.json").exists() else {}  # names R2 objects
KEY = re.compile(r"^h/[a-z0-9][a-z0-9-]*/(\d{4}Q[1-4](\.json|\.csv|\.v1\.json)|index\.json)$"
                 r"|^fb/\d{4}Q[1-4]/\d{10}\.json$|^s/[0-9A-Z]{6}\.json$|^bulk/\d{4}Q[1-4](\.part\d+)?\.csv\.gz$"
                 r"|^changes/\d{4}Q[1-4]\.json$|^v/\d{10}/\d{10}-\d{2}-\d{6}\.json$|^hl/[0-9A-Z]{6}\.json$")
# Keys the Worker may not accept yet: a failure warns instead of failing the run,
# and the rest of that kind are skipped until the next run.
OPTIONAL = re.compile(r"/index\.json$|\.v1\.json$|^fb/|^s/|^bulk/|^changes/|^v/|^hl/")
BUNDLE_ENTRIES = 100  # the self-hosted API's rate limit: 100 entries or 20 MB per bundle, one at a time
BUNDLE_BYTES = 5_000_000  # a 19 MB bundle hit Cloudflare's 100 s tunnel timeout (HTTP 524); plain tars only
BUNDLE_RAW_BYTES = 20_000_000  # the API's limit per bundle, uncompressed; gzipped it is ~5 MB on the wire
GZIP = [os.environ.get("COPYBOOK_UPLOAD_GZIP", "1") != "0"]  # cleared when the API refuses a gzipped bundle
ORDER = ("h/", "hl/", "fb/")  # sent first, in this order
PROBE_MAX_S = 2.0  # gene's /health slower than this: members are waiting, so the backlog backs off
FRESH_MAX = 60  # files per run in EDGAR hours: a few new filings' h/ books, never the backlog
QUIET_LEAD_S = 90  # no bundle starts this close to a COPYBOOK_UPLOAD_QUIET window (one bundle takes 3-30 s)
QUIET_FROM = datetime(2026, 11, 12, 11, tzinfo=timezone.utc)
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


def quiet(now: datetime) -> datetime | None:
    """The end of the COPYBOOK_UPLOAD_QUIET window ("2026-11-11T13:55:00Z/2026-11-11T14:20:00Z", comma-separated)
    that `now` is in, else None. No uploads inside one, so gene's uplink is left to members (post A's first sign-ins)."""
    for w in filter(None, (os.environ.get("COPYBOOK_UPLOAD_QUIET") or "").split(",")):
        a, b = (datetime.fromisoformat(x.strip().replace("Z", "+00:00")) for x in w.split("/"))
        if a <= now < b:
            return b
    return None


def edgar_hours(now: datetime) -> bool:
    """Weekdays 11:00-03:00 UTC (EDGAR's 6am-10pm ET) from QUIET_FROM: members' hours on gene."""
    if now < QUIET_FROM or 3 <= now.hour < 11:
        return False
    return (now if now.hour >= 11 else now - timedelta(days=1)).weekday() < 5


def _links(root: Path) -> dict:
    try:
        return json.loads((root / "cusip_links.json").read_text()).get("links") or {}
    except (OSError, ValueError):
        return {}


def link_files(root: Path) -> dict[str, int]:
    """hl/ files of reissued CUSIPs' issuers (cusip_links.json): the new code's merged file 0, the old code's 1. They
    go before everything else, new first, so a cut-off upload never leaves gene with an old code's file shrunk to
    its leftover lines and no merged file (TEVA hl/881624 on Nov 11 12:05)."""
    out: dict[str, int] = {}
    for old, v in _links(root).items():
        out[f"hl/{v['new'][:6]}.json"] = 0
    for old, v in _links(root).items():
        out.setdefault(f"hl/{old[:6]}.json", 1)
    return out


def link_news(root: Path) -> dict[str, set[str]]:
    """Old code's hl/ file -> the new codes' hl/ files that must reach gene first."""
    out: dict[str, set[str]] = {}
    for old, v in _links(root).items():
        if old[:6] != v["new"][:6]:
            out.setdefault(f"hl/{old[:6]}.json", set()).add(f"hl/{v['new'][:6]}.json")
    return out


def fresh_only(todo: list) -> list:
    """The curated h/ files of funds whose h/{slug}/index.json changed (a new filing), capped."""
    slugs = {k.split("/")[1] for k, _, _ in todo if k.startswith("h/") and k.endswith("/index.json")}
    return [t for t in todo if t[0].startswith("h/") and t[0].split("/")[1] in slugs][:FRESH_MAX]


def probe() -> float:
    t = time.monotonic()
    try:
        with urlopen(Request(f"{API}/health", headers={"User-Agent": USER_AGENT}), timeout=10) as resp:
            resp.read()
    except Exception:  # noqa: BLE001 - a failed probe counts as slow
        return 99.0
    return time.monotonic() - t


def api_base() -> str:
    if os.environ.get("COPYBOOK_API"):
        return os.environ["COPYBOOK_API"].rstrip("/")
    try:
        req = Request(f"{API_JSON}?t={int(time.time())}", headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())["api"].rstrip("/")
    except Exception as e:  # noqa: BLE001
        print(f"::warning::{API_JSON} unreadable ({e}); using {FALLBACK}", flush=True)
        return FALLBACK


def main() -> int:
    global API
    API = api_base()
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    if manifest.get("_target") != TARGET:  # written for another store: it has none of this yet
        manifest = {"_target": TARGET}
    token = Token()
    started = time.monotonic()
    root = HIST.parent
    sources: dict[str, Path] = {}
    for pattern in ("h/*/*.json", "h/*/*.csv", "v/*/*.json", "changes/*.json", "fb/*/*.json", "s/*.json",
                    "bulk/*.csv.gz"):
        for p in sorted(root.glob(pattern)):
            sources[p.relative_to(root).as_posix()] = p
    # Change rows (fq/, moves.py) replace the plain book for the same quarter. Curated runs restore fb/ read-only
    # and usually skip moves.py: their plain books would overwrite the change books a full run sent, so only full
    # runs send plain fb/ books.
    if os.environ.get("SCOPE", "full") != "full":
        sources = {k: v for k, v in sources.items() if not k.startswith("fb/")}
    for p in sorted(root.glob("fq/*/*.json")):
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
    pair = link_files(root)
    rank = lambda key: pair[key] - 2 if key in pair else next((i for i, p in enumerate(ORDER) if key.startswith(p)), len(ORDER))
    todo.sort(key=lambda t: (rank(t[0]), t[0]))
    if edgar_hours(datetime.now(timezone.utc)) and os.environ.get("COPYBOOK_UPLOAD_ANYTIME") != "1":
        held = len(todo)
        todo = [t for t in todo if t[0] in pair] + [t for t in fresh_only(todo) if t[0] not in pair]
        print(f"upload: EDGAR hours; sending {len(todo)} files of new filings, {held - len(todo)} wait for 03:00 UTC",
              flush=True)
    print(f"upload: {len(todo)} new or changed of {len(files)} files to {API}, one bundle at a time of up to "
          f"{BUNDLE_ENTRIES} files / {(BUNDLE_RAW_BYTES if GZIP[0] else BUNDLE_BYTES) / 1e6:.0f} MB"
          f"{' before gzip' if GZIP[0] else ''}", flush=True)
    sent = 0
    pending = {k for k, _, _ in todo}
    pair_new = link_news(root)
    try:
        for batch in bundles(todo):
            now = datetime.now(timezone.utc)
            until = quiet(now + timedelta(seconds=QUIET_LEAD_S))  # a bundle sent just before must land before it
            if until and os.environ.get("SCOPE", "full") != "full":  # a curated publish never waits
                print(f"upload: quiet window (COPYBOOK_UPLOAD_QUIET); {len(todo) - sent} files wait for the next run", flush=True)
                break
            if until:  # a full run holds its upload until the window ends; the hold doesn't count against the budget
                wait = (until - now).total_seconds()
                print(f"upload: quiet window (COPYBOOK_UPLOAD_QUIET); holding {len(todo) - sent} files until "
                      f"{until:%H:%M:%S} UTC ({wait:.0f} s)", flush=True)
                time.sleep(wait)
                started += wait
            if time.monotonic() - started > UPLOAD_BUDGET_S:
                print(f"::warning::upload budget reached; {len(todo) - sent} files wait for the next run", flush=True)
                break
            slow = probe()
            if slow > PROBE_MAX_S:
                time.sleep(30)
                slow = probe()
                if slow > PROBE_MAX_S:
                    print(f"::warning::gene's /health took {slow:.1f} s (limit {PROBE_MAX_S:.0f} s); backing off, "
                          f"{len(todo) - sent} files wait for the next run", flush=True)
                    break
            # Never shrink an old code's holder file before its merged new-code file is on gene (TEVA, Nov 11 12:05).
            ahead = {k for k, _, _ in batch}
            early = [t for t in batch if pair.get(t[0]) == 1 and any(
                n in pending and n not in ahead for n in pair_new.get(t[0], ()))]
            if early:
                print(f"::warning::upload: {len(early)} old-code hl/ files wait for their merged new-code file", flush=True)
                batch = [t for t in batch if t not in early]
                if not batch:
                    continue
            written, refused = put_bundle(batch, token)
            pending -= written
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
        cap = BUNDLE_RAW_BYTES if GZIP[0] else BUNDLE_BYTES
        if batch and (len(batch) >= BUNDLE_ENTRIES or size + n > cap):
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
    raw = buf.getvalue()
    last, failures = "", 0
    for attempt in range(4):
        zipped = GZIP[0]
        body = gzip.compress(raw, 6) if zipped else raw
        headers = {"Authorization": "Bearer " + token.get(), "Content-Type": "application/x-tar", "User-Agent": USER_AGENT,
                   "x-copybook-build-id": BUILD.get("build_id") or "", "x-copybook-built-at": BUILD.get("data_built_at") or ""}
        if zipped:
            headers["Content-Encoding"] = "gzip"
        req = Request(f"{API}/ingest/bundle", data=body, method="PUT", headers=headers)
        try:
            with urlopen(req, timeout=300) as resp:
                out = json.loads(resp.read())
                refused = list(out.get("refused") or [])
                return {k for k, _, _ in batch} - set(refused), refused
        except HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}"
            if e.code == 401 and attempt == 0:
                token.value = ""  # a stale token: refresh once, not counted as the retry
                continue
            if e.code == 400 and zipped:  # an API without gzip support: plain tars from now on, not counted
                print(f"::warning::API refused a gzipped bundle ({last}); sending plain tars", flush=True)
                GZIP[0] = False
                continue
            if e.code < 500 and e.code != 429:
                break
        except (URLError, TimeoutError, OSError) as e:
            last = str(e)
        failures += 1
        if failures > 1:
            break
        time.sleep(30)  # one retry after 30 s, then the run stops
    raise RuntimeError(f"bundle of {len(batch)} files ({len(raw) / 1e6:.1f} MB) failed: {last}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"::error::{exc}", file=sys.stderr)
        raise SystemExit(1)
