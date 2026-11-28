#!/usr/bin/env python3
"""What the AlgorithmBridge tools actually do.

The TypeScript half of this plugin spawns this program and parses one JSON
object from its stdout.  Everything that needs a library -- the algorithm
catalog, the Mining port, a generated program -- happens here, on the Python
side of a process boundary, for the reason Import's importer is a child process
too: a generated program is code nobody in this repository wrote, and a crash
in it must cost the caller a failed tool call rather than the agent's session.

    bridge.py <verb> [--option value ...]

Every verb prints exactly one JSON object and exits 0 when it produced one.
A verb that could not run at all (no library, no such verb) exits 2 with the
reason on stderr, which the TypeScript half turns into a thrown tool error --
"could not be attempted" and "ran and failed" are different answers and the
tools' exit codes are what keeps them apart.
"""

from __future__ import annotations

import argparse
import ctypes
import difflib
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

if os.name == "nt":
    from ctypes import wintypes

    class _JobBasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _JobIoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _JobExtendedLimit(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JobBasicLimit),
            ("IoInfo", _JobIoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class _WindowsJob:
        """Own a spawned program and all of its descendants until bridge exit."""

        def __init__(self, process):
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                       ctypes.c_void_p, wintypes.DWORD]
            kernel.SetInformationJobObject.restype = wintypes.BOOL
            kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            kernel.TerminateJobObject.restype = wintypes.BOOL
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.restype = wintypes.BOOL
            self.kernel = kernel
            self.handle = kernel.CreateJobObjectW(None, None)
            if not self.handle:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                limits = _JobExtendedLimit()
                limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
                if not kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits),
                                                      ctypes.sizeof(limits)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if not kernel.AssignProcessToJobObject(self.handle, process._handle):
                    raise ctypes.WinError(ctypes.get_last_error())
            except BaseException:
                self.close()
                raise

        def terminate(self):
            if self.handle and not self.kernel.TerminateJobObject(self.handle, 1):
                raise ctypes.WinError(ctypes.get_last_error())

        def close(self):
            if self.handle:
                self.kernel.CloseHandle(self.handle)
                self.handle = None

# Prefer the deployment's IAX root; a checkout uses its generated native package.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("IAX_PLATFORM_ROOT") or Path(__file__).resolve().parents[4]).resolve()
os.environ.setdefault("IAX_PLATFORM_ROOT", str(ROOT))
_configured_package = os.environ.get("IAM_PYTHON_PACKAGE_DIR")
_platform = {"win32": "win-native", "linux": "linux-native", "darwin": "macos-native"}.get(sys.platform)
ALGORITHMS_PYTHON = (Path(_configured_package).resolve() if _configured_package else
                     ROOT / "build" / "CMakePlatforms" / (_platform or "unsupported") / "IAM/Host/Python")
if _configured_package and not (ALGORITHMS_PYTHON / "iam_algorithms/__init__.py").is_file():
    raise RuntimeError("IAM_PYTHON_PACKAGE_DIR must name a generated IAM package; build IamAlgorithmsPython or stage_iam_python")
MINING_PYTHON = ROOT / "Mining" / "Host" / "python"
VENDOR_PYTHON = PACKAGE_ROOT / "python" / "vendor"
# This ordered list is the import contract for both the bridge and the programs
# it starts. Generated build output wins in a checkout; deployments use vendor.
PYTHON_PACKAGE_PATHS = tuple(directory for directory in
                             (ALGORITHMS_PYTHON, MINING_PYTHON, VENDOR_PYTHON)
                             if directory.is_dir())
# SAME RULE AS THE PYTHON PACKAGES BELOW: the checkout wins when it is there,
# and the packaged copy answers when it is not.  The first version preferred the
# copy whenever one existed, which meant an edit to a workflow's manifest was
# invisible to `iam_workflow_list` until the next build -- measured, by editing
# a workflow in the checkout and watching the catalog go on describing the old
# one.  A deployed package has no checkout, so this degrades to the copy.
# The checkout root also holds the example fixture under `Examples/`; one level
# deeper is outside `workflow_catalog`'s `*/manifest.json`, so a fresh install
# lists no platform capability.
_CHECKOUT_WORKFLOWS = ROOT / "IAM" / "plugin" / "Workflows"
_PACKAGED_WORKFLOWS = PACKAGE_ROOT / "workflows"
WORKFLOWS = _CHECKOUT_WORKFLOWS if _CHECKOUT_WORKFLOWS.is_dir() else _PACKAGED_WORKFLOWS

# Move these paths to the front even if PYTHONPATH already supplied them in a
# different order. The child receives the same order in child_environment().
for directory in reversed(PYTHON_PACKAGE_PATHS):
    path = str(directory)
    if path in sys.path:
        sys.path.remove(path)
    sys.path.insert(0, path)

for variable, names in (
        ("IAM_C_LIBRARY", ("IamC.dll", "libIamC.so")),
        # The .iamp output binding.  It is a separate library from IamC for the
        # reason its header states: writing a drawing needs the Drawing/Plot
        # closure, which the data binding deliberately does not carry.
        ("IAM_PLOT_C_LIBRARY", ("IamPlotC.dll", "libIamPlotC.so", "libIamPlotC.dylib"))):
    if variable in os.environ:
        continue
    for platform in ("win-native", "win", "linux-native", "linux", "macos-native", "macos"):
        for leaf in ("exe", "bin"):
            for name in names:
                candidate = ROOT / "build" / leaf / platform / name
                if candidate.is_file():
                    os.environ[variable] = str(candidate)
                    break
            if variable in os.environ:
                break
        if variable in os.environ:
            break

# How much of a generated program's output is kept, per stream.  Bounded for the
# reason Import bounds a vendor reader's: the producer is not this process's to
# trust with the heap, and a runaway print loop would otherwise become the tool
# result.
OUTPUT_LIMIT_BYTES = 256 * 1024
MAX_CAPTURE_BYTES = 1024 * 1024

# WHAT A RUN LEFT BEHIND.  Before these constants, `run.json` recorded fifteen
# fields and not one of them said which files the run produced: a `.iax/runs/`
# directory full of records and a workspace full of results recognised each
# other only by their timestamps, which is to say not at all.  A content hash
# is what makes "this result came from that run" answerable.
#
# The hash is bounded because a run may legitimately write a 200 MB model, and
# hashing it a second time to record that it happened would turn a fast run into
# a slow one.  Over 64 MiB the entry keeps its size and mtime, says in `note`
# why it has no hash, and the record remains honest about what it does not know.
ARTIFACT_HASH_LIMIT = 64 * 1024 * 1024
# A run that writes 200 files has said something; a run that writes 20,000 has
# written a cache, and the record is not the place to be exhaustive.  Truncation
# is counted rather than silent -- see `artifacts_truncated`.
ARTIFACT_LIMIT = 200
# Directories that are a mechanism rather than a product.  `.iax/runs` would
# make the record list its own directory; `.iax/workflows` is the user's code,
# not the run's output; `.git`, `node_modules`, `build` and `__pycache__` are
# either huge or machine-generated.  The rule is by directory NAME anywhere in
# the tree, except the two `.iax` paths, which are anchored to the workspace.
ARTIFACT_SKIP_ROOTS = (".iax/runs", ".iax/workflows")
ARTIFACT_SKIP_DIRECTORIES = (".git", "node_modules", "build", "__pycache__")


