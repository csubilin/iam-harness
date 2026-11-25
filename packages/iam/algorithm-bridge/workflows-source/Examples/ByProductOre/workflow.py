#!/usr/bin/env python3
"""巷道掘进副产矿石量及金属量.

The question this answers, in the words a user types:

    输出所有巷道掘进副产矿石量及金属量

Read as five demands, each of which is a capability this platform already has:

  * "所有巷道"     -- a set, chosen by a SELECTOR over the project's own facts
  * "矿体"         -- the other set, same mechanism
  * "掘进副产"     -- 巷道实体 ∩ 矿体实体, a boolean intersection
  * "矿石量"       -- sum over block-model cells of volume x density
  * "金属量"       -- sum over block-model cells of volume x density x grade

Nothing here understands Chinese.  What it does is take two selectors -- which a
glossary supplies and a user can edit -- and run the rest.  That split is the
whole design: the part a machine cannot do yet (mapping words to things) is
data, and the part it can do is this program.

THREE THINGS THIS REFUSES TO DO, and each is deliberate:

1. It does not report a total for a selection it could not measure.  A roadway
   that is not a closed solid is listed with the platform's own reason for
   saying so, the table carries a coverage line, and the totals cover only what
   was measured.  Six measured roadways reported as "all roadways" would be a
   number nobody could tell was wrong.

2. It does not invent a density.  The block model here has no weight column, so
   the density is a required argument with no default -- a default would be a
   number this program made up.

3. It does not write to the source project.  The by-product solids are put into
   an in-memory copy of the revision, which is never saved, because the only way
   to constrain a block model by a shape is to name that shape inside a
   snapshot -- and the snapshot does not have to be a file.

WHAT IS ASSUMED ABOUT THE DATA, and where it would be checked: the project's
surfaces are read in their STORED (frame-local) space, which is the space the
Mining constraint solver reads a containing surface in
(Mining/Source/IamBlockModelConstraint.cpp applies the frame itself).  A
mesh built from project-coordinate vertices and written back would put the shell
somewhere else and produce a wrong tonnage rather than an error, so every read
here passes project_coordinates=False.

Runnable on its own:

    python workflow.py --project mine.iam --block-model <id> \\
        --grade-column <id> --density 2.7 --out by-product.csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from functools import lru_cache
from contextlib import ExitStack

# --------------------------------------------------------------------------
# The two libraries this program is built out of.
#
# iam is the Mining port: it opens a project, enumerates what the project
# holds, and is the one write door.  iam_algorithms is the algorithm library:
# booleans, measurements, and the block-model constraint.  They are separate
# packages with separate C libraries, and this program is where they meet.
# --------------------------------------------------------------------------

def _repository_root():
    """The IAX root, from the environment or by walking up to Mining/Host/python.

    THE WORKFLOW MAY LIVE ANYWHERE.  The example sits under Workflows/Examples/,
    a frozen copy sits under a workspace, and a copied file has no fixed depth;
    `parents[N]` is a claim about where the file is, not about where the platform
    is.  The bridge passes IAX_PLATFORM_ROOT to every child; the walk is for a
    standalone run from the checkout, where no environment has been set.
    """
    configured = os.environ.get("IAX_PLATFORM_ROOT")
    if configured:
        return Path(configured).resolve()
    for parent in Path(__file__).resolve().parents:
        if (parent / "Mining" / "Host" / "python").is_dir():
            return parent
    raise RuntimeError("cannot find the IAX platform root; set IAX_PLATFORM_ROOT")


REPO = _repository_root()
for relative in ("Mining/Host/python",):
    candidate = str(REPO / relative)
    if candidate not in sys.path:
        sys.path.insert(0, candidate)
_platform = {"win32": "win-native", "linux": "linux-native", "darwin": "macos-native"}.get(sys.platform)
_package_root = os.environ.get("IAM_PYTHON_PACKAGE_DIR") or str(
    REPO / "build/CMakePlatforms" / (_platform or "unsupported") / "IAM/Host/Python")
if Path(_package_root).is_dir() and _package_root not in sys.path:
    sys.path.insert(0, _package_root)

import iam                                    # noqa: E402
import iam_algorithms                             # noqa: E402
from iam_algorithms import direct                  # noqa: E402

ELEMENT_SURFACE = iam._abi.ELEMENT_SURFACE
ELEMENT_FEATURE = iam._abi.ELEMENT_FEATURE
ELEMENT_BLOCK_MODEL = iam._abi.ELEMENT_BLOCK_MODEL


class WorkflowError(RuntimeError):
    """A refusal that says what was asked for and why it cannot be answered."""


@lru_cache(maxsize=1)
def _native_library():
    return iam_algorithms.Library()


def _native_calculation(library, name, *arguments):
    from iam_algorithms import _workflow_kernels
    try:
        return getattr(_workflow_kernels, name)(library or _native_library(), *arguments)
    except (iam_algorithms.IamError, ValueError, TypeError) as error:
        raise WorkflowError(str(error)) from error


# --------------------------------------------------------------------------
# Selectors: the half of "understanding" that is data.
# --------------------------------------------------------------------------

def load_glossary(path=None):
    """The term-to-selector table, from a file or from the shipped default."""
    source = Path(path) if path else Path(__file__).with_name("glossary.default.json")
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WorkflowError("no glossary at %s" % source) from error
    terms = document.get("terms")
    if not isinstance(terms, list) or not terms:
        raise WorkflowError("%s declares no terms" % source)
    return {entry["term"]: entry.get("selector", {}) for entry in terms}


def select(port, selector, term):
    """The elements a selector names, as (element_id, name, [geometry_id]).

    A selector reads only what the project itself records: the element's name,
    its metadata (a Dimine import writes the source layer there), and its
    parent.  Nothing is guessed from a geometry type, because "this is an L-shaped
    surface" is not what makes something a roadway.

    AN EMPTY MATCH IS REFUSED rather than returned.  An empty set and an
    unasked question are different requests -- a glossary whose 矿体 selector
    matches nothing would otherwise produce a table of zeros that reads exactly
    like a mine with no ore.
    """
    name_any = selector.get("name_any", [])
    metadata_any = selector.get("metadata_any", [])
    if not name_any and not metadata_any:
        raise WorkflowError("the selector for %s names no condition" % term)
    matched = []
    for element_id, name in zip(port.ids(ELEMENT_FEATURE), port.element_strings(ELEMENT_FEATURE)):
        try:
            metadata = port.element_metadata(element_id)
        except iam.IamError:
            metadata = ""
        if name_any and not any(needle in name for needle in name_any):
            continue
        if metadata_any and not any(needle in metadata for needle in metadata_any):
            continue
        geometry = port.element_geometry_ids(element_id)
        if geometry:
            matched.append((element_id, name, geometry))
    if not matched:
        raise WorkflowError(
            "nothing in the project matches %s (%s); the glossary and the project disagree"
            % (term, json.dumps(selector, ensure_ascii=False)))
    return matched


# --------------------------------------------------------------------------
# Geometry: what the project holds, and what can be done with it.
# --------------------------------------------------------------------------

def surface_of(port, geometry_ids):
    """The first id that names a TriangulatedSurface, or None.

    A geometry id is not self-describing through this API, so this asks the
    project: only a surface answers with triangles.
    """
    for geometry_id in geometry_ids:
        try:
            port.surface_triangles(geometry_id)
            return geometry_id
        except iam.IamError:
            continue
    return None


def read_surface(port, surface_id):
    """A surface's vertices and triangles, both in STORED (frame-local) space."""
    vertices = port.read_points(ELEMENT_SURFACE, surface_id, project_coordinates=False)
    triangles = port.surface_triangles(surface_id)
    return vertices, triangles


