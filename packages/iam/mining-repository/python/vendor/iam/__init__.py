"""iam -- the Python port onto the Mining platform.

Mining is the only truth on this platform; drawings, specifications and pictures
are read-only projections of one revision, and the only thing that changes the
truth is a delta committed through one write door.  This package is how a design
verb reaches that door.

Three things to know before using it:

* **A verb writes a payload, not a sequence of operations.**  :meth:`Port.put`
  takes a dict shaped by ``Mining/Schema/MiningProject.fbs``, so every field the
  schema has is addressable by name and a field added to the schema needs no
  change here.  An unknown name is refused, never dropped.
* **A geometry nothing references cannot be committed.**  The platform refuses
  it, so attaching new geometry to an element is done with
  :meth:`Port.attach`, which does the read for you.
* **Version negotiation is not optional.**  A host that does not know a newer
  schema drops the fields it does not recognise and produces geometry nobody
  asked for, silently.  :func:`load` refuses that before any work happens.

Typical use::

    import iam

    port = iam.open("host.iamh")
    port.put({"point_sets": [{"id": "p1", "points": [{"x": 0, "y": 0, "z": 0}]}]})
    port.attach("element-1", ["p1"])
    print(port.summary())
    port.commit()
    port.save("work-copy.iam")
"""

import os
import sys
from pathlib import Path

from ._abi import IamError, Library, StationFrame  # noqa: F401  (re-exported)

__all__ = ["load", "require", "schema", "open", "new", "stream", "open_delta", "discover_data", "Port", "Delta", "StreamWriter",
           "Plot", "PlotError", "discover_plot",
           "IamError", "LibraryMismatch",
           "libraryPath", "ABI_VERSION", "SCHEMA_VERSION",
           "ExplorationData", "Finding", "ImportResult", "Repair",
           "ExportResult", "read_exploration_workbook", "check_exploration_data",
           "repair_exploration_data", "import_exploration_data",
           "check_exploration_file", "repair_exploration_file",
           "read_exploration_project", "write_exploration_workbook",
           "export_exploration_data"]


