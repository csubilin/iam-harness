"""Raw ctypes binding to libIamPlotC, the .iamp output surface.

Nothing here decides anything: it declares the C surface, converts status codes
and the two-stage UTF-8 read of the last error, and raises :class:`PlotError` on
failure.  The ergonomic layer is :mod:`iam.plot`.

The declarations mirror Mining/Plot/Host/C/Include/IamPlotC.h.  A function that
is not declared here does not exist as far as Python is concerned, which is
deliberate: every call goes through a prototype, so a signature that drifts from
the header fails loudly instead of corrupting the stack.
"""

import ctypes
from ctypes import (POINTER, c_char_p, c_double, c_int32, c_size_t, c_uint32,
                    c_uint64, c_void_p)

# Mirrors IamPlotCStatus.  Values 1, 2, 6, 7, 8 and 10 mean the same thing as
# their IamCStatus counterparts; 11 is the plot surface's unexpected-exception
# code.
OK = 0
INVALID = 1
NOT_FOUND = 2
UNSUPPORTED = 6
CORRUPT = 7
IO = 8
LIMIT = 10
INTERNAL = 11

STATUS_NAMES = {
    OK: "OK",
    INVALID: "INVALID",
    NOT_FOUND: "NOT_FOUND",
    UNSUPPORTED: "UNSUPPORTED",
    CORRUPT: "CORRUPT",
    IO: "IO",
    LIMIT: "LIMIT",
    INTERNAL: "INTERNAL",
}

ABI_VERSION = 1

# IAM_PLOT_LINE_WEIGHT_DEFAULT.  A line weight is IaxDb::LineWeight's value in
# hundredths of a millimetre; this sentinel means "leave the database default".
LINE_WEIGHT_DEFAULT = -2 ** 31

# Mirrors DbMiningPlotSheetType.
SHEET_UNSPECIFIED = 0
SHEET_PLAN = 1
SHEET_SECTION = 2
SHEET_LONGITUDINAL = 3
SHEET_DETAIL = 4
SHEET_COLUMNAR = 5

SHEET_TYPES = {
    "unspecified": SHEET_UNSPECIFIED,
    "plan": SHEET_PLAN,
    "section": SHEET_SECTION,
    "longitudinal": SHEET_LONGITUDINAL,
    "detail": SHEET_DETAIL,
    "columnar": SHEET_COLUMNAR,
}

# Mirrors DbMiningPlotRole.
ROLE_UNSPECIFIED = 0
ROLE_MODEL_PROJECTION = 1
ROLE_DIMENSION = 2
ROLE_STATION_LABEL = 3
ROLE_ANNOTATION = 4
ROLE_SECTION_LINE = 5
ROLE_HATCH = 6
ROLE_FRAME = 7
ROLE_TITLE_BLOCK = 8
ROLE_NORTH_ARROW = 9
ROLE_SCALE_BAR = 10
ROLE_GRID = 11
ROLE_DECORATION = 12

ROLES = {
    "unspecified": ROLE_UNSPECIFIED,
    "model_projection": ROLE_MODEL_PROJECTION,
    "dimension": ROLE_DIMENSION,
    "station_label": ROLE_STATION_LABEL,
    "annotation": ROLE_ANNOTATION,
    "section_line": ROLE_SECTION_LINE,
    "hatch": ROLE_HATCH,
    "frame": ROLE_FRAME,
    "title_block": ROLE_TITLE_BLOCK,
    "north_arrow": ROLE_NORTH_ARROW,
    "scale_bar": ROLE_SCALE_BAR,
    "grid": ROLE_GRID,
    "decoration": ROLE_DECORATION,
}

# Mirrors DbMiningPlotSourceKind.
SOURCE_NONE = 0
SOURCE_ELEMENT_GEOMETRY = 1
SOURCE_GEOMETRY_PARAMETER = 2
SOURCE_ELEMENT_ATTRIBUTE = 3
SOURCE_PROJECT_ATTRIBUTE = 4
SOURCE_VIEW_SPEC = 5
SOURCE_RULE = 6

SOURCE_KINDS = {
    "none": SOURCE_NONE,
    "element_geometry": SOURCE_ELEMENT_GEOMETRY,
    "geometry_parameter": SOURCE_GEOMETRY_PARAMETER,
    "element_attribute": SOURCE_ELEMENT_ATTRIBUTE,
    "project_attribute": SOURCE_PROJECT_ATTRIBUTE,
    "view_spec": SOURCE_VIEW_SPEC,
    "rule": SOURCE_RULE,
}

