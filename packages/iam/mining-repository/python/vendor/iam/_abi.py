"""Raw ctypes binding to libIamC.

Nothing here decides anything: it declares the C surface, converts its two-stage
UTF-8 reads and its status codes, and raises IamError on failure.  The
ergonomic layer is :mod:`iam.port`.

The declarations mirror Mining/Host/C/Include/IamC.h.  A function that is not
declared here does not exist as far as Python is concerned, which is deliberate:
every call goes through a prototype, so a signature that drifts from the header
fails loudly instead of corrupting the stack.
"""

import ctypes
from ctypes import (POINTER, c_char_p, c_double, c_float, c_int, c_int32, c_size_t, c_uint8, c_uint32,
                    c_uint64, c_void_p, c_int64)

# Mirrors IamCStatus.
OK = 0
INVALID = 1
NOT_FOUND = 2
CONFLICT = 3
INCOMPLETE = 4
UNLOCATED = 5
UNSUPPORTED = 6
CORRUPT = 7
IO = 8
CANCELLED = 9
LIMIT = 10

STATUS_NAMES = {
    OK: "OK",
    INVALID: "INVALID",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
    INCOMPLETE: "INCOMPLETE",
    UNLOCATED: "UNLOCATED",
    UNSUPPORTED: "UNSUPPORTED",
    CORRUPT: "CORRUPT",
    IO: "IO",
    CANCELLED: "CANCELLED",
    LIMIT: "LIMIT",
}

# Mirrors IamCResourceType, for erase().
RESOURCE_FRAME = 0
RESOURCE_FIELD = 1
RESOURCE_ELEMENT = 2
RESOURCE_POINT_SET = 4
RESOURCE_LINE_SET = 5
RESOURCE_POLYLINE_3D = 6
RESOURCE_GRID_SURFACE = 7
RESOURCE_BLOCK_MODEL = 8
RESOURCE_SURFACE = 9
RESOURCE_ATTRIBUTE_COLUMN = 14
RESOURCE_CROSS_SECTION = 15
RESOURCE_LINE_NETWORK = 16
RESOURCE_COMPOSITE = 17

# Mirrors IamCContainer, for save().  The names, in the same order, are how
# Port.save spells them for a caller who would rather not import this module.
CONTAINER_PORTABLE = 0
CONTAINER_COLUMNAR = 1
CONTAINER_NAMES = {"portable": CONTAINER_PORTABLE, "columnar": CONTAINER_COLUMNAR}

# Mirrors IamCStoreArrayType. These are physical .iamh array types.
STORE_FLOAT64 = 0
STORE_FLOAT32 = 1
STORE_UINT32 = 2
STORE_INT32 = 3
STORE_INT64 = 4
STORE_UINT8 = 5
STORE_TEXT = 6

# Mirrors IamCElementType, for the reads that address one geometry kind.
ELEMENT_POINT_SET = 2
ELEMENT_LINE_SET = 3
ELEMENT_SURFACE = 4
ELEMENT_GRID_SURFACE = 5
ELEMENT_BLOCK_MODEL = 6
ELEMENT_FEATURE = 11
ELEMENT_POLYLINE_3D = 13
ELEMENT_ATTRIBUTE = 14
ELEMENT_COORDINATE_FRAME = 15
ELEMENT_FIELD = 16
ELEMENT_CROSS_SECTION = 17
ELEMENT_NETWORK = 18
ELEMENT_COMPOSITE = 19

# Mirrors IamCCoordinateFrameString.
FRAME_NAME = 0
FRAME_VERTICAL_DATUM = 1
FRAME_WKT = 2

# Mirrors IamCFieldString.
FIELD_NAME = 0
FIELD_UNIT = 1
FIELD_DESCRIPTION = 2
FIELD_TIME_BASIS = 3

