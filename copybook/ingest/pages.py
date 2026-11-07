"""HTML rendering for the Copybook static site."""

from __future__ import annotations

from datetime import datetime
from html import escape
from pathlib import Path

import os

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or Path(__file__).resolve().parents[1] / "web")
MANAGERS_DIR = WEB / "managers"

NAV = [
    ("Managers", "index.html"),
    ("Copycat", "copycat.html"),
    ("Pricing", "pricing.html"),
    ("About", "about.html"),
]
FEATURED = [
    "warren-buffett",
    "bill-ackman",
    "ray-dalio",
    "stanley-druckenmiller",
    "carl-icahn",
]


def money(value: float) -> str:
    if value >= 1_000_000_000:
        return f"${value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"${value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"${value / 1_000:.0f}K"
    return f"${value:,.0f}"


def pct(weight: float) -> str:
    return f"{weight * 100:.2f}%"


def nice_date(iso: str) -> str:
    if not iso:
        return "—"
    try:
        dt = datetime.strptime(iso[:10], "%Y-%m-%d")
        return f"{dt.day} {dt.strftime('%b %Y')}"
    except ValueError:
        return iso[:10]


def waitlist_form(id_suffix: str = "") -> str:
    return f"""<form data-waitlist class="waitlist-form">
  <label class="sr" for="email{id_suffix}">Email</label>
  <input id="email{id_suffix}" type="email" name="email" required placeholder="you@example.com" autocomplete="email">
  <button class="btn" type="submit">Join the waitlist</button>
</form>
<p class="faint">We’ll email you when Copy opens.</p>"""


def page(title: str, body: str, path_depth: int = 0, current: str = "") -> str:
    prefix = "../" * path_depth
    parts = []
    for label, href in NAV:
        cur = ' aria-current="page"' if label == current else ""
        parts.append(f'<a href="{prefix}{href}"{cur}>{escape(label)}</a>')
    nav = "".join(parts)
    data_prefix = f"{prefix}data/index.json"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<meta name="description" content="Copybook — latest 13F holdings as filed for 41 superinvestors. Copycat book, no live prices.">
<meta name="theme-color" content="#0b0d10">
<link rel="icon" href="{prefix}favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{prefix}styles.css">
</head>
<body data-base="{prefix}">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="{prefix}index.html"><span class="mark">C</span> Copybook</a>
    <nav class="nav" id="nav">{nav}</nav>
    <div class="search-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3"/></svg>
      <label class="sr" for="global-search">Search managers</label>
      <input id="global-search" type="search" placeholder="Search" autocomplete="off">
      <div id="search-results" class="search-results"></div>
    </div>
    <button class="menu-btn" type="button" aria-label="Menu">Menu</button>
    <a class="top-cta" href="{prefix}pricing.html">Get Copy</a>
  </div>
</header>
{body}
<footer class="site-footer">
  <div class="inner">
    <div>
      <p>Source: SEC EDGAR 13F-HR, as filed. Values are quarter-end and about 45 days late. Not investment advice.</p>
      <p>Factor Dynamics · Holdings only · No Yahoo prices</p>
    </div>
    <div>
      <a href="{prefix}about.html">About</a> ·
      <a href="{prefix}pricing.html">Pricing</a> ·
      <a href="{prefix}pricing.html">Waitlist</a>
    </div>
  </div>
</footer>
<script src="{prefix}app.js" defer></script>
</body>
</html>
"""


def render_index(payload: dict) -> str:
    ok = [m for m in payload["managers"] if m.get("ok")]
    featured = [next((m for m in ok if m["slug"] == s), None) for s in FEATURED]
    featured = [m for m in featured if m]
    updated = nice_date(payload.get("generated_at", ""))
    copycat_n = payload["copycat"].get("num_positions") or len(payload.get("copycat_top") or [])
    return page(
        "Copybook — 13F holdings as filed",
        f"""<main id="main">
<section class="hero">
  <div>
    <p class="faint">13F holdings, as filed</p>
    <h1>What 41 superinvestors actually filed.</h1>
    <p class="lede">Latest-quarter 13F holdings from SEC EDGAR. Values come from the filing, not a price feed.</p>
    <p class="meta">Updated {escape(updated)} · {payload['filed_count']} of {payload['manager_count']} managers · source SEC EDGAR</p>
    <p class="cta-row">
      <a class="btn" href="copycat.html">Open copycat</a>
      <a class="btn ghost" href="pricing.html">Join the waitlist</a>
    </p>
  </div>
  <div class="stats">
    <div class="stat"><b>{payload['filed_count']}</b><span>Managers with a filing</span></div>
    <div class="stat"><b>{money(payload['copycat']['total_value'])}</b><span>Copycat book, as filed</span></div>
    <div class="stat"><b>{copycat_n:,}</b><span>Names in the book</span></div>
    <div class="stat"><b>Free</b><span>Latest quarter</span></div>
  </div>
</section>
<section>
  <div class="section-head">
    <div>
      <h2>Copycat, top 20</h2>
      <p class="muted">Value-weighted across managers using as-filed 13F values. Conviction is how many of them hold it.</p>
    </div>
    <a href="copycat.html">Full book</a>
  </div>
  <p class="faint">GOOGL and GOOG stay separate because they are separate 13F lines (Class A / Class C).</p>
  <div id="home-copycat"></div>
</section>
<section id="managers">
  <div class="section-head">
    <div>
      <h2>Managers</h2>
      <p class="muted">Free: latest quarter. Featured names first. Late filings are marked.</p>
    </div>
  </div>
  <div class="toolbar">
    <label class="sr" for="manager-search">Filter managers</label>
    <input id="manager-search" type="search" placeholder="Filter by name or firm">
    <select id="manager-sort" aria-label="Sort managers">
      <option value="aum">Sort by as-filed value</option>
      <option value="name">Sort by name</option>
    </select>
  </div>
  <div id="featured-grid" class="grid"></div>
  <div id="manager-grid" class="grid" style="margin-top:10px"></div>
</section>
</main>""",
        current="Managers",
    )


def render_copycat(payload: dict) -> str:
    c = payload["copycat"]
    return page(
        "Copycat book — Copybook",
        f"""<main id="main">
<p class="crumb"><a href="index.html">Managers</a> / Copycat</p>
<section class="hero" style="grid-template-columns:1fr">
  <div>
    <p class="faint">Copycat</p>
    <h1>One book from {c['num_investors']} filings.</h1>
    <p class="lede">Each position is the sum of as-filed 13F values. Weight is that sum over the grand total. Conviction is the number of managers who hold it. Search works on ticker, issuer, and manager name.</p>
    <p class="meta">{money(c['total_value'])} as-filed · {c['num_positions']:,} names · {c['num_investors']} managers</p>
  </div>
</section>
<section id="copycat-app">
  <div class="toolbar">
    <label class="sr" for="copycat-search">This table</label>
    <input id="copycat-search" type="search" placeholder="This table: ticker, issuer, manager">
    <span id="copycat-meta" class="faint"></span>
  </div>
  <div id="copycat-table"></div>
  <p style="margin-top:12px"><button class="btn ghost" id="copycat-more" type="button">Show more</button></p>
</section>
<section class="note">
  <h2>Research footnote, not a track record</h2>
  <p>An in-sample value-weight backtest on this universe, 2016Q1–2025Q3, printed +17.06% annualized vs SPY +11.18%. It used Yahoo bars, is not live AUM, and is not this product. Copybook does not show live P&amp;L or prices.</p>
</section>
</main>""",
        current="Copycat",
    )


def render_manager(m: dict, neighbors: list[dict] | None = None) -> str:
    if not m.get("ok"):
        body = f"""<main id="main"><p class="crumb"><a href="../index.html">Managers</a> / {escape(m['manager'])}</p>
<section class="hero" style="grid-template-columns:1fr"><div>
<h1>{escape(m['manager'])}</h1>
<p class="lede">{escape(m.get('error') or 'Filing not available on this refresh.')}</p>
<p class="muted">CIK {escape(m['cik'])} · {escape(m['name'])}</p>
</div></section></main>"""
        return page(f"{m['manager']} — Copybook", body, path_depth=1, current="Managers")
    stale = not str(m.get("quarter", "")).startswith("2026")
    badge = (
        f'<span class="pill" style="background:rgba(245,193,90,.12);color:var(--warn)">Last filing {escape(m["quarter"])}</span>'
        if stale
        else ""
    )
    top_note = ""
    if m.get("holdings"):
        top = m["holdings"][0]
        label = top.get("ticker") or top["issuer"]
        top_note = f"Largest line: {label} at {pct(top['weight'])} of as-filed value."
    nav_html = ""
    if neighbors:
        slugs = [n["slug"] for n in neighbors if n.get("ok")]
        if m["slug"] in slugs:
            i = slugs.index(m["slug"])
            prev_m = neighbors[i - 1] if i > 0 else None
            next_m = neighbors[i + 1] if i + 1 < len(neighbors) else None
            parts = []
            if prev_m:
                parts.append(f'<a href="{escape(prev_m["slug"])}.html">← {escape(prev_m["manager"])}</a>')
            if next_m:
                parts.append(f'<a href="{escape(next_m["slug"])}.html">{escape(next_m["manager"])} →</a>')
            if parts:
                nav_html = f'<p class="cta-row" style="margin-top:24px">{"".join(f"<span>{p}</span>" for p in parts)}</p>'
    return page(
        f"{m['manager']} — Copybook",
        f"""<main id="main">
<p class="crumb"><a href="../index.html">Managers</a> / {escape(m['manager'])}</p>
<section class="hero">
  <div>
    <p class="faint">{escape(m['name'])} {badge}</p>
    <h1>{escape(m['manager'])}</h1>
    <p class="lede">{escape(m['quarter'])} 13F-HR filed {escape(nice_date(m['filing_date']))} for period {escape(m['report_date'])}. {m['position_count']} positions, {money(m['total_value'])} as filed. {escape(top_note)}</p>
    <p class="meta">CIK {escape(m['cik'])} · {escape(m['form'])} · <a href="{escape(m['sec_url'])}">SEC filing</a></p>
    <div class="quarters" role="tablist" aria-label="Filing quarter">
      <span class="qtab locked" title="Copy unlocks history">🔒 2026Q1</span>
      <span class="qtab on">{escape(m['quarter'])}</span>
      <span class="qtab locked" title="Copy unlocks history">🔒 2026Q3</span>
    </div>
  </div>
</section>
<section id="holdings-app" data-slug="{escape(m['slug'])}">
  <div class="toolbar">
    <label class="sr" for="holdings-search">This table</label>
    <input id="holdings-search" type="search" placeholder="Ticker or issuer">
  </div>
  <div id="holdings-table"></div>
</section>
{nav_html}
</main>""",
        path_depth=1,
        current="Managers",
    )


def render_pricing() -> str:
    return page(
        "Pricing — Copybook",
        f"""<main id="main">
<section class="hero" style="grid-template-columns:1fr">
  <div>
    <p class="faint">Pricing</p>
    <h1>Latest quarter is free. History is Copy.</h1>
    <p class="lede">Built for people who refresh a 13F site in the two weeks after the deadline.</p>
    {waitlist_form("-top")}
  </div>
</section>
<section class="plans">
  <article class="plan">
    <h2>Free</h2>
    <p class="price">$0</p>
    <ul>
      <li>Latest quarter for the 41 named managers</li>
      <li>Copycat book with search</li>
      <li>No CSV</li>
    </ul>
    <p class="muted">Live now.</p>
  </article>
  <article class="plan featured">
    <h2>Copy</h2>
    <p class="price">$9/mo or $79/yr</p>
    <ul>
      <li>Full history</li>
      <li>CSV export</li>
      <li>Email when a tracked 13F hits EDGAR</li>
    </ul>
    <p class="muted">History, CSV, and filing email when Copy opens.</p>
  </article>
</section>
</main>""",
        current="Pricing",
    )


def render_about() -> str:
    return page(
        "About — Copybook",
        """<main id="main">
<section class="hero" style="grid-template-columns:1fr">
  <div>
    <p class="faint">About</p>
    <h1>Holdings as filed. Nothing else.</h1>
  </div>
</section>
<section class="prose">
  <p>Copybook is a consumer 13F site from <a href="https://www.factordynamics.com">Factor Dynamics</a>. It reads each manager’s latest 13F-HR information table from SEC EDGAR and shows issuer, CUSIP, shares, and the filer-reported value.</p>
  <div class="about-split">
  <div>
  <h2>What you are looking at</h2>
  <ul>
    <li>Public 13F-HR filings, as filed. Fair-access User-Agent, under 10 requests/second.</li>
    <li>CUSIP to ticker from a static map when we have one. Missing tickers show as a dash, not a guessed price.</li>
    <li>Split 13F lines (same CUSIP, several other-manager rows) are summed.</li>
    <li>The copycat book is the value-weighted sum of those as-filed books. It is not a fund.</li>
    <li>GOOGL and GOOG stay two rows because they are two 13F share classes.</li>
  </ul>
  </div>
  <div>
  <h2>What we do not show</h2>
  <ul>
    <li>Live quotes, sparklines, or “up 2% this week.”</li>
    <li>Yahoo or any unlicensed price data.</li>
    <li>Form 4 or 13D. Those parsers are empty; this launch is holdings-only.</li>
    <li>Dataroma HTML. Managers are the 41 hard-coded CIKs.</li>
  </ul>
  </div></div>
  <h2>Lag and holes</h2>
  <p>13F is due 45 days after quarter-end. It omits shorts, many options, and advisers under $100M AUM. Values are the filer’s quarter-end marks, not today’s market.</p>
  <p>Not investment advice. Factor Dynamics is not a registered investment adviser. Past research results are not a live track record.</p>
</section>
</main>""",
        current="About",
    )


def write_site(payload: dict) -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    MANAGERS_DIR.mkdir(parents=True, exist_ok=True)
    ok = [m for m in payload["managers"] if m.get("ok")]
    ok_sorted = sorted(ok, key=lambda m: -(m.get("total_value") or 0))
    (WEB / "index.html").write_text(render_index(payload))
    (WEB / "copycat.html").write_text(render_copycat(payload))
    (WEB / "pricing.html").write_text(render_pricing())
    (WEB / "about.html").write_text(render_about())
    (WEB / "404.html").write_text(
        page(
            "Not found — Copybook",
            "<main id='main'><section class='hero' style='grid-template-columns:1fr'><div><h1>Missing page.</h1><p><a href='index.html'>Back to Copybook</a></p></div></section></main>",
        )
    )
    for m in payload["managers"]:
        (MANAGERS_DIR / f"{m['slug']}.html").write_text(render_manager(m, ok_sorted))
    (WEB / ".nojekyll").write_text("")
    (WEB / "robots.txt").write_text("User-agent: *\nAllow: /\n")
