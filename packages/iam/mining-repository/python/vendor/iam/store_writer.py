"""Bounded, direct writer for a new host-side .iamh project.

The caller supplies the Mining schema manifest. This layer only streams its
chunked arrays; it does not interpret a vendor's records or choose field names.
"""

import ctypes
import json
from pathlib import Path

from . import _abi


_TYPES = {
    "float64": (_abi.STORE_FLOAT64, "d", 8),
    "float32": (_abi.STORE_FLOAT32, "f", 4),
    "uint32": (_abi.STORE_UINT32, "I", 4),
    "int32": (_abi.STORE_INT32, "i", 4),
    "int64": (_abi.STORE_INT64, "q", 8),
    "uint8": (_abi.STORE_UINT8, "B", 1),
    "text": (_abi.STORE_TEXT, None, None),
}


class StreamWriter:
    """Owns one unfinished .iamh file; close aborts unless commit succeeds."""

    def __init__(self, library, path):
        self._library = library
        self.path = Path(path).resolve()
        self._handle = ctypes.c_void_p()
        self._arrays = {}
        library.call("iamStoreWriterCreate", str(self.path).encode("utf-8"),
                     ctypes.byref(self._handle))

    def begin_array(self, dataset, data_type, columns=1, estimated_rows=0,
                    repeating=False, max_text_bytes=0):
        """Declare a row-major physical array. Text has exactly one column."""
        self._require_open()
        if data_type not in _TYPES:
            raise ValueError("data_type must be one of %s" % ", ".join(_TYPES))
        if dataset in self._arrays:
            raise ValueError("dataset already begun: %s" % dataset)
        code, _, _ = _TYPES[data_type]
        self._library.call("iamStoreWriterBeginArray", self._handle,
                           dataset.encode("utf-8"), code, columns, estimated_rows,
                           int(repeating), max_text_bytes)
        self._arrays[dataset] = (data_type, columns)

    def append(self, dataset, values):
        """Append one contiguous numeric page of 1..4096 rows.

        ``values`` may be an ``array.array`` or a contiguous NumPy array of
        the declared native scalar type. For vector arrays, flatten in row order.
        The page is copied once into an owned ctypes buffer for the C call.
        """
        self._require_open()
        data_type, columns = self._arrays[dataset]
        _, format_code, element_bytes = _TYPES[data_type]
        if format_code is None:
            raise TypeError("Use append_text for text arrays")
        view = memoryview(values)
        aliases = {"int32": "il", "uint32": "IL", "int64": "ql"}
        native = view.format.lstrip("@=")
        if (not view.c_contiguous or view.itemsize != element_bytes or
                native not in aliases.get(data_type, format_code) or
                view.format.startswith(("<", ">", "!"))):
            raise TypeError("Expected contiguous native %s values" % data_type)
        raw = view.cast("B").tobytes()
        width = columns * element_bytes
        if len(raw) % width:
            raise ValueError("The scalar count is not divisible by columns")
        rows = len(raw) // width
        if not 1 <= rows <= 4096:
            raise ValueError("A page must have 1..4096 rows")
        buffer = ctypes.create_string_buffer(raw)
        self._library.call("iamStoreWriterAppend", self._handle,
                           dataset.encode("utf-8"), ctypes.cast(buffer, ctypes.c_void_p),
                           len(raw), rows)

    def append_text(self, dataset, values):
        """Append one page of 1..4096 non-null UTF-8 strings."""
        self._require_open()
        if self._arrays[dataset][0] != "text":
            raise TypeError("The array is numeric; use append")
        encoded = []
        for value in values:
            if not isinstance(value, str):
                raise TypeError("Text page values must be str")
            if "\0" in value:
                raise ValueError("Text page values cannot contain NUL")
            encoded.append(value.encode("utf-8"))
        if not 1 <= len(encoded) <= 4096:
            raise ValueError("A page must have 1..4096 rows")
        pointers = (ctypes.c_char_p * len(encoded))(*encoded)
        self._library.call("iamStoreWriterAppendText", self._handle,
                           dataset.encode("utf-8"), pointers, len(encoded))

    def commit(self, manifest):
        """Validate and publish a complete Mining project manifest."""
        self._require_open()
        payload = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._library.call("iamStoreWriterCommit", self._handle, payload)
        self.close()
        return self.path

    def close(self):
        if self._handle:
            self._library.lib.iamStoreWriterRelease(self._handle)
            self._handle = ctypes.c_void_p()

    def _require_open(self):
        if not self._handle:
            raise RuntimeError("The stream writer is closed")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __del__(self):
        if getattr(self, "_handle", None):
            self.close()
