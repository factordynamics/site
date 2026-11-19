#!/usr/bin/env python3
"""Publish gate: refuse to publish a build that lost ticker coverage against the live data.

Compares the curated books ({slug}.json for every manager in index.json) in the data
directory with the same files at the git revision that is live (HEAD of the Pages repo).
Fails when the share of value with a ticker drops by more than 0.5 percentage points, when
any CUSIP among the 1,000 largest by value had a ticker and no longer has one, or when a
book's pct_of_book over its share (SH equity) rows does not sum to 1 within 0.001, or when a
curated quarter's book (h/) is over 1.5x the cover-page tableValueTotal of the filings merged
into it, or over 1.5x its previous quarter after merging a NEW HOLDINGS amendment (a re-filed
book added on top of the original).

Usage: python gate.py <data dir> [git revision, default HEAD]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.parse import not_common  # noqa: E402  (the same rule hl/ uses)
CLASS_SUM_MAX = 10  # moves.CLASS_SUM_MAX (moves isn't imported here: gate.py stays light)

MAX_DROP = 0.005
TOP_N = 1000
# Filer types: no type's count may move more than 10% (and more than 10 filers, so the 19 sovereigns don't trip it on
# two new filers) from the published set, except in a run dispatched with the accepted-reclass flag.
TYPES_MAX_MOVE, TYPES_MIN_FILERS = 0.10, 10
BOOK_COVER_MAX, BOOK_JUMP_MAX, BOOK_MEDIAN_MAX = 1.5, 1.5, 1.6  # book_totals: merged books vs cover, prior, positions
WEIGHT_TOL = 0.001  # pct_of_book over equity rows sums to 1 within this
NO_PUBLISH = "Nothing is published: the live data stays."
GATES: list[dict] = []  # data/gates.json (public /data-quality/): every gate this run, its rule and its result


def gate(gid: str, name: str, fails_when: str, stays_live: str, failed, detail=None) -> bool:
    """Records one gate for gates.json; returns whether it failed."""
    failed = bool(failed)
    GATES.append({"id": gid, "name": name, "fails_when": fails_when, "stays_live": stays_live,
                  "result": "fail" if failed else "pass", **({"detail": str(detail)[:500]} if failed and detail else {})})
    return failed
TYPES_ACCEPTED = os.environ.get("COPYBOOK_TYPES_ACCEPTED") == "1"


def type_counts(filers: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in filers.values():
        out[str(row.get("type"))] = out.get(str(row.get("type")), 0) + 1
    return out


def type_drift(published: dict[str, int], candidate: dict[str, int]) -> list[dict]:
    """Types whose filer count moved beyond the limit: [{type, published, candidate, change_pct}]."""
    moved = []
    for t in sorted(set(published) | set(candidate)):
        b, a = published.get(t, 0), candidate.get(t, 0)
        if abs(a - b) > max(TYPES_MAX_MOVE * b, TYPES_MIN_FILERS):
            moved.append({"type": t, "published": b, "candidate": a, "change_pct": round(100 * (a - b) / b, 1) if b else None})
    return moved


def books(read) -> dict[str, dict]:
    index = read("index.json")
    if not index:
        return {}
    out = {}
    for m in index.get("managers") or []:
        b = read(f"{m['slug']}.json")
        if b:
            out[m["slug"]] = b
    return out


def coverage(bs: dict[str, dict]) -> tuple[float, dict[str, float], dict[str, str | None]]:
    """(share of value with a ticker, value per CUSIP, ticker per CUSIP)."""
    total = mapped = 0.0
    value: dict[str, float] = {}
    ticker: dict[str, str | None] = {}
    for b in bs.values():
        for h in b.get("holdings") or []:
            v = float(h.get("value") or 0)
            total += v
            if h.get("ticker"):
                mapped += v
            c = h.get("cusip")
            if c:
                value[c] = value.get(c, 0.0) + v
                ticker[c] = ticker.get(c) or h.get("ticker")
    return (mapped / total if total else 1.0), value, ticker


def holder_counts(data: Path, books: dict[str, dict]) -> list[str]:
    """hl/{issuer}.json counts every filer's full book, so it can never be below the curated funds' count."""
    folder = data / "hlf" if (data / "hlf").exists() else data / "hl"  # full lists in CI, public top rows otherwise
    if not folder.exists():
        return []
    tracked: dict[str, set] = {}
    links = (read_json(data / "cusip_links.json") or {}).get("links") or {}
    for b in books.values():
        for h in b.get("holdings") or []:
            c = h.get("cusip") or ""
            c = (links.get(c) or {}).get("new") or c  # hl/ counts a reissued CUSIP's holders under the new one
            if len(c) >= 6 and not h.get("put_call") and h.get("shares_type", "SH") != "PRN" and h.get("shares") \
                    and not not_common(h.get("title"), c):  # a debt CUSIP (Joby 47775AAA9) is never a holder row
                tracked.setdefault(c[:6], set()).add(b.get("cik"))
    bad = []
    for code, ciks in tracked.items():
        p = folder / f"{code}.json"
        if not p.exists() and folder.name == "hl":
            continue  # public hl/ only has issuers with a ticker
        n = json.loads(p.read_text())["counts"]["holders"] if p.exists() else 0
        if n < len(ciks):
            bad.append(f"{code} {n} < {len(ciks)}")
    return bad


def reviewed_types(data: Path) -> list[str]:
    """Every hand-checked filer (ingest/type_cases.json) must come out with its reviewed type."""
    path = data / "filer_types.json"
    if not path.exists():
        return []
    got = json.loads(path.read_text()).get("filers") or {}
    cases = json.loads(Path(__file__).with_name("type_cases.json").read_text())["filers"]
    return [f"{v['name']}: {(got.get(c) or {}).get('type')} (reviewed: {v['type']})"
            for c, v in sorted(cases.items()) if c in got and got[c].get("type") != v["type"]]


def split_rows(data: Path, bs: dict[str, dict]) -> list[str]:
    """Rows that carry `split` with an unadjusted prior (prev_shares must be prev_shares_as_filed x ratio),
    and share rows in a stock with a split on file whose implied price moved by about the split ratio
    without one: an unapplied split shown as a trade (Egerton APH +$492.5M, really +$82M)."""
    import math

    p = data / "splits.json"
    table: dict[str, dict[str, float]] = {}
    for s in (json.loads(p.read_text()).get("splits") if p.exists() else None) or []:
        table.setdefault(s["cusip"], {})[s["to_quarter"]] = s["ratio"]
    bad = []
    for slug, b in bs.items():
        for h in b.get("holdings") or []:
            name = f"{slug} {h.get('ticker') or h.get('cusip')}"
            sp = h.get("split") or {}
            if sp.get("ratio") not in (None, 1, 1.0):
                filed = h.get("prev_shares_as_filed")
                if filed is None or abs((h.get("prev_shares") or 0) - filed * sp["ratio"]) > 1:
                    bad.append(f"{name}: split x{sp['ratio']} but prev_shares {h.get('prev_shares')} (as filed {filed})")
                continue
            k = table.get(h.get("cusip") or "", {}).get(b.get("quarter") or "")
            if not k or h.get("put_call") or h.get("shares_type", "SH") == "PRN" or h.get("change") not in ("added", "trimmed"):
                continue
            s, v, ps, pv = h.get("shares") or 0, h.get("value") or 0, h.get("prev_shares") or 0, h.get("prev_value") or 0
            if min(s, v, ps, pv) <= 0:
                continue
            moved = math.log((v / s) / (pv / ps))
            if abs(moved + math.log(k)) < min(abs(moved), math.log(1.25)):
                bad.append(f"{name}: value per share moved {math.exp(moved):.2f}x, about 1/{k:g}, with no split applied")
    return bad


def blank_accepted(data: Path) -> tuple[int, int, list[str]]:
    """hl/ holder rows (hlf/ when present: every holder) with an accession but no accepted_at:
    (blank rows, rows with an accession, examples). Files from before the column existed are skipped."""
    folder = data / "hlf" if (data / "hlf").exists() else data / "hl"
    blank = total = 0
    curated_blank: list[str] = []
    for f in folder.glob("*.json"):
        if f.name == "index.json":
            continue
        doc = json.loads(f.read_text())
        cols = doc.get("columns") or []
        if "accepted_at" not in cols:
            continue
        ai, ti, ci, ni = cols.index("accession"), cols.index("accepted_at"), cols.index("curated"), cols.index("name")
        for r in doc.get("rows") or []:
            if r[ai]:
                total += 1
                if not r[ti]:
                    blank += 1
                    if r[ci]:
                        curated_blank.append(f"{r[ni]} {r[ai]}")
    return blank, total, sorted(set(curated_blank))


INDEX_TYPES = {"hedge_fund", "long_only", "index", "bank", "insurance", "wealth", "pension", "sovereign", "other"}


def index_contract(index: dict) -> list[str]:
    """index.json against the API's contract (copybook/api/src/contract.ts): every managers[] row typed and well formed,
    and at least one hedge_fund and one long_only row, the two types that route stock-match alerts."""
    import re
    rows = index.get("managers") or []
    if not rows:
        return ["managers[] is empty"]
    bad = []
    date = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    for m in rows:
        who, ok = m.get("slug") or m.get("cik") or "?", m.get("ok")
        checks = [
            ("slug", isinstance(m.get("slug"), str) and re.fullmatch(r"[a-z0-9-]+", m["slug"])),
            ("cik", isinstance(m.get("cik"), str) and re.fullmatch(r"\d{1,10}", m["cik"])),
            ("type", m.get("type") in INDEX_TYPES),
            ("featured", isinstance(m.get("featured"), bool)),
            ("ok", isinstance(ok, bool)),
            ("form", isinstance(m.get("form"), str) and m["form"].startswith("13F-")),
            ("accession", (m.get("accession") is None and ok is False)
             or (isinstance(m.get("accession"), str) and re.fullmatch(r"\d{10}-\d{2}-\d{6}", m["accession"]))),
            ("reported_by", m.get("reported_by") is None or isinstance(m["reported_by"], str)
             or (isinstance(m["reported_by"], dict) and re.fullmatch(r"\d{1,10}", str(m["reported_by"].get("cik") or "")))),
        ] + [(k, (m.get(k) is None and ok is False) or (isinstance(m.get(k), str) and date.fullmatch(m[k])))
             for k in ("report_date", "filing_date")]
        bad += [f"{who}: {k}={m.get(k)!r}" for k, good in checks if not good]
    for t in ("hedge_fund", "long_only"):
        if not any(m.get("type") == t for m in rows):
            bad.append(f"no managers[] row of type {t}")
    return bad


def provenance(data: Path) -> dict:
    """Full books served by /v1 (fq/ where present, else fb/): rows without source_accession or
    first_disclosed_at, and checked share rows (no notes or options, not exited) whose suspect_units is not
    true or false. Plus AllianceBernstein's KLAC and BKNG flags, the cross-filer check's reference case."""
    out = {"rows": 0, "no_source": 0, "no_disclosed": 0, "share_rows": 0, "unchecked": 0, "examples": [], "ab": {},
           "basis": {}, "null_books": {}, "plain_books": 0, "bare_books": []}
    seen: set[tuple[str, str]] = set()
    for folder in ("fq", "fb"):
        for f in sorted((data / folder).glob("*/*.json")):
            if (f.parent.name, f.name) in seen:
                continue
            seen.add((f.parent.name, f.name))
            try:
                doc = json.loads(f.read_text())
            except ValueError:
                continue
            cols = doc.get("columns") or []
            rows = doc.get("rows") or []
            if folder == "fb" and "suspect_units" not in cols:
                out["plain_books"] += 1  # served without change columns or the unit check
            idx = {c: i for i, c in enumerate(cols)}
            get = lambda r, c: r[idx[c]] if c in idx and idx[c] < len(r) else None
            if rows and not any(get(r, "source_accession") or get(r, "first_disclosed_at") for r in rows):
                out["bare_books"].append(f"{folder}/{f.parent.name}/{f.stem}")  # no row names its filing
            for r in rows:
                out["rows"] += 1
                miss = [c for c in ("source_accession", "first_disclosed_at") if not get(r, c)]
                out["no_source"] += "source_accession" in miss
                out["no_disclosed"] += "first_disclosed_at" in miss
                name = f"{folder}/{f.parent.name}/{f.stem}"
                if miss and len(out["examples"]) < 10 and name not in out["examples"]:
                    out["examples"].append(name)
                if folder == "fq" and get(r, "shares_type") != "PRN" and not get(r, "put_call") \
                        and get(r, "change") != "exited":
                    out["share_rows"] += 1
                    basis = get(r, "suspect_units_basis") or "unset"
                    out["basis"][basis] = out["basis"].get(basis, 0) + 1
                    if not isinstance(get(r, "suspect_units"), bool):
                        out["unchecked"] += 1
                        out["null_books"][name] = out["null_books"].get(name, 0) + 1
                if f.stem == "0001109448" and get(r, "ticker") in ("KLAC", "BKNG"):
                    out["ab"][f"{f.parent.name} {get(r, 'ticker')}"] = get(r, "suspect_units")
    return out


def foreign_merges(hist: Path) -> list[str]:
    """Books holding another filer's 13F outside a 13F-NT succession. combined_with is allowed only between
    a fund and the manager its notices name as reporting for it (Pershing Square Capital and Pershing Square
    Inc.) once the fund has stopped filing for itself; a parent that files its own book beside the fund
    (Amundi 2026Q2 with Credit Agricole's 0001172661-26-003711) is never merged in. Rows whose
    source_accession is none of the quarter's own filings fail too."""
    books: dict[str, dict[str, dict]] = {}
    for folder in sorted(hist.glob("*")) if hist.exists() else []:
        for p in folder.glob("*Q?.json"):
            try:
                books.setdefault(folder.name, {})[p.stem] = json.loads(p.read_text())
            except ValueError:
                continue
    cik_of = {slug: next((q.get("cik") for q in qs.values() if q.get("cik")), None) for slug, qs in books.items()}
    succession = set()  # {fund cik, reporter cik} pairs, from quarters the fund took from its reporter
    for slug, qs in books.items():
        for q in qs.values():
            rep = (q.get("reported_by") or {}).get("cik")
            if rep and q.get("status") in ("notice", "successor"):
                succession.add(frozenset((cik_of[slug], rep)))
    bad = []
    for slug, qs in books.items():
        for name, q in qs.items():
            other = q.get("combined_with") or {}
            if other and frozenset((cik_of[slug], other.get("cik"))) not in succession:
                bad.append(f"{slug} {name} has {other.get('name')} {other.get('accession')} merged in")
                continue
            allowed = {f.get("accession") for f in (q.get("filings") or []) + (q.get("parts") or [])}
            allowed |= {q.get("accession"), other.get("accession")}
            stray = {h.get("source_accession") for h in q.get("holdings") or []} - allowed - {None}
            if stray and q.get("filings") and not other:
                bad.append(f"{slug} {name} rows from {', '.join(sorted(stray)[:3])}")
    return bad


def bad_baselines(data: Path) -> list[str]:
    """Quarters in h/ whose changes were computed against anything but the quarter right before, from the same
    filers (MFG 2026Q2 against Mizuho Bank's 2026Q1 book; FMR 2025Q3 against 2025Q1)."""
    def prev_q(q: str) -> str:
        y, n = int(q[:4]), int(q[5])
        return f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"

    def filer(fund: str, q: dict) -> int:
        rep = (q.get("reported_by") or {}).get("cik") if q.get("status") in ("notice", "successor") else None
        return int(rep or fund)

    def sources(fund: str, q: dict) -> set[int]:
        c = (q.get("combined_with") or {}).get("cik")
        return {filer(fund, q)} | ({int(c)} if c and str(c).isdigit() else set())

    bad = []
    hist = data / "h"
    roster = {m.get("slug") for m in (read_json(data / "index.json") or {}).get("managers") or []}
    for folder in sorted(hist.glob("*")) if hist.exists() else []:
        if folder.name not in roster:  # a cached folder of a fund no longer tracked isn't published
            continue
        fund = (read_json(data / f"{folder.name}-history.json") or {}).get("cik")
        books = {p.stem: b for p in folder.glob("*Q?.json") if (b := read_json(p)) is not None}
        for name, q in sorted(books.items()):
            pq = q.get("prev_quarter")
            if not pq or not fund:
                continue
            prev = books.get(pq) or {}
            if pq != prev_q(name) or filer(fund, q) not in sources(fund, prev):
                bad.append(f"{folder.name} {name} vs {pq}")
                continue
            shares = [h for h in q.get("holdings") or [] if not h.get("put_call") and h.get("shares_type") != "PRN"]
            if len(shares) >= 5 and not q.get("exited") and all(h.get("change") == "new" for h in shares):
                bad.append(f"{folder.name} {name} vs {pq}: every line new, no exits")
    return bad


def history_gaps(data: Path, span: int = 8) -> list[str]:
    """Tracked funds' quarters missing inside their last `span` quarters, with no reason on record: neither a 13F-HR
    that is empty as filed (placeholders, confidential treatment not yet lifted) nor a 13F-NT. FMR 2025Q2 went
    missing this way (its 13F-HR sat on an older EDGAR submissions page); a quarter the filer never filed lists too."""
    qn = lambda q: int(q[:4]) * 4 + int(q[5]) - 1
    out = []
    for m in (read_json(data / "index.json") or {}).get("managers") or []:
        b = read_json(data / f"{m.get('slug')}.json") or {}
        served = set(b.get("history_quarters") or [])
        if not served:
            continue
        why = {s.get("quarter"): s.get("reason") for s in b.get("skipped_quarters") or []}
        top = max(map(qn, served))
        span_q = [f"{n // 4}Q{n % 4 + 1}" for n in range(top - span + 1, top)]
        low = min(map(qn, served))
        for q in span_q:
            if qn(q) > low and q not in served and why.get(q) not in ("empty", "notice"):
                out.append(f"{m['slug']} {q} ({why.get(q) or 'no 13F-HR read'})")
    return out


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def total_drift(hist: Path, tol: float = 0.001) -> list[str]:
    """Quarters whose total (after the unit fix) is more than tol off the filed cover totals of the
    filings they are built from (cover_total sums them for merged and combined books). A warning only:
    some covers are wrong as filed, and a hard stop could block a filing-week publish."""
    out = []
    for folder in sorted(hist.glob("*")) if hist.exists() else []:
        for p in sorted(folder.glob("*Q?.json")):
            try:
                q = json.loads(p.read_text())
            except ValueError:
                continue
            total, cover = q.get("total_value") or 0, q.get("cover_total") or 0
            if cover and abs(total - cover) > tol * cover:
                out.append(f"{folder.name} {p.stem} ${total / 1e9:.3f}B vs cover ${cover / 1e9:.3f}B "
                           f"({100 * (total - cover) / cover:+.2f}%)")
    return out


def book_totals(hist: Path) -> list[str]:
    """Quarters merged from more than one filing of the same filer that look double-counted.

    The cover check needs a merge (amendments added, or another filer's book via combined_with,
    whose cover counts too): a single filing's book is that filing, and some covers are in
    thousands or simply wrong.
    A jump after an amendment fails only when the positions themselves doubled (median share
    ratio against the prior quarter), so a genuine large addition (Invesco 2025Q4) passes.
    """
    bad = []
    for folder in sorted(hist.glob("*")) if hist.exists() else []:
        qs = {}
        for p in folder.glob("*Q?.json"):
            try:
                qs[p.stem] = json.loads(p.read_text())
            except ValueError:
                continue
        for name, q in qs.items():
            merged = any(f.get("role") == "addition" for f in q.get("filings") or [])
            if not merged and not q.get("combined_with"):
                continue
            total, cover = q.get("total_value") or 0, q.get("cover_total") or 0
            if cover and total > BOOK_COVER_MAX * cover:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B vs filed ${cover / 1e9:.1f}B")
                continue
            prev = qs.get(q.get("prev_quarter") or "")
            if not (prev and prev.get("total_value") and total > BOOK_JUMP_MAX * prev["total_value"]):
                continue
            ratios = sorted(h["shares"] / h["prev_shares"] for h in q.get("holdings") or []
                            if not h.get("put_call") and h.get("shares") and h.get("prev_shares"))
            if ratios and ratios[len(ratios) // 2] > BOOK_MEDIAN_MAX:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B after an amendment vs ${prev['total_value'] / 1e9:.1f}B, "
                           f"median position x{ratios[len(ratios) // 2]:.2f}")
    return bad


# Cache format bumps refetch every stored curated quarter from EDGAR (build.CACHE_FORMAT 6, Nov 19: merged lines that
# had lost their filed CUSIP). A refetch should change only the merge markers; anything else in a book whose filing is
# unchanged is held for review (lead, Nov 19) unless the run is dispatched with reason refetch-accepted.
REFETCH_MARKERS = {"cusip_pair", "prev_cusip", "cusip_as_filed", "filed_cusip", "filed_price", "matched_cusip",
                   "reference_price", "cusip_mismatch"}
REFETCH_ACCEPTED = os.environ.get("COPYBOOK_REFETCH_ACCEPTED") == "1"
REFETCH_TOTAL_TOL = 0.005  # a refetched book's total moving more than 0.5% is held
REFETCH_TRADE_MIN = 5_000_000  # a trade (value_delta or change) moving by at least this, or 0.5% of the book, is held


def _rows(b: dict) -> dict[tuple, dict]:
    if b.get("columns") and b.get("rows") is not None:
        rows = [dict(zip(b["columns"], r)) for r in b["rows"]]
    else:
        rows = list(b.get("holdings") or [])
    return {(r.get("cusip"), r.get("put_call") or "", r.get("change") == "exited"): r for r in rows}


def refetch_diff(pairs: list[tuple[str, dict, dict]], refetched_only: bool = True) -> tuple[list[tuple[float, str, str]], list[str]]:
    """For books refetched this run (format up, same filing_key), or every book with the same filing when
    refetched_only is False: ([(dollars, name, what)] for every book with a change beyond the merge markers,
    [held reasons])."""
    changed, held = [], []
    for name, b, a in pairs:
        if (refetched_only and (b.get("format") or 0) >= (a.get("format") or 0)) \
                or (b.get("filing_key") or b.get("accession")) \
                != (a.get("filing_key") or a.get("accession")):
            continue
        rb, ra = _rows(b), _rows(a)
        book = max(abs(a.get("total_value") or 0), 1)
        dollars, what = 0.0, []
        for k in ("total_value", "equity_value", "total_value_counted", "equity_value_counted"):
            x, y = b.get(k), a.get(k)
            if x is not None and y is not None and x != y:
                dollars += abs(y - x)
                what.append(f"{k} {x:,.0f}->{y:,.0f}")
                if abs(y - x) > REFETCH_TOTAL_TOL * max(abs(x), 1):
                    held.append(f"{name} {k} {x:,.0f} -> {y:,.0f}")
        for key in set(rb) | set(ra):
            x, y = rb.get(key), ra.get(key)
            if x is None or y is None:
                v = (x or y).get("value") or 0
                dollars += abs(v)
                what.append(f"{key[0]} {'gone' if y is None else 'added'} ${v:,.0f}")
                if abs(v) >= min(REFETCH_TRADE_MIN, 0.005 * book):
                    held.append(f"{name} {key[0]} row {'gone' if y is None else 'added'} (${v:,.0f})")
                continue
            diff = {f for f in set(x) | set(y) if f not in REFETCH_MARKERS and x.get(f) != y.get(f)
                    and not (isinstance(x.get(f), (int, float)) and isinstance(y.get(f), (int, float))
                             and abs((x.get(f) or 0) - (y.get(f) or 0)) < 1e-6 * max(1, abs(x.get(f) or 0)))}
            if not diff:
                continue
            dv = abs((y.get("value") or 0) - (x.get("value") or 0))
            dd = abs((y.get("value_delta") or 0) - (x.get("value_delta") or 0))
            dollars += dv + dd
            what.append(f"{key[0]} {','.join(sorted(diff))[:80]}")
            if dd >= min(REFETCH_TRADE_MIN, 0.005 * book) or (x.get("change") != y.get("change")
                                                                and abs(y.get("value") or 0) >= REFETCH_TRADE_MIN):
                held.append(f"{name} {key[0]} change {x.get('change')}->{y.get('change')}, "
                            f"value_delta {x.get('value_delta')}->{y.get('value_delta')}")
        if what:
            changed.append((dollars, name, "; ".join(what[:6])))
    return sorted(changed, reverse=True), held


# curated_lag (lead, Nov 19): a tracked fund's newer 13F-HR that was fetched but came back unreadable warns and is
# retried next run; it blocks once the same accession is unreadable in UNREADABLE_RUNS runs in a row, or when more than
# UNREADABLE_MAX are unreadable in one run. Any other reason a newer filing wasn't loaded still blocks.
UNREADABLE_RUNS, UNREADABLE_MAX = 3, 3


def lag_check(lag: list[dict], streaks: dict[str, int]) -> tuple[list[str], list[str], dict[str, int]]:
    """lag: [{slug, quarter, behind, reason, accession, error}] for newer quarters not loaded; streaks: accession ->
    consecutive published runs it was unreadable (live unreadable_streaks.json). Returns (blocking, warned, streaks
    for this run)."""
    text = lambda q: f"{q['slug']} {q['behind']} < {q['quarter']} ({q['reason']} {q.get('accession') or ''})"
    bad = [q for q in lag if q["reason"] == "unreadable" and q.get("accession")]
    now = {q["accession"]: (streaks.get(q["accession"]) or 0) + 1 for q in bad}
    blocking = [text(q) for q in lag if q not in bad]
    if len(bad) > UNREADABLE_MAX:
        blocking += [text(q) + f" [{len(bad)} unreadable this run, over {UNREADABLE_MAX}]" for q in bad]
        return blocking, [], now
    blocking += [text(q) + f" [unreadable {now[q['accession']]} runs in a row]" for q in bad
                 if now[q["accession"]] >= UNREADABLE_RUNS]
    warned = [text(q) + f" [unreadable {now[q['accession']]} of {UNREADABLE_RUNS}; {q.get('error') or 'no error'}]"
              for q in bad if now[q["accession"]] < UNREADABLE_RUNS]
    return blocking, warned, now


def main() -> int:
    data = Path(sys.argv[1])
    rev = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    top = subprocess.run(["git", "-C", str(data), "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    rel = data.resolve().relative_to(Path(top).resolve()).as_posix() if top else None

    def live(name: str):
        if not rel:
            return None
        r = subprocess.run(["git", "-C", top, "show", f"{rev}:{rel}/{name}"], capture_output=True, text=True)
        return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None

    def new(name: str):
        p = data / name
        return json.loads(p.read_text()) if p.exists() else None

    before, after = books(live), books(new)
    if not before:
        print("gate: no live data to compare against; pass")
        return 0
    cov_b, val_b, tick_b = coverage(before)
    cov_a, _, tick_a = coverage(after)
    top_cusips = sorted(val_b, key=val_b.get, reverse=True)[:TOP_N]
    lost = [c for c in top_cusips if tick_b.get(c) and c in tick_a and not tick_a[c]]
    print(f"gate: value with a ticker {cov_b:.2%} live -> {cov_a:.2%} new ({len(before)} -> {len(after)} books); "
          f"{len(lost)} of the top {TOP_N} CUSIPs lost their ticker")
    failed = False
    off = []
    for slug, b in after.items():
        eq = [h for h in b.get("holdings") or [] if not h.get("put_call") and h.get("shares_type", "SH") != "PRN"]
        if eq and "pct_of_book" in eq[0] and "delta_pct_of_book" in eq[0]:  # the equity-weight definition
            total = sum(h.get("pct_of_book") or 0 for h in eq)
            if abs(total - 1) > WEIGHT_TOL:
                off.append(f"{slug} {total:.4f}")
    gate("weights", "Book weights", f"A tracked fund's equity weights add up to more than {WEIGHT_TOL:.1%} away from 100%.", NO_PUBLISH, off, off[:10])
    if off:
        print(f"::error::pct_of_book does not sum to 1 over equity rows: {', '.join(off[:20])}; not publishing.")
        failed = True
    index = new("index.json") or {}
    broken = index_contract(index)
    gate("index_contract", "Alert routing index", "The fund index lacks a field the API routes alerts by, or has no hedge-fund or long-only manager.", NO_PUBLISH, broken, broken[:10])
    if broken:
        print(f"::error::index.json breaks the API contract (alert routing): {'; '.join(broken[:20])}; not publishing.")
        failed = True
    lag = [{"slug": m["slug"], "behind": m.get("quarter"), **q} for m in index.get("managers") or []
           for q in m.get("skipped_quarters") or []
           if q["report_date"] > (m.get("report_date") or "") and q["reason"] not in ("empty", "notice")]
    lagging, warned, streaks = lag_check(lag, (live("unreadable_streaks.json") or {}).get("streaks") or {})
    (data / "unreadable_streaks.json").write_text(json.dumps({"streaks": streaks}, separators=(",", ":")) + "\n")
    if warned:
        print(f"::warning::curated_lag: unreadable this run, retried next run: {'; '.join(warned[:20])}", flush=True)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Unreadable tracked-fund filings, warned ({len(warned)})\n\n" + "".join(f"- {w}\n" for w in warned) + "\n")
    gate("curated_lag", "Tracked funds current", "A tracked fund has a newer 13F-HR on EDGAR that this build did not load (an unreadable one blocks after 3 runs in a row, or when more than 3 are unreadable in one run).", NO_PUBLISH, lagging, lagging[:10])
    if lagging:
        print(f"::error::Curated funds behind a newer 13F-HR on EDGAR that was not loaded: {'; '.join(lagging[:20])}; "
              f"not publishing.")
        failed = True
    short = holder_counts(data, after)
    gate("holder_counts", "Holder counts", "A stock's all-filer holder count is below the number of tracked funds holding its common shares.", NO_PUBLISH, short, short[:10])
    if short:
        print(f"::error::All-filer holder counts below the tracked funds holding the stock: {'; '.join(short[:20])}; "
              f"not publishing.")
        failed = True
    live_types, new_types = (live("filer_types.json") or {}).get("filers"), (new("filer_types.json") or {}).get("filers")
    if live_types and new_types:
        drift = type_drift(type_counts(live_types), type_counts(new_types))
        gate("type_drift", "Filer type drift", f"A filer type's count moves more than {TYPES_MAX_MOVE:.0%} (and by more than "
             f"{TYPES_MIN_FILERS} filers) against the live set without a reviewed reclass.", NO_PUBLISH,
             drift and not TYPES_ACCEPTED, drift)
        if drift and not TYPES_ACCEPTED:  # filer_types.py holds such a set back; this catches any other path
            print(f"::error::Filer type counts moved more than {TYPES_MAX_MOVE:.0%} from the published set without the "
                  f"accepted-reclass flag: " + "; ".join(f"{d['type']} {d['published']} -> {d['candidate']}" for d in drift)
                  + "; not publishing.")
            failed = True
    wrong = reviewed_types(data)
    gate("reviewed_types", "Reviewed filer types", "A hand-reviewed filer comes out of the build with a different type.", NO_PUBLISH, wrong, wrong[:10])
    if wrong:
        print(f"::error::Filer types differ from the reviewed cases: {'; '.join(wrong[:20])}; not publishing.")
        failed = True
    unsplit = split_rows(data, after)
    gate("splits", "Splits applied", "A position in a stock with a split on file reads as a trade the split explains.", NO_PUBLISH, unsplit, unsplit[:10])
    if unsplit:
        print(f"::error::Split not applied: {'; '.join(unsplit[:20])}; not publishing.")
        failed = True
    blank, total, curated_blank = blank_accepted(data)
    if total:
        print(f"gate: accepted_at blank on {blank} of {total} holder rows with an accession")
    gate("accepted_at", "Acceptance times", "A tracked fund's holder row has no EDGAR acceptance time.", NO_PUBLISH, curated_blank, curated_blank[:10])
    if curated_blank:  # curated books always know their filing's acceptance time
        print(f"::error::accepted_at missing on curated holder rows: {'; '.join(curated_blank[:20])}; not publishing.")
        failed = True
    elif blank:  # other filers: accepted.py backfills under a time budget and continues next run
        print(f"::warning::accepted_at missing on {blank} of {total} holder rows; accepted.py fills them next run")
    pv = provenance(data)
    print(f"gate: full books: {pv['no_source']} of {pv['rows']} rows without source_accession, {pv['no_disclosed']} "
          f"without first_disclosed_at; suspect_units unset on {pv['unchecked']} of {pv['share_rows']} checked share "
          f"rows (basis {pv['basis']}); {pv['plain_books']} plain fb/ books; AllianceBernstein {pv['ab']}")
    worst = sorted(pv["null_books"].items(), key=lambda x: -x[1])[:8]
    if worst:
        print("gate: share rows with suspect_units null, most per book: " + ", ".join(f"{b} {n}" for b, n in worst))
    gate("provenance", "Row provenance", "A full book has no source accession or first-disclosed time on any row.", NO_PUBLISH, pv["bare_books"], pv["bare_books"][:10])
    if pv["bare_books"]:  # served with no provenance at all (Root Financial 2026Q3, Nov 11 05:41)
        print(f"::error::{len(pv['bare_books'])} full books with no source_accession or first_disclosed_at on any row: "
              f"{', '.join(pv['bare_books'][:20])}; not publishing.")
        failed = True
    if pv["no_source"] or pv["no_disclosed"]:  # accepted.py fills them under its budget; the next run continues
        print(f"::warning::per-row provenance missing in {', '.join(pv['examples'])}")
    merged = foreign_merges(data / "h")
    gate("foreign_merges", "One filer per book", "Another filer's 13F is merged into a book outside a 13F-NT succession.", NO_PUBLISH, merged, merged[:10])
    if merged:
        print(f"::error::Another filer's 13F merged into a book: {'; '.join(merged[:20])}; not publishing.")
        failed = True
    gaps = history_gaps(data)
    if gaps:  # listed, not fatal: a fund that skipped a quarter on EDGAR shows here too
        print(f"::warning::{len(gaps)} tracked-fund quarters missing with no reason on record: {'; '.join(gaps[:30])}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Tracked-fund quarters missing ({len(gaps)})\n\n" + "".join(f"- {g}\n" for g in gaps) + "\n")
    based = bad_baselines(data)
    if based:  # build.py's baseline() refuses these; a hit here is a cached book of a fund whose fetch failed
        print(f"::warning::{len(based)} quarters diffed against a non-adjacent quarter or another filer's book: "
              f"{'; '.join(based[:20])}")
    drift = total_drift(data / "h")
    if drift:
        print(f"::warning::{len(drift)} books more than 0.1% off their filed cover totals: {'; '.join(drift[:10])}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Books more than 0.1% off their filed cover totals ({len(drift)})\n\n"
                        + "".join(f"- {d}\n" for d in drift[:200]) + "\n")
    ciks = {str(m.get("cik") or "").zfill(10) for m in (new("index.json") or {}).get("managers") or []}
    changed, held = refetch_diff([(slug, before[slug], after[slug]) for slug in after if slug in before])
    # The tracked funds' all-filer shards (f/, from the SEC data sets, never refetched): reported, not held.
    shards = [(f"f/{c}", live(f"f/{c}.json") or {}, new(f"f/{c}.json") or {}) for c in sorted(ciks)]
    f_changed, _ = refetch_diff([p for p in shards if p[1] and p[2]], refetched_only=False)
    print(f"gate: tracked funds' f/ shards changed beyond the merge markers with the same filing: {len(f_changed)}"
          + (": " + " | ".join(f"{n} ${d:,.0f} ({w})" for d, n, w in f_changed[:5]) if f_changed else ""), flush=True)
    if changed:
        print(f"gate: refetched books with changes beyond the merge markers: {len(changed)}; top 5 by $: "
              + " | ".join(f"{n} ${d:,.0f} ({w})" for d, n, w in changed[:5]), flush=True)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Refetched books changed beyond the merge markers ({len(changed)})\n\n"
                        + "".join(f"- {n}: ${d:,.0f}: {w}\n" for d, n, w in changed[:100]) + "\n")
    held_now = held and not REFETCH_ACCEPTED
    gate("refetch_diff", "Refetched books", "A book refetched from EDGAR after a cache format change moves its totals "
         f"more than {REFETCH_TOTAL_TOL:.1%} or a trade by ${REFETCH_TRADE_MIN:,} (or 0.5% of the book) without a new "
         "filing.", NO_PUBLISH, held_now, held[:10])
    if held:
        print(("::warning::accepted (refetch-accepted): " if REFETCH_ACCEPTED else "::error::")
              + f"refetched books changed totals or trades: {'; '.join(held[:20])}"
              + ("" if REFETCH_ACCEPTED else "; not publishing."), flush=True)
        failed = failed or held_now
    doubled = book_totals(data / "h")
    gate("book_totals", "Book totals", f"A book merged from several filings totals more than {BOOK_COVER_MAX}x its filed cover, or more than {BOOK_JUMP_MAX}x the prior quarter with the median position up more than {BOOK_MEDIAN_MAX}x.", NO_PUBLISH, doubled, doubled[:10])
    if doubled:
        print(f"::error::Books larger than their filings: {'; '.join(doubled[:20])}; not publishing.")
        failed = True
    gate("coverage", "Ticker coverage", f"Holdings value with a ticker falls more than {100 * MAX_DROP:.1f} points against the live data.", NO_PUBLISH, cov_a < cov_b - MAX_DROP, f"{cov_b:.2%} live, {cov_a:.2%} new")
    if cov_a < cov_b - MAX_DROP:
        print(f"::error::Ticker coverage fell {100 * (cov_b - cov_a):.2f} points (limit {100 * MAX_DROP:.1f}); not publishing.")
        failed = True
    gate("tickers_kept", "Tickers kept", f"Any of the {TOP_N:,} largest CUSIPs loses the ticker it had in the live data.", NO_PUBLISH, lost, lost[:10])
    if lost:
        print(f"::error::Previously mapped CUSIPs lost their ticker: "
              + ", ".join(f"{c} ({tick_b[c]})" for c in lost[:40]) + "; not publishing.")
        failed = True
    refused = data / "holders_refused.json"
    why = str((read_json(refused) or {}).get("reason") or "") if refused.exists() else ""
    gate("class_sum", "Share-class sums", f"More than {CLASS_SUM_MAX} multi-class holder rows differ from the sum of "
         "their classes, or any does in a top-100 stock by value.", NO_PUBLISH, "class_sum" in why, why)
    gate("holder_rows", "Holder net and counts", "A stock's net or change counts differ from the sum of its own holder "
         "rows.", NO_PUBLISH, "net or counts" in why, why)
    par, moves_failed = (new("quality.json") or {}).get("parity") or {}, os.environ.get("MOVES_FAILED") == "1"
    gate("parity", "Holders net = changes", "Any stock's holder-index net differs from the sum of its counted changes "
         "rows for the same quarter.", "The previous holder index and changes stay; everything else publishes and the "
         "run is marked failed.", moves_failed or (par and par.get("matched") != par.get("issuers")),
         "moves.py failed this run" if moves_failed else f"{par.get('matched')} of {par.get('issuers')} issuers")
    if refused.exists():  # moves.py: the class sums are broken (over the ceiling, or a top-100 stock); hl/ unchanged
        r = json.loads(refused.read_text())
        print(f"::error::gate: holder index refused ({len(r.get('rows') or [])} class_sum_mismatch rows, "
              f"{len(r.get('top100') or [])} in top-100 stocks): {r.get('rows', [])[:5]}", flush=True)
        failed = True
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (data / "gates.json").write_text(json.dumps({
        "generated": now, "build": (new("build.json") or {}).get("build_id"),
        "note": "Every check a data run must pass before it publishes. Only a run that passes them all is published, "
                "so the live data's run reads pass; a failing run's data never reaches the site.",
        "gates": [g | {"checked_at": now} for g in GATES]}, separators=(",", ":")) + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
