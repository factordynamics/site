import json
import unittest

from ingest import build
from ingest.build import baseline, with_changes
from ingest.enrich import quarter_csv


def row(cusip, shares, value, put_call=None):
    return {"issuer": cusip, "title": "COM", "cusip": cusip, "ticker": None,
            "value": value, "shares": shares, "put_call": put_call, "weight": 0}


class ChangesTest(unittest.TestCase):
    def test_quarter_over_quarter(self):
        latest = {"holdings": [row("A", 10, 100), row("B", 5, 50), row("C", 7, 70),
                               row("D", 3, 30), row("A", 1, 9, "Put")]}
        prev = {"holdings": [row("A", 8, 90), row("B", 9, 80), row("C", 7, 60),
                             row("E", 4, 40), row("A", 2, 5, "Call")]}
        got = [(r["cusip"], r["put_call"], r["change"], r["prev_shares"], r["value"])
               for r in with_changes(latest, prev)]
        self.assertEqual(got, [
            ("A", None, "added", 8, 100),
            ("B", None, "trimmed", 9, 50),
            ("C", None, "unchanged", 7, 70),  # value moved, shares did not
            ("D", None, "new", 0, 30),
            ("A", "Put", "new", 0, 9),
            ("E", None, "exited", 4, 0),
            ("A", "Call", "exited", 2, 0),
        ])

    def test_trade_size_uses_this_filings_price_not_the_value_change(self):
        latest = {"holdings": [row("A", 10, 100), row("B", 5, 50), row("C", 7, 70), row("D", 3, 30)],
                  "total_value": 250}
        prev = {"holdings": [row("A", 8, 90), row("B", 9, 80), row("C", 7, 60), row("E", 4, 40)],
                "total_value": 270}
        got = {r["cusip"]: (r["value_delta"], r["delta_pct_of_book"]) for r in with_changes(latest, prev)}
        # A: +2 sh at $10 = +20 (not 100-90); B: -4 sh at $10 = -40 (not 50-80); C: price only = 0.
        self.assertEqual(got, {"A": (20, 0.08), "B": (-40, -0.16), "C": (0, 0.0), "D": (30, 0.12),
                               "E": (-40, -0.16)})

    def test_split_confirmation_reads_the_first_cover_after_the_quarter(self):
        # APH 2:1 in Q3 2026: the Q2 10-Q cover (Jul 28) is still pre-split; the Q3 cover (Oct 27) shows it.
        from unittest import mock
        from ingest import splits
        series = [("2026-04-28", 1230234445.0), ("2026-07-28", 1232983457.0), ("2026-10-27", 2469261188.0)]
        with mock.patch.object(splits, "_shares_outstanding", return_value=series):
            self.assertAlmostEqual(splits.xbrl_ratio("820313", "2026Q2", "2026Q3"), 2.007, places=3)

    def test_split_adjusts_the_prior_quarter_before_comparing(self):
        # CRWD-style 4:1 split: 100 -> 400 shares is unchanged, 100 -> 500 is +100, not +400.
        build.SPLITS.clear()
        build.SPLITS.update({"S": {"2026Q3": 4}})
        try:
            latest = {"quarter": "2026Q3", "holdings": [row("S", 400, 400), row("S", 20, 20, "CALL")]}
            prev = {"quarter": "2026Q2", "holdings": [row("S", 100, 380), row("S", 5, 19, "CALL")]}
            got = {(r["put_call"], r["change"], r["prev_shares"], r["share_change"], r["value_delta"])
                   for r in with_changes(latest, prev)}
            self.assertEqual(got, {(None, "unchanged", 400, 0, 0), ("CALL", "unchanged", 20, 0, 0)})
            latest["holdings"][0] = row("S", 500, 500)
            r = with_changes(latest, prev)[0]
            self.assertEqual((r["change"], r["share_change"], r["value_delta"], r["prev_shares_as_filed"],
                              r["split"]["ratio"]), ("added", 100, 100, 100, 4))
        finally:
            build.SPLITS.clear()

    def test_prior_quarter_is_taken_as_known_when_this_quarter_was_filed(self):
        # Berkshire 2025Q1: LEN disclosed by an amendment accepted after the Q2 original.
        late = row("L", 10, 10) | {"first_disclosed_at": "2025-08-14T20:10:02Z", "late_disclosure": True}
        q1 = {"quarter": "2025Q1", "holdings": [row("A", 5, 5) | {"first_disclosed_at": "2025-05-15T20:06:43Z"}, late]}
        q2 = {"quarter": "2025Q2", "accepted_at": "2025-08-14T20:05:04Z",
              "holdings": [row("A", 5, 5), row("L", 10, 10)]}
        got = {r["cusip"]: r["change"] for r in with_changes(q2, q1)}
        self.assertEqual(got, {"A": "unchanged", "L": "new"})  # not public yet when Q2 was filed
        q0 = {"quarter": "2024Q4", "holdings": [row("A", 5, 5)]}
        got = {r["cusip"]: (r["change"], r["value_delta"]) for r in with_changes(q1, q0)}
        self.assertEqual(got, {"A": ("unchanged", 0), "L": ("disclosed_later", 0)})  # not "new" in Q1

    def test_principal_amount_notes_are_never_shares(self):
        note = lambda amt, v: row("N", 0, v) | {"shares_type": "PRN", "principal_amount": amt}
        r = with_changes({"holdings": [note(2000, 210)]}, {"holdings": [note(1000, 100)]})[0]
        self.assertEqual((r["change"], r["share_change"], r["prev_shares"], r["prev_principal_amount"],
                          r["value_delta"]), ("added", None, 0, 1000, 105))

    def test_quarters_two_filers_both_filed_are_one_combined_book(self):
        # Ackman: Pershing Square Capital (a) and Pershing Square Inc. (p) both filed 2026Q1 (18M + 9M HHH);
        # from 2026Q2 Pershing Square Inc. reports the fund (27M). Neither page may show a 9M buy.
        q = lambda qq, d, st, n, **kw: {"quarter": qq, "report_date": d, "status": st, "holdings": [row("H", n, n)],
                                         "total_value": n, **kw}
        own_a = q("2026Q1", "2026-03-31", "filed", 18)
        own_p = q("2026Q1", "2026-03-31", "filed", 9, cik="p", name="P")
        fund = {"slug": "a", "cik": "a", "ok": True, "history": [
            q("2026Q2", "2026-06-30", "notice", 27), build.combine_books(own_a, own_p) | {"total_value": 27}]}
        reporter = {"slug": "p", "cik": "p", "ok": True, "history": [
            q("2026Q2", "2026-06-30", "filed", 27), own_p]}
        build.OWN_BOOKS[("a", "2026-03-31")] = own_a
        try:
            build.share_reporter_books({"managers": [fund, reporter]})
            for m in (fund, reporter):
                r = with_changes(m["history"][0], baseline(m, 0))[0]
                self.assertEqual((m["slug"], r["change"], r["prev_shares"], r["value_delta"]),
                                 (m["slug"], "unchanged", 27, 0))
            self.assertEqual(reporter["history"][1]["combined_with"]["cik"], "a")
        finally:
            build.OWN_BOOKS.clear()

    def test_no_baseline_from_another_filers_book_or_across_a_gap(self):
        # MFG filed its own 2026Q2 after 13F-NTs whose 2026Q1 book was Mizuho Bank's 13F-HR; FMR skipped 2025Q2.
        q = lambda qq, st="filed", **kw: {"quarter": qq, "status": st, "holdings": [row("H", 1, 1)], "total_value": 1, **kw}
        bank = {"cik": "0001512734", "name": "Mizuho Bank"}
        mfg = {"cik": "0001335730", "history": [q("2026Q2"), q("2026Q1", "notice", reported_by=bank)]}
        self.assertIsNone(baseline(mfg, 0))
        succession = {"cik": "0001335730", "history": [q("2026Q2", "notice", reported_by=bank),
                                                        q("2026Q1", "notice", reported_by=bank)]}
        self.assertEqual(baseline(succession, 0)["quarter"], "2026Q1")
        gap = {"cik": "0000315066", "history": [q("2025Q3"), q("2025Q1")]}
        self.assertIsNone(baseline(gap, 0))
        self.assertEqual(baseline({"cik": "1", "history": [q("2026Q1"), q("2025Q4")]}, 0)["quarter"], "2025Q4")

    def test_prior_disclosed_only_after_this_filing_is_no_prior(self):
        # Norges Bank 2025Q2 (accepted 2025-08-13) against 2025Q1, disclosed by amendment on 2026-05-11.
        r = row("H", 1, 1)
        late = {"quarter": "2025Q1", "status": "filed", "total_value": 1, "holdings": [r | {"first_disclosed_at": "2026-05-11"}]}
        cur = {"quarter": "2025Q2", "status": "filed", "total_value": 1, "accepted_at": "2025-08-13", "holdings": [r]}
        self.assertIsNone(baseline({"cik": "1", "history": [cur, late]}, 0))
        on_time = late | {"holdings": [r | {"first_disclosed_at": "2025-05-13"}]}
        self.assertEqual(baseline({"cik": "1", "history": [cur, on_time]}, 0)["quarter"], "2025Q1")

    def test_no_prior_filing_is_unknown_not_new(self):
        self.assertEqual({r["change"] for r in with_changes({"holdings": [row("A", 1, 1)]}, None)}, {None})


