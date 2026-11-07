"""Bootstrapped 13F managers. Featured CIKs plus curated universe when present."""

# cik, filing name, manager, slug
MANAGERS: list[tuple[str, str, str, str]] = [
    ("0001067983", "Berkshire Hathaway Inc", "Warren Buffett", "warren-buffett"),
    ("0001061768", "Baupost Group LLC", "Seth Klarman", "seth-klarman"),
    ("0001656456", "Appaloosa LP", "David Tepper", "david-tepper"),
    ("0001489933", "DME Capital Management LP", "David Einhorn", "david-einhorn"),
    ("0001040273", "Third Point LLC", "Dan Loeb", "dan-loeb"),
    ("0001350694", "Bridgewater Associates LP", "Ray Dalio", "ray-dalio"),
    (
        "0001336528",
        "Pershing Square Capital Management LP",
        "Bill Ackman",
        "bill-ackman",
    ),
    ("0001135730", "Coatue Management LLC", "Philippe Laffont", "philippe-laffont"),
    ("0001103804", "Viking Global Investors LP", "Andreas Halvorsen", "andreas-halvorsen"),
    ("0001167483", "Tiger Global Management LLC", "Chase Coleman", "chase-coleman"),
    ("0001747057", "D1 Capital Partners LP", "Dan Sundheim", "dan-sundheim"),
    ("0001061165", "Lone Pine Capital LLC", "Stephen Mandel", "stephen-mandel"),
    ("0001647251", "TCI Fund Management Ltd", "Chris Hohn", "chris-hohn"),
    ("0000921669", "Icahn Carl C", "Carl Icahn", "carl-icahn"),
    ("0001345471", "Trian Fund Management LP", "Nelson Peltz", "nelson-peltz"),
    ("0001418814", "ValueAct Holdings LP", "Mason Morfit", "mason-morfit"),
    ("0001358706", "Abrams Capital Management LP", "David Abrams", "david-abrams"),
    ("0000949509", "Oaktree Capital Management LP", "Howard Marks", "howard-marks"),
    ("0001709323", "Himalaya Capital Management LLC", "Li Lu", "li-lu"),
    ("0001135778", "Miller Value Partners LLC", "Bill Miller", "bill-miller"),
    ("0001376879", "AKO Capital LLP", "Nicolai Tangen", "nicolai-tangen"),
    ("0001641864", "Giverny Capital Inc", "Francois Rochon", "francois-rochon"),
    ("0001540866", "Makaira Partners LLC", "Thomas Bancroft", "thomas-bancroft"),
    ("0001039565", "Kahn Brothers Group Inc", "Irving Kahn", "irving-kahn"),
    (
        "0001454502",
        "Triple Frond Partners LLC",
        "Stuart McLaughlin",
        "stuart-mclaughlin",
    ),
    (
        "0001697868",
        "Valley Forge Capital Management LP",
        "Dev Kantesaria",
        "dev-kantesaria",
    ),
    ("0000947996", "Olstein Capital Management LP", "Robert Olstein", "robert-olstein"),
    (
        "0001325447",
        "First Eagle Investment Management LLC",
        "Matthew McLennan",
        "matthew-mclennan",
    ),
    ("0001377581", "First Pacific Advisors LP", "Steven Romick", "steven-romick"),
    ("0000936753", "Ariel Investments LLC", "John Rogers", "john-rogers"),
    ("0001569205", "Fundsmith LLP", "Terry Smith", "terry-smith"),
    (
        "0001279936",
        "Cantillon Capital Management LLC",
        "William von Mueffling",
        "william-von-mueffling",
    ),
    (
        "0000807985",
        "Southeastern Asset Management Inc",
        "Mason Hawkins",
        "mason-hawkins",
    ),
    ("0000813917", "Harris Associates LP", "Bill Nygren", "bill-nygren"),
    ("0000732905", "Tweedy Browne Company LLC", "Tweedy Browne", "tweedy-browne"),
    ("0001720792", "Ruane Cunniff & Goldfarb LP", "Ruane Cunniff", "ruane-cunniff"),
    (
        "0001404599",
        "Aquamarine Capital Management LLC",
        "Guy Spier",
        "guy-spier",
    ),
    (
        "0001766504",
        "Greenlea Lane Capital Management LLC",
        "Josh Tarasoff",
        "josh-tarasoff",
    ),
    (
        "0001027796",
        "Pzena Investment Management LLC",
        "Richard Pzena",
        "richard-pzena",
    ),
    ("0001166559", "Gates Foundation Trust", "Bill Gates", "bill-gates"),
    (
        "0001536411",
        "Duquesne Family Office LLC",
        "Stanley Druckenmiller",
        "stanley-druckenmiller",
    ),
]


def load_managers():
    """Featured 41 plus curated names from universe.json when built."""
    import json
    from pathlib import Path

    web = Path(__file__).resolve().parents[1] / "web" / "data" / "universe.json"
    if not web.exists():
        return list(MANAGERS)
    curated = json.loads(web.read_text()).get("curated") or []
    rows = []
    seen = set()
    for row in curated:
        cik = row["cik"]
        if cik in seen:
            continue
        seen.add(cik)
        rows.append((cik, row["name"], row["manager"], row["slug"]))
    for item in MANAGERS:
        if item[0] not in seen:
            rows.append(item)
    return rows