def pin_utf8():
    """Write UTF-8 and nothing else, whatever the caller's console says.

    A wire protocol whose encoding is the caller's locale is not a wire
    protocol.  Measured 2026-10-12, and this is the whole reason the function
    exists: on a machine whose console code page is 936, the harness ran

        python bridge.py mine-describe --project ... 1> _mine.json

    and the file came out in GBK, so the next program to read it as JSON got
    `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xb5 in position 301`.
    The same command on a UTF-8 console wrote UTF-8.  Nothing about the request
    differed; only the caller's locale did, and a caller cannot be expected to
    know that its locale is part of this program's contract.

    `reconfigure` rather than a new writer so that the file object's buffering,
    its line discipline and any redirection already in place are kept.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="strict")
        except (AttributeError, ValueError, OSError):
            # A stream that cannot be reconfigured (already detached, or not a
            # TextIOWrapper) is left alone: writing through it is still better
            # than refusing to answer.
            pass


def emit(document):
    json.dump(document, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


def fail(message):
    sys.stderr.write("algorithm-bridge: %s\n" % message)
    return 2


# --------------------------------------------------------------------------
# The retrieval surface.
# --------------------------------------------------------------------------

def library():
    """The IAM algorithm library, or a refusal that names what is missing."""
    try:
        import iam_algorithms
    except ImportError as error:
        raise RuntimeError("iam_algorithms is not importable from %s: %s"
                           % (", ".join(map(str, PYTHON_PACKAGE_PATHS)), error)) from error
    return iam_algorithms.Library()


def algorithm_environment():
    """The catalog version and the provider libraries this process loaded.

    Read from the library rather than from the environment, because the
    environment says what was asked for and the library says what was there: a
    path that did not load is the difference between a result that is
    reproducible elsewhere and one that is not.
    """
    try:
        catalog = library()
    except Exception:                     # noqa: BLE001 - a record is not worth failing a run
        return {}
    names = list(catalog.provider_names())
    selected = os.environ.get("IAM_ALGORITHM_USER_IMPLEMENTATIONS", "{}")
    return {"catalog_version": getattr(catalog, "catalog_version", None),
            "providers": names, "user_implementations": json.loads(selected)}


def workspace_algorithms(workspace):
    """A user algorithm is a manifest and algorithm.py under the chosen workspace."""
    if not workspace:
        return []
    root = Path(workspace).resolve()
    directory = (root / ".iax" / "algorithms").resolve()
    if not directory.is_relative_to(root):
        raise RuntimeError("the algorithm directory escapes the workspace")
    found = []
    for path in sorted(directory.glob("*/manifest.json")):
        folder = path.parent.resolve()
        code = folder / "algorithm.py"
        if (not folder.is_relative_to(directory) or not path.resolve().is_relative_to(folder)
                or not code.is_file() or not code.resolve().is_relative_to(folder)):
            continue
        manifest = json.loads(path.read_text(encoding="utf-8"))
        identifier = manifest.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[\w][\w.-]{0,119}", identifier):
            raise RuntimeError("invalid user algorithm id in %s" % path)
        if not isinstance(manifest.get("operation"), str) or not manifest["operation"]:
            raise RuntimeError("user algorithm %s needs an operation" % identifier)
        if not isinstance(manifest.get("title"), str) or not manifest["title"]:
            raise RuntimeError("user algorithm %s needs a title" % identifier)
        if not isinstance(manifest.get("inputs"), list) or any(
                not isinstance(item, dict) or not isinstance(item.get("name"), str)
                for item in manifest["inputs"]):
            raise RuntimeError("user algorithm %s needs named inputs" % identifier)
        if not isinstance(manifest.get("result_schema"), dict):
            raise RuntimeError("user algorithm %s needs a JSON result_schema" % identifier)
        found.append({**manifest, "id": identifier, "backend": "workspace",
                      "provenance": "workspace", "directory": str(folder), "entry": "algorithm.py",
                      "source_sha256": hashlib.sha256(code.read_bytes()).hexdigest()})
    ids = [entry["id"] for entry in found]
    if len(ids) != len(set(ids)):
        raise RuntimeError("duplicate user algorithm ids in the workspace")
    return found


# How long a search result's one-line brief may be, in characters.
#
# 160 is measured rather than chosen: across the 132 built-in entries the first
# sentence runs to 86 characters at the median and 208 at the longest, so this
# bounds the worst case without cutting the ordinary one.
BRIEF_LIMIT = 160


def summary_brief(summary):
    """One line of a catalog summary, for a search result.

    WHY A SEARCH RESULT CARRIES PROSE WHEN THE REST OF IT IS DELIBERATELY BARE.
    An entry identified by `geometry.boolean.difference` and the title "Mesh
    boolean difference" says what the algorithm is called and not what it does,
    so the answer to "is there anything here for this problem" comes back thin.
    A thin answer is one a model goes elsewhere to check -- and somewhere else is
    the repository's C++, which is the wrong place twice over: it describes the
    availability of some build rather than of this session, and it is not
    something a session can call. With the brief, a search that returns nothing
    for a problem IS the catalog's answer that it has nothing, which is the
    conclusion the model was after.

    The FIRST SENTENCE, not a fixed number of characters: the declarations are
    written to answer in their opening sentence, and a character cut lands
    mid-clause on exactly the entries that took the trouble to explain
    themselves. `BRIEF_LIMIT` is the backstop for the few that do not stop.
    """
    if not isinstance(summary, str):
        return None
    text = summary.strip()
    if not text:
        return None
    # A sentence ends at `.`, `!` or `?` followed by whitespace and something
    # that opens a new one. Decimals ("1.5 m") and lower-case abbreviations
    # ("e.g. this") do not match, which is what keeps them inside their sentence.
    # The match is the whitespace run, so it STARTS just past the sentence's own
    # full stop -- which is where the slice ends. Taking one more character would
    # keep the separating space and make every brief end in whitespace.
    end = re.search(r"(?<=[.!?])\s+(?=[A-Z(])", text)
    if end:
        text = text[:end.start()]
    if len(text) > BRIEF_LIMIT:
        cut = text.rfind(" ", 0, BRIEF_LIMIT)
        text = text[:cut if cut > 0 else BRIEF_LIMIT].rstrip() + "…"
    return text


def _entry_matches(entry, query):
    """Whether an entry carries every word of `query`.

    The same rule `Library.discover` applies to built-ins, repeated here for
    workspace entries so one search does not answer two different questions.
    """
    tokens = (query or "").casefold().split()
    text = json.dumps(entry, ensure_ascii=False).casefold()
    return all(token in text for token in tokens)


# The `operation` value that asks for the whole catalog instead of one family.
WHOLE_CATALOG = "*"


def _operation_index(native, user_entries, options):
    """The catalog as a table of contents: one row per operation family.

    WHY THIS IS THE EMPTY-QUERY ANSWER.  Listing every entry costs about 100 KB
    -- roughly twenty-five thousand tokens -- to answer a question a caller
    usually has not asked yet: "what is in here".  The index is about fourteen
    kilobytes, names every family once with its entry count and backends, and
    turns the next call into `operation: "<family>"`.  The whole list stays
    reachable with
    `operation: "*"`, because a caller that really does want it should not have
    to make a hundred calls to assemble it.
    """
    entries = [entry for entry in native.algorithms
               if not options.backend or entry["backend"] == options.backend]
    for entry in user_entries:
        if options.backend and options.backend != "workspace":
            continue
        entries.append(entry)
    families = {}
    for entry in entries:
        operation = entry.get("operation", "")
        row = families.get(operation)
        if row is None:
            row = families[operation] = {"operation": operation,
                                         "entry_count": 0, "backends": []}
        row["entry_count"] += 1
        if entry["backend"] not in row["backends"]:
            row["backends"].append(entry["backend"])
    rows = [families[operation] for operation in sorted(families)]
    return {"query": options.query, "backend": options.backend,
            "operations": rows, "operation_count": len(rows),
            "entry_count": len(entries),
            "hint": "Pass operation=<family> to list one family's entries; "
                    "operation=\"*\" returns every entry."}


def verb_search(options):
    """Short entries grouped by operation family.

    Grouped and short, because the model's first question is "what can this
    platform do about booleans", not "show me the third variant's preconditions".
    A full contract is one `describe` away, and paying for sixteen of them to
    answer a question about one family is how a tool result becomes a context
    problem.

    An empty query with no operation is the table of contents rather than the
    catalog: one row per family, which is the cheap way to ask what exists.
    """
    native = library()
    user_entries = workspace_algorithms(options.workspace)
    duplicates = native._by_id.keys() & {entry["id"] for entry in user_entries}
    if duplicates:
        raise RuntimeError("user algorithm ids collide with built-ins: %s" % ", ".join(sorted(duplicates)))
    query = options.query or ""
    operation = (options.operation or "").strip()
    if not query and not operation:
        return _operation_index(native, user_entries, options)
    entries = native.discover(query or None, options.backend)
    if operation and operation != WHOLE_CATALOG:
        entries = [entry for entry in entries
                   if entry.get("operation", "").casefold() == operation.casefold()]
    for entry in user_entries:
        if options.backend and options.backend != "workspace":
            continue
        if (operation and operation != WHOLE_CATALOG
                and entry.get("operation", "").casefold() != operation.casefold()):
            continue
        if query and not _entry_matches(entry, query):
            continue
        entries.append(entry)
    families = {}
    for entry in entries:
        families.setdefault(entry["operation"], []).append({
            "id": entry["id"], "backend": entry["backend"],
            "variant": entry.get("variant"), "title": entry.get("title"),
            "brief": summary_brief(entry.get("summary")),
            # The one-line Chinese phrase every declaration carries.  It is
            # what a Chinese query matched, so returning it turns a hit into
            # something the caller can confirm without opening the contract.
            "route": entry.get("route"),
            # The selection claim is one word per field, and it belongs where
            # the choice is made rather than one describe call per candidate.
            # "unknown" is a stated fact: nobody has established it.
            "select": entry.get("select"),
            "python_return": entry.get("python_return"),
            "call_kind": ("workspace" if entry.get("provenance") == "workspace"
                          else entry["call_kind"]),
            # Some invoke entries retain a direct compatibility alias. Search
            # advertises the primary call_kind route only; exposing the alias
            # here gives generated callers two conflicting entry points.
            "python_direct": (entry.get("python_direct")
                              if entry.get("call_kind") == "direct" else None),
            "execution": ("iam_algorithm_run" if entry.get("provenance") == "workspace"
                          else None),
            "provenance": entry.get("provenance", "builtin"),
        })
    # A QUERY'S ORDER IS ITS ANSWER.  `discover` ranks entries by where the
    # words hit, so with a query the families are emitted in that order and the
    # best family is first.  An empty query is browsing rather than searching,
    # and keeps the stable alphabetical order a caller can navigate.
    ordered = list(families.items()) if options.query else sorted(families.items())
    result = {"query": options.query, "backend": options.backend,
              "operation": operation or None,
              "families": [{"operation": family, "entries": variants}
                           for family, variants in ordered],
              "entry_count": len(entries)}
    if operation and operation != WHOLE_CATALOG and not entries and not query:
        result["hint"] = ("No operation family by that name; omit operation to get "
                          "the family index.")
    return result


def verb_describe(options):
    """One entry's full contract: what it takes, what it refuses, what it costs."""
    catalog = library()
    users = workspace_algorithms(options.workspace)
    duplicates = catalog._by_id.keys() & {candidate["id"] for candidate in users}
    if duplicates:
        raise RuntimeError("user algorithm ids collide with built-ins: %s" % ", ".join(sorted(duplicates)))
    entry = catalog._by_id.get(options.id)
    if entry is None:
        matches = [candidate for candidate in users if candidate["id"] == options.id]
        if matches:
            return {"entry": matches[0], "result_schema": matches[0]["result_schema"],
                    "execution": "iam_algorithm_run", "provenance": "workspace"}
        close = [candidate["id"] for candidate in catalog.discover(options.id)][:8]
        raise RuntimeError("no algorithm with id %r; the catalog has %d entries%s"
                           % (options.id, catalog.algorithm_count,
                              ("; nearest: " + ", ".join(close)) if close else ""))
    # The result schema travels with the entry and is what a caller has to
    # program against, so it is returned inline rather than named: a name would
    # be a second lookup for something already in hand.
    return {"entry": entry, "result_schema": catalog.result_schema(options.id),
            "catalog_version": catalog.catalog_version,
            "algorithm_version": catalog.algorithm_version,
            "abi_version": catalog.abi_version}


