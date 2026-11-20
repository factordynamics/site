"""Class-level holds in hl/ (moves.class_holds): class_swap only between share classes of one company."""

import json
import unittest
from pathlib import Path

from ingest import moves

# SEC's Official 13(f) List for 2026Q3, the rows for the codes below (13flist2026q3.txt, as published).
LIST_Q3 = {c: tuple(r) for c, r in json.loads((Path(__file__).parent / "fixtures_13flist_2026q3.json").read_text()).items()}
COMPANIES = ["02079K", "084670", "35137L", "75134P", "011532", "23834J", "M8216R", "023135", "025537", "025816", "035710",
             "040413", "053015", "097023", "19247L", "38964R", "389930", "674599", "683712", "68989M", "76655K", "83601L",
             "896438", "949746", "98421M"]  # payments' 25, Nov 20: share-class issuers and companies with options or warrants
FUND_FAMILIES = ["464287", "92189F", "032108", "46436E", "524682"]  # iShares, VanEck, Amplify (with CALL/PUT), iShares, Legg Mason


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


class FundSeries(unittest.TestCase):
    """A company with share classes is never a fund family, whatever one filer's line says (live funds, Nov 20)."""

    def setUp(self):
        self.saved = dict(moves.LISTS)
        moves.LISTS.clear()

    def tearDown(self):
        moves.LISTS.clear()
        moves.LISTS.update(self.saved)

    def line(self, cusip, title, issuer):
        return {"cusip": cusip, "title": title, "issuer": issuer}

    def test_share_class_companies_on_the_13f_list_are_not_funds(self):
        # SEC's 2026Q3 13(f) list, as published; one filer's stray fund-like line under each code.
        moves.LISTS["2026Q3"] = {
            "02079K305": ("", "CAP STK CL A", "ALPHABET INC"), "02079K107": ("", "CAP STK CL C", "ALPHABET INC"),
            "084670108": ("", "CL A", "BERKSHIRE HATHAWAY INC DEL"), "084670702": ("", "CL B NEW", "BERKSHIRE HATHAWAY INC DEL"),
            "35137L105": ("", "CL A COM", "FOX CORP"), "35137L204": ("", "CL B COM", "FOX CORP"),
            "92189F676": ("", "SEMICONDUCTR ETF", "VANECK ETF TRUST"), "92189F106": ("", "GOLD MINERS ETF", "VANECK ETF TRUST"),
        }
        stray = lambda c: self.line(c, "SHS BEN INT", "ETF TRUST")
        self.assertFalse(moves.fund_series([self.line("02079K305", "CAP STK CL A", "ALPHABET INC"), stray("02079K107")]))
        self.assertFalse(moves.fund_series([self.line("084670702", "CL B NEW", "BERKSHIRE HATHAWAY"), stray("084670770")]))
        self.assertFalse(moves.fund_series([self.line("35137L105", "CL A COM", "FOX CORP"), stray("35137L204")]))
        self.assertTrue(moves.fund_series([self.line("92189F676", "COM", "VANECK"), self.line("92189F106", "COM", "VANECK")]))

    def test_unlisted_code_goes_by_most_filers_lines(self):
        company = [self.line("023135106", "COM", "AMAZON COM INC")] * 5 + [self.line("023135106", "ETF", "SOME FUND")]
        self.assertFalse(moves.fund_series(company))
        funds = [self.line("25460G781", "DAI GOL BUL ETF", "DIREXION SHARES ETF TRUST"),
                 self.line("25460G153", "DAILY BANKS ETF", "DIREXION SHARES ETF TRUST")]
        self.assertTrue(moves.fund_series(funds))

    def test_payments_25_companies_are_not_funds_and_etf_families_are(self):
        moves.LISTS["2026Q3"] = LIST_Q3
        stray = lambda c: {"cusip": c, "title": "SHS BEN INT", "issuer": "ETF TRUST"}  # one filer's fund-like line
        for code in COMPANIES:
            lines = [stray(c) for c in LIST_Q3 if c.startswith(code)]
            self.assertTrue(lines, code)
            self.assertFalse(moves.fund_series(lines), code)
        for code in FUND_FAMILIES:
            self.assertTrue(moves.fund_series([{"cusip": c} for c in LIST_Q3 if c.startswith(code)]), code)

    def test_unlisted_mutual_fund_by_sec_ticker_list(self):
        saved = set(moves.MF_TICKERS)
        try:
            moves.MF_TICKERS.clear()
            moves.MF_TICKERS.add("PMYAX")  # Putnam Core Equity Fund A, on company_tickers_mf.json
            lines = [{"cusip": "74676P104", "ticker": "PMYAX", "title": "COM", "issuer": "PUTNAM"}]
            self.assertTrue(moves.fund_series(lines))
            moves.MF_TICKERS.clear()
            self.assertFalse(moves.fund_series(lines))
        finally:
            moves.MF_TICKERS.clear()
            moves.MF_TICKERS.update(saved)


if __name__ == "__main__":
    unittest.main()
