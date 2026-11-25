"""A verb that applies a DECLARATIVE edit -- one JSON description, no user code.

The write door has two entrances and this is the one that does not run a program
somebody wrote.  A caller who wants to rename an element, attach a surface to a
tunnel or drop three roadways has no computation to express, and making them
write `def run(port)` for it would put generated code in the path of an ordinary
edit for no gain.

It is run by the platform's own headless host, not by this plugin:

    python3 -m iam.host --plugin apply_edit.py \\
        --in mine.iam --emit-delta review.iaxd --arg edit='{"erase": [...]}'

so the deadline, the retained-bytes budget, the version negotiation and the
`--emit-delta` review gate are the host's and are not re-implemented here.  What
this file adds is the translation from a JSON edit description to the port's own
write primitives, and nothing else.

WHY THE DESCRIPTION ARRIVES AS A FILE.  It used to travel as one
`--arg edit=<json>`, and a real surface edit (thousands of vertices) exceeds the
OS command-line limit -- 32767 characters on Windows -- before the host ever
starts.  `iam_mine_edit` now writes the description to a temporary file and
passes `edit_file=<path>`; `--arg edit=` is still accepted for small, direct
invocations such as the one above.  An unparseable description is still refusable
by name rather than silently empty: "the edit did not happen" and "the edit
changed nothing" must not look alike.
"""

from __future__ import annotations

import json
from pathlib import Path

# The erasure vocabulary, spelled the way the C surface spells it and mapped to
# the tag the platform takes.  A name rather than a number, because the number a
# caller would have to write is an ABI detail and the gap in that enum (there is
# no 3, 10, 11, 12, 13) is exactly the kind of thing a caller should never have
# to know.
ERASE_TYPES = {
    "frame": "RESOURCE_FRAME",
    "field": "RESOURCE_FIELD",
    "element": "RESOURCE_ELEMENT",
    "point_set": "RESOURCE_POINT_SET",
    "line_set": "RESOURCE_LINE_SET",
    "polyline_3d": "RESOURCE_POLYLINE_3D",
    "grid_surface": "RESOURCE_GRID_SURFACE",
    "block_model": "RESOURCE_BLOCK_MODEL",
    "surface": "RESOURCE_SURFACE",
    "attribute_column": "RESOURCE_ATTRIBUTE_COLUMN",
    "cross_section": "RESOURCE_CROSS_SECTION",
    "line_network": "RESOURCE_LINE_NETWORK",
    "composite": "RESOURCE_COMPOSITE",
}


def _refuse(message):
    """Refuses through the host's own error type.

    `IamError` is what `iam.host` catches: it prints "failed: <message>"
    and the port's diagnostics, and exits 1.  Any other exception would leave the
    host as a traceback, and a caller reads a traceback as a defect in this file
    rather than as an answer about their edit.
    """
    from iam import IamError, _abi
    raise IamError(_abi.INVALID, message)


def _list(edit, name):
    """One member of the edit, as a list, refusing the wrong shape by name."""
    value = edit.get(name)
    if value is None:
        return []
    if isinstance(value, dict):
        # A single resource is the natural thing to write by hand, and accepting
        # it here is cheaper than making every caller wrap it in a one-item list.
        return [value]
    if not isinstance(value, list):
        _refuse('"%s" must be an object or an array of objects' % name)
    return value


def apply(port, edit):
    """Applies one edit description and returns how many of each it did.

    The order is put, attach, erase, and it is load-bearing rather than
    arbitrary.  `put` first so everything a later step refers to exists; `attach`
    second, because the reason it exists as a primitive at all is "create the
    geometry, then attach it"; `erase` last, because an erasure cascades -- it
    rewrites every element that named the resource -- so running it before a
    `put` would let a later payload re-declare something the same edit removed.

    The three accumulate into ONE delta: the reachability invariant is checked on
    the committed result, not on each call, which is what makes "create the
    geometry, then attach it" work at all.
    """
    from iam import _abi

    if not isinstance(edit, dict):
        _refuse("the edit must be a JSON object")

    puts = _list(edit, "put")
    attaches = _list(edit, "attach")
    erases = _list(edit, "erase")
    if not (puts or attaches or erases):
        # An edit that says nothing is not a no-op to be shrugged at: it would
        # produce a document carrying nothing, and downstream that reads as "the
        # change was applied and changed nothing".
        _refuse('the edit is empty: name at least one of "put", "attach", "erase"')

    for payload in puts:
        port.put(payload)

    for item in attaches:
        element = item.get("element") if isinstance(item, dict) else None
        if not element:
            _refuse('every "attach" needs an "element" id')
        geometry = item.get("geometry", item.get("geometry_ids"))
        if not geometry:
            _refuse('"attach" for element %s names no geometry' % element)
        port.attach(element, geometry)

    for item in erases:
        kind = item.get("type") if isinstance(item, dict) else None
        if kind not in ERASE_TYPES:
            _refuse("unknown erase type %r; one of: %s" % (kind, ", ".join(sorted(ERASE_TYPES))))
        identifier = item.get("id") if isinstance(item, dict) else None
        if not identifier:
            _refuse('every "erase" needs an "id"')
        if kind == "frame":
            # A project has exactly one frame and validation requires it, so this
            # is said here rather than recorded as a removal that can never take
            # effect.  The platform refuses it too; refusing first is what keeps
            # the message about the caller's own description.
            _refuse("a project's coordinate frame cannot be erased")
        port.erase(getattr(_abi, ERASE_TYPES[kind]), identifier)

    return {"put": len(puts), "attach": len(attaches), "erase": len(erases)}


def run(port):
    """The host's entry point: parse one JSON edit, apply it, publish nothing."""
    edit_file = port.arg("edit_file")
    if edit_file is not None:
        try:
            description = Path(edit_file).read_text(encoding="utf-8")
        except OSError as error:
            _refuse("the edit file could not be read: %s" % error)
    else:
        description = port.arg("edit", required=True)
    try:
        edit = json.loads(description)
    except ValueError as error:
        _refuse("the edit is not valid JSON: %s" % error)
    apply(port, edit)
