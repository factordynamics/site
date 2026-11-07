"""Fetch 13F-HR filings from SEC EDGAR. Holdings as filed only."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USER_AGENT = "Copybook factordynamics.com copybook@factordynamics.com"
DATA_BASE = "https://data.sec.gov"
ARCHIVE_BASE = "https://www.sec.gov"
MIN_INTERVAL = 0.12  # stay under 10 req/s

_last_request = 0.0


def _sleep():
    global _last_request
    elapsed = time.monotonic() - _last_request
    if elapsed < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - elapsed)
    _last_request = time.monotonic()


def get(url: str, retries: int = 5) -> bytes:
    backoff = 1.0
    last_err: Exception | None = None
    for attempt in range(retries):
        _sleep()
        req = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
        try:
            with urlopen(req, timeout=45) as resp:
                return resp.read()
        except HTTPError as e:
            last_err = e
            if e.code == 429 or e.code >= 500:
                retry_after = e.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else backoff
                time.sleep(wait)
                backoff = min(backoff * 2, 60)
                continue
            if e.code == 404:
                raise FileNotFoundError(f"404 {url}") from e
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        except URLError as e:
            last_err = e
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
    raise RuntimeError(f"GET failed {url}: {last_err}")


@dataclass
class FilingMeta:
    cik: str
    accession: str
    form: str
    filing_date: str
    report_date: str
    primary_document: str


def fetch_submissions(cik: str) -> dict:
    padded = cik.zfill(10)
    raw = get(f"{DATA_BASE}/submissions/CIK{padded}.json")
    return json.loads(raw.decode("utf-8"))


def list_13f(submissions: dict) -> list[FilingMeta]:
    recent = submissions.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])
    primaries = recent.get("primaryDocument", [""] * len(forms))
    out: list[FilingMeta] = []
    for i, form in enumerate(forms):
        if str(form) not in {"13F-HR", "13F-HR/A"}:
            continue
        report_date = report_dates[i] if i < len(report_dates) else ""
        if not report_date:
            continue
        out.append(
            FilingMeta(
                cik=str(submissions.get("cik", "")).zfill(10),
                accession=accessions[i],
                form=form,
                filing_date=filing_dates[i],
                report_date=report_date,
                primary_document=primaries[i] if i < len(primaries) else "",
            )
        )
    out.sort(key=lambda m: (m.report_date, m.filing_date, 0 if m.form == "13F-HR" else 1), reverse=True)
    return out


def latest_13f(submissions: dict) -> FilingMeta | None:
    items = list_13f(submissions)
    return items[0] if items else None


_index_cache: dict[str, dict] = {}


def fetch_index(cik: str, accession: str) -> dict:
    key = f"{cik}:{accession}"
    cached = _index_cache.get(key)
    if cached is not None:
        return cached
    cik_stripped = str(int(cik))
    acc = accession.replace("-", "")
    raw = get(f"{ARCHIVE_BASE}/Archives/edgar/data/{cik_stripped}/{acc}/index.json")
    data = json.loads(raw.decode("utf-8"))
    _index_cache[key] = data
    return data


def unique_quarters(metas: list[FilingMeta], limit: int) -> list[FilingMeta]:
    """Newest filing per report date, up to limit quarters."""
    seen: set[str] = set()
    out: list[FilingMeta] = []
    for meta in metas:
        if meta.report_date in seen:
            continue
        seen.add(meta.report_date)
        out.append(meta)
        if len(out) >= limit:
            break
    return out


def fetch_primary_doc(cik: str, accession: str) -> str | None:
    cik_stripped = str(int(cik))
    acc = accession.replace("-", "")
    index = fetch_index(cik, accession)
    for item in index.get("directory", {}).get("item", []):
        name = item.get("name") or ""
        if name.lower() != "primary_doc.xml":
            continue
        url = f"{ARCHIVE_BASE}/Archives/edgar/data/{cik_stripped}/{acc}/{name}"
        try:
            return get(url).decode("utf-8", errors="replace")
        except HTTPError:
            return None
    return None


def table_value_total(primary_xml: str | None) -> float | None:
    if not primary_xml:
        return None
    start = primary_xml.lower().find("<tablevaluetotal>")
    end = primary_xml.lower().find("</tablevaluetotal>")
    if start == -1 or end == -1:
        return None
    raw = primary_xml[start + len("<tablevaluetotal>") : end].replace(",", "").strip()
    try:
        return float(raw)
    except ValueError:
        return None


def fetch_info_table(cik: str, accession: str) -> str:
    cik_stripped = str(int(cik))
    acc = accession.replace("-", "")
    index = fetch_index(cik, accession)
    items = index.get("directory", {}).get("item", [])
    names = [item["name"] for item in items if item.get("name")]

    preferred = []
    fallback = []
    for name in names:
        lower = name.lower()
        if not lower.endswith(".xml"):
            continue
        if "primary" in lower or "index" in lower:
            continue
        if "infotable" in lower or "13f" in lower or lower[0].isdigit():
            preferred.append(name)
        else:
            fallback.append(name)

    for name in preferred + fallback:
        url = f"{ARCHIVE_BASE}/Archives/edgar/data/{cik_stripped}/{acc}/{name}"
        try:
            text = get(url).decode("utf-8", errors="replace")
        except HTTPError:
            continue
        if "infoTable" in text or "informationTable" in text:
            return text
    raise FileNotFoundError(f"No 13F information table in {cik} {accession}")
