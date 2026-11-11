#!/usr/bin/env python3
"""Full 13F books for every filer from the SEC's quarterly Form 13F data sets.

https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets publishes every
13F information table, back to 2013Q2, as one zip per filing window. One period's
filings land in the window that starts at its quarter end (late filings and
amendments in the next one), so a period is read from those two windows.

Each period's books go to data/fb/{YYYYQn}/{cik}.json (full, uncapped; paid data,
never on Pages), in the same column layout as the public f/{cik}.json shards. The
book for a (filer, period) is picked like the live ingest: the original 13F-HR,
replaced by a RESTATEMENT amendment, plus NEW HOLDINGS amendments merged in.

    python ingest/datasets.py            # seed the stock period and the one before it
    python ingest/datasets.py 2025Q4     # seed given periods
A period is skipped once fb/{period}/.complete exists.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.edgar import ARCHIVE_BASE, get
from ingest.parse import ABOVE_20K, unit_fix
from ingest.managers import clean_name

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
FB = DATA / "fb"
CACHE = Path(os.environ.get("COPYBOOK_DATASET_CACHE") or (Path(os.environ.get("RUNNER_TEMP") or "/tmp") / "copybook-13f-sets"))
PAGE = f"{ARCHIVE_BASE}/data-research/sec-markets-data/form-13f-data-sets"
COLUMNS = ("ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type")
# Bump when the fb/ book layout changes: periods seeded by an older format are read again.
FORMAT = "4"  # 2: shares_type (SH, or PRN where shares is a principal amount); 3: re-filed books not double-counted;
# 4: per-row source_accession and unit fields (value_as_filed, value_scale, value_adjusted)
BOOK_COLUMNS = COLUMNS + ("source_accession", "value_as_filed", "value_scale", "value_adjusted")
DOLLARS_FROM = "2023-01-03"  # VALUE is in $000s for filings before this date (data set readme)
MONTHS = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
csv.field_size_limit(10_000_000)


def sec_date(s: str) -> str:
    """'30-JUN-2026' -> '2026-06-30'."""
    d, m, y = s.strip().split("-")
    return f"{y}-{MONTHS[m.upper()]:02d}-{int(d):02d}"


def quarter_of(report_date: str) -> str:
    return f"{report_date[:4]}Q{(int(report_date[5:7]) - 1) // 3 + 1}"


def quarter_end(q: str) -> date:
    y, n = int(q[:4]), int(q[5])
    return date(y, 12, 31) if n == 4 else date(y, 3 * n + 1, 1) - timedelta(days=1)


def prev_quarter(q: str) -> str:
    y, n = int(q[:4]), int(q[5])
    return f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"


def stock_period(today: date) -> str:
    """Newest quarter whose 45-day 13F deadline passed at least 3 days ago (filing season over)."""
    q = quarter_of(today.isoformat())
    for _ in range(3):
        q = prev_quarter(q)
        if quarter_end(q) + timedelta(days=48) <= today:
            return q
    return q


def windows() -> list[tuple[date, date, str]]:
    """(first filing date, last filing date, url) for every published data set."""
    html = get(PAGE).decode("utf-8", "replace")
    out = []
    for path in sorted(set(re.findall(r'href="([^"]*form13f\.zip)"', html))):
        name = path.rsplit("/", 1)[-1]
        url = path if path.startswith("http") else ARCHIVE_BASE + path
        m = re.match(r"(\d{2}[a-z]{3}\d{4})-(\d{2}[a-z]{3}\d{4})_form13f", name)
        if m:
            a, b = (datetime.strptime(x, "%d%b%Y").date() for x in m.groups())
        else:
            m = re.match(r"(\d{4})q([1-4])_form13f", name)
            if not m:
                continue
            y, n = int(m.group(1)), int(m.group(2))
            a = date(y, 3 * n - 2, 1)
            b = quarter_end(f"{y}Q{n}")
        out.append((a, b, url))
    return sorted(out)


def sets_for(q: str, published: list[tuple[date, date, str]]) -> list[str] | None:
    """The window holding most of q's filings plus the next one; None until the first is out."""
    end = quarter_end(q)
    main = [w for w in published if w[0] <= end + timedelta(days=45) <= w[1]]
    if not main:
        return None
    later = [w for w in published if w[0] > main[0][1]][:1]
    return [w[2] for w in main[:1] + later]


def fetch_set(url: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[-1]
    if not path.exists():
        tmp = path.with_suffix(".part")
        tmp.write_bytes(get(url))
        tmp.replace(path)
    return path


def _rows(z: zipfile.ZipFile, name: str):
    member = next(n for n in z.namelist() if n.upper().endswith(name))
    with z.open(member) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8", errors="replace", newline="")
        reader = csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)
        for r in reader:
            if len(r) >= len(header):
                yield dict(zip(header, r))


