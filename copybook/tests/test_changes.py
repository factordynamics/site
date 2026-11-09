import json
import unittest

from ingest import build
from ingest.build import baseline, with_changes
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
        got = {r["cusip"]: (r["value_delta"], r["delta_pct_of_book"]) for r in with_changes(latest, prev)}
        # A: +2 sh at $10 = +20 (not 100-90); B: -4 sh at $10 = -40 (not 50-80); C: price only = 0.
        self.assertEqual(got, {"A": (20, 0.08), "B": (-40, -0.16), "C": (0, 0.0), "D": (30, 0.12),
                               "E": (-40, -0.16)})

    def test_split_confirmation_reads_the_first_cover_after_the_quarter(self):
        # APH 2:1 in Q3 2026: the Q2 10-Q cover (Jul 28) is still pre-split; the Q3 cover (Oct 27) shows it.
        from unittest import mock
        from ingest import splits
        series = [("2026-04-28", 1230234445.0), ("2026-07-28", 1232983457.0), ("2026-10-27", 2469261188.0)]
        with mock.patch.object(splits, "_shares_outstanding", return_value=series):
            self.assertAlmostEqual(splits.xbrl_ratio("820313", "2026Q2", "2026Q3"), 2.007, places=3)

    def test_split_adjusts_the_prior_quarter_before_comparing(self):
        # CRWD-style 4:1 split: 100 -> 400 shares is unchanged, 100 -> 500 is +100, not +400.
        build.SPLITS.clear()
        build.SPLITS.update({"S": {"2026Q3": 4}})
        try:
            latest = {"quarter": "2026Q3", "holdings": [row("S", 400, 400), row("S", 20, 20, "CALL")]}
            prev = {"quarter": "2026Q2", "holdings": [row("S", 100, 380), row("S", 5, 19, "CALL")]}
            got = {(r["put_call"], r["change"], r["prev_shares"], r["share_change"], r["value_delta"])
                   for r in with_changes(latest, prev)}
            self.assertEqual(got, {(None, "unchanged", 400, 0, 0), ("CALL", "unchanged", 20, 0, 0)})
            latest["holdings"][0] = row("S", 500, 500)
            r = with_changes(latest, prev)[0]
            self.assertEqual((r["change"], r["share_change"], r["value_delta"], r["prev_shares_as_filed"],
                              r["split"]["ratio"]), ("added", 100, 100, 100, 4))
        finally:
            build.SPLITS.clear()

    def test_prior_quarter_is_taken_as_known_when_this_quarter_was_filed(self):
        # Berkshire 2025Q1: LEN disclosed by an amendment accepted after the Q2 original.
        late = row("L", 10, 10) | {"first_disclosed_at": "2025-08-14T20:10:02Z", "late_disclosure": True}
        q1 = {"quarter": "2025Q1", "holdings": [row("A", 5, 5) | {"first_disclosed_at": "2025-05-15T20:06:43Z"}, late]}
        q2 = {"quarter": "2025Q2", "accepted_at": "2025-08-14T20:05:04Z",
              "holdings": [row("A", 5, 5), row("L", 10, 10)]}
        got = {r["cusip"]: r["change"] for r in with_changes(q2, q1)}
        self.assertEqual(got, {"A": "unchanged", "L": "new"})  # not public yet when Q2 was filed
        q0 = {"quarter": "2024Q4", "holdings": [row("A", 5, 5)]}
        got = {r["cusip"]: (r["change"], r["value_delta"]) for r in with_changes(q1, q0)}
        self.assertEqual(got, {"A": ("unchanged", 0), "L": ("disclosed_later", 0)})  # not "new" in Q1

    def test_principal_amount_notes_are_never_shares(self):
        note = lambda amt, v: row("N", 0, v) | {"shares_type": "PRN", "principal_amount": amt}
        r = with_changes({"holdings": [note(2000, 210)]}, {"holdings": [note(1000, 100)]})[0]
        self.assertEqual((r["change"], r["share_change"], r["prev_shares"], r["prev_principal_amount"],
                          r["value_delta"]), ("added", None, 0, 1000, 105))

    def test_quarters_two_filers_both_filed_are_one_combined_book(self):
        # Ackman: Pershing Square Capital (a) and Pershing Square Inc. (p) both filed 2026Q1 (18M + 9M HHH);
        # from 2026Q2 Pershing Square Inc. reports the fund (27M). Neither page may show a 9M buy.
        q = lambda qq, d, st, n, **kw: {"quarter": qq, "report_date": d, "status": st, "holdings": [row("H", n, n)],
                                         "total_value": n, **kw}
        own_a = q("2026Q1", "2026-03-31", "filed", 18)
        own_p = q("2026Q1", "2026-03-31", "filed", 9, cik="p", name="P")
        fund = {"slug": "a", "cik": "a", "ok": True, "history": [
            q("2026Q2", "2026-06-30", "notice", 27), build.combine_books(own_a, own_p) | {"total_value": 27}]}
        reporter = {"slug": "p", "cik": "p", "ok": True, "history": [
            q("2026Q2", "2026-06-30", "filed", 27), own_p]}
        build.OWN_BOOKS[("a", "2026-03-31")] = own_a
        try:
            build.share_reporter_books({"managers": [fund, reporter]})
            for m in (fund, reporter):
                r = with_changes(m["history"][0], baseline(m, 0))[0]
                self.assertEqual((m["slug"], r["change"], r["prev_shares"], r["value_delta"]),
                                 (m["slug"], "unchanged", 27, 0))
            self.assertEqual(reporter["history"][1]["combined_with"]["cik"], "a")
        finally:
            build.OWN_BOOKS.clear()

    def test_no_prior_filing_is_unknown_not_new(self):
        self.assertEqual({r["change"] for r in with_changes({"holdings": [row("A", 1, 1)]}, None)}, {None})