def _stated(value):
    """A declaration's prose, or None when it wrote none."""
    return value if isinstance(value, str) and value.strip() else None


def input_questions(declarations, missing):
    """The missing required inputs, as questions a caller can put to a user.

    EVERYTHING BUT `parameter` IS COPIED.  A question is the declaration's own
    words shown to a user, and a sentence composed here would be the platform
    answering for the workflow -- the same reason `suggested` is never
    estimated.  A key the declaration does not carry is omitted rather than
    filled with an empty value; `suggested` and `choices` are the two that are
    always present, because `null` and `[]` are themselves answers -- "nothing
    is recommended" and "there is nothing to choose between" -- and a caller
    rendering a field has to be able to tell those from a field this platform
    forgot.

    `reason` is WHY this is a question: the declaration's own `reason` when it
    wrote one, else the `why_not_inferred` that kept the platform from guessing.

    ORDER IS THE DECLARATION'S.  A dialog that lists the same inputs in another
    order disagrees with the contract it came from, and a stable order is also
    what lets a caller compare the whole list.
    """
    unanswered = set(missing)
    questions = []
    for item in declarations:
        name = item.get("name")
        if not isinstance(name, str) or name not in unanswered:
            continue
        question = {"parameter": name}
        # A catalog declaration spells these `type`/`unit` and `description`;
        # a workflow manifest spells them `kind` and `means`.  Both are read so
        # one question builder serves both, and the catalog's spelling wins only
        # when the other is absent.
        kind = _stated(item.get("kind"))
        if kind is None:
            parts = [_stated(item.get("type")), _stated(item.get("unit"))]
            kind = ", ".join(part for part in parts if part is not None) or None
        if kind is not None:
            question["kind"] = kind
        means = _stated(item.get("means")) or _stated(item.get("description"))
        if means is not None:
            question["means"] = means
        reason = _stated(item.get("reason")) or _stated(item.get("why_not_inferred"))
        if reason is not None:
            question["reason"] = reason
        choices = item.get("choices")
        choices = list(choices) if isinstance(choices, list) and choices else []
        suggested = item.get("suggested")
        if suggested is None or isinstance(suggested, (dict, list)):
            suggested = choices[0] if choices else None
        question["suggested"] = suggested
        question["choices"] = choices
        examples = item.get("examples")
        if isinstance(examples, list) and examples:
            question["examples"] = list(examples)
        questions.append(question)
    return questions


def verb_algorithm_run(options):
    entries = {entry["id"]: entry for entry in workspace_algorithms(options.workspace)}
    duplicates = library()._by_id.keys() & entries.keys()
    if duplicates:
        raise RuntimeError("user algorithm ids collide with built-ins: %s" % ", ".join(sorted(duplicates)))
    entry = entries.get(options.id)
    if entry is None:
        return {"ok": False, "algorithm": options.id,
                "refused": "no workspace algorithm with this id; available: %s"
                           % (", ".join(sorted(entries)) or "none")}
    supplied = json.loads(options.arguments) if options.arguments else {}
    if not isinstance(supplied, dict):
        raise RuntimeError("algorithm arguments must be a JSON object")
    missing = [item["name"] for item in entry["inputs"]
               if item.get("required", True) and item["name"] not in supplied]
    if missing:
        return {"ok": False, "algorithm": options.id, "needs_input": True,
                "questions": input_questions(entry["inputs"], missing),
                "refused": "missing required inputs: %s" % ", ".join(missing)}
    result = run_isolated({"name": options.id, **entry}, supplied, options.timeout_seconds, options.workspace)
    if result.get("ok"):
        check_result_schema(entry["result_schema"], result.get("report"), options.id)
    result["algorithm"] = options.id
    result["source_sha256"] = entry["source_sha256"]
    result.pop("workflow", None)
    return result


# The `type` names JSON Schema shares with Python, and the Python classes that
# satisfy each.  `number` and `integer` and `boolean` are handled in
# `_matches_type` rather than here because Python's `bool` IS an `int`.
_JSON_TYPE_CLASSES = {"object": dict, "array": list, "string": str, "null": type(None)}


