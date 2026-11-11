#!/usr/bin/env python3
"""Stock splits between consecutive quarters, detected from 13F holders. SEC data only.

A k-for-1 split multiplies every holder's share count by k. Holders who did not
trade therefore show a quarter-over-quarter share ratio of exactly k, while in a
normal quarter they sit at exactly 1. For each CUSIP held by MIN_HOLDERS filers in
both quarters:

- the most common exact ratio (within 0.3%) among the candidates in RATIOS must cover
  at least 5% of holders and at least 5, and more than 3x the holders at exactly 1;
- the median holder's share ratio must be k itself (within 5%);
- the median implied price must move by about 1/k (price ratio x k within 0.5-2, or up to 3
  when SEC XBRL shares outstanding confirms k within 10%).

When the issuer's CIK is known, SEC XBRL companyfacts (dei:EntityCommonStockSharesOutstanding)
must not contradict it: a reported share count change between the two quarters has to be
within 35% of k. Accepted splits are cached in data/splits.json; rejections are rechecked each run.
Change math everywhere multiplies the earlier quarter's shares by `ratio`.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.datasets import quarter_end
from ingest.edgar import DATA_BASE, get

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
PATH = DATA / "splits.json"
MIN_HOLDERS = 5
# A split on file is only dropped by a run that saw this many filers in both quarters (a full run).
# Curated runs see a few hundred and would drop real splits (APH, MNST, SFBS 2026Q3) for lack of holders.
FULL_PAIRS = 3000
MIN_EXACT = 5  # holders at exactly k
RATIOS = sorted({2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 100, 1.5, 2.5,
                 *(1 / k for k in (2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 100)), 2 / 3})
EXACT = 0.003
# Splits the issuer's own SEC filing states, applied whatever the holders show: (new cusip, to_quarter) -> ratio
# (new shares per old) and the filing. HON's 1-for-2 came the day of the Honeywell Aerospace spin-off, so the price
# per share looked unchanged and the holder rule couldn't confirm it; the per-filer price check is skipped for these.
FILED = {
    ("438516205", "2026Q2"): {"ratio": 0.5, "ticker": "HON", "issuer": "Honeywell International",
                              "evidence": "8-K 0000773840-26-000084 Ex. 99.1: 1-for-2 reverse stock split, effective "
                                          "with the Honeywell Aerospace (HONA) spin-off; new CUSIP 438516205"},
}


def detect(pairs: list[tuple[dict, dict]]) -> dict[str, dict]:
    """{cusip: evidence} from (earlier, later) {cusip: (shares, value)} books of the same filer."""
    ratios: dict[str, list[tuple[float, float]]] = {}
    for old, new in pairs:
        for cusip, (s1, v1) in old.items():
            s2, v2 = new.get(cusip, (0, 0))
            if s1 > 0 and s2 > 0 and v1 > 0 and v2 > 0:
                ratios.setdefault(cusip, []).append((s2 / s1, (v2 / s2) / (v1 / s1)))
    found = {}
    for cusip, rs in ratios.items():
        if len(rs) < MIN_HOLDERS:
            continue
        exact = lambda k: sum(1 for r, _ in rs if abs(r / k - 1) <= EXACT)
        at_one = exact(1)
        best = max(RATIOS, key=exact)
        hits = exact(best)
        if hits < MIN_EXACT or hits < 0.05 * len(rs) or hits <= 3 * at_one:
            continue
        # Most holders moved by k: the median holder's share ratio is k itself, not just a cluster.
        if abs(statistics.median(r for r, _ in rs) / best - 1) > 0.05:
            continue
        price = statistics.median(p for _, p in rs)
        if not 0.5 <= price * best <= 3:  # above 2 needs SEC XBRL confirmation (update)
            continue
        found[cusip] = {"ratio": round(best, 6), "holders": len(rs), "exact_holders": hits,
                        "unchanged_holders": at_one, "price_ratio": round(price, 4)}
    return found


def _shares_outstanding(cik: str) -> list[tuple[str, float]]:
    raw = get(f"{DATA_BASE}/api/xbrl/companyfacts/CIK{cik.zfill(10)}.json")
    facts = json.loads(raw).get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {})
    out = []
    for unit in facts.get("units", {}).values():
        for f in unit:
            if f.get("end") and f.get("val"):
                out.append((f["end"], float(f["val"])))
    return sorted(set(out))


def xbrl_ratio(cik: str | None, q_from: str, q_to: str) -> float | None:
    """Shares outstanding after the later quarter end over at the earlier one, or None.

    A 10-Q cover date falls about a month after its quarter, so a split late in a quarter shows
    first on the next cover: use the first value after the later quarter end when there is one.
    """
    if not cik:
        return None
    try:
        series = _shares_outstanding(cik)
    except Exception:  # noqa: BLE001 - confirmation is optional
        return None
    a, b = quarter_end(q_from).isoformat(), quarter_end(q_to).isoformat()
    before = [v for d, v in series if d <= a]
    after = [v for d, v in series if b < d][:1]  # a cover inside the quarter may predate the split: no verdict
    if not before or not after:
        return None
    return after[0] / before[-1]


def load() -> dict:
    return json.loads(PATH.read_text()) if PATH.exists() else {"splits": [], "checked": {}}


def table(doc: dict | None = None) -> dict[str, dict[str, float]]:
    """{cusip: {to_quarter: ratio}} for change math."""
    out: dict[str, dict[str, float]] = {}
    for s in (doc or load()).get("splits") or []:
        out.setdefault(s["cusip"], {})[s["to_quarter"]] = s["ratio"]
    return out


def ratio_between(splits: dict, cusip: str, q_from: str, q_to: str, put_call: str | None = None) -> float:
    """Product of split ratios for quarters in (q_from, q_to]. Options follow their issuer's split."""
    hits = splits.get(cusip)
    if hits is None and put_call:
        hits = next((v for c, v in splits.items() if c[:6] == cusip[:6]), None)
    r = 1.0
    for q, k in (hits or {}).items():
        if q_from < q <= q_to:
            r *= k
    return r


