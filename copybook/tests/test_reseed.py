"""Re-seeding a quarter with SEC's late-filing window (datasets.reseed_diff): books may only be added."""

import json
import tempfile
import unittest
from pathlib import Path

from ingest import datasets


def book(acc, total, positions, source="SEC Form 13F data set", filing_date="2026-02-14", name="X"):
    return {"ok": True, "accession": acc, "total_value": total, "position_count": positions, "source": source,
            "filing_date": filing_date, "name": name}


class Reseed(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = datasets.FB
        datasets.FB = Path(self.tmp.name)
        (datasets.FB / "2025Q4").mkdir()
        for cik, b in {"0000000001": book("a-1", 1000, 10),
                       "0000000002": book("b-1", 500, 5),
                       "0000000003": book("c-2", 700, 7, source="EDGAR", filing_date="2026-03-01")}.items():
            (datasets.FB / "2025Q4" / f"{cik}.json").write_text(json.dumps(b))

    def tearDown(self):
        datasets.FB = self.saved
        self.tmp.cleanup()

    def test_late_filers_only_pass(self):
        d = datasets.reseed_diff("2025Q4", {"0000000001": book("a-1", 1000, 10), "0000000002": book("b-1", 500, 5),
                                             "0000000004": book("d-1", 90, 2)})
        self.assertEqual((d["added"], d["unchanged"], d["changed"]), (1, 2, []))

    def test_an_existing_book_that_changes_is_held_with_its_diff(self):
        # B's late NEW HOLDINGS amendment adds $40 and a line; C's newer live EDGAR book is kept as write_period does.
        d = datasets.reseed_diff("2025Q4", {"0000000002": book("b-1", 540, 6, name="B"),
                                             "0000000003": book("c-1", 650, 6, filing_date="2026-02-14")})
        self.assertEqual(d["unchanged"], 1)
        self.assertEqual(d["changed"], [{"cik": "0000000002", "name": "B", "accession": ["b-1", "b-1"],
                                         "total_value": [500, 540], "positions": [5, 6], "dollars": 40, "what": ""}])

    def test_a_held_reseed_writes_nothing_and_names_the_changed_lines(self):
        # B's book in the data set has one more line (CUSIP 037833100, $40): the run fails before any write.
        cols = list(datasets.BOOK_COLUMNS)
        row = lambda cusip, sh, v: [{"cusip": cusip, "shares": sh, "value": v}.get(c) for c in cols]
        path = datasets.FB / "2025Q4" / "0000000002.json"
        path.write_text(json.dumps(book("b-1", 500, 1) | {"columns": cols, "rows": [row("594918104", 10, 500)]}))
        before = path.read_text()
        late = book("b-1", 540, 2, name="B") | {"columns": cols, "rows": [row("594918104", 10, 500),
                                                                           row("037833100", 2, 40)]}
        from unittest import mock
        with mock.patch.object(datasets, "sets_for", return_value=["set", "late"]), \
                mock.patch.object(datasets, "fetch_set", return_value=None), \
                mock.patch.object(datasets, "read_period", return_value={"0000000002": late,
                                                                          "0000000009": book("i-1", 9, 1)}), \
                mock.patch.object(datasets, "windows", return_value=[]):
            self.assertEqual(datasets.reseed("2025Q4"), 1)
        self.assertEqual(path.read_text(), before)
        self.assertFalse((datasets.FB / "2025Q4" / "0000000009.json").exists())
        self.assertFalse((datasets.FB / "2025Q4" / ".complete").exists())
        self.assertEqual(datasets.lines_changed(json.loads(before), late), "037833100 added")

    def test_a_filer_reported_by_another_manager_keeps_its_book(self):
        # AEW 2026Q3: its fb/ book says another manager reports its holdings; the data set still has the 78 lines.
        aew = {"ok": False, "cik": "0001042008", "status": "reported_by_other", "quarter": "2025Q4",
               "accession": "0001104659-26-130039", "source": "SEC EDGAR"}
        path = datasets.FB / "2025Q4" / "0001042008.json"
        path.write_text(json.dumps(aew))
        original = book("0001104659-26-123428", 1_559_274_998, 78) | {"rows": [], "columns": []}
        d = datasets.reseed_diff("2025Q4", {"0001042008": original})
        self.assertEqual((d["added"], d["unchanged"], d["changed"]), (0, 1, []))
        from unittest import mock
        with mock.patch.object(datasets, "attach_tickers"):
            datasets.write_period("2025Q4", {"0001042008": original})
        self.assertEqual(json.loads(path.read_text()), aew)


if __name__ == "__main__":
    unittest.main()
