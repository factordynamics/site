from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest.adv import verdict  # noqa: E402
from ingest.filer_types import classify  # noqa: E402


def adviser(raum, hedge, private_gav, counts=None, individuals=0.0, inv_cos=0.0, exempt=False):
    counts = counts or ({"Hedge": hedge} if hedge else {})
    return {"crd": "1", "cik": None, "names": ["X"], "exempt": exempt, "raum": raum, "raum_individuals": individuals,
            "raum_investment_companies": inv_cos, "private_funds": sum(counts.values()), "hedge_funds": hedge,
            "fund_counts": counts, "private_gav": private_gav}


class AdviserRuleTests(unittest.TestCase):
    def test_hedge_fund_by_share_of_raum(self):
        self.assertEqual(verdict(adviser(0.6e9, 2, 0.5e9))[0], "hedge_fund")  # 83% of RAUM
        self.assertIsNone(verdict(adviser(2e9, 1, 0.8e9))[0])  # 40%, under $1B

    def test_a_billion_counts_only_at_a_quarter_of_the_book(self):
        # Brigade: 27 hedge funds of 37 private funds, ~$10.7B estimated, 32% of RAUM.
        self.assertEqual(verdict(adviser(33e9, 27, 14.7e9, {"Hedge": 27, "Other": 10}))[0], "hedge_fund")
        # Arnhold: one $1.1B estimated hedge fund on a $6.4B wealth book, 16%.
        self.assertNotEqual(verdict(adviser(6.4e9, 1, 2.2e9, {"Hedge": 1, "Other": 1}, individuals=4e9))[0], "hedge_fund")

    def test_estimate_splits_gross_assets_by_fund_count(self):
        _, ev = verdict(adviser(10e9, 1, 4e9, {"Hedge": 1, "PE": 3}))
        self.assertTrue(ev["hedge_gav_estimated"])
        self.assertEqual(ev["hedge_gav"], 1_000_000_000)

    def test_exempt_adviser_uses_its_private_funds_as_the_book(self):
        self.assertEqual(verdict(adviser(0, 1, 0.3e9, exempt=True))[0], "hedge_fund")

    def test_wealth_and_fund_complexes(self):
        self.assertEqual(verdict(adviser(5e9, 0, 0, individuals=3e9))[0], "wealth")
        self.assertEqual(verdict(adviser(50e9, 0, 0, inv_cos=40e9))[0], "long_only")

    def test_own_form_d_counts_only_without_a_form_adv_match(self):
        # Santa Monica Partners files Form D for its hedge fund under its own CIK and has no Form ADV match.
        form_d = ({"0000904793"}, {})
        self.assertEqual(classify("0000904793", "SANTA MONICA PARTNERS LP", {}, form_d)[0], "hedge_fund")
        # With an ADV match, ADV decides: a wealth book with a small hedge fund stays wealth.
        wealthy = adviser(6.4e9, 1, 2.2e9, {"Hedge": 1, "Other": 1}, individuals=4e9)
        self.assertEqual(classify("0000904793", "SANTA MONICA PARTNERS LP", {}, form_d, None, wealthy)[0], "wealth")

    def test_the_reclass_removes_hedge_fund_only_when_form_adv_lists_no_hedge_funds(self):
        # Nov 11 review: ~1 in 5 dropped hedge funds were real (Sphera: no ADV match; Carlson: hedge funds at 20% of RAUM).
        carlson = adviser(711e6, 2, 145e6, {"Hedge": 2, "Other": 3})
        self.assertEqual(classify("1", "Sphera Management", {}, prior="hedge_fund")[0], "hedge_fund")
        self.assertEqual(classify("2", "Carlson Capital", {}, None, None, carlson, "hedge_fund")[0], "hedge_fund")
        self.assertNotEqual(classify("2", "Carlson Capital", {}, None, None, carlson, "long_only")[0], "hedge_fund")
        no_hedge = adviser(842e6, 0, 0, {}, individuals=600e6)  # Stone House: wealth book, no hedge funds
        self.assertEqual(classify("3", "Stone House", {}, None, None, no_hedge, "hedge_fund")[0], "wealth")
        # Cresset: 14 hedge funds among 145 private funds, under 1% of a $79B wealth book.
        cresset = adviser(78.9e9, 14, 6.7e9, {"Hedge": 14, "PE": 25, "VC": 43, "Other": 63}, individuals=70e9)
        self.assertEqual(classify("4", "Cresset Asset Management", {}, None, None, cresset, "hedge_fund")[0], "wealth")
        # JAT: no private funds on its ADV and no client-type verdict, so nothing shows it isn't a hedge fund.
        self.assertEqual(classify("5", "JAT Capital Mgmt", {}, None, None, adviser(228e6, 0, 0), "hedge_fund")[0], "hedge_fund")

    def test_shape_alone_never_makes_a_hedge_fund(self):
        shape = {"positions": 40, "top10": 0.6, "options": 0.2, "etf": 0.0, "turnover": 0.9, "aum": 2e9}
        kind, basis, _ = classify("0009999999", "Concentrated Options LP", shape)
        self.assertEqual(kind, "long_only")
        self.assertIn("no Form ADV", basis)
        kind, _, ev = classify("0009999999", "Concentrated Options LP", shape, adviser=adviser(1e9, 2, 0.9e9))
        self.assertEqual((kind, ev["adv"]["hedge_funds"]), ("hedge_fund", 2))