_TICKER_CIK: dict[str, str] | None = None


def issuer_cik(ticker: str | None) -> str | None:
    """SEC company_tickers.json: ticker -> CIK (for XBRL confirmation)."""
    global _TICKER_CIK
    if not ticker:
        return None
    if _TICKER_CIK is None:
        try:
            rows = json.loads(get("https://www.sec.gov/files/company_tickers.json")).values()
            _TICKER_CIK = {r["ticker"].upper(): str(r["cik_str"]).zfill(10) for r in rows}
        except Exception:  # noqa: BLE001
            _TICKER_CIK = {}
    return _TICKER_CIK.get(ticker.upper().replace(".", "-"))


def relink(book: dict[str, tuple[float, float]], links: dict[str, str]) -> dict[str, tuple[float, float]]:
    """A book with reissued CUSIPs (old -> new) under the new one, so a split that came with a new CUSIP is seen."""
    out: dict[str, tuple[float, float]] = {}
    for c, (s, v) in book.items():
        c = links.get(c, c)
        a, b = out.get(c, (0, 0))
        out[c] = (a + s, b + v)
    return out


def link_check(pairs: list[tuple[dict, dict]], old: str, new: str, split: float | None) -> dict | None:
    """Whether a reissue's share units match: holders of old last quarter and new this one. units_ok when a split was
    found on the linked pair (applied as a split) or holders at exactly 1:1 are at least 10% and outnumber those at
    any other split ratio. Otherwise the link would net mismatched units (a reverse split without enough holders)."""
    rs = [b[new][0] / a[old][0] for a, b in pairs if a.get(old, (0, 0))[0] > 0 and b.get(new, (0, 0))[0] > 0]
    if not rs:
        return None
    exact = lambda k: sum(1 for r in rs if abs(r / k - 1) <= EXACT)
    at1 = exact(1)
    other = max(exact(k) for k in RATIOS)
    med = statistics.median(rs)
    ok = bool(split and split != 1) or (at1 >= max(1, 0.1 * len(rs)) and at1 > other)
    return {"new": new, "holders": len(rs), "exact_at_1": at1, "exact_at_ratio": exact(split) if split and split != 1 else at1,
            "median_ratio": round(med, 4),
            "split_ratio": split if split and split != 1 else None, "units_ok": ok,
            "reason": None if ok else (f"units unconfirmed: median share ratio {med:.3f} over {len(rs)} holders, "
                                       f"{at1} at exactly 1:1, no split found")}


