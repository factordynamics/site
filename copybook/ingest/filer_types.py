#!/usr/bin/env python3
"""Filer type for every 13F filer, from EDGAR-only signals.

type is one of:
  hedge_fund  hedge funds, multi-strategy, quant and activist managers (activist: true on known activists)
  long_only   long-only stock pickers and mutual-fund complexes (Fidelity, T. Rowe, Capital Group, ...)
  index       index, passive and ETF sponsors (Vanguard, BlackRock, State Street, Geode, ProShares, ...)
  bank        banks, brokers and dealers
  insurance   insurers and reinsurers
  wealth      wealth managers, RIAs and family offices running diversified client books
  pension     pensions, endowments and foundations
  sovereign   sovereign wealth funds and central banks
  other       not enough signal
"Smart money" on the site is hedge_fund + long_only (`active` was the earlier name for both).

Order of evidence: the hand-checked OVERRIDES below; name rules for the institutional types; SEC
Form D (an adviser that files Form D for pooled funds of investment fund type "Hedge Fund", as the
submitter or by the fund's or its general partner's name); hedge-fund name rules; then book shape
from the filer's latest full book (position count, top-10 weight, options, ETF weight, turnover).
Each row carries `basis` saying which.

Writes data/filer_types.json ({cik: {type, basis, activist?}}) and stamps `type` into
filers.json and every f/{cik}.json shard. build.py, stocks.py and moves.py read the json.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.adv import load as load_advisers, verdict
from ingest.datasets import prev_quarter
from ingest.gate import TYPES_ACCEPTED, TYPES_MAX_MOVE, TYPES_MIN_FILERS, type_counts, type_drift

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or (ROOT / "web"))
DATA = WEB / "data"
TYPES = ("hedge_fund", "long_only", "index", "bank", "insurance", "wealth", "pension", "sovereign", "other")
SMART = ("hedge_fund", "long_only")
FORM_D_QUARTERS = 8  # quarters of SEC Form D data sets read for hedge-fund advisers

# Hand-checked: (cik, type). Large index/bank/insurer filers whose names are ambiguous, and
# well-known hedge funds whose books (thousands of lines, heavy options) look like banks.
OVERRIDES = {
    # index / passive / ETF sponsors
    "0002012383": "index", "0000093751": "index", "0001214717": "index", "0000073124": "index",
    "0000354204": "index", "0000914208": "index", "0001330387": "index", "0000884546": "index",
    # long-only managers that name rules would miss
    "0000315066": "long_only", "0001422848": "long_only", "0001562230": "long_only", "0001422849": "long_only",
    "0000080255": "long_only", "0001897612": "long_only", "0000902219": "long_only", "0001067983": "long_only",
    # banks, brokers, insurers
    "0000019617": "bank", "0000895421": "bank", "0000886982": "bank", "0000072971": "bank",
    "0000831001": "bank", "0000312069": "bank", "0000948046": "bank", "0000070858": "bank",
    "0001000275": "bank", "0001610520": "bank", "0000861177": "bank",
    # sovereign
    "0001374170": "sovereign",
    # hedge funds and multi-strategy managers
    "0001423053": "hedge_fund", "0001273087": "hedge_fund", "0001179392": "hedge_fund",
    "0001603466": "hedge_fund", "0001037389": "hedge_fund", "0001167557": "hedge_fund",
    "0001009207": "hedge_fund", "0001350694": "hedge_fund", "0001029160": "hedge_fund",
    "0001637460": "hedge_fund", "0001318757": "hedge_fund", "0001218710": "hedge_fund",
    "0001736225": "hedge_fund", "0001665241": "hedge_fund", "0001393825": "hedge_fund",
    "0001656456": "hedge_fund", "0001040273": "hedge_fund", "0001336528": "hedge_fund",
    "0001135730": "hedge_fund", "0001103804": "hedge_fund", "0001167483": "hedge_fund",
    "0001747057": "hedge_fund", "0001061165": "hedge_fund", "0001647251": "hedge_fund",
    "0000921669": "hedge_fund", "0001345471": "hedge_fund", "0001418814": "hedge_fund",
    "0001358706": "hedge_fund", "0001489933": "hedge_fund", "0001061768": "hedge_fund",
    "0001536411": "hedge_fund", "0001791786": "hedge_fund", "0001387322": "hedge_fund",
    "0001798849": "hedge_fund", "0001541617": "hedge_fund", "0001517137": "hedge_fund",
    "0001998597": "hedge_fund", "0001535472": "hedge_fund", "0001582090": "hedge_fund",
}
# Well-known multi-manager, macro, quant and long/short hedge funds (checked by name against EDGAR).
OVERRIDES.update({c: "hedge_fund" for c in """
0001165408 0001326389 0001581811 0001512857 0000923093 0001612063 0001009207 0001037389 0001218710 0001665241
0001578621 0001603466 0001736225 0001454027 0001393825 0001478735 0001179392 0001637460 0001318757 0002051323
0001388551 0001448574 0001315421 0001535630 0001642575 0001557017 0001666905 0001758720 0002024579 0001729829
0001564702 0001352851 0001595082 0001054587 0001747057 0000934639 0001569049 0001535943 0001218199 0000909661
0001278951 0001011443 0001577524 0001535472 0001998597 0001517137 0001345471 0001418814 0001536411 0001079114
0001541617 0001214822 0001389507 0001443689 0001423053""".split()})
# Checked by hand: not hedge funds although book shape or Form D names suggested it.
OVERRIDES.update({
    "0001214639": "long_only",   # DSM Capital Partners
    "0001191672": "bank",        # Credit Agricole SA
    "0000944388": "long_only",   # 1832 Asset Management
    "0001573767": "other",       # Hamilton Lane (private equity fund of funds)
    "0002070852": "long_only",   # Wedbush Fund Advisers
    "0002076121": "sovereign",   # Amanah Holdings Trust
    "0001780365": "long_only",   # WT Asset Management
    "0002053305": "long_only",   # BIT Capital
    # Proprietary traders and market makers (broker-dealers), not hedge funds
    "0001632341": "bank", "0001719165": "bank", "0001632813": "bank", "0001721757": "bank",
    "0001143261": "bank", "0002011874": "bank", "0001915842": "bank",
    # PM's check of CRWD, APH and SNDK hedge-fund holders (2026-11-09)
    "0001024896": "bank", "0001881567": "bank", "0001274419": "bank", "0001997464": "bank",  # Cantor, Clear Street, CIC, Marex
    "0001652026": "other", "0002118292": "other",  # Fund Resources Investment Holding, Galaxy Digital
    "0002010854": "long_only", "0001491719": "long_only", "0001861159": "long_only", "0001974438": "long_only",
    "0001506073": "long_only", "0001506071": "long_only",  # BOCHK AM, Lombard Odier AM (USA), O'Neil, OneAscent, Wellington Shields x2
    "0001704268": "sovereign",  # Mubadala
})
# The reviewed cases (also the gate's regression test) win over everything above.
CASES = Path(__file__).with_name("type_cases.json")
OVERRIDES.update({c: v["type"] for c, v in json.loads(CASES.read_text())["filers"].items()})
# Checked by hand (reclass review, 2026-11-11), used only when the classifier runs (not on the published types):
# advisers whose Form ADV private funds are hedge funds but who allocate to other managers (funds of funds, OCIOs,
# endowment-style platforms) or run private equity; rules-based ETF issuers; market makers whose 13F is inventory.
RECLASS_CASES = {
    "0001616667": "index", "0001744347": "index", "0001600064": "index",  # Pacer, Vident, Tidal (ETF issuers)
    "0000932540": "other", "0001475597": "other", "0001831577": "other",  # Group One, HRT, Jump (market makers)
    "0001698246": "long_only",  # IFM Investors (infrastructure and pension-owned asset manager)
    "0001939480": "long_only",  # GCM Grosvenor (alternatives allocator, funds of funds)
    "0001514334": "long_only",  # MSD Partners (Dell family's investment firm)
    "0001535457": "wealth",     # MIO Partners (McKinsey's investment office)
    "0001476993": "wealth",     # Investure (OCIO)
    "0001359262": "wealth",     # Makena Capital (endowment-model OCIO)
    "0001519611": "wealth",     # Cerity Partners OCIO
    "0001159363": "wealth",     # CAZ Investments (access funds for individuals)
    "0001157519": "wealth",     # Okabena Investment Services (multi-family office)
    "0001335325": "wealth",     # HighVista Strategies (endowment-model OCIO)
    "0001317947": "other",      # Bain Capital Credit (private credit)
    # PM review (Nov 11): Horizon Kinetics' book is mostly ETFs, mutual funds and separate accounts; value managers whose
    # wrap and separate accounts count as individuals on Form ADV; Empowered Funds is a white-label ETF platform.
    "0001056823": "long_only", "0000823621": "long_only", "0001007524": "long_only", "0001112325": "long_only",
    "0001592828": "index",
    "0001730578": "wealth",     # Vanguard Capital Wealth Advisors (an RIA, not Vanguard; the name rule typed it index)
    "0001404784": "hedge_fund", # Granville Capital, Greensboro NC (ADV CRD 126679: 7 private funds, all hedge, 58% of RAUM)
    # Market makers and prop traders (their 13F is inventory), whatever Form ADV says
    "0001533421": "other", "0001488542": "other", "0001455915": "other", "0001279891": "other",  # Tower, Simplex, Old Mission, Wolverine
    "0001714498": "long_only",  # AIP (funds of hedge funds)
    "0001080818": "other",      # EnTrust Global (fund of funds)
    "0001560123": "other",      # Catterton (private equity)
}
ACTIVISTS = {"0000921669", "0001345471", "0001418814", "0001336528", "0001040273", "0001791786",
             "0001517137", "0001998597", "0001535472", "0001582090"}

RULES: list[tuple[str, re.Pattern]] = [
    ("index", re.compile(r"\b(VANGUARD|BLACKROCK|STATE STREET|GEODE|DIMENSIONAL FUND|SSGA|ISHARES|SPDR|"
                         r"PROSHARE|DIREXION|RAFFERTY ASSET|NEOS INVESTMENT|PENSERRA|HARVEST PORTFOLIOS|ROUNDHILL|"
                         r"FIRST TRUST|WISDOMTREE|GLOBAL X|VAN ?ECK|INDEX|ETF|ETFS|INVESCO|AMUNDI|"
                         r"LEGAL & GENERAL|CHARLES SCHWAB|NORTHERN TRUST|RUSSELL INVESTMENTS|"
                         r"PARAMETRIC|QUANTITATIVE MANAGEMENT ASSOC|MELLON INVESTMENTS)\b", re.I)),
    ("sovereign", re.compile(r"\b(NORGES BANK|KOREA INVESTMENT CORP|GIC PRIVATE|GOVERNMENT OF SINGAPORE|TEMASEK|"
                             r"INVESTMENT AUTHORITY|PUBLIC INVESTMENT FUND|CHINA INVESTMENT CORP|SOVEREIGN|"
                             r"MUBADALA|FUTURE FUND|NATIONAL WEALTH FUND|PERMANENT FUND|AMANAH|KHAZANAH|"
                             r"CENTRAL BANK|SWISS NATIONAL BANK|BANK OF (ISRAEL|KOREA|JAPAN|CANADA|ENGLAND)|"
                             r"MONETARY AUTHORITY|SAFE INVESTMENT)\b", re.I)),
    ("pension", re.compile(r"\b(RETIREMENT|PENSION|PENSIOEN|PENSIONS|TEACHERS|PUBLIC EMPLOYEES|EMPLOYEES'? RETIREMENT|"
                           r"PROVIDENT FUND|EMERYTALNE|NATIONALE-NEDERLANDEN|AP-?FONDEN|APG|KLP|MN SERVICES|PGGM|ALECTA|KEVA|"
                           r"ILMARINEN|VARMA|CAISSE DE DEPOT|OMERS|CPP INVESTMENT|"
                           r"ENDOWMENT|UNIVERSITY|COLLEGE|FOUNDATION|BOARD OF ADMINISTRATION|INVESTMENT BOARD|"
                           r"ENSIGN PEAK|STATE OF [A-Z]+|COMMONWEALTH|COUNTY OF|CITY OF|"
                           r"SUPERANNUATION|MASTER TRUST|REGENTS)\b", re.I)),
    ("insurance", re.compile(r"\b(INSURANCE|ASSURANCE|REINSURANCE|ASSURANCES|ASSICURAZIONI|VERSICHERUNG|LIFE|"
                             r"AVIVA|ALLIANZ|AXA|GENERALI|ZURICH|METLIFE|PRUDENTIAL|MANULIFE|MUNICH RE|SWISS RE|"
                             r"HANNOVER RE|CHUBB|AMERICAN INTERNATIONAL GROUP|LINCOLN NATIONAL|NATIONWIDE|"
                             r"THRIVENT|MUTUAL OF|CINCINNATI FINANCIAL|MARKEL|TOKIO MARINE|MS&AD|SOMPO|"
                             r"MITSUI SUMITOMO INSURANCE|FAIRFAX FINANCIAL|FIDELITY NATIONAL FINANCIAL|HARTFORD FINANCIAL|"
                             r"FORSAKRING\w*|LIVFORSAKRING\w*|INTACT INVESTMENT|AG2R|MONDIALE|AEGON|TALANX|SCOR|"
                             r"CNP ASSURANCES|ASSUR)\b", re.I)),
    ("other", re.compile(r"\b(JANE STREET|SUSQUEHANNA|OPTIVER|IMC|VIRTU|FLOW TRADERS|HUDSON RIVER TRADING|"
                         r"JUMP TRADING|CITADEL SECURITIES|BELVEDERE TRADING|DV TRADING|PROPRIETARY|"
                         r"MARKETS TRADING|WALLEYE TRADING|HARTREE)\b", re.I)),  # market makers and prop traders
    ("bank", re.compile(r"\b(BANK|BANCORP|BANCSHARES|BANCORPORATION|BANQUE|BANCO|N\.?A\.?$|NATIONAL ASSOCIATION|"
                        r"SECURITIES|BROKERAGE|MUTUAL|"
                        r"MORGAN STANLEY|GOLDMAN SACHS|JPMORGAN|CITIGROUP|WELLS FARGO|UBS|BARCLAYS|HSBC|"
                        r"BNP PARIBAS|CREDIT SUISSE|MIZUHO|NOMURA|MITSUBISHI UFJ|SUMITOMO|RAYMOND JAMES|"
                        r"STIFEL|LPL FINANCIAL|OPPENHEIMER & CO|AMERIPRISE|EDWARD JONES|TRUST CO(MPANY)?|SAVINGS|CREDIT UNION|"
                        r"DEKABANK|DZ BANK|LANDESBANK|SPARKASSE|JANE STREET|SUSQUEHANNA|OPTIVER|IMC|"
                        r"VIRTU|FLOW TRADERS|HUDSON RIVER TRADING|JUMP TRADING|CITADEL SECURITIES|CLEAR STREET|MAREX|"
                        r"CANTOR FITZGERALD|NEARWATER|CAPITAL MARKETS|MARKETS CAYMAN|MARKETS AMERICAS|"
                        r"MARKET MAKING|BROKER|DEALER|STONEX|INTERACTIVE BROKERS|TRADEWEB|PERSHING LLC)\b", re.I)),
    ("other", re.compile(r"\b(VENTURES?|VENTURE PARTNERS|PRIVATE EQUITY|GROWTH EQUITY|BUYOUT|ACQUISITIONS?|"
                         r"KKR|CARLYLE|BLACKSTONE INC|TPG|WARBURG PINCUS|SILVER LAKE|THOMA BRAVO|VISTA EQUITY|"
                         r"BAIN CAPITAL (INVESTORS|VENTURE|LIFE)|AFFINITY PARTNERS|LITTLEJOHN|GENERAL ATLANTIC|"
                         r"SOFTBANK|INVESTOR AB|WALMART|MSD CAPITAL|HAMILTON LANE)\b", re.I)),
    ("wealth", re.compile(r"\b(PRIVATE BANK|BROWN SHIPLEY|EVELYN PARTNERS)\b", re.I)),
    ("long_only", re.compile(r"\b(FMR|FIDELITY|T\.? ?ROWE|PRICE T ROWE|CAPITAL RESEARCH|CAPITAL WORLD|"
                             r"CAPITAL INTERNATIONAL|FRANKLIN RESOURCES|FRANKLIN TEMPLETON|FRANKLIN ADVISERS|ALLIANCEBERNSTEIN|NUVEEN|MASSACHUSETTS FINANCIAL|MFS|"
                             r"LORD,? ABBETT|WASATCH|ABERDEEN|ABRDN|GF FUND|FUND MANAGEMENT|FUND MGMT|FUNDS MANAGEMENT|"
                             r"FUND MANAGERS|ASSET MANAGEMENT CO\.?,? LTD|INVESTMENT TRUST|INVESTMENT TRUST MANAGEMENT|"
                             r"WELLINGTON MANAGEMENT|AMERICAN CENTURY|JANUS|DODGE & COX|PRIMECAP|BAILLIE GIFFORD|"
                             r"PUTNAM|LOOMIS|HARRIS ASSOCIATES|SOUTHEASTERN ASSET|ARTISAN PARTNERS|COHEN & STEERS|"
                             r"NEUBERGER|FEDERATED|HARTFORD|VICTORY CAPITAL|COLUMBIA MANAGEMENT|THORNBURG|CALAMOS|"
                             r"PIMCO|PACIFIC INVESTMENT MANAGEMENT|INTECH INVESTMENT|C WORLDWIDE|NINETY ONE|SCHRODER|M&G|JUPITER|DWS|"
                             r"UNION INVESTMENT|ROBECO|NORDEA|CANDRIAM|PICTET|LAZARD|MATTHEWS INTERNATIONAL|GQG|"
                             r"HARDING LOEVNER|JENNISON|WILLIAM BLAIR|DAVIS SELECTED|TWEEDY|MANNING & NAPIER|"
                             r"VOYA|PRINCIPAL|EATON VANCE|TIAA|TEACHERS ADVISORS|AMERICAN FUNDS|ALGER|"
                             r"BROWN ADVISORY|POLEN|SANDS CAPITAL|EDGEWOOD|FIERA|MACKENZIE|RBC GLOBAL ASSET|"
                             r"CI INVESTMENTS|BMO ASSET|NATIXIS|OSTRUM|ODDO|CARMIGNAC|COMGEST|STEWART INVESTORS|"
                             r"FIRST SENTIER|MAGELLAN|PLATINUM INVESTMENT|O'?NEIL GLOBAL|NIKKO|DAIWA ASSET|MITSUBISHI UFJ ASSET|"
                             r"SAMSUNG ASSET|MIRAE|E FUND|CHINA ASSET|HARVEST FUND|HUAXIA)\b", re.I)),
    ("wealth", re.compile(r"\b(WEALTH|FINANCIAL PLANNING|FINANCIAL ADVISORS?|PLANNING|RETIREMENT PLANNING|"
                          r"FAMILY OFFICE|PRIVATE CLIENT|INVESTMENT COUNSEL|FINANCIAL SERVICES|"
                          r"FINANCIAL GROUP|FINANCIAL NETWORK|ADVISORY SERVICES|FINANCIAL PARTNERS|"
                          r"FINANCIAL CORP)\b", re.I)),
]
HEDGE_NAME = re.compile(r"\b(MASTER FUND|OFFSHORE|HEDGE|ARBITRAGE|MULTI-?STRATEGY|"
                        r"OPPORTUNITIES FUND|GLOBAL MACRO|ACTIVIST)\b", re.I)

# Words that carry no identity when matching a 13F filer to Form D fund and general-partner names.
NOISE = set("""L P LP LLP LLC L L C INC INCORPORATED LTD LIMITED CORP CORPORATION CO COMPANY PLC SA S A AG AB NV BV
GMBH SE SARL SAS KG THE AND OF A PARTNERS PARTNERSHIP MANAGEMENT MGMT MANAGER MANAGERS CAPITAL ADVISORS ADVISERS ADVISORY
ASSET ASSETS INVESTMENT INVESTMENTS INVESTORS GROUP HOLDINGS HOLDING FUND FUNDS MASTER FEEDER OFFSHORE ONSHORE DOMESTIC
INTERNATIONAL GLOBAL TRUST GP GENERAL PARTNER LTD QP II III IV V VI I SPV SERIES CLASS ASSOCIATES ADVISOR CAYMAN
DELAWARE US USA LIMITED PARTNERSHIP EQUITY EQUITIES OPPORTUNITIES OPPORTUNITY STRATEGIES STRATEGY PORTFOLIO
LONG SHORT SPECIAL SITUATIONS VALUE GROWTH MACRO MULTI CREDIT EVENT DRIVEN SELECT FOCUS FOCUSED USD EUR GBP JPY
LEVERED UNLEVERED ENHANCED PLUS TRADING INSTITUTIONAL ACCESS FEEDER S""".split())


def stem(name: str) -> str:
    """Identity words of an entity name: 'Pershing Square Capital Management, L.P.' -> 'PERSHING SQUARE'."""
    words = re.sub(r"[^A-Z0-9 ]", " ", (name or "").upper().replace("&", " AND ")).split()
    return " ".join(w for w in words if w not in NOISE and not w.isdigit())


def form_d_hedge() -> tuple[set[str], dict[str, int]]:
    """(submitter CIKs, {name stem: offerings}) of SEC Form D offerings whose investment fund type is
    "Hedge Fund", from the last FORM_D_QUARTERS quarterly Form D data sets. Empty when unavailable."""
    import csv
    import io
    import zipfile
    from datetime import date

    from ingest.datasets import CACHE
    from ingest.edgar import get

    ciks: set[str] = set()
    stems: dict[str, int] = {}
    y, q = date.today().year, (date.today().month - 1) // 3 + 1
    got = 0
    for _ in range(FORM_D_QUARTERS + 2):
        y, q = (y, q - 1) if q > 1 else (y - 1, 4)
        if got >= FORM_D_QUARTERS:
            break
        path = CACHE / f"formd-{y}q{q}.zip"
        if not path.exists():
            try:
                body = get(f"https://www.sec.gov/files/structureddata/data/form-d-data-sets/{y}q{q}_d.zip")
            except Exception:  # noqa: BLE001  (not published yet)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        got += 1
        z = zipfile.ZipFile(path)
        names = {n.rsplit("/", 1)[-1]: n for n in z.namelist()}
        rows = lambda n: csv.DictReader(io.TextIOWrapper(z.open(names[n]), encoding="utf-8", errors="replace"),
                                        delimiter="\t")
        hedge = {r["ACCESSIONNUMBER"] for r in rows("OFFERING.tsv") if r.get("INVESTMENTFUNDTYPE") == "Hedge Fund"}
        for acc in hedge:
            ciks.add(acc.split("-")[0].zfill(10))
        for r in rows("ISSUERS.tsv"):
            if r["ACCESSIONNUMBER"] in hedge and (s := stem(r.get("ENTITYNAME") or "")):
                stems[s] = stems.get(s, 0) + 1
        for r in rows("RELATEDPERSONS.tsv"):  # general partners and managers filed as entities
            if r["ACCESSIONNUMBER"] in hedge and (r.get("FIRSTNAME") or "").strip().lower() in ("", "n/a", "na", "none"):
                if s := stem(r.get("LASTNAME") or ""):
                    stems[s] = stems.get(s, 0) + 1
    firsts: dict[str, int] = {}
    for st in stems:
        if " " in st:
            firsts[st.split()[0]] = firsts.get(st.split()[0], 0) + 1
    GENERIC.update(w for w, k in firsts.items() if k >= 3)
    return ciks, stems


GENERIC: set[str] = set()  # filled by form_d_hedge()
ACRONYMS = set("""LLC LP LLP PLC AG SA NV BV AB AS ASA SE US USA UK ETF ETFS AQR BNP UBS HSBC RBC BMO TD MFS FMR DWS GQG
IMC NA II III IV VI CI CIBC ING KLP APG PGGM CPP DE GP SPDR SSGA ADR REIT LPL PNC SVB BMW HQ IT AI DSM RIA CTA
SEI TCW TIAA CREF AXA AIG MSD DE ICM AMP CDPQ PSP BCI IFM ATP GIC KIC NBIM ASR NN MN BBVA BPCE DZ LGT EFG KBC""".split())
CASED = {"INC": "Inc.", "LTD": "Ltd", "CO": "Co.", "CORP": "Corp.", "GMBH": "GmbH", "JPMORGAN": "JPMorgan",
         "BLACKROCK": "BlackRock", "GUARDCAP": "GuardCap", "MCKINLEY": "McKinley", "OF": "of", "AND": "and", "THE": "the",
         "PTE": "Pte", "SARL": "S.à r.l.", "L.P.": "L.P.", "L.L.C.": "L.L.C.", "N.A.": "N.A.", "S.A.": "S.A."}


def display_name(name: str) -> str:
    """'GUARDCAP ASSET MANAGEMENT LTD' -> 'GuardCap Asset Management Ltd'; names with lower case stay as filed."""
    name = re.sub(r"\s*/[A-Z]{2,4}/?\s*$", "", (name or "").strip())
    if not name or re.search(r"[a-z]", name):
        return name
    out = []
    for i, w in enumerate(name.split()):
        core = w.strip(",.()")
        if core.upper() in CASED and (i or core.upper() not in ("OF", "AND", "THE")):
            at = w.find(core)
            rep = CASED[core.upper()]
            out.append(w[:at] + (rep.rstrip(".") if w[at + len(core):at + len(core) + 1] == "." else rep) + w[at + len(core):])
        elif core in ACRONYMS or any(ch.isdigit() for ch in core) or ("." in core and len(core) <= 6) \
                or (len(core) <= 4 and core.isalpha() and not re.search(r"[AEIOUY]", core)):
            out.append(w)
        else:
            out.append(re.sub(r"[A-Z][A-Z']*", lambda m: m.group()[0] + m.group()[1:].lower(), w)
                       .replace("Mc", "Mc", 1))
    s = " ".join(out)
    return re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), s)


def read(path: Path):
    try:
        return json.loads(path.read_text()) if path.exists() else None
    except ValueError:
        return None


def shape(book: dict | None, prev: dict | None) -> dict:
    """Book-shape signals from a full book (columnar, as in f/ and fb/)."""
    if not book or not book.get("ok"):
        return {}
    cols = book["columns"]
    rows = [dict(zip(cols, r)) for r in book.get("rows") or []]
    eq = [h for h in rows if not h.get("put_call") and h.get("shares_type", "SH") != "PRN"]
    total = sum(h.get("value") or 0 for h in eq) or 1
    vals = sorted((h.get("value") or 0 for h in eq), reverse=True)
    opts = sum(h.get("value") or 0 for h in rows if h.get("put_call"))
    etf = sum(h.get("value") or 0 for h in eq if re.search(r"\bETF\b|\bTR UNIT\b|ISHARES|SPDR",
                                                              f"{h.get('issuer') or ''} {h.get('title') or ''}", re.I))
    out = {"positions": book.get("position_count") or len(rows), "top10": sum(vals[:10]) / total,
           "options": opts / total, "etf": etf / total, "aum": total}
    if prev and prev.get("ok"):
        pc = prev["columns"]
        a = {r[pc.index("cusip")] for r in prev.get("rows") or []}
        b = {h["cusip"] for h in eq}
        if a or b:
            out["turnover"] = len(a ^ b) / max(1, (len(a) + len(b)) / 2)
    return out


def concentrated(s: dict) -> bool:
    """A stock picker's book: top 10 at least 40% of the share book and under 100 positions."""
    return bool(s) and (s.get("positions") or 10**9) < 100 and (s.get("top10") or 0) >= 0.4


