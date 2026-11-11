"""Parse SEC 13F information-table XML. Values are as filed (USD)."""

from __future__ import annotations

import re

# Not the common stock although they share its issuer code: preferreds, notes, warrants and rights.
# Depositary shares are preferreds only with a preferred's cues (DEP SHS RP1/20 A, 6.5 DEP CUM SR D);
# ADRs (AMERICAN DEP, DEPOSITARY RECEI) and MLP depositary units are the common.
_NOT_COMMON = re.compile(r"\bPFD\b|\bPREF|\bNOTE|%|\bWT\b|\bWARRANT|\bRIGHT|\*W\b|\bW EXP\b")
_DEP_PREFERRED = re.compile(r"\bDEP(OSITARY)?\b.*(\bSHS\b|\bSR\b|\bCUM|\bCM\b|\bCNV|\bCONV|\bREP)|^\d[\d.]* DEP\b")
_ADR = re.compile(r"\bAMERICAN\b|\bADR|\bADS\b|RECEI|RCPT|\bUNIT")


def not_common(title: str | None) -> bool:
    t = (title or "").upper()
    return bool(_NOT_COMMON.search(t) or (_DEP_PREFERRED.search(t) and not _ADR.search(t)))

import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


@dataclass
class HoldingRow:
    issuer: str
    title: str
    cusip: str
    value: float
    shares: float
    shares_type: str
    put_call: str | None
    discretion: str
    other_manager: str = ""
    vote_sole: float = 0.0
    vote_shared: float = 0.0
    vote_none: float = 0.0


@dataclass
class AggregatedHolding:
    issuer: str
    title: str
    cusip: str
    value: float
    shares: float
    put_call: str | None
    ticker: str | None = None
    shares_type: str = "SH"  # "PRN": `shares` is a principal amount (notes), never a share count
    discretion: set = field(default_factory=set)
    other_managers: set = field(default_factory=set)
    vote_sole: float = 0.0
    vote_shared: float = 0.0
    vote_none: float = 0.0
    lines: int = 0


def parse_info_table(xml_text: str) -> list[HoldingRow]:
    root = ET.fromstring(xml_text)
    rows: list[HoldingRow] = []
    for el in root.iter():
        if _local(el.tag).lower() != "infotable":
            continue
        fields: dict[str, str] = {}
        for child in el.iter():
            name = _local(child.tag).lower()
            if child.text and child.text.strip():
                fields[name] = child.text.strip()
        cusip = fields.get("cusip", "").strip()
        issuer = fields.get("nameofissuer", "").strip()
        if not cusip or not issuer:
            continue
        value_raw = fields.get("value", "0").replace(",", "")
        shares_raw = fields.get("sshprnamt", "0").replace(",", "")
        try:
            value = float(value_raw)
        except ValueError:
            value = 0.0
        try:
            shares = float(shares_raw)
        except ValueError:
            shares = 0.0
        put_call = fields.get("putcall")
        if put_call:
            put_call = put_call.upper()
            if put_call not in {"PUT", "CALL"}:
                put_call = None
        rows.append(
            HoldingRow(
                issuer=issuer,
                title=fields.get("titleofclass", "COM"),
                cusip=cusip.upper(),
                value=value,
                shares=shares,
                shares_type=fields.get("sshprnamttype", "SH").upper(),
                put_call=put_call,
                discretion=fields.get("investmentdiscretion", "").upper(),
                other_manager=fields.get("othermanager", ""),
                vote_sole=_num(fields.get("sole")),
                vote_shared=_num(fields.get("shared")),
                vote_none=_num(fields.get("none")),
            )
        )
    return rows


def real_cusip(c: str | None) -> bool:
    """A usable 9-character CUSIP. Filers put placeholders such as 000000000 (or 10 zeros)
    on private funds and unlisted securities; their 000000 issuer code matches nothing."""
    c = (c or "").strip().upper()
    return len(c) == 9 and c.isalnum() and c[:6] != "000000"


def _num(raw: str | None) -> float:
    try:
        return float((raw or "0").replace(",", ""))
    except ValueError:
        return 0.0


def other_managers(raw: str) -> set[str]:
    """otherManager is a list of sequence numbers: '1', '1,2', '1 2' or '01'."""
    return {p.lstrip("0") or "0" for p in raw.replace(",", " ").replace(";", " ").split() if p.strip()}