def pick(filings: list[dict]) -> tuple[dict | None, list[dict]]:
    """Same rule as build.pick_filings, on data set cover pages."""
    by_date = lambda f: (f["filing_date"], f["accession"])
    originals = sorted((f for f in filings if not f["amendment"]), key=by_date)
    amends = sorted((f for f in filings if f["amendment"]), key=by_date)
    restated = [f for f in amends if f["amendment_type"] == "RESTATEMENT"]
    unknown = [f for f in amends if not f["amendment_type"]]
    base = (restated or originals or unknown or [None])[-1]
    if base is None:
        return None, []
    extra = [f for f in amends if f["amendment_type"] == "NEW HOLDINGS" and f["filing_date"] >= base["filing_date"]]
    return base, extra


def read_period(q: str, zips: list[Path], ciks: set[str] | None = None) -> dict[str, dict]:
    """{cik: book} for every filer (or the given CIKs) that filed holdings for q."""
    want_date = quarter_end(q).isoformat()
    filings: dict[str, dict] = {}
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            for r in _rows(z, "SUBMISSION.TSV"):
                if not r["SUBMISSIONTYPE"].startswith("13F-HR"):
                    continue
                if sec_date(r["PERIODOFREPORT"]) != want_date:
                    continue
                cik = r["CIK"].strip().zfill(10)
                if ciks is not None and cik not in ciks:
                    continue
                filings[r["ACCESSION_NUMBER"]] = {
                    "accession": r["ACCESSION_NUMBER"], "cik": cik, "form": r["SUBMISSIONTYPE"],
                    "filing_date": sec_date(r["FILING_DATE"]), "amendment": r["SUBMISSIONTYPE"] != "13F-HR",
                    "amendment_type": "", "name": "",
                }
            for r in _rows(z, "COVERPAGE.TSV"):
                f = filings.get(r["ACCESSION_NUMBER"])
                if f:
                    f["amendment_type"] = (r.get("AMENDMENTTYPE") or "").strip().upper()
                    f["name"] = clean_name(r.get("FILINGMANAGER_NAME") or "")
    by_cik: dict[str, list[dict]] = {}
    for f in filings.values():
        by_cik.setdefault(f["cik"], []).append(f)
    chosen: dict[str, tuple[dict, list[dict]]] = {}
    use: dict[str, str] = {}  # accession -> cik
    for cik, fs in by_cik.items():
        base, extra = pick(fs)
        if base:
            chosen[cik] = (base, extra)
            for f in [base, *extra]:
                use[f["accession"]] = cik
    # accession -> {(cusip, put_call): [issuer, title, cusip, put_call, shares, value]}
    lines: dict[str, int] = {}
    books: dict[str, dict[tuple, list]] = {}
    for zp in zips:
        with zipfile.ZipFile(zp) as z:
            for r in _rows(z, "INFOTABLE.TSV"):
                acc = r["ACCESSION_NUMBER"]
                if acc not in use:
                    continue
                lines[acc] = lines.get(acc, 0) + 1
                cusip = r["CUSIP"].strip().upper()
                if not cusip:
                    continue
                pc = (r.get("PUTCALL") or "").strip().upper()
                pc = pc if pc in ("PUT", "CALL") else None
                try:
                    value, shares = float(r["VALUE"] or 0), float(r["SSHPRNAMT"] or 0)
                except ValueError:
                    continue
                typ = "PRN" if (r.get("SSHPRNAMTTYPE") or "").strip().upper() == "PRN" else "SH"
                key = (cusip, pc or "", typ)
                b = books.setdefault(acc, {})
                row = b.get(key)
                if row is None:
                    b[key] = [r["NAMEOFISSUER"].strip(), r["TITLEOFCLASS"].strip(), cusip, pc, shares, value, typ]
                else:
                    row[4] += shares
                    row[5] += value
    out = {}
    for cik, (base, extra) in chosen.items():
        out[cik] = book(q, base, extra, books, lines)
    return out


def refiled(base_rows: dict, extra_rows: dict) -> bool:
    """A NEW HOLDINGS amendment repeating most of the book: a mislabeled full re-filing (as build.py)."""
    keys = {k[:2] for k in base_rows}
    new = {k[:2] for k in extra_rows}
    if not keys or not new:
        return False
    if len(keys & new) > 0.5 * len(keys):
        return True
    ratio = sum(r[5] for r in extra_rows.values()) / (sum(r[5] for r in base_rows.values()) or 1)
    return 0.8 <= ratio <= 1.25 and len(new) >= 0.5 * len(keys)


