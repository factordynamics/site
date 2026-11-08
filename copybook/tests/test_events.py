import unittest

from ingest.events import clean_ticker, parse_form4, parse_schedule

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

    def test_filings_about_the_managers_own_insiders_are_dropped(self):
        self.assertIsNone(parse_form4(FORM4, "315090"))

    def test_placeholder_symbols_are_not_tickers(self):
        self.assertEqual([clean_ticker(t) for t in ("N/A", "NONE", "brk.b", "", "LEN, LEN.B")],
                         [None, None, "BRK.B", None, "LEN"])


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
