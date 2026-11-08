#!/usr/bin/env python3
"""Build curated + full 13F filer directories from SEC master indexes."""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ingest.managers import MANAGERS, clean_name

NEEDLES = {
    x.strip().lower()
    for x in """
berkshire hathaway, baupost, appaloosa, greenlight, third point, bridgewater,
pershing square, coatue, viking global, tiger global, d1 capital, lone pine,
tci fund, icahn, trian fund, valueact, abrams capital, oaktree, himalaya,
miller value, ako capital, giverny, makaira, kahn brothers, triple frond,
valley forge, olstein, first eagle, first pacific, ariel investments,
fundsmith, cantillon, southeastern asset, harris associates, tweedy browne,
ruane, aquamarine, greenlea, pzena, gates foundation, duquesne,
renaissance technologies, citadel advisors, millennium management, two sigma,
point72, elliott investment, soros fund, paulson, starboard value,
jana partners, scion asset, sachem head, corvex, inclusive capital,
maverick capital, egerton, lansdowne, matrix capital, light street,
alden global, gqg partners, clearbridge, fisher asset, van eck, vaneck,
cohen & steers, wellington management, capital research, fmr llc, fidelity,
t. rowe, t rowe, invesco, blackrock, vanguard group, state street,
goldman sachs, morgan stanley, jpmorgan, jp morgan, norges bank,
geode capital, northern trust, legal & general, schroders, yacktman,
davis selected, dodge & cox, primecap, baillie gifford, lindsell train,
marshall wace, brevan howard, aqr capital, grantham mayo, farallon,
king street, apollo management, kkr, carlyle, blackstone, brookfield,
third avenue, gamco, gabelli, davidson kempner, highfields, engine no,
caxton, tudor investment, moore capital, man group, capula, winton,
pdt partners, cubist, adage capital, arrowstreet, acadian asset,
dimensional fund, hotchkis, boston partners, discovery capital,
silver lake, vista equity, thoma bravo, owl creek, templar,
canada pension, ontario teachers, calpers, calstrs, harvard management,
yale university, stanford, mit investment, wellcome, temasek, gic private,
qatar investment, kuwait investment, future fund, church commissioners,
new york state common, florida state board, wisconsin investment,
alaska permanent, university of california, university of texas,
duke university, princeton, nomura, mizuho, sumitomo, amundi, ubs asset,
barclays, hsbc, deutsche, bnp paribas, axa, metlife, prudential,
pimco, allianz, franklin, gqg, dme capital, bill & melinda
""".replace("\n", " ").split(",")
    if len(x.strip()) >= 4
}


def parse_index(path: Path) -> dict[str, dict]:
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    start = 0
    for i, line in enumerate(lines):
        if line.startswith("Form Type"):
            start = i + 2
            break
    out: dict[str, dict] = {}
    for line in lines[start:]:
        form = line[:12].strip()
        if form not in {"13F-HR", "13F-HR/A"}:
            continue
        name = clean_name(line[12:74])
        rest = line[74:].split()
        if len(rest) < 3:
            continue
        file_name = rest[-1]
        cik = ""
        if "/data/" in file_name:
            part = file_name.split("/data/")[1].split("/")[0]
            if part.isdigit():
                cik = part.zfill(10)
        if not cik:
            maybe = rest[0]
            if maybe.isdigit():
                cik = maybe.zfill(10)
            else:
                continue
        date = rest[-2] if len(rest) >= 2 else rest[1]
        if len(date) != 10 or date[4] != "-":
            continue
        rec = {"cik": cik, "name": name, "filing_date": date, "form": form}
        prev = out.get(cik)
        if prev is None or date > prev["filing_date"] or (
            date == prev["filing_date"] and form == "13F-HR"
        ):
            out[cik] = rec
    return out


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s[:60] or "filer"


def build(q2: Path, q3: Path, web_data: Path) -> dict:
    allu = parse_index(q2)
    for cik, rec in parse_index(q3).items():
        if cik not in allu or rec["filing_date"] >= allu[cik]["filing_date"]:
            allu[cik] = rec

    matched: dict[str, dict] = {}
    for cik, rec in allu.items():
        n = rec["name"].lower()
        if any(nd in n for nd in NEEDLES):
            matched[cik] = rec
    have = {cik for cik, _, _, _ in MANAGERS}
    slug_map = {cik: sl for cik, _, _, sl in MANAGERS}
    name_map = {cik: (nm, mgr) for cik, nm, mgr, _ in MANAGERS}
    for cik, nm, mgr, sl in MANAGERS:
        matched.setdefault(cik, {"cik": cik, "name": nm, "filing_date": "", "form": "13F-HR"})

    curated = []
    seen: set[str] = set()
    for cik, rec in sorted(matched.items(), key=lambda x: x[1]["name"].lower()):
        sl = slug_map.get(cik) or slugify(rec["name"])
        base = sl
        i = 2
        while sl in seen:
            sl = f"{base}-{i}"
            i += 1
        seen.add(sl)
        nm, mgr = name_map.get(cik, (rec["name"], rec["name"]))
        curated.append(
            {
                "cik": cik,
                "name": nm,
                "manager": mgr,
                "slug": sl,
                "featured": cik in have,
                "filing_date": rec.get("filing_date") or "",
            }
        )

    filers = []
    seen_f: set[str] = set()
    for rec in sorted(allu.values(), key=lambda x: x["name"].lower()):
        sl = slugify(rec["name"]) + "-" + rec["cik"][-4:]
        if sl in seen_f:
            sl = sl + rec["cik"][-2:]
        seen_f.add(sl)
        filers.append(
            {
                "cik": rec["cik"],
                "name": rec["name"],
                "filing_date": rec["filing_date"],
                "form": rec["form"],
                "slug": sl,
            }
        )

    web_data.mkdir(parents=True, exist_ok=True)
    (web_data / "universe.json").write_text(
        json.dumps(
            {
                "source": "SEC EDGAR 13F-HR master index",
                "quarters": ["2026Q2", "2026Q3"],
                "curated_count": len(curated),
                "filer_count": len(filers),
                "featured_count": sum(1 for x in curated if x["featured"]),
                "curated": curated,
            },
            indent=2,
        )
        + "\n"
    )
    (web_data / "filers.json").write_text(
        json.dumps(
            {
                "source": "SEC EDGAR 13F-HR master index, 2026Q2–Q3",
                "count": len(filers),
                "filers": [
                    {
                        "cik": f["cik"],
                        "name": f["name"],
                        "slug": f["slug"],
                        "filing_date": f["filing_date"],
                    }
                    for f in filers
                ],
            }
        )
        + "\n"
    )
    return {"curated": curated, "filers": filers}


if __name__ == "__main__":
    data = build(Path("/tmp/form-q2.idx"), Path("/tmp/form.idx"), ROOT / "web" / "data")
    print(f"curated {len(data['curated'])} filers {len(data['filers'])}")
