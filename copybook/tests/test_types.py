from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.adv import verdict  # noqa: E402
from ingest.filer_types import classify  # noqa: E402


def adviser(raum, hedge, private_gav, counts=None, individuals=0.0, inv_cos=0.0, exempt=False):
    counts = counts or ({"Hedge": hedge} if hedge else {})
    return {"crd": "1", "cik": None, "names": ["X"], "exempt": exempt, "raum": raum, "raum_individuals": individuals,
            "raum_investment_companies": inv_cos, "private_funds": sum(counts.values()), "hedge_funds": hedge,
            "fund_counts": counts, "private_gav": private_gav}


class AdviserRuleTests(unittest.TestCase):
    def test_hedge_fund_by_share_of_raum(self):
        self.assertEqual(verdict(adviser(0.6e9, 2, 0.5e9))[0], "hedge_fund")  # 83% of RAUM
        self.assertIsNone(verdict(adviser(2e9, 1, 0.8e9))[0])  # 40%, under $1B

    def test_a_billion_counts_only_at_a_quarter_of_the_book(self):
        # Brigade: 27 hedge funds of 37 private funds, ~$10.7B estimated, 32% of RAUM.
        self.assertEqual(verdict(adviser(33e9, 27, 14.7e9, {"Hedge": 27, "Other": 10}))[0], "hedge_fund")
        # Arnhold: one $1.1B estimated hedge fund on a $6.4B wealth book, 16%.
        self.assertNotEqual(verdict(adviser(6.4e9, 1, 2.2e9, {"Hedge": 1, "Other": 1}, individuals=4e9))[0], "hedge_fund")

    def test_estimate_splits_gross_assets_by_fund_count(self):
        _, ev = verdict(adviser(10e9, 1, 4e9, {"Hedge": 1, "PE": 3}))
        self.assertTrue(ev["hedge_gav_estimated"])
        self.assertEqual(ev["hedge_gav"], 1_000_000_000)

    def test_exempt_adviser_uses_its_private_funds_as_the_book(self):
        self.assertEqual(verdict(adviser(0, 1, 0.3e9, exempt=True))[0], "hedge_fund")

    def test_wealth_and_fund_complexes(self):
        self.assertEqual(verdict(adviser(5e9, 0, 0, individuals=3e9))[0], "wealth")
        self.assertEqual(verdict(adviser(50e9, 0, 0, inv_cos=40e9))[0], "long_only")

    def test_shape_alone_never_makes_a_hedge_fund(self):
        shape = {"positions": 40, "top10": 0.6, "options": 0.2, "etf": 0.0, "turnover": 0.9, "aum": 2e9}
        kind, basis, _ = classify("0009999999", "Concentrated Options LP", shape)
        self.assertEqual(kind, "long_only")
        self.assertIn("no Form ADV", basis)
        kind, _, ev = classify("0009999999", "Concentrated Options LP", shape, adviser=adviser(1e9, 2, 0.9e9))
        self.assertEqual((kind, ev["adv"]["hedge_funds"]), ("hedge_fund", 2))


if __name__ == "__main__":
    unittest.main()