def drop_repeated_triangles(vertices, triangles, *, library=None):
    """Stable duplicate-face removal through the GeomAlg topology kernel."""
    result = _native_calculation(library, "topology", 0, len(vertices), triangles)
    return vertices, [tuple(triangles[i]) for i in result["kept"]], result["dropped"]


def proven_solid(library, project, surface_id, vertices, triangles, frame=None):
    """The surface's volume, or the platform's own reason for refusing.

    `mine.measure surface.volume` is used as the gate rather than a closure test
    written here.  It proves more than closure: it walks every undirected edge
    looking for exactly two faces traversed in opposite directions, which is the
    same property the block-model constraint demands of a containing surface.
    Handing the constraint a shell this rejects would move the failure to the
    end of the run, after all the plumbing had done its work.

    Returns (volume, refusal_reason); exactly one is None.
    """
    try:
        if frame is not None:
            mesh = library.create_mesh(vertices, triangles, coordinate_frame=frame)
            return float(mesh.measure_volume()["value"]), None
        return float(direct.surface__volume(
            project=project, surfaceId=surface_id)), None
    except Exception as error:                                # noqa: BLE001
        return None, str(error)


def connected_shells(vertices, triangles, *, library=None):
    """Compact edge-connected shells through the GeomAlg topology kernel."""
    result = _native_calculation(library, "topology", 1, len(vertices), triangles)
    return [([vertices[i] for i in shell["vertices"]],
             [tuple(face) for face in shell["triangles"]]) for shell in result["shells"]]


