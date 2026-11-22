"""Past-quarter holder index (moves.write_quarters, hq/{quarter}/): each quarter from its own books, gated."""

import json
import tempfile
import unittest
from pathlib import Path

from ingest import moves
from ingest.bulk import FB_COLUMNS

AAPL, MSFT, NVDA, TSLA = "037833100", "594918104", "67066G104", "88160R101"


def fb(data: Path, q: str, cik: str, *lines):
    """lines: (cusip, ticker, shares, value[, title])."""
    rows = [[x[1], "ISSUER " + x[1], (x[4:] or ("COM",))[0], x[0], None, x[2], x[3], "SH", f"{cik}-{q}", None, None, None, None]
            for x in lines]
    (data / "fb" / q).mkdir(parents=True, exist_ok=True)
    (data / "fb" / q / f"{cik}.json").write_text(json.dumps({
        "ok": True, "name": f"Filer {cik[-1]}", "accession": f"{cik}-{q}", "filing_date": "2026-01-01",
        "columns": list(FB_COLUMNS), "rows": rows}))


class PastQuarters(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name)
        self.saved = (moves.DATA, moves.HQ, moves.HQ_MIN_BOOKS, moves.prior_books)
        moves.DATA, moves.HQ, moves.HQ_MIN_BOOKS = self.data, self.data / "hq", 1
        moves.prior_books = lambda q: {}
        moves.MF_TICKERS.update({"VFIAX"})  # never read from SEC here
        A, B, C = "0000000001", "0000000002", "0000000003"
        # 2026Q1: A 100 AAPL; B 40 AAPL and 10 MSFT.
        fb(self.data, "2026Q1", A, (AAPL, "AAPL", 100, 1000))
        fb(self.data, "2026Q1", B, (AAPL, "AAPL", 40, 400), (MSFT, "MSFT", 10, 300), (NVDA, "NVDA", 3, 60))
        # 2026Q2: A adds 50 AAPL at $12; B sells all AAPL, keeps MSFT; C (first book) buys 5 MSFT.
        fb(self.data, "2026Q2", A, (AAPL, "AAPL", 150, 1800), (TSLA, "TSLA", 2, 800))
        fb(self.data, "2026Q2", B, (MSFT, "MSFT", 10, 330))
        fb(self.data, "2026Q2", C, (MSFT, "MSFT", 5, 165))
        for q in ("2026Q1", "2026Q2"):
            (self.data / "fb" / q / ".complete").write_text('{"format": "4"}\n')
        # 2025Q4: a few books, no .complete (SEC's late window not read): never built.
        fb(self.data, "2025Q4", A, (AAPL, "AAPL", 90, 900))
        # 2026Q3, the newest (hl/'s quarter): A trims to 120.
        fb(self.data, "2026Q3", A, (AAPL, "AAPL", 120, 1560))
        # D's 2026Q3 book is only a public f/ shard (no fb/ book yet): hl/ reads it, so the parity build must too.
        (self.data / "f").mkdir()
        (self.data / "f" / "0000000004.json").write_text(json.dumps({
            "ok": True, "quarter": "2026Q3", "name": "Filer 4", "accession": "4-q3", "columns": list(FB_COLUMNS),
            "rows": [["AAPL", "ISSUER AAPL", "COM", AAPL, None, 7, 91, "SH", "4-q3", None, None, None, None]]}))

    def tearDown(self):
        moves.DATA, moves.HQ, moves.HQ_MIN_BOOKS, moves.prior_books = self.saved
        self.tmp.cleanup()

    def hl_now(self):
        """hlf/ as the run's hl/ build left it: the newest quarter, from the same books and D's f/ shard. A sold all its
        TSLA in 2026Q3 and nobody else holds it, so hl/ (current holders) has no TSLA file."""
        assert moves.quarter_holders("2026Q3", {}, {}, {}, self.data / "hlf", {}) > 0
        (self.data / "hlf" / "88160R.json").unlink()
        assert any(r[0] == "0000000004" for r in json.loads((self.data / "hlf" / "037833.json").read_text())["rows"])

    def rows(self, q, cusip):
        body = json.loads((self.data / "hq" / q / f"{cusip[:6]}.json").read_text())
        cols = body["columns"]
        return body, {r[0][-1]: {c: r[cols.index(c)] for c in ("period", "change", "shares", "prev_shares", "value_delta")}
                      for r in body["rows"]}

    def test_each_past_quarter_is_built_from_its_own_books(self):
        self.hl_now()
        got = moves.write_quarters({}, {}, {}, "2026Q3")
        self.assertEqual(sorted(got), ["2026Q1", "2026Q2"])  # complete ones only, never the newest: hl/ serves it
        body, rows = self.rows("2026Q2", AAPL)
        # A: +50 shares at Q2's $12 = +600 (not the 800 value change); B's 40 shares are gone: -400 at Q1's value.
        self.assertEqual(rows["1"], {"period": "2026Q2", "change": "added", "shares": 150, "prev_shares": 100,
                                     "value_delta": 600})
        self.assertEqual(rows["2"]["change"], "exited")
        self.assertEqual(rows["2"]["value_delta"], -400)
        self.assertNotIn("3", rows)  # C never held AAPL
        self.assertEqual((body["counts"]["holders"], body["counts"]["added"], body["counts"]["exited"]), (1, 1, 1))
        self.assertEqual(body["counts"]["net"], 200)
        self.assertEqual(body["counts"]["net_quarter"], "2026Q2")
        _, ms = self.rows("2026Q2", MSFT)
        # C's first book: no prior on file, as in hl/ (counted no_prior, never "new").
        self.assertEqual((ms["2"]["change"], ms["3"]["change"]), ("unchanged", None))
        # 2025Q4 is never built (not complete), but its books are still 2026Q1's prior quarter.
        _, q1 = self.rows("2026Q1", AAPL)
        self.assertEqual((q1["1"]["change"], q1["1"]["prev_shares"], q1["1"]["shares"]), ("added", 90, 100))
        self.assertFalse((self.data / "hq" / "2025Q4").exists())
        # B left NVDA in 2026Q2 and nobody holds it: the quarter still has the file, with the exit.
        body, nv = self.rows("2026Q2", NVDA)
        self.assertEqual((body["counts"]["holders"], body["counts"]["exited"], nv["2"]["change"], nv["2"]["value_delta"]),
                         (0, 1, "exited", -60))
        idx = json.loads((self.data / "hq" / "2026Q2" / "index.json").read_text())
        self.assertEqual((idx["funds"], idx["classes"]), ({}, {}))
        self.assertEqual((idx["tickers"], idx["complete"]), ({"AAPL": "037833", "MSFT": "594918", "NVDA": "67066G", "TSLA": "88160R"}, True))
        self.assertFalse((self.data / "hq" / "_check").exists())

    def test_a_quarter_lists_its_own_funds_and_share_classes(self):
        # Only in 2026Q1: two VanEck ETFs under one code (since gone from every book) and Berkshire's two classes.
        fb(self.data, "2026Q1", "0000000005", ("92189F676", "SMH", 10, 3000, "SEMICONDUCTR ETF"),
           ("92189F106", "GDX", 20, 1000, "GOLD MINERS ETF"), ("084670108", "BRK.A", 1, 700000, "CL A"),
           ("084670702", "BRK.B", 100, 50000, "CL B NEW"))
        self.hl_now()
        moves.write_quarters({}, {}, {}, "2026Q3")
        q1 = json.loads((self.data / "hq" / "2026Q1" / "index.json").read_text())
        q2 = json.loads((self.data / "hq" / "2026Q2" / "index.json").read_text())
        self.assertEqual(q1["funds"], {"92189F": [{"cusip": "92189F106", "ticker": "GDX"},
                                                  {"cusip": "92189F676", "ticker": "SMH"}]})
        self.assertEqual(q1["classes"], {"084670": [{"cusip": "084670108", "ticker": "BRK.A"},
                                                    {"cusip": "084670702", "ticker": "BRK.B"}]})
        self.assertEqual((q2["funds"], q2["classes"]), ({}, {}))  # the next quarter has neither: its own lists

    def test_nothing_is_written_when_the_newest_quarter_differs_from_hl(self):
        self.hl_now()
        path = self.data / "hlf" / "037833.json"
        body = json.loads(path.read_text())
        body["rows"][0][body["columns"].index("value_delta")] += 1
        path.write_text(json.dumps(body))
        self.assertEqual(moves.write_quarters({}, {}, {}, "2026Q3"), {})
        self.assertFalse(any((self.data / "hq").glob("*Q?")))

    def test_an_issuer_hl_lacks_must_have_no_holders(self):
        self.hl_now()
        (self.data / "hlf" / "037833.json").unlink()  # AAPL still has holders: hl/ lacking it is a real miss
        self.assertEqual(moves.write_quarters({}, {}, {}, "2026Q3"), {})

    def test_curated_funds_are_left_out_of_the_parity_check(self):
        self.hl_now()
        path = self.data / "hlf" / "037833.json"
        body = json.loads(path.read_text())
        body["rows"][0][body["columns"].index("value_delta")] += 1  # A's own page (with page holds) may differ
        path.write_text(json.dumps(body))
        got = moves.write_quarters({}, {"0000000001": {"slug": "a"}}, {}, "2026Q3")
        self.assertEqual(sorted(got), ["2026Q1", "2026Q2"])


if __name__ == "__main__":
    unittest.main()