ERROR_CAPACITY = 1024


class PlotError(RuntimeError):
    """A plot call failed.

    ``status`` is the IamPlotCStatus value and ``message`` is the C surface's
    last-error text, which is "path: message" for a writer diagnostic.  The path
    is what makes the failure actionable, so it is kept.
    """

    def __init__(self, status, message):
        self.status = status
        self.message = message or ""
        super().__init__("%s: %s" % (STATUS_NAMES.get(status, status), self.message))


class PlotDocumentInfo(ctypes.Structure):
    _fields_ = [
        ("project_id", c_char_p),
        ("sheet_id", c_char_p),
        ("revision", c_uint64),
        ("view_spec", c_char_p),
    ]


class PlotViewDescriptor(ctypes.Structure):
    _fields_ = [
        ("role", c_int32),
        ("kind", c_int32),
        ("level", c_char_p),
        ("scale_numerator", c_int32),
        ("scale_denominator", c_int32),
        ("direction_x", c_double),
        ("direction_y", c_double),
        ("direction_z", c_double),
        ("section_origin", c_double),
        ("block_record", c_uint64),
        ("min_x", c_double),
        ("min_y", c_double),
        ("min_z", c_double),
        ("max_x", c_double),
        ("max_y", c_double),
        ("max_z", c_double),
    ]


class PlotSheetDescriptor(ctypes.Structure):
    _fields_ = [
        ("sheet_type", c_int32),
        ("scale_numerator", c_int32),
        ("scale_denominator", c_int32),
        ("projector_version", c_char_p),
        ("rule_catalog_id", c_char_p),
        ("rule_catalog_version", c_char_p),
        ("views", POINTER(PlotViewDescriptor)),
        ("view_count", c_size_t),
    ]


class PlotEntityAppearance(ctypes.Structure):
    _fields_ = [
        ("layer", c_char_p),
        ("text_style", c_char_p),
        ("color_index", c_int32),
        ("line_weight", c_int32),
    ]


class PlotTextStyle(ctypes.Structure):
    _fields_ = [
        ("name", c_char_p),
        ("typeface", c_char_p),
        ("file_name", c_char_p),
        ("big_font", c_char_p),
        ("is_shape_file", c_int32),
        ("bold", c_int32),
        ("italic", c_int32),
        ("charset", c_int32),
        ("pitch_and_family", c_int32),
    ]


class PlotPoint2d(ctypes.Structure):
    _fields_ = [("x", c_double), ("y", c_double)]


class PlotPoint3d(ctypes.Structure):
    _fields_ = [("x", c_double), ("y", c_double), ("z", c_double)]


class PlotSourceDescriptor(ctypes.Structure):
    _fields_ = [
        ("kind", c_int32),
        ("role", c_int32),
        ("element_id", c_char_p),
        ("geometry_id", c_char_p),
        ("column_id", c_char_p),
        ("field_id", c_char_p),
        ("key", c_char_p),
        ("rule_id", c_char_p),
        ("rule_version", c_char_p),
        ("has_referent", c_int32),
        ("referent", c_uint64),
    ]