# Mirrors IamCValueType, whose VALUES are IamValueType's -- the header
# says so and the two enumerations agree member for member.
VALUE_NUMBER = 0
VALUE_INTEGER = 1
VALUE_BOOLEAN = 2
VALUE_TEXT = 3
VALUE_FLOAT32 = 4
VALUE_INT32 = 5
VALUE_UINT32 = 6
VALUE_TIMESTAMP = 7
VALUE_VECTOR2 = 8
VALUE_VECTOR3 = 9

# What counts as a number, copied from `numeric()` in
# Mining/Source/IamBlockModelConstraint.cpp rather than re-decided here: the
# constraint refuses a non-numeric column, so a caller offering a choice wants
# the same set the platform will accept.  BOOLEAN is in IamValueType and NOT
# in this set, exactly as it is not in that function.
NUMERIC_VALUE_TYPES = frozenset((VALUE_NUMBER, VALUE_INTEGER, VALUE_FLOAT32,
                                 VALUE_INT32, VALUE_UINT32, VALUE_TIMESTAMP))

VALUE_TYPE_NAMES = {
    VALUE_NUMBER: "number", VALUE_INTEGER: "integer", VALUE_BOOLEAN: "boolean",
    VALUE_TEXT: "text", VALUE_FLOAT32: "float32", VALUE_INT32: "int32",
    VALUE_UINT32: "uint32", VALUE_TIMESTAMP: "timestamp",
    VALUE_VECTOR2: "vector2", VALUE_VECTOR3: "vector3",
}

# Mirrors IamCSectionForm.  These are the codes the platform's
# expansion primitive understands, and the same codes its category dictionary
# carries, so a name here and a code in the project say the same thing.
SECTION_RECTANGULAR = 1
SECTION_SEMICIRCULAR_ARCH = 2
SECTION_ARC_ARCH = 3
SECTION_THREE_CENTRED_ARCH = 4

SECTION_FORM_NAMES = {
    SECTION_RECTANGULAR: "rectangular",
    SECTION_SEMICIRCULAR_ARCH: "semicircular-arch",
    SECTION_ARC_ARCH: "arc-arch",
    SECTION_THREE_CENTRED_ARCH: "three-centred-arch",
}

# Mirrors IamCProjectString.
PROJECT_ID = 0
PROJECT_NAME = 1
PROJECT_REFERENCE = 2

# Mirrors IamCElementString.
ELEMENT_NAME = 0
ELEMENT_PARENT = 1
ELEMENT_METADATA = 2

# Mirrors IamCAttributeString.
ATTRIBUTE_ELEMENT_ID = 0
ATTRIBUTE_FIELD_ID = 1
ATTRIBUTE_GEOMETRY_ID = 2

# Mirrors IamAttributeLocation, for filters beside attribute_info().
LOCATION_ELEMENT = 0
LOCATION_VERTEX = 1
LOCATION_PART = 2
LOCATION_FACE = 3
LOCATION_CELL = 4
LOCATION_PARENT_BLOCK = 6
LOCATION_SUBBLOCK = 7
LOCATION_GEOMETRY = 8

ERROR_CAPACITY = 1024


class IamError(RuntimeError):
    """A call failed.

    ``status`` is the IamCStatus value and ``message`` is the C surface's
    error text, which is "path: message" for a diagnostic.  The path is what
    makes the failure actionable, so it is kept rather than stripped.
    """

    def __init__(self, status, message):
        self.status = status
        self.message = message or ""
        super().__init__("%s: %s" % (STATUS_NAMES.get(status, status), self.message))


class StationFrame(ctypes.Structure):
    """Mirrors IamCStationFrame.

    origin/tangent/u_axis/v_axis are LOCAL SOURCE UNITS; the two lengths are
    metres.  See Mining/Include/IamStationFrame.h for why that is the point.
    """

    _fields_ = [
        ("origin", c_double * 3),
        ("tangent", c_double * 3),
        ("u_axis", c_double * 3),
        ("v_axis", c_double * 3),
        ("segment", c_uint32),
        ("segment_parameter", c_double),
        ("station_metres", c_double),
        ("length_metres", c_double),
    ]