def classify(cik: str, name: str, s: dict, form_d: tuple[set[str], dict[str, int]] | None = None,
             common: set[str] | None = None, adviser: dict | None = None, prior: str | None = None) -> tuple[str, str, dict]:
    """(type, basis, type_evidence). A filer becomes hedge_fund only from the hand-checked cases, a name rule or Form
    ADV (hedge funds' gross assets at least half of RAUM, or $1B and more at a quarter of it); Form D, names and book
    shape alone never add one. A published hedge_fund stays unless Form ADV clearly shows it isn't one, and a filer
    published as a stock picker (long_only, or a hedge_fund that Form ADV removes) with a concentrated book is long_only,
    never wealth, whatever the client mix (Akre, Giverny, Semper Augustus; Check Capital, published hedge_fund)."""
    kind, basis, ev = _classify(cik, name, s, form_d, common, adviser, prior)
    if prior in ("long_only", "hedge_fund") and kind == "wealth" and concentrated(s) \
            and not basis.startswith(("override", "hand", "name")):
        return "long_only", f"kept: concentrated book ({basis})", ev
    return kind, basis, ev


def _classify(cik, name, s, form_d, common, adviser, prior) -> tuple[str, str, dict]:
    ev: dict = {}
    if form_d and (cik in form_d[0]):
        ev["form_d"] = "files Form D for hedge funds"
    if cik in OVERRIDES:
        return OVERRIDES[cik], "override", ev | {"source": "hand-checked"}
    if cik in RECLASS_CASES:
        return RECLASS_CASES[cik], "hand-checked (reclass review)", ev | {"source": "hand-checked"}
    for kind, rx in RULES:
        if rx.search(name or ""):
            return kind, "name", ev | {"source": "name rule"}
    if adviser:
        kind, adv_ev = verdict(adviser)
        ev |= {"adv": adv_ev}
        # The reclass adds hedge_fund freely but removes a published hedge_fund only when the matched adviser's Form ADV
        # clearly shows it isn't one: hedge funds under 5% of its book, and either private funds that are mostly of
        # other kinds (Cresset: 14 of 145; Patient Square: private equity) or no private funds and a book of individuals
        # or registered funds (Stone House). Carlson, Tensile and NEXTBio run hedge funds below the reclass share;
        # Keywise's private funds are mostly hedge funds; JAT and Vennlight report no private funds and no client mix.
        pf, hf = adviser["private_funds"], adviser["hedge_funds"]
        clearly_not = (adv_ev.get("hedge_share") or 0) < 0.05 and (
            (pf and hf < 0.5 * pf) or (not pf and kind in ("wealth", "long_only")))
        if kind != "hedge_fund" and prior == "hedge_fund" and not clearly_not:
            return "hedge_fund", "kept: Form ADV doesn't show it isn't a hedge fund", ev
        if kind:
            return kind, f"Form ADV ({kind})", ev
    elif prior == "hedge_fund":  # no Form ADV match: nothing shows it isn't one (Sphera, Harspring, Santa Monica)
        return "hedge_fund", "kept: no Form ADV match", ev
    kind, basis = shape_type(name, s)
    if kind == "hedge_fund":
        kind, basis = "long_only", basis + "; no Form ADV hedge-fund evidence"
    return kind, basis, ev