def _json_type_of(value):
    """The JSON Schema type name of a decoded JSON value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _matches_type(value, names):
    for name in names:
        # `bool` first every time: `isinstance(True, int)` is true, so a schema
        # asking for an integer would otherwise be satisfied by `true`.
        if name == "boolean":
            if isinstance(value, bool):
                return True
        elif name in ("integer", "number"):
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if name == "number" or isinstance(value, int):
                    return True
        elif isinstance(value, _JSON_TYPE_CLASSES[name]):
            return True
    return False


def check_result_schema(schema, value, identifier):
    """Refuse a result the algorithm's own declared schema rules out.

    TWO RULES -- `type`, and `required` on an object -- AND THAT BOUNDARY IS THE
    POINT rather than a shortcut.  A full validator is a dependency this plugin
    does not have and a second implementation of a standard; a partial one that
    *looks* complete is worse than a small one that says where it stops.  Every
    other keyword a manifest may write (`properties`, `items`, `enum`, `$ref`,
    `format`) is carried, published through `iam_algorithm_describe`, and NOT
    enforced.

    What these two catch is the mistake people actually make: declaring an object
    and returning a list, or renaming a field after the manifest was written.
    Without them a declared schema is decoration, and `workspace_algorithms`
    requiring one made it look like a contract.

    Raised rather than returned as a refusal, because a result that contradicts
    the algorithm's own manifest is a defect in that algorithm and not a fact
    about the request -- the same reason a malformed manifest raises.
    """
    if not isinstance(schema, dict):
        return
    declared = schema.get("type")
    if declared is not None:
        names = declared if isinstance(declared, list) else [declared]
        if not _matches_type(value, names):
            raise RuntimeError(
                "algorithm %s returned %s but its result_schema declares type %s"
                % (identifier, _json_type_of(value), "/".join(str(name) for name in names)))
    required = schema.get("required")
    if required:
        if not isinstance(value, dict):
            raise RuntimeError("algorithm %s declares required fields but returned %s"
                               % (identifier, _json_type_of(value)))
        missing = [str(name) for name in required if name not in value]
        if missing:
            raise RuntimeError("algorithm %s returned nothing for required field(s): %s"
                               % (identifier, ", ".join(sorted(missing))))


def verb_mine_describe(options):
    """What a Mining project holds, in one answer.

    This is the surface that makes "find the roadways and the orebody" possible
    without guessing an id: semantic elements with their names and metadata,
    the geometry each references, and -- for a block model -- the fields and
    columns a caller must name to measure anything.
    """
    import iam

    port = iam.open(options.project)
    _ = port.coordinate_frame                       # refuses a project with no frame
    if options.offset < 0 or options.limit < 1 or options.limit > 500:
        raise RuntimeError("offset must be nonnegative and limit must be between 1 and 500")

    features = []
    all_features = list(zip(port.ids(iam._abi.ELEMENT_FEATURE),
                            port.element_strings(iam._abi.ELEMENT_FEATURE)))
    for element_id, name in all_features[options.offset:options.offset + options.limit]:
        try:
            metadata = port.element_metadata(element_id)
        except iam.IamError:
            metadata = ""
        geometry = port.element_geometry_ids(element_id)
        item = {"id": element_id, "name": name, "geometry_ids": geometry, "metadata": metadata}
        # What can be done with a geometry is decided by reading it, and the two
        # answers a caller actually needs are "is it a closed solid" and "how
        # many triangles".  Reported per element rather than per type, because
        # this project holds both sheets and solids.
        if options.surface_details:
            for geometry_id in geometry:
                try:
                    triangles = port.surface_triangles(geometry_id)
                except iam.IamError:
                    continue
                item["surface"] = {"vertices": len(port.read_points(
                    iam._abi.ELEMENT_SURFACE, geometry_id, project_coordinates=False)),
                    "triangles": len(triangles)}
                break
        features.append(item)

    # The block model is the other half of any measurement.  A COLUMN IS
    # REPORTED BY WHAT ITS FIELD CALLS ITSELF, not by its id: an id like
    # `merge-2-dimine-cell-1` says nothing about whether it holds a grade, a
    # density or a level number, and a caller who has to CHOOSE one -- to ask a
    # user which column is the grade, say -- cannot offer a list of ids and
    # expect an answer.  `numeric` is the set the block-model constraint will
    # accept, so it is also the candidate set.
    models = []
    for model_id in port.ids(iam._abi.ELEMENT_BLOCK_MODEL):
        columns = []
        seen = set()
        for column_id in port.ids(iam._abi.ELEMENT_ATTRIBUTE):
            try:
                info = port.attribute_info(column_id)
                field_id = port.attribute_field_id(column_id)
            except iam.IamError:
                continue
            if field_id in seen or model_id.split("-dimine-")[0] not in column_id:
                continue
            seen.add(field_id)
            try:
                field = port.field(field_id)
            except iam.IamError:
                field = {"id": field_id, "name": "", "unit": "", "description": "",
                         "value_type": "unknown", "numeric": False}
            columns.append({"column_id": column_id, "field_id": field_id,
                            "field_name": field["name"], "field_unit": field["unit"],
                            "field_description": field["description"],
                            "value_type": field["value_type"], "numeric": field["numeric"],
                            "location": info.location, "values": info.value_count})
        models.append({"id": model_id, "columns": columns})

    return {"project": str(options.project), "project_id": port.project_id,
            "revision": port.revision, "coordinate_frame": port.coordinate_frame,
             "feature_count": len(all_features), "offset": options.offset,
             "next_offset": options.offset + len(features) if options.offset + len(features) < len(all_features) else None,
             "features": features,
            "block_models": models,
            # Said here rather than left for a caller to work out: the platform
            # records a field's name and value type and NOTHING about what its
            # numbers mean, so a choice among these is the user's to make.
            "field_names_are_not_semantics":
                "A field's name and unit are all the project records. Every field in the reference "
                "model declares unit='1' with no description, so which column holds a grade, and "
                "whether its numbers are a fraction or a percent, are not derivable -- ASK.",
            "counts": {"surfaces": len(port.ids(iam._abi.ELEMENT_SURFACE)),
                       "polylines": len(port.ids(iam._abi.ELEMENT_POLYLINE_3D)),
                       "fields": len(port.ids(iam._abi.ELEMENT_FIELD))}}


# --------------------------------------------------------------------------
# The execution surface.
# --------------------------------------------------------------------------

def child_environment(workspace=None):
    """Pass only interpreter, native-library and workspace essentials to user code."""
    allowed = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME",
               "USERPROFILE", "LANG", "LC_ALL", "LD_LIBRARY_PATH",
               "DYLD_LIBRARY_PATH", "IAM_ALGORITHMS_LIBRARY",
               "IAM_C_LIBRARY", "IAM_PLOT_C_LIBRARY", "IAM_ALGORITHMS_PYTHON_MODULE", "IAM_PYTHON_PACKAGE_DIR",
                "IAM_ALGORITHM_PROVIDERS", "IAM_ALGORITHM_USER_IMPLEMENTATIONS",
               "IAX_PLATFORM_ROOT",
               # The packaged Desktop's programRunner adapter needs these to
               # start the harness ACL runner as an Electron-Node child.
               "IAM_SANDBOX_RUNNER", "ELECTRON_RUN_AS_NODE")
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    existing = os.environ.get("PYTHONPATH", "").split(os.pathsep)
    paths = [str(directory) for directory in PYTHON_PACKAGE_PATHS]
    environment["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(
        path for path in paths + existing if path))
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONNOUSERSITE"] = "1"
    if workspace:
        environment["IAX_EXECUTION_WORKSPACE"] = str(Path(workspace).resolve())
    return environment


def program_command(path, arguments):
    """Require an external sandbox adapter unless a deployment opts into host execution."""
    command = [sys.executable, "-X", "utf8", str(path)] + list(arguments)
    encoded = os.environ.get("IAX_PROGRAM_RUNNER_JSON")
    if encoded:
        runner = json.loads(encoded)
        if not isinstance(runner, list) or not runner or not all(
                isinstance(item, str) and item for item in runner):
            raise RuntimeError("IAX_PROGRAM_RUNNER_JSON must be a non-empty string array")
        return runner + command
    if os.environ.get("IAX_ALLOW_UNSAFE_PROGRAMS") == "1":
        return command
    raise RuntimeError("user code requires a configured programRunner sandbox; "
                       "allowUnsafeExecution is only for trusted local development")


def kill_process_tree(process):
    if os.name == "nt":
        job = getattr(process, "iax_job", None)
        if job is not None:
            job.terminate()
            return
    if process.poll() is not None:
        return
    if os.name == "nt":
        taskkill = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32" / "taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


ACTIVE_CHILD = None


def cancellation_requested():
    marker = os.environ.get("IAX_CANCEL_FILE")
    return bool(marker and Path(marker).is_file())


def stop_active_child(_signum, _frame):
    if ACTIVE_CHILD is not None:
        kill_process_tree(ACTIVE_CHILD)
    raise SystemExit(143)


if os.name != "nt":
    signal.signal(signal.SIGTERM, stop_active_child)


def write_program(source):
    """Write the program to one file, and return where it went.

    Written to a file rather than passed with `-c`: a generated program is
    routinely longer than a command line allows on Windows, and a file gives the
    child a `__file__` that points somewhere real, which a program that resolves
    a path relative to itself needs.

    ONE FILE, NOT A DIRECTORY PER RUN.  The first version wrote `program.py` into
    a fresh directory and let `tempfile.TemporaryDirectory` remove it.  Measured
    2026-10-12 against the desktop harness's own `workspace-write` sandbox, whose
    grant denies the ambient parent-delete right and leaves its capability ACE as
    the only delete authority: a confined child creates a directory and writes
    into it, and is then refused BOTH the file's removal and the directory's
    (`PermissionError: [WinError 5] 拒绝访问`) -- while a file created directly in
    the same root, one level up, deletes normally.  The program ran, both streams
    were captured in full, and the tool call failed anyway while tidying up.  A
    file has no second level that can be refused.
    """
    try:
        handle, name = tempfile.mkstemp(prefix="iam-program-", suffix=".py")
    except OSError as error:
        # Said here rather than left as a bare errno: a confined session may only
        # write where its sandbox granted, and TEMP is one of the things that
        # grant does not always cover.
        raise RuntimeError("could not write the program into %s (%s); a confined session "
                           "can only write where its sandbox grants, and TEMP/TMP say "
                           "where that is" % (tempfile.gettempdir(), error)) from error
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(source)
    return Path(name)


def discard_program(path):
    """Remove the program file, best effort, and return why it survived.

    Called after the program has run, so its output is already the answer: a
    sandbox that refuses the removal must not be able to turn a finished run into
    a failed tool call.  What it must not do either is leave litter silently, so
    the reason travels in the result instead of being swallowed.
    """
    try:
        path.unlink()
    except OSError as error:
        return str(error)
    return None


def run_program(source, timeout, arguments=(), workspace=None):
    """Run one Python program in a child process and return what it produced."""
    if not math.isfinite(timeout) or timeout <= 0 or timeout > 3600:
        raise RuntimeError("program timeout must be between 0 and 3600 seconds")
    if cancellation_requested():
        raise RuntimeError("program was cancelled before it started")
    environment = child_environment(workspace)
    path = write_program(source)
    try:
        command = program_command(path, arguments)
        global ACTIVE_CHILD
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=environment, cwd=str(path.parent),
            **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
               else {"start_new_session": True}))
        if os.name == "nt":
            try:
                process.iax_job = _WindowsJob(process)
            except BaseException:
                process.kill()
                process.wait()
                process.stdout.close()
                process.stderr.close()
                raise
        ACTIVE_CHILD = process
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        sizes = {"stdout": 0, "stderr": 0}
        total = [0]
        lock = threading.Lock()
        exceeded = threading.Event()

        def drain(stream, key):
            while chunk := stream.read(65536):
                with lock:
                    total[0] += len(chunk)
                    sizes[key] += len(chunk)
                    if total[0] > MAX_CAPTURE_BYTES:
                        exceeded.set()
                    data = captured[key]
                    data.extend(chunk[-OUTPUT_LIMIT_BYTES:])
                    if len(data) > OUTPUT_LIMIT_BYTES:
                        del data[:-OUTPUT_LIMIT_BYTES]
            stream.close()

        readers = [threading.Thread(target=drain, args=(process.stdout, "stdout"), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, "stderr"), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + timeout
        timed_out = False
        while process.poll() is None:
            if cancellation_requested():
                kill_process_tree(process)
                break
            if exceeded.is_set():
                kill_process_tree(process)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                kill_process_tree(process)
                break
            try:
                process.wait(timeout=min(0.1, max(0.001, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
        process.wait()
        ACTIVE_CHILD = None
        if os.name == "nt":
            process.iax_job.close()
        for reader in readers:
            reader.join(timeout=2)
    finally:
        leftover = discard_program(path)
    stdout = bytes(captured["stdout"]).decode("utf-8", "replace")
    stderr = bytes(captured["stderr"]).decode("utf-8", "replace")
    return {
        "ok": process.returncode == 0 and not exceeded.is_set() and not timed_out,
        "timeout": timed_out,
        "exit_code": process.returncode,
        # Truncated from the END, not the beginning: a traceback's last lines are
        # the ones that say what went wrong, and a program that failed has its
        # answer there.
        "stdout": stdout,
        "stderr": stderr,
        "stdout_truncated": sizes["stdout"] > OUTPUT_LIMIT_BYTES,
        "stderr_truncated": sizes["stderr"] > OUTPUT_LIMIT_BYTES,
        **({"detail": "program output exceeded its 1 MiB limit"} if exceeded.is_set() else {}),
        # A path and a reason rather than a sentence, because a caller that wants
        # to remove it wants the path, and one that wants to explain it has the
        # reason.
        **({"leftover": {"path": str(path), "reason": leftover}} if leftover else {}),
    }


def _artifact_skipped(relative):
    """Whether a workspace-relative path is part of the platform, not the product."""
    if any(relative == root or relative.startswith(root + "/") for root in ARTIFACT_SKIP_ROOTS):
        return True
    return any(part in ARTIFACT_SKIP_DIRECTORIES for part in relative.split("/"))


def snapshot_workspace(workspace):
    """Every regular file under the workspace: relative path -> (bytes, mtime_ns).

    A SNAPSHOT IS TAKEN BEFORE AND AFTER THE RUN and the difference is what the
    run produced.  The alternative -- asking the program what it wrote -- trusts
    the code being measured to report on itself, and a program that fails or
    crashes (the ones a reader most wants to explain) writes nothing to stdout.

    Permission errors and paths that vanish are skipped file by file: the record
    is worth having, and one unreadable directory must not cost the run.  A
    symlink is skipped rather than followed, because following one would let a
    workspace list -- and later hash -- files outside itself.

    mtime is kept in NANOSECONDS.  The comparison is (size, mtime), so a file
    rewritten with the same byte count inside the same second still counts as
    changed, which is the case a coarse timestamp would miss.
    """
    root = Path(workspace)
    if not root.is_dir():
        return {}
    found = {}
    for current, directories, files in os.walk(root, followlinks=False):
        base = Path(current)
        relative = base.relative_to(root).as_posix()
        prefix = "" if relative == "." else relative + "/"
        kept = []
        for name in directories:
            candidate = prefix + name
            if _artifact_skipped(candidate) or (base / name).is_symlink():
                continue
            kept.append(name)
        directories[:] = kept
        for name in files:
            candidate = prefix + name
            path = base / name
            if _artifact_skipped(candidate) or path.is_symlink():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            found[candidate] = (stat.st_size, stat.st_mtime_ns)
    return found


def _artifact_entry(root, relative, size, mtime_ns):
    """One recorded product: what it is, how big, when, and (usually) its hash."""
    entry = {
        "path": relative,
        "bytes": size,
        "mtime": datetime.fromtimestamp(mtime_ns / 1e9).astimezone().isoformat(timespec="microseconds"),
    }
    if size > ARTIFACT_HASH_LIMIT:
        entry["sha256_16"] = None
        entry["note"] = "larger than 64 MiB; not hashed"
        return entry
    digest = hashlib.sha256()
    try:
        with (root / relative).open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        entry["sha256_16"] = None
        entry["note"] = "could not be read: %s" % error
        return entry
    entry["sha256_16"] = digest.hexdigest()[:16]
    return entry


def workspace_artifacts(workspace, before):
    """The files a run created or changed, and whether the list was truncated.

    ORDER IS THE PATH so that two runs of the same program produce comparable
    records.  TRUNCATION IS BY SIZE, largest first, because when a run produces
    more than the record can carry the largest files are the ones a reader is
    looking for; the fact that others existed travels as `artifacts_truncated`
    rather than as silence.
    """
    after = snapshot_workspace(workspace)
    changed = [(relative, size, mtime_ns)
               for relative, (size, mtime_ns) in after.items()
               if before.get(relative) != (size, mtime_ns)]
    truncated = len(changed) > ARTIFACT_LIMIT
    if truncated:
        changed.sort(key=lambda item: (-item[1], item[0]))
        changed = changed[:ARTIFACT_LIMIT]
    changed.sort(key=lambda item: item[0])
    root = Path(workspace)
    return [_artifact_entry(root, *item) for item in changed], truncated


def record_run(workspace, source, outcome, artifacts=None, artifacts_truncated=False,
               artifacts_error=None):
    """Keep the program and what it did, under `<workspace>/.iax/runs/`.

    A RUN IS THROWN AWAY OTHERWISE.  `run_program` executes from a temporary file
    that is removed before it returns, so the source exists only in the
    conversation that produced it -- and "固化" then means asking for it again,
    which is the same as having no mechanism at all.

    Written even when the program FAILED.  A program that crashed is the one a
    reader most wants to look at afterwards, and keeping only the successes would
    make the record a list of things that happened to work.

    Best-effort, and the failure is reported rather than raised: a read-only or
    missing workspace should not turn a successful program run into a failed tool
    call.  What it must never do is pretend to have recorded something.
    """
    if not workspace:
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    root = Path(workspace).resolve()
    runs = (root / ".iax" / "runs").resolve()
    if not runs.is_relative_to(root):
        return {"recorded": False, "reason": "the .iax/runs directory escapes the workspace"}
    try:
        runs.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="run-%s-" % stamp, dir=runs))
        (directory / "program.py").write_text(source, encoding="utf-8")
        (directory / "run.json").write_text(json.dumps({
            "started": stamp, "exit_code": outcome["exit_code"], "ok": outcome["ok"],
            "timeout": outcome["timeout"], "stdout_truncated": outcome["stdout_truncated"],
            "stderr_truncated": outcome["stderr_truncated"],
            "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "platform_root": str(ROOT), "python": sys.version.split()[0],
            "sandboxed": bool(os.environ.get("IAX_PROGRAM_RUNNER_JSON")),
            # Always present, and always a list: "the run produced nothing" is
            # an answer, while a missing field would be indistinguishable from a
            # record written by an older bridge -- and the CapabilityForge audit
            # reads this field to decide whether a result still matches its run.
            "artifacts": list(artifacts or []),
            "artifacts_truncated": bool(artifacts_truncated),
            **({"artifacts_error": artifacts_error} if artifacts_error else {}),
            # What the algorithms this run called actually were.  A provider
            # can replace a built-in implementation and can add algorithms, so
            # the same program against the same catalog version can produce
            # different numbers on two machines -- and without these two fields
            # the difference has no explanation anywhere in the record.
            **algorithm_environment(),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as error:
        return {"recorded": False, "reason": str(error)}
    return {"recorded": True, "directory": str(directory), "id": directory.name}


# The token the Python binding appends to a missing-argument TypeError (see
# `throwMissingInputs` in IAM/Host/Python/Source/Buffers.cpp).  A generated
# program's missing input reaches this process only as a traceback in its
# stderr, so the two halves agree on one token that turns that line into the
# same structured answer the workspace path returns directly.
NEEDS_INPUT_MARKER = "[IAM_NEEDS_INPUT]"


def needs_input_of(outcome):
    """The (algorithm, missing) payload a failed program's stderr carries, if any."""
    position = outcome["stderr"].rfind(NEEDS_INPUT_MARKER)
    if position < 0:
        return None
    line = outcome["stderr"][position + len(NEEDS_INPUT_MARKER):].split("\n", 1)[0].strip()
    try:
        payload = json.loads(line)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    algorithm = payload.get("algorithm")
    missing = payload.get("missing")
    if not isinstance(algorithm, str) or not algorithm:
        return None
    if not isinstance(missing, list) or not missing or not all(
            isinstance(name, str) and name for name in missing):
        return None
    return algorithm, missing