if __name__ == "__main__":
    unittest.main()


class AdvFilesTest(unittest.TestCase):
    def test_registered_and_exempt_files_are_told_apart_by_file_name(self):
        # The SEC folder is ".../information-about-registered-investment-advisers-exempt-reporting-advisers/".
        from unittest import mock
        from ingest import adv
        d = "/files/investment/data/other/information-about-registered-investment-advisers-exempt-reporting-advisers/"
        page = f'<a href="{d}ia11022026-exempt.zip">x</a><a href="{d}ia110226-registered.zip">y</a>'.encode()
        with mock.patch.object(adv, "get", return_value=page):
            reg, ex = adv.latest_files()
        self.assertEqual((reg.rsplit("/", 1)[-1], ex.rsplit("/", 1)[-1]), ("ia110226-registered.zip", "ia11022026-exempt.zip"))


    def test_a_filer_matches_its_adviser_by_legal_name_when_the_short_name_is_shared(self):
        # Voss Capital, LP and Endeavour Capital Advisors were never matched: "VOSS" is too short to trust and
        # "ENDEAVOUR" also names another adviser. The whole legal name identifies them.
        from ingest.filer_types import adviser_for, adviser_index
        mk = lambda *names: {"cik": None, "names": list(names)}
        voss, endeavour = mk("VOSS CAPITAL, L.P."), mk("ENDEAVOUR CAPITAL ADVISORS INC.")
        index = adviser_index([voss, mk("VOSS WEALTH MANAGEMENT LLC"), endeavour, mk("DVSM, LP", "ENDEAVOUR CAPITAL")])
        self.assertIs(adviser_for("1", "Voss Capital, LP", index, set()), voss)
        self.assertIs(adviser_for("2", "ENDEAVOUR CAPITAL ADVISORS INC", index, set()), endeavour)
        self.assertIsNone(adviser_for("3", "Voss Partners LLC", index, set()))


class IndexContractTest(unittest.TestCase):
    def test_a_renamed_type_fails_the_publish_gate(self):
        # Nov 9: `active` renamed to `long_only` silently stopped stock-match alerts for two days.
        from ingest.gate import index_contract
        row = lambda slug, t: {"slug": slug, "cik": "0001067983", "type": t, "featured": True, "ok": True, "form": "13F-HR",
                               "accession": "0000950123-26-008123", "report_date": "2026-09-30", "filing_date": "2026-11-14",
                               "reported_by": None}
        good = {"managers": [row("a", "hedge_fund"), row("b", "long_only")]}
        self.assertEqual(index_contract(good), [])
        self.assertEqual(index_contract({"managers": [row("a", "hedge_fund"), row("b", "active")]}),
                         ["b: type='active'", "no managers[] row of type long_only"])


class TypesGuardTest(unittest.TestCase):
    def test_a_full_run_keeps_the_published_types_when_a_type_moves_over_ten_percent(self):
        # Nov 11 03:45: a run that could not read Form ADV published 88 hedge funds instead of 1,243.
        import json
        import tempfile
        from unittest import mock
        from ingest import filer_types as ft
        from ingest.gate import type_drift

        self.assertEqual([d["type"] for d in type_drift({"hedge_fund": 1243, "long_only": 1554, "sovereign": 19},
                                                         {"hedge_fund": 831, "long_only": 1700, "sovereign": 22})],
                         ["hedge_fund"])  # -33% fails; +9.4% and +3 sovereigns pass
        self.assertEqual(type_drift({"wealth": 100}, {"wealth": 100, "pension": 11})[0]["type"], "pension")
        with tempfile.TemporaryDirectory() as d:
            data = Path(d)
            ciks = [f"{i:010d}" for i in range(40)]
            published = {c: {"type": "hedge_fund" if i < 20 else "long_only"} for i, c in enumerate(ciks)}
            (data / "f").mkdir()
            (data / "filer_types.json").write_text(json.dumps({"filers": published}))
            (data / "filers.json").write_text(json.dumps({"filers": [{"cik": c, "name": f"Fund {c}"} for c in ciks]}))
            patches = dict(DATA=data, RECLASS=True, form_d_hedge=lambda: None, load_advisers=lambda: [],
                           adviser_index=lambda a: {}, adviser_for=lambda *a: None, shape=lambda *a: {},
                           classify=lambda *a: ("long_only", "shape", "test"))
            (data / "index.json").write_text(json.dumps({"managers": []}))
            for accepted, want in ((False, "hedge_fund"), (True, "long_only")):
                with mock.patch.multiple(ft, TYPES_ACCEPTED=accepted, **patches):
                    ft.main()
                if not accepted:  # held: the published set keeps its date
                    self.assertEqual(json.loads((data / "index.json").read_text())["types_as_of"], ft.FIRST_AS_OF)
                got = json.loads((data / "filer_types.json").read_text())["filers"][ciks[0]]["type"]
                guard = json.loads((data / "types_guard.json").read_text())
                self.assertEqual((got, guard["status"]), (want, "accepted" if accepted else "held"))
            self.assertEqual(guard["moved"][0], {"type": "hedge_fund", "published": 20, "candidate": 0, "change_pct": -100.0})
            # The held run kept the set and its date; the accepted run published a new set dated today.
            from datetime import datetime, timezone
            self.assertEqual(json.loads((data / "filer_types.json").read_text())["as_of"], datetime.now(timezone.utc).strftime("%Y-%m-%d"))
