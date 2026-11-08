import unittest

from ingest.events import affiliate, clean_ticker, enrich, parse_form4, parse_schedule

FORM4 = """<ownershipDocument><issuer><issuerCik>0000000002</issuerCik><issuerName>LENNAR CORP</issuerName>
<issuerTradingSymbol>len</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0001067983</rptOwnerCik></reportingOwnerId>
<reportingOwnerRelationship><isTenPercentOwner>true</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>
<nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle>
<transactionDate><value>2026-10-01</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Sub A</value></natureOfOwnership></ownershipNature>
</nonDerivativeTransaction>
<nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle>
<transactionDate><value>2026-10-02</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>300</value></transactionShares><transactionPricePerShare><value>12</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>700</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Sub B</value></natureOfOwnership></ownershipNature>
</nonDerivativeTransaction>
<nonDerivativeHolding><securityTitle><value>Class A</value></securityTitle>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>20000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Sub C</value></natureOfOwnership></ownershipNature>
</nonDerivativeHolding>
</nonDerivativeTable></ownershipDocument>"""

SCHEDULE = """<edgarSubmission><headerData><submissionType>SCHEDULE 13G/A</submissionType></headerData><formData>
<coverPageHeader><amendmentNo>3</amendmentNo><eventDateRequiresFilingThisStatement>09/30/2026</eventDateRequiresFilingThisStatement>
<issuerInfo><issuerCik>0000000002</issuerCik><issuerCusips><issuerCusipNumber>526057104</issuerCusipNumber></issuerCusips>
<issuerName>LENNAR CORPORATION</issuerName></issuerInfo></coverPageHeader>
<coverPageHeaderReportingPersonDetails><reportingPersonName>Parent</reportingPersonName>
<reportingPersonBeneficiallyOwnedAggregateNumberOfShares>26000</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
<classPercent>12.5</classPercent></coverPageHeaderReportingPersonDetails>
<coverPageHeaderReportingPersonDetails><reportingPersonName>Sub</reportingPersonName>
<reportingPersonBeneficiallyOwnedAggregateNumberOfShares>21000</reportingPersonBeneficiallyOwnedAggregateNumberOfShares>
<classPercent>10.3</classPercent></coverPageHeaderReportingPersonDetails></formData></edgarSubmission>"""


class Form4Test(unittest.TestCase):
    def test_net_trade_and_holdings_across_owner_lines(self):
        ev = parse_form4(FORM4, "1067983")
        self.assertEqual((ev["action"], ev["shares"], ev["value_usd"], ev["ticker"]), ("buy", 700, 13600, "LEN"))
        # 5000 (Sub A) + 700 (Sub B) + 20000 (Sub C, held without a trade), not the last row's 700.
        self.assertEqual(ev["shares_after"], 25700)
        self.assertEqual(ev["event_date"], "2026-10-02")
        # Before the filing: 25,700 after, minus 1,000 bought, plus 300 sold.
        self.assertEqual(ev["prev_shares_after"], 25_000)

    def test_filings_about_the_managers_own_insiders_are_dropped(self):
        self.assertIsNone(parse_form4(FORM4, "315090"))

    def test_placeholder_symbols_are_not_tickers(self):
        self.assertEqual([clean_ticker(t) for t in ("N/A", "NONE", "brk.b", "", "LEN, LEN.B")],
                         [None, None, "BRK.B", None, "LEN"])


class EnrichTest(unittest.TestCase):
    SECS = {"526057104": {"ticker": "LEN", "name": "Lennar", "sector": "Consumer Discretionary"},
            "526057302": {"ticker": "LEN.B", "name": "Lennar", "sector": "Consumer Discretionary"},
            "000000004": {"ticker": "AGX", "name": "Argan", "sector": "Industrials"}}

    def run_enrich(self, ev, book, manager="Berkshire Hathaway Inc"):
        by_ticker = {r["ticker"]: (c, r) for c, r in self.SECS.items()}
        return enrich(ev, book, self.SECS, by_ticker, manager)

    def test_class_a_13g_is_compared_with_class_a_only(self):
        book = {"a": {"cusip": "526057104", "shares": 13_111_741, "put_call": None},
                "b": {"cusip": "526057302", "shares": 298_117, "put_call": None}}
        ev = {"filed_cusip": "526057104", "shares_after": 26_034_436}
        self.assertTrue(self.run_enrich(ev, book))
        self.assertEqual((ev["ticker"], ev["shares_in_13f"], ev["change_vs_13f"]), ("LEN", 13_111_741, 12_922_695))

    def test_placeholder_cusips_and_own_funds_are_dropped(self):
        # Third Point seeding its own private fund: CUSIP 0000000000, no ticker.
        ev = {"filed_cusip": "0000000000", "issuer": "Third Point Private Capital Income Fund"}
        self.assertFalse(self.run_enrich(ev, {}, "Third Point LLC"))
        self.assertIsNone(ev["ticker"])
        ev = {"filed_cusip": "000000000", "issuer": "Unlisted Trust"}
        self.assertFalse(self.run_enrich(ev, {}, "Other Capital LP"))
        self.assertTrue(affiliate("Brookfield Corp /ON/", "Brookfield Real Estate Income Trust Inc."))
        self.assertFalse(affiliate("Third Point LLC", "Thirdhaven Corp"))


class ScheduleTest(unittest.TestCase):
    def test_joint_filing_reports_the_group_stake(self):
        ev = parse_schedule(SCHEDULE, "1067983")
        self.assertEqual(
            (ev["kind"], ev["action"], ev["shares_after"], ev["percent_of_class"], ev["cusip"], ev["event_date"]),
            ("13g", "stake_update", 26000, 12.5, "526057104", "2026-09-30"),
        )

    def test_schedule_about_the_manager_itself_is_dropped(self):
        self.assertIsNone(parse_schedule(SCHEDULE, "2"))


if __name__ == "__main__":
    unittest.main()