def algorithm_questions(algorithm, missing):
    """Questions for a built-in algorithm's missing required inputs.

    The declarations come from the same catalog `iam_algorithm_describe`
    publishes, so a question says exactly what the catalog says and nothing
    this process made up.  Inputs and parameters can name the same thing; the
    first declaration wins, and order is the catalog's.
    """
    try:
        entry = library()._by_id.get(algorithm)
    except Exception:                     # noqa: BLE001 - a record is not worth failing a run
        return []
    if not isinstance(entry, dict):
        return []
    declarations, seen = [], set()
    for key in ("inputs", "parameters"):
        for item in entry.get(key) or []:
            name = item.get("name") if isinstance(item, dict) else None
            if isinstance(name, str) and name not in seen:
                seen.add(name)
                declarations.append(item)
    unanswered = set(missing)
    return input_questions(declarations, [item["name"] for item in declarations
                                          if item["name"] in unanswered])


def verb_program_run(options):
    source = options.code
    if options.file:
        source = Path(options.file).read_text(encoding="utf-8")
    if not source.strip():
        raise RuntimeError("no program was supplied")
    # THE SNAPSHOT IS AROUND THE PROGRAM, NOT INSIDE `record_run`: the record is
    # written after the run and would otherwise see its own `program.py` and
    # `run.json` as products.  A snapshot that cannot be taken is reported in
    # the record and never fails the run -- the same rule `record_run` follows.
    before, artifacts_error = None, None
    if options.workspace:
        try:
            before = snapshot_workspace(options.workspace)
        except OSError as error:
            artifacts_error = "could not list the workspace before the run: %s" % error
    outcome = run_program(source, options.timeout_seconds, workspace=options.workspace)
    if not outcome["ok"]:
        found = needs_input_of(outcome)
        if found is not None:
            algorithm, missing = found
            questions = algorithm_questions(algorithm, missing)
            if questions:
                outcome["needs_input"] = True
                outcome["algorithm"] = algorithm
                outcome["questions"] = questions
                outcome["refused"] = "missing required inputs: %s" % ", ".join(
                    question["parameter"] for question in questions)
    artifacts, artifacts_truncated = [], False
    if before is not None:
        try:
            artifacts, artifacts_truncated = workspace_artifacts(options.workspace, before)
        except OSError as error:
            artifacts_error = "could not list the workspace after the run: %s" % error
    record = record_run(options.workspace, source, outcome, artifacts=artifacts,
                        artifacts_truncated=artifacts_truncated,
                        artifacts_error=artifacts_error)
    if record is not None:
        outcome["record"] = record
    return outcome


SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def version_key(value):
    """A semantic version as comparable numbers, or None when it is not one.

    Deliberately strict: three numeric parts and nothing else.  A version is the
    thing that decides whether an existing workflow may be replaced, so `1.2`,
    `v1.2.0` and `1.2.0-beta` must be refused here rather than sorted by a rule
    nobody wrote down.
    """
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


# The manifest fields this platform understands beyond the five that make up a
# workflow's own contract (`title`, `answers`, `inputs`, `steps`, `acceptance`).
#
# A WHITELIST, AND THE REASON IS A SILENT FAILURE.  Freezing used to merge the
# caller's JSON verbatim, so a manifest that misspelt `acceptance_checks` froze
# successfully and the assertion it was meant to carry simply did not exist --
# after which "acceptance passed" in a report was a sentence about a rule nobody
# had ever tested.  A field the platform does not read has no business being
# written into a contract it will later be judged by.
EXTENSION_FIELDS = {
    "version": str,                  # semver; see version_key
    "status": str,                   # draft|active; `workflow_catalog` and run read it
    "supersedes": (str, type(None)),
    "requires_catalog": int,         # positive: the catalog is numbered from 1
    "derived": list,
    "consumes": dict,
    "produces": dict,
    "specs": dict,
    "acceptance_checks": list,
    "acceptance_params": dict,
    "known_limits": list,
    "deliverable": dict,
    # NOT ONE OF THE ELEVEN CONTRACT FIELDS.  It is accepted because this
    # repository's own manifests use it to explain themselves to a reader
    # (`Workflows/Examples/ByProductOre/manifest.json`, `IAM/plugin/manifest.json`), and a
    # freeze of that manifest must not fail on the prose that documents it.  It
    # is data for humans and nothing reads it -- which is the one exception the
    # rule above can afford, because its absence would never be mistaken for a
    # passing assertion.
    "comment": list,
}


def _type_name(expected):
    if isinstance(expected, tuple):
        return " or ".join("null" if item is type(None) else item.__name__ for item in expected)
    return expected.__name__


