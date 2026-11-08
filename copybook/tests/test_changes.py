import unittest

from ingest.build import with_changes
from ingest.enrich import quarter_csv


def row(cusip, shares, value, put_call=None):
    return {"issuer": cusip, "title": "COM", "cusip": cusip, "ticker": None,
            "value": value, "shares": shares, "put_call": put_call, "weight": 0}


class ChangesTest(unittest.TestCase):
    def test_quarter_over_quarter(self):
        latest = {"holdings": [row("A", 10, 100), row("B", 5, 50), row("C", 7, 70),
                               row("D", 3, 30), row("A", 1, 9, "Put")]}
        prev = {"holdings": [row("A", 8, 90), row("B", 9, 80), row("C", 7, 60),
                             row("E", 4, 40), row("A", 2, 5, "Call")]}
        got = [(r["cusip"], r["put_call"], r["change"], r["prev_shares"], r["value"])
               for r in with_changes(latest, prev)]
        self.assertEqual(got, [
            ("A", None, "added", 8, 100),
            ("B", None, "trimmed", 9, 50),
            ("C", None, "unchanged", 7, 70),  # value moved, shares did not
            ("D", None, "new", 0, 30),
            ("A", "Put", "new", 0, 9),
            ("E", None, "exited", 4, 0),
            ("A", "Call", "exited", 2, 0),
        ])

    def test_trade_size_uses_this_filings_price_not_the_value_change(self):
        latest = {"holdings": [row("A", 10, 100), row("B", 5, 50), row("C", 7, 70), row("D", 3, 30)],
                  "total_value": 250}
        prev = {"holdings": [row("A", 8, 90), row("B", 9, 80), row("C", 7, 60), row("E", 4, 40)],
                "total_value": 270}
        got = {r["cusip"]: (r["value_delta"], r["pct_of_book"]) for r in with_changes(latest, prev)}
        # A: +2 sh at $10 = +20 (not 100-90); B: -4 sh at $10 = -40 (not 50-80); C: price only = 0.
        self.assertEqual(got, {"A": (20, 0.08), "B": (-40, -0.16), "C": (0, 0.0), "D": (30, 0.12),
                               "E": (-40, -0.16)})

    def test_no_prior_filing_is_unknown_not_new(self):
        self.assertEqual({r["change"] for r in with_changes({"holdings": [row("A", 1, 1)]}, None)}, {None})


class QuarterCsvTest(unittest.TestCase):
    def test_csv_contract_for_copy_api(self):
        q = {"manager": "M", "slug": "m", "cik": "1", "quarter": "2026Q2", "report_date": "2026-06-30",
             "filing_date": "2026-08-14", "accession": "a",
             "holdings": [{"ticker": None, "issuer": 'A, "B"', "cusip": "c", "title": "COM",
                           "put_call": None, "shares": 10.0, "value": 2500.0, "weight": 0.5,
                           "change": "added", "prev_shares": 4, "share_change": 6, "value_delta": 1500,
                           "pct_of_book": 0.3}],
             "exited": [{"ticker": "X", "issuer": "X", "cusip": "x", "title": "COM", "put_call": "Put",
                         "shares": 0, "value": 0, "weight": 0.0, "change": "exited", "prev_shares": 3,
                         "share_change": -3, "value_delta": -90, "pct_of_book": -0.018}]}
        self.assertEqual(
            quarter_csv(q),
            "manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,"
            "put_call,shares,value_usd,weight,change,prev_shares,share_change,value_delta_usd,pct_of_book\r\n"
            'M,m,1,2026Q2,2026-06-30,2026-08-14,a,,"A, ""B""",c,COM,,10,2500,0.5,added,4,6,1500,0.3\r\n'
            "M,m,1,2026Q2,2026-06-30,2026-08-14,a,X,X,x,COM,Put,0,0,0,exited,3,-3,-90,-0.018\r\n",
        )


if __name__ == "__main__":
    unittest.main()