class SectionParameters(ctypes.Structure):
    """Mirrors IamCSectionParameters.

    ``form`` is one of the SECTION_* codes.  ``chord_tolerance_metres`` of zero
    means the platform's default; whatever it resolves to is stored WITH the
    section, because it decides how finely an arc is subdivided and a
    re-expansion at another value would disagree for no design reason.
    """

    _fields_ = [
        ("form", c_int64),
        ("span_metres", c_double),
        ("wall_height_metres", c_double),
        ("arch_height_metres", c_double),
        ("chord_tolerance_metres", c_double),
    ]


class Point2(ctypes.Structure):
    """Mirrors IamCPoint2: one profile vertex, in metres along the axes."""

    _fields_ = [("x", c_double), ("y", c_double)]


class Point3(ctypes.Structure):
    """Mirrors IamCPoint3: a collar or a trace point, in frame-local units."""

    _fields_ = [("x", c_double), ("y", c_double), ("z", c_double)]


class DrillStation(ctypes.Structure):
    """Mirrors IamCDrillStation: one survey station, in metres and degrees.

    ``azimuth_degrees`` is clockwise from north and ``dip_degrees`` is negative
    downward -- the convention IamDrillHole.h fixes and the expansion uses.
    """

    _fields_ = [("depth_metres", c_double), ("azimuth_degrees", c_double),
                ("dip_degrees", c_double)]


# Mirrors IamCDrillSurveyBeyondLast and IamCDrillIntervalKind.
DRILL_STOP_AT_LAST_STATION = 0
DRILL_EXTRAPOLATE_LAST_STATION = 1
DRILL_SAMPLE_INTERVAL = 1
DRILL_LITHOLOGY_INTERVAL = 2


class RegularSubblock(ctypes.Structure):
    _fields_ = [("parent", c_uint32 * 3), ("minimum", c_uint32 * 3),
                ("maximum", c_uint32 * 3)]


class LineSegment(ctypes.Structure):
    """Mirrors IamCLineSegment: two indices into a line set's vertices."""

    _fields_ = [("first", c_uint32), ("second", c_uint32)]


class Triangle(ctypes.Structure):
    """Mirrors IamCTriangle: three indices into a surface's vertices.

    The vertex array these index is the one ``read_points`` returns with
    ``project_coordinates=False`` -- the STORED, frame-local positions.  A
    surface built from these and from project coordinates would sit in the
    wrong place rather than raise, so the two reads belong together.
    """

    _fields_ = [("first", c_uint32), ("second", c_uint32), ("third", c_uint32)]


class AttributeInfo(ctypes.Structure):
    """Mirrors IamCAttributeInfo: the shape of one attribute column."""

    _fields_ = [("location", c_int), ("hidden", c_int), ("value_count", c_size_t)]


class AttributeValue(ctypes.Structure):
    """Mirrors IamCValue for a bounded scalar read, including stored validity."""

    _fields_ = [("valid", c_int), ("number", c_double), ("integer", c_int64),
                ("boolean", c_int), ("vector2x", c_double), ("vector2y", c_double),
                ("vector3x", c_double), ("vector3y", c_double), ("vector3z", c_double)]


class AttributeValueEdit(ctypes.Structure):
    """One owned-by-caller sparse row update; text is copied by the C call."""

    _fields_ = [("index", c_uint64), ("value", AttributeValue), ("text_utf8", c_char_p)]


class CoordinateFrameInfo(ctypes.Structure):
    """Mirrors IamCCoordinateFrameInfo: the frame's NUMERIC half.

    The rest of a Frame -- its id, name, vertical datum and WKT -- comes from
    ``iamCoordinateFrameString`` and from the element id.  Together the two
    reads are every field ``Frame`` declares, which is what lets a caller copy a
    frame VERBATIM into a project it is building; a frame assembled from part of
    them would place geometry wrongly rather than fail.

    ``origin_metres`` and ``yaw_degrees`` are meaningful only when ``located`` is
    nonzero -- IamC.h says so, and the platform refuses a located frame whose
    project has no reference, which is why ``Port.project_reference`` is the
    other half of this pair.
    """

    _fields_ = [
        ("epsg", c_int32),
        ("metres_per_unit", c_double),
        ("located", c_int),
        ("origin_metres", c_double * 3),
        ("yaw_degrees", c_double),
    ]