def looks_like_thousands(total_value: float, table_value_total: float | None) -> bool:
    """SEC used to require 13F values in $000s; some filers still do.

    Competing mistake: always multiply by 1,000, which would inflate Berkshire ~1000x.
    Use the cover form's tableValueTotal plus a size sanity check instead.
    """
    if total_value <= 0:
        return False
    if table_value_total and table_value_total > 0:
        ratio = total_value / table_value_total
        if 0.8 <= ratio <= 1.25 and total_value < 50_000_000:
            return True
        if 800 <= ratio <= 1250:
            return False
    return 0 < total_value < 50_000_000


def unit_fix(pairs: list[tuple[float, float]]) -> float:
    """Factor that puts values in dollars, judged by median implied price per share.

    Some filers report in $000s with a cover total that hides it, others report
    dollars x1000. A median price under $0.50 means thousands; over $2,500 means
    an extra x1000. Needs 5 priced stock rows; otherwise 1 (trust the filing).
    Idempotent: a corrected book lands back inside the band.
    """
    prices = sorted(v / s for v, s in pairs if v > 0 and s > 0)
    if len(prices) < 5:
        return 1.0
    mid = prices[len(prices) // 2]
    if mid < 0.5:
        return 1000.0
    if mid > 2_500:
        return 0.001
    return 1.0


ABOVE_20K = {"084670108"}  # Berkshire Class A, the one US stock priced above $20k


def row_overstated(cusip: str, value: float, shares: float) -> bool:
    """A stock line priced above $20k/share was filed in dollars x1000 (mixed-unit filings)."""
    return shares > 0 and value / shares > 20_000 and cusip not in ABOVE_20K


def scale_if_thousands(holdings: list[AggregatedHolding], thousands: bool) -> None:
    if not thousands:
        return
    for h in holdings:
        h.value *= 1000


def aggregate_holdings(rows: list[HoldingRow]) -> list[AggregatedHolding]:
    """Sum split lines that share CUSIP + put/call."""
    buckets: dict[tuple[str, str], AggregatedHolding] = {}
    for row in rows:
        key = (row.cusip, row.put_call or "")
        existing = buckets.get(key)
        if existing is None:
            existing = buckets[key] = AggregatedHolding(
                issuer=row.issuer,
                title=row.title,
                cusip=row.cusip,
                value=0.0,
                shares=0.0,
                put_call=row.put_call,
                shares_type="PRN" if row.shares_type == "PRN" else "SH",
            )
        elif row.shares_type == "PRN" and existing.shares_type != "PRN":
            existing.shares_type = "PRN"  # mixed lines: never treat the sum as shares
        existing.value += row.value
        existing.shares += row.shares
        existing.lines += 1
        if row.discretion:
            existing.discretion.add(row.discretion)
        existing.other_managers |= other_managers(row.other_manager)
        existing.vote_sole += row.vote_sole
        existing.vote_shared += row.vote_shared
        existing.vote_none += row.vote_none
    out = list(buckets.values())
    out.sort(key=lambda h: h.value, reverse=True)
    return out


def consensus_prices(quarters) -> dict[tuple[str, str], float]:
    """(quarter, cusip) -> median implied price across filers; needs 3+ filers.

    Input: iterable of (quarter, [(cusip, value, shares, put_call), ...]) per filing.
    """
    seen: dict[tuple[str, str], list[float]] = {}
    for quarter, rows in quarters:
        for cusip, value, shares, put_call in rows:
            if not put_call and value > 0 and shares > 0:
                seen.setdefault((quarter, cusip), []).append(value / shares)
    out = {}
    for key, prices in seen.items():
        if len(prices) >= 3:
            prices.sort()
            out[key] = prices[len(prices) // 2]
    return out


def consensus_factor(price: float, consensus: float | None) -> float:
    """1000 or 0.001 when a line is priced ~1000x off what other filers report; else 1."""
    if not consensus or price <= 0:
        return 1.0
    ratio = price / consensus
    if 300 <= ratio <= 3000:
        return 0.001
    if 1 / 3000 <= ratio <= 1 / 300:
        return 1000.0
    return 1.0