_DATA_CAPABILITIES = (
    ("mine.data.schema", "iam.schema", ""),
    ("mine.data.create", "iam.new", "payload"),
    ("mine.data.stream", "iam.stream", "path"),
    ("mine.data.stream_begin_array", "iam.StreamWriter.begin_array", "dataset, data_type, columns=1, estimated_rows=0"),
    ("mine.data.stream_append", "iam.StreamWriter.append", "dataset, values"),
    ("mine.data.stream_append_text", "iam.StreamWriter.append_text", "dataset, values"),
    ("mine.data.stream_commit", "iam.StreamWriter.commit", "manifest"),
    ("mine.data.open", "iam.open", "path"),
    ("mine.data.open_delta", "iam.open_delta", "source"),
    ("mine.data.ids", "iam.Port.ids", "element_type"),
    ("mine.data.resource", "iam.Port.resource", "resource_type, resource_id"),
    ("mine.data.element_strings", "iam.Port.element_strings", "element_type, kind=None"),
    ("mine.data.element_geometry_ids", "iam.Port.element_geometry_ids", "element_id"),
    ("mine.data.field", "iam.Port.field", "field_id"),
    ("mine.data.attribute_info", "iam.Port.attribute_info", "column_id"),
    ("mine.data.attribute_values", "iam.Port.attribute_values", "column_id"),
    ("mine.data.attribute_numbers", "iam.Port.attribute_numbers", "column_id"),
    ("mine.data.read_points", "iam.Port.read_points", "element_type, element_id, project_coordinates=True"),
    ("mine.data.surface_triangles", "iam.Port.surface_triangles", "surface_id"),
    ("mine.data.put", "iam.Port.put", "payload"),
    ("mine.data.attach", "iam.Port.attach", "element_id, geometry_ids"),
    ("mine.data.update_attribute_rows", "iam.Port.update_attribute_rows", "column_id, rows"),
    ("mine.data.commit_attribute_rows", "iam.Port.commit_attribute_rows",
     "column_id, rows, expected_revision=None"),
    ("mine.data.erase", "iam.Port.erase", "resource_type, resource_id"),
    ("mine.data.dry_run", "iam.Port.dry_run", ""),
    ("mine.data.summary", "iam.Port.summary", ""),
    ("mine.data.commit", "iam.Port.commit", "expected_revision=None"),
    ("mine.data.undo", "iam.Port.undo", ""),
    ("mine.data.redo", "iam.Port.redo", ""),
    ("mine.data.delta", "iam.Port.delta", ""),
    ("mine.data.apply_delta", "iam.Port.apply_delta", "delta"),
    ("mine.data.commit_delta", "iam.Port.commit_delta", "delta"),
    ("mine.data.delta_save", "iam.Delta.save", "path"),
    ("mine.data.snapshot_bytes", "iam.Port.snapshot_bytes", ""),
    ("mine.data.save", "iam.Port.save", "path, container=None"),
    # Drill-hole expansion primitives: the survey parameters and their trace,
    # and the intervals and their segments, land in one call each.
    ("mine.data.put_drill_hole", "iam.Port.put_drill_hole",
     "trace, collar, total_depth, stations, element_id, extrapolate=True"),
    ("mine.data.put_drill_intervals", "iam.Port.put_drill_intervals",
     "line_set, element_id, trace_id, kind, intervals"),
    ("mine.data.drill_hole_point", "iam.Port.drill_hole_point",
     "trace_id, depth, project_coordinates=True"),
    ("mine.data.drill_hole_trace_deviation", "iam.Port.drill_hole_trace_deviation",
     "trace_id"),
    ("mine.data.drill_hole_intervals_deviation",
     "iam.Port.drill_hole_intervals_deviation", "line_set_id"),
    # The exploration workbook route: read/check/repair/import into a project,
    # and export a project back to a workbook.  The QC and repair reports belong
    # to the import direction and are written beside the source workbook.
    ("mine.data.import_exploration", "iam.import_exploration_data",
     "xlsx, output=None, units=None, repair=False, strict=False"),
    ("mine.data.check_exploration", "iam.check_exploration_file",
     "xlsx, units=None"),
    ("mine.data.repair_exploration", "iam.repair_exploration_file",
     "xlsx, repairs=None, units=None"),
    ("mine.data.export_exploration", "iam.export_exploration_data",
     "project, output"),
    ("mine.data.read_exploration_project", "iam.read_exploration_project",
     "port"),
    ("mine.data.write_exploration_workbook", "iam.write_exploration_workbook",
     "data, xlsx"),
)


def discover_data(prefix=""):
    """Describe Mining's direct data calls for a harness.

    Paths beginning ``iam.Port`` are methods on a project returned by
    ``iam.new`` or ``iam.open``. A host can publish an .iamh revision and
    export a portable .iam work copy. ``delta`` / ``apply_delta`` transfer one
    revision-checked edit; they do not reconcile divergent offline histories.
    The IAM algorithm catalog's invoke route is for computations.
    """
    return [{"id": name, "call_kind": "direct", "python_direct": path,
             "parameters": parameters,
             "receiver": "Port" if path.startswith("iam.Port.") else
                         "Delta" if path.startswith("iam.Delta.") else
                         "StreamWriter" if path.startswith("iam.StreamWriter.") else None}
            for name, path, parameters in _DATA_CAPABILITIES if name.startswith(prefix)]

# What this binding was written against.  A library that does not implement at
# least these cannot be trusted to understand what we send it.
ABI_VERSION = 14
SCHEMA_VERSION = 1


_LIBRARY_ENV = "IAM_C_LIBRARY"