class QuarterCsvTest(unittest.TestCase):
    def test_csv_contract_for_copy_api(self):
        q = {"manager": "M", "slug": "m", "cik": "1", "quarter": "2026Q2", "report_date": "2026-06-30",
             "filing_date": "2026-08-14", "accession": "a",
             "holdings": [{"ticker": None, "issuer": 'A, "B"', "cusip": "c", "title": "COM",
                           "put_call": None, "shares": 10.0, "value": 2500.0, "weight": 0.5, "pct_of_book": 0.5,
                           "change": "added", "prev_shares": 4, "share_change": 6, "value_delta": 1500,
                           "delta_pct_of_book": 0.3, "shares_type": "SH", "split": {"ratio": 2},
                           "prev_shares_as_filed": 2, "source_accession": "a",
                           "first_disclosed_at": "2026-08-14T20:05:04Z", "discretion": "SOLE",
                           "other_managers": ["1", "2"], "vote_sole": 10, "vote_shared": 0, "vote_none": 0}],
             "exited": [{"ticker": "X", "issuer": "X", "cusip": "x", "title": "NOTE", "put_call": None,
                         "shares": 0, "value": 0, "weight": 0.0, "change": "exited", "prev_shares": 0,
                         "share_change": None, "value_delta": -90, "delta_pct_of_book": -0.018,
                         "shares_type": "PRN"}]}
        lines = quarter_csv(q).split("\r\n")
        self.assertEqual(lines[0].split(",")[:20], [
            "manager", "slug", "cik", "quarter", "report_date", "filing_date", "accession", "ticker", "issuer",
            "cusip", "title", "put_call", "shares", "value_usd", "weight",
            "change", "prev_shares", "share_change", "value_delta_usd", "delta_pct_of_book"])
        self.assertEqual(
            lines[1],
            'M,m,1,2026Q2,2026-06-30,2026-08-14,a,,"A, ""B""",c,COM,,10,2500,0.5,added,4,6,1500,0.3,'
            "0.5,SH,,2,2,a,2026-08-14T20:05:04Z,,SOLE,1 2,10,0,0",
        )
        # A note's share change is blank, never a share count.
        self.assertEqual(lines[2].split(",")[15:22], ["exited", "0", "", "-90", "-0.018", "", "PRN"])
        self.assertEqual(lines[3], "")


if __name__ == "__main__":
    unittest.main()


