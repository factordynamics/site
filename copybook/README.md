# Copybook

Consumer 13F site: latest holdings as filed for 41 superinvestors, plus a value-weighted copycat book.

Pitch: Dataroma with a copycat book. Free latest quarter. Copy ($9/mo or $79/yr) is waitlisted until Stripe keys exist.

## What it shows

- SEC 13F-HR information tables only: issuer, CUSIP, shares, filer-reported value.
- No Yahoo prices, no live P&amp;L, no Form 4 / 13D, no Dataroma scrape.

## Refresh

GitHub Actions pulls EDGAR daily at 12:00 UTC and on every push to `main`, then deploys GitHub Pages from `web/`. Q3 2026 13Fs due ~14 Nov 2026 will show up on the next successful run.

```bash
python -m unittest discover -s tests -v
python ingest/build.py
```

User-Agent: `Copybook factordynamics.com copybook@factordynamics.com`. Stay under 10 req/s.

## License

Holdings are a public record. Site code is private to Factor Dynamics unless otherwise marked.