class LibraryMismatch(RuntimeError):
    """The library is missing, cannot be loaded, or speaks a version this binding cannot use.

    One exception for all three because the caller does the same thing with each:
    the library it was told about is not the library it needs, and no retry or
    fallback inside this package can change that.
    """


def _neighbouring_names(path):
    """The files beside `path` that carry the same library name.

    A caller who names the wrong file has usually named a real one -- the
    spelling differs by platform and by layer (`IamC.dll` here,
    `libIamC.so` elsewhere) -- so what is actually there ends the search
    in one line.
    """
    directory = Path(path).parent
    if not directory.is_dir():
        return []
    stem = Path(path).name.split(".")[0]
    if stem.startswith("lib"):
        stem = stem[3:]
    return sorted(item.name for item in directory.iterdir() if stem and stem in item.name)[:8]


def _configured_library(path, variable):
    """Refuse a configured library path that is not a file, and say what is.

    `iam_algorithms` carries the same pair of checks for the same reason, and
    this is its twin: discovery finds the build tree in any checkout, so the only
    thing that can break it is an explicit path -- which is therefore the one
    place worth checking.  Measured 2026-10-12, when a harness session set an
    algorithm-library variable to a `.dll` this tree never writes and the whole
    failure it saw was `Could not find module '<that path>' (or one of its
    dependencies)`, naming neither the variable nor the file that is there.
    """
    if Path(path).is_file():
        return
    neighbours = _neighbouring_names(path)
    raise LibraryMismatch(
        "%s names %s, which is not a file.%s  Leave %s unset to let the build tree be "
        "searched, or name an existing file." % (
            variable, path,
            "  Beside it: %s." % ", ".join(neighbours) if neighbours else "",
            variable))


def _load_library(path):
    """ctypes.CDLL, with a message for the ambiguity its own message carries.

    Kept out of `_abi`, which declares the C surface and decides nothing.  On
    Windows `Could not find module 'X' (or one of its dependencies)` is raised
    both when X is missing and when X is present and a DLL it imports is not, and
    the two need opposite fixes.
    """
    try:
        return Library(path)
    except OSError as error:
        if not Path(path).is_file():
            raise
        raise LibraryMismatch(
            "%s is there but could not be loaded: %s.  On Windows that means a library it "
            "depends on is missing from the search path -- the build's output directory "
            "holds the rest of the platform and its runtime DLLs, and "
            "os.add_dll_directory() is how it is added." % (path, error)) from error


def libraryPath(explicit=None):
    """Finds libIamC.

    Resolution order: an explicit path, then ``$IAM_C_LIBRARY``, then the
    build tree this file lives in.  The build tree is searched by name rather
    than by a hard-coded directory because the library's SONAME is what a plugin
    binds to; which configuration produced it is not the caller's business.
    """
    if explicit:
        _configured_library(explicit, "the path given to load()")
        return Path(explicit)
    from_env = os.environ.get(_LIBRARY_ENV)
    if from_env:
        _configured_library(from_env, _LIBRARY_ENV)
        return Path(from_env)

    # .../Mining/Host/python/iam/__init__.py -> the repository root.
    root = Path(__file__).resolve().parents[4]
    candidates = []
    # TWO ROOTS, and the second one is not a nicety.  The tree picks its output
    # leaf by compiler family -- `build/bin/<platform>` for GCC and Clang,
    # `build/exe/<platform>` for a Windows build -- so searching only `bin`
    # finds nothing at all on Windows and reports the library as missing while
    # it sits exactly where the build put it.  `iam_algorithms`' own
    # `_build_library_directories()` carries the same pair for the same reason.
    for name in ("linux-native", "linux", "linux-static", "macos-native", "macos", "win-native", "win"):
        for leaf in ("bin", "exe"):
            directory = root / "build" / leaf / name
            candidates.extend(sorted(directory.glob("libIamC.so*")))
            candidates.extend(sorted(directory.glob("IamC.dll")))
            candidates.extend(sorted(directory.glob("libIamC*.dylib")))
    # A versioned name sorts before the bare symlink, and both work; prefer the
    # real file so a stale symlink cannot shadow it.
    candidates = [path for path in candidates if path.is_file()]
    if not candidates:
        raise LibraryMismatch(
            "libIamC was not found.  Build it with './build.sh build native', or set "
            "%s to its path." % _LIBRARY_ENV)
    return candidates[0]


