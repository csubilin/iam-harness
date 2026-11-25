"""Write the platform's own drawing format, ``.iamp``, from Python.

The geometry a harness computes -- section outlines, hatch strokes, grid lines,
dimensions, labels, a title block -- becomes a real drawing file here, not an
SVG stand-in.  The writer is the same ``DbMiningPlotIO`` the import tools and the
Drawing view use; this module is the language binding in front of it.

Three things to know before using it:

* **A plot is a session.**  Add layers, text styles and entities, then write.
  Every add returns the entity's persistent handle: that is what a source entry
  needs. The writer translates it to a document-local record index.
* **Coordinates are model units** (metres for a metric document).  Paper scale
  and paper-space translation are not applied here; the sheet's scale is
  metadata.  All 2D entities lie in the XY plane with normal +Z.
* **This version writes model space only.**  Layouts, viewports and true
  paper-space composition are not exposed yet.  A composed sheet is written
  flattened into model space; the sheet structure still records its type and
  scale.

Text in Chinese needs a text style whose face has CJK glyphs: the skeleton's
Standard style is an SHX face with none.  :meth:`Plot.add_text_style` creates
one, and ``text_style="..."`` on :meth:`Plot.add_text` selects it.

Typical use::

    import iam

    with iam.Plot() as plot:
        plot.set_document(project_id="p1", sheet_id="section-1", revision=3)
        plot.set_sheet(sheet_type="section", scale=(1, 500))
        plot.add_layer("SECTION", color=7, line_weight=35)
        outline = plot.add_polyline(points, closed=True, layer="SECTION")
        plot.add_source(outline, kind="element_geometry", role="model_projection",
                        element_id="orebody", geometry_id="g1")
        print(plot.write("section.iamp"))
"""

import ctypes
import hashlib
import math
import os
from pathlib import Path

from . import _plot_ctypes as _plot_abi
from ._plot_ctypes import (ABI_VERSION, CORRUPT, INTERNAL, IO, LIMIT, LINE_WEIGHT_DEFAULT,
                        NOT_FOUND, OK, ROLES, SHEET_TYPES, SOURCE_KINDS, STATUS_NAMES,
                        UNSUPPORTED, INVALID, PlotError)

__all__ = [
    "Plot", "PlotError", "library_path", "load_library", "discover_plot",
    "ABI_VERSION", "SHEET_TYPES", "ROLES", "SOURCE_KINDS", "STATUS_NAMES",
    "LINE_WEIGHT_DEFAULT",
]

_LIBRARY_ENV = "IAM_PLOT_C_LIBRARY"
_PLATFORM_ROOT_ENV = "IAX_PLATFORM_ROOT"

# Kept alive for the process's lifetime.  os.add_dll_directory returns a handle
# that removes the directory when closed, so letting it be collected would undo
# the search path a loaded library still needs.
_DLL_DIRECTORY_HANDLES = []


def _find_nearby_library_names(path):
    directory = Path(path).parent
    if not directory.is_dir():
        return []
    stem = Path(path).name.split(".")[0]
    if stem.startswith("lib"):
        stem = stem[3:]
    return sorted(item.name for item in directory.iterdir() if stem and stem in item.name)[:8]


def _require_configured_library_file(path, variable):
    if Path(path).is_file():
        return
    neighbours = _find_nearby_library_names(path)
    raise PlotError(
        INVALID,
        "%s names %s, which is not a file.%s  Leave %s unset to let the build tree be "
        "searched, or name an existing file." % (
            variable, path,
            "  Beside it: %s." % ", ".join(neighbours) if neighbours else "",
            variable))


