import unittest
from types import SimpleNamespace as M

from unittest import mock

from ingest import build
from ingest.build import merge_quarter, pick_filings


def f(acc, form, filed):
    return M(accession=acc, form=form, filing_date=filed, report_date="2025-03-31")


class AmendmentTest(unittest.TestCase):
    def test_new_holdings_amendment_adds_to_original(self):
        # Buffett 2025Q1: original in May, 4-line NEW HOLDINGS /A in August.
        orig, add = f("o", "13F-HR", "2025-05-15"), f("a", "13F-HR/A", "2025-08-14")
        base, extra = pick_filings([add, orig], {"a": "NEW HOLDINGS"})
        self.assertEqual((base.accession, [m.accession for m in extra]), ("o", ["a"]))

    def test_restatement_replaces_and_drops_earlier_additions(self):
        orig = f("o", "13F-HR", "2025-05-15")
        add = f("a", "13F-HR/A", "2025-06-01")
        rest = f("r", "13F-HR/A", "2025-07-01")
        late = f("b", "13F-HR/A", "2025-08-01")
        types = {"a": "NEW HOLDINGS", "r": "RESTATEMENT", "b": "NEW HOLDINGS"}
        base, extra = pick_filings([late, rest, add, orig], types)
        self.assertEqual((base.accession, [m.accession for m in extra]), ("r", ["b"]))

    def test_new_holdings_amendment_that_refiles_the_whole_book_replaces_it(self):
        # First Eagle 2026Q2: a NEW HOLDINGS /A repeating the whole book doubled it ($59.9B + $60.8B).
        def book(acc, rows, at):
            hs = [{"issuer": c, "title": "COM", "cusip": c, "ticker": None, "value": v, "shares": n, "put_call": None,
                   "shares_type": "SH", "source_accession": acc, "first_disclosed_at": at} for c, n, v in rows]
            return {"accession": acc, "total_value": sum(h["value"] for h in hs), "holdings": hs, "line_count": len(hs)}
        orig = book("o", [("GOOG", 7_300_000, 600), ("A", 10, 300), ("B", 5, 100)], "2026-08-14T20:00:00Z")
        refile = book("r", [("GOOG", 7_300_000, 610), ("A", 10, 300), ("B", 5, 100), ("C", 1, 5)], "2026-09-01T20:00:00Z")
        small = book("s", [("D", 3, 50)], "2026-10-01T20:00:00Z")  # a genuine late disclosure stays additive
        loads = {"o": orig, "r": refile, "s": small}
        group = [f("o", "13F-HR", "2026-08-14"), f("r", "13F-HR/A", "2026-09-01"), f("s", "13F-HR/A", "2026-10-01")]
        for m in group:
            m.accepted_at = ""
        with mock.patch.object(build, "load_filing", side_effect=lambda cik, m: loads[m.accession]), \
                mock.patch.object(build, "amend_cover", return_value={"type": "NEW HOLDINGS", "no": 1,
                                                                    "confidential_treatment_expired": False}):
            q = build.load_period("1", group, {})
        by = {h["cusip"]: h for h in q["holdings"]}
        self.assertEqual((by["GOOG"]["shares"], q["total_value"]), (7_300_000, 1065))
        self.assertEqual((by["GOOG"]["first_disclosed_at"], by["C"]["source_accession"], by["D"]["source_accession"]),
                         ("2026-08-14T20:00:00Z", "r", "s"))
        roles = {t["accession"]: (t["role"], t.get("mislabeled_amendment")) for t in q["filings"]}
        self.assertEqual(roles, {"o": ("superseded", None), "r": ("base", True), "s": ("addition", None)})

    def test_data_set_books_do_not_double_count_a_refiled_amendment(self):
        from ingest import datasets
        row = lambda c, n, v: [c, "COM", c, None, n, v, "SH"]
        books = {"o": {(c, "", "SH"): row(c, n, v) for c, n, v in (("A", 10, 300), ("B", 5, 100))},
                 "r": {(c, "", "SH"): row(c, n, v) for c, n, v in (("A", 10, 300), ("B", 5, 100), ("C", 1, 5))},
                 "s": {("D", "", "SH"): row("D", 3, 50)}}
        meta = lambda a, d: {"accession": a, "cik": "1", "name": "X", "form": "13F-HR", "filing_date": d}
        b = datasets.book("2026Q2", meta("o", "2026-08-14"), [meta("r", "2026-09-01"), meta("s", "2026-10-01")],
                          books, {})
        self.assertEqual((b["total_value"], b["accession"], b["superseded"], b["amendments"]), (455, "r", ["o"], ["s"]))

    def test_data_set_book_rows_carry_unit_fields_and_their_filing(self):
        # LSV 2026Q1 filed its values in thousands: Mueller (624756102) 161,799 is $161,799,000.
        from ingest import datasets
        row = lambda c, n, v: [c, "COM", c, None, n, v, "SH"]
        o = {(c, "", "SH"): row(c, 1_000_000, 100_000 + i) for i, c in enumerate(["624756102", "B", "C", "D", "E"])}
        o[("624756102", "", "SH")] = row("624756102", 1_500_000, 161_799)
        books = {"o": o, "a": {("F", "", "SH"): row("F", 1_000, 50)}}
        meta = lambda a, d: {"accession": a, "cik": "1", "name": "X", "form": "13F-HR", "filing_date": d}
        b = datasets.book("2026Q1", meta("o", "2026-05-14"), [meta("a", "2026-06-01")], books, {})
        rows = {r[3]: dict(zip(b["columns"], r)) for r in b["rows"]}
        m = rows["624756102"]
        self.assertEqual((m["value"], m["value_as_filed"], m["value_scale"], m["value_adjusted"], m["source_accession"]),
                         (161_799_000, 161_799, 1000.0, True, "o"))
        self.assertEqual(rows["F"]["source_accession"], "a")  # the amendment that added it

    def test_lone_additive_amendment_is_not_a_book(self):
        self.assertEqual(pick_filings([f("a", "13F-HR/A", "2025-08-14")], {"a": "NEW HOLDINGS"}), (None, []))

    def test_merge_sums_overlaps_and_reweights(self):
        h = lambda c, v, pc=None: {"cusip": c, "put_call": pc, "value": v, "shares": v, "weight": 0}
        base = {"accession": "o", "line_count": 2, "holdings": [h("X", 300), h("Y", 100)]}
        add = {"accession": "a", "line_count": 2, "holdings": [h("Y", 50), h("Z", 50, "Put")]}
        q = merge_quarter(base, [add])
        self.assertEqual([(r["cusip"], r["value"]) for r in q["holdings"]], [("X", 300), ("Y", 150), ("Z", 50)])
        self.assertEqual((q["total_value"], q["position_count"], q["amendments"]), (500, 3, ["a"]))
        # One weight definition: share positions only; the put is notional, outside the denominator.
        x, y, z = q["holdings"]
        self.assertEqual((x["pct_of_book"], x["weight"], z["pct_of_book"], z["notional_pct_of_book"]),
                         (0.666667, 0.666667, None, 0.111111))
        # Z was first disclosed by the amendment; Y existed in the original and keeps it as its source.
        self.assertEqual((z.get("late_disclosure"), y.get("late_disclosure")), (True, None))