# --------------------------------------------------------------------------
# The boolean, and why it is attempted more than once.
# --------------------------------------------------------------------------

# Historical direct-FacetModeler measurement on this platform's Windows build,
# 2026-10-12: the facet boolean
# refuses about seven calls in ten on real Dimine meshes with "FacetModeler
# could not build a body from the triangle payload", in fresh processes and
# within one process alike, while the same mesh slices reliably 30 times out of
# 30 and synthetic cubes boolean 10 times out of 10.  The failure is in
# FacetModeler::Body::createFromMesh for a mesh with sliver triangles, and it is
# not this program's to fix. This workflow now invokes the unified Boolean ID:
# MeshAlg runs first, then FacetModeler on recoverable failure. The historical
# refusal rate has not been remeasured on that dispatch path.
#
# Historical direct-FacetModeler successes agreed in twelve attempts: four
# successes, all 316 triangles and 377.9063539952 m3 to the bit. Unified
# dispatch may choose a different implementation. The agreement check below
# therefore remains necessary: if two successful volumes disagree, the run
# stops instead of choosing an answer.
#
# The 40-attempt budget comes from the historical direct-FacetModeler refusal
# rate (0.42 to 0.65 per call at 0.3 to 0.45 s per attempt). The unified path's
# refusal rate and run time have not been measured on this data set.
BOOLEAN_ATTEMPTS = 40


def intersect(library, operand_a, operand_b, attempts=BOOLEAN_ATTEMPTS):
    """Native Boolean retries, manifold measurement and reproducibility check."""
    result = _native_calculation(library, "intersection", operand_a, operand_b, attempts)
    return result["volume"], result["refusal"], result.get("mesh"), result["attempts"]


# --------------------------------------------------------------------------
# Turning a by-product solid into a block-model query.
# --------------------------------------------------------------------------

def payload_of(vertices, triangles):
    """A TriangulatedSurface as the write door's JSON, in the stored space."""
    return {
        "vertices": [{"x": float(x), "y": float(y), "z": float(z)} for x, y, z in vertices],
        "triangles": [{"first": int(a), "second": int(b), "third": int(c)} for a, b, c in triangles],
    }