def shape_type(name: str, s: dict) -> tuple[str, str]:
    if HEDGE_NAME.search(name or ""):
        return "hedge_fund", "name"
    if not s:
        return "other", "none"
    n, top10, opts, etf = s["positions"], s["top10"], s["options"], s["etf"]
    if etf > 0.5:
        return "wealth", "shape: mostly ETFs"
    if n <= 5 and opts == 0 and s.get("turnover", 0) < 0.3:
        return "other", "shape: a few long-held stakes (strategic or corporate holder)"
    if n <= 150 and top10 >= 0.4 and etf <= 0.2:
        if opts > 0.05 or s.get("turnover", 0) > 0.6:
            return "hedge_fund", "shape: concentrated, options or high turnover"
        return "long_only", "shape: concentrated"
    if opts > 0.25 and n <= 1500:
        return "hedge_fund", "shape: heavy options"
    if n > 1500 and top10 < 0.25:
        return "index", "shape: broad and diversified"
    if etf > 0.1:
        return "wealth", "shape: ETF-heavy"
    if s.get("aum", 0) < 1.5e9:
        # Small diversified books are mostly advisers running client accounts, not fund managers.
        return "wealth", "shape: small diversified book"
    return "long_only", "shape: diversified"


SUFFIXES = {"LIMITED": "LTD", "INCORPORATED": "INC", "CORPORATION": "CORP", "COMPANY": "CO"}