class MoveMathTest(unittest.TestCase):
    """CUSIP reissues and mis-scaled filings must not turn into trades."""

    def setUp(self):
        # Links apply only once their share units checked out on the holders (splits.link_check).
        checked = {"ratio": 1, "units_basis": "holders_1to1", "basis": "sec_13f_list"}
        build._LINKS = {o: {"old": o, "new": n} | checked for o, n in
                        (("30231G102", "30233Q108"), ("682680103", "30609A109"), ("881624209", "M8769Q102"))}
        self.addCleanup(build.reload_links)

    def row(self, cusip, ticker, shares, value, title="COM"):
        return {"issuer": "X", "title": title, "cusip": cusip, "ticker": ticker, "value": float(value),
                "shares": float(shares), "put_call": None, "shares_type": "SH"}

    def test_reissued_cusip_is_one_position(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("30231G102", "XOM", 31468114, 4302320615)]}
        cur = {"quarter": "2026Q3", "accepted_at": "2026-11-01", "holdings": [self.row("30233Q108", "XOM", 31933523, 5197180970)]}
        rows = build.with_changes(cur, prev)
        self.assertEqual([r["change"] for r in rows], ["added"])
        self.assertEqual(rows[0]["prev_cusip"], "30231G102")
        # Fisher's XOM: the trade is the share change at Q3's price (+465,409 sh x $162.75 = +$75.7M),
        # not the change in reported value ($5.20B - $4.30B = +$894.9M, mostly the price move).
        self.assertEqual(rows[0]["share_change"], 465409)
        self.assertEqual(rows[0]["prev_shares_as_filed"], 31468114)  # no split: the filed prior, equal to prev_shares
        self.assertAlmostEqual(rows[0]["value_delta"], 465409 * 5197180970 / 31933523, delta=1)

    def test_filed_split_applies_even_with_the_price_unchanged(self):
        # HON 2026Q2: 1-for-2 reverse split (8-K) on the day of a spin-off, so the price per share barely moved.
        # BlackRock 48,831,876 -> 22,778,297 is a trim of about 1.64M split-adjusted shares, not a 53% sale.
        build._LINKS["438516106"] = {"old": "438516106", "new": "438516205", "ratio": 0.5,
                                     "units_basis": "split_confirmed", "basis": "sec_13f_list"}
        build.SPLITS["438516205"] = {"2026Q2": 0.5}
        self.addCleanup(build.SPLITS.pop, "438516205")
        prev = {"quarter": "2026Q1", "holdings": [self.row("438516106", "HON", 48_831_876, 48_831_876 * 200)]}
        cur = {"quarter": "2026Q2", "holdings": [self.row("438516205", "HON", 22_778_297, 22_778_297 * 198)]}
        r = build.with_changes(cur, prev)[0]
        self.assertEqual((r["change"], r["prev_shares"], r["share_change"]), ("trimmed", 24_415_938, -1_637_641))
        # Newport Trust still reported the pre-split count under the new CUSIP: no 2x purchase, flagged instead.
        prev = {"quarter": "2026Q1", "holdings": [self.row("438516106", "HON", 6_432_598, 6_432_598 * 200)]}
        cur = {"quarter": "2026Q2", "holdings": [self.row("438516205", "HON", 6_432_598, 6_432_598 * 198)]}
        r = build.with_changes(cur, prev)[0]
        self.assertEqual((r["change"], r["suspect_units"], r["suspect_reason"], r["value_delta"]),
                         (None, True, "reissue_ratio_not_applied", 0))

    def test_reissue_links_only_through_cusip_links(self):
        # ONEOK 682680103 -> 30609A109 (SEC 13(f) list, 2026Q3), across free-text titles.
        prev = {"quarter": "2026Q2", "holdings": [self.row("682680103", "OKE", 1000, 80000, title="cs")]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("30609A109", "OKE", 1000, 90000, title="COM")]}
        self.assertEqual([(r["change"], r.get("prev_cusip")) for r in build.with_changes(cur, prev)],
                         [("unchanged", "682680103")])
        # A shared ticker alone never links (a SPAC's units and shares): an exit and a new line, as filed.
        cur = {"quarter": "2026Q3", "holdings": [self.row("682680999", "OKE", 1000, 90000, title="COM")]}
        self.assertEqual(sorted(r["change"] for r in build.with_changes(cur, prev)), ["exited", "new"])
        # Both codes in one book (IFP Advisors 2026Q3 TEVA): the new code continues the old position; the stale old
        # line is suspect_duplicate with no change, never summed or sold.
        prev = {"quarter": "2026Q2", "holdings": [self.row("881624209", "TEVA", 143_000, 2.6e6)]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("881624209", "TEVA", 143_891, 2.9e6),
                                                 self.row("M8769Q102", "TEVA", 143_876, 2.9e6)]}
        got = {r["cusip"]: r for r in build.with_changes(cur, prev)}
        self.assertEqual(len(got), 2)
        self.assertEqual((got["M8769Q102"]["change"], got["M8769Q102"]["prev_cusip"], got["M8769Q102"]["share_change"]),
                         ("added", "881624209", 876))
        self.assertEqual((got["881624209"]["change"], got["881624209"]["suspect_duplicate"]), (None, True))
        rows = build.with_changes(cur, prev)
        self.assertEqual(build.moves(rows)["bought_usd"], round(got["M8769Q102"]["value_delta"]))  # fund-page moves

    def test_reissue_link_needs_the_sec_13f_list_and_never_joins_units(self):
        from ingest.moves import on_list
        lists = {"2026Q3": {"30231G102": ("D", "COM"), "30233Q108": ("A", "COM SHS"),
                            "G4365S128": ("", "UNIT 01/20/2031"), "G4365S102": ("A", "ORD USD CL A"),
                            "46438R105": ("", "SHS")}}
        self.assertEqual(on_list("30231G102", "30233Q108", lists), "2026Q3")
        self.assertIsNone(on_list("G4365S128", "G4365S102", lists))  # SPAC unit and its class A both still trade
        self.assertIsNone(on_list("46438R105", "46438R204", lists))  # new CUSIP on no list
        lists["2026Q3"]["G4365S128"] = ("D", "UNIT 01/20/2031")
        self.assertIsNone(on_list("G4365S128", "G4365S102", lists))  # units never link, even when deleted

    def test_line_far_off_the_cross_filer_price_is_suspect(self):
        # AllianceBernstein 2026Q2 KLAC: $1,472 a share against a $301.71 median across filers.
        prev = {"quarter": "2026Q1", "holdings": [self.row("482480100", "KLAC", 7_000_000, 7e9)]}
        cur = {"quarter": "2026Q2", "holdings": [self.row("482480100", "KLAC", 7_472_826, 11.0e9)]}
        build.CONSENSUS.update({("2026Q1", "482480100"): 1000.0, ("2026Q2", "482480100"): 301.71})
        try:
            self.assertTrue(build.with_changes(cur, prev)[0].get("suspect_units"))
            self.assertEqual(build.with_changes(cur, prev)[0]["suspect_reason"], "cross_filer")
            # Geode SION: this line at the peer median, its prior quarter's line 3.5x off: flagged for the prior.
            odd_prev = {"quarter": "2026Q1", "holdings": [self.row("482480100", "KLAC", 2_000_000, 7e9)]}
            sion = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("482480100", "KLAC", 36_459_000, 11.0e9)]}, odd_prev)[0]
            self.assertEqual((sion["suspect_units"], sion["suspect_reason"]), (True, "cross_filer_prior"))
            cur["holdings"] = [self.row("482480100", "KLAC", 36_459_000, 11.0e9)]  # priced like its peers
            self.assertIs(build.with_changes(cur, prev)[0].get("suspect_units"), False)  # checked: false, not null
            # UBS 2026Q3: a book with no stored prior was served without any check; the cross-filer check still runs.
            only = build.with_changes(cur, None)[0]
            self.assertEqual((only["suspect_units"], only["suspect_units_basis"], only["change"]), (False, "filers", None))
            # Late-disclosed lines are share lines too.
            late = build.with_changes({"quarter": "2026Q2", "accepted_at": "2026-08-14",
                                       "holdings": [self.row("482480100", "KLAC", 7_472_826, 11.0e9) | {"late_disclosure": True}]}, prev)[0]
            self.assertEqual((late["change"], late["suspect_units"]), ("disclosed_later", True))
            # No median for the CUSIP: the filer's own prior decides (GuardCap BKNG: $188 -> $5,138 a share).
            own = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 1_304, 6.7e6)]},
                                     {"quarter": "2026Q1", "holdings": [self.row("09857L108", "BKNG", 646_216, 121.6e6)]})[0]
            self.assertEqual((own["suspect_units"], own["suspect_units_basis"], own["suspect_reason"]), (True, "own_prior", "own_prior"))
            # Neither can run (a new line with no median), or not a share line: null, and the basis says why.
            new = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("000000001", "NEW", 10, 1e3)]}, prev)
            self.assertEqual([(r["suspect_units"], r["suspect_units_basis"]) for r in new if r["change"] == "new"], [(None, "none")])
            opt = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("482480100", "KLAC", 1e5, 3e7) | {"put_call": "CALL"}]}, prev)[0]
            self.assertEqual((opt["suspect_units"], opt["suspect_units_basis"]), (None, "none"))
        finally:
            build.CONSENSUS.clear()

    def test_stale_split_field_is_not_kept(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("037833100", "AAPL", 100, 20000)]}
        stale = self.row("037833100", "AAPL", 120, 25000) | {
            "split": {"ratio": 2.0, "from_quarter": "2026Q2", "to_quarter": "2026Q3"}, "prev_shares_as_filed": 100}
        rows = build.with_changes({"quarter": "2026Q3", "holdings": [stale]}, prev)
        self.assertNotIn("split", rows[0])
        self.assertEqual((rows[0]["prev_shares"], rows[0]["change"]), (100, "added"))

    def test_holder_weights_use_the_share_book(self):
        # Amundi CMG: $410.8M over the SH book reads 0.000924; over the total with $51.4B of notes, 0.000828.
        import tempfile
        from pathlib import Path as P
        from ingest import moves
        cols = ["ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type"]
        rows = [["CMG", "X", "COM", "169656105", None, 100, 400.0, "SH"],
                [None, "X", "NOTE 1%", "123456AB1", None, 50, 51.0, "PRN"],
                ["CMG", "X", "COM", "169656105", "Call", 10, 30.0, "SH"]]
        with tempfile.TemporaryDirectory() as d:
            old = moves.DATA
            moves.DATA = P(d)
            try:
                for q in ("2026Q2", "2026Q3"):
                    (P(d) / "fb" / q).mkdir(parents=True)
                    (P(d) / "fb" / q / "0000000001.json").write_text(json.dumps(
                        {"ok": True, "quarter": q, "columns": cols, "rows": rows}))
                moves.changes({"ok": True, "cik": "0000000001", "quarter": "2026Q3"})
                self.assertEqual(moves.EQUITY["0000000001"], 400)
            finally:
                moves.DATA = old
                moves.EQUITY.clear()

    def test_gate_refuses_a_parent_book_merged_in(self):
        import tempfile
        from pathlib import Path as P
        from ingest import gate
        with tempfile.TemporaryDirectory() as d:
            def put(slug, q, body):
                (P(d) / slug).mkdir(exist_ok=True)
                (P(d) / slug / f"{q}.json").write_text(json.dumps(body))
            # Amundi files its own 13F; Credit Agricole (named on a 2021 notice) files its own too.
            put("amundi", "2026Q2", {"cik": "0001330387", "combined_with": {"cik": "0001191672", "accession": "0001172661-26-003711"}})
            put("amundi", "2026Q3", {"cik": "0001330387"})
            # Pershing Square Capital stopped filing; Pershing Square Inc. reports for it (a succession).
            put("psi", "2025Q4", {"cik": "0002021365", "combined_with": {"cik": "0001336528", "accession": "x"}})
            put("ackman", "2026Q1", {"cik": "0001336528", "status": "successor", "reported_by": {"cik": "0002021365"}})
            bad = gate.foreign_merges(P(d))
            self.assertEqual(len(bad), 1)
            self.assertIn("amundi 2026Q2", bad[0])

    def test_gate_refuses_unapplied_split(self):
        import tempfile
        from pathlib import Path as P
        from ingest import gate
        with tempfile.TemporaryDirectory() as d:
            (P(d) / "splits.json").write_text(json.dumps({"splits": [{"cusip": "032095101", "to_quarter": "2026Q3", "ratio": 2.0}]}))
            aph = self.row("032095101", "APH", 10708713, 902.6e6) | {"change": "added", "prev_value": 820.3e6}
            split = {"ratio": 2.0, "from_quarter": "2026Q2", "to_quarter": "2026Q3"}
            ok = aph | {"prev_shares": 9733376, "prev_shares_as_filed": 4866688, "split": split}
            unadjusted = aph | {"prev_shares": 4866688, "prev_shares_as_filed": 4866688, "split": split}
            unmarked = aph | {"prev_shares": 4866688}  # Egerton's APH as first published: +$492.5M
            book = lambda h: {"egerton": {"quarter": "2026Q3", "holdings": [h]}}
            self.assertEqual(gate.split_rows(P(d), book(ok)), [])
            self.assertEqual(len(gate.split_rows(P(d), book(unadjusted))), 1)
            self.assertEqual(len(gate.split_rows(P(d), book(unmarked))), 1)

    def test_preferred_is_not_the_common(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("060505682", "BAC", 5, 50, "7.25%CNV PFD L")]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("060505104", "BAC", 4, 40)]}
        self.assertEqual(sorted(r["change"] for r in build.with_changes(cur, prev)), ["exited", "new"])

    def test_mis_scaled_share_count_is_capped(self):
        prev = {"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 646216, 121.6e6)]}
        cur = {"quarter": "2026Q3", "holdings": [self.row("09857L108", "BKNG", 1304, 6.7e6)]}
        r = build.with_changes(cur, prev)[0]
        self.assertTrue(r["suspect_units"])
        # No median or split on file to say which side is off: both, change unknown, no $ trade.
        self.assertEqual((r["unreliable"], r["change"], r["share_change"], r["value_delta"]), ("both", None, None, 0))
        self.assertNotIn("BKNG", [m["ticker"] for m in (build.moves([r]) or {}).get("trimmed", [])])

    def test_flagged_line_shows_its_reliable_side_only(self):
        build.SPLITS["09857L108"] = {"2026Q2": 25.0}
        build.CONSENSUS.update({("2026Q2", "09857L108"): 178.24, ("2026Q3", "09857L108"): 162.91,
                                ("2026Q1", "79466L302"): 186.67, ("2026Q2", "79466L302"): 156.66,
                                ("2026Q2", "M8769Q102"): 25.0, ("2026Q3", "M8769Q102"): 33.0,
                                ("2026Q2", "78462F103"): 617.0, ("2026Q3", "78462F103"): 763.0})
        try:
            # Guardcap BKNG 2026Q3: 1,304 shares at ~$5,120, the 25:1 split ratio off the median: shares unreliable.
            g = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("09857L108", "BKNG", 1304, 6676571)]},
                                   {"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 646216, 121636487)]})[0]
            self.assertEqual((g["unreliable"], g["change"], g["value_delta"], g["value_change"]), ("shares", None, 0, -114959916))
            # One line whose share count jumps 17x while its value moves 1.2x: shares unreliable, never "added".
            c = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("79466L302", "CRM", 2347970, 31001326)]},
                                   {"quarter": "2026Q1", "holdings": [self.row("79466L302", "CRM", 136035, 25393653)]})[0]
            self.assertEqual((c["unreliable"], c["change"], c["share_change"], c["value_delta"]), ("shares", None, None, 0))
            # BMO TEVA 2026Q3: ~$4,005 a share filed, a real +159,272 shares: value unreliable, the share change stands.
            b = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("M8769Q102", "TEVA", 1130855, 4528837000)]},
                                   {"quarter": "2026Q2", "holdings": [self.row("M8769Q102", "TEVA", 971583, 24289575)]})[0]
            self.assertEqual((b["unreliable"], b["change"], b["share_change"], b["value_delta"]), ("value", "added", 159272, 0))
            # A new position keeps its label whatever the flag, with no $ trade.
            n = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("09857L108", "BKNG", 1304, 6676571)]},
                                   {"quarter": "2026Q2", "holdings": []})[0]
            self.assertEqual((n["change"], n["value_delta"]), ("new", 0))
        finally:
            build.CONSENSUS.clear()
            build.SPLITS.pop("09857L108", None)

    def test_option_lines_price_against_the_common_line(self):
        build.CONSENSUS.update({("2026Q3", "78462F103"): 762.63, ("2026Q3", "78462F903"): 2836.21,
                                ("2026Q2", "78462F103"): 746.77, ("2026Q3", "28176E108"): 86.32,
                                ("2026Q2", "28176E108"): 90.46, ("2026Q3", "872540109"): 101.0})
        opt = lambda c, t, sh, v, pc: self.row(c, t, sh, v) | {"put_call": pc}
        try:
            # IMC 2026Q3 (0001452861-26-000007): 78462F903 calls 41,048,800 sh, $31.3B = $762.63, the same as its own
            # SPY common line. In band, counted; never priced against option-style CUSIPs' $2,836 median.
            imc = {"quarter": "2026Q3", "holdings": [self.row("78462F103", "SPY", 1547924, 1180493280),
                                                     opt("78462F903", "SPY", 41048800, 31305046344, "Call")]}
            r = [x for x in build.with_changes(imc, {"quarter": "2026Q2", "holdings": [opt("78462F903", "SPY", 25000000, 18669250000, "Call")]})
                 if x["put_call"]][0]
            self.assertEqual((r.get("price_outlier"), r.get("unreliable"), r["change"], r["option_benchmark"], r["value_delta_basis"]),
                             (None, None, "added", "filing_common", "trade"))
            # No common line in the filing: the cross-filer median of the common CUSIP, by ticker (not the $2,836).
            alone = build.classify_options({"quarter": "2026Q3", "holdings": [opt("78462F903", "SPY", 41048800, 31305046344, "Call")]})
            self.assertEqual((alone["options_basis"], alone["holdings"][0]["option_benchmark"]), ("standard", "filers_common"))
            # BNP Paribas FM 2026Q2: contract counts (3,500 contracts x 100 x $746.77 = $261.4M filed): x100, counted.
            bnp = build.classify_options({"quarter": "2026Q2", "holdings": [
                opt("78462F103", "SPY", 3500, 261369500, "Put"), opt("78462F103", "SPY", 2000, 149354000, "Call")]})
            h = bnp["holdings"][0]
            self.assertEqual((bnp["options_basis"], h["shares"], h["shares_as_filed"], h["shares_basis"], h.get("price_outlier")),
                             ("contracts", 350000, 3500, "contracts", None))
            self.assertEqual(build.classify_options(bnp)["holdings"][0]["shares"], 350000)  # idempotent on read-back
            # Nine Masts: the filer's option lines at ~8x the common: every one held, unreliable both, not counted.
            nm = build.with_changes({"quarter": "2026Q3", "holdings": [opt("78462F103", "SPY", 10000, 61700000, "Call"),
                                                                     opt("78462F103", "SPY", 5000, 30850000, "Put")]},
                                    {"quarter": "2026Q2", "holdings": [opt("78462F103", "SPY", 20000, 120000000, "Call")]})
            self.assertEqual({(x["option_held"], x["unreliable"], x["value_delta"], x["value_delta_basis"]) for x in nm},
                             {("filer_non_standard", "both", 0, None)})
            # Mizuho Markets SPY calls 2026Q3 (0001062993-26-005826), filer at ~6x: held, not -$58.0M or -$13.3B.
            mz = build.with_changes({"quarter": "2026Q3", "holdings": [opt("78462F103", "SPY", 19152, 552460839, "Call")]},
                                    {"quarter": "2026Q2", "holdings": [opt("78462F103", "SPY", 479831, 610478402, "Call")]})[0]
            self.assertEqual((mz["unreliable"], mz["change"], mz["value_delta"]), ("both", None, 0))
            # Belvedere 2026Q3: EW puts 3,898,050 sh at $30.24B (~87x) in an otherwise compliant book: that line held.
            bel = build.classify_options({"quarter": "2026Q3", "holdings": [
                self.row("872540109", "TJX", 100000, 10100000), opt("872540109", "TJX", 50000, 5050000, "Call"),
                opt("872540109", "TJX", 40000, 4040000, "Put"), opt("28176E108", "EW", 3898050, 30243052287, "Put")]})
            got = {h["cusip"] + h["put_call"]: h.get("option_held") for h in bel["holdings"] if h.get("put_call")}
            self.assertEqual((bel["options_basis"], got), ("standard", {"872540109Call": None, "872540109Put": None,
                                                                         "28176E108Put": "isolated"}))
            rows = build.with_changes(bel, None)
            self.assertEqual(build.counted(rows)[0], 10100000 + 5050000 + 4040000)  # the EW puts are not counted
        finally:
            build.CONSENSUS.clear()

    def test_rescale_only_when_it_reconciles(self):
        from ingest.parse import consensus_factor, rescale_rejected
        # Mizuho Securities USA 2026Q3 (0001062993-26-005832) MCHP: 18,615,337 sh, $3,256,537 filed ($0.17 a share);
        # x1000 is $175, 2.25x the $77.77 median: neither reconciles, so no rescale and the line is held.
        self.assertEqual(consensus_factor(3256537 / 18615337, 77.77), 1.0)
        self.assertTrue(rescale_rejected(3256537 / 18615337, 77.77))
        self.assertEqual(consensus_factor(0.0781, 77.77), 1000.0)  # a line filed in thousands lands on the median
        self.assertFalse(rescale_rejected(0.0781, 77.77))
        m = {"slug": "mz", "history": [{"quarter": "2026Q3", "unit_fix": 1.0, "holdings": [
            self.row("595017104", "MCHP", 18615337, 3256537000) | {"value_as_filed": 3256537}]}]}
        others = [{"slug": f"o{i}", "history": [{"quarter": "2026Q3", "total_value": 7777, "holdings": [self.row("595017104", "MCHP", 100, 7777)]}]}
                  for i in range(3)]
        build.fix_with_consensus([m] + others)  # an earlier build's x1000 is judged again from the filed value
        h = m["history"][0]["holdings"][0]
        self.assertEqual((h["value"], h.get("price_outlier"), h.get("value_rescale")), (3256537, True, "rejected"))
        # AKAM in the same filing: x1000 would price at $113.6 against $106.35, but the cover ($6.30B) equals the
        # lines as filed, so the book is in dollars: held, not +$1.27B.
        akam = {"slug": "mz", "history": [{"quarter": "2026Q3", "unit_fix": 1.0, "cover_total": 1273895 + 5e9, "holdings": [
            self.row("00971T101", "AKAM", 11211728, 1273895000) | {"value_as_filed": 1273895}, self.row("X", "X", 1, 5e9)]}]}
        peers = [{"slug": f"p{i}", "history": [{"quarter": "2026Q3", "total_value": 10635, "holdings": [self.row("00971T101", "AKAM", 100, 10635)]}]}
                 for i in range(3)]
        build.fix_with_consensus([akam] + peers)
        h = next(x for x in akam["history"][0]["holdings"] if x["ticker"] == "AKAM")
        self.assertEqual((h["value"], h.get("value_rescale")), (1273895, "rejected"))
        r = build.with_changes(m["history"][0] | {"holdings": [h]}, {"quarter": "2026Q2", "holdings": []})[0]
        self.assertEqual((r["change"], r["unreliable"], r["value_delta"], r["value_delta_basis"]), ("new", "both", 0, None))

    def test_split_applies_by_its_date_not_the_cusip_change(self):
        # Bowen Hanes DD: 2026Q2 7,000 x 26614N102 at $45.80 (pre-split, after the 1-for-3 of that quarter); 2026Q3
        # 2,731 x 26614N102 at $129.89. The prior is 2,333 post-split shares: added ~+398, not trimmed -4,269.
        build._LINKS = {"26614N102": {"old": "26614N102", "new": "26614N201", "ratio": 0.333333, "units_basis": "split",
                                      "basis": "sec_13f_list"}}
        build.SPLITS["26614N201"] = {"2026Q2": 1 / 3}
        try:
            r = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("26614N102", "DD", 2731, 354_729)]},
                                   {"quarter": "2026Q2", "holdings": [self.row("26614N102", "DD", 7000, 320_600)]})[0]
            self.assertEqual((r["change"], round(r["share_change"]), r["split"]["ratio"]), ("added", 398, 1 / 3))
            self.assertAlmostEqual(r["value_delta"], (2731 - 7000 / 3) * 354_729 / 2731, delta=1)
            # A filer already in post-split units both quarters is left alone.
            r = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("26614N102", "DD", 2731, 354_729)]},
                                   {"quarter": "2026Q2", "holdings": [self.row("26614N102", "DD", 2333, 320_600)]})[0]
            self.assertEqual((r["change"], r["share_change"], r.get("split")), ("added", 398, None))
        finally:
            build.SPLITS.pop("26614N201", None)

    def test_prior_note_line_priced_like_the_stock_counts_as_shares(self):
        build.CONSENSUS.update({("2026Q2", "30231G102"): 150.0})
        try:
            # Sprott XOM: 2026Q2 157,390 of 30231G102 filed PRN at $136.6 a unit, 2026Q3 266,599 SH: added +109,209.
            prn = self.row("30231G102", "XOM", 0, 21_500_000) | {"shares_type": "PRN", "principal_amount": 157390}
            r = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("30231G102", "XOM", 266599, 43_389_065)]},
                                   {"quarter": "2026Q2", "holdings": [prn]})
            self.assertEqual([(x["change"], x["prev_shares"], x["share_change"]) for x in r], [("added", 157390, 109209)])
            # A note priced like a note (par $100 against a $150 stock... at $1 a unit) is a different security:
            # the share line is new and the note exited, consistently.
            note = prn | {"value": 157_390}
            r = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("30231G102", "XOM", 266599, 43_389_065)]},
                                   {"quarter": "2026Q2", "holdings": [note]})
            self.assertEqual(sorted((x["change"], x["prev_shares"]) for x in r), [("exited", 0), ("new", 0)])
        finally:
            build.CONSENSUS.clear()

    def test_held_line_names_its_reason(self):
        # Aware Super XOM 2026Q3 (0002012816-26-000017): new 42,807 sh for $79,377,569 ($1,854, 11.4x the median).
        build.CONSENSUS.update({("2026Q3", "30233Q108"): 162.75})
        try:
            r = build.with_changes({"quarter": "2026Q3", "holdings": [self.row("30233Q108", "XOM", 42807, 79_377_569)]},
                                   {"quarter": "2026Q2", "holdings": []})[0]
            self.assertEqual((r["change"], r["suspect_reason"], r["unreliable"], r["value_delta"], r["value_delta_basis"]),
                             ("new", "cross_filer", "both", 0, None))
        finally:
            build.CONSENSUS.clear()

    def test_lines_are_price_checked_before_they_are_summed(self):
        build.SPLITS["09857L108"] = {"2026Q2": 25.0}
        build.CONSENSUS.update({("2026Q1", "79466L302"): 186.67, ("2026Q2", "79466L302"): 156.66,
                                ("2026Q1", "09857L108"): 4210.32, ("2026Q2", "09857L108"): 178.24})
        try:
            # Crosslink 2026Q2 (0001104329-26-000015): two CRM-CUSIP lines; the $4.44 one isn't CRM. It is held on its
            # own and the position is the clean line: 136,035 -> 135,175 sh, trimmed -860, not "added" 2.2M shares.
            got = build.check_lines([(135175, 21176516), (2212795, 9824810)], "79466L302", "2026Q2")
            self.assertEqual((got["shares"], got["value"], [x["shares"] for x in got["held_lines"]]),
                             (135175, 21176516, [2212795]))
            cur = self.row("79466L302", "CRM", got["shares"], got["value"]) | {"held_lines": got["held_lines"], "lines": 2}
            r = build.with_changes({"quarter": "2026Q2", "holdings": [cur]},
                                   {"quarter": "2026Q1", "holdings": [self.row("79466L302", "CRM", 136035, 25393653)]})[0]
            self.assertEqual((r["change"], r["share_change"], r.get("unreliable")), ("trimmed", -860, None))
            # The held line stays in the filed total, out of the counted one.
            self.assertEqual(build.apply_weights({"holdings": [cur]})["total_value"], 21176516 + 9824810)
            self.assertEqual(build.counted([r])[0], 21176516)
            self.assertAlmostEqual(r["value_delta"], -860 * 21176516 / 135175, delta=1)
            # Summed before the check (a stored quarter not refetched yet): priced between scales, so both, not shares.
            summed = self.row("79466L302", "CRM", 2347970, 31001326) | {"lines": 2}
            r = build.with_changes({"quarter": "2026Q2", "holdings": [summed]},
                                   {"quarter": "2026Q1", "holdings": [self.row("79466L302", "CRM", 136035, 25393653)]})[0]
            self.assertEqual((r["unreliable"], r["change"], r["value_delta"]), ("both", None, 0))
            # Allianz 2026Q1 (0001193125-26-216255): 15,736 sh at $4,210 (pre-split) beside 45,199 + 20 sh at $168
            # (post-split): units mixed, so x25 on the sum is wrong: both, never "added +637,092".
            self.assertEqual(build.check_lines([(15736, 66250000), (45199, 7593432), (20, 3360)], "09857L108", "2026Q1"),
                             {"mixed_scale": True})
            prior = self.row("09857L108", "BKNG", 60955, 74056328) | {"mixed_scale": True, "lines": 3}
            a = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 2188767, 390125830)]},
                                   {"quarter": "2026Q1", "holdings": [prior]})[0]
            self.assertEqual((a["suspect_reason"], a["unreliable"], a["change"], a["value_delta"]), ("mixed_scale", "both", None, 0))
            # The same prior read back without the flag (summed, priced between the scales) is both too.
            a = build.with_changes({"quarter": "2026Q2", "holdings": [self.row("09857L108", "BKNG", 2188767, 390125830)]},
                                   {"quarter": "2026Q1", "holdings": [self.row("09857L108", "BKNG", 60955, 74056328)]})[0]
            self.assertEqual((a["unreliable"], a["change"]), ("both", None))
            # A stored quarter summed before the check is refetched once; a checked one is not.
            q = {"quarter": "2026Q2", "holdings": [summed]}
            self.assertTrue(build.needs_line_check(q))
            self.assertFalse(build.needs_line_check(q | {"lines_checked": True}))
        finally:
            build.CONSENSUS.clear()
            build.SPLITS.pop("09857L108", None)

    def test_linked_prior_under_one_share_is_kept(self):
        # DZ Bank DD 2026Q1: 1 share, 1-for-3 into 26614N201: the prior is 0.3333, never 0 (which read as new).
        self.assertEqual(build.compact_row({"prev_shares": 1 / 3, "shares": 2.0})["prev_shares"], 0.3333)
        self.assertEqual(build.compact_row({"prev_shares": 22778297.4})["prev_shares"], 22778297)