if __name__ == "__main__":
    unittest.main()


class ConsolidatedRefilingTest(unittest.TestCase):
    def test_same_total_fewer_lines_replaces(self):
        from ingest.build import is_refiled_book
        h = lambda c, v: {"cusip": c, "put_call": None, "value": v}
        book = {"total_value": 100.0, "holdings": [h(f"C{i:08d}", 100 / 53) for i in range(53)]}
        refile = {"total_value": 99.0, "holdings": [h(f"C{i:08d}", 99 / 17) for i in range(17)]}
        addition = {"total_value": 62.0, "holdings": [h(f"C{i:08d}", 62 / 17) for i in range(17)]}
        self.assertTrue(is_refiled_book(book, [], refile))
        self.assertFalse(is_refiled_book(book, [], addition))


class RowProvenanceTest(unittest.TestCase):
    def test_full_books_get_source_and_disclosure_time_per_row(self):
        # A NEW HOLDINGS amendment's row is disclosed at the amendment's acceptance, not the original's.
        import json, tempfile, time
        from pathlib import Path
        from ingest import accepted
        cols = ["ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type"]
        plain = {"ok": True, "cik": "0000000001", "accession": "0000000001-26-000001", "columns": list(cols),
                 "rows": [["AAA", "A", "COM", "000000AAA", None, 10, 100, "SH"]]}
        amended = {"ok": True, "cik": "0000000002", "accession": "0000000002-26-000001",
                   "amendments": ["0000000002-26-000009"], "columns": list(cols),
                   "rows": [["BBB", "B", "COM", "000000BBB", None, 10, 100, "SH"],
                            ["CCC", "C", "COM", "000000CCC", "Call", 1, 5, "SH"]]}
        cache = {"0000000001-26-000001": "2026-11-12T21:05:00Z", "0000000002-26-000001": "2026-08-14T20:00:00Z",
                 "0000000002-26-000009": "2026-09-30T13:00:00Z"}
        listed = {("000000BBB", ""): "0000000002-26-000001", ("000000CCC", "call"): "0000000002-26-000009"}
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "fb" / "2026Q3").mkdir(parents=True)
            for b in (plain, amended):
                (Path(d) / "fb" / "2026Q3" / f"{b['cik']}.json").write_text(json.dumps(b))
            with mock.patch.object(accepted, "DATA", Path(d)), mock.patch.object(accepted, "first_listed", return_value=listed):
                self.assertEqual(accepted.fill_rows(cache, time.monotonic()), (2, 0))
            got = {cik: json.loads((Path(d) / "fb" / "2026Q3" / f"{cik}.json").read_text()) for cik in ("0000000001", "0000000002")}
        self.assertEqual(got["0000000001"]["columns"][-2:], ["source_accession", "first_disclosed_at"])
        self.assertEqual(got["0000000001"]["rows"][0][-2:], ["0000000001-26-000001", "2026-11-12T21:05:00Z"])
        self.assertEqual([r[-2:] for r in got["0000000002"]["rows"]],
                         [["0000000002-26-000001", "2026-08-14T20:00:00Z"], ["0000000002-26-000009", "2026-09-30T13:00:00Z"]])


