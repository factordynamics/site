import unittest

from ingest.datasets import stock_period
from ingest.stocks import roll_up

COLS = ["ticker", "issuer", "title", "cusip", "put_call", "shares", "value"]


def book(*rows):
    return {"ok": True, "columns": COLS, "rows": [list(r) for r in rows]}


class RollUpTest(unittest.TestCase):
    def test_classes_roll_up_and_options_and_debt_stay_out_of_holders(self):
        got, _ = roll_up({
            "1": book(("GOOGL", "ALPHABET", "CL A", "02079K305", None, 10, 100),
                      ("GOOG", "ALPHABET", "CL C", "02079K107", None, 5, 60),
                      (None, "ALPHABET", "CALL", "02079K905", None, 1, 7)),
            "2": book(("GOOG", "ALPHABET", "CL C", "02079K107", None, 2, 20),
                      (None, "ALPHABET", "NOTE 1.1% 2030", "02079KAX5", None, 9, 900),
                      ("GOOGL", "ALPHABET", "CL A", "02079K305", "PUT", 3, 30)),
        })
        a = got["02079K"]
        # Two filers hold shares (the first holds both classes), one holds calls, one holds puts.
        self.assertEqual((a["equity"]["holders"], a["equity"]["shares"], a["equity"]["value"]), (2, 17, 180))
        self.assertEqual((a["calls"]["holders"], a["puts"]["holders"]), (1, 1))
        self.assertEqual(a["ticker"], "GOOGL")  # the larger class by value

    def test_buyers_sellers_new_and_exited_count_only_filers_with_both_quarters(self):
        now = {
            "a": book(("X", "X", "COM", "111111101", None, 10, 100)),   # added (5 -> 10)
            "b": book(("X", "X", "COM", "111111101", None, 1, 10)),     # trimmed (4 -> 1)
            "c": book(("X", "X", "COM", "111111101", None, 3, 30)),     # new (held nothing in X)
            "d": book(("Y", "Y", "COM", "222222101", None, 1, 1)),      # exited X
            "e": book(("X", "X", "COM", "111111101", None, 7, 70)),     # no prior filing: holder only
        }
        prev = {
            "a": book(("X", "X", "COM", "111111101", None, 5, 40)),
            "b": book(("X", "X", "COM", "111111101", None, 4, 30)),
            "c": book(("Y", "Y", "COM", "222222101", None, 1, 1)),
            "d": book(("X", "X", "COM", "111111101", None, 2, 15)),
            "f": book(("X", "X", "COM", "111111101", None, 9, 90)),     # stopped filing: not an exit
        }
        stats, holders = roll_up(now, prev)
        x = stats["111111"]["equity"]
        self.assertEqual(
            {k: x[k] for k in ("holders", "prev_holders", "buyers", "sellers", "new", "exited", "shares", "prev_shares")},
            {"holders": 4, "prev_holders": 4, "buyers": 1, "sellers": 1, "new": 1, "exited": 1,
             "shares": 21, "prev_shares": 20},
        )
        self.assertEqual(sorted((h[0], h[8]) for h in holders["111111"]),
                         [("a", "added"), ("b", "trimmed"), ("c", "new"), ("d", "exited"), ("e", None)])


    def test_split_adjusted_prior_shares_are_not_buys(self):
        now = {"a": book(("C", "C", "COM", "22788C105", None, 400, 100)), "b": book(("C", "C", "COM", "22788C105", None, 500, 125))}
        prev = {"a": book(("C", "C", "COM", "22788C105", None, 100, 90)), "b": book(("C", "C", "COM", "22788C105", None, 100, 90))}
        e = roll_up(now, prev, ratio=lambda c, pc: 4)[0]["22788C"]["equity"]
        self.assertEqual((e["buyers"], e["sellers"], e["unchanged"], e["net_shares"]), (1, 0, 1, 100))


class StockPeriodTest(unittest.TestCase):
    def test_period_moves_three_days_after_the_45_day_deadline(self):
        from datetime import date
        self.assertEqual(stock_period(date(2026, 11, 8)), "2026Q2")   # Q3 due Nov 14
        self.assertEqual(stock_period(date(2026, 11, 16)), "2026Q2")
        self.assertEqual(stock_period(date(2026, 11, 17)), "2026Q3")
        self.assertEqual(stock_period(date(2027, 2, 20)), "2026Q4")   # Q4 due Feb 14


if __name__ == "__main__":
    unittest.main()