def legal(name: str) -> str:
    """The whole legal name, normalized: 'Voss Capital, L.P.' and 'VOSS CAPITAL, LP' -> 'VOSS CAPITAL LP'."""
    s = re.sub(r"\b([A-Z]) (?=[A-Z]\b)", r"\1", re.sub(r"[^A-Z0-9]+", " ", (name or "").upper().replace("&", " AND ")))
    return " ".join(SUFFIXES.get(w, w) for w in s.split())


def adviser_index(advisers: list[dict]) -> tuple[dict, dict, dict]:
    """{cik: adviser}, {legal name: adviser} and {name stem: adviser}, names kept only when they name exactly one adviser."""
    by_cik, by_legal, by_stem, seen = {}, {}, {}, {}
    for a in advisers:
        if a["cik"]:
            by_cik.setdefault(a["cik"], a)
        for key, table in [(("L", legal(n)), by_legal) for n in a["names"]] + [(("S", stem(n)), by_stem) for n in a["names"]]:
            if key[1] and table.get(key[1]) is not a:
                seen[key] = seen.get(key, 0) + 1
                table[key[1]] = a
    return (by_cik, {k: a for k, a in by_legal.items() if seen[("L", k)] == 1},
            {k: a for k, a in by_stem.items() if seen[("S", k)] == 1})


