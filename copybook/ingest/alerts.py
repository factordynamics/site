"""Detect new 13F filings and optionally email the Copy waitlist."""

from __future__ import annotations

import json
import os
import smtplib
from email.message import EmailMessage
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


def previous_accessions(data_dir: Path) -> dict[str, str]:
    path = data_dir / "index.json"
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}
    out: dict[str, str] = {}
    for m in payload.get("managers") or []:
        slug = m.get("slug")
        acc = m.get("accession")
        if slug and acc:
            out[slug] = acc
    return out


def new_filings(managers: list[dict], previous: dict[str, str]) -> list[dict]:
    found = []
    for m in managers:
        if not m.get("ok"):
            continue
        acc = m.get("accession")
        slug = m.get("slug")
        if not acc or not slug:
            continue
        prev = previous.get(slug)
        if prev != acc:
            found.append(
                {
                    "slug": slug,
                    "manager": m.get("manager"),
                    "name": m.get("name"),
                    "quarter": m.get("quarter"),
                    "filing_date": m.get("filing_date"),
                    "report_date": m.get("report_date"),
                    "accession": acc,
                    "previous_accession": prev,
                    "sec_url": m.get("sec_url"),
                    "is_first_seen": prev is None,
                }
            )
    return found


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
