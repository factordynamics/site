import unittest

from ingest.securities import clean_name, sic_sector, uncut


class SecuritiesTest(unittest.TestCase):
    def test_display_names_from_raw_13f_issuers(self):
        self.assertEqual(clean_name("BANK OF AMER CORP", expand=True), "Bank of America")
        self.assertEqual(clean_name("OCCIDENTAL PETE CORP", expand=True), "Occidental Petroleum")
        self.assertEqual(clean_name("AMER EXPRESS CO", expand=True), "American Express")
        self.assertEqual(clean_name("BANK OF AMERICA CORP /DE/"), "Bank of America")
        self.assertEqual(clean_name("JPMORGAN CHASE & CO"), "Jpmorgan Chase")
        self.assertEqual(clean_name("Spotify Technology S.A."), "Spotify Technology")
        self.assertEqual(clean_name("AT&T INC."), "AT&T")

    def test_cut_off_issuer_names_drop_the_fragment(self):
        # 13F nameOfIssuer cut mid-suffix: a member's alert showed "Crinetics Pharmaceuticals in".
        self.assertEqual(clean_name(uncut("CRINETICS PHARMACEUTICALS IN"), expand=True), "Crinetics Pharmaceuticals")
        self.assertEqual(clean_name(uncut("TWO HARBORS INVENTMENT CORPO"), expand=True), "Two Harbors Inventment")
        self.assertEqual(uncut("GLOBAL BUSINESS TRAVEL GROUP"), "GLOBAL BUSINESS TRAVEL GROUP")  # whole words stay
        self.assertEqual(uncut("ACME CO IN"), "ACME CO IN")  # short names are not cut ones

    def test_sic_sectors(self):
        self.assertEqual(sic_sector(7320), "Financials")  # Moody's, S&P Global
        self.assertEqual(sic_sector(3674), "Information Technology")
        self.assertEqual(sic_sector(5331), "Consumer Staples")  # Walmart, Costco
        self.assertEqual(sic_sector(6798), "Real Estate")
        self.assertEqual(sic_sector(6311), "Financials")
        self.assertEqual(sic_sector(2834), "Health Care")
        self.assertIsNone(sic_sector(0))


if __name__ == "__main__":
    unittest.main()
