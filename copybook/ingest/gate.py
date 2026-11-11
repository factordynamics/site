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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ingest.parse import not_common  # noqa: E402  (the same rule hl/ uses)

MAX_DROP = 0.005
TOP_N = 1000


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
    for b in books.values():
        for h in b.get("holdings") or []:
            c = h.get("cusip") or ""
            if len(c) >= 6 and not h.get("put_call") and h.get("shares_type", "SH") != "PRN" and h.get("shares") \
                    and not not_common(h.get("title")):
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
            if cover and total > 1.5 * cover:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B vs filed ${cover / 1e9:.1f}B")
                continue
            prev = qs.get(q.get("prev_quarter") or "")
            if not (prev and prev.get("total_value") and total > 1.5 * prev["total_value"]):
                continue
            ratios = sorted(h["shares"] / h["prev_shares"] for h in q.get("holdings") or []
                            if not h.get("put_call") and h.get("shares") and h.get("prev_shares"))
            if ratios and ratios[len(ratios) // 2] > 1.6:
                bad.append(f"{folder.name} {name} ${total / 1e9:.1f}B after an amendment vs ${prev['total_value'] / 1e9:.1f}B, "
                           f"median position x{ratios[len(ratios) // 2]:.2f}")
    return bad


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
            if abs(total - 1) > 0.001:
                off.append(f"{slug} {total:.4f}")
    if off:
        print(f"::error::pct_of_book does not sum to 1 over equity rows: {', '.join(off[:20])}; not publishing.")
        failed = True
    index = new("index.json") or {}
    lagging = [f"{m['slug']} {m.get('quarter')} < {q['quarter']} ({q['reason']} {q.get('accession') or ''})"
               for m in index.get("managers") or [] for q in m.get("skipped_quarters") or []
               if q["report_date"] > (m.get("report_date") or "") and q["reason"] not in ("empty", "notice")]
    if lagging:
        print(f"::error::Curated funds behind a newer 13F-HR on EDGAR that was not loaded: {'; '.join(lagging[:20])}; "
              f"not publishing.")
        failed = True
    short = holder_counts(data, after)
    if short:
        print(f"::error::All-filer holder counts below the tracked funds holding the stock: {'; '.join(short[:20])}; "
              f"not publishing.")
        failed = True
    wrong = reviewed_types(data)
    if wrong:
        print(f"::error::Filer types differ from the reviewed cases: {'; '.join(wrong[:20])}; not publishing.")
        failed = True
    unsplit = split_rows(data, after)
    if unsplit:
        print(f"::error::Split not applied: {'; '.join(unsplit[:20])}; not publishing.")
        failed = True
    blank, total, curated_blank = blank_accepted(data)
    if total:
        print(f"gate: accepted_at blank on {blank} of {total} holder rows with an accession")
    if curated_blank:  # curated books always know their filing's acceptance time
        print(f"::error::accepted_at missing on curated holder rows: {'; '.join(curated_blank[:20])}; not publishing.")
        failed = True
    elif blank:  # other filers: accepted.py backfills under a time budget and continues next run
        print(f"::warning::accepted_at missing on {blank} of {total} holder rows; accepted.py fills them next run")
    merged = foreign_merges(data / "h")
    if merged:
        print(f"::error::Another filer's 13F merged into a book: {'; '.join(merged[:20])}; not publishing.")
        failed = True
    drift = total_drift(data / "h")
    if drift:
        print(f"::warning::{len(drift)} books more than 0.1% off their filed cover totals: {'; '.join(drift[:10])}")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Books more than 0.1% off their filed cover totals ({len(drift)})\n\n"
                        + "".join(f"- {d}\n" for d in drift[:200]) + "\n")
    doubled = book_totals(data / "h")
    if doubled:
        print(f"::error::Books larger than their filings: {'; '.join(doubled[:20])}; not publishing.")
        failed = True
    if cov_a < cov_b - MAX_DROP:
        print(f"::error::Ticker coverage fell {100 * (cov_b - cov_a):.2f} points (limit {100 * MAX_DROP:.1f}); not publishing.")
        failed = True
    if lost:
        print(f"::error::Previously mapped CUSIPs lost their ticker: "
              + ", ".join(f"{c} ({tick_b[c]})" for c in lost[:40]) + "; not publishing.")
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
