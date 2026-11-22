"""Past-quarter holder index (moves.write_quarters, hq/{quarter}/): each quarter from its own books, gated."""

import json
import tempfile
import unittest
from pathlib import Path

from ingest import moves
from ingest.bulk import FB_COLUMNS

AAPL, MSFT = "037833100", "594918104"


def fb(data: Path, q: str, cik: str, *lines):
    """lines: (cusip, ticker, shares, value)."""
    rows = [[t, "ISSUER " + t, "COM", c, None, sh, v, "SH", f"{cik}-{q}", None, None, None, None] for c, t, sh, v in lines]
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
        fb(self.data, "2026Q1", B, (AAPL, "AAPL", 40, 400), (MSFT, "MSFT", 10, 300))
        # 2026Q2: A adds 50 AAPL at $12; B sells all AAPL, keeps MSFT; C (first book) buys 5 MSFT.
        fb(self.data, "2026Q2", A, (AAPL, "AAPL", 150, 1800))
        fb(self.data, "2026Q2", B, (MSFT, "MSFT", 10, 330))
        fb(self.data, "2026Q2", C, (MSFT, "MSFT", 5, 165))
        (self.data / "fb" / "2026Q2" / ".complete").write_text('{"format": "4"}\n')
        # 2026Q3, the newest (hl/'s quarter): A trims to 120.
        fb(self.data, "2026Q3", A, (AAPL, "AAPL", 120, 1560))

    def tearDown(self):
        moves.DATA, moves.HQ, moves.HQ_MIN_BOOKS, moves.prior_books = self.saved
        self.tmp.cleanup()

    def hl_now(self):
        """hlf/ as the run's hl/ build left it: the newest quarter, built from the same books."""
        assert moves.quarter_holders("2026Q3", {}, {}, {}, self.data / "hlf", {}) > 0

    def rows(self, q, cusip):
        body = json.loads((self.data / "hq" / q / f"{cusip[:6]}.json").read_text())
        cols = body["columns"]
        return body, {r[0][-1]: {c: r[cols.index(c)] for c in ("period", "change", "shares", "prev_shares", "value_delta")}
                      for r in body["rows"]}

    def test_each_past_quarter_is_built_from_its_own_books(self):
        self.hl_now()
        got = moves.write_quarters({}, {}, {}, "2026Q3")
        self.assertEqual(sorted(got), ["2026Q1", "2026Q2"])  # never the newest: hl/ serves it
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
        # The oldest stored quarter has no quarter before it here: holders, no changes.
        _, q1 = self.rows("2026Q1", AAPL)
        self.assertEqual((q1["1"]["change"], q1["1"]["shares"]), (None, 100))
        idx = json.loads((self.data / "hq" / "2026Q2" / "index.json").read_text())
        self.assertEqual((idx["tickers"], idx["complete"]), ({"AAPL": "037833", "MSFT": "594918"}, True))
        self.assertFalse(json.loads((self.data / "hq" / "2026Q1" / "index.json").read_text())["complete"])
        self.assertFalse((self.data / "hq" / "_check").exists())

    def test_nothing_is_written_when_the_newest_quarter_differs_from_hl(self):
        self.hl_now()
        path = self.data / "hlf" / "037833.json"
        body = json.loads(path.read_text())
        body["rows"][0][body["columns"].index("value_delta")] += 1
        path.write_text(json.dumps(body))
        self.assertEqual(moves.write_quarters({}, {}, {}, "2026Q3"), {})
        self.assertFalse(any((self.data / "hq").glob("*Q?")))

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