class DeltaInfo(ctypes.Structure):
    """Mirrors IamCDeltaInfo.

    ``delta_version`` is the document's layout and ``contract_schema_version``
    the resource vocabulary it was written in -- two different numbers, both of
    which a reader has to check before it interprets anything.
    """

    _fields_ = [
        ("delta_version", c_uint32),
        ("contract_schema_version", c_uint32),
        ("base_revision", c_uint64),
    ]


class Library:
    """A loaded libIamC, with every prototype declared."""

    def __init__(self, path):
        self.path = str(path)
        self.lib = ctypes.CDLL(self.path)
        self._declare()

    def _declare(self):
        lib = self.lib
        lib.iamAbiVersion.restype = c_uint32
        lib.iamContractSchemaVersion.restype = c_uint32
        lib.iamContractSchemaText.argtypes = [c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamStartup.argtypes = [c_char_p, c_size_t]
        lib.iamShutdown.argtypes = []

        lib.iamDatabaseCreate.argtypes = [POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamStoreWriterCreate.argtypes = [c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamStoreWriterBeginArray.argtypes = [
            c_void_p, c_char_p, c_int, c_uint32, c_uint64, c_int, c_uint32, c_char_p, c_size_t]
        lib.iamStoreWriterAppend.argtypes = [
            c_void_p, c_char_p, c_void_p, c_size_t, c_uint64, c_char_p, c_size_t]
        lib.iamStoreWriterAppendText.argtypes = [
            c_void_p, c_char_p, POINTER(c_char_p), c_uint64, c_char_p, c_size_t]
        lib.iamStoreWriterCommit.argtypes = [c_void_p, c_char_p, c_char_p, c_size_t]
        lib.iamStoreWriterRelease.argtypes = [c_void_p]
        lib.iamStoreWriterRelease.restype = None
        lib.iamDatabaseRelease.argtypes = [c_void_p]
        lib.iamDatabaseCreateProject.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDatabaseOpenFile.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDatabaseSnapshot.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDatabaseUndo.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDatabaseRedo.argtypes = [c_void_p, c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDatabaseCommit.argtypes = [c_void_p, c_void_p, c_uint64, POINTER(c_void_p), c_char_p, c_size_t]

        lib.iamSnapshotRelease.argtypes = [c_void_p]
        lib.iamSnapshotRetain.argtypes = [c_void_p]
        lib.iamSnapshotRevision.argtypes = [c_void_p]
        lib.iamSnapshotRevision.restype = c_uint64
        lib.iamSnapshotSaveFile.argtypes = [c_void_p, c_char_p, c_char_p, c_size_t]
        # Declared only when the library has it, and it is the ONE prototype here
        # that is optional.  Both containers were always readable and only the
        # portable one was writable, so a library built before this entry point
        # exists is a real thing to meet -- and a bare attribute access would turn
        # meeting one into an AttributeError out of _declare(), before any call,
        # naming nothing about containers.  Port.save reports it by name instead.
        # This is the guard iam_algorithms' binder already uses, for the same
        # reason: a binding must be able to say what a library cannot do.
        if hasattr(lib, "iamSnapshotSaveFileAs"):
            lib.iamSnapshotSaveFileAs.argtypes = [c_void_p, c_char_p, c_int, c_char_p, c_size_t]
        lib.iamSnapshotOpenFile.argtypes = [c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamSnapshotEncode.argtypes = [
            c_void_p, POINTER(c_uint8), c_size_t, POINTER(c_size_t), c_char_p, c_size_t]

        lib.iamElementString.argtypes = [c_void_p, c_char_p, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamAttributeString.argtypes = [c_void_p, c_char_p, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamAttributeFloat64.argtypes = [
            c_void_p, c_char_p, POINTER(c_double), c_size_t, POINTER(c_size_t)]
        for name, value_type in (("iamAttributeFloat32", c_float),
                                 ("iamAttributeInt32", c_int32),
                                 ("iamAttributeUInt32", c_uint32),
                                 ("iamAttributeInt64", c_int64)):
            getattr(lib, name).argtypes = [
                c_void_p, c_char_p, POINTER(value_type), c_size_t, POINTER(c_size_t)]
        lib.iamAttributeValidity.argtypes = [
            c_void_p, c_char_p, POINTER(c_uint8), c_size_t, POINTER(c_size_t)]
        lib.iamAttributeValueCount.argtypes = [c_void_p, c_char_p, POINTER(c_size_t)]
        lib.iamAttributeValue.argtypes = [
            c_void_p, c_char_p, c_size_t, POINTER(AttributeValue),
            c_char_p, c_size_t, POINTER(c_size_t)]
        # ABI 3 adds this entry point. Leave version rejection to iam.require(),
        # which can report the library's actual version instead of AttributeError.
        if hasattr(lib, "iamAttributeNumericRange"):
            lib.iamAttributeNumericRange.argtypes = [
                c_void_p, c_char_p, c_size_t, c_size_t,
                POINTER(AttributeValue), c_size_t, POINTER(c_size_t)]
        lib.iamAttributeInfo.argtypes = [c_void_p, c_char_p, POINTER(AttributeInfo)]
        lib.iamFeatureGeometryCount.argtypes = [c_void_p, c_char_p, POINTER(c_size_t)]
        lib.iamFeatureGeometryId.argtypes = [
            c_void_p, c_char_p, c_size_t, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamElementCount.argtypes = [c_void_p, c_int]
        lib.iamElementCount.restype = c_size_t
        lib.iamElementId.argtypes = [c_void_p, c_int, c_size_t, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamElementStrings.argtypes = [c_void_p, c_int, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamReadElementPoints.argtypes = [
            c_void_p, c_int, c_char_p, c_int, POINTER(c_double), c_size_t, POINTER(c_size_t)]
        lib.iamBlockModelCellCount.argtypes = [c_void_p, c_char_p, POINTER(c_uint64)]
        lib.iamBlockLeafVolumes.argtypes = [
            c_void_p, c_char_p, c_uint64, c_size_t, POINTER(c_double), c_size_t, POINTER(c_size_t)]
        lib.iamRegularSubblockRange.argtypes = [
            c_void_p, c_char_p, c_uint64, c_size_t, POINTER(RegularSubblock), c_size_t,
            POINTER(c_size_t), POINTER(c_uint32)]
        lib.iamBlockCellCenter.argtypes = [
            c_void_p, c_char_p, c_uint64, c_int, POINTER(c_double)]
        lib.iamBlockCellVertices.argtypes = [
            c_void_p, c_char_p, c_uint64, c_int, POINTER(c_double), c_size_t, POINTER(c_size_t)]
        lib.iamBlockCellTopology.argtypes = [
            c_void_p, c_char_p, c_uint64, POINTER(c_uint32), c_size_t, POINTER(c_size_t),
            POINTER(c_uint32), c_size_t, POINTER(c_size_t)]
        lib.iamSurfaceTriangles.argtypes = [
            c_void_p, c_char_p, POINTER(Triangle), c_size_t, POINTER(c_size_t)]
        lib.iamLineSetSegmentCount.argtypes = [c_void_p, c_char_p, POINTER(c_size_t)]
        lib.iamLineSetSegment.argtypes = [c_void_p, c_char_p, c_size_t, POINTER(LineSegment)]
        lib.iamSurfaceTrianglesPage.argtypes = [
            c_void_p, c_char_p, c_uint64, c_size_t, POINTER(Triangle), c_size_t,
            POINTER(c_size_t), POINTER(c_uint64)]
        lib.iamSurfaceVerticesPage.argtypes = [
            c_void_p, c_char_p, c_int, c_uint64, c_size_t, POINTER(c_double), c_size_t,
            POINTER(c_size_t), POINTER(c_uint64)]
        lib.iamProjectString.argtypes = [c_void_p, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        # The frame's numeric half.  Declared beside the project strings because
        # the two are read together by anything that copies a frame: the strings
        # carry the name, datum and WKT, this carries the scale, the origin and
        # the yaw.  It reports through its status and takes no error buffer, so
        # Port reads it with `check` rather than `call`.
        lib.iamCoordinateFrameInfo.argtypes = [c_void_p, c_char_p, POINTER(CoordinateFrameInfo)]
        lib.iamCoordinateFrameString.argtypes = [
            c_void_p, c_char_p, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamFieldString.argtypes = [c_void_p, c_char_p, c_int, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamFieldType.argtypes = [c_void_p, c_char_p, POINTER(c_int)]
        lib.iamStationFrame.argtypes = [
            c_void_p, c_char_p, c_double, POINTER(StationFrame), c_char_p, c_size_t]

        # The expansion primitive.  Parameters travel as a struct rather than a
        # payload because, unlike a resource, this is an API argument that will
        # not grow when the schema does.
        lib.iamSectionProfile.argtypes = [
            POINTER(SectionParameters), POINTER(Point2), c_size_t, POINTER(c_size_t), c_char_p, c_size_t]
        lib.iamEditPutSection.argtypes = [
            c_void_p, c_char_p, POINTER(SectionParameters), c_char_p, c_char_p, c_size_t]
        lib.iamSectionProfileDeviation.argtypes = [
            c_void_p, c_char_p, POINTER(c_double), c_char_p, c_size_t]

        # The drill-hole expansion primitives.  The payloads are schema-shaped,
        # like iamEditPut; the survey and the interval depths travel as fixed
        # arrays because they are arguments to an expansion rather than
        # resources in their own right.  Guarded so a library built before ABI
        # 14 raises the version refusal, not AttributeError out of _declare().
        if hasattr(lib, "iamEditPutDrillHole"):
            lib.iamEditPutDrillHole.argtypes = [
                c_void_p, c_char_p, c_char_p, Point3, c_double,
                POINTER(DrillStation), c_size_t, c_int, c_char_p, c_size_t]
            lib.iamEditPutDrillIntervals.argtypes = [
                c_void_p, c_char_p, c_char_p, c_char_p, c_int,
                POINTER(c_double), POINTER(c_double), c_size_t, c_char_p, c_size_t]
            lib.iamDrillHolePoint.argtypes = [
                c_void_p, c_char_p, c_double, c_int, POINTER(c_double), c_char_p, c_size_t]
            lib.iamDrillHoleTraceDeviation.argtypes = [
                c_void_p, c_char_p, POINTER(c_double), c_char_p, c_size_t]
            lib.iamDrillHoleIntervalsDeviation.argtypes = [
                c_void_p, c_char_p, POINTER(c_double), c_char_p, c_size_t]

        lib.iamEditBegin.argtypes = [c_void_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamEditPut.argtypes = [c_void_p, c_char_p, c_char_p, c_size_t]
        lib.iamEditBeginExternalSurface.argtypes = [
            c_void_p, c_char_p, c_char_p, c_char_p, c_uint64, c_uint64, c_int, c_uint32,
            POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamExternalSurfaceAppendVertices.argtypes = [
            c_void_p, c_uint64, c_uint64, POINTER(c_double), c_char_p, c_size_t]
        lib.iamExternalSurfaceAppendTriangles.argtypes = [
            c_void_p, c_uint64, c_uint64, POINTER(c_uint32), c_char_p, c_size_t]
        lib.iamExternalSurfaceFinalize.argtypes = [c_void_p, c_char_p, c_size_t]
        lib.iamExternalSurfaceAbort.argtypes = [c_void_p]
        lib.iamEditAttributeValues.argtypes = [
            c_void_p, c_char_p, POINTER(AttributeValueEdit), c_size_t, c_char_p, c_size_t]
        lib.iamDatabaseCommitAttributeValues.argtypes = [
            c_void_p, c_void_p, c_char_p, POINTER(AttributeValueEdit), c_size_t,
            c_uint64, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamResourceFragmentJson.argtypes = [
            c_void_p, c_int, c_char_p, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamEditAttachGeometry.argtypes = [
            c_void_p, c_char_p, POINTER(c_char_p), c_size_t, c_char_p, c_size_t]
        lib.iamEditErase.argtypes = [c_void_p, c_int, c_char_p, c_char_p, c_size_t]
        lib.iamEditDryRun.argtypes = [c_void_p, c_char_p, c_size_t]
        lib.iamEditSetBudget.argtypes = [c_void_p, c_uint64]
        lib.iamEditEstimatedRetainedBytes.argtypes = [c_void_p]
        lib.iamEditEstimatedRetainedBytes.restype = c_size_t
        lib.iamEditDiagnosticCount.argtypes = [c_void_p]
        lib.iamEditDiagnosticCount.restype = c_size_t
        lib.iamEditDiagnostic.argtypes = [
            c_void_p, c_size_t, POINTER(c_int), c_char_p, c_size_t, c_char_p, c_size_t]
        lib.iamEditSummary.argtypes = [c_void_p, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamEditDiscard.argtypes = [c_void_p]

        # The delta document.  A document is its own handle because the first
        # question about one -- is it addressed to the project I hold, and which
        # revision does it edit -- is answered without a project at all.
        lib.iamDeltaOpen.argtypes = [c_void_p, c_size_t, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDeltaOpenJson.argtypes = [c_char_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamDeltaRelease.argtypes = [c_void_p]
        lib.iamDeltaInfo.argtypes = [c_void_p, POINTER(DeltaInfo)]
        lib.iamDeltaProjectId.argtypes = [c_void_p, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamDeltaSaveFile.argtypes = [c_void_p, c_char_p, c_char_p, c_size_t]
        lib.iamDeltaJson.argtypes = [c_void_p, c_char_p, c_size_t, POINTER(c_size_t)]
        lib.iamEditToDelta.argtypes = [c_void_p, POINTER(c_void_p), c_char_p, c_size_t]
        lib.iamEditBeginFromDelta.argtypes = [c_void_p, c_void_p, POINTER(c_void_p), c_char_p, c_size_t]


    # -- calling convention -------------------------------------------------

    def check(self, status, context=""):
        """Raises for a call that reports its status directly, without a buffer.

        The read half of the surface works this way -- it is the two-stage
        convention -- while the write half and the two primitives added for
        Python report through an error buffer and go through :meth:`call`.
        """
        if status != OK:
            raise IamError(status, context)
        return status

    def call(self, name, *args):
        """Calls ``name``, raising IamError if it reports a failure.

        Every write function reports through a status and a fixed error buffer,
        so this is the single place that turns one into an exception.

        ``*args`` are the function's parameters WITHOUT the trailing
        ``char* error, size_t errorCapacity`` pair: this allocates the buffer and
        appends both, which is why a call site here is shorter than the header
        declaration by exactly those two arguments.  Compare against the header
        with that in mind -- reading them as a mismatched parameter count is a
        false alarm this comment exists to save (2026-10-19).
        """
        error = ctypes.create_string_buffer(ERROR_CAPACITY)
        status = getattr(self.lib, name)(*(args + (error, ERROR_CAPACITY)))
        if status != OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))
        return status

    def readString(self, name, args, capacity=1024):
        """Performs a two-stage UTF-8 read: size query, then the read itself."""
        required = c_size_t()
        status = getattr(self.lib, name)(*(args + (None, 0, ctypes.byref(required))))
        if status != OK or required.value == 0:
            return ""
        buffer = ctypes.create_string_buffer(required.value)
        status = getattr(self.lib, name)(*(args + (buffer, required.value, ctypes.byref(required))))
        if status != OK:
            raise IamError(status, "string read failed")
        return buffer.value.decode("utf-8", "replace")