def require(library, required_abi=ABI_VERSION, required_schema=SCHEMA_VERSION):
    """Refuses to go further when the library is not one this binding can use.

    A host older than the plugin is the dangerous direction, and it is dangerous
    precisely because it is quiet: flatbuffers ignores a field name it does not
    know, so a payload written against a newer schema would be accepted with the
    unknown parts simply absent.  Checking turns that into a refusal naming both
    versions.  A newer library is fine when it reports a compatible ABI and schema version.

    """
    abi = library.lib.iamAbiVersion()
    schema = library.lib.iamContractSchemaVersion()
    if abi < required_abi:
        raise LibraryMismatch(
            "%s implements C ABI %d but %d is required; rebuild the platform."
            % (library.path, abi, required_abi))
    if schema < required_schema:
        raise LibraryMismatch(
            "%s implements contract schema %d but %d is required.  Running anyway would drop "
            "every field the library does not know and produce geometry nobody asked for; "
            "rebuild the platform." % (library.path, schema, required_schema))
    return library


def load(path=None, required_abi=ABI_VERSION, required_schema=SCHEMA_VERSION):
    """Loads the library, checks the version, and initializes the platform."""
    library = _load_library(libraryPath(path))
    require(library, required_abi, required_schema)
    # Idempotent, and a no-op in a host that has already initialized IAX: the
    # ABI initializes the data layer only when nobody has, and only tears down
    # what it brought up.
    library.call("iamStartup")
    return library


def open(path, library=None):  # noqa: A001 - the name reads better at the call site
    """Opens a document and returns a :class:`~iam.port.Port` on it."""
    from .port import Port
    port = Port(library or load())
    port.open(path)
    return port


def new(payload, library=None):
    """Builds a project from nothing and returns a Port on it.

    ``payload`` is the same schema-shaped dict :meth:`Port.put` takes, and it
    carries the project's own ``id`` and ``frame``.
    """
    from .port import Port
    port = Port(library or load())
    port.create(payload)
    return port


def stream(path, library=None):
    """Create a bounded writer for a new host-side .iamh project."""
    return StreamWriter(library or load(), path)


def schema(library=None):
    """Return the exact flattened Mining project schema built into libIamC."""
    return (library or load()).readString("iamContractSchemaText", ())


def open_delta(source, library=None):
    """Opens a delta document without applying it.

    ``source`` is a path, the document's bytes, or its JSON text.  Reading a
    document needs no project: what it says about itself -- which project, which
    revision, which contract -- is what a caller checks before deciding to apply
    it, and that is the point of the format.
    """
    from .port import Delta
    return Delta.open(library or load(), source)


# Port is a public direct receiver and appears in discover_data().
from .port import Port, Delta  # noqa: E402
from .store_writer import StreamWriter  # noqa: E402
# The exploration workbook reader/checker/repairer/importer.  It imports Port
# above, so it must come after the line that defines it.
from .exploration import (  # noqa: E402
    ExplorationData, ExportResult, Finding, ImportResult, Repair,
    check_exploration_data, check_exploration_file, import_exploration_data,
    export_exploration_data, read_exploration_project, read_exploration_workbook,
    repair_exploration_data, repair_exploration_file, write_exploration_workbook)
# The .iamp output binding.  Importing the module declares the ctypes surface but
# does not load the library; Plot() does that when a session is asked for.
from .plot import Plot, PlotError, discover_plot  # noqa: E402