def library_path(explicit=None):
    """Finds libIamPlotC.

    Resolution order: an explicit path, then ``$IAM_PLOT_C_LIBRARY``, then the
    build tree under ``$IAX_PLATFORM_ROOT`` (what the harness sets) or the
    checkout this file lives in.  The directory is searched by name rather than
    hard-coded because the output leaf differs by compiler family and platform.
    """
    if explicit:
        _require_configured_library_file(explicit, "the path given to load_library")
        return Path(explicit)
    from_env = os.environ.get(_LIBRARY_ENV)
    if from_env:
        _require_configured_library_file(from_env, _LIBRARY_ENV)
        return Path(from_env)

    roots = []
    platform_root = os.environ.get(_PLATFORM_ROOT_ENV)
    if platform_root:
        roots.append(Path(platform_root))
    # .../Mining/Host/python/iam/plot.py -> the repository root.
    roots.append(Path(__file__).resolve().parents[4])

    candidates = []
    names = ("linux-native", "linux", "linux-static", "macos-native", "macos", "win-native", "win")
    for root in roots:
        for name in names:
            for leaf in ("bin", "exe"):
                directory = root / "build" / leaf / name
                candidates.extend(sorted(directory.glob("libIamPlotC.so*")))
                candidates.extend(sorted(directory.glob("IamPlotC.dll")))
                candidates.extend(sorted(directory.glob("libIamPlotC*.dylib")))
    candidates = [path for path in candidates if path.is_file()]
    if not candidates:
        raise PlotError(
            INVALID,
            "libIamPlotC was not found.  Build it with the platform's native build, or set "
            "%s to its path." % _LIBRARY_ENV)
    return candidates[0]


def load_library(path=None, required_abi=ABI_VERSION):
    """Loads libIamPlotC and refuses one older than this binding.

    On Windows the library's directory is added to the DLL search path first:
    ``IamPlotC.dll`` imports the Drawing libraries and the plot module beside
    it, and a caller who names the DLL by an absolute path has not thereby told
    the loader where its dependencies are.
    """
    resolved = library_path(path)
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        try:
            _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(resolved.parent)))
        except OSError:
            pass
    try:
        library = _plot_abi.PlotLibrary(resolved)
    except OSError as error:
        from . import LibraryMismatch
        raise LibraryMismatch(
            "%s is there but could not be loaded: %s.  On Windows that means a library it "
            "depends on is missing from the search path -- the build's output directory "
            "holds the rest of the platform and its runtime modules." % (resolved, error)) from error

    abi = library.abi_version()
    if abi < required_abi:
        from . import LibraryMismatch
        raise LibraryMismatch(
            "%s implements plot ABI %d but %d is required; rebuild the platform."
            % (resolved, abi, required_abi))
    return library


def _resolve_enum_choice(value, table, what):
    if isinstance(value, str):
        try:
            return table[value]
        except KeyError:
            raise ValueError("%s must be one of %s, not %r" % (what, ", ".join(sorted(table)), value))
    return int(value)


def _encode_optional_utf8(value):
    return None if value is None else str(value).encode("utf-8")


def _make_abi_point_2d(value):
    components = list(value)
    if len(components) not in (2, 3):
        raise ValueError("a 2D point needs two or three components")
    return _plot_abi.PlotPoint2d(float(components[0]), float(components[1]))


def _make_abi_point_3d(value):
    components = list(value)
    if len(components) == 2:
        components.append(0.0)
    if len(components) != 3:
        raise ValueError("a 3D point needs two or three components")
    return _plot_abi.PlotPoint3d(float(components[0]), float(components[1]), float(components[2]))


def _parse_scale_ratio(value):
    if value is None:
        return 1, 1
    numerator, denominator = value
    return int(numerator), int(denominator)


