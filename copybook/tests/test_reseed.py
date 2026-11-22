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
                                         "total_value": [500, 540], "positions": [5, 6], "dollars": 40}])


if __name__ == "__main__":
    unittest.main()