class HedgeFlowTest(unittest.TestCase):
    def test_hedge_fund_flow_counts_only_hedge_funds_that_filed_both_quarters(self):
        import json, tempfile
        from pathlib import Path
        from unittest import mock
        from ingest import moves
        row = lambda sh, ps, v, pv, ch: {"cusip": "123456101", "ticker": "XYZ", "title": "COM", "put_call": None,
                                         "shares_type": "SH", "shares": sh, "prev_shares": ps, "value": v,
                                         "prev_value": pv, "change": ch, "value_delta": v - pv, "share_change": sh - ps}
        latest = {"A": [row(100, 0, 1000, 0, "new")],          # hedge fund, filed Q3: new
                  "B": [row(20, 50, 200, 500, "trimmed")],     # hedge fund, filed Q3: trimmed
                  "C": [row(30, 30, 300, 300, "unchanged")],   # hedge fund, Q3 not filed yet (latest is Q2)
                  "D": [row(900, 0, 9000, 0, "new")]}          # long-only: not in the lens
        types = {k: {"type": "hedge_fund"} for k in "ABC"} | {"D": {"type": "long_only"}}
        shards = [{"cik": k, "quarter": "2026Q2" if k == "C" else "2026Q3", "name": k} for k in "ABCD"]
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.multiple(moves, DATA=Path(d), LATEST=latest, PERIOD={}, FILING={}, SECS={},
                                    EQUITY={"A": 2000, "B": 1000, "C": 600, "D": 10_000}):
            moves.write_hedge_flow(shards, types, {})
            doc = json.loads((Path(d) / "hedge_flow.json").read_text())
        q3 = doc["periods"][0]
        x = q3["stocks"]["XYZ"]
        self.assertEqual((q3["quarter"], q3["funds_filed"]), ("2026Q3", 2))
        self.assertEqual((x["buyers"], x["sellers"], x["breadth"], x["new_count"], x["exited_count"]), (1, 1, 0, 1, 0))
        self.assertEqual((x["holders"], x["holders_prev"], x["holder_change"]), (2, 1, 1))
        self.assertEqual(x["filed_of_prev_holders"], [1, 2])  # B filed; C held it in Q2 and has not filed Q3
        self.assertEqual((x["bought_usd"], x["sold_usd"], x["net_usd"], x["gross_usd"]), (1000, -300, 700, 1300))
        self.assertEqual(x["median_pct_of_book"], 0.35)  # A 1000/2000, B 200/1000
        self.assertIn("XYZ", q3["lists"]["holder_change_up"])