class QuarterCsvTest(unittest.TestCase):
    def test_csv_contract_for_copy_api(self):
        q = {"manager": "M", "slug": "m", "cik": "1", "quarter": "2026Q2", "report_date": "2026-06-30",
             "filing_date": "2026-08-14", "accession": "a",
             "holdings": [{"ticker": None, "issuer": 'A, "B"', "cusip": "c", "title": "COM",
                           "put_call": None, "shares": 10.0, "value": 2500.0, "weight": 0.5, "pct_of_book": 0.5,
                           "change": "added", "prev_shares": 4, "share_change": 6, "value_delta": 1500,
                           "delta_pct_of_book": 0.3, "shares_type": "SH", "split": {"ratio": 2},
                           "prev_shares_as_filed": 2, "source_accession": "a",
                           "first_disclosed_at": "2026-08-14T20:05:04Z", "discretion": "SOLE",
                           "other_managers": ["1", "2"], "vote_sole": 10, "vote_shared": 0, "vote_none": 0}],
             "exited": [{"ticker": "X", "issuer": "X", "cusip": "x", "title": "NOTE", "put_call": None,
                         "shares": 0, "value": 0, "weight": 0.0, "change": "exited", "prev_shares": 0,
                         "share_change": None, "value_delta": -90, "delta_pct_of_book": -0.018,
                         "shares_type": "PRN"}]}
        lines = quarter_csv(q).split("\r\n")
        self.assertEqual(lines[0].split(",")[:20], [
            "manager", "slug", "cik", "quarter", "report_date", "filing_date", "accession", "ticker", "issuer",
            "cusip", "title", "put_call", "shares", "value_usd", "weight",
            "change", "prev_shares", "share_change", "value_delta_usd", "delta_pct_of_book"])
        self.assertEqual(
            lines[1],
            'M,m,1,2026Q2,2026-06-30,2026-08-14,a,,"A, ""B""",c,COM,,10,2500,0.5,added,4,6,1500,0.3,'
            "0.5,SH,,2,2,a,2026-08-14T20:05:04Z,,SOLE,1 2,10,0,0",
        )
        # A note's share change is blank, never a share count.
        self.assertEqual(lines[2].split(",")[15:22], ["exited", "0", "", "-90", "-0.018", "", "PRN"])
        self.assertEqual(lines[3], "")