class Plot:
    """One .iamp document being built.  Use as a context manager or call close()."""

    def __init__(self, library=None):
        self.library = library or load_library()
        self._session = self.library.create_session()

    # -- lifetime ---------------------------------------------------------

    def close(self):
        if self._session is not None:
            self.library.lib.iamPlotSessionRelease(self._session)
            self._session = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
        return False

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass

    def _invoke_native_plot_operation(self, operation_name, *operation_arguments):
        if self._session is None:
            raise PlotError(INVALID, "this plot session has been closed")
        status = getattr(self.library.lib, operation_name)(self._session, *operation_arguments)
        if status != OK:
            raise PlotError(status, self.library.last_error(self._session))

    # -- document and sheet ----------------------------------------------

    def set_document(self, *, project_id="", sheet_id="", revision=0, view_spec=""):
        """Sets the document's identity: which sheet of which project, at which revision."""
        project_id_utf8 = _encode_optional_utf8(project_id)
        sheet_id_utf8 = _encode_optional_utf8(sheet_id)
        view_spec_utf8 = _encode_optional_utf8(view_spec)
        document_info = _plot_abi.PlotDocumentInfo(project_id_utf8, sheet_id_utf8, int(revision), view_spec_utf8)
        self._invoke_native_plot_operation("iamPlotSetDocumentInfo", ctypes.byref(document_info))

    def set_sheet(self, *, sheet_type="unspecified", scale=(1, 1),
                  projector_version="", rule_catalog_id="", rule_catalog_version="",
                  views=()):
        """Describes the sheet: its type, scale, producer, and the views it holds.

        ``views`` is a sequence of dicts with ``role``, ``kind``, ``level``,
        ``scale``, ``direction`` (3 numbers), ``section_origin``,
        ``block_record`` and ``extents`` (6 numbers).  ``block_record`` zero
        means this session's model space, which is where entities are written.
        """
        numerator, denominator = _parse_scale_ratio(scale)
        projector = _encode_optional_utf8(projector_version)
        catalog_id = _encode_optional_utf8(rule_catalog_id)
        catalog_version = _encode_optional_utf8(rule_catalog_version)

        view_descriptors = list(views)
        abi_views = (_plot_abi.PlotViewDescriptor * len(view_descriptors))()
        view_level_buffers = []
        for view_index, view in enumerate(view_descriptors):
            level = _encode_optional_utf8(view.get("level", ""))
            view_level_buffers.append(level)
            view_numerator, view_denominator = _parse_scale_ratio(view.get("scale", (1, 1)))
            direction = list(view.get("direction", (0.0, 0.0, 1.0)))
            if len(direction) != 3:
                raise ValueError("a view direction needs three components")
            extents = list(view.get("extents", (0.0,) * 6))
            if len(extents) != 6:
                raise ValueError("view extents need six components (minX..maxZ)")

            abi_views[view_index].role = _resolve_enum_choice(view.get("role", "unspecified"), ROLES, "view role")
            abi_views[view_index].kind = _resolve_enum_choice(view.get("kind", "unspecified"), SHEET_TYPES, "view kind")
            abi_views[view_index].level = level
            abi_views[view_index].scale_numerator = view_numerator
            abi_views[view_index].scale_denominator = view_denominator
            abi_views[view_index].direction_x = float(direction[0])
            abi_views[view_index].direction_y = float(direction[1])
            abi_views[view_index].direction_z = float(direction[2])
            abi_views[view_index].section_origin = float(view.get("section_origin", 0.0))
            abi_views[view_index].block_record = int(view.get("block_record", 0))
            (abi_views[view_index].min_x, abi_views[view_index].min_y, abi_views[view_index].min_z,
             abi_views[view_index].max_x, abi_views[view_index].max_y, abi_views[view_index].max_z) = (
                float(value) for value in extents)

        sheet = _plot_abi.PlotSheetDescriptor(
            _resolve_enum_choice(sheet_type, SHEET_TYPES, "sheet type"), numerator, denominator,
            projector, catalog_id, catalog_version, abi_views, len(view_descriptors))
        self._invoke_native_plot_operation("iamPlotSetSheet", ctypes.byref(sheet))
        # ``abi_views`` and ``view_level_buffers`` are alive until this function returns;
        # the C call above has already copied every field it needs.

    # -- appearance -------------------------------------------------------

    def add_layer(self, name, *, color=None, line_weight=None):
        """Creates a layer, or updates the properties the caller named.

        ``color`` is an ACI index (0..256); ``line_weight`` is an
        ``IaxDb::LineWeight`` value in hundredths of a millimetre (e.g. 25, 35,
        or -3 for the default).  ``None`` leaves that property alone.
        """
        encoded = _encode_optional_utf8(name)
        self._invoke_native_plot_operation("iamPlotAddLayer", encoded,
                     -1 if color is None else int(color),
                     LINE_WEIGHT_DEFAULT if line_weight is None else int(line_weight))

    def add_text_style(self, name, *, typeface="", file_name="", big_font="",
                       is_shape_file=False, bold=False, italic=False,
                       charset=0, pitch_and_family=0):
        """Creates or updates a text style.

        ``typeface`` selects a TrueType face (the way to get CJK glyphs) and
        requires ``file_name`` as well -- the platform otherwise resolves the
        file through a process-wide cache, and the first document in a process
        would encode a different style record from every later one.  An empty
        ``typeface`` with a non-empty ``file_name`` selects an SHX file,
        optionally with ``big_font``.  Text passes the style name via
        ``text_style=``.
        """
        if not name:
            raise ValueError("a text style name is required")
        encoded_name = _encode_optional_utf8(name)
        encoded_typeface = _encode_optional_utf8(typeface)
        encoded_file = _encode_optional_utf8(file_name)
        encoded_big_font = _encode_optional_utf8(big_font)
        style = _plot_abi.PlotTextStyle(
            encoded_name, encoded_typeface, encoded_file, encoded_big_font,
            1 if is_shape_file else 0, 1 if bold else 0, 1 if italic else 0,
            int(charset), int(pitch_and_family))
        self._invoke_native_plot_operation("iamPlotAddTextStyle", ctypes.byref(style))

    def _make_abi_entity_appearance(self, layer, color, line_weight, text_style):
        layer_bytes = _encode_optional_utf8(layer)
        text_style_bytes = _encode_optional_utf8(text_style)
        style = _plot_abi.PlotEntityAppearance(
            layer_bytes, text_style_bytes,
            -1 if color is None else int(color),
            LINE_WEIGHT_DEFAULT if line_weight is None else int(line_weight))
        return style, (layer_bytes, text_style_bytes)

    # -- entities ---------------------------------------------------------

    def add_line(self, start, end, *, layer="0", color=None, line_weight=None):
        """Adds a 3D line segment.  Returns its persistent handle."""
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        first, second = _make_abi_point_3d(start), _make_abi_point_3d(end)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddLine", ctypes.byref(style), ctypes.byref(first),
                     ctypes.byref(second), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_polyline(self, vertices, *, closed=False, elevation=0.0,
                     layer="0", color=None, line_weight=None):
        """Adds a lightweight polyline at one elevation.  Returns its handle."""
        points = list(vertices)
        if len(points) < 2:
            raise ValueError("a polyline needs at least two vertices")
        abi_vertices = (_plot_abi.PlotPoint2d * len(points))()
        for vertex_index, vertex_coordinates in enumerate(points):
            point = _make_abi_point_2d(vertex_coordinates)
            abi_vertices[vertex_index].x = point.x
            abi_vertices[vertex_index].y = point.y
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddPolyline", ctypes.byref(style), abi_vertices, len(points),
                     1 if closed else 0, float(elevation), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_circle(self, center, radius, *, layer="0", color=None, line_weight=None):
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        point = _make_abi_point_3d(center)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddCircle", ctypes.byref(style), ctypes.byref(point),
                     float(radius), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_arc(self, center, radius, start_angle_degrees, end_angle_degrees,
                *, layer="0", color=None, line_weight=None):
        """Adds an arc; Python angles are degrees, the C surface takes radians."""
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        point = _make_abi_point_3d(center)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddArc", ctypes.byref(style), ctypes.byref(point),
                     float(radius), math.radians(float(start_angle_degrees)),
                     math.radians(float(end_angle_degrees)), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_text(self, position, contents, *, height, rotation_degrees=0.0,
                 width_factor=1.0, text_style=None,
                 layer="0", color=None, line_weight=None):
        """Adds single-line text.  The platform refuses more than 256 characters."""
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, text_style)
        point = _make_abi_point_3d(position)
        encoded = _encode_optional_utf8(contents)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddText", ctypes.byref(style), ctypes.byref(point), encoded,
                     float(height), math.radians(float(rotation_degrees)),
                     float(width_factor), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_mtext(self, position, contents, *, height, width=0.0,
                  rotation_degrees=0.0, attachment=0, flow=0, text_style=None,
                  layer="0", color=None, line_weight=None):
        """Adds multi-line text.  attachment is 1..9, flow is 1..5; zero is the default."""
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, text_style)
        point = _make_abi_point_3d(position)
        encoded = _encode_optional_utf8(contents)
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddMText", ctypes.byref(style), ctypes.byref(point), encoded,
                     float(height), float(width), math.radians(float(rotation_degrees)),
                     int(attachment), int(flow), ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_aligned_dimension(self, extension_point_1, extension_point_2,
                              dimension_line_point, *, text="",
                              layer="0", color=None, line_weight=None):
        """Adds an aligned dimension.  ``text`` empty leaves the measured value."""
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        first_extension_point = _make_abi_point_3d(extension_point_1)
        second_extension_point = _make_abi_point_3d(extension_point_2)
        dimension_line_location = _make_abi_point_3d(dimension_line_point)
        encoded = _encode_optional_utf8(text) if text else None
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddAlignedDimension", ctypes.byref(style), ctypes.byref(first_extension_point),
                     ctypes.byref(second_extension_point), ctypes.byref(dimension_line_location), encoded, ctypes.byref(entity_handle))
        return int(entity_handle.value)

    def add_rotated_dimension(self, extension_point_1, extension_point_2,
                              dimension_line_point, *, rotation_degrees=0.0, text="",
                              layer="0", color=None, line_weight=None):
        style, appearance_string_buffers = self._make_abi_entity_appearance(layer, color, line_weight, None)
        first_extension_point = _make_abi_point_3d(extension_point_1)
        second_extension_point = _make_abi_point_3d(extension_point_2)
        dimension_line_location = _make_abi_point_3d(dimension_line_point)
        encoded = _encode_optional_utf8(text) if text else None
        entity_handle = ctypes.c_uint64()
        self._invoke_native_plot_operation("iamPlotAddRotatedDimension", ctypes.byref(style), ctypes.byref(first_extension_point),
                     ctypes.byref(second_extension_point), ctypes.byref(dimension_line_location),
                     math.radians(float(rotation_degrees)), encoded, ctypes.byref(entity_handle))
        return int(entity_handle.value)

    # -- provenance -------------------------------------------------------

    def add_source(self, handle, *, kind="none", role="unspecified",
                   element_id="", geometry_id="", column_id="", field_id="",
                   key="", rule_id="", rule_version="", referent=None):
        """Records where one drawn object came from.

        ``handle`` is the value an add method returned.  The writer refuses a
        source that names an object the document does not carry, rather than
        writing a dangling entry.
        """
        source_string_buffers = [
            _encode_optional_utf8(element_id), _encode_optional_utf8(geometry_id), _encode_optional_utf8(column_id),
            _encode_optional_utf8(field_id), _encode_optional_utf8(key), _encode_optional_utf8(rule_id), _encode_optional_utf8(rule_version)]
        source = _plot_abi.PlotSourceDescriptor(
            _resolve_enum_choice(kind, SOURCE_KINDS, "source kind"),
            _resolve_enum_choice(role, ROLES, "source role"),
            source_string_buffers[0], source_string_buffers[1], source_string_buffers[2], source_string_buffers[3],
            source_string_buffers[4], source_string_buffers[5], source_string_buffers[6],
            0 if referent is None else 1,
            0 if referent is None else int(referent))
        self._invoke_native_plot_operation("iamPlotAddSource", ctypes.c_uint64(int(handle)), ctypes.byref(source))

    # -- writing ----------------------------------------------------------

    def write(self, path):
        """Writes the document, replacing any existing file.

        Returns ``{"path", "bytes", "sha256", "io_status", "warning"}``.  The
        warning is a non-fatal writer diagnostic (a dropped object, for
        instance); a fatal one raises :class:`PlotError`.
        """
        output_path = Path(path)
        path_utf8 = str(output_path).encode("utf-8")
        io_status = ctypes.c_int32(0)
        self._invoke_native_plot_operation("iamPlotWrite", path_utf8, ctypes.byref(io_status))
        warning = self.library.last_error(self._session) or None
        encoded_drawing = output_path.read_bytes()
        return {
            "path": str(output_path.resolve()),
            "bytes": len(encoded_drawing),
            "sha256": hashlib.sha256(encoded_drawing).hexdigest(),
            "io_status": int(io_status.value),
            "warning": warning,
        }


