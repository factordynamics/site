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

    def test_no_prior_filing_is_unknown_not_new(self):
        self.assertEqual({r["change"] for r in with_changes({"holdings": [row("A", 1, 1)]}, None)}, {None})


class QuarterCsvTest(unittest.TestCase):
    def test_csv_contract_for_copy_api(self):
        q = {"manager": "M", "slug": "m", "cik": "1", "quarter": "2026Q2", "report_date": "2026-06-30",
             "filing_date": "2026-08-14", "accession": "a",
             "holdings": [{"ticker": None, "issuer": 'A, "B"', "cusip": "c", "title": "COM",
                           "put_call": None, "shares": 10.0, "value": 2500.0, "weight": 0.5}]}
        self.assertEqual(
            quarter_csv(q),
            "manager,slug,cik,quarter,report_date,filing_date,accession,ticker,issuer,cusip,title,"
            "put_call,shares,value_usd,weight\r\n"
            'M,m,1,2026Q2,2026-06-30,2026-08-14,a,,"A, ""B""",c,COM,,10,2500,0.5\r\n',
        )


if __name__ == "__main__":
    unittest.main()