class UnitFieldsTest(unittest.TestCase):
    def test_value_scale_and_adjusted_per_row_survive_an_amendment_merge(self):
        # A book filed in thousands (scale 1000) with one line filed in dollars (rescaled back, scale 1),
        # plus a NEW HOLDINGS amendment filed in dollars that adds to the first line.
        row = lambda c, v, filed: {"cusip": c, "put_call": None, "shares_type": "SH", "shares": 10.0, "value": v,
                                   "value_as_filed": filed}
        base = {"accession": "o", "holdings": [row("A", 5_000_000.0, 5_000.0), row("B", 2_000.0, 2_000.0)]}
        add = {"accession": "a", "holdings": [row("A", 1_000_000.0, 1_000_000.0)]}
        q = build.merge_quarter(base, [add])
        build.stamp_units([{"history": [q]}])
        got = {h["cusip"]: (h["value_as_filed"], h["value_scale"], h["value_adjusted"]) for h in q["holdings"]}
        self.assertEqual(got["B"], (2_000.0, 1.0, False))
        self.assertEqual(got["A"], (1_005_000.0, float(f"{6_000_000 / 1_005_000:.6g}"), True))
        v1 = build.v1_position(q["holdings"][1])
        self.assertEqual((v1["value_as_filed"], v1["value_scale"], v1["value_adjusted"]), (2_000.0, 1.0, False))
