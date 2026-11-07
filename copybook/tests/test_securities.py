import unittest

from ingest.securities import clean_name, sic_sector


class SecuritiesTest(unittest.TestCase):
    def test_display_names_from_raw_13f_issuers(self):
        self.assertEqual(clean_name("BANK OF AMER CORP", expand=True), "Bank of America")
        self.assertEqual(clean_name("OCCIDENTAL PETE CORP", expand=True), "Occidental Petroleum")
        self.assertEqual(clean_name("AMER EXPRESS CO", expand=True), "American Express")
        self.assertEqual(clean_name("BANK OF AMERICA CORP /DE/"), "Bank of America")
        self.assertEqual(clean_name("JPMORGAN CHASE & CO"), "Jpmorgan Chase")
        self.assertEqual(clean_name("Spotify Technology S.A."), "Spotify Technology")
        self.assertEqual(clean_name("AT&T INC."), "AT&T")

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
