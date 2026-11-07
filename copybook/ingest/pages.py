"""HTML rendering for the Copybook static site."""

from __future__ import annotations

from html import escape
from pathlib import Path

import os

WEB = Path(os.environ.get("COPYBOOK_WEB_DIR") or Path(__file__).resolve().parents[1] / "web")
MANAGERS_DIR = WEB / "managers"

NAV = [
    ("Holdings", "index.html#managers"),
    ("Copycat", "copycat.html"),
    ("Pricing", "pricing.html"),
    ("About", "about.html"),
]


def money(value: float) -> str:
    if value >= 1_000_000_000:
        return f"${value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"${value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"${value / 1_000:.0f}K"
    return f"${value:,.0f}"


def shares_fmt(value: float) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    return f"{value:,.0f}"


def pct(weight: float) -> str:
    return f"{weight * 100:.2f}%"


def page(title: str, body: str, path_depth: int = 0) -> str:
    prefix = "../" * path_depth
    nav = "".join(
        f'<a href="{prefix}{href}">{escape(label)}</a>' for label, href in NAV
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<meta name="description" content="Copybook tracks 13F holdings as filed for 41 superinvestors. Latest quarter free. Copycat book, no live prices.">
<link rel="stylesheet" href="{prefix}styles.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="{prefix}index.html">Copybook</a>
  <nav>{nav}</nav>
</header>
{body}
<footer class="site-footer">
  <p>Source: SEC EDGAR 13F-HR, as filed. Values are quarter-end and ~45 days late. Not investment advice.</p>
  <p>A Factor Dynamics product. No Yahoo prices. No Dataroma scrape. Holdings only.</p>
</footer>
</body>
</html>
"""


def holdings_table(holdings: list[dict], limit: int | None = None, show_holders: bool = False) -> str:
    rows = holdings if limit is None else holdings[:limit]
    extra_head = "<th>Held by</th>" if show_holders else ""
    body = []
    for h in rows:
        ticker = h.get("ticker") or "—"
        put = h.get("put_call")
        flag = f' <span class="pill">{escape(put)}</span>' if put else ""
        holders = ""
        if show_holders:
            names = h.get("held_by_names") or []
            holders = f"<td>{escape(', '.join(names[:6]))}{'…' if len(names) > 6 else ''}</td>"
        weight = h.get("weight") or 0.0
        value = h.get("value", h.get("total_value", 0.0))
        shares = h.get("shares", h.get("total_shares", 0.0))
        body.append(
            "<tr>"
            f"<td class='ticker'>{escape(ticker)}{flag}</td>"
            f"<td>{escape(h.get('issuer') or '')}</td>"
            f"<td class='mono'>{escape(h.get('cusip') or '')}</td>"
            f"<td class='num'>{shares_fmt(shares)}</td>"
            f"<td class='num'>{money(value)}</td>"
            f"<td class='num'>{pct(weight)}</td>"
            f"{holders}"
            "</tr>"
        )
    return (
        '<div class="table-wrap"><table>'
        "<thead><tr><th>Ticker</th><th>Issuer</th><th>CUSIP</th>"
        f"<th>Shares</th><th>Value as filed</th><th>Weight</th>{extra_head}</tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table></div>"
    )


def render_index(payload: dict) -> str:
    ok = [m for m in payload["managers"] if m.get("ok")]
    copycat = payload["copycat"]["holdings"][:20]
    cards = []
    for m in sorted(ok, key=lambda x: x["manager"]):
        cards.append(
            f'<a class="card" href="managers/{escape(m["slug"])}.html">'
            f"<h3>{escape(m['manager'])}</h3>"
            f'<p class="muted">{escape(m["name"])}</p>'
            f'<p class="stat">{money(m["total_value"])} · {m["position_count"]} names · {escape(m["quarter"])}</p>'
            "</a>"
        )
    missing = [m for m in payload["managers"] if not m.get("ok")]
    missing_html = ""
    if missing:
        items = "".join(
            f"<li>{escape(m['manager'])} — {escape(m.get('error') or 'unavailable')}</li>"
            for m in missing
        )
        missing_html = (
            "<section class='narrow'><h2>Not on this refresh</h2>"
            f"<ul class='muted'>{items}</ul></section>"
        )
    return page(
        "Copybook — 13F holdings as filed",
        f"""<main>
<section class="hero">
  <p class="eyebrow">Dataroma with a copycat book</p>
  <h1>What the 41 actually filed.</h1>
  <p class="lede">Latest-quarter 13F holdings for a curated book of superinvestors. Values come from the filing, not a price feed. History, CSV, and filing alerts are on Copy — waitlist open.</p>
  <p class="meta">As of {escape(payload['generated_at'])} · {payload['filed_count']} of {payload['manager_count']} managers · source SEC EDGAR</p>
  <p class="cta-row">
    <a class="btn" href="copycat.html">Open the copycat book</a>
    <a class="btn ghost" href="pricing.html">Copy $9/mo — coming soon</a>
  </p>
</section>
<section>
  <div class="section-head">
    <h2>Copycat book, top 20</h2>
    <p class="muted">Value-weighted across managers using as-filed 13F values. No live marks.</p>
  </div>
  {holdings_table(copycat, show_holders=True)}
  <p><a href="copycat.html">Full copycat book →</a></p>
</section>
<section id="managers">
  <div class="section-head">
    <h2>Managers</h2>
    <p class="muted">Free: latest quarter only. Click through for the full as-filed table.</p>
  </div>
  <div class="grid">{''.join(cards)}</div>
</section>
{missing_html}
</main>""",
    )


def render_copycat(payload: dict) -> str:
    c = payload["copycat"]
    top = c["holdings"][:50]
    conviction = sorted(
        c["holdings"], key=lambda h: (-h["num_investors"], -h["total_value"])
    )[:20]
    return page(
        "Copycat book — Copybook",
        f"""<main>
<section class="hero">
  <p class="eyebrow">Copycat</p>
  <h1>One book from {c['num_investors']} filings.</h1>
  <p class="lede">Each position is the sum of as-filed 13F values across the bootstrapped managers. Weight is that sum over the grand total. Conviction is how many of them hold it.</p>
  <p class="meta">{money(c['total_value'])} as-filed · {c['num_positions']} names · {c['num_investors']} managers</p>
</section>
<section>
  <h2>Largest positions</h2>
  {holdings_table(top, show_holders=True)}
</section>
<section>
  <h2>Highest conviction</h2>
  <p class="muted">Sorted by number of managers holding, then as-filed value.</p>
  {holdings_table(conviction, show_holders=True)}
</section>
<section class="note">
  <h2>Research footnote, not a track record</h2>
  <p>An in-sample value-weight backtest on this universe, 2016Q1–2025Q3, printed +17.06% annualized vs SPY +11.18%, Sharpe 0.89, max drawdown 35.8%. It used Yahoo bars, is not live AUM, and is not this product. Copybook does not show live P&amp;L or prices.</p>
</section>
</main>""",
    )


def render_manager(m: dict) -> str:
    if not m.get("ok"):
        body = (
            f"<main><section class=\"hero\"><h1>{escape(m['manager'])}</h1>"
            f"<p class=\"lede\">{escape(m.get('error') or 'Filing not available on this refresh.')}</p>"
            f"<p class=\"muted\">CIK {escape(m['cik'])} · {escape(m['name'])}</p></section></main>"
        )
        return page(f"{m['manager']} — Copybook", body, path_depth=1)
    top_note = ""
    if m["holdings"]:
        top = m["holdings"][0]
        label = top.get("ticker") or top["issuer"]
        top_note = f"Largest line: {label} at {pct(top['weight'])} of as-filed value."
    return page(
        f"{m['manager']} — Copybook",
        f"""<main>
<section class="hero">
  <p class="eyebrow">{escape(m['name'])}</p>
  <h1>{escape(m['manager'])}</h1>
  <p class="lede">{escape(m['quarter'])} 13F-HR filed {escape(m['filing_date'])} for period {escape(m['report_date'])}. {m['position_count']} positions, {money(m['total_value'])} as filed. {escape(top_note)}</p>
  <p class="meta">CIK {escape(m['cik'])} · {escape(m['form'])} · <a href="{escape(m['sec_url'])}">SEC filing</a></p>
</section>
<section>
  <h2>Holdings as filed</h2>
  {holdings_table(m['holdings'])}
</section>
</main>""",
        path_depth=1,
    )


def render_pricing() -> str:
    return page(
        "Pricing — Copybook",
        """<main>
<section class="hero">
  <p class="eyebrow">Pricing</p>
  <h1>Latest quarter is free. History is Copy.</h1>
  <p class="lede">Built for people who refresh a 13F site in the two weeks after the deadline. Q3 2026 filings are due ~14 Nov 2026.</p>
</section>
<section class="plans">
  <article class="plan">
    <h2>Free</h2>
    <p class="price">$0</p>
    <ul>
      <li>Latest quarter for the 41 named managers</li>
      <li>Copycat book, top 20</li>
      <li>No CSV</li>
    </ul>
    <p class="muted">Live now.</p>
  </article>
  <article class="plan featured">
    <h2>Copy</h2>
    <p class="price">$9/mo or $79/yr</p>
    <ul>
      <li>Full history</li>
      <li>Conviction filter and copycat weights</li>
      <li>CSV export</li>
      <li>Email when a tracked 13F hits EDGAR</li>
    </ul>
    <p><strong>Coming soon.</strong> Stripe is not wired yet. Join the waitlist.</p>
  </article>
  <article class="plan">
    <h2>Desk</h2>
    <p class="price">$29/mo</p>
    <ul>
      <li>Slack / webhook</li>
      <li>More managers, still curated</li>
      <li>Overlap vs a pasted ticker list</li>
    </ul>
    <p class="muted">After Copy.</p>
  </article>
</section>
<section class="waitlist">
  <h2>Waitlist</h2>
  <p>Email <a href="mailto:copybook@factordynamics.com?subject=Copybook%20waitlist">copybook@factordynamics.com</a> with the address you want alerts on. Paid signup will open here once Stripe keys exist. Do not send payment details.</p>
</section>
</main>""",
    )


def render_about() -> str:
    return page(
        "About — Copybook",
        """<main>
<section class="hero">
  <p class="eyebrow">About</p>
  <h1>Holdings as filed. Nothing else.</h1>
</section>
<section class="prose">
  <p>Copybook is a consumer 13F site from Factor Dynamics. It reads each manager's latest 13F-HR information table from SEC EDGAR and shows issuer, CUSIP, shares, and the filer-reported value.</p>
  <h2>What you are looking at</h2>
  <ul>
    <li>Public 13F-HR filings, as filed. Fair-access User-Agent, under 10 requests/second.</li>
    <li>CUSIP to ticker from a static map when we have one. Missing tickers show as a dash, not a guessed price.</li>
    <li>Split 13F lines (same CUSIP, several other-manager rows) are summed.</li>
    <li>The copycat book is the value-weighted sum of those as-filed books. It is not a fund.</li>
  </ul>
  <h2>What we do not show</h2>
  <ul>
    <li>Live quotes, sparklines, or “up 2% this week.”</li>
    <li>Yahoo or any unlicensed price data.</li>
    <li>Form 4 or 13D. Those parsers are empty; this launch is holdings-only.</li>
    <li>Dataroma HTML. Managers are the 41 hard-coded CIKs.</li>
  </ul>
  <h2>Lag and holes</h2>
  <p>13F is due 45 days after quarter-end. It omits shorts, many options, and advisers under $100M AUM. Values are the filer's quarter-end marks, not today's market.</p>
  <p>Not investment advice. Factor Dynamics is not a registered investment adviser. Past research results are not a live track record.</p>
</section>
</main>""",
    )


def write_site(payload: dict) -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    MANAGERS_DIR.mkdir(parents=True, exist_ok=True)
    (WEB / "index.html").write_text(render_index(payload))
    (WEB / "copycat.html").write_text(render_copycat(payload))
    (WEB / "pricing.html").write_text(render_pricing())
    (WEB / "about.html").write_text(render_about())
    (WEB / "404.html").write_text(
        page(
            "Not found — Copybook",
            "<main><section class='hero'><h1>Missing page.</h1><p><a href='index.html'>Back to Copybook</a></p></section></main>",
        )
    )
    for m in payload["managers"]:
        (MANAGERS_DIR / f"{m['slug']}.html").write_text(render_manager(m))
    (WEB / ".nojekyll").write_text("")
    (WEB / "robots.txt").write_text("User-agent: *\nAllow: /\n")
