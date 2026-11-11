import unittest

from ingest.alerts import new_filings, next_periods
from ingest.build import expected_report_date, manager_status

NOW = "2026-11-16T22:00:00Z"


def fund(**kw):
    base = {"ok": True, "slug": "warren-buffett", "manager": "Warren Buffett", "name": "Berkshire",
            "quarter": "2026Q3", "report_date": "2026-09-30", "filing_date": "2026-11-16",
            "form": "13F-HR", "accession": "new", "sec_url": "u"}
    return base | kw


class AlertRuleTest(unittest.TestCase):
    def test_new_period_original_filing_alerts(self):
        got = new_filings([fund()], {"warren-buffett": "2026-06-30"}, NOW)
        self.assertEqual([(f["slug"], f["quarter"], f["previous_report_date"]) for f in got],
                         [("warren-buffett", "2026Q3", "2026-06-30")])

    def test_accession_flip_on_old_period_never_alerts(self):
        # Blackstone Nov 7: same Q2 period, accession changed after an amendment.
        old = fund(slug="blackstone-inc", quarter="2026Q2", report_date="2026-06-30", filing_date="2026-08-14")
        self.assertEqual(new_filings([old], {"blackstone-inc": "2026-06-30"}, NOW), [])

    def test_amendments_stale_and_first_seen_never_alert(self):
        prev = {"warren-buffett": "2026-06-30"}
        self.assertEqual(new_filings([fund(form="13F-HR/A")], prev, NOW), [])  # restated base, new period
        self.assertEqual(new_filings([fund(filing_date="2026-08-14")], prev, NOW), [])  # 94 days old
        self.assertEqual(new_filings([fund()], {}, NOW), [])  # fund we have never recorded
        self.assertEqual(new_filings([fund(report_date="2026-03-31")], prev, NOW), [])  # fell back a period

    def test_periods_only_move_forward(self):
        prev = {"warren-buffett": "2026-09-30"}
        self.assertEqual(next_periods([fund(report_date="2026-06-30")], prev), prev)


class StatusTest(unittest.TestCase):
    def q(self, quarter, date, **kw):
        return {"quarter": quarter, "report_date": date, "status": "filed"} | kw

    def test_expected_period_follows_45_day_deadline(self):
        self.assertEqual(expected_report_date("2026-11-08"), "2026-06-30")
        self.assertEqual(expected_report_date("2026-11-15"), "2026-09-30")

    def test_statuses(self):
        today = "2026-11-08"
        self.assertEqual(manager_status([self.q("2026Q2", "2026-06-30")], [], today)["status"], "current")
        self.assertEqual(manager_status([self.q("2026Q2", "2026-06-30")], [], today, "0000947996")["status"], "inactive")  # closed (Olstein)
        self.assertEqual(manager_status([self.q("2026Q1", "2026-03-31")], [], today)["status"], "stale")
        self.assertEqual(manager_status([self.q("2025Q3", "2025-09-30")], [], today)["status"], "stale")  # 3 behind
        self.assertEqual(manager_status([self.q("2025Q2", "2025-06-30")], [], today)["status"], "inactive")  # 4 behind
        self.assertEqual(manager_status([self.q("2022Q2", "2022-06-30")], [], today)["status"], "inactive")  # Spier
        empty = [{"quarter": "2026Q1", "report_date": "2026-03-31", "reason": "empty"}]
        st = manager_status([self.q("2025Q4", "2025-12-31")], empty, today)
        self.assertEqual(st["status"], "empty_latest")
        self.assertIn("2026Q1", st["status_note"])
        notice = self.q("2026Q2", "2026-06-30", status="notice",
                        reported_by={"cik": "0002026053", "name": "PERSHING SQUARE INC."})
        st = manager_status([notice], [], today)
        self.assertEqual(st["status"], "reported_by_other")
        self.assertIn("Pershing Square Inc.", st["status_note"])


if __name__ == "__main__":
    unittest.main()
