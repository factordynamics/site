import unittest

from ingest.stocks import roll_up

COLS = ["ticker", "issuer", "title", "cusip", "put_call", "shares", "value"]


def shard(*rows):
    return {"ok": True, "columns": COLS, "rows": [list(r) for r in rows]}


class RollUpTest(unittest.TestCase):
    def test_classes_roll_up_and_options_and_debt_stay_out_of_holders(self):
        got = roll_up([
            shard(("GOOGL", "ALPHABET", "CL A", "02079K305", None, 10, 100),
                  ("GOOG", "ALPHABET", "CL C", "02079K107", None, 5, 60),
                  (None, "ALPHABET", "CALL", "02079K905", None, 1, 7)),
            shard(("GOOG", "ALPHABET", "CL C", "02079K107", None, 2, 20),
                  (None, "ALPHABET", "NOTE 1.1% 2030", "02079KAX5", None, 9, 900),
                  ("GOOGL", "ALPHABET", "CL A", "02079K305", "Put", 3, 30)),
        ])["02079K"]
        # Two filers hold shares (the first holds both classes), one holds calls, one holds puts.
        self.assertEqual(got["equity"], {"holders": 2, "shares": 17, "value": 180})
        self.assertEqual((got["calls"], got["puts"]), ({"holders": 1, "value": 7}, {"holders": 1, "value": 30}))
        self.assertEqual(got["ticker"], "GOOGL")  # the larger class by value


if __name__ == "__main__":
    unittest.main()