class OlderQuarterChangesTest(unittest.TestCase):
    def test_earlier_quarters_get_changes_and_the_oldest_uses_the_prior_store(self):
        # LSV-like: books for 2026Q1 and 2026Q2 stored, latest 13F is 2026Q3; 2025Q4 only in the prior store.
        import gzip, tempfile
        from pathlib import Path
        from unittest import mock
        from ingest import moves
        cols = ["ticker", "issuer", "title", "cusip", "put_call", "shares", "value", "shares_type"]
        bk = lambda q, acc, rows: {"ok": True, "cik": "0000000001", "quarter": q, "accession": acc, "columns": cols,
                                   "rows": [[None, c, "COM", c, None, sh, v, "SH"] for c, sh, v in rows]}
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            for q, acc, rows in (("2026Q1", "q1", [("624756102", 150, 1500), ("BBBBBB101", 10, 100)]),
                                 ("2026Q2", "q2", [("624756102", 120, 1200)])):
                (data / "fb" / q).mkdir(parents=True)
                (data / "fb" / q / "0000000001.json").write_text(json.dumps(bk(q, acc, rows)))
            (data / "fb" / "_prior").mkdir()
            (data / "fb" / "_prior" / "2025Q4.json.gz").write_bytes(gzip.compress(json.dumps(
                {"0000000001": bk("2025Q4", "q0", [("624756102", 100, 1000), ("CCCCCC101", 5, 50)])}).encode()))
            per = {}
            with mock.patch.multiple(moves, DATA=data, PRIOR=data / "fb" / "_prior", CONS={}, SECS={}, ACCEPTED={}):
                n = moves.older_changes([{"cik": "0000000001", "quarter": "2026Q3"}], {}, per, lambda c, rec, r: r["change"])
                q1 = json.loads((data / "fq" / "2026Q1" / "0000000001.json").read_text())
                q2 = json.loads((data / "fq" / "2026Q2" / "0000000001.json").read_text())
                self.assertFalse((data / "fq" / "2025Q4").exists())  # the prior is never a served book
        rows = lambda b: {r[b["columns"].index("cusip")]: dict(zip(b["columns"], r)) for r in b["rows"]}
        self.assertEqual(n, 2)
        self.assertEqual((q1["prev_quarter"], q2["prev_quarter"]), ("2025Q4", "2026Q1"))
        r1 = rows(q1)
        self.assertEqual((r1["624756102"]["change"], r1["624756102"]["prev_shares"]), ("added", 100))
        self.assertEqual((r1["BBBBBB101"]["change"], r1["CCCCCC101"]["change"]), ("new", "exited"))
        self.assertEqual(rows(q2)["BBBBBB101"]["change"], "exited")  # Q2 against stored Q1, not the prior store
        self.assertEqual(sorted(per), ["2026Q1", "2026Q2"])