def measure_derived(port, library, block_model, grades, solids,
                    density_of, subdivide_max_size, *, keep_native=False):
    """Put the by-product solids in a copy of the revision and measure them.

    WHY THE SOLIDS HAVE TO ENTER THE PROJECT AT ALL.  `constrained_block_model_cells`
    names its containing surface by ID and resolves it inside the snapshot
    (Mining/Source/IamBlockModelConstraint.cpp).  There is no inline-surface
    input, so a derived shape reaches the constraint as a project resource or
    not at all.

    The copy is in memory and is NEVER SAVED: `Port.commit` publishes a revision
    to this process's database, not to a file, and the source project is opened
    read-only in the sense that nothing writes it back.  One commit carries
    every solid, because each commit rebuilds the snapshot and this project's is
    158 MB.

    Returns (cells_payload, refusal_reason) per solid; keep_native retains owned tables.
    """
    if not solids:
        return []
    surfaces = []
    elements = []
    for index, (label, vertices, triangles) in enumerate(solids):
        surface_id = "by-product-%d" % index
        surfaces.append(dict(payload_of(vertices, triangles), id=surface_id, name=label,
                             source="IAM by-product-ore workflow"))
        # A geometry nothing references is refused at commit, so each solid
        # names an element.  The element is a container for the geometry, not a
        # claim about the mine; the by-product is not an excavation anybody dug.
        elements.append({"id": "by-product-element-%d" % index, "name": label,
                         "geometry_ids": [surface_id], "parent_id": ""})
    port.put({"surfaces": surfaces, "elements": elements})
    port.commit()

    materialised = library.create_geometry({
        "schema_version": 1,
        "representation": "mine.block_model",
        "metadata": {"coordinate_frame": port.coordinate_frame, "length_unit": "m",
                     "unit_to_meters": 1.0},
        # The key, not the parameter: the geometry envelope's schema spells this
        # member block_model_id, and a payload that renames it is refused by name
        # rather than silently read as absent.
        "block_model_id": block_model,
        "column_id": grades[0]["column"],
        "project_snapshot": {
            "encoding": "base64",
            "media_type": "application/vnd.iax.mine-project+flatbuffers",
            "data": _base64(port.snapshot_bytes()),
        },
    })

    measured = []
    for index, (label, _, _) in enumerate(solids):
        surface_id = "by-product-%d" % index
        try:
            # The keyword here is the LIBRARY's, not this workflow's: the two
            # vocabularies are deliberately separate, and the run above this one
            # spent a while reporting "got an unexpected keyword argument" as if
            # it were a failure of the block model rather than a typo in a call.
            cells = library.constrained_block_model_cells(
                materialised, block_model, containing_surface_id=surface_id,
                column_ids=([grade["column"] for grade in grades]
                            + ([density_of["column"]] if density_of["column"] else [])),
                subdivide_max_size_metres=subdivide_max_size)
            if keep_native:
                measured.append((cells, None))
            else:
                with cells:
                    measured.append((cells.to_payload(), None))
        except Exception as error:                            # noqa: BLE001
            measured.append((None, str(error)))
    return measured


def _base64(payload):
    import base64
    return base64.b64encode(payload).decode("ascii")


def tonnage_and_metal(cells, grades, density_of, *, library=None):
    """Native volume-density-grade accumulation with per-metal coverage."""
    return _native_calculation(library, "tonnage", cells, grades, density_of)