_PLOT_CAPABILITIES = (
    ("mine.plot.new", "iam.Plot", "library=None", "Plot"),
    ("mine.plot.document", "iam.Plot.set_document",
     "project_id, sheet_id, revision, view_spec", "Plot"),
    ("mine.plot.sheet", "iam.Plot.set_sheet",
     "sheet_type, scale, projector_version, rule_catalog_id, rule_catalog_version, views", "Plot"),
    ("mine.plot.layer", "iam.Plot.add_layer", "name, color=None, line_weight=None", "Plot"),
    ("mine.plot.text_style", "iam.Plot.add_text_style",
     "name, typeface, file_name, big_font, is_shape_file, bold, italic, charset, pitch_and_family",
     "Plot"),
    ("mine.plot.line", "iam.Plot.add_line",
     "start, end, layer, color, line_weight", "Plot"),
    ("mine.plot.polyline", "iam.Plot.add_polyline",
     "vertices, closed, elevation, layer, color, line_weight", "Plot"),
    ("mine.plot.circle", "iam.Plot.add_circle", "center, radius, layer, color, line_weight", "Plot"),
    ("mine.plot.arc", "iam.Plot.add_arc",
     "center, radius, start_angle_degrees, end_angle_degrees, layer, color, line_weight", "Plot"),
    ("mine.plot.text", "iam.Plot.add_text",
     "position, contents, height, rotation_degrees, width_factor, text_style, layer, color, line_weight",
     "Plot"),
    ("mine.plot.mtext", "iam.Plot.add_mtext",
     "position, contents, height, width, rotation_degrees, attachment, flow, text_style, layer, color, line_weight",
     "Plot"),
    ("mine.plot.aligned_dimension", "iam.Plot.add_aligned_dimension",
     "extension_point_1, extension_point_2, dimension_line_point, text, layer, color, line_weight",
     "Plot"),
    ("mine.plot.rotated_dimension", "iam.Plot.add_rotated_dimension",
     "extension_point_1, extension_point_2, dimension_line_point, rotation_degrees, text, layer, color, line_weight",
     "Plot"),
    ("mine.plot.source", "iam.Plot.add_source",
     "handle, kind, role, element_id, geometry_id, column_id, field_id, key, rule_id, rule_version, referent",
     "Plot"),
    ("mine.plot.write", "iam.Plot.write", "path", "Plot"),
)


def discover_plot(prefix=""):
    """Describes the .iamp output calls for a harness.

    ``mine.plot.*`` entries are direct methods on :class:`Plot`; the paths use
    the same shape as :func:`iam.discover_data`, so one capability table can
    carry both the data verbs and the drawing output.
    """
    return [{"id": name, "call_kind": "direct", "python_direct": path,
             "parameters": parameters, "receiver": receiver}
            for name, path, parameters, receiver in _PLOT_CAPABILITIES
            if name.startswith(prefix)]
