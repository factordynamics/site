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
