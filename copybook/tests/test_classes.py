"""Class-level holds in hl/ (moves.class_holds): class_swap only between share classes of one company."""

import unittest

from ingest import moves


def cls(*rows):
    """rows: (cusip, title, issuer, shares, prev_shares, value, prev_value), as filed."""
    return {c: {"cusip": c, "title": t, "issuer": i, "shares": s, "prev_shares": ps, "value": v, "prev_value": pv,
                "side": None, "reason": None} for c, t, i, s, ps, v, pv in rows}


def held(k):
    return sorted(c for c, x in k.items() if x["reason"] == "class_swap")


class ClassSwap(unittest.TestCase):
    def test_vaneck_etfs_are_not_share_classes(self):
        # Morgan Stanley 2026Q3 92189F: the pair that crossed in the band (OIL REFINERS ETF $47 -> $63.34,
        # CHINE INNOV ETF $62.41 -> $45.05) beside SMH and GDX. Separate funds: nothing is held.
        k = cls(("92189F585", "OIL REFINERS ETF", "VANECK ETF TRUST", 1000, 1, 63340, 47),
                ("92189F627", "CHINE INNOV ETF", "VANECK ETF TRUST", 180, 1418, 8109, 88497),
                ("92189F676", "SEMICONDUCTR ETF", "VANECK ETF TRUST", 2926265, 4074538, 1782096922, 2672449897),
                ("92189F106", "GOLD MINERS ETF", "VANECK ETF TRUST", 13849572, 16420795, 1215992538, 1238949068))
        self.assertIsNone(moves.class_holds(k, True))
        self.assertEqual(held(k), [])

    def test_direxion_etfs_are_not_share_classes(self):
        # Citadel 2026Q3 25460G: NUGT and DPST crossed in the band.
        k = cls(("25460G781", "DAI GOL BUL ETF", "DIREXION SHARES ETF TRUST", 124332, 149417, 18368810, 17483283),
                ("25460G153", "DAILY BANKS ETF", "DIREXION SHARES ETF TRUST", 5175, 286205, 566663, 40475111),
                ("25460G138", "DLY 20 YR TRESUR", "DIREXION SHARES ETF TRUST", 925965, 0, 23778781, 0))
        self.assertIsNone(moves.class_holds(k, True))
        self.assertEqual(held(k), [])

    def test_berkshire_classes_that_trade_places_are_held(self):
        # McMill Wealth 2026Q2/A: Class A filed at B's ~$500, Class B at A's ~$748K, the other way round last quarter.
        # Titles as filed (0002056447-26-000004): "Equity", the class only in the issuer name.
        k = cls(("084670108", "Equity", "BERKSHIRE HATHAWAY INC DCLASS A", 10, 10, 5_000, 7_480_000),
                ("084670702", "Equity", "BERKSHIRE HATHAWAY CLASS B", 10, 10, 7_480_000, 5_000))
        self.assertEqual(moves.class_holds(k, True), "class_swap")
        self.assertEqual(held(k), ["084670108", "084670702"])

    def test_only_the_crossed_pair_of_three_classes_is_held(self):
        # Liberty Global G61188, three listed classes (COM CL A, B, C): A and C trade places (~$11 and ~$15 swap);
        # B, priced like its own prior, stays counted.
        k = cls(("G61188101", "COM CL A", "LIBERTY GLOBAL LTD", 100, 100, 1_500, 1_100),
                ("G61188127", "COM CL C", "LIBERTY GLOBAL LTD", 100, 100, 1_100, 1_500),
                ("G61188119", "COM CL B", "LIBERTY GLOBAL LTD", 100, 100, 1_200, 1_190))
        self.assertEqual(moves.class_holds(k, True), "class_swap")
        self.assertEqual(held(k), ["G61188101", "G61188127"])
        self.assertIsNone(k["G61188119"]["side"])


if __name__ == "__main__":
    unittest.main()