class PlotLibrary:
    """A loaded libIamPlotC, with every prototype declared."""

    def __init__(self, path):
        self.path = str(path)
        self.lib = ctypes.CDLL(self.path)
        self._bind_function_prototypes()

    def _bind_function_prototypes(self):
        native_library = self.lib

        native_library.iamPlotAbiVersion.argtypes = ()
        native_library.iamPlotAbiVersion.restype = c_uint32
        native_library.iamPlotFormatVersion.argtypes = ()
        native_library.iamPlotFormatVersion.restype = c_uint32

        native_library.iamPlotSessionCreate.argtypes = (POINTER(c_void_p), c_char_p, c_size_t)
        native_library.iamPlotSessionCreate.restype = ctypes.c_int
        native_library.iamPlotSessionRelease.argtypes = (c_void_p,)
        native_library.iamPlotSessionRelease.restype = None
        native_library.iamPlotLastError.argtypes = (c_void_p, c_char_p, c_size_t, POINTER(c_size_t))
        native_library.iamPlotLastError.restype = ctypes.c_int

        native_library.iamPlotSetDocumentInfo.argtypes = (c_void_p, POINTER(PlotDocumentInfo))
        native_library.iamPlotSetDocumentInfo.restype = ctypes.c_int
        native_library.iamPlotSetSheet.argtypes = (c_void_p, POINTER(PlotSheetDescriptor))
        native_library.iamPlotSetSheet.restype = ctypes.c_int

        native_library.iamPlotAddLayer.argtypes = (c_void_p, c_char_p, c_int32, c_int32)
        native_library.iamPlotAddLayer.restype = ctypes.c_int
        native_library.iamPlotAddTextStyle.argtypes = (c_void_p, POINTER(PlotTextStyle))
        native_library.iamPlotAddTextStyle.restype = ctypes.c_int

        entity_handle_pointer = POINTER(c_uint64)
        appearance_pointer = POINTER(PlotEntityAppearance)
        point_3d_pointer = POINTER(PlotPoint3d)
        point_2d_pointer = POINTER(PlotPoint2d)

        native_library.iamPlotAddLine.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, point_3d_pointer, entity_handle_pointer)
        native_library.iamPlotAddLine.restype = ctypes.c_int
        native_library.iamPlotAddPolyline.argtypes = (c_void_p, appearance_pointer, point_2d_pointer, c_size_t, c_int32,
                                           c_double, entity_handle_pointer)
        native_library.iamPlotAddPolyline.restype = ctypes.c_int
        native_library.iamPlotAddCircle.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, c_double, entity_handle_pointer)
        native_library.iamPlotAddCircle.restype = ctypes.c_int
        native_library.iamPlotAddArc.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, c_double, c_double,
                                      c_double, entity_handle_pointer)
        native_library.iamPlotAddArc.restype = ctypes.c_int
        native_library.iamPlotAddText.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, c_char_p, c_double,
                                       c_double, c_double, entity_handle_pointer)
        native_library.iamPlotAddText.restype = ctypes.c_int
        native_library.iamPlotAddMText.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, c_char_p, c_double,
                                        c_double, c_double, c_int32, c_int32, entity_handle_pointer)
        native_library.iamPlotAddMText.restype = ctypes.c_int
        native_library.iamPlotAddAlignedDimension.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, point_3d_pointer,
                                                   point_3d_pointer, c_char_p, entity_handle_pointer)
        native_library.iamPlotAddAlignedDimension.restype = ctypes.c_int
        native_library.iamPlotAddRotatedDimension.argtypes = (c_void_p, appearance_pointer, point_3d_pointer, point_3d_pointer,
                                                   point_3d_pointer, c_double, c_char_p, entity_handle_pointer)
        native_library.iamPlotAddRotatedDimension.restype = ctypes.c_int

        native_library.iamPlotAddSource.argtypes = (c_void_p, c_uint64, POINTER(PlotSourceDescriptor))
        native_library.iamPlotAddSource.restype = ctypes.c_int
        native_library.iamPlotWrite.argtypes = (c_void_p, c_char_p, POINTER(c_int32))
        native_library.iamPlotWrite.restype = ctypes.c_int

    def abi_version(self):
        return int(self.lib.iamPlotAbiVersion())

    def format_version(self):
        return int(self.lib.iamPlotFormatVersion())

    def create_session(self):
        session_handle = c_void_p()
        error_buffer = ctypes.create_string_buffer(ERROR_CAPACITY)
        status = self.lib.iamPlotSessionCreate(
            ctypes.byref(session_handle), error_buffer, len(error_buffer))
        if status != OK:
            raise PlotError(status, (error_buffer.value or b"").decode("utf-8", "replace"))
        return session_handle

    def last_error(self, session):
        required_byte_count = c_size_t(0)
        status = self.lib.iamPlotLastError(session, None, 0, ctypes.byref(required_byte_count))
        if status == OK:
            return ""
        if status != LIMIT:
            return ""
        buffer_capacity = max(int(required_byte_count.value), 1)
        error_buffer = ctypes.create_string_buffer(buffer_capacity)
        status = self.lib.iamPlotLastError(
            session, error_buffer, buffer_capacity, ctypes.byref(required_byte_count))
        if status != OK:
            return ""
        return error_buffer.value.decode("utf-8", "replace")
