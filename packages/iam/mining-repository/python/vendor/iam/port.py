"""The port a design verb is handed.

A :class:`Port` owns one open project and at most one edit in flight.  A verb
calls read primitives to find out where things are, :meth:`put`/:meth:`attach` to
describe what it wants changed, and the host commits.  The verb never sees a
file, a handle or a revision number it did not ask for.
"""

import ctypes
import json
import warnings
from array import array
from ctypes import (c_char_p, c_double, c_float, c_int, c_int32, c_int64, c_size_t,
                    c_uint8, c_uint32, c_void_p)

from . import _abi
from ._abi import IamError


class Port:
    """One project, one edit in flight, and the primitives a verb needs."""

    def __init__(self, library):
        self._library = library
        self._lib = library.lib
        self._database = c_void_p()
        self._project = c_void_p()
        self._edit = c_void_p()
        # Set by the host from its command line.  A verb reads them through
        # arg(), so a verb never parses argv and never knows how it was invoked.
        self.arguments = {}
        # Zero disables the budget.  The host sets it from its command line, so
        # a caller driving the port directly gets no cap rather than a
        # surprising one.
        self.max_delta_bytes = 0
        library.call("iamDatabaseCreate", ctypes.byref(self._database))

    def arg(self, name, default=None, required=False):
        """A parameter the host was given for this verb."""
        if name in self.arguments:
            return self.arguments[name]
        if required:
            raise IamError(_abi.INVALID, "the host did not supply --arg %s=" % name)
        return default

    # -- lifecycle ----------------------------------------------------------

    def create(self, payload):
        """Builds a project from nothing.  The payload carries its id and frame."""
        handle = c_void_p()
        self._library.call("iamDatabaseCreateProject", self._database,
                           json.dumps(payload).encode("utf-8"), ctypes.byref(handle))
        self._project = handle

    def open(self, path):
        """Opens a .iam or .iamh document."""
        handle = c_void_p()
        self._library.call("iamDatabaseOpenFile", self._database,
                           str(path).encode("utf-8"), ctypes.byref(handle))
        self._project = handle

    def save(self, path, container=None):
        """Persist this revision as host data or a portable offline work copy.

        A `.iamh` is the host's columnar main store; a `.iam` materializes a
        self-contained, size-bounded snapshot for Desktop or WASM. The default
        container follows the suffix. `container` can explicitly select the C
        surface's `"columnar"` or `"portable"` writer. Saving a portable copy
        alone does not merge its later offline changes into the host store;
        revision-checked delta application is a separate operation.
        """
        if container is None:
            container = _abi.CONTAINER_COLUMNAR if str(path).lower().endswith(
                (".iamh", ".iaxh5")) else _abi.CONTAINER_PORTABLE
        elif isinstance(container, str):
            try:
                container = _abi.CONTAINER_NAMES[container]
            except KeyError:
                raise IamError(
                    _abi.INVALID,
                    "container must be 'portable' or 'columnar', not %r" % container)
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        if container == _abi.CONTAINER_COLUMNAR:
            if not hasattr(self._lib, "iamSnapshotSaveFileAs"):
                raise IamError(
                    _abi.UNSUPPORTED,
                    "%s writes only the portable .iam container; it has no "
                    "iamSnapshotSaveFileAs, so it cannot write a columnar store. "
                    "Rebuild the platform, or save to a .iam." % self._library.path)
            status = self._lib.iamSnapshotSaveFileAs(
                self._project, str(path).encode("utf-8"), ctypes.c_int(container),
                error, _abi.ERROR_CAPACITY)
        else:
            status = self._lib.iamSnapshotSaveFile(self._project, str(path).encode("utf-8"),
                                                       error, _abi.ERROR_CAPACITY)
        if status != _abi.OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))

    def close(self):
        if self._edit:
            self._lib.iamEditDiscard(self._edit)
            self._edit = None
        if self._project:
            self._lib.iamSnapshotRelease(self._project)
            self._project = None
        if self._database:
            self._lib.iamDatabaseRelease(self._database)
            self._database = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @property
    def revision(self):
        return self._lib.iamSnapshotRevision(self._project)

    @property
    def project_id(self):
        """The project's id, which undo and redo need.

        Read from the snapshot rather than remembered from `create()`: an opened
        document's id is not something the caller was ever told.
        """
        return self._library.readString("iamProjectString", (self._project, c_int(_abi.PROJECT_ID)))

    @property
    def coordinate_frame(self):
        """The project's coordinate frame name.

        A project has exactly one frame, and it is what a consumer holding the
        snapshot has to be told alongside it: an algorithm payload carries a
        frame name, and one that disagrees with the snapshot's describes a mine
        placed somewhere else.
        """
        frames = self.ids(_abi.ELEMENT_COORDINATE_FRAME)
        if not frames:
            raise IamError(_abi.NOT_FOUND, "the project declares no coordinate frame")
        return self._library.readString(
            "iamCoordinateFrameString",
            (self._project, frames[0].encode("utf-8"), c_int(_abi.FRAME_NAME)))

    @property
    def project_reference(self):
        """The project's reference, which a located frame requires.

        The platform refuses a project whose located frame has no reference
        ("A located project frame requires a defined project reference"), and it
        is right to: the reference is where the frame's origin is measured from,
        so a copy of a frame that drops it is a frame that has lost its place.
        Anything REBUILDING a project -- a derived view, a fixture -- carries
        this string verbatim or the result will not reopen.
        """
        return self._library.readString(
            "iamProjectString", (self._project, c_int(_abi.PROJECT_REFERENCE)))

    def coordinate_frame_info(self, frame_id=None):
        """The frame's numeric half: EPSG, unit scale, location and yaw.

        With :attr:`coordinate_frame` (the name) and the vertical datum and WKT
        read through ``iamCoordinateFrameString``, this is every field
        ``Frame`` declares except its id -- so a caller copying a frame has all
        of them and has to invent none, which matters because a guessed
        ``metres_per_unit`` is not an error but a wrong number.

        Defaults to the project's sole frame, which is the only one a project
        has.  ``origin_metres`` and ``yaw_degrees`` are meaningful only when
        ``located`` is true; see IamC.h.
        """
        if frame_id is None:
            frames = self.ids(_abi.ELEMENT_COORDINATE_FRAME)
            if not frames:
                raise IamError(_abi.NOT_FOUND, "the project declares no coordinate frame")
            frame_id = frames[0]
        info = _abi.CoordinateFrameInfo()
        self._library.check(
            self._lib.iamCoordinateFrameInfo(
                self._project, frame_id.encode("utf-8"), ctypes.byref(info)),
            "reading a coordinate frame's info")
        return info

    def coordinate_frame_string(self, kind, frame_id=None):
        """One string member of the project's frame: name, datum or WKT.

        The companion to :meth:`coordinate_frame_info`; both exist so that a
        caller copying a frame never has to reach for ``_abi`` itself.
        """
        if frame_id is None:
            frames = self.ids(_abi.ELEMENT_COORDINATE_FRAME)
            if not frames:
                raise IamError(_abi.NOT_FOUND, "the project declares no coordinate frame")
            frame_id = frames[0]
        return self._library.readString(
            "iamCoordinateFrameString",
            (self._project, frame_id.encode("utf-8"), c_int(kind)))

    # -- reading ------------------------------------------------------------

    def station_frame(self, polyline_id, station_metres):
        """Point and orthonormal frame at a station along an open centreline.

        ``origin``/``tangent``/``u_axis``/``v_axis`` come back in LOCAL SOURCE
        UNITS and ``length_metres`` in metres.  That is not a detail to work
        around: a cross-section stores its origin and axes in local units while
        its profile offsets are metres, so a frame built from project-space
        tangents is exactly right whenever the project's yaw is zero and rotated
        by the yaw angle whenever it is not, with nothing to report it.

        ``station_frame(centreline, 0.0).length_metres`` is the station range of
        the centreline, which for an OPEN polyline is also its length.  For a
        length use :meth:`measure_polyline_length` instead: it is the primitive
        for that question, it is catalogued with its unit, and it does not
        disagree with this one about a closed polyline.
        """
        frame = _abi.StationFrame()
        self._library.call("iamStationFrame", self._project,
                           polyline_id.encode("utf-8"), c_double(station_metres),
                           ctypes.byref(frame))
        return frame

    def element_geometry_ids(self, element_id):
        """The geometry an element currently references.

        Not needed for :meth:`attach`, which reads it for you; it is here because
        a verb sometimes has to ask before it decides.
        """
        count = c_size_t()
        self._library.check(self._lib.iamFeatureGeometryCount(
            self._project, element_id.encode("utf-8"), ctypes.byref(count)),
            "reading an element's geometry")
        result = []
        for index in range(count.value):
            result.append(self._library.readString(
                "iamFeatureGeometryId", (self._project, element_id.encode("utf-8"), c_size_t(index))))
        return result

    def read_points(self, element_type, element_id, project_coordinates=True):
        """The coordinates of one geometry resource, as a list of (x, y, z).

        ``project_coordinates`` chooses between the project frame and the local
        source units the resource is stored in, which is the same distinction the
        station frame carries.
        """
        required = c_size_t()
        encoded = element_id.encode("utf-8")
        self._library.check(self._lib.iamReadElementPoints(
            self._project, c_int(element_type), encoded, c_int(1 if project_coordinates else 0),
            None, c_size_t(0), ctypes.byref(required)), "reading geometry points")
        if required.value == 0:
            return []
        buffer = (ctypes.c_double * (required.value * 3))()
        self._library.check(self._lib.iamReadElementPoints(
            self._project, c_int(element_type), encoded, c_int(1 if project_coordinates else 0),
            buffer, c_size_t(required.value), ctypes.byref(required)), "reading geometry points")
        return [(buffer[index * 3], buffer[index * 3 + 1], buffer[index * 3 + 2])
                for index in range(required.value)]

    def block_model_cell_count(self, model_id):
        """Number of active cell/subblock rows in a stored BlockModel."""
        count = ctypes.c_uint64()
        self._library.check(self._lib.iamBlockModelCellCount(
            self._project, model_id.encode("utf-8"), ctypes.byref(count)),
            "reading block model cell count")
        return count.value

    def block_leaf_volumes(self, model_id, offset, count):
        """Up to 4096 active leaf volumes in source units cubed, in attribute row order."""
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset < 2**64:
            raise ValueError("offset must be a nonnegative uint64")
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 4096:
            raise ValueError("count must be in 0..4096")
        rows = (c_double * count)()
        required = c_size_t()
        self._library.check(self._lib.iamBlockLeafVolumes(
            self._project, model_id.encode("utf-8"), offset, count,
            rows, count, ctypes.byref(required)), "reading block leaf volumes")
        return list(rows[:required.value])

    def regular_subblock_range(self, model_id, offset, count):
        """Regular subblock parent and integer bounds in active leaf row order."""
        if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset < 2**64:
            raise ValueError("offset must be a nonnegative uint64")
        if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 4096:
            raise ValueError("count must be in 0..4096")
        rows = (_abi.RegularSubblock * count)()
        required = c_size_t()
        division = (c_uint32 * 3)()
        self._library.check(self._lib.iamRegularSubblockRange(
            self._project, model_id.encode("utf-8"), offset, count,
            rows, count, ctypes.byref(required), division), "reading regular subblock rows")
        return {"division": tuple(division), "offset": offset,
                "rows": [{"parent": tuple(row.parent), "minimum": tuple(row.minimum),
                          "maximum": tuple(row.maximum)} for row in rows[:required.value]]}

    def block_cell_center(self, model_id, index, project_coordinates=True):
        """Center of one stored cell row, in project or model-local coordinates."""
        if not isinstance(index, int) or index < 0 or index > 0xFFFFFFFFFFFFFFFF:
            raise ValueError("cell index must be a nonnegative uint64")
        xyz = (c_double * 3)()
        self._library.check(self._lib.iamBlockCellCenter(
            self._project, model_id.encode("utf-8"), index,
            1 if project_coordinates else 0, xyz), "reading block cell center")
        return tuple(xyz)

    def block_cell_vertices(self, model_id, index, project_coordinates=True):
        """One cell's vertices in the order addressed by its face topology."""
        if not isinstance(index, int) or index < 0 or index > 0xFFFFFFFFFFFFFFFF:
            raise ValueError("cell index must be a nonnegative uint64")
        encoded = model_id.encode("utf-8")
        count = c_size_t()
        self._library.check(self._lib.iamBlockCellVertices(
            self._project, encoded, index, 1 if project_coordinates else 0,
            None, 0, ctypes.byref(count)), "reading block cell vertex count")
        xyz = (c_double * (3 * count.value))()
        self._library.check(self._lib.iamBlockCellVertices(
            self._project, encoded, index, 1 if project_coordinates else 0,
            xyz, count.value, ctypes.byref(count)), "reading block cell vertices")
        return [(xyz[3 * row], xyz[3 * row + 1], xyz[3 * row + 2])
                for row in range(count.value)]

    def block_cell_topology(self, model_id, index):
        """Face-start offsets and vertex indices for one cell's vertices."""
        if not isinstance(index, int) or index < 0 or index > 0xFFFFFFFFFFFFFFFF:
            raise ValueError("cell index must be a nonnegative uint64")
        encoded = model_id.encode("utf-8")
        start_count, index_count = c_size_t(), c_size_t()
        self._library.check(self._lib.iamBlockCellTopology(
            self._project, encoded, index, None, 0, ctypes.byref(start_count),
            None, 0, ctypes.byref(index_count)), "reading block cell topology size")
        starts = (c_uint32 * start_count.value)()
        indices = (c_uint32 * index_count.value)()
        self._library.check(self._lib.iamBlockCellTopology(
            self._project, encoded, index, starts, start_count.value, ctypes.byref(start_count),
            indices, index_count.value, ctypes.byref(index_count)), "reading block cell topology")
        return list(starts), list(indices)

    def line_set_segments(self, line_set_id):
        """The line set's stored index pairs, in OnPart attribute row order."""
        encoded = line_set_id.encode("utf-8")
        count = c_size_t()
        self._library.check(self._lib.iamLineSetSegmentCount(
            self._project, encoded, ctypes.byref(count)), "reading line set segment count")
        pair = _abi.LineSegment()
        segments = []
        for index in range(count.value):
            self._library.check(self._lib.iamLineSetSegment(
                self._project, encoded, index, ctypes.byref(pair)), "reading line set segment")
            segments.append((pair.first, pair.second))
        return segments

    def surface_triangles(self, surface_id):
        """A TriangulatedSurface's triangles, as a list of (first, second, third).

        Pairs with :meth:`read_points` called with ``project_coordinates=False``:
        the indices address the STORED, frame-local vertices, and the constraint
        solver reads a containing surface in exactly that space.  Taking the
        project-coordinate vertices instead produces a shell in the wrong place,
        which is a wrong number rather than an error -- so the two reads are
        documented together and the workflow uses neither flag by accident.

        Reading a surface's vertices without this leaves a point cloud: no
        boolean and no containment test can be built from it.
        """
        required = c_size_t()
        encoded = surface_id.encode("utf-8")
        self._library.check(self._lib.iamSurfaceTriangles(
            self._project, encoded, None, c_size_t(0), ctypes.byref(required)),
            "reading a surface's triangles")
        if required.value == 0:
            return []
        buffer = (_abi.Triangle * required.value)()
        self._library.check(self._lib.iamSurfaceTriangles(
            self._project, encoded, buffer, c_size_t(required.value), ctypes.byref(required)),
            "reading a surface's triangles")
        return [(buffer[index].first, buffer[index].second, buffer[index].third)
                for index in range(required.value)]

    def surface_triangles_page(self, surface_id, offset, count=4096):
        """Read at most 4096 triangle rows and return (rows, total)."""
        if count < 0 or count > 4096:
            raise ValueError("count must be between 0 and 4096")
        rows = (_abi.Triangle * count)()
        written = c_size_t()
        total = ctypes.c_uint64()
        self._library.check(self._lib.iamSurfaceTrianglesPage(
            self._project, surface_id.encode("utf-8"), offset, count, rows, count,
            ctypes.byref(written), ctypes.byref(total)), "reading a surface triangle page")
        return ([(rows[i].first, rows[i].second, rows[i].third)
                 for i in range(written.value)], total.value)

    def surface_vertices_page(self, surface_id, offset, count=4096,
                              project_coordinates=True):
        """Read at most 4096 vertex rows and return (XYZ rows, total)."""
        if count < 0 or count > 4096:
            raise ValueError("count must be between 0 and 4096")
        coordinates = (c_double * (count * 3))()
        written = c_size_t()
        total = ctypes.c_uint64()
        self._library.check(self._lib.iamSurfaceVerticesPage(
            self._project, surface_id.encode("utf-8"), int(project_coordinates),
            offset, count, coordinates, count, ctypes.byref(written),
            ctypes.byref(total)), "reading a surface vertex page")
        return ([(coordinates[i * 3], coordinates[i * 3 + 1], coordinates[i * 3 + 2])
                 for i in range(written.value)], total.value)

    def snapshot_bytes(self):
        """The current revision as raw FlatBuffers payload, with no file container.

        This is what an IAM algorithm wants for a ``project_snapshot``: the bytes
        INSIDE a .iam, not the .iam.  ``decode()`` reads a payload and nothing
        around it, so handing it the file gives the verifier a zlib stream to
        report as corrupt.

        It is a read of the revision this Port holds, so after :meth:`commit` it
        returns the new revision -- which is how a derived solid reaches an
        algorithm without ever being saved to a file.
        """
        required = c_size_t()
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        self._library.check(self._lib.iamSnapshotEncode(
            self._project, None, c_size_t(0), ctypes.byref(required), error, _abi.ERROR_CAPACITY),
            "sizing the encoded snapshot")
        if required.value == 0:
            return b""
        buffer = (c_uint8 * required.value)()
        self._library.check(self._lib.iamSnapshotEncode(
            self._project, buffer, c_size_t(required.value), ctypes.byref(required),
            error, _abi.ERROR_CAPACITY), "encoding the snapshot")
        return bytes(buffer)

    def ids(self, element_type):
        """Every resource id of one kind in the current revision.

        An agent enumerating a mine needs this, and it is the only way to ask
        "which of these exist" without already knowing the answer.
        """
        count = self._lib.iamElementCount(self._project, c_int(element_type))
        return [self._library.readString(
            "iamElementId", (self._project, c_int(element_type), c_size_t(index)))
            for index in range(count)]

    def resource(self, resource_type, resource_id):
        """Return one complete schema-shaped resource from the current revision.

        The returned dict can be placed under its MiningProject.fbs collection
        name and passed to put for inline resources. Chunked attribute columns
        retain their store descriptors. External geometry is refused because
        its separate manifest cannot be round-tripped through put.
        """
        collections = {
            _abi.RESOURCE_FRAME: ("frame",),
            _abi.RESOURCE_FIELD: ("fields",),
            _abi.RESOURCE_ELEMENT: ("elements",),
            _abi.RESOURCE_POINT_SET: ("point_sets",),
            _abi.RESOURCE_LINE_SET: ("line_sets",),
            _abi.RESOURCE_LINE_NETWORK: ("line_networks",),
            _abi.RESOURCE_POLYLINE_3D: ("polylines_3d",),
            _abi.RESOURCE_GRID_SURFACE: ("grid_surfaces",),
            _abi.RESOURCE_BLOCK_MODEL: ("regular_block_models", "tensor_block_models"),
            _abi.RESOURCE_SURFACE: ("surfaces",),
            _abi.RESOURCE_CROSS_SECTION: ("cross_sections",),
            _abi.RESOURCE_COMPOSITE: ("composites",),
            _abi.RESOURCE_ATTRIBUTE_COLUMN: ("attribute_columns",),
        }
        if resource_type not in collections:
            raise IamError(_abi.INVALID, "unknown resource type")
        encoded = resource_id.encode("utf-8")
        required = c_size_t()
        self._library.check(self._lib.iamResourceFragmentJson(
            self._project, c_int(resource_type), encoded, None, 0,
            ctypes.byref(required)), "reading resource %s" % resource_id)
        buffer = ctypes.create_string_buffer(required.value)
        self._library.check(self._lib.iamResourceFragmentJson(
            self._project, c_int(resource_type), encoded, buffer, required.value,
            ctypes.byref(required)), "reading resource %s" % resource_id)
        fragment = json.loads(buffer.value.decode("utf-8"))
        if resource_type == _abi.RESOURCE_FRAME:
            return fragment["frame"]
        for collection in collections[resource_type]:
            values = fragment.get(collection, [])
            if values:
                return values[0]
        raise IamError(_abi.CORRUPT, "resource fragment omitted its requested resource")

    def element_strings(self, element_type, kind=None):
        """One string member of EVERY element of a type, in one call.

        Returns a list parallel to :meth:`ids` of the same type -- the same
        order, the same length -- because listing a project one round trip per
        element is the difference between a listing and a crawl.

        ``kind`` is one of the ELEMENT_* string constants; NAME is the default
        and the only one every named resource has.  PARENT and METADATA belong
        to a semantic element (ELEMENT_FEATURE) alone, and asking a centreline
        for its parent raises UNSUPPORTED rather than returning empty strings --
        "has no parent" and "parent is empty" are different facts.
        """
        if kind is None:
            kind = _abi.ELEMENT_NAME
        count = self._lib.iamElementCount(self._project, c_int(element_type))
        if not count:
            return []
        required = c_size_t()
        self._library.call("iamElementStrings", self._project, c_int(element_type),
                           c_int(kind), None, 0, ctypes.byref(required))
        buffer = ctypes.create_string_buffer(required.value)
        self._library.call("iamElementStrings", self._project, c_int(element_type),
                           c_int(kind), buffer, required.value, ctypes.byref(required))
        # `count` NUL-terminated strings and nothing after the last, so
        # splitting yields one more part than there are strings and the trailing
        # empty one is the artifact of the final terminator, not a resource.
        # A sentinel would have made an unnamed resource indistinguishable from
        # the end of the run, and an unnamed resource is legitimate.
        raw = buffer.raw[:required.value]
        return [part.decode("utf-8", "replace") for part in raw.split(b"\0")[:-1]]

    def element_name(self, element_id):
        return self._readElementString(element_id, _abi.ELEMENT_NAME)

    def element_metadata(self, element_id):
        return self._readElementString(element_id, _abi.ELEMENT_METADATA)

    def _readElementString(self, element_id, kind):
        return self._library.readString(
            "iamElementString", (self._project, element_id.encode("utf-8"), c_int(kind)))

    def attribute_field_id(self, column_id):
        """The field a column supplies values for."""
        return self._library.readString(
            "iamAttributeString",
            (self._project, column_id.encode("utf-8"), c_int(_abi.ATTRIBUTE_FIELD_ID)))

    def attribute_element_id(self, column_id):
        """The element a column belongs to."""
        return self._library.readString(
            "iamAttributeString",
            (self._project, column_id.encode("utf-8"), c_int(_abi.ATTRIBUTE_ELEMENT_ID)))

    def attribute_geometry_id(self, column_id):
        """The geometry a geometry-scoped column addresses; empty for element scope."""
        return self._library.readString(
            "iamAttributeString",
            (self._project, column_id.encode("utf-8"), c_int(_abi.ATTRIBUTE_GEOMETRY_ID)))

    def field(self, field_id):
        """What a field declares about itself: its name, unit and value type.

        THIS IS WHAT A PERSON CHOOSES A COLUMN BY.  An id like
        `merge-2-dimine-cell-1` says nothing about whether it holds a grade, a
        density or a level number; the field it names is the only place that is
        recorded, and `numeric` is the same set the block-model constraint
        accepts, copied from Mining's own `numeric()` rather than re-decided.

        The reference model declares `unit='1'` and an empty description for
        every field, so this can say `CU` and `float32` and still not say what
        the numbers mean -- which is why a caller that needs a grade has to ask
        rather than infer.
        """
        encoded = field_id.encode("utf-8")
        kind = c_int()
        self._library.check(self._lib.iamFieldType(self._project, encoded, ctypes.byref(kind)),
                            "reading a field's type")
        return {
            "id": field_id,
            "name": self._library.readString("iamFieldString", (self._project, encoded, c_int(_abi.FIELD_NAME))),
            "unit": self._library.readString("iamFieldString", (self._project, encoded, c_int(_abi.FIELD_UNIT))),
            "description": self._library.readString(
                "iamFieldString", (self._project, encoded, c_int(_abi.FIELD_DESCRIPTION))),
            "value_type": _abi.VALUE_TYPE_NAMES.get(kind.value, str(kind.value)),
            "numeric": kind.value in _abi.NUMERIC_VALUE_TYPES,
        }

    def attribute_info(self, column_id):
        """The column's location, hidden flag and value count."""
        info = _abi.AttributeInfo()
        self._library.call("iamAttributeInfo", self._project, column_id.encode("utf-8"),
                           ctypes.byref(info))
        return info

    def attribute_numbers(self, column_id):
        """Numeric rows in stored order; absent rows are ``None``.

        Bounded numeric range reads handle inline, paged and external columns.
        """
        encoded = column_id.encode("utf-8")
        field_id = self.attribute_field_id(column_id).encode("utf-8")
        kind = c_int()
        self._library.check(self._lib.iamFieldType(self._project, field_id,
                            ctypes.byref(kind)), "reading a column's field type")
        if kind.value not in _abi.NUMERIC_VALUE_TYPES:
            raise IamError(_abi.INVALID, "%s is not a numeric column" % column_id)
        required = c_size_t()
        self._library.check(self._lib.iamAttributeValueCount(
            self._project, encoded, ctypes.byref(required)), "reading attribute count")
        count = required.value
        result = []
        for offset in range(0, count, 4096):
            rows = min(4096, count - offset)
            page = (_abi.AttributeValue * rows)()
            required = c_size_t()
            self._library.check(self._lib.iamAttributeNumericRange(
                self._project, encoded, offset, rows, page, rows,
                ctypes.byref(required)), "reading attribute rows at %d" % offset)
            if required.value != rows:
                raise IamError(_abi.CORRUPT, "%s ended before row %d" % (column_id, count))
            floats = kind.value in (_abi.VALUE_NUMBER, _abi.VALUE_FLOAT32, _abi.VALUE_TIMESTAMP)
            result.extend((row.number if floats else row.integer) if row.valid else None
                          for row in page)
        return result

    def attribute_values(self, column_id):
        """Read any field type in stored order, preserving nulls and Python types.

        This composes the existing C row accessor. Use attribute_numbers for
        large numeric columns because it reads bounded pages instead.
        """
        field_id = self.attribute_field_id(column_id)
        kind = c_int()
        self._library.check(self._lib.iamFieldType(
            self._project, field_id.encode("utf-8"), ctypes.byref(kind)),
            "reading an attribute field type")
        if kind.value in _abi.NUMERIC_VALUE_TYPES:
            return self.attribute_numbers(column_id)
        size = c_size_t()
        encoded = column_id.encode("utf-8")
        self._library.check(self._lib.iamAttributeValueCount(
            self._project, encoded, ctypes.byref(size)), "reading attribute count")
        result = []
        for index in range(size.value):
            value = _abi.AttributeValue()
            required = c_size_t()
            self._library.check(self._lib.iamAttributeValue(
                self._project, encoded, index, ctypes.byref(value), None, 0,
                ctypes.byref(required)), "reading attribute row %d" % index)
            if not value.valid:
                result.append(None)
            elif kind.value == _abi.VALUE_BOOLEAN:
                result.append(bool(value.boolean))
            elif kind.value == _abi.VALUE_TEXT:
                buffer = ctypes.create_string_buffer(required.value)
                self._library.check(self._lib.iamAttributeValue(
                    self._project, encoded, index, ctypes.byref(value), buffer,
                    required.value, ctypes.byref(required)),
                    "reading text attribute row %d" % index)
                result.append(buffer.value.decode("utf-8"))
            elif kind.value == _abi.VALUE_VECTOR2:
                result.append((value.vector2x, value.vector2y))
            elif kind.value == _abi.VALUE_VECTOR3:
                result.append((value.vector3x, value.vector3y, value.vector3z))
            else:
                raise IamError(_abi.UNSUPPORTED, "unsupported attribute field type")
        return result

    def attribute_number(self, column_id):
        """The single value of a column that holds exactly one."""
        values = self.attribute_numbers(column_id)
        if len(values) != 1:
            raise IamError(_abi.INVALID,
                               "%s holds %d values, not one" % (column_id, len(values)))
        return values[0]

    def section_profile(self, parameters):
        """Expands section parameters into a closed polygon, in metres.

        The pure form of the platform's expansion primitive: it needs no project
        and writes nothing, so a verb can see the shape it is about to commit.
        Returns a list of ``(u, v)`` offsets along the section's own axes -- and
        the axes themselves are local source units, which is why a verb must let
        station_frame() build those rather than deriving them.
        """
        native = self._sectionParameters(parameters)
        required = c_size_t()
        self._library.call("iamSectionProfile",
                           ctypes.byref(native), None, 0, ctypes.byref(required))
        buffer = (_abi.Point2 * required.value)()
        self._library.call("iamSectionProfile",
                           ctypes.byref(native), buffer, required.value, ctypes.byref(required))
        return [(buffer[index].x, buffer[index].y) for index in range(required.value)]

    def put_section(self, section, parameters, element_id):
        """Writes a cross-section AND the parameters it was expanded from.

        One call rather than three, because the two facts have to land together:
        a parameter set and the polygon it describes are two statements about one
        tunnel, and stored separately they can contradict each other while both
        are valid.  This discards any ``profile`` in ``section`` and writes the
        expansion instead, declares the parameter fields, writes one column per
        parameter scoped to this geometry, and attaches the section to
        ``element_id``.

        ``section`` is a dict shaped by ``MiningProject.fbs`` for one
        cross-section -- id, axis_geometry_id, station_metres, origin, u_axis,
        v_axis.  The axes come from :meth:`station_frame`.
        """
        self._begin()
        native = self._sectionParameters(parameters)
        text = json.dumps({"cross_sections": [section]})
        self._library.call("iamEditPutSection", self._edit, text.encode("utf-8"),
                           ctypes.byref(native), element_id.encode("utf-8"))
        self._checkBudget("put_section")

    def section_deviation(self, section_id):
        """Re-expands a section's stored parameters and measures the stored
        profile against the result.

        A MEASUREMENT, not a verdict: compare it against the section's own chord
        tolerance.  Returns ``None`` when the section carries no parameters --
        there is nothing to compare, which is a different statement from
        agreeing, and the platform reports the two differently.
        """
        deviation = c_double(0.)
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        status = self._lib.iamSectionProfileDeviation(
            self._project, section_id.encode("utf-8"), ctypes.byref(deviation),
            error, _abi.ERROR_CAPACITY)
        if status == _abi.NOT_FOUND:
            return None
        if status != _abi.OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))
        return deviation.value

    def put_drill_hole(self, trace, collar, total_depth, stations, element_id,
                       extrapolate=True):
        """Writes a drill-hole trace and the survey it was expanded from.

        ``trace`` is a dict shaped by MiningProject.fbs for one ``polylines_3d``
        entry -- id, name, source.  Its vertices are DISCARDED and replaced with
        the minimum-curvature expansion of ``collar`` and ``stations``, so the
        two facts cannot disagree.  ``collar`` is ``{"x", "y", "z"}`` or a
        three-item sequence in the project frame's stored units; ``stations`` is
        a sequence of ``(depth, azimuth, dip)`` triples in metres and degrees
        (azimuth clockwise from north, dip negative downward).

        ``extrapolate`` continues the last measured direction to
        ``total_depth`` and records the extrapolated length; False ends the
        trace at the last station, and intervals past it are then refused rather
        than invented.  The trace is attached to ``element_id``.
        """
        point = self._point3(collar)
        native = (_abi.DrillStation * len(stations))()
        for index, station in enumerate(stations):
            if isinstance(station, dict):
                depth = station["depth"]
                azimuth = station["azimuth"]
                dip = station["dip"]
            else:
                depth, azimuth, dip = station
            native[index].depth_metres = float(depth)
            native[index].azimuth_degrees = float(azimuth)
            native[index].dip_degrees = float(dip)
        self._begin()
        text = json.dumps({"polylines_3d": [trace]})
        self._library.call(
            "iamEditPutDrillHole", self._edit, element_id.encode("utf-8"),
            text.encode("utf-8"), point, float(total_depth), native, len(stations),
            _abi.DRILL_EXTRAPOLATE_LAST_STATION if extrapolate
            else _abi.DRILL_STOP_AT_LAST_STATION)
        self._checkBudget("put_drill_hole")

    def put_drill_intervals(self, line_set, element_id, trace_id, kind, intervals):
        """Writes one sample or lithology interval set and its from/to columns.

        ``line_set`` is a dict shaped by MiningProject.fbs for one ``line_sets``
        entry; its vertices and segments are DISCARDED and replaced with one
        segment per interval, in the same order.  ``kind`` is ``"sample"`` or
        ``"lithology"`` (or the corresponding ``_abi.DRILL_*`` code).
        ``intervals`` is a sequence of ``(from, to)`` pairs in metres.  The
        caller writes its own columns -- sample number, grades, rock code -- in
        the same edit; commit validation makes their row count and the segment
        count one fact.
        """
        if isinstance(kind, str):
            try:
                kind = {"sample": _abi.DRILL_SAMPLE_INTERVAL,
                        "lithology": _abi.DRILL_LITHOLOGY_INTERVAL}[kind]
            except KeyError:
                raise IamError(_abi.INVALID,
                               "kind must be 'sample' or 'lithology', not %r" % kind)
        from_values = (ctypes.c_double * len(intervals))()
        to_values = (ctypes.c_double * len(intervals))()
        for index, interval in enumerate(intervals):
            if isinstance(interval, dict):
                start, end = interval["from"], interval["to"]
            else:
                start, end = interval
            from_values[index] = float(start)
            to_values[index] = float(end)
        self._begin()
        text = json.dumps({"line_sets": [line_set]})
        self._library.call(
            "iamEditPutDrillIntervals", self._edit, element_id.encode("utf-8"),
            text.encode("utf-8"), trace_id.encode("utf-8"), int(kind),
            from_values, to_values, len(intervals))
        self._checkBudget("put_drill_intervals")

    def drill_hole_point(self, trace_id, depth, project_coordinates=True):
        """The point at a measured depth on a stored trace.

        Returns ``(x, y, z)`` in project or stored frame-local coordinates.
        ``None`` when the trace does not exist.  A depth past the trace raises
        ``UNLOCATED`` rather than answering with an invented point.
        """
        result = (ctypes.c_double * 3)()
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        status = self._lib.iamDrillHolePoint(
            self._project, trace_id.encode("utf-8"), float(depth),
            1 if project_coordinates else 0, result, error, _abi.ERROR_CAPACITY)
        if status == _abi.NOT_FOUND:
            return None
        if status != _abi.OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))
        return (result[0], result[1], result[2])

    def drill_hole_trace_deviation(self, trace_id):
        """Re-expands a trace and returns the largest stored-vertex distance.

        A MEASUREMENT, not a verdict: compare it against the tolerance the
        project was imported with.  ``None`` when the trace does not exist.
        """
        deviation = ctypes.c_double(0.)
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        status = self._lib.iamDrillHoleTraceDeviation(
            self._project, trace_id.encode("utf-8"), ctypes.byref(deviation),
            error, _abi.ERROR_CAPACITY)
        if status == _abi.NOT_FOUND:
            return None
        if status != _abi.OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))
        return deviation.value

    def drill_hole_intervals_deviation(self, line_set_id):
        """Re-expands an interval set and returns the largest endpoint distance.

        ``None`` when the line set does not exist.
        """
        deviation = ctypes.c_double(0.)
        error = ctypes.create_string_buffer(_abi.ERROR_CAPACITY)
        status = self._lib.iamDrillHoleIntervalsDeviation(
            self._project, line_set_id.encode("utf-8"), ctypes.byref(deviation),
            error, _abi.ERROR_CAPACITY)
        if status == _abi.NOT_FOUND:
            return None
        if status != _abi.OK:
            raise IamError(status, error.value.decode("utf-8", "replace"))
        return deviation.value

    @staticmethod
    def _point3(value):
        if isinstance(value, dict):
            return _abi.Point3(float(value["x"]), float(value["y"]), float(value["z"]))
        if len(value) != 3:
            raise IamError(_abi.INVALID, "a point needs exactly three coordinates")
        return _abi.Point3(float(value[0]), float(value[1]), float(value[2]))

    @staticmethod
    def _sectionParameters(parameters):
        native = _abi.SectionParameters()
        native.form = int(parameters["form"])
        native.span_metres = float(parameters["span"])
        native.wall_height_metres = float(parameters["wall_height"])
        native.arch_height_metres = float(parameters.get("arch_height", 0.0))
        native.chord_tolerance_metres = float(parameters.get("chord_tolerance", 0.0))
        return native

    # -- writing ------------------------------------------------------------

    def _begin(self):
        if self._edit:
            return
        handle = c_void_p()
        self._library.call("iamEditBegin", self._project, ctypes.byref(handle))
        self._edit = handle
        if self.max_delta_bytes:
            self._library.check(self._lib.iamEditSetBudget(
                self._edit, self.max_delta_bytes), "setting the edit byte budget")

    @property
    def retained_bytes(self):
        """Approximate heap this edit's delta retains, excluding its base.

        The quantity a host budgets against, and the same one the undo history
        is bounded by -- so a cap here and the history's limit mean the same
        thing by the same measure.
        """
        if not self._edit:
            return 0
        return self._lib.iamEditEstimatedRetainedBytes(self._edit)

    def _checkBudget(self, what):
        """Refuses the edit once it has grown past the session's budget.

        Checked after each call rather than before, so a plugin that has already
        overspent is stopped at the call that did it and the message can name
        which one.  One over-budget call still lands -- the same rule the undo
        history uses, where a single over-budget action stays undoable by
        itself -- but the plugin does not get to make a second one.
        """
        if not self.max_delta_bytes:
            return
        retained = self.retained_bytes
        if retained > self.max_delta_bytes:
            raise IamError(_abi.LIMIT,
                               "%s left this edit holding %d bytes, past the %d byte budget. "
                               "Nothing has been published; the edit is discarded."
                               % (what, retained, self.max_delta_bytes))

    def put(self, payload, chunk_bytes=None):
        """Puts a payload into the edit.

        ``payload`` is a dict shaped by ``MiningProject.fbs``.  The project's id
        and frame are supplied by the platform, so a payload must not restate
        them -- and if it does, the collision is refused with the field named
        rather than quietly winning.

        The payload is parsed, decoded and checked in full before the edit is
        touched, so a rejected payload leaves the edit exactly as it was.
        """
        if chunk_bytes is None and isinstance(payload, dict):
            candidates = payload.get("surfaces", ())
            if any(hasattr(surface.get("triangles"), "__len__") and
                   len(surface["triangles"]) >= 100000 for surface in candidates):
                chunk_bytes = 786432
                warnings.warn("Large surfaces are stored externally in chunked HDF5 arrays.",
                              RuntimeWarning, stacklevel=2)
        if chunk_bytes is not None:
            if not isinstance(payload, dict):
                raise ValueError("chunk_bytes requires a dict payload")
            remaining = dict(payload)
            surfaces = remaining.pop("surfaces", ())
            allowed = {"id", "name", "source", "vertices", "triangles", "display_style"}
            for surface in surfaces:
                extras = set(surface) - allowed
                if extras:
                    raise ValueError("streamed surface has unsupported fields: %s" % ", ".join(sorted(extras)))
                if not {"id", "vertices", "triangles"}.issubset(surface):
                    raise ValueError("streamed surface requires id, vertices and triangles")
            if remaining:
                self.put(remaining)

            def rows(values, names):
                try:
                    view = memoryview(values)
                except TypeError:
                    view = None
                if view is not None and view.ndim == 2:
                    return values
                return (tuple(row[name] for name in names) if isinstance(row, dict)
                        else row for row in values)

            for surface in surfaces:
                style = surface.get("display_style") or {}
                color = style.get("color") if style.get("has_color") else None
                self.put_surface_stream(surface["id"], surface.get("name", surface["id"]),
                                        rows(surface["vertices"], ("x", "y", "z")),
                                        rows(surface["triangles"], ("first", "second", "third")),
                                        display_color=color, chunk_bytes=chunk_bytes,
                                        source=surface.get("source", "stream"))
            return
        self._begin()
        text = payload if isinstance(payload, (str, bytes)) else json.dumps(payload)
        if isinstance(text, str):
            text = text.encode("utf-8")
        self._library.call("iamEditPut", self._edit, text)
        label = "put"
        if isinstance(payload, dict):
            for kind, resources in payload.items():
                if isinstance(resources, list) and resources and isinstance(resources[0], dict):
                    label = "put %s/%s" % (kind, resources[0].get("id", "unknown"))
                    break
        self._checkBudget(label)

    def put_surface_stream(self, surface_id, name, vertices_iter, triangles_iter,
                           display_color=None, chunk_bytes=786432, source="stream"):
        """Stage a surface from bounded numeric buffers or iterables of triples.

        Chunks expose native float64 XYZ and uint32 triangle indices. NumPy
        arrays are read through the buffer protocol without JSON conversion.
        """
        if display_color is not None and not (0 <= display_color <= 0xFFFFFFFF):
            raise ValueError("display_color must be a uint32 value")
        if chunk_bytes < 24:
            raise ValueError("chunk_bytes must be at least 24")
        self._begin()
        stream = c_void_p()
        self._library.call("iamEditBeginExternalSurface", self._edit,
                           str(surface_id).encode("utf-8"), str(name).encode("utf-8"),
                           str(source).encode("utf-8"), 0, 0,
                           int(display_color is not None), display_color or 0,
                           ctypes.byref(stream))

        def write_rows(items, code, c_type, function, row_bytes):
            offset = 0
            maximum = min(65536, max(1, chunk_bytes // row_bytes))
            try:
                whole = memoryview(items)
            except TypeError:
                whole = None
            if whole is not None and whole.ndim == 2:
                items = (items,)

            def append(view):
                nonlocal offset
                if view.ndim != 2 or view.shape[1] != 3 or view.itemsize != ctypes.sizeof(c_type):
                    raise ValueError("surface chunks must have shape (N, 3) and the expected numeric type")
                formats = ("I", "L") if code == "I" else (code,)
                if view.format.lstrip("@=<>!") not in formats:
                    raise ValueError("surface chunk has the wrong numeric format")
                if not view.c_contiguous:
                    raise ValueError("surface chunk must be contiguous")
                for start in range(0, view.shape[0], maximum):
                    part = view[start:start + maximum].cast("B")
                    try:
                        buffer = (ctypes.c_char * len(part)).from_buffer(part)
                    except TypeError:
                        buffer = (ctypes.c_char * len(part)).from_buffer_copy(part)
                    pointer = ctypes.cast(buffer, ctypes.POINTER(c_type))
                    rows = len(part) // row_bytes
                    self._library.call(function, stream, offset, rows, pointer)
                    offset += rows

            pending = array(code)
            for item in items:
                try:
                    view = memoryview(item)
                except TypeError:
                    view = None
                if view is not None and view.ndim == 2:
                    if pending:
                        append(memoryview(pending).cast("B").cast(code, shape=(len(pending) // 3, 3)))
                        pending = array(code)
                    append(view)
                    continue
                if len(item) != 3:
                    raise ValueError("each surface row must contain three numbers")
                pending.extend(item)
                if len(pending) // 3 >= maximum:
                    append(memoryview(pending).cast("B").cast(code, shape=(len(pending) // 3, 3)))
                    pending = array(code)
            if pending:
                append(memoryview(pending).cast("B").cast(code, shape=(len(pending) // 3, 3)))
            return offset

        try:
            write_rows(vertices_iter, "d", c_double,
                       "iamExternalSurfaceAppendVertices", 24)
            write_rows(triangles_iter, "I", c_uint32,
                       "iamExternalSurfaceAppendTriangles", 12)
            self._library.call("iamExternalSurfaceFinalize", stream)
        finally:
            self._lib.iamExternalSurfaceAbort(stream)
        self._checkBudget("put surface/%s" % surface_id)

    def _attribute_row_edits(self, column_id, rows):
        """Convert Python row values once for both Mining commit routes."""
        if not rows:
            raise IamError(_abi.INVALID, "at least one attribute row is required")
        field_id = self.attribute_field_id(column_id)
        kind = c_int()
        self._library.check(self._lib.iamFieldType(
            self._project, field_id.encode("utf-8"), ctypes.byref(kind)),
            "reading an attribute field type")
        edits = (_abi.AttributeValueEdit * len(rows))()
        for position, (index, value) in enumerate(rows.items()):
            if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= 1 << 64:
                raise IamError(_abi.INVALID, "row index must be a uint64")
            entry = edits[position]
            entry.index = index
            entry.value.valid = int(value is not None)
            if value is None:
                continue
            if kind.value in (_abi.VALUE_NUMBER, _abi.VALUE_FLOAT32, _abi.VALUE_TIMESTAMP):
                entry.value.number = float(value)
            elif kind.value in (_abi.VALUE_INTEGER, _abi.VALUE_INT32, _abi.VALUE_UINT32):
                if isinstance(value, bool) or not isinstance(value, int) or not -(1 << 63) <= value < (1 << 63):
                    raise IamError(_abi.INVALID, "integer attribute value must fit int64")
                entry.value.integer = value
            elif kind.value == _abi.VALUE_BOOLEAN:
                if not isinstance(value, bool):
                    raise IamError(_abi.INVALID, "boolean attribute value must be bool")
                entry.value.boolean = int(value)
            elif kind.value == _abi.VALUE_TEXT:
                if not isinstance(value, str) or "\0" in value:
                    raise IamError(_abi.INVALID, "text attribute value must be str without NUL")
                entry.text_utf8 = value.encode("utf-8")
            elif kind.value in (_abi.VALUE_VECTOR2, _abi.VALUE_VECTOR3):
                length = 2 if kind.value == _abi.VALUE_VECTOR2 else 3
                if not isinstance(value, (tuple, list)) or len(value) != length:
                    raise IamError(_abi.INVALID, "vector attribute value has the wrong dimension")
                coordinates = tuple(float(component) for component in value)
                if length == 2:
                    entry.value.vector2x, entry.value.vector2y = coordinates
                else:
                    entry.value.vector3x, entry.value.vector3y, entry.value.vector3z = coordinates
            else:
                raise IamError(_abi.UNSUPPORTED, "unsupported attribute field type")
        return edits

    def update_attribute_rows(self, column_id, rows):
        """Stage sparse ``{row_index: value_or_None}`` edits on a column.

        Field type determines the payload representation; None clears validity.
        Indices refer to stored row order. A later commit publishes the edit.
        External columns keep their validity mask, so their rows cannot switch
        between a value and None. Resource edits and row patches commit together.
        """
        edits = self._attribute_row_edits(column_id, rows)
        self._begin()
        self._library.call("iamEditAttributeValues", self._edit,
                           column_id.encode("utf-8"), edits, len(edits))
        self._checkBudget("update_attribute_rows")

    def commit_attribute_rows(self, column_id, rows, expected_revision=None):
        """Commit one column's row changes as one undoable revision.

        This direct database route also handles HDF5-backed numeric and fixed-width text
        columns through Mining's immutable page-version writer. It cannot be
        mixed with a pending put/erase edit. A store-backed validity change is
        refused because the original mask is shared with the new value pages.
        Unchanged null rows do not produce a revision. Variable-length text
        needs conversion to fixed-width text before page-versioning.
        """
        if self._edit:
            raise IamError(_abi.CONFLICT, "commit or discard the pending edit first")
        edits = self._attribute_row_edits(column_id, rows)
        expected = self.revision if expected_revision is None else expected_revision
        handle = c_void_p()
        self._library.call("iamDatabaseCommitAttributeValues", self._database,
                           self._project, column_id.encode("utf-8"), edits, len(edits),
                           ctypes.c_uint64(expected), ctypes.byref(handle))
        self._lib.iamSnapshotRelease(self._project)
        self._project = handle
        return self.revision

    def attach(self, element_id, geometry_ids):
        """Adds geometry to an element that already exists.

        This is what a verb does on every run -- "these new sections belong to
        that tunnel" -- and it is one call rather than a read-modify-write
        because the read half is not reachable from Python: an element's name and
        metadata are not readable through the C surface, so a verb that
        reconstructed the element would silently drop both.

        Idempotent, so a verb that runs twice need not know whether its first
        run's geometry is still attached.
        """
        self._begin()
        if isinstance(geometry_ids, str):
            geometry_ids = [geometry_ids]
        encoded = [value.encode("utf-8") for value in geometry_ids]
        array = (c_char_p * len(encoded))(*encoded) if encoded else None
        self._library.call("iamEditAttachGeometry", self._edit,
                           element_id.encode("utf-8"), array, c_size_t(len(encoded)))
        self._checkBudget("attach")

    def erase(self, resource_type, resource_id):
        """Removes a resource and everything the project cannot keep without it.

        Erasing a geometry is a cascade: a snapshot whose element still names a
        resource that is gone does not validate, so the platform closes over
        every reference rather than leaving a half-applied state to be discovered
        later.
        """
        self._begin()
        self._library.call("iamEditErase", self._edit, c_int(resource_type),
                           resource_id.encode("utf-8"))
        self._checkBudget("erase")

    # -- reviewing and publishing -------------------------------------------

    def diagnostics(self):
        """The edit's diagnostics as a list of ``(status, path, message)``.

        The path is the actionable half -- ``crossSections/abi-section-1`` rather
        than "validation failed" -- so it is returned separately rather than
        folded into the message.
        """
        count = self._lib.iamEditDiagnosticCount(self._edit)
        result = []
        for index in range(count):
            code = c_int()
            path = ctypes.create_string_buffer(512)
            message = ctypes.create_string_buffer(2048)
            self._lib.iamEditDiagnostic(self._edit, c_size_t(index), ctypes.byref(code),
                                            path, 512, message, 2048)
            result.append((code.value, path.value.decode("utf-8", "replace"),
                           message.value.decode("utf-8", "replace")))
        return result

    def dry_run(self):
        """Validates the edit exactly as a commit would, publishing nothing.

        The point is that the database is untouched: a caller can show a verb's
        result to someone before anyone commits to it.
        """
        self._begin()
        self._library.call("iamEditDryRun", self._edit)
        return True

    def summary(self):
        """What the edit changes, as a dict.

        ``replace`` is what it rewrites and ``erase`` what it removes.  A
        reviewable delta needs that distinction, and the affected-resource list
        alone cannot express it.
        """
        required = c_size_t()
        self._library.check(self._lib.iamEditSummary(
            self._edit, None, c_size_t(0), ctypes.byref(required)), "summarising the edit")
        buffer = ctypes.create_string_buffer(required.value)
        self._library.check(self._lib.iamEditSummary(
            self._edit, buffer, c_size_t(required.value), ctypes.byref(required)), "summarising the edit")
        return json.loads(buffer.value.decode("utf-8"))

    def commit(self, expected_revision=None):
        """Publishes the edit as one revision, recorded in the project's history.

        ``expected_revision`` defaults to the revision the edit was begun from,
        which is the answer a verb wants: if the project has moved on since, the
        commit is refused rather than applied to a state the verb never saw.

        THE FILE IS NOT TOUCHED.  This publishes into the open project, the way
        a database transaction publishes into the database; :meth:`save` is what
        writes a revision to disk.  A caller that opens a document, commits and
        then re-opens the same path is reading the bytes it never replaced --
        which is exactly how a write once looked broken while it was working
        (2026-10-19).  The host does both calls for a verb; a program driving
        the port itself has to do the same::

            port.commit()
            port.save(path)
        """
        if not self._edit:
            return self.revision
        handle = c_void_p()
        expected = self.revision if expected_revision is None else expected_revision
        self._library.call("iamDatabaseCommit", self._database, self._edit,
                           ctypes.c_uint64(expected), ctypes.byref(handle))
        self._lib.iamEditDiscard(self._edit)
        self._edit = None
        self._lib.iamSnapshotRelease(self._project)
        self._project = handle
        return self.revision

    def undo(self):
        """Reverses the last committed edit and returns the new revision."""
        handle = c_void_p()
        self._library.call("iamDatabaseUndo", self._database, self.project_id.encode("utf-8"),
                           ctypes.byref(handle))
        self._lib.iamSnapshotRelease(self._project)
        self._project = handle
        return self.revision

    def redo(self):
        handle = c_void_p()
        self._library.call("iamDatabaseRedo", self._database, self.project_id.encode("utf-8"),
                           ctypes.byref(handle))
        self._lib.iamSnapshotRelease(self._project)
        self._project = handle
        return self.revision

    # -- the delta document -------------------------------------------------

    def delta(self):
        """The edit in flight, as a document.

        A document is what makes an edit reviewable before it is applied and
        replayable after: it can be written to a file, shown to someone, and
        committed later -- by this process or another one.  It is the same edit
        either way, so committing it goes through the same history every other
        edit does.

        Requires an edit in flight, which requires at least one put/attach/erase.
        """
        self._begin()
        handle = c_void_p()
        self._library.call("iamEditToDelta", self._edit, ctypes.byref(handle))
        return Delta(self._library, handle)

    def load_delta(self, source):
        """Opens a document without applying it.

        ``source`` is a path, or the document's bytes.  Opening reads the
        document's own header, so a caller can find out which project and which
        revision it was written for BEFORE deciding to apply it.
        """
        return Delta.open(self._library, source)

    def apply_delta(self, delta):
        """Loads a document onto this project's current revision, as an edit.

        The document must have been written against the revision the project is
        at; otherwise the load is refused with both revisions named.  What comes
        back is an ordinary edit in flight: dry-run it, look at its diagnostics,
        commit it -- or discard it by closing the port.
        """
        if self._edit:
            raise IamError(_abi.INVALID, "an edit is already in flight; commit or discard it first")
        owned = None if isinstance(delta, Delta) else self.load_delta(delta)
        try:
            source = delta.handle if owned is None else owned.handle
            handle = c_void_p()
            self._library.call("iamEditBeginFromDelta", self._project, source, ctypes.byref(handle))
            self._edit = handle
        finally:
            if owned is not None:
                owned.close()
        return self

    def commit_delta(self, delta):
        """Commit one reviewed offline delta against its exact host revision.

        A single external-column row patch uses Mining's existing page-version
        commit. Mixed resource and external-row changes use one native edit and
        publish one revision. Failures do not publish a partial edit.
        """
        if self._edit:
            raise IamError(_abi.CONFLICT, "commit or discard the pending edit first")
        owned = None if isinstance(delta, Delta) else self.load_delta(delta)
        document = delta if owned is None else owned
        try:
            info = document.info
            if document.project_id != self.project_id:
                raise IamError(_abi.INVALID, "delta addresses another project")
            if info.base_revision != self.revision:
                raise IamError(_abi.CONFLICT, "delta base revision differs from the host")
            payload = json.loads(document.json())
            patches = payload.get("attribute_patches", [])
            metadata = {"project_id", "base_revision", "delta_version",
                        "contract_schema_version", "attribute_patches"}
            pure_patch = (len(patches) == 1 and
                          not any(value for key, value in payload.items() if key not in metadata))
            if pure_patch:
                column_id = patches[0]["column_id"]
                column = self.resource(_abi.RESOURCE_ATTRIBUTE_COLUMN, column_id)
                if column.get("chunked_values"):
                    field_id = self.attribute_field_id(column_id)
                    kind = c_int()
                    self._library.check(self._lib.iamFieldType(
                        self._project, field_id.encode("utf-8"), ctypes.byref(kind)),
                        "reading an attribute field type")
                    slot = {
                        _abi.VALUE_NUMBER: "number", _abi.VALUE_FLOAT32: "number",
                        _abi.VALUE_TIMESTAMP: "number", _abi.VALUE_INTEGER: "integer",
                        _abi.VALUE_INT32: "integer", _abi.VALUE_UINT32: "integer",
                        _abi.VALUE_BOOLEAN: "boolean", _abi.VALUE_TEXT: "text",
                    }.get(kind.value)
                    if slot is None:
                        raise IamError(_abi.UNSUPPORTED,
                                       "this external column type cannot be patched")
                    rows = {}
                    for row in patches[0].get("rows", []):
                        index = row.get("index", 0)
                        if index in rows:
                            raise IamError(_abi.INVALID, "duplicate attribute row in delta")
                        value = row.get("value") or {}
                        rows[index] = value.get(slot) if value.get("valid", False) else None
                    return self.commit_attribute_rows(column_id, rows,
                                                      expected_revision=info.base_revision)
            try:
                self.apply_delta(document)
                self.dry_run()
                return self.commit(expected_revision=info.base_revision)
            except Exception:
                if self._edit:
                    self._lib.iamEditDiscard(self._edit)
                    self._edit = None
                raise
        finally:
            if owned is not None:
                owned.close()


class Delta:
    """A delta document: what one edit changes, as bytes.

    Read-only once opened.  ``info`` says which revision it edits and which
    contract it was written in; ``json()`` is its readable form, which is also
    an accepted input -- see :func:`Delta.from_json`.
    """

    def __init__(self, library, handle):
        self._library = library
        self._lib = library.lib
        self.handle = handle

    @classmethod
    def open(cls, library, source):
        """Opens a document from a path, or from bytes or JSON text."""
        handle = c_void_p()
        if isinstance(source, (bytes, bytearray)):
            data = bytes(source)
            # A document in its text form starts with '{'; its binary form is a
            # FlatBuffers buffer whose identifier is at offset 4.  Sniffing is
            # safe because the delta identifier is deliberately not the mine's.
            if data.lstrip()[:1] == b"{":
                library.call("iamDeltaOpenJson", data, ctypes.byref(handle))
            else:
                buffer = ctypes.create_string_buffer(data, len(data))
                library.call("iamDeltaOpen", ctypes.cast(buffer, c_void_p), c_size_t(len(data)),
                             ctypes.byref(handle))
        elif isinstance(source, str) and source.lstrip().startswith("{"):
            library.call("iamDeltaOpenJson", source.encode("utf-8"), ctypes.byref(handle))
        else:
            with open(source, "rb") as stream:
                return cls.open(library, stream.read())
        return cls(library, handle)

    @classmethod
    def from_json(cls, library, text):
        """Opens a hand-written document.  The only way to express a removal."""
        handle = c_void_p()
        library.call("iamDeltaOpenJson", text.encode("utf-8"), ctypes.byref(handle))
        return cls(library, handle)

    @property
    def info(self):
        result = _abi.DeltaInfo()
        self._library.check(self._lib.iamDeltaInfo(self.handle, ctypes.byref(result)),
                            "reading the document's header")
        return result

    @property
    def project_id(self):
        return self._library.readString("iamDeltaProjectId", (self.handle,))

    def json(self):
        """The document as strict JSON, for a reviewer or another program."""
        required = c_size_t()
        self._library.check(self._lib.iamDeltaJson(
            self.handle, None, c_size_t(0), ctypes.byref(required)), "reading the document")
        buffer = ctypes.create_string_buffer(required.value)
        self._library.check(self._lib.iamDeltaJson(
            self.handle, buffer, c_size_t(required.value), ctypes.byref(required)), "reading the document")
        return buffer.value.decode("utf-8")

    def save(self, path):
        """Writes the document to a file."""
        self._library.call("iamDeltaSaveFile", self.handle, str(path).encode("utf-8"))

    def close(self):
        if self.handle:
            self._lib.iamDeltaRelease(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
