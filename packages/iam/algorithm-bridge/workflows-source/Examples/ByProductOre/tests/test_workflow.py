"""The workflow, run for real on a real project.

These tests need three things this repository does not contain: a built
`IamC` and `IamAlgorithms`, and a `.iam` holding roadways, an
orebody and a block model.  None of them is committed, so every test here SKIPS
when one is missing rather than failing -- a red suite that means "you have not
built the platform" trains a reader to ignore red.

    python -m unittest discover -s IAM/plugin/Workflows/Examples/ByProductOre/tests

What is being tested is not "does the arithmetic work".  It is the three
refusals the workflow exists for: a total over a selection it could not measure,
a default density, and an empty selector read as an empty answer.
"""

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
WORKFLOW = HERE.parent
sys.path.insert(0, str(WORKFLOW))

# Imported at module scope and not inside the probe, because the workflow module
# is what puts the two library directories on sys.path -- asking whether the
# platform is available before importing it asks before the paths exist, and the
# answer is always no.
import workflow                                              # noqa: E402

REPO = WORKFLOW.parents[3]
PROJECT = Path("D:/dev/MiningFlatform/workspace/test1.iam")
BLOCK_MODEL = "merge-2-dimine-block-model"
# A metal is named, not just a column: the model declares every field's unit as
# '1' with no description, so nothing in the project says CU is a grade or what
# its numbers mean. The scale is part of the name for the same reason.
GRADES = [{"column": "merge-2-dimine-cell-1", "metal": "Cu", "scale": 1.0}]


def platform_available():
    """Whether the libraries and a project to point them at are both here."""
    if not PROJECT.is_file():
        return False
    try:
        library = workflow.iam_algorithms.Library()
        if "surface.volume" not in library._by_id:
            return False
        workflow.iam.load()
    except Exception:                                          # noqa: BLE001
        return False
    return True


AVAILABLE = platform_available()
SKIP = "needs a Mining-enabled IAM library and D:/dev/MiningFlatform/workspace/test1.iam"


def narrow_glossary(directory, roadways):
    """A glossary naming only the roadways a test wants, so a run stays short."""
    path = Path(directory) / "glossary.json"
    path.write_text(json.dumps({
        "terms": [
            {"term": "巷道", "selector": {"name_any": roadways}},
            {"term": "矿体", "selector": {"name_any": ["矿体"]}},
        ]}, ensure_ascii=False), encoding="utf-8")
    return path