class BulkExportTest(unittest.TestCase):
    def test_bulk_rows_are_the_rows_v1_serves(self):
        # Nov 11: bulk read the plain fb/ book; /v1 serves fq/ (Regions 78468R622 filed $1, served $1,000; exited lines).
        import json
        import tempfile
        from pathlib import Path
        from unittest import mock
        from ingest import export
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            cols = ["cusip", "shares", "value", "change", "source_accession", "value_as_filed", "value_scale",
                    "value_adjusted", "suspect_units", "suspect_units_basis"]
            for folder, rows in (("fb", [["78468R622", 10, 1, None, None, 1, None, None, None, None]]),
                                 ("fq", [["78468R622", 10, 1000, "added", "0001281761-26-000010", 1, 1000.0, True,
                                          False, "filers"],
                                         ["111111111", 0, 0, "exited", "0001281761-26-000010", None, None, None,
                                          None, None]])):
                (data / folder / "2026Q3").mkdir(parents=True)
                (data / folder / "2026Q3" / "0001281761.json").write_text(json.dumps(
                    {"ok": True, "cik": "0001281761", "accession": "0001281761-26-000010", "columns": cols, "rows": rows}))
            with mock.patch.object(export, "DATA", data):
                got = [(r[6], r[13], r[17], r[18]) + tuple(r[21:28]) for r in export.rows("2026Q3")]
                self.assertEqual({r[29] for r in export.rows("2026Q3")}, {"0001281761-26-000010"})
        self.assertEqual(got, [("78468R622", 1000, "added", "holding", 1000, 1, "true", "false", "false", "filers", ""),
                               ("111111111", 0, "exited", "exited", "", "", "", "false", "", "", "")])
        self.assertEqual(export.HEADER[17:], ("change", "row_type", "prev_shares", "prev_value", "value_scale",
                                              "value_as_filed", "value_adjusted", "zero_value", "suspect_units",
                                              "suspect_units_basis", "suspect_reason", "prev_cusip",
                                              "original_accession"))

    def test_exited_rows_are_typed_and_hold_the_old_position_in_prev(self):
        prev = {"quarter": "2026Q2", "holdings": [{"cusip": "111111111", "issuer": "A", "title": "COM", "ticker": "A",
                                                    "value": 5e6, "shares": 1e5, "put_call": None, "shares_type": "SH"}]}
        rows = build.with_changes({"quarter": "2026Q3", "holdings": []}, prev)
        self.assertEqual([(r["row_type"], r["shares"], r["value"], r["prev_shares"], r["prev_value"]) for r in rows],
                         [("exited", 0, 0, 1e5, 5e6)])
