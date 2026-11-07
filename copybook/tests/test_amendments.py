import unittest
from types import SimpleNamespace as M

from ingest.build import merge_quarter, pick_filings


def f(acc, form, filed):
    return M(accession=acc, form=form, filing_date=filed, report_date="2025-03-31")


class AmendmentTest(unittest.TestCase):
    def test_new_holdings_amendment_adds_to_original(self):
        # Buffett 2025Q1: original in May, 4-line NEW HOLDINGS /A in August.
        orig, add = f("o", "13F-HR", "2025-05-15"), f("a", "13F-HR/A", "2025-08-14")
        base, extra = pick_filings([add, orig], {"a": "NEW HOLDINGS"})
        self.assertEqual((base.accession, [m.accession for m in extra]), ("o", ["a"]))

    def test_restatement_replaces_and_drops_earlier_additions(self):
        orig = f("o", "13F-HR", "2025-05-15")
        add = f("a", "13F-HR/A", "2025-06-01")
        rest = f("r", "13F-HR/A", "2025-07-01")
        late = f("b", "13F-HR/A", "2025-08-01")
        types = {"a": "NEW HOLDINGS", "r": "RESTATEMENT", "b": "NEW HOLDINGS"}
        base, extra = pick_filings([late, rest, add, orig], types)
        self.assertEqual((base.accession, [m.accession for m in extra]), ("r", ["b"]))

    def test_lone_additive_amendment_is_not_a_book(self):
        self.assertEqual(pick_filings([f("a", "13F-HR/A", "2025-08-14")], {"a": "NEW HOLDINGS"}), (None, []))

    def test_merge_sums_overlaps_and_reweights(self):
        h = lambda c, v, pc=None: {"cusip": c, "put_call": pc, "value": v, "shares": v, "weight": 0}
        base = {"accession": "o", "line_count": 2, "holdings": [h("X", 300), h("Y", 100)]}
        add = {"accession": "a", "line_count": 2, "holdings": [h("Y", 50), h("Z", 50, "Put")]}
        q = merge_quarter(base, [add])
        self.assertEqual([(r["cusip"], r["value"]) for r in q["holdings"]], [("X", 300), ("Y", 150), ("Z", 50)])
        self.assertEqual((q["total_value"], q["position_count"], q["amendments"]), (500, 3, ["a"]))
        self.assertAlmostEqual(q["holdings"][0]["weight"], 0.6)


if __name__ == "__main__":
    unittest.main()