if __name__ == "__main__":
    unittest.main()


class MoveMathTest(unittest.TestCase):
    """CUSIP reissues and mis-scaled filings must not turn into trades."""

    def row(self, cusip, ticker, shares, value, title="COM"):
        return {"issuer": "X", "title": title, "cusip": cusip, "ticker": ticker, "value": float(value),
                "shares": float(shares), "put_call": None, "shares_type": "SH"}

    def test_reissued_cusip_is_one_position(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("30231G102", "XOM", 31468114, 4302320615)]}
        cur = {"quarter": "2026Q3", "accepted_at": "2026-11-01", "holdings": [self.row("30233Q108", "XOM", 31933523, 5197180970)]}
        rows = build.with_changes(cur, prev)
        self.assertEqual([r["change"] for r in rows], ["added"])
        self.assertEqual(rows[0]["prev_cusip"], "30231G102")
        # Fisher's XOM: the trade is the share change at Q3's price (+465,409 sh x $162.75 = +$75.7M),
        # not the change in reported value ($5.20B - $4.30B = +$894.9M, mostly the price move).
        self.assertEqual(rows[0]["share_change"], 465409)
        self.assertAlmostEqual(rows[0]["value_delta"], 465409 * 5197180970 / 31933523, delta=1)

    def test_stale_split_field_is_not_kept(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("037833100", "AAPL", 100, 20000)]}
        stale = self.row("037833100", "AAPL", 120, 25000) | {
            "split": {"ratio": 2.0, "from_quarter": "2026Q2", "to_quarter": "2026Q3"}, "prev_shares_as_filed": 100}
        rows = build.with_changes({"quarter": "2026Q3", "holdings": [stale]}, prev)
        self.assertNotIn("split", rows[0])
        self.assertEqual((rows[0]["prev_shares"], rows[0]["change"]), (100, "added"))

    def test_gate_refuses_unapplied_split(self):
        import tempfile
        from pathlib import Path as P
        from ingest import gate
        with tempfile.TemporaryDirectory() as d:
            (P(d) / "splits.json").write_text(json.dumps({"splits": [{"cusip": "032095101", "to_quarter": "2026Q3", "ratio": 2.0}]}))
            aph = self.row("032095101", "APH", 10708713, 902.6e6) | {"change": "added", "prev_value": 820.3e6}
            split = {"ratio": 2.0, "from_quarter": "2026Q2", "to_quarter": "2026Q3"}
            ok = aph | {"prev_shares": 9733376, "prev_shares_as_filed": 4866688, "split": split}
            unadjusted = aph | {"prev_shares": 4866688, "prev_shares_as_filed": 4866688, "split": split}
            unmarked = aph | {"prev_shares": 4866688}  # Egerton's APH as first published: +$492.5M
            book = lambda h: {"egerton": {"quarter": "2026Q3", "holdings": [h]}}
            self.assertEqual(gate.split_rows(P(d), book(ok)), [])
            self.assertEqual(len(gate.split_rows(P(d), book(unadjusted))), 1)
            self.assertEqual(len(gate.split_rows(P(d), book(unmarked))), 1)

    def test_preferred_is_not_the_common(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("060505682", "BAC", 5, 50, "7.25%CNV PFD L")]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("060505104", "BAC", 4, 40)]}
        self.assertEqual(sorted(r["change"] for r in build.with_changes(cur, prev)), ["exited", "new"])

    def test_mis_scaled_share_count_is_capped(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 646216, 121.6e6)]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("09857L108", "BKNG", 1304, 6.7e6)]}
        r = build.with_changes(cur, prev)[0]
        self.assertTrue(r["suspect_units"])
        self.assertAlmostEqual(r["value_delta"], 6.7e6 - 121.6e6, delta=1)
        self.assertNotIn("BKNG", [m["ticker"] for m in (build.moves([r]) or {}).get("trimmed", [])])