def validate_manifest_extensions(declared):
    """Refuse a field the freezer would store and no reader would ever see.

    The suggestion is the point: `accepatance_checks` is one transposed letter
    away from an assertion that will be enforced, and a bare "unknown field"
    would leave the author to find it.  `difflib` names the intended field when
    there is one and says nothing when there is not -- inventing a suggestion is
    how a helpful error becomes a misleading one.
    """
    for key, value in declared.items():
        if key in ("title", "answers", "inputs", "steps", "acceptance"):
            continue
        expected = EXTENSION_FIELDS.get(key)
        if expected is None:
            close = difflib.get_close_matches(key, EXTENSION_FIELDS, n=1)
            suggestion = (' did you mean "%s"?' % close[0]) if close else ""
            raise RuntimeError(
                'manifest field "%s" is not one this platform reads;%s A field the freezer '
                'does not understand would be written into the manifest and read by nobody, '
                'so a typo would silently drop what it was meant to say.'
                % (key, suggestion))
        # `bool` first: Python's True IS an int, so a type check that starts with
        # isinstance would accept `requires_catalog: true` as a catalogue number.
        allowed = (isinstance(value, expected) and not isinstance(value, bool)) \
            if not isinstance(expected, tuple) else isinstance(value, expected)
        if not allowed:
            raise RuntimeError(
                'manifest field "%s" must be %s; it is %s'
                % (key, _type_name(expected), _json_type_of(value)))
        if key == "requires_catalog" and value < 1:
            raise RuntimeError('manifest "requires_catalog" must be a positive integer; got %r'
                               % (value,))

    version = declared.get("version")
    if version is not None and version_key(version) is None:
        raise RuntimeError('manifest "version" must be a semantic version such as "1.2.0"; got %r'
                           % (version,))

    # THE CATALOG READS THIS FIELD, so the freezer must understand it: a draft
    # frozen directly through the bridge stays a draft, and `iam_workflow_run`
    # refuses it until something publishes it. The forge freezes as draft and
    # writes active only after the lock is recorded.
    status = declared.get("status")
    if status is not None and status not in ("draft", "active"):
        raise RuntimeError('manifest "status" must be "draft" or "active"; got %r'
                           % (status,))

    checks = declared.get("acceptance_checks")
    if checks is None:
        return
    acceptance = declared.get("acceptance")
    acceptance = acceptance if isinstance(acceptance, list) else []
    for position, check in enumerate(checks, 1):
        where = "acceptance_checks[%d]" % position
        if not isinstance(check, dict) or not check:
            raise RuntimeError("%s must be an object with an id and an assert" % where)
        for field in ("id", "assert"):
            if not _stated(check.get(field)):
                raise RuntimeError('%s is missing a non-empty "%s"; a check without one cannot '
                                   'be run, which makes it a rule that can never fail'
                                   % (where, field))
    if len(checks) != len(acceptance):
        if len(acceptance) > len(checks):
            raise RuntimeError(
                "acceptance lists %d rule(s) but acceptance_checks lists %d; rule %d has no "
                "assertion. An acceptance rule with no assertion is a rule that can never fail, "
                "so the report's 'accepted' would be a statement nobody tested."
                % (len(acceptance), len(checks), len(checks) + 1))
        raise RuntimeError(
            "acceptance lists %d rule(s) but acceptance_checks lists %d; check %d belongs to "
            "no rule. A check the report never prints is a check whose result nobody reads."
            % (len(acceptance), len(checks), len(acceptance) + 1))
    identifiers = [check["id"] for check in checks]
    if len(identifiers) != len(set(identifiers)):
        duplicate = next(item for item in identifiers if identifiers.count(item) > 1)
        raise RuntimeError('acceptance_checks repeats the id "%s"; ids are what a report uses '
                           "to match a verdict to its rule, so a duplicate leaves one of them "
                           "unaddressed" % duplicate)
    for position, (rule, check) in enumerate(zip(acceptance, checks), 1):
        if isinstance(rule, dict) and _stated(rule.get("id")) and rule["id"] != check["id"]:
            raise RuntimeError(
                'acceptance[%d] names id "%s" but acceptance_checks[%d] is "%s"; a check must '
                "follow the rule it belongs to" % (position, rule["id"], position, check["id"]))


def frozen_version(folder):
    """The version an existing workflow directory records, or None.

    None is not "version 0": it means the directory predates versioning or its
    manifest cannot be read, and either way a same-name freeze has no basis for
    deciding that it may replace it.  The old refusal is the right answer there.
    """
    try:
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = manifest.get("version") if isinstance(manifest, dict) else None
    return version if version_key(version) is not None else None


def archive_previous(target, version):
    """Copy the current workflow aside before a same-name freeze replaces it.

    A COPY RATHER THAN A MOVE: the top-level pair keeps serving
    `iam_workflow_run` until the replacement is written, so a failure between
    the two steps leaves a runnable workflow rather than none.  The archive is a
    history entry, so an existing one is never overwritten: if it is byte-for-
    byte what is about to be copied the operation is a retry and may continue,
    and if it differs somebody's history is at stake and it is refused.
    """
    names = ("workflow.py", "manifest.json")
    archive = target / "versions" / version
    if archive.exists():
        try:
            identical = all((archive / name).is_file()
                            and (target / name).read_bytes() == (archive / name).read_bytes()
                            for name in names)
        except OSError:
            identical = False
        if not identical:
            raise RuntimeError("%s already holds a different copy of version %s; refusing to "
                               "overwrite a history entry" % (archive, version))
        return
    for name in names:
        if not (target / name).is_file():
            raise RuntimeError("%s is not a complete workflow (no %s); refusing to replace it"
                               % (target, name))
    try:
        archive.mkdir(parents=True)
        for name in names:
            shutil.copy2(target / name, archive / name)
    except OSError as error:
        raise RuntimeError("could not archive %s as version %s: %s"
                           % (target, version, error)) from error