def validate_grades(grades):
    """The metals to report, each with the column and the scale it is read at.

    EVERY FIELD IS REQUIRED, AND `scale` MOST OF ALL.  The scale is the one
    parameter here that can be wrong without anything noticing: a percent column
    read as a fraction overstates the metal a hundredfold and produces a table
    that looks entirely reasonable.  It cannot be inferred -- measured on the
    reference model, every field declares `unit='1'` and no description -- so it
    is asked for rather than assumed.

    Several metals are allowed because the question is "which metal or metals",
    and the answer is the caller's.  Two entries may not share a name: they would
    merge into one column and one of them would be silently dropped.
    """
    if not isinstance(grades, (list, tuple)) or not grades:
        raise WorkflowError(
            "name the metal or metals to report, each as "
            "{'column': <id>, 'metal': <name>, 'scale': <number>} -- at least one. "
            "WHICH metal and WHAT its numbers mean are the user's to say: the project records a "
            "field's name and type and nothing about its meaning, so ask rather than pick. ")
    checked = []
    for entry in grades:
        if not isinstance(entry, dict):
            raise WorkflowError("each grade must be an object, not %r" % (entry,))
        unknown = set(entry) - {"column", "metal", "scale"}
        if unknown:
            raise WorkflowError("a grade carries column, metal and scale; not %s"
                                % ", ".join(sorted(unknown)))
        for field in ("column", "metal"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                raise WorkflowError("a grade needs a non-empty %r" % field)
        if len(entry["metal"]) > 32:
            raise WorkflowError("a metal name is at most 32 characters")
        try:
            scale = float(entry.get("scale"))
        except (TypeError, ValueError):
            raise WorkflowError(
                "grade %r needs a scale: 1 if its column already holds a fraction, "
                "0.01 if it holds percent. There is no default, because a wrong scale is "
                "wrong by a hundredfold and still looks right -- and because nothing in "
                "the project says which it is, so it is the user's to state." % entry["metal"]) from None
        if not math.isfinite(scale) or scale <= 0:
            raise WorkflowError("grade %r needs a finite positive scale" % entry["metal"])
        checked.append({"column": entry["column"], "metal": entry["metal"], "scale": scale})
    names = [entry["metal"] for entry in checked]
    if len(names) != len(set(names)):
        raise WorkflowError("two metals are named the same: %s. They would share one "
                            "column in the table and one of them would be lost."
                            % ", ".join(sorted({name for name in names if names.count(name) > 1})))
    return checked


# --------------------------------------------------------------------------
# The run.
# --------------------------------------------------------------------------

def run(project, block_model, grades, density, *,
        glossary=None, density_column=None, density_table=None,
        subdivide_max_size=None, roadway_term="巷道",
        orebody_term="矿体", log=print):
    """The whole flow.  Returns the report; writes nothing.

    `grades` names the METAL and is not a bare column id.  Which metal to report
    is not a thing this program can work out: the reference model's fields all
    declare `unit='1'` and no description, so `CU` is identifiable as a grade
    only because a person said so.  A run that took a column and printed
    `金属量_t` would produce a table whose meaning lived in whoever typed the
    command.
    """
    started = time.time()
    terms = load_glossary(glossary)
    for term in (roadway_term, orebody_term):
        if term not in terms:
            raise WorkflowError(
                "the glossary has no term %r; it declares %s"
                % (term, ", ".join(sorted(terms))))

    grades = validate_grades(grades)
    density = float(density)
    if not math.isfinite(density) or density <= 0:
        raise WorkflowError("density must be a finite positive t/m3 value")
    if subdivide_max_size is not None and (not math.isfinite(subdivide_max_size) or subdivide_max_size <= 0):
        raise WorkflowError("subdivide_max_size must be finite and positive")
    for value in (density_table or {}).values():
        if not math.isfinite(float(value)) or float(value) <= 0:
            raise WorkflowError("density_table values must be finite and positive")
    library = iam_algorithms.Library()
    try:
        port = iam.open(str(project))
    except iam.IamError as error:
        # A project that cannot be opened is a REFUSAL about the request, not a
        # defect in this program, and the difference is visible to the caller:
        # a refusal comes back as a value it can read and correct, while
        # anything else escapes as a failed call.  Measured: without this, a
        # wrong path reached the model as `IamError: IO: The operation
        # failed.` -- a status code where the answer is "that file is not
        # there", and the path was not even in the message.
        raise WorkflowError("打不开项目 %s：%s" % (project, error)) from error
    # The frame the algorithm layer must be told, read from the project rather
    # than guessed: the payload's metadata is what the constraint scales by.
    frame = port.coordinate_frame

    roadways = select(port, terms[roadway_term], roadway_term)
    orebodies = select(port, terms[orebody_term], orebody_term)
    log("%s: %d 巷道, %d 矿体" % (Path(project).name, len(roadways), len(orebodies)))

    source_snapshot = port.snapshot_bytes()
    project_payload = library.create_geometry({
        "schema_version": 1, "representation": "mine.project_snapshot",
        "metadata": {"coordinate_frame": frame, "length_unit": "m", "unit_to_meters": 1.0},
        "project_snapshot": {"encoding": "base64",
                             "media_type": "application/vnd.iax.mine-project+flatbuffers",
                             "data": _base64(source_snapshot)}})

    # -- the orebody: one solid, or the run stops ------------------------
    orebody_vertices, orebody_triangles, orebody_volume = None, None, None
    valid_orebodies = []
    for _, name, geometry in orebodies:
        surface_id = surface_of(port, geometry)
        if surface_id is None:
            continue
        vertices, triangles = read_surface(port, surface_id)
        volume, refusal = proven_solid(library, project_payload, surface_id, vertices, triangles)
        if volume is None:
            log("  矿体 %s 不是闭合实体：%s" % (name, refusal))
            continue
        valid_orebodies.append(name)
        orebody_vertices, orebody_triangles, orebody_volume = vertices, triangles, volume
        log("  矿体 %s: %d 三角形, %.1f m3" % (name, len(triangles), volume))
    if len(valid_orebodies) > 1:
        raise WorkflowError("matched multiple closed orebodies (%s); select one explicitly or provide a merged solid"
                            % ", ".join(valid_orebodies))
    if orebody_vertices is None:
        raise WorkflowError(
            "no orebody in %s is a closed solid, so no by-product can be intersected"
            % project)

    # -- the roadways: classify, then intersect --------------------------
    rows = []
    solids = []
    for element_id, name, geometry in sorted(roadways, key=lambda item: item[1]):
        surface_id = surface_of(port, geometry)
        if surface_id is None:
            rows.append(_row(name, UNMEASURED, "元素没有几何引用"))
            continue
        try:
            vertices, triangles = read_surface(port, surface_id)
        except iam.IamError as error:
            rows.append(_row(name, UNMEASURED, "读取几何失败：%s" % error))
            continue
        volume, refusal = proven_solid(library, project_payload, surface_id, vertices, triangles)
        repaired = 0
        if volume is None and "more than once" in (refusal or ""):
            vertices, triangles, repaired = drop_repeated_triangles(vertices, triangles, library=library)
            volume, refusal = proven_solid(library, project_payload, surface_id, vertices, triangles, frame)
            if volume is not None:
                log("  %s: 去掉 %d 个重复三角形后成为闭合实体" % (name, repaired))
        if volume is None:
            rows.append(_row(name, UNMEASURED, refusal))
            continue
        rows.append(_row(name, SOLID, "实体，%.1f m3%s"
                         % (volume, "（去掉 %d 个重复三角形）" % repaired if repaired else "")))
        rows[-1]["_row_index"] = len(solids)
        solids.append((name, vertices, triangles))

    # -- the by-product solids -------------------------------------------
    orebody_mesh = library.create_mesh(orebody_vertices, orebody_triangles)
    by_products = []
    for row in rows:
        if row["状态"] != SOLID:
            continue
        name, vertices, triangles = solids[row["_row_index"]]
        roadway_mesh = library.create_mesh(vertices, triangles)
        volume, refusal, payload, tried = intersect(library, roadway_mesh, orebody_mesh)
        row["_boolean_attempts"] = tried
        if refusal is not None:
            row["状态"] = UNMEASURED
            row["说明"] = "布尔运算拒绝执行：%s" % refusal
            continue
        if not volume:
            # Judged, and the judgement is zero.  A roadway that misses the
            # orebody has a by-product tonnage of zero, which is an answer and
            # counts as one -- the distinction this table keeps is between
            # "zero" and "not known", and it is the second that lowers coverage.
            row["状态"] = NO_BY_PRODUCT
            row["说明"] += "；与矿体不相交，副产为零"
            continue
        by_products.append((name, payload["vertices"], payload["triangles"]))
        row["_by_product_index"] = len(by_products) - 1
        row["副产体积_m3"] = volume

    # -- the block model -------------------------------------------------
    density_of = {"value": density, "column": density_column,
                  "table": _native_calculation(library, "density_table", density_table or {})}
    with ExitStack() as cell_owners:
        measured = measure_derived(port, library, block_model, grades, by_products,
                                   density_of, subdivide_max_size, keep_native=True)
        for table, _ in measured:
            if isinstance(table, iam_algorithms.MineCells):
                cell_owners.enter_context(table)
        for row in rows:
            index = row.pop("_by_product_index", None)
            if index is None:
                continue
            cells, refusal = measured[index]
            cell_info = cells.info if isinstance(cells, iam_algorithms.MineCells) else cells
            if cells is None:
                row["状态"] = UNMEASURED
                row["说明"] += "；块段模型圈定失败：%s" % refusal
                row["副产体积_m3"] = None
                continue
            totals = tonnage_and_metal(cells, grades, density_of, library=library)
            row["状态"] = MEASURED
            row["单元数"] = cell_info["cell_count"]
            row["矿石量_t"] = totals["ore_tonnes"]
            # ONE COLUMN PER METAL, NAMED.  A single `金属量_t` would make two runs
            # over different columns produce tables that look alike and mean
            # different things, and nothing in the file would say which.
            for metal, figure in totals["metals"].items():
                row[metal_column(metal)] = figure["metal_tonnes"]
            # The constraint keeps a cell whole when its CENTRE is inside, so the
            # tonnage carries the boundary cells' error.  The handle already reports
            # the interval that error lies in, and printing it is the difference
            # between a number with a bracket and a number pretending to be exact.
            lower = cell_info.get("volume_lower_bound_m3")
            upper = cell_info.get("volume_upper_bound_m3")
            if lower is not None and upper is not None:
                row["圈定体积_m3"] = cell_info["total_volume_m3"]
                row["体积下界_m3"] = lower
                row["体积上界_m3"] = upper
            for metal, figure in sorted(totals["metals"].items()):
                if figure["ungraded_cells"]:
                    row["说明"] += "；%s 有 %d 个单元无品位，仅计入矿石量" % (metal, figure["ungraded_cells"])
            if totals["undensified_cells"]:
                row["说明"] += "；%d 个单元无体重，未计入" % totals["undensified_cells"]

    for row in rows:
        row.pop("_row_index", None)

    # A roadway is JUDGED when this run formed an opinion about it -- including
    # the opinion that its by-product is zero.  Coverage is judged over selected,
    # and the totals cover only the judged, because a total over a selection it
    # could not measure is the number this workflow exists to refuse.
    report = {
        "project": str(project),
        "source_sha256": hashlib.sha256(source_snapshot).hexdigest(),
        "algorithm_version": library.algorithm_version,
        "catalog_version": library.catalog_version,
        "glossary": str(glossary or Path(__file__).with_name("glossary.default.json")),
        "glossary_sha256": hashlib.sha256(
            Path(glossary or Path(__file__).with_name("glossary.default.json")).read_bytes()).hexdigest(),
        "block_model": block_model,
        "grades": [dict(grade) for grade in grades],
        "density": {"value_or_table": density_of["value"], "column": density_column,
                    "table": density_of["table"]},
        "subdivide_max_size": subdivide_max_size,
        "orebody_volume_m3": orebody_volume,
        "rows": rows,
        "totals": _native_calculation(library, "totals", rows, grades, BOOLEAN_ATTEMPTS),
        "seconds": round(time.time() - started, 2),
    }
    return report


def metal_column(metal):
    """The table column one metal's tonnage goes in, named for that metal."""
    return "金属量_%s_t" % metal


def _row(name, status, note):
    return {"巷道": name, "状态": status, "说明": note, "副产体积_m3": None,
            "圈定体积_m3": None, "体积下界_m3": None, "体积上界_m3": None,
            "单元数": None, "矿石量_t": None}


# The four verdicts a roadway can get.  They are the whole honest content of the
# table: two of them are answers and two are admissions.
SOLID = "实体"                # closed, and a candidate for the intersection
MEASURED = "已测量"            # by-product found, block model constrained, tons computed
NO_BY_PRODUCT = "无副产"       # judged: it does not reach the orebody; the answer is zero
UNMEASURED = "未测量"          # admitted: no judgement was formed, and the reason is beside it

# Everything but the metals, whose columns are the metals the run was asked for.
COLUMNS = ["巷道", "状态", "说明", "副产体积_m3", "圈定体积_m3", "体积下界_m3", "体积上界_m3",
           "单元数", "矿石量_t"]


def columns_for(report):
    """This table's columns, which depend on which metals were asked for."""
    return COLUMNS + [metal_column(grade["metal"]) for grade in report["grades"]]


def write_table(report, path):
    """The deliverable.  CSV, because that is what every reader opens."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = columns_for(report)
    with path.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        for row in report["rows"]:
            writer.writerow(["" if row.get(column) is None else
                             (round(row[column], 4) if isinstance(row.get(column), float)
                              else row.get(column, "")) for column in columns])
        totals = report["totals"]
        writer.writerow([])
        writer.writerow(["所选巷道", totals["roadways_selected"]])
        writer.writerow(["已判定巷道", totals["roadways_judged"]])
        writer.writerow(["其中有副产的巷道", totals["roadways_with_by_product"]])
        writer.writerow(["覆盖率（已判定/所选）", "%.1f%%" % (totals["coverage"] * 100)])
        writer.writerow(["副产体积合计 m3", round(totals["by_product_volume_m3"], 3)])
        writer.writerow(["矿石量合计 t", round(totals["ore_tonnes"], 3)])
        # The metal totals are named too, and carry the scale they were read at:
        # the number alone cannot say whether it was computed from a fraction or
        # from percent, and that is the one parameter a reader cannot check.
        for grade in report["grades"]:
            writer.writerow(["金属量合计 %s t" % grade["metal"],
                             round(totals["metals"][grade["metal"]], 3)])
            writer.writerow(["  （%s 列 %s，scale %g）"
                             % (grade["metal"], grade["column"], grade["scale"]), ""])
    return path


def parse_grades(values):
    """`--grade COLUMN:METAL:SCALE`, repeated once per metal."""
    grades = []
    for value in values:
        parts = value.split(":")
        if len(parts) != 3 or not all(part.strip() for part in parts):
            raise WorkflowError(
                "--grade takes COLUMN:METAL:SCALE, e.g. merge-2-dimine-cell-1:CU:0.01 "
                "(got %r). The scale is required: 1 if the column holds a fraction, "
                "0.01 if it holds percent." % value)
        column, metal, scale = (part.strip() for part in parts)
        grades.append({"column": column, "metal": metal, "scale": scale})
    return grades


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", required=True, help="a .iam or .iamh document")
    parser.add_argument("--block-model", required=True, help="the BlockModel's resource id")
    parser.add_argument("--grade", required=True, action="append", metavar="COLUMN:METAL:SCALE",
                        help="a metal to report, repeatable: the numeric column holding its grade, "
                             "the metal's name (which titles the column in the table), and the scale "
                             "its values are read at -- 1 if the column already holds a fraction, "
                             "0.01 if it holds percent. Nothing here is inferable: the reference "
                             "model declares unit='1' for every field, so neither which column is a "
                             "grade nor what its numbers mean can be worked out from the project.")
    parser.add_argument("--density", required=True, type=float,
                        help="tonnes per cubic metre; there is no default, because a "
                             "default would be a number this program invented")
    parser.add_argument("--density-column", default=None,
                        help="a category column selecting a density from --density-table")
    parser.add_argument("--density-table", default=None,
                        help="JSON file: {\"<category code>\": <tonnes per cubic metre>}")
    parser.add_argument("--subdivide-max-size", type=float, default=None,
                        help="metres; refine the block model at the by-product surface")
    parser.add_argument("--glossary", default=None, help="a glossary.json other than the default")
    parser.add_argument("--roadway-term", default="巷道")
    parser.add_argument("--orebody-term", default="矿体")
    parser.add_argument("--out", default=None, help="the CSV to write")
    parser.add_argument("--report", default=None, help="a JSON run record to write")
    arguments = parser.parse_args(argv)

    table = None
    if arguments.density_table:
        table = json.loads(Path(arguments.density_table).read_text(encoding="utf-8"))

    report = run(arguments.project, arguments.block_model, parse_grades(arguments.grade),
                 arguments.density, glossary=arguments.glossary,
                 density_column=arguments.density_column, density_table=table,
                 subdivide_max_size=arguments.subdivide_max_size,
                 roadway_term=arguments.roadway_term, orebody_term=arguments.orebody_term)

    totals = report["totals"]
    print("\n所选巷道 %d 条，已判定 %d 条（覆盖率 %.1f%%），其中有副产的 %d 条"
          % (totals["roadways_selected"], totals["roadways_judged"],
             totals["coverage"] * 100, totals["roadways_with_by_product"]))
    print("副产体积 %.3f m3，矿石量 %.3f t（%.1f 秒）"
          % (totals["by_product_volume_m3"], totals["ore_tonnes"], report["seconds"]))
    for grade in report["grades"]:
        print("  金属量 %s %.3f t（列 %s，scale %g）"
              % (grade["metal"], totals["metals"][grade["metal"]],
                 grade["column"], grade["scale"]))
    if arguments.out:
        print("表：%s" % write_table(report, arguments.out))
    if arguments.report:
        Path(arguments.report).parent.mkdir(parents=True, exist_ok=True)
        Path(arguments.report).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("运行记录：%s" % arguments.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
