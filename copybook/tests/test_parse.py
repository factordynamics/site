"""Parser tests. Values must stay as-filed; split CUSIP lines must sum."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import unittest

from ingest.parse import (
    aggregate_holdings,
    looks_like_thousands,
    parse_info_table,
    scale_if_thousands,
)


SAMPLE = """\
<?xml version="1.0" encoding="UTF-8"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>02005N100</cusip>
    <value>577211815</value>
    <shrsOrPrnAmt>
      <sshPrnamt>12561737</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>DFND</investmentDiscretion>
  </infoTable>
  <infoTable>
    <nameOfIssuer>ALLY FINL INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>02005N100</cusip>
    <value>128838056</value>
    <shrsOrPrnAmt>
      <sshPrnamt>2803875</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>DFND</investmentDiscretion>
  </infoTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>1000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>5000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <putCall>Call</putCall>
  </infoTable>
</informationTable>
"""


class ParseTests(unittest.TestCase):
    def test_parse_keeps_as_filed_dollars_and_split_lines(self):
        rows = parse_info_table(SAMPLE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].value, 577_211_815.0)
        self.assertEqual(rows[1].value, 128_838_056.0)
        self.assertEqual(rows[2].put_call, "CALL")
        # Competing mistake: treat <value> as thousands of USD.
        self.assertNotEqual(rows[0].value, 577_211_815.0 * 1000)

    def test_aggregate_sums_same_cusip_keeps_calls_apart(self):
        holdings = aggregate_holdings(parse_info_table(SAMPLE))
        by_key = {(h.cusip, h.put_call): h for h in holdings}
        ally = by_key[("02005N100", None)]
        call = by_key[("037833100", "CALL")]
        self.assertEqual(ally.value, 577_211_815.0 + 128_838_056.0)
        self.assertEqual(ally.shares, 12_561_737.0 + 2_803_875.0)
        self.assertEqual(call.value, 1_000_000.0)
        self.assertEqual(holdings[0].cusip, "02005N100")

    def test_known_managers_are_forty_one_unique_ciks(self):
        from ingest.managers import MANAGERS

        ciks = [m[0] for m in MANAGERS]
        slugs = [m[3] for m in MANAGERS]
        self.assertEqual(len(MANAGERS), 41)
        self.assertEqual(len(set(ciks)), 41)
        self.assertEqual(len(set(slugs)), 41)
        self.assertIn("0001067983", ciks)
        self.assertIn("0001336528", ciks)

    def test_new_filings_detects_accession_change(self):
        from ingest.alerts import new_filings

        prev = {"warren-buffett": "old"}
        managers = [
            {
                "ok": True,
                "slug": "warren-buffett",
                "manager": "Warren Buffett",
                "name": "Berkshire",
                "accession": "new",
                "quarter": "2026Q2",
                "filing_date": "2026-08-14",
                "report_date": "2026-06-30",
                "sec_url": "https://example.com",
            }
        ]
        found = new_filings(managers, prev)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["previous_accession"], "old")
        self.assertEqual(new_filings(managers, {"warren-buffett": "new"}), [])

    def test_unit_fix_by_implied_price(self):
        from ingest.parse import unit_fix

        # Acadian-style: values in $000s but the total sits above the old $50M cutoff.
        self.assertEqual(unit_fix([(3_289_929, 17_633_622)] + [(1_000, 5_000)] * 4), 1000.0)
        # Davidson Kempner-style: dollars x1000 (Amedisys at ~$98k/share).
        self.assertEqual(unit_fix([(48_505_483_000, 492_992)] * 5), 0.001)
        # Caxton-style: all x1000 but a cheap name pulls the median to ~$5.7k.
        self.assertEqual(unit_fix([(430_000 * 7_623, 7_623), (8_630 * 100, 100)] * 3), 0.001)
        # Normal book with one BRK.A line stays put.
        self.assertEqual(unit_fix([(700_000 * 10, 10)] + [(150 * 1_000, 1_000)] * 4), 1.0)
        # Too few priced rows: trust the filing.
        self.assertEqual(unit_fix([(1, 100)]), 1.0)

    def test_consensus_unit_check(self):
        from ingest.parse import consensus_factor, consensus_prices

        q = "2024Q4"
        filers = [(q, [("HTZ", 5_000_000, 1_000_000, None)])] * 3 + [(q, [("HTZ", 46_533_100_000, 12_713_963, None)])]
        cons = consensus_prices(filers)
        self.assertAlmostEqual(cons[(q, "HTZ")], 5.0)
        self.assertEqual(consensus_factor(46_533_100_000 / 12_713_963, cons[(q, "HTZ")]), 0.001)  # Ackman's Hertz line
        self.assertEqual(consensus_factor(0.005, 5.0), 1000.0)
        self.assertEqual(consensus_factor(9.0, 5.0), 1.0)  # different trade dates, same units
        self.assertNotIn((q, "X"), consensus_prices([(q, [("X", 10, 1, None)])] * 2))  # too few filers

    def test_row_overstated(self):
        from ingest.parse import row_overstated

        self.assertTrue(row_overstated("02209S103", 48_505_483_000, 492_992))  # $98k/share
        self.assertFalse(row_overstated("084670108", 735_000 * 10, 10))  # BRK.A is real
        self.assertFalse(row_overstated("67066G104", 186 * 1_000, 1_000))

    def test_thousands_scale_baupost_not_berkshire(self):
        # Baupost-style: tableValueTotal matches summed lines and is small.
        self.assertTrue(looks_like_thousands(5_415_853.0, 5_415_853.0))
        # Berkshire-style: already dollars, huge tableValueTotal.
        self.assertFalse(looks_like_thousands(299_253_556_246.0, 299_253_556_246.0))
        holdings = aggregate_holdings(parse_info_table(SAMPLE))
        scale_if_thousands(holdings, True)
        ally = next(h for h in holdings if h.cusip == "02005N100")
        self.assertEqual(ally.value, (577_211_815.0 + 128_838_056.0) * 1000)
