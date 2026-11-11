"""Parse SEC 13F information-table XML. Values are as filed (USD)."""

from __future__ import annotations

import re

# Not the common stock although they share its issuer code: preferreds, notes, warrants and rights.
# Depositary shares are preferreds only with a preferred's cues (DEP SHS RP1/20 A, 6.5 DEP CUM SR D);
# ADRs (AMERICAN DEP, DEPOSITARY RECEI) and MLP depositary units are the common.
_NOT_COMMON = re.compile(r"\bPFD\b|\bPREF|\bNOTE|%|\bWT\b|\bWARRANT|\bRIGHT|\*W\b|\bW EXP\b")
_DEP_PREFERRED = re.compile(r"\bDEP(OSITARY)?\b.*(\bSHS\b|\bSR\b|\bCUM|\bCM\b|\bCNV|\bCONV|\bREP)|^\d[\d.]* DEP\b")
_ADR = re.compile(r"\bAMERICAN\b|\bADR|\bADS\b|RECEI|RCPT|\bUNIT")


def not_common(title: str | None, cusip: str | None = None) -> bool:
    """Not a common-stock line: a preferred, note, warrant or right by its title, or a debt CUSIP (debt_cusip)."""
    t = (title or "").upper()
    return bool(_NOT_COMMON.search(t) or (_DEP_PREFERRED.search(t) and not _ADR.search(t))) or debt_cusip(cusip)


def cusip_check_ok(cusip: str | None) -> bool:
    """The 9th character is the CUSIP check digit of the first 8 (Ashurst 2026Q3 MSFT \"59491810R\" fails it)."""
    c = (cusip or "").upper()
    if len(c) != 9 or not c[8].isdigit():
        return False
    total = 0
    for i, ch in enumerate(c[:8]):
        v = int(ch) if ch.isdigit() else ord(ch) - 55 if "A" <= ch <= "Z" else {"*": 36, "@": 37, "#": 38}.get(ch)
        if v is None:
            return False
        v = v * 2 if i % 2 else v
        total += v // 10 + v % 10
    return (10 - total % 10) % 10 == int(c[8])


def debt_cusip(cusip: str | None) -> bool:
    """A CUSIP whose issue number (characters 7-8) has a letter: a fixed-income issue, never a share class, whatever
    the filer's title or SH/PRN says (Triglav 2026Q2 09857LAW8 and 09857LAV0, Booking notes filed as SH \"Common\" at
    ~$1.05 a unit, were summed into BKNG's holder row by issuer prefix)."""
    c = (cusip or "").upper()
    return len(c) >= 8 and any(ch.isalpha() for ch in c[6:8])

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
    line_parts: list = field(default_factory=list)  # [(shares, value as filed)] per line, for the per-line price check


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
        existing.line_parts.append((row.shares, row.value))
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


RESCALE_BAND = 1.5  # a x1000 (or /1000) rescale must land within this of the peers' median, or it isn't one


def consensus_factor(price: float, consensus: float | None) -> float:
    """1000 or 0.001 when a line is priced ~1000x off what other filers report and the rescaled price lands near
    theirs; else 1. Mizuho Securities USA 2026Q3 MCHP (18,615,337 sh, $3,256,537 filed, $0.17 a share) would be
    $175 x1000, 2.25x the $77.77 median: neither reconciles, so it is not rescaled (rescale_rejected)."""
    if not consensus or price <= 0:
        return 1.0
    ratio = price / consensus
    f = 0.001 if 300 <= ratio <= 3000 else 1000.0 if 1 / 3000 <= ratio <= 1 / 300 else 1.0
    return f if f != 1.0 and 1 / RESCALE_BAND <= ratio * f <= RESCALE_BAND else 1.0


def unit_verdict(price: float, consensus: float | None, in_dollars: bool = False) -> tuple[float, bool]:
    """The one x1000 rule for every book (curated h/, every filer's f/ shard and fb/ full book): (factor, rejected).
    Rescale only when the rescaled price lands near the peers' and the book isn't in dollars as filed (its lines sum
    to the cover page's tableValueTotal: Mizuho Securities USA 2026Q3, $6.30B, ON and AKAM). rejected: the line keeps
    its filed value and is price_outlier with value_rescale "rejected" (held, not counted)."""
    f = consensus_factor(price, consensus)
    if f == 1000.0 and in_dollars:
        return 1.0, True
    if f != 1.0:
        return f, False
    return 1.0, rescale_rejected(price, consensus)


def in_dollars(lines_total: float | None, cover_total: float | None) -> bool:
    """The book's lines as filed sum to its cover total (within 2%): its values are dollars, as the filer says."""
    return bool(cover_total and lines_total and abs(lines_total - cover_total) <= 0.02 * cover_total)


def rescale_rejected(price: float, consensus: float | None) -> bool:
    """Priced ~1000x off the peers, but x1000 (or /1000) doesn't land near them either: neither side reconciles."""
    if not consensus or price <= 0:
        return False
    ratio = price / consensus
    return (300 <= ratio <= 3000 or 1 / 3000 <= ratio <= 1 / 300) and consensus_factor(price, consensus) == 1.0