def adviser_for(cik: str, name: str, index: tuple[dict, dict, dict] | None, common: set[str]) -> dict | None:
    if not index:
        return None
    by_cik, by_legal, by_stem = index
    if cik in by_cik:
        return by_cik[cik]
    # The same legal name on the 13F and the ADV (Voss Capital, LP; AIGH Capital Management LLC), even when the short
    # stem is shared with other advisers (Voss Wealth) or too short to trust on its own.
    if legal(name) in by_legal:
        return by_legal[legal(name)]
    st = stem(name)
    # A stem shared by several 13F filers identifies nobody (Glenview Trust vs Glenview Capital have
    # different stems; "ATLAS" alone does not), and a one-word stem must be distinctive.
    if st in by_stem and st not in common and (" " in st or len(st) >= 6):
        return by_stem[st]
    return None


def write_guard(status: str, reason: str, published: dict, candidate: dict | None, moved: list) -> None:
    """data/types_guard.json: what the last full run did with filer types. status: published (new types within the
    limit), accepted (published under the accepted-reclass flag), held (the published types were kept: the candidate
    set moved too far or Form ADV could not be read; alert), kept (the classifier did not run)."""
    from datetime import datetime, timezone
    (DATA / "types_guard.json").write_text(json.dumps({
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "status": status, "reason": reason,
        "limit_pct": round(100 * TYPES_MAX_MOVE), "limit_min_filers": TYPES_MIN_FILERS,
        "published_counts": published, "candidate_counts": candidate, "moved": moved}, indent=1) + "\n")