class PureLogic(unittest.TestCase):
    def test_stored_surface_uses_direct_volume_api(self):
        class Library:
            def invoke(self, *_args, **_kwargs):
                raise AssertionError("surface.volume must use its direct API")

        with mock.patch.object(workflow.direct, "surface__volume", create=True,
                               return_value=7.0) as measure:
            volume, refusal = workflow.proven_solid(
                Library(), "project", "surface-1", [], [], None)
        self.assertEqual((volume, refusal), (7.0, None))
        measure.assert_called_once_with(project="project", surfaceId="surface-1")

    def test_repaired_surface_is_measured_from_repaired_mesh(self):
        class Mesh:
            def measure_volume(self):
                return {"value": 7.0}

        class Library:
            def create_mesh(self, vertices, triangles, **metadata):
                self.seen = (vertices, triangles, metadata)
                return Mesh()

            def invoke(self, *_args, **_kwargs):
                raise AssertionError("the original project surface must not be remeasured")

        library = Library()
        vertices, triangles = [(0, 0, 0)], [(0, 0, 0)]
        volume, refusal = workflow.proven_solid(
            library, object(), "original", vertices, triangles, "mine-frame")
        self.assertEqual((volume, refusal), (7.0, None))
        self.assertEqual(library.seen, (vertices, triangles, {"coordinate_frame": "mine-frame"}))

    def test_missing_grade_does_not_erase_known_ore_tonnage(self):
        cells = {"cells": [{"volume_m3": 2.0, "values": [None]},
                           {"volume_m3": 3.0, "values": [0.1]}]}
        grades = [{"column": "c", "metal": "Cu", "scale": 1.0}]
        result = workflow.tonnage_and_metal(
            cells, grades, {"value": 2.0, "column": None, "table": {}})
        self.assertEqual(result["ore_tonnes"], 10.0)
        self.assertAlmostEqual(result["metals"]["Cu"]["metal_tonnes"], 0.6)
        self.assertEqual(result["metals"]["Cu"]["ungraded_cells"], 1)

    def test_two_metals_share_the_ore_tonnage_and_keep_their_own(self):
        # The ore tonnage is the same number for every metal -- a cell is rock
        # with a weight whether or not anybody assayed it -- so it is summed once
        # rather than three times, which would invite reading them as three
        # different piles.
        cells = {"cells": [{"volume_m3": 2.0, "values": [0.1, None, 0.2]},
                           {"volume_m3": 3.0, "values": [None, 0.05, 0.2]}]}
        grades = [{"column": "cu", "metal": "Cu", "scale": 1.0},
                  {"column": "pb", "metal": "Pb", "scale": 1.0},
                  {"column": "zn", "metal": "Zn", "scale": 0.01}]
        result = workflow.tonnage_and_metal(
            cells, grades, {"value": 2.0, "column": None, "table": {}})
        self.assertEqual(result["ore_tonnes"], 10.0)
        self.assertAlmostEqual(result["metals"]["Cu"]["metal_tonnes"], 0.4)
        self.assertAlmostEqual(result["metals"]["Pb"]["metal_tonnes"], 0.3)
        # 0.2 percent of 10 t, via the scale
        self.assertAlmostEqual(result["metals"]["Zn"]["metal_tonnes"], 0.02)
        self.assertEqual(result["metals"]["Cu"]["ungraded_cells"], 1)
        self.assertEqual(result["metals"]["Pb"]["ungraded_cells"], 1)

    def test_a_metal_without_a_scale_is_refused(self):
        # The one parameter that can be wrong silently: a percent column read as
        # a fraction overstates the metal a hundredfold and looks reasonable.
        for bad in ({"column": "c", "metal": "Cu"},
                    {"column": "c", "metal": "Cu", "scale": "x"},
                    {"column": "c", "metal": "Cu", "scale": 0}):
            with self.subTest(entry=bad):
                with self.assertRaisesRegex(workflow.WorkflowError, "needs a scale|finite positive scale"):
                    workflow.validate_grades([bad])

    def test_two_metals_may_not_share_a_name(self):
        with self.assertRaisesRegex(workflow.WorkflowError, "named the same"):
            workflow.validate_grades([{"column": "a", "metal": "Cu", "scale": 1.0},
                                      {"column": "b", "metal": "Cu", "scale": 0.01}])

    def test_invalid_density_is_refused_before_opening_a_project(self):
        for density in (-1.0, float("nan"), float("inf")):
            with self.subTest(density=density):
                with self.assertRaisesRegex(workflow.WorkflowError, "density must be"):
                    workflow.run("missing.iam", "model",
                                 [{"column": "c", "metal": "Cu", "scale": 1.0}], density,
                                 log=lambda *_: None)


