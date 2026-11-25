"""SEC request pacing (edgar.interval): the overnight window and its end before EDGAR's 11:00Z morning listing."""

import time
import unittest

from ingest import edgar


def at(h, m):
    return time.struct_time((2026, 11, 20, h, m, 0, 4, 324, 0))


class OvernightRate(unittest.TestCase):
    def setUp(self):
        self.saved = (edgar.MIN_INTERVAL, edgar.NIGHT_INTERVAL)
        edgar.MIN_INTERVAL, edgar.NIGHT_INTERVAL = 0.55, 1.0  # a keepalive run

    def tearDown(self):
        edgar.MIN_INTERVAL, edgar.NIGHT_INTERVAL = self.saved

    def test_window_edges(self):
        self.assertEqual(edgar.interval(at(22, 59)), 0.55)
        self.assertEqual(edgar.interval(at(23, 0)), 1.0)
        self.assertEqual(edgar.interval(at(3, 0)), 1.0)
        self.assertEqual(edgar.interval(at(10, 44)), 1.0)
        self.assertEqual(edgar.interval(at(10, 45)), 0.55)  # daytime rate before the 11:00Z listing

    def test_no_night_rate_set_keeps_the_daytime_rate(self):
        edgar.NIGHT_INTERVAL = None
        self.assertEqual(edgar.interval(at(3, 0)), 0.55)

    def test_a_refusal_reverts_to_the_daytime_rate(self):
        from email.message import Message
        from unittest import mock
        from urllib.error import HTTPError
        refuse = HTTPError("https://www.sec.gov/x", 429, "Too Many Requests", Message(), None)
        with mock.patch.object(edgar, "urlopen", side_effect=refuse), mock.patch.object(edgar, "REFUSED_PAUSE_S", (0, 0)), \
                mock.patch.object(edgar.time, "sleep"), mock.patch.object(edgar, "_refusals", 0):
            with self.assertRaises(Exception):
                edgar.get("https://www.sec.gov/x")
        self.assertIsNone(edgar.NIGHT_INTERVAL)
        self.assertGreaterEqual(edgar.interval(at(3, 0)), 0.55)


if __name__ == "__main__":
    unittest.main()


class InformationTable(unittest.TestCase):
    """fetch_info_table picks the document the filing index types INFORMATION TABLE, whatever its file name."""

    # Knighthead Capital (CIK 1512397) 2026Q3 13F-HR 0001012975-26-001075, as EDGAR lists it.
    BASE = "https://www.sec.gov/Archives/edgar/data/1512397/000101297526001075/"
    INDEX = {"directory": {"item": [{"name": n} for n in (
        "0001012975-26-001075-index-headers.html", "0001012975-26-001075-index.html", "0001012975-26-001075.txt",
        "knighthead_index.xml", "primary_doc.xml")]}}
    PAGE = """<table class="tableFile"><tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td>1</td><td></td><td><a href="x">primary_doc.html</a></td><td>13F-HR</td><td>&nbsp;</td></tr>
<tr><td>1</td><td></td><td><a href="x">primary_doc.xml</a></td><td>13F-HR</td><td>4519</td></tr>
<tr><td>2</td><td></td><td><a href="x">knighthead_index.html</a></td><td>INFORMATION TABLE</td><td>&nbsp;</td></tr>
<tr><td>2</td><td></td><td><a href="x">knighthead_index.xml</a></td><td>INFORMATION TABLE</td><td>6818</td></tr>
</table>"""
    TABLE = "<informationTable><infoTable><cusip>000000000</cusip></infoTable></informationTable>"

    def read(self, pages):
        from unittest import mock
        def get(url, retries=5):
            if url not in pages:
                raise edgar.HTTPError(url, 404, "Not Found", {}, None)
            return pages[url].encode()
        edgar._index_cache.clear()
        with mock.patch.object(edgar, "get", side_effect=get), \
                mock.patch.object(edgar, "fetch_index", return_value=self.INDEX):
            return edgar.fetch_info_table("0001512397", "0001012975-26-001075")

    def test_the_typed_information_table_is_read_whatever_its_name(self):
        pages = {self.BASE + "0001012975-26-001075-index.htm": self.PAGE, self.BASE + "knighthead_index.xml": self.TABLE,
                 self.BASE + "primary_doc.xml": "<edgarSubmission/>"}
        self.assertEqual(self.read(pages), self.TABLE)

    def test_without_types_the_file_name_rule_stands(self):
        # No index page: names decide, as before, and knighthead_index.xml is skipped for "index".
        with self.assertRaises(FileNotFoundError):
            self.read({self.BASE + "knighthead_index.xml": self.TABLE})