def update(transitions: dict[tuple[str, str], dict[str, tuple[dict, dict]]], issuers: dict[str, dict],
           links: dict[str, str] | None = None) -> dict:
    """Detect splits for each (from_quarter, to_quarter), confirm new ones once, save splits.json. Reissued CUSIPs
    (links, old -> new) count as one security, and each link's units are checked (doc["links"])."""
    doc = load()
    known = {(s["cusip"], s["to_quarter"]): s for s in doc.get("splits") or []}
    checked = doc.setdefault("checked", {})
    link_checks = doc.setdefault("links", {})
    seen: dict[str, dict] = {}
    from ingest.datasets import prev_quarter
    for (cusip, q_to), f in FILED.items():
        known[(cusip, q_to)] = {"cusip": cusip, "ticker": f["ticker"], "issuer": f["issuer"],
                                "from_quarter": prev_quarter(q_to), "to_quarter": q_to,
                                "effective_after": quarter_end(prev_quarter(q_to)).isoformat(),
                                "effective_by": quarter_end(q_to).isoformat(), "ratio": f["ratio"],
                                "confirmed_by": "issuer filing", "evidence": f["evidence"]}
    for (q_from, q_to), pairs in sorted(transitions.items()):
        found = detect([(relink(a, links), relink(b, links)) for a, b in pairs.values()] if links
                       else list(pairs.values()))
        stale = [k for k in known if k[1] == q_to and k[0] not in found and k not in FILED]
        if stale and len(pairs) < FULL_PAIRS:
            print(f"splits: {q_to} kept {len(stale)} on file not seen in {len(pairs)} filer pairs (a full run rechecks)")
            stale = []
        for key in stale:  # re-checked under today's rule
            print(f"splits: {known[key].get('ticker') or key[0]} {q_to} no longer meets the rule; dropped")
            checked[f"{key[0]}:{q_to}"] = "dropped"
            del known[key]
        for cusip, ev in found.items():
            key = f"{cusip}:{q_to}"
            if (cusip, q_to) in known:
                known[(cusip, q_to)].update(ev)
                continue
            meta = issuers.get(cusip) or {}
            xr = xbrl_ratio(meta.get("issuer_cik") or issuer_cik(meta.get("ticker")), q_from, q_to)
            if not 0.5 <= ev["price_ratio"] * ev["ratio"] <= 2 and (xr is None or abs(xr / ev["ratio"] - 1) > 0.1):
                checked[key] = "rejected"
                print(f"splits: {cusip} {q_to} x{ev['ratio']} rejected (price moved {ev['price_ratio'] * ev['ratio']:.2f}x "
                      f"after the split and XBRL does not confirm)")
                continue
            if xr is not None and abs(xr / ev["ratio"] - 1) > 0.35:
                checked[key] = "rejected"  # shares outstanding did not move with it (rechecked each run)
                print(f"splits: {cusip} {q_to} x{ev['ratio']} rejected (XBRL shares ratio {xr:.2f})")
                continue
            known[(cusip, q_to)] = {
                "cusip": cusip, "ticker": meta.get("ticker"), "issuer": meta.get("name"),
                "from_quarter": q_from, "to_quarter": q_to,
                "effective_after": quarter_end(q_from).isoformat(), "effective_by": quarter_end(q_to).isoformat(),
                **ev, "xbrl_shares_ratio": round(xr, 4) if xr else None,
                "confirmed_by": "holders and SEC XBRL shares outstanding" if xr else "holders",
            }
            checked[key] = "accepted"
            print(f"splits: {meta.get('ticker') or cusip} {q_to} ratio {ev['ratio']} "
                  f"({ev['exact_holders']}/{ev['holders']} holders exact, XBRL {xr})")
        for old, new in (links or {}).items():
            c = link_check(list(pairs.values()), old, new, (known.get((new, q_to)) or {}).get("ratio"))
            if c:
                c["evidence"] = (known.get((new, q_to)) or {}).get("evidence") or (
                    "holders and SEC XBRL shares outstanding" if c.get("split_ratio") else "holders at exactly 1:1")
            if c and c["holders"] > (seen.get(old) or {}).get("holders", 0):
                seen[old] = c | {"to_quarter": q_to, "pairs": len(pairs)}
    for old, c in seen.items():  # a curated run's few holders never overrule a full run's check
        prev = link_checks.get(old)
        if not prev or prev.get("new") != c["new"] or c["pairs"] >= FULL_PAIRS or c["holders"] >= prev.get("holders", 0):
            link_checks[old] = c
    doc["splits"] = sorted(known.values(), key=lambda s: (s["to_quarter"], s["cusip"]), reverse=True)
    doc["generated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    doc["rule"] = ("A k-for-1 split is detected when filers holding the stock in both quarters cluster at an exact "
                   "share ratio of k (and the price moves by about 1/k), and SEC XBRL shares outstanding does not "
                   "contradict it. Earlier quarters' share counts are multiplied by k in all change math.")
    PATH.write_text(json.dumps(doc, indent=1) + "\n")
    return table(doc)


def book_shares(book: dict) -> dict[str, tuple[float, float]]:
    """{cusip: (shares, value)} of share rows (no options, no principal-amount notes) in a shard or fb book."""
    cols = book.get("columns") or []
    out = {}
    for r in book.get("rows") or []:
        h = dict(zip(cols, r))
        if h.get("put_call") or h.get("shares_type") == "PRN" or not h.get("shares"):
            continue
        s, v = out.get(h["cusip"], (0, 0))
        out[h["cusip"]] = (s + h["shares"], v + (h.get("value") or 0))
    return out


def all_filer_transitions() -> dict[tuple[str, str], dict[str, tuple[dict, dict]]]:
    """Filer pairs from full books (fb/{q}/) and the latest public shards (f/)."""
    from ingest.datasets import prev_quarter

    by_q: dict[str, dict[str, dict]] = {}
    fb = DATA / "fb"
    for folder in sorted(fb.glob("*Q?")) if fb.exists() else []:
        for p in folder.glob("*.json"):
            try:
                b = json.loads(p.read_text())
            except ValueError:
                continue
            if b.get("ok"):
                by_q.setdefault(folder.name, {})[p.stem] = book_shares(b)
    for p in (DATA / "f").glob("*.json") if (DATA / "f").exists() else []:
        try:
            b = json.loads(p.read_text())
        except ValueError:
            continue
        if b.get("ok") and b.get("quarter") and p.stem not in by_q.get(b["quarter"], {}):
            by_q.setdefault(b["quarter"], {})[p.stem] = book_shares(b)
    out = {}
    for q, books in by_q.items():
        prior = by_q.get(prev_quarter(q))
        if prior:
            out[(prev_quarter(q), q)] = {c: (prior[c], books[c]) for c in books if c in prior}
    return out