@unittest.skipUnless(AVAILABLE, SKIP)
class TheWorkflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = workflow
        cls.temporary = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_narrow(self, roadways):
        glossary = narrow_glossary(self.temporary.name, roadways)
        return self.workflow.run(
            PROJECT, BLOCK_MODEL, GRADES, 2.7,
            glossary=glossary, subdivide_max_size=3.0, log=lambda *_: None)

    def test_the_one_roadway_that_reaches_the_orebody_is_measured(self):
        """480水平 is the level this project's orebody actually intersects.

        The by-product volume is asserted against the geometric intersection
        measured independently with `geometry.boolean` (377.906 m3), not against
        a number this test invented -- if the two ever disagree, one of them has
        moved and a reader should be told.
        """
        report = self.run_narrow(["480水平"])
        measured = [row for row in report["rows"] if row["状态"] == "已测量"]
        self.assertEqual(len(measured), 1, "expected exactly the 480水平 roadway to be measured")
        self.assertAlmostEqual(measured[0]["副产体积_m3"], 377.906, places=2)
        self.assertGreater(measured[0]["矿石量_t"], 0.0)
        # NAMED AFTER THE METAL, so two runs over different columns cannot
        # produce tables that look alike and mean different things.
        self.assertGreater(measured[0]["金属量_Cu_t"], 0.0)
        # Metal is a fraction of the ore, never more than it.
        self.assertLess(measured[0]["金属量_Cu_t"], measured[0]["矿石量_t"])

    def test_native_cells_do_not_expand_to_python_rows_and_are_released(self):
        captured = []
        aggregate = workflow.tonnage_and_metal

        def collect(cells, *args, **kwargs):
            self.assertIsInstance(cells, workflow.iam_algorithms.MineCells)
            captured.append(cells)
            return aggregate(cells, *args, **kwargs)

        with mock.patch.object(workflow.iam_algorithms.MineCells, "to_payload",
                               side_effect=AssertionError("native cells must stay native")), \
                mock.patch.object(workflow, "tonnage_and_metal", side_effect=collect):
            report = self.run_narrow(["480水平"])
        self.assertGreater(report["totals"]["ore_tonnes"], 0.)
        self.assertTrue(captured)
        self.assertTrue(all(not cells._handle for cells in captured))

    def test_a_roadway_that_misses_the_orebody_is_judged_zero_not_unmeasured(self):
        """The distinction the table keeps: zero is an answer, unknown is not.

        Counting a disjoint roadway as unmeasured would understate coverage and
        make a complete answer look like a failed one.
        """
        report = self.run_narrow(["637-725回风小井"])
        self.assertEqual([row["状态"] for row in report["rows"]], ["无副产"])
        self.assertEqual(report["totals"]["coverage"], 1.0)
        self.assertEqual(report["totals"]["ore_tonnes"], 0.0)

    def test_an_open_sheet_is_admitted_with_the_platforms_own_reason(self):
        """A 中段水平面 is a 2D drawing, not a solid, and the table says so.

        The reason is the platform's sentence, quoted rather than paraphrased --
        a workflow that rewrote it would be reporting its own opinion.
        """
        report = self.run_narrow(["435水平"])
        row = report["rows"][0]
        self.assertEqual(row["状态"], "未测量")
        self.assertIn("not closed", row["说明"])
        self.assertEqual(report["totals"]["coverage"], 0.0)
        self.assertEqual(report["totals"]["ore_tonnes"], 0.0)

    def test_a_selector_that_matches_nothing_is_refused(self):
        """An empty set and an unasked question are not the same request."""
        glossary = narrow_glossary(self.temporary.name, ["这个巷道不存在"])
        with self.assertRaises(self.workflow.WorkflowError) as raised:
            self.workflow.run(PROJECT, BLOCK_MODEL, GRADES, 2.7,
                              glossary=glossary, log=lambda *_: None)
        self.assertIn("一个不存在的巷道名", str(raised.exception).replace("这个巷道不存在", "一个不存在的巷道名"))

    def test_the_source_project_is_not_written(self):
        """The by-product solids go into a copy; the file on disk is untouched."""
        before = PROJECT.stat().st_mtime_ns, PROJECT.stat().st_size
        with PROJECT.open("rb") as stream:
            before_digest = hashlib.file_digest(stream, "sha256").hexdigest()
        self.run_narrow(["480水平"])
        after = PROJECT.stat().st_mtime_ns, PROJECT.stat().st_size
        self.assertEqual(before, after)
        with PROJECT.open("rb") as stream:
            self.assertEqual(before_digest, hashlib.file_digest(stream, "sha256").hexdigest())

    def test_the_table_carries_its_own_coverage(self):
        """The deliverable says how much of the selection it covers."""
        report = self.run_narrow(["480水平", "635水平", "637-725回风小井"])
        totals = report["totals"]
        self.assertEqual(totals["roadways_selected"], 2)         # 635水平 does not exist
        self.assertEqual(totals["roadways_judged"], 2)
        self.assertEqual(totals["roadways_with_by_product"], 1)
        self.assertAlmostEqual(totals["coverage"], 1.0)

        destination = Path(self.temporary.name) / "table.csv"
        self.workflow.write_table(report, destination)
        text = destination.read_text(encoding="utf-8-sig")
        self.assertIn("覆盖率", text)
        self.assertIn("已判定巷道", text)


if __name__ == "__main__":
    unittest.main()