def verb_workflow_freeze(options):
    """Turn a run into a workflow, by writing the directory the catalog reads.

    THIS IS THE "固化" STEP, and it is deliberately an act rather than an
    automatic consequence of a run succeeding.  A program that worked once is not
    yet a procedure: what makes it one is somebody stating what it requires, what
    steps it performs and what would count as it having gone wrong -- which is
    exactly the three things `Workflows/README.md` makes an entry bar.  Those are
    arguments here, not defaults, because a manifest filled in by this program
    would be a manifest nobody meant.

    The source comes from a RECORDED RUN (`--run <id>`) rather than from the
    caller's text, so the frozen workflow is the program that actually ran.
    """
    if not options.workspace:
        raise RuntimeError("freezing needs a workspace; there is nowhere to write a workflow")
    if not options.run:
        raise RuntimeError("name the recorded run to freeze (--run)")
    if not re.fullmatch(r"[\w][\w.-]{0,79}", options.name) or options.name in (".", ".."):
        raise RuntimeError("workflow name must be one path component (letters, digits, _, - or .)")
    if not re.fullmatch(r"run-[0-9]{8}-[0-9]{6}-[\w-]+", options.run):
        raise RuntimeError("run must be a recorded run id, not a path")
    workspace = Path(options.workspace).resolve(strict=True)
    runs = (workspace / ".iax" / "runs").resolve()
    workflows = (workspace / ".iax" / "workflows").resolve()
    if not runs.is_relative_to(workspace) or not workflows.is_relative_to(workspace):
        raise RuntimeError("the .iax directories must stay inside the workspace")
    directory = runs / options.run
    source_path = directory / "program.py"
    if not source_path.is_file() or not source_path.resolve().is_relative_to(directory):
        existing = sorted(item.name for item in runs.glob("run-*")) if runs.is_dir() else []
        raise RuntimeError("no recorded run %r under %s; there are %s"
                           % (options.run, runs, ", ".join(existing[-8:]) or "none"))
    source = source_path.read_text(encoding="utf-8")
    record_path = directory / "run.json"
    if not record_path.is_file() or not record_path.resolve().is_relative_to(directory):
        raise RuntimeError("the recorded run has no trustworthy run.json")
    record = json.loads(record_path.read_text(encoding="utf-8"))
    if not record.get("ok") or record.get("timeout"):
        raise RuntimeError("only a successful recorded run can become a workflow")
    if record.get("source_sha256") != hashlib.sha256(source.encode("utf-8")).hexdigest():
        raise RuntimeError("the recorded program changed after it ran")

    try:
        declared = json.loads(options.manifest) if options.manifest else {}
    except ValueError as error:
        raise RuntimeError("--manifest is not JSON: %s" % error) from error
    if not isinstance(declared, dict):
        raise RuntimeError("--manifest must be a JSON object")
    for required in ("title", "answers"):
        if not declared.get(required):
            raise RuntimeError("the manifest needs %r; see "
                               "Workflows/Examples/ByProductOre/manifest.json for what a "
                               "workflow is asked to say about itself" % required)
    for required in ("inputs", "steps", "acceptance"):
        if required not in declared:
            raise RuntimeError(
                "%r is missing. A workflow that cannot state its %s is still a one-off "
                "program, and Workflows/README.md makes that the bar for taking a name."
                % (required, {"inputs": "input requirements", "steps": "step dependencies",
                              "acceptance": "acceptance rules"}[required]))
    if not isinstance(declared["inputs"], dict):
        raise RuntimeError("workflow inputs must be an object")
    required_inputs = declared["inputs"].get("required")
    if required_inputs is not None:
        if not isinstance(required_inputs, list):
            raise RuntimeError("workflow inputs.required must be a list")
        for position, item in enumerate(required_inputs, 1):
            where = "inputs.required[%d]" % position
            if not isinstance(item, dict):
                raise RuntimeError("%s must be an object stating name, kind, means and "
                                   "refused_when" % where)
            # These four are the question a missing input becomes, so a
            # declaration that omits one would freeze into a workflow that
            # cannot say what it is waiting for.  The position is named because
            # the manifest is JSON handed over as one line, where counting
            # items is the reader's only way to find the one that is wrong.
            for field in ("name", "kind", "means", "refused_when"):
                if not _stated(item.get(field)):
                    raise RuntimeError(
                        '%s is missing a non-empty "%s"; a required input has to say what it '
                        'is called, what it takes, what it means and when a run refuses '
                        'without it' % (where, field))
            if "choices" in item and not (isinstance(item["choices"], list) and item["choices"]):
                raise RuntimeError('%s "choices" must be a non-empty list' % where)
            if "suggested" in item and isinstance(item["suggested"], (dict, list)):
                raise RuntimeError('%s "suggested" must be a scalar' % where)
            for field in ("why_not_inferred", "impact"):
                if field in item and not _stated(item[field]):
                    raise RuntimeError('%s "%s" must be a non-empty string' % (where, field))
    if not isinstance(declared["steps"], list) or not declared["steps"]:
        raise RuntimeError("workflow steps must be a non-empty list")
    if not isinstance(declared["acceptance"], list) or not declared["acceptance"]:
        raise RuntimeError("workflow acceptance must be a non-empty list")
    if not options.confirmed:
        raise RuntimeError("freezing requires explicit confirmation of the run and its acceptance rules")
    if any(key in declared for key in ("workflow_version", "name", "entry", "provenance")):
        raise RuntimeError("manifest may not override workflow_version, name, entry or provenance")
    # AFTER the reserved keys and BEFORE anything is written: a whitelist that
    # ran later would still have stored the typo it is meant to refuse.
    validate_manifest_extensions(declared)

    # THE VERSION IS TWO THINGS AT ONCE: what the frozen manifest says, and the
    # permission to replace an existing directory.  If `--version` and the
    # manifest disagree, one of them would be a lie, so they are required to
    # agree rather than one silently winning.
    requested = options.version
    declared_version = declared.get("version")
    if requested is not None and version_key(requested) is None:
        raise RuntimeError('--version must be a semantic version such as "1.2.0"; got %r'
                           % (requested,))
    if requested is not None and declared_version is not None and requested != declared_version:
        raise RuntimeError('--version says "%s" but the manifest declares "%s"; a manifest that '
                           "names one version while the directory is frozen as another leaves "
                           "every later reader with two answers" % (requested, declared_version))
    version = requested if requested is not None else declared_version
    if requested is not None and declared_version is None:
        declared["version"] = requested

    target = workflows / options.name
    # A NAME IS ONE COMPONENT, BUT A SYMLINK IS NOT A NAME.  An existing target
    # that resolves outside the workflow root would make the writes below land
    # outside the workspace; refuse it before the version rules read or archive
    # anything through it.
    if target.exists() and not target.resolve().is_relative_to(workflows):
        raise RuntimeError("the workflow directory resolves outside the workflow root: %s"
                           % target)
    replaced = None
    if target.exists():
        if not target.is_dir():
            raise RuntimeError("%s already exists and is not a workflow directory; freezing "
                               "does not overwrite a workflow" % target)
        previous = frozen_version(target)
        if previous is None:
            # The old protection, unchanged in effect: a directory whose version
            # cannot be read is not something a version comparison may replace.
            raise RuntimeError("%s already exists and its manifest records no version; freezing "
                               "does not overwrite a workflow. Remove it, choose another name, or "
                               "freeze it once with a version before advancing it." % target)
        if version is None:
            raise RuntimeError("%s already exists at version %s; this freeze names no version. "
                               "Pass --version (or declare manifest.version) to move it forward."
                               % (target, previous))
        if version_key(version) <= version_key(previous):
            raise RuntimeError("cannot freeze %s at version %s: it is already frozen at %s. A "
                               "same-name freeze may only move forward; replacing it with an equal "
                               "or lower version would make the existing history unreachable."
                               % (options.name, version, previous))
        archive_previous(target, previous)
        replaced = {"version": version, "previous_version": previous}
    try:
        if not target.exists():
            target.mkdir(parents=True)
        (target / "workflow.py").write_text(source, encoding="utf-8")
        manifest = {"workflow_version": 1, "name": options.name, "entry": "workflow.py"}
        manifest.update(declared)
        manifest["source_sha256"] = record["source_sha256"]
        manifest["confirmed_from_run"] = options.run
        (target / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as error:
        raise RuntimeError("could not write %s: %s" % (target, error)) from error
    status = manifest.get("status")
    return {"frozen": True, "name": options.name, "directory": str(target),
            "status": status if status in ("draft", "active") else "active",
            "from_run": options.run,
            "replaced": replaced,
            "next": ("iam_workflow_list shows it as a draft; iam_workflow_run refuses it "
                     "until something publishes it") if status == "draft" else
                    ("iam_workflow_list will show it; iam_workflow_run runs it isolated, "
                     "because a workflow found in a workspace is not repository code.")}


def workflow_roots(workspace=None):
    """Every directory a workflow may live in, innermost last.

    TWO ROOTS, and where a workflow was FOUND decides how it is run, so the
    distinction cannot be talked around by a manifest that claims otherwise:

      * the built-in directory in this checkout.  It holds the example fixture
        under `Examples/`, one level below the `*/manifest.json` the catalog
        scans, so a fresh install discovers no platform capability.  A
        `--directory` fixture runs here, in-process;
      * `<workspace>/.iax/workflows`, whose contents a user wrote.  This is the
        only default source of capabilities, and the only one that is frozen
        from a confirmed run.

    `.iax/` is the layout `IAM/plugin/Workspace/README.md` already fixes for
    everything that is IAX's own in a workspace rather than the Harness's -- it
    names `algorithms/`, `plugins/`, `runs/` and `artifacts/`, and this is the
    fifth.  A workflow is the one of those that is a program with a contract, so
    it gets its own word rather than living under `plugins/`.
    """
    roots = [(WORKFLOWS, "builtin")]
    if workspace:
        base = Path(workspace).resolve()
        user_root = (base / ".iax" / "workflows").resolve()
        if not user_root.is_relative_to(base):
            raise RuntimeError("the workflow directory escapes the workspace")
        roots.append((user_root, "workspace"))
    return roots


def archived_versions(folder):
    """The version copies under `<workflow>/versions/`, oldest first.

    HISTORY, NOT ENTRIES.  `workflow_catalog` reads only the top-level
    `manifest.json`, so `iam_workflow_run` cannot address `versions/1.0.0` by
    name -- and must not: a name that resolves to a retired program is the same
    defect as one that resolves to two.  The list exists so a reader can see
    what a same-name freeze kept, not so anything can run it.
    """
    directory = folder / "versions"
    if not directory.is_dir():
        return []
    names = [child.name for child in directory.iterdir()
             if child.is_dir() and (child / "manifest.json").is_file()]
    return sorted(names, key=lambda name: ((0, version_key(name))
                                           if version_key(name) else (1, (0, 0, 0)), name))


def workflow_catalog(workspace=None, directory=None):
    """Every workflow under every root, by manifest.

    `directory` is the older, narrower spelling: it replaces the built-in root
    rather than adding to it, and is kept because a test or a script that wants
    to point at one directory should not have to invent a workspace around it.
    """
    roots = [(Path(directory), "builtin")] if directory else workflow_roots(workspace)
    found, seen = [], {}
    for root, provenance in roots:
        for manifest_path in sorted(root.glob("*/manifest.json")):
            # A DOT DIRECTORY IS NOT AN ADDRESS.  The forge parks a draft as
            # .draft-<name>-<stamp> while freeze runs; the catalog must not offer
            # it, and the freeze name rule cannot produce a dot-leading name.
            # Skipping every dot directory also keeps .git-like debris out.
            if manifest_path.parent.name.startswith("."):
                continue
            folder = manifest_path.parent.resolve()
            if provenance == "workspace" and (not folder.is_relative_to(root)
                                              or not manifest_path.resolve().is_relative_to(folder)):
                raise RuntimeError("a workflow manifest escapes the workspace")
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            name = manifest.get("name", manifest_path.parent.name)
            entry_file = manifest.get("entry", "workflow.py")
            if (not isinstance(entry_file, str) or not re.fullmatch(r"[\w.-]+\.py", entry_file)
                    or entry_file in (".", "..") or not (folder / entry_file).is_file()
                    or not (folder / entry_file).resolve().is_relative_to(folder)):
                raise RuntimeError("workflow %s has no local Python entry" % folder)
            if name in seen:
                # REFUSED, not shadowed.  Two workflows with one name -- across
                # the two roots, or two directories in one root -- cannot be
                # told apart afterwards.  Quietly running one would hide the
                # other, and the caller has no way to know which one answered.
                raise RuntimeError(
                    "two workflows are named %r: %s and %s. Rename one; a name that "
                    "resolves to two programs is a name nobody can rely on."
                    % (name, seen[name], manifest_path.parent))
            seen[name] = manifest_path.parent
            # MISSING STATUS IS ACTIVE.  Every workflow that existed before this
            # field did is a working capability, including the example fixture;
            # only an explicit "draft" is refused by `iam_workflow_run`.
            status = "draft" if manifest.get("status") == "draft" else "active"
            found.append({"name": name,
                          "title": manifest.get("title"), "answers": manifest.get("answers"),
                           "entry": entry_file,
                          # `version` is the CURRENT one; `versions` is what a
                          # replacement kept under versions/.  Both are read from
                          # the top-level manifest and its children only -- see
                          # `archived_versions` for why history is not an entry.
                          "version": (manifest.get("version")
                                      if isinstance(manifest.get("version"), str) else None),
                          "versions": archived_versions(manifest_path.parent),
                          "status": status,
                          "provenance": provenance,
                          "directory": str(manifest_path.parent),
                          "required_inputs": [item["name"] for item in
                                              manifest.get("inputs", {}).get("required", [])]})
    return found


def required_inputs_of(entry):
    """The required-input declarations, as the workflow's manifest wrote them.

    RE-READ FROM THE ENTRY'S DIRECTORY rather than carried through
    `workflow_catalog`: `iam_workflow_list` is an index and answers with input
    NAMES, while the prose a question is made of belongs in the answer to that
    question.  A manifest that cannot be read now -- removed or changed since
    the catalog listed it -- declares nothing, which leaves the workflow to
    refuse as it always did.
    """
    try:
        manifest = json.loads((Path(entry["directory"]) / "manifest.json")
                              .read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    inputs = manifest.get("inputs") if isinstance(manifest, dict) else None
    required = inputs.get("required") if isinstance(inputs, dict) else None
    if not isinstance(required, list):
        return []
    return [item for item in required
            if isinstance(item, dict) and isinstance(item.get("name"), str)]


def verb_workflow_list(options):
    roots = ([(Path(options.directory), "builtin")] if options.directory
             else workflow_roots(options.workspace))
    workflows = workflow_catalog(options.workspace, options.directory)
    # ACTIVE FIRST, DRAFTS AFTER.  A scaffold is not a capability yet; putting it
    # in the same run as what can be addressed would make "what can I run" and
    # "what is being written" one list with no visible boundary.
    workflows.sort(key=lambda entry: (entry.get("status") == "draft", entry.get("name") or ""))
    return {"workflow_roots": [{"directory": str(path), "provenance": provenance}
                               for path, provenance in roots],
            "workspace": options.workspace,
            "workflows": workflows}


# A workflow found in a workspace is USER CODE, and this is the program that runs
# it in a child of the bridge instead of inside it.
#
# The rule the rest of this plugin already follows -- generated code runs in a
# grandchild so that a crash costs a tool call and not the session -- applies to
# a user's workflow for the same reason it applies to a generated program: nobody
# in this repository wrote it, and nothing here can promise it terminates, frees
# what it takes, or returns.  A built-in workflow is repository code with a
# contract and a test, so it keeps the in-process path where a refusal is an
# exception the bridge can hand back as a value.
#
# The child prints one JSON object and the workflow's own progress log goes to
# stderr, which is the same split the bridge itself keeps.
WORKFLOW_DRIVER = '''\
import importlib
import json
import sys

sys.path.insert(0, {directory!r})
module = importlib.import_module({module!r})
supplied = json.loads({arguments!r})
supplied.setdefault("log", lambda message: print(message, file=sys.stderr))
try:
    report = module.run(**supplied)
except module.WorkflowError as refusal:
    print(json.dumps({{"ok": False, "refused": str(refusal)}}, ensure_ascii=False))
else:
    print(json.dumps({{"ok": True, "report": report}}, ensure_ascii=False))
'''


def run_isolated(entry, supplied, timeout_seconds, workspace=None):
    """Run a workspace workflow in a child process and return what it said."""
    driver = WORKFLOW_DRIVER.format(
        directory=entry["directory"],
        module=Path(entry["entry"]).stem,
        arguments=json.dumps(supplied, ensure_ascii=False))
    outcome = run_program(driver, timeout_seconds, workspace=workspace)
    if outcome["timeout"]:
        return {"ok": False, "workflow": entry["name"],
                "refused": "the workflow did not finish within %g seconds" % timeout_seconds}
    if not outcome["ok"]:
        # The child failed rather than refusing -- a crash, a syntax error in the
        # user's module, a missing dependency.  That is a RESULT and not an
        # error for the same reason a refusal is: the traceback is what the
        # author needs, and it is right there in stderr.
        return {"ok": False, "workflow": entry["name"], "crashed": True,
                "exit_code": outcome["exit_code"],
                "stderr": outcome["stderr"][-4000:]}
    try:
        return json.loads(outcome["stdout"])
    except (ValueError, TypeError):
        return {"ok": False, "workflow": entry["name"],
                "refused": "the isolated run printed no report; stderr said: %s"
                           % outcome["stderr"][-400:]}


def verb_workflow_run(options):
    """Run a frozen workflow by name.

    This is what "固化" means concretely: the program that was written and
    confirmed once is addressed by a name, and its manifest says what it needs.
    HOW it runs is decided by where it was found -- see `run_isolated`.
    """
    catalog = {entry["name"]: entry for entry in
               workflow_catalog(options.workspace, options.directory)}
    entry = catalog.get(options.name)
    if entry is None:
        # A wrong name is a RESULT and not an error, for the same reason a
        # workflow's own refusal is: the caller is a model that can correct
        # itself from being told what does exist, and an exit code would leave it
        # with a message it cannot act on.
        return {"ok": False, "workflow": options.name,
                "refused": "no workflow named %r; this directory holds %s"
                           % (options.name, ", ".join(sorted(catalog)) or "none")}
    if entry.get("status") == "draft":
        # A SCAFFOLD IS NOT A CAPABILITY.  It is on disk so it can be edited and
        # run by hand while it is being written; freezing is what makes it
        # addressable, and this refusal says so instead of running the skeleton
        # as if it were the confirmed procedure.
        return {"ok": False, "workflow": options.name,
                "refused": "workflow %r is a draft: fill in workflow.py and its manifest, "
                           "run it, then iam_workflow_freeze makes it executable"
                           % options.name}

    supplied = json.loads(options.arguments) if options.arguments else {}
    declarations = required_inputs_of(entry)
    missing = [item["name"] for item in declarations if item["name"] not in supplied]
    # AN INPUT THE MANIFEST CALLS NON-INFERABLE IS ASKED FOR BEFORE THE RUN.
    # The workflow would otherwise be started and fail on it -- `run()` takes
    # such an input as a parameter with no default, so the child exits on a
    # TypeError -- and "the run crashed" is a worse answer than the question the
    # manifest already wrote down.  Inputs that do not say this keep the old
    # route: the workflow decides whether to refuse, and how.
    if missing and any(_stated(item.get("why_not_inferred")) for item in declarations
                       if item["name"] in missing):
        return {"ok": False, "workflow": options.name, "needs_input": True,
                "questions": input_questions(declarations, missing),
                "refused": "missing required inputs: %s" % ", ".join(missing)}
    if entry["provenance"] == "workspace":
        return run_isolated(entry, supplied, options.timeout_seconds, options.workspace)

    directory = Path(entry["directory"])
    sys.path.insert(0, str(directory))
    try:
        module = __import__(Path(entry["entry"]).stem)
    finally:
        sys.path.pop(0)

    # STDOUT IS THE PROTOCOL.  A workflow's progress lines are for a human, and
    # `run` takes a log callable for exactly that -- but its default is `print`,
    # which would interleave with the one JSON object this program owes its
    # caller and make the whole result unparseable.  Measured: that is what the
    # first version of this did, and the symptom was a JSON decode error on a
    # document that was valid apart from two lines of Chinese at the top.
    supplied.setdefault("log", lambda message: print(message, file=sys.stderr))
    try:
        report = module.run(**supplied)
    except module.WorkflowError as refusal:
        # A workflow's refusal is an ANSWER about the data, not a failure of the
        # tool call, so it comes back as a value the model can read and act on.
        return {"ok": False, "refused": str(refusal), "workflow": options.name}
    return {"ok": True, "workflow": options.name, "report": report}


# --------------------------------------------------------------------------

def main(argv=None):
    pin_utf8()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    verbs = parser.add_subparsers(dest="verb", required=True)

    search = verbs.add_parser("search")
    search.add_argument("--query", default="")
    search.add_argument("--operation", default=None,
                        help="one operation family, or '*' for the whole catalog")
    search.add_argument("--backend", default=None)
    search.add_argument("--workspace", default=None)
    search.set_defaults(handler=verb_search)

    describe = verbs.add_parser("describe")
    describe.add_argument("--id", required=True)
    describe.add_argument("--workspace", default=None)
    describe.set_defaults(handler=verb_describe)

    algorithm = verbs.add_parser("algorithm-run")
    algorithm.add_argument("--id", required=True)
    algorithm.add_argument("--arguments", default=None)
    algorithm.add_argument("--workspace", default=None)
    algorithm.add_argument("--timeout-seconds", type=float, default=300.0)
    algorithm.set_defaults(handler=verb_algorithm_run)

    mine = verbs.add_parser("mine-describe")
    mine.add_argument("--project", required=True)
    mine.add_argument("--offset", type=int, default=0)
    mine.add_argument("--limit", type=int, default=100)
    mine.add_argument("--surface-details", action="store_true")
    mine.set_defaults(handler=verb_mine_describe)

    program = verbs.add_parser("program-run")
    program.add_argument("--code", default="")
    program.add_argument("--file", default=None)
    program.add_argument("--timeout-seconds", type=float, default=300.0)
    program.add_argument("--workspace", default=None,
                         help="where to keep the run, under <workspace>/.iax/runs")
    program.set_defaults(handler=verb_program_run)

    listing = verbs.add_parser("workflow-list")
    listing.add_argument("--workspace", default=None)
    listing.add_argument("--directory", default=None,
                         help="one directory instead of the roots; for tests and scripts")
    listing.set_defaults(handler=verb_workflow_list)

    workflow = verbs.add_parser("workflow-run")
    workflow.add_argument("--name", required=True)
    workflow.add_argument("--arguments", default=None, help="a JSON object of run() keywords")
    workflow.add_argument("--workspace", default=None)
    workflow.add_argument("--directory", default=None)
    workflow.add_argument("--timeout-seconds", type=float, default=1800.0)
    workflow.set_defaults(handler=verb_workflow_run)

    freeze = verbs.add_parser("workflow-freeze")
    freeze.add_argument("--name", required=True, help="the name the catalog will answer to")
    freeze.add_argument("--workspace", default=None)
    freeze.add_argument("--run", default=None, help="the id of a recorded run to freeze")
    freeze.add_argument("--confirmed", action="store_true",
                        help="the user confirmed this run and its acceptance rules")
    freeze.add_argument("--manifest", default=None,
                        help="JSON with title, answers, inputs, steps and acceptance")
    freeze.add_argument("--version", default=None,
                        help="semver to freeze as; a strictly higher one may replace an existing "
                             "workflow of the same name, whose previous files are kept under "
                             "versions/<old>/")
    freeze.set_defaults(handler=verb_workflow_freeze)

    options = parser.parse_args(argv)
    try:
        return emit(options.handler(options))
    except Exception as error:                                 # noqa: BLE001
        return fail("%s: %s" % (type(error).__name__, error))


if __name__ == "__main__":
    raise SystemExit(main())
