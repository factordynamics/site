"""Detect new 13F filings and optionally email the Copy waitlist."""

from __future__ import annotations

import json
import os
import smtplib
from datetime import date
from email.message import EmailMessage
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


MAX_AGE_DAYS = 7  # an alert for a filing older than this is never "new"


def previous_periods(data_dir: Path) -> dict[str, str]:
    """Latest report period already recorded per slug (alerted or not).

    alerts.json `periods` is the source of truth; index.json fills in funds that
    predate it. Periods only move forward, so a fund falling back to an older
    filing and then returning never re-alerts.
    """
    out: dict[str, str] = {}
    for name, key in (("index.json", "managers"),):
        path = data_dir / name
        if path.exists():
            try:
                for m in json.loads(path.read_text()).get(key) or []:
                    if m.get("slug") and m.get("report_date"):
                        out[m["slug"]] = m["report_date"]
            except json.JSONDecodeError:
                pass
    path = data_dir / "alerts.json"
    if path.exists():
        try:
            for slug, period in (json.loads(path.read_text()).get("periods") or {}).items():
                out[slug] = max(out.get(slug, ""), period)
        except json.JSONDecodeError:
            pass
    return out


def age_days(filing_date: str, now: str) -> int:
    return (date.fromisoformat(now[:10]) - date.fromisoformat(filing_date[:10])).days


def is_alertable(m: dict, previous: dict[str, str], now: str) -> bool:
    """A genuinely new 13F-HR for a period this fund has never reported before.

    Amendments, restatements, accession changes on an old period, 13F-NT
    notices, first sightings of a fund, and anything filed more than
    MAX_AGE_DAYS ago never alert.
    """
    prev = previous.get(m.get("slug") or "")
    period = m.get("report_date") or ""
    return bool(
        m.get("ok")
        and prev
        and period > prev
        and m.get("form") == "13F-HR"
        and m.get("filing_date")
        and 0 <= age_days(m["filing_date"], now) <= MAX_AGE_DAYS
    )


def new_filings(managers: list[dict], previous: dict[str, str], now: str) -> list[dict]:
    found = []
    for m in managers:
        if not is_alertable(m, previous, now):
            continue
        found.append(
            {
                "slug": m["slug"],
                "manager": m.get("manager"),
                "name": m.get("name"),
                "quarter": m.get("quarter"),
                "filing_date": m.get("filing_date"),
                "report_date": m.get("report_date"),
                "previous_report_date": previous.get(m["slug"]),
                "form": m.get("form"),
                "accession": m.get("accession"),
                "sec_url": m.get("sec_url"),
                "reported_by": m.get("reported_by"),
            }
        )
    return found


def next_periods(managers: list[dict], previous: dict[str, str]) -> dict[str, str]:
    out = dict(previous)
    for m in managers:
        if m.get("ok") and m.get("slug") and m.get("report_date"):
            out[m["slug"]] = max(out.get(m["slug"], ""), m["report_date"])
    return dict(sorted(out.items()))


def _usd(v: float) -> str:
    a = abs(v)
    s = f"${a / 1e9:.1f}B" if a >= 1e9 else f"${a / 1e6:.1f}M" if a >= 1e6 else f"${a / 1e3:.0f}K"
    return ("-" if v < 0 else "+") + s


def move_lines(mv: dict | None) -> list[str]:
    """'New: DHI +$1.2B (0.4% of book)' style lines from a filing's `moves`."""
    if not mv:
        return []
    out = []
    for label, key in (("New", "new"), ("Added", "added"), ("Trimmed", "trimmed"), ("Exited", "exited")):
        rows = mv.get(key) or []
        if not rows:
            continue
        parts = []
        for r in rows[:5]:
            name = r.get("ticker") or r.get("display_name") or r.get("issuer") or r.get("cusip")
            if r.get("put_call"):
                name = f"{name} {r['put_call'].lower()}s"
            pct = r.get("pct_of_book")
            parts.append(f"{name} {_usd(r['value_delta'])}" + (f" ({abs(pct) * 100:.1f}% of book)" if pct else ""))
        out.append(f"{label}: " + ", ".join(parts))
    return out


def email_body(filings: list[dict], generated_at: str) -> tuple[str, str]:
    subject = f"Copybook: {len(filings)} new 13F filing" + (
        "s" if len(filings) != 1 else ""
    )
    lines = [
        f"Copybook filing ping — {generated_at}",
        "Source: SEC EDGAR 13F-HR, as filed. Not investment advice.",
        "",
    ]
    for f in filings:
        lines.append(
            f"- {f['manager']} ({f['name']}) {f['quarter']} filed {f['filing_date']}"
        )
        for line in move_lines(f.get("moves")):
            lines.append(f"  {line}")
        if f.get("sec_url"):
            lines.append(f"  {f['sec_url']}")
    lines.append("")
    lines.append("History, CSV, and this alert are Copy ($9/mo or $79/yr).")
    return subject, "\n".join(lines)


def send_email(subject: str, body: str) -> str:
    """Send via Resend or SMTP if configured. Returns status string."""
    to_addr = os.environ.get("COPYBOOK_ALERT_TO", "").strip()
    if not to_addr:
        return "skipped: COPYBOOK_ALERT_TO unset"
    resend = os.environ.get("RESEND_API_KEY", "").strip()
    if resend:
        payload = json.dumps(
            {
                "from": os.environ.get(
                    "COPYBOOK_ALERT_FROM", "Copybook <copybook@factordynamics.com>"
                ),
                "to": [addr.strip() for addr in to_addr.split(",") if addr.strip()],
                "subject": subject,
                "text": body,
            }
        ).encode("utf-8")
        req = Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": f"Bearer {resend}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(req, timeout=30) as resp:
                return f"resend:{resp.status}"
        except URLError as exc:
            return f"resend-error:{exc}"
    host = os.environ.get("COPYBOOK_SMTP_HOST", "").strip()
    if not host:
        return "skipped: no RESEND_API_KEY or COPYBOOK_SMTP_HOST"
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = os.environ.get(
        "COPYBOOK_ALERT_FROM", "copybook@factordynamics.com"
    )
    msg["To"] = to_addr
    msg.set_content(body)
    port = int(os.environ.get("COPYBOOK_SMTP_PORT", "587"))
    user = os.environ.get("COPYBOOK_SMTP_USER", "")
    password = os.environ.get("COPYBOOK_SMTP_PASSWORD", "")
    with smtplib.SMTP(host, port, timeout=30) as smtp:
        smtp.starttls()
        if user:
            smtp.login(user, password)
        smtp.send_message(msg)
    return "smtp:sent"