# The published set's date (`as_of`, index.json `types_as_of`): set when a full type set is published (status published
# or accepted); hand-checked corrections keep it. The set live since Nov 11 01:22 UTC predates the field.
FIRST_AS_OF = "2026-11-11"


def stamp_as_of(as_of: str) -> None:
    """index.json `types_as_of` now, not only at the next run's build.py (which runs before this step)."""
    index = read(DATA / "index.json")
    if index is not None and index.get("types_as_of") != as_of:
        (DATA / "index.json").write_text(json.dumps(index | {"types_as_of": as_of}, separators=(",", ":")) + "\n")


def apply_overrides() -> int:
    """Curated runs: the hand overrides and reviewed cases on top of the last full run's filer_types.json,
    so a change to them is live (and passes the gate) without waiting for a full run."""
    doc = read(DATA / "filer_types.json")
    if not doc:
        return 0
    if not doc.get("as_of"):
        doc["as_of"] = FIRST_AS_OF
        (DATA / "filer_types.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    stamp_as_of(doc["as_of"])
    changed = {c: t for c, t in OVERRIDES.items() if c in doc["filers"] and doc["filers"][c].get("type") != t}
    for c, t in changed.items():
        doc["filers"][c] |= {"type": t, "basis": "override"}
    if changed:
        (DATA / "filer_types.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
        filers_doc = read(DATA / "filers.json") or {"filers": []}
        for f in filers_doc["filers"]:
            f["type"] = changed.get(f["cik"], f.get("type"))
        (DATA / "filers.json").write_text(json.dumps(filers_doc, separators=(",", ":")) + "\n")
        for c, t in changed.items():
            shard = read(DATA / "f" / f"{c}.json")
            if shard is not None:
                (DATA / "f" / f"{c}.json").write_text(json.dumps(shard | {"type": t}, separators=(",", ":")) + "\n")
    print(f"filer types: {len(changed)} overrides applied to the last full run's types")
    return 0


# The Form ADV reclass is published only once accepted (PM test list 100%, 30-filer sample, checked on a full run's
# output): until COPYBOOK_TYPES_RECLASS=1, full runs keep the last published types plus the hand-checked cases.
RECLASS = os.environ.get("COPYBOOK_TYPES_RECLASS") == "1"


def main() -> int:
    if "--overrides" in sys.argv:
        return apply_overrides()
    published_types = (read(DATA / "filer_types.json") or {}).get("filers") or {}
    published = type_counts(published_types)
    if not RECLASS:
        write_guard("kept", "reclass off (COPYBOOK_TYPES_RECLASS unset)", published, None, [])
        return apply_overrides()
    filers_doc = read(DATA / "filers.json") or {"filers": []}
    curated = {m["cik"]: m for m in (read(DATA / "index.json") or {}).get("managers") or []}
    out: dict[str, dict] = {}
    counts: dict[str, int] = {}
    try:
        form_d = form_d_hedge()
    except Exception as exc:  # noqa: BLE001  (types still come from names and shapes)
        print(f"::warning::Form D data sets unavailable: {exc}")
        form_d = None
    try:
        index = adviser_index(load_advisers())
    except Exception as exc:  # noqa: BLE001  (without ADV no filer becomes a hedge fund except hand-checked ones)
        # Without ADV no filer but the hand-checked ones would be a hedge fund: keep the published types instead.
        print(f"::error::Form ADV data unavailable ({exc!r}); keeping the last published types")
        write_guard("held", f"Form ADV unavailable: {exc!r}"[:300], published, None, [])
        return apply_overrides()
    everyone = filers_doc["filers"] + [{"cik": c, "name": m.get("name") or m.get("manager")} for c, m in curated.items()]
    seen: dict[str, int] = {}
    for f in everyone:
        st = stem(f.get("name") or "")
        seen[st] = seen.get(st, 0) + 1
    common = {st for st, k in seen.items() if k > 2}
    for f in filers_doc["filers"] + [{"cik": c, "name": m.get("name") or m.get("manager")} for c, m in curated.items()]:
        cik = f["cik"]
        if cik in out:
            continue
        shard = read(DATA / "f" / f"{cik}.json")
        q = (shard or {}).get("quarter")
        book = read(DATA / "fb" / q / f"{cik}.json") if q else None
        prev = read(DATA / "fb" / prev_quarter(q) / f"{cik}.json") if q else None
        s = shape(book or shard, prev)
        adviser = adviser_for(cik, f.get("name") or "", index, common)
        kind, basis, evidence = classify(cik, f.get("name") or "", s, form_d, common, adviser,
                                         (published_types.get(cik) or {}).get("type"))
        row = {"type": kind, "basis": basis, "type_evidence": evidence, "display_name": display_name(f.get("name") or "")}
        if cik in ACTIVISTS:
            row["activist"] = True
        if s.get("aum"):
            row["aum"] = round(s["aum"])
        out[cik] = row
        counts[kind] = counts.get(kind, 0) + 1
    moved = type_drift(published, counts) if published else []
    if moved and not TYPES_ACCEPTED:
        print(f"::error::filer types: candidate counts moved more than {TYPES_MAX_MOVE:.0%} from the published set ("
              + "; ".join(f"{d['type']} {d['published']} -> {d['candidate']}" for d in moved)
              + "); keeping the published types. Dispatch with accept_types once the reclass is accepted.")
        write_guard("held", "type counts moved beyond the limit", published, counts, moved)
        return apply_overrides()
    write_guard("accepted" if moved else "published", "accepted reclass flag" if moved else "within the limit",
                published, counts, moved)
    from datetime import datetime, timezone
    as_of = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (DATA / "filer_types.json").write_text(json.dumps({
        "as_of": as_of, "types": list(TYPES), "smart_money": list(SMART),
        "note": "SEC data only: hand-checked cases, then name rules (banks, brokers, ETF issuers, ...), then SEC Form ADV "
                "(hedge_fund when Schedule D 7.B.1 hedge funds' gross assets are at least half of regulatory AUM or $1B "
                "and more; wealth or long_only by client type), then the latest 13F book's shape, which never makes a "
                "hedge fund on its own. type_evidence says which. smart_money = hedge_fund + long_only.",
        "filers": out}, separators=(",", ":")) + "\n")
    for f in filers_doc["filers"]:
        f["type"] = out.get(f["cik"], {}).get("type")
        f["display_name"] = display_name(f.get("name") or "")
    (DATA / "filers.json").write_text(json.dumps(filers_doc, separators=(",", ":")) + "\n")
    for p in (DATA / "f").glob("*.json"):
        shard = read(p)
        t, dn = out.get(p.stem, {}).get("type"), out.get(p.stem, {}).get("display_name")
        if shard is not None and (shard.get("type"), shard.get("display_name")) != (t, dn):
            shard["type"], shard["display_name"] = t, dn
            p.write_text(json.dumps(shard, separators=(",", ":")) + "\n")
    stamp_as_of(as_of)
    print("filer types: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
    return 0


def load() -> dict[str, dict]:
    return (read(DATA / "filer_types.json") or {}).get("filers") or {}


if __name__ == "__main__":
    raise SystemExit(main())