def book(q: str, base: dict, extra: list[dict], books: dict, lines: dict) -> dict:
    merged: dict[tuple, list] = {}
    filed: dict[tuple, float] = {}  # VALUE as filed, summed like the row
    first: dict[tuple, str] = {}  # the first of the period's filings that lists the row
    replaced: list[str] = []
    seen: dict = {}
    for f in extra:  # a re-filed full book becomes the base; what it repeats is dropped
        if refiled({**books.get(base["accession"], {}), **seen}, books.get(f["accession"], {})):
            replaced.append(base["accession"])
            replaced.extend(e["accession"] for e in extra[:extra.index(f)] if e["accession"] not in replaced)
            base, seen = f, {}
        else:
            seen.update(books.get(f["accession"], {}))
    extra = [f for f in extra if f["accession"] not in replaced and f is not base
             and f["filing_date"] >= base["filing_date"]]
    for f in [base, *extra]:
        rows = books.get(f["accession"], {})
        thousands = f["filing_date"] < DOLLARS_FROM
        for key, r in rows.items():
            filed[key] = filed.get(key, 0) + r[5]
            first.setdefault(key, f["accession"])
            v = r[5] * (1000 if thousands else 1)
            if key in merged:
                merged[key][4] += r[4]
                merged[key][5] += v
            else:
                merged[key] = r[:5] + [v] + r[6:]
    rows = [r + [first[k], filed[k]] for k, r in merged.items()]
    # Same implied-price checks as the live ingest (filing-level, then single lines).
    factor = unit_fix([(r[5], r[4]) for r in rows if not r[3] and r[6] == "SH"])
    for r in rows:
        r[5] *= factor
        if not r[3] and r[6] == "SH" and r[4] > 0 and r[5] / r[4] > 20_000 and r[2] not in ABOVE_20K:
            r[5] /= 1000
    rows = [r for r in rows if r[5] > 0 and r[2] != "000000000"]
    rows.sort(key=lambda r: r[5], reverse=True)
    total = sum(r[5] for r in rows)
    accession = base["accession"]
    return {
        "ok": bool(rows),
        "cik": base["cik"],
        "name": base["name"],
        "form": base["form"],
        "accession": accession,
        "filing_date": base["filing_date"],
        "report_date": quarter_end(q).isoformat(),
        "quarter": q,
        "sec_url": f"{ARCHIVE_BASE}/Archives/edgar/data/{int(base['cik'])}/{accession.replace('-', '')}/{accession}-index.html",
        "line_count": sum(lines.get(f["accession"], 0) for f in [base, *extra]),
        "position_count": len(rows),
        "total_value": round(total),
        "values_in_thousands": base["filing_date"] < DOLLARS_FROM or factor > 1,
        "unit_fix": factor,
        "amendments": [f["accession"] for f in extra],
        "superseded": replaced,
        "mislabeled_amendment": bool(replaced),
        "source": "SEC Form 13F data set",
        "columns": list(BOOK_COLUMNS),
        "rows": [[None, r[0], r[1], r[2], r[3], round(r[4]), round(r[5]), r[6], r[7], r[8],
                  float(f"{r[5] / r[8]:.6g}") if r[8] else None, abs(r[5] - r[8]) > 0.5] for r in rows],
    }


def attach_tickers(rows: list[list], cusip_map: dict[str, str]) -> None:
    for r in rows:
        r[0] = cusip_map.get(r[3]) or None


def write_period(q: str, books: dict[str, dict]) -> None:
    folder = FB / q
    folder.mkdir(parents=True, exist_ok=True)
    cmap_path = Path(os.environ.get("COPYBOOK_CUSIP_MAP") or (DATA / "cusip_map.json"))
    cmap = json.loads(cmap_path.read_text()) if cmap_path.exists() else {}
    for cik, b in books.items():
        if not b["ok"]:
            continue
        path = folder / f"{cik}.json"
        if path.exists():
            try:  # a live EDGAR book for a newer filing of the same period wins
                old = json.loads(path.read_text())
                if old.get("source") != b["source"] and old.get("filing_date", "") >= b["filing_date"]:
                    continue
            except ValueError:
                pass
        attach_tickers(b["rows"], cmap)
        path.write_text(json.dumps(b, separators=(",", ":")) + "\n")


def seed(periods: list[str]) -> int:
    published = None
    done = 0
    for q in periods:
        marker = FB / q / ".complete"
        try:
            if json.loads(marker.read_text()).get("format") == FORMAT:
                continue
        except (OSError, ValueError):
            pass
        published = published or windows()
        urls = sets_for(q, published)
        if not urls:
            print(f"datasets: no SEC data set for {q} yet; live EDGAR books only")
            continue
        zips = [fetch_set(u) for u in urls]
        books = read_period(q, zips)
        write_period(q, books)
        # Complete only once the late-filing window is out too.
        if len(urls) == 2:
            marker.write_text(json.dumps({"sets": urls, "filers": len(books), "format": FORMAT}) + "\n")
        print(f"datasets: {q}: {sum(1 for b in books.values() if b['ok'])} filer books from {len(urls)} data set(s)")
        done += 1
    return done


def main(argv: list[str]) -> int:
    periods = argv or [(p := stock_period(date.today())), prev_quarter(p)]
    seed(periods)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
