"""Fetch 13F-HR filings from SEC EDGAR. Holdings as filed only."""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

USER_AGENT = "Copybook factordynamics.com copybook@factordynamics.com"
DATA_BASE = "https://data.sec.gov"
ARCHIVE_BASE = "https://www.sec.gov"
MIN_INTERVAL = float(os.environ.get("COPYBOOK_SEC_INTERVAL", "0.12"))  # stay under 10 req/s

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


def iso_utc(raw: str) -> str:
    """EDGAR's '2025-08-14T20:10:02.000Z' as '2025-08-14T20:10:02Z'; '' when missing."""
    return raw[:19] + "Z" if raw and len(raw) >= 19 else ""


@dataclass
class FilingMeta:
    cik: str
    accession: str
    form: str
    filing_date: str
    report_date: str
    primary_document: str
    accepted_at: str = ""  # EDGAR acceptance time, ISO UTC ("2025-08-14T20:10:02Z")


def fetch_submissions(cik: str, since: str | None = None, pages: dict | None = None) -> dict:
    """EDGAR's submissions JSON. `recent` holds only the last ~1,000 filings or a year, so a busy filer's older
    13F-HRs (FMR 2025Q2, JPMorgan 2025Q3) sit in its `files` pages: with `since` (YYYY-MM-DD), the 13F rows of every
    page filed on or after it are appended to `recent`. `pages` caches those rows by page, so each is fetched once."""
    padded = cik.zfill(10)
    raw = get(f"{DATA_BASE}/submissions/CIK{padded}.json")
    subs = json.loads(raw.decode("utf-8"))
    recent = subs.get("filings", {}).get("recent", {})
    n = len(recent.get("form", []))
    for page in subs.get("filings", {}).get("files") or [] if since else []:
        if (page.get("filingTo") or "") < since:
            continue
        key = f"{page.get('name')}|{page.get('filingCount')}|{page.get('filingTo')}"
        rows = (pages or {}).get(key)
        if rows is None:
            full = json.loads(get(f"{DATA_BASE}/submissions/{page['name']}").decode("utf-8"))
            keep = [i for i, f in enumerate(full.get("form", [])) if str(f).startswith("13F")]
            rows = {k: [v[i] for i in keep] for k, v in full.items()
                    if isinstance(v, list) and len(v) == len(full.get("form", []))}
            if pages is not None:
                pages[key] = rows
        m = len(rows.get("form", []))
        for k, v in list(recent.items()):
            if isinstance(v, list) and len(v) == n:
                recent[k] = v + (rows.get(k) or [""] * m)
        n += m
    return subs


HOLDINGS_FORMS = {"13F-HR", "13F-HR/A"}
NOTICE_FORMS = {"13F-NT", "13F-NT/A"}


def list_13f(submissions: dict, forms_wanted: set[str] = HOLDINGS_FORMS) -> list[FilingMeta]:
    recent = submissions.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accessions = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    report_dates = recent.get("reportDate", [])
    primaries = recent.get("primaryDocument", [""] * len(forms))
    accepted = recent.get("acceptanceDateTime", [""] * len(forms))
    out: list[FilingMeta] = []
    for i, form in enumerate(forms):
        if str(form) not in forms_wanted:
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
                accepted_at=iso_utc(accepted[i] if i < len(accepted) else ""),
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


def quarter_groups(metas: list[FilingMeta], limit: int) -> list[list[FilingMeta]]:
    """Every 13F-HR and 13F-HR/A per report date, newest period first, up to limit periods."""
    groups: dict[str, list[FilingMeta]] = {}
    for meta in metas:
        groups.setdefault(meta.report_date, []).append(meta)
    return [groups[d] for d in sorted(groups, reverse=True)[:limit]]


def amendment_cover(cik: str, accession: str) -> dict:
    """Amendment cover page: {type: 'RESTATEMENT' | 'NEW HOLDINGS' | '', no, confidential_treatment_expired}."""
    doc = fetch_primary_doc(cik, accession) or ""
    tag = lambda n: (m.group(1) if (m := re.search(rf"<(?:\w+:)?{n}>\s*([^<]+?)\s*<", doc, re.I)) else "")
    no = tag("amendmentNo")
    conf = tag("confDeniedExpired").lower()
    return {"type": tag("amendmentType").upper(), "no": int(no) if no.isdigit() else None,
            "confidential_treatment_expired": True if conf in ("true", "y") else False if conf in ("false", "n") else None,
            "confidential_omitted": tag("isConfidentialOmitted").lower() in ("true", "y")}


def amendment_type(cik: str, accession: str) -> str:
    """'RESTATEMENT', 'NEW HOLDINGS', or '' when the cover page does not say."""
    return amendment_cover(cik, accession)["type"]


def list_notices(submissions: dict) -> list[FilingMeta]:
    """13F-NT filings: the filer's holdings are reported by another manager."""
    return list_13f(submissions, NOTICE_FORMS)


def notice_reporters(cik: str, accession: str) -> dict:
    """Other managers named on a 13F-NT cover page, plus its explanation."""
    doc = fetch_primary_doc(cik, accession) or ""
    reporters = []
    for block in re.findall(r"<(?:\w+:)?otherManager>(.*?)</(?:\w+:)?otherManager>", doc, re.S | re.I):
        c = re.search(r"<(?:\w+:)?cik>\s*(\d+)\s*<", block, re.I)
        n = re.search(r"<(?:\w+:)?name>\s*([^<]+?)\s*<", block, re.I)
        reporters.append({"cik": c.group(1).zfill(10) if c else None, "name": n.group(1) if n else ""})
    info = re.search(r"<(?:\w+:)?additionalInformation>\s*([^<]*?)\s*<", doc, re.I)
    return {"reporters": reporters, "note": info.group(1) if info else ""}


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
