#!/usr/bin/env python3
"""What the MiningRepository tools actually do: read, and write, a mine.

The TypeScript half of this plugin spawns this program and parses one JSON
object from its stdout.  Four verbs:

    resolve   which of the named elements a project really has
    edit      apply a declarative edit, as a document; publish nothing
    verb      run a `run(port)` verb, as a document; publish nothing
    apply     apply a document to the project it names, as one revision

`resolve` and `show` are the read half.  The other three are the write door, and
the reason they are the shape they are is one sentence from the platform: Mining
is the only truth, and the only thing that changes it is a delta committed after
validation.  So an edit here NEVER publishes -- it produces a `.iaxd` document,
which a person can read and which `apply` later commits.  That two-step is the
platform's own `--emit-delta` / `--delta` pair, and this file drives the
platform's own host rather than reimplementing either half of it.

    repository.py <verb> [--option value ...]

Every verb prints exactly one JSON object and exits 0 when it produced one.  A
verb that could not run at all (no library, no such verb) exits 2 with the reason
on stderr, which the TypeScript half turns into a thrown tool error -- "could not
be attempted" and "ran and failed" are different answers, and the exit codes are
what keeps them apart.

A REFUSAL IS NOT A FAILURE.  An element id the project does not have, an edit
description that names a resource type that does not exist, a document written
against a revision the project has left -- each exits 0 with
`{"ok": false, "refused": "..."}`: they are answers the caller reads and corrects
itself from, and throwing them would leave the caller nothing to read.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# The two containers.  Which one a document is decides where it can be shown --
# the WebAssembly view links no HDF5, so a columnar store cannot be drawn there
# at all -- and that is a question about the FILE, asked here because this is
# where the file is already being opened.
PORTABLE = "iam"
COLUMNAR = "iamh"

# The suffix a delta document is written with.  A document is a review artifact
# rather than a second copy of the mine, so it lands beside the project it
# describes -- see document_path for why that is the location and not a
# subdirectory.
DELTA_SUFFIX = ".iaxd"

# One delta document names the resources it replaces as top-level arrays, exactly
# as MiningProject.fbs's Project table does.  Listing them here is what lets this
# file report what an edit changed by reading the DOCUMENT rather than by
# re-deriving it: the artifact under review is the thing the counts come from.
REPLACED_ARRAYS = (
    "fields", "elements", "point_sets", "line_sets", "line_networks", "polylines_3d",
    "grid_surfaces", "regular_block_models", "tensor_block_models", "surfaces",
    "cross_sections", "composites", "attribute_columns",
)

# DeltaResourceType -> the name the ERASE vocabulary uses.  The document spells
# an enum SYMBOLICALLY -- flatc's JSON writes `PointSet`, not `4` -- and the two
# spellings differ (`Polyline3d` against `polyline_3d`), so this is a table
# rather than a case conversion.  Reporting back in the caller's own vocabulary is
# what lets a reader take an `erased` entry and write it straight into a new
# `erase`, which is the thing they are most likely to want to do with it.
ERASED_TYPE_NAMES = {
    "Frame": "frame", "Field": "field", "Element": "element",
    "PointSet": "point_set", "LineSet": "line_set", "Polyline3d": "polyline_3d",
    "GridSurface": "grid_surface", "BlockModel": "block_model", "Surface": "surface",
    "AttributeColumn": "attribute_column", "CrossSection": "cross_section",
    "LineNetwork": "line_network", "Composite": "composite",
}


def pin_utf8():
    """Write UTF-8 and nothing else, whatever the caller's console says.

    The same function, for the same measured reason, as AlgorithmBridge's
    bridge.py: a wire protocol whose encoding is the caller's locale is not a
    wire protocol.  On a machine whose console code page is 936, a redirected
    stdout came out in GBK and the next program to read it as JSON got
    `UnicodeDecodeError` -- and nothing about the request differed except the
    caller's locale.

    `reconfigure` rather than a new writer, so the file object's buffering and
    any redirection already in place are kept.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="strict")
        except (AttributeError, ValueError):
            pass


def emit(document):
    json.dump(document, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


def fail(message):
    sys.stderr.write("mining-repository: %s\n" % message)
    return 2


class Refused(Exception):
    """Something the caller can fix -- an id that is not there, a path that is not."""


def container_of(path):
    """Which container a document is, from its own name."""
    return COLUMNAR if Path(path).suffix.lower() in (".iamh", ".iaxh5") else PORTABLE


# --------------------------------------------------------------------------
# Driving the platform's headless host.
#
# EVERY WRITE GOES THROUGH `iam.host`.  It is where the deadline, the
# retained-bytes budget, the ABI/schema negotiation and the `--emit-delta`
# review gate already live, and a second implementation of any of them here would
# be a second answer to a question the platform has already answered.  What this
# half adds is the CLI the tools speak and the JSON they read back.
# --------------------------------------------------------------------------


def program_command(command):
    """The argv to run user code with, requiring a sandbox unless opted out.

    The same policy, spelled the same way, as AlgorithmBridge's bridge.py: a
    deployment that has configured a `programRunner` gets its programs confined,
    a local development run may opt out explicitly, and neither of those being
    true is a refusal naming both.  It is copied rather than imported because
    that half is a different package with no importable surface -- and it is a
    POLICY, not a launcher: what runs here is the platform's host, which is the
    only process that touches the project file.
    """
    encoded = os.environ.get("IAX_PROGRAM_RUNNER_JSON")
    if encoded:
        runner = json.loads(encoded)
        if not isinstance(runner, list) or not runner or not all(
                isinstance(item, str) and item for item in runner):
            raise Refused("IAX_PROGRAM_RUNNER_JSON must be a non-empty string array")
        return runner + command
    if os.environ.get("IAX_ALLOW_UNSAFE_PROGRAMS") == "1":
        return command
    raise Refused(
        "running a verb means running code this session wrote, so it needs a configured "
        "programRunner sandbox. Set IAX_PROGRAM_RUNNER_JSON to the runner's argv "
        "(allowUnsafeExecution is only for trusted local development). "
        "iam_mine_edit applies a declarative edit and needs no sandbox.")


# The deadline this half arms around the host, in seconds, and how much longer
# than the host's own it is.
#
# TWO DEADLINES, AND THE HOST'S MUST WIN.  `iam.host` arms `--timeout` with
# SIGALRM on POSIX and with a child-process watchdog on Windows; either way its
# deadline starts when the host starts, which is after this side has already
# spawned it.  The margin makes the host answer first, so the message a caller
# gets is the platform's rather than this file's.  What is left here is the
# backstop for a host that never reaches its own deadline (and for `--delta`,
# which the Windows watchdog does not wrap): "a plugin that cannot be stopped is
# not one a host can run on someone else's behalf" is the whole reason
# `iam_mine_verb` is allowed to run code at all.
HOST_DEADLINE_SECONDS = 600
DEADLINE_MARGIN_SECONDS = 30

# The most document JSON this half will carry back when a caller asks to see what
# a document changes.  Bounded rather than truncated: half of a JSON object is
# not a smaller answer, it is an unparseable one, so past this the answer says
# what the size was and where the file is.
DOCUMENT_JSON_LIMIT_BYTES = 256 * 1024

def run_host(arguments, sandbox=False, timeout_seconds=None, workspace=None):
    """Runs `python -m iam.host ...` and returns (exit code, stdout, stderr).

    A grandchild rather than an import, because the host is a CLI: it owns its
    stdout, and calling its `main()` in this process would fold its progress
    lines into the one JSON object this program owes its caller.

    ALWAYS BOUNDED.  `timeout_seconds=None` means the default, not "no limit":
    see the note on HOST_DEADLINE_SECONDS for why an unbounded host is not a
    thing this half is allowed to start.

    `workspace` is the boundary the sandboxed host may write in; the packaged
    Desktop's programRunner adapter reads it as IAX_EXECUTION_WORKSPACE.
    """
    command = [sys.executable, "-X", "utf8", "-m", "iam.host"] + list(arguments)
    if sandbox:
        command = program_command(command)
    environment = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    if sandbox and workspace:
        environment["IAX_EXECUTION_WORKSPACE"] = str(Path(workspace).resolve())
    bound = timeout_seconds or HOST_DEADLINE_SECONDS
    margin = DEADLINE_MARGIN_SECONDS
    try:
        completed = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=environment, timeout=bound + margin, check=False)
    except subprocess.TimeoutExpired:
        # The host's OWN deadline wraps the verb and publishes nothing when it
        # fires; this is the outer bound for a host that never reaches it, and it
        # is a refusal because "started, ran too long, changed nothing" is an
        # answer about the edit rather than a defect here.
        return (1, "", "the platform's host did not finish within %g seconds, and was stopped. "
                       "Nothing has been published." % bound)
    return (completed.returncode,
            completed.stdout.decode("utf-8", "replace"),
            completed.stderr.decode("utf-8", "replace"))


def host_refusal(outcome, project):
    """What a host that exited non-zero said, as a value the caller can read.

    Nothing the host refuses is a defect in this program: it is a project that
    would not open, an edit the platform would not accept, a document addressed
    to another revision.  Every one of those is the caller's to fix, so every one
    of them is a refusal rather than a thrown error -- which is the split the
    module docstring draws.  The reasons a host CANNOT be run at all (no
    interpreter, no library) do not arrive here; they raise.
    """
    code, _, stderr = outcome
    detail = stderr.strip() or "the platform's host exited %d without saying why" % code
    return {"ok": False, "refused": detail, "project": str(project)}


def resolve_under(workspace, path):
    """A path as the caller meant it: relative to the SESSION's workspace."""
    if workspace is None:
        return Path(path)
    candidate = Path(path)
    return candidate if candidate.is_absolute() else Path(workspace) / candidate


def document_path(project, workspace, named):
    """Where the review document goes.

    Named explicitly wins.  Otherwise it lands BESIDE THE PROJECT, under its own
    stem.  That is not merely the tidy place: it is the one location that cannot
    fail for a reason unrelated to the edit.  Whoever may write the project may
    write next to it, whereas a fixed subdirectory has to be created and can be
    refused by a read-only parent or by a sandbox that grants one level and not
    two -- which is the failure already measured against a nested temporary
    directory in AlgorithmBridge's bridge.py.  It is also where a reviewer looks.
    """
    if named:
        return resolve_under(workspace, named)
    return resolve_under(workspace, project).with_suffix(DELTA_SUFFIX)


def relative_to_workspace(path, workspace):
    """The path as the caller would name it again, or the absolute one."""
    if not workspace:
        return str(path)
    try:
        return str(Path(path).resolve().relative_to(Path(workspace).resolve()))
    except ValueError:
        return str(path)


def isInlineDocument(source):
    """Whether a caller handed the document's TEXT rather than a path to it.

    The same sniff `Delta.open` makes, and it has to be made here too: a path
    that does not exist is a refusal worth naming, while JSON text is never
    expected to be a file.  `open_delta` answers FileNotFoundError for the first
    case, which is not a sentence about what the caller typed.
    """
    if isinstance(source, (bytes, bytearray)):
        return bytes(source).lstrip()[:1] == b"{"
    return isinstance(source, str) and source.lstrip().startswith("{")


def describe_document(opened):
    """What a document says it does, named resource by resource.

    READING THE ARTIFACT RATHER THAN REMEMBERING THE EDIT is the point, and this
    is where that stops being a slogan: every id below is read out of the bytes
    the caller is being asked to approve, so a document that did not carry what
    the edit intended reports the difference instead of hiding it.

    Ids rather than counts, unlike the edit verbs' own answer.  The two are for
    different readers: an edit's result is a summary that points at a document,
    and this is the detail a person reads before saying yes to it.  "2 surfaces"
    is not something anyone can approve.
    """
    info = opened.info
    document = json.loads(opened.json())
    replaces = []
    for name in REPLACED_ARRAYS:
        for entry in document.get(name) or []:
            replaces.append({"kind": name, "id": entry.get("id", "")})
    for patch in document.get("attribute_patches") or []:
        # A column patch names its column and edits rows in place, so it has no
        # `id` of its own -- the column is what the edit is about.
        replaces.append({"kind": "attribute_patches", "id": patch.get("column_id", "")})
    if document.get("has_external_payloads"):
        replaces.append({"kind": "external_payloads", "id": ""})
    erases = [{"type": ERASED_TYPE_NAMES.get(entry.get("type"), str(entry.get("type"))),
               "id": entry.get("id", "")}
              for entry in document.get("erased") or []]
    return {
        "project_id": opened.project_id,
        "base_revision": info.base_revision,
        "delta_version": info.delta_version,
        "contract_schema_version": info.contract_schema_version,
        "replaces": replaces,
        "erases": erases,
    }


def digest(path):
    """The same description, for a document this program just wrote.

    ONE DESCRIPTION, TWO CALLERS.  An edit's answer and the document tool's answer
    are the same facts about the same file, so they are produced by the same
    function -- a second reading of the same bytes would be a second place for
    "what this document does" to be decided.
    """
    import iam

    with iam.open_delta(path) as opened:
        return describe_document(opened)


def written_document(path, project, workspace, outcome, extra):
    """The answer both edit verbs give: a document, and nothing published."""
    if outcome[0] != 0:
        return host_refusal(outcome, project)
    if not Path(path).is_file():
        raise RuntimeError("the host exited 0 without writing %s" % path)
    # The workspace, not the process's directory: a caller who named a relative
    # project meant the session's, and resolving it against wherever this
    # interpreter happens to have been started would report a path that is not
    # the file that was read.
    result = {"ok": True, "project": str(resolve_under(workspace, project).resolve()),
              "container": container_of(project),
              "document": relative_to_workspace(path, workspace),
              "document_absolute": str(Path(path).resolve())}
    result.update(digest(path))
    result.update(extra)
    # Said in the answer rather than left to be worked out: the whole point of
    # the first half of the door is that it changes nothing.
    result["nothing_published"] = (
        "The project is untouched, still at revision %s. iam_mine_apply publishes this "
        "document as the next revision." % result["base_revision"])
    return result


# --------------------------------------------------------------------------
# The read half.
# --------------------------------------------------------------------------


def verb_resolve(options):
    """Which of the named elements this project really has."""
    import iam
    from iam import _abi as abi

    workspace = Path(options.workspace) if options.workspace else None
    project = Path(options.project) if workspace is None else Path(options.workspace) / options.project
    if not project.is_file():
        raise Refused("no such project: %s" % project)

    port = iam.open(project)
    try:
        features = set(port.ids(abi.ELEMENT_FEATURE))
        elements = []
        for element_id in options.element or ():
            if element_id not in features:
                # NOT dropped quietly.  A caller that named four elements and got
                # three drawn has no way to tell whether the fourth was never
                # there or was lost on the way -- and the view, told to show
                # something that does not exist, would draw an empty scene with
                # nothing saying why.
                raise Refused("no element %r in %s" % (element_id, project.name))
            try:
                metadata = port.element_metadata(element_id)
            except iam.IamError:
                metadata = ""
            elements.append({
                "id": element_id,
                "name": port.element_name(element_id),
                "metadata": metadata,
                "geometry_ids": port.element_geometry_ids(element_id),
            })
        return {
            "ok": True,
            "project": str(project),
            "container": container_of(project),
            "project_id": port.project_id,
            "revision": port.revision,
            "elements": elements,
            "counts": {"elements": len(elements),
                       "geometry": sum(len(element["geometry_ids"]) for element in elements)},
        }
    finally:
        port.close()


# --------------------------------------------------------------------------
# The write door: two ways to produce a document, one way to publish it.
# --------------------------------------------------------------------------


def edit_arguments(options):
    """The argv that produces a document without publishing it.

    `--emit-delta` is the platform's own review gate and is what makes "the edit
    did not happen yet" a fact about the file system rather than a promise: the
    host returns before the commit, and what is left behind is a document.
    """
    host_arguments = []
    document = document_path(options.project, options.workspace, options.document)
    document.parent.mkdir(parents=True, exist_ok=True)
    host_arguments += ["--in", str(resolve_under(options.workspace, options.project)),
                       "--emit-delta", str(document)]
    if options.timeout_seconds is not None:
        host_arguments += ["--timeout", str(options.timeout_seconds)]
    if options.max_delta_bytes is not None:
        host_arguments += ["--max-delta-bytes", str(options.max_delta_bytes)]
    return host_arguments, document


def verb_edit(options):
    """A declarative edit, written as a document.  Nothing is published.

    The description is one JSON string because a verb is handed its parameters as
    `--arg key=value` and has no other channel; see apply_edit.py, which is where
    the description is turned into the port's own write primitives.
    """
    try:
        json.loads(options.edit)
    except ValueError as error:
        # Refused here rather than by the verb, so the message names the flag the
        # caller actually used instead of an --arg they never typed.
        raise Refused("the edit is not valid JSON: %s" % error) from error
    plugin = Path(__file__).with_name("apply_edit.py")
    if not plugin.is_file():
        raise RuntimeError("this package is incomplete: %s is missing" % plugin)
    arguments, document = edit_arguments(options)
    # The edit is a document, not a command line: a real surface runs far past
    # the OS argv limit (32767 characters on Windows).  The host reads the file
    # while it runs; it is removed when the run is over.
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", suffix=".edit.json", delete=False)
    try:
        handle.write(options.edit)
        handle.close()
        arguments = ["--plugin", str(plugin)] + arguments + ["--arg", "edit_file=%s" % handle.name]
        outcome = run_host(arguments, timeout_seconds=options.timeout_seconds)
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
    return written_document(document, options.project, options.workspace, outcome,
                            {"edit_plugin": plugin.name})


def verb_verb(options):
    """A `run(port)` verb, written as a document.  Nothing is published.

    This is where a computed edit lives -- "place a section every 20 m along that
    centreline" is not something a payload can say.  It is code the session
    wrote, so it runs under the programRunner policy (see program_command), and
    what it is handed is a WRITE PORT rather than the read-only snapshot
    `iam_program_run` gives.
    """
    if not options.code.strip():
        raise Refused("the verb is empty")
    verb = Path(options.code_file)
    verb.write_text(options.code, encoding="utf-8")
    try:
        arguments, document = edit_arguments(options)
        arguments = ["--plugin", str(verb)] + arguments
        for pair in options.argument or ():
            arguments += ["--arg", pair]
        # No outer deadline by default: the host's own `--timeout` is the one that
        # wraps the verb, and a second bound here would be a second answer to the
        # same question, firing at a moment nobody chose.
        outcome = run_host(arguments, sandbox=True, timeout_seconds=options.timeout_seconds,
                           workspace=options.workspace)
        return written_document(document, options.project, options.workspace,
                                outcome, {"verb": str(verb.name)})
    finally:
        # Best effort, and a run that produced an answer is not turned into a
        # failure by a sandbox that refuses the removal -- see bridge.py, where
        # the same hazard was measured against the Windows workspace-write grant.
        try:
            verb.unlink()
        except OSError:
            pass


def verb_document(options):
    """Reads a review document.  Needs no project, and changes nothing.

    A DOCUMENT IS ADDRESSED TO A PROJECT, NOT READ FROM ONE.  The first question
    about an edit someone handed you is whether it is for the mine you have --
    and its header answers that without opening either.  So this verb takes no
    `--project`, which is also what lets an edit be reviewed before anyone
    decides which mine it lands on.

    `--resources` adds the document's own JSON, so a reviewer sees WHAT changes
    rather than only which resources do.  It is bounded, and says so when the
    bound is what stopped it: a re-uploaded shell is megabytes of coordinates and
    truncating that would produce JSON nobody can parse.
    """
    source = options.document
    if not isInlineDocument(source):
        resolved = resolve_under(options.workspace, source)
        if not resolved.is_file():
            raise Refused("no such document: %s" % resolved)
        source = resolved

    import iam

    with iam.open_delta(source) as opened:
        described = describe_document(opened)
        text = opened.json()

    described["ok"] = True
    described["document"] = ("<the JSON that was passed in>" if isInlineDocument(source)
                             else relative_to_workspace(source, options.workspace))
    described["bytes"] = len(text.encode("utf-8"))
    described["nothing_published"] = (
        "Reading a document changes nothing. iam_mine_apply publishes it as the next "
        "revision of %s, which is at revision %s." % (described["project_id"], described["base_revision"]))
    if options.resources:
        if described["bytes"] > DOCUMENT_JSON_LIMIT_BYTES:
            described["resources_omitted"] = (
                "The document is %d bytes, past the %d this answer carries; its JSON was not "
                "included. It is at %s and reads with iam.open_delta(...).json()."
                % (described["bytes"], DOCUMENT_JSON_LIMIT_BYTES, described["document"]))
        else:
            described["resources"] = json.loads(text)
    return described


def verb_apply(options):
    """Publishes one document as one revision, in place unless told otherwise.

    The revision check is the platform's, not this file's: a document names the
    project and the revision it was written against, and one addressed elsewhere
    is refused with both revisions named.  `out` defaults to the project itself,
    so the ordinary case is "the mine now has the change" rather than "a second
    file exists".
    """
    document = resolve_under(options.workspace, options.document)
    if not document.is_file():
        raise Refused("no such document: %s" % document)
    project = resolve_under(options.workspace, options.project)
    target = resolve_under(options.workspace, options.out) if options.out else project

    arguments = ["--delta", str(document), "--in", str(project), "--out", str(target)]
    outcome = run_host(arguments)
    if outcome[0] != 0:
        return host_refusal(outcome, options.project)

    # READ BACK rather than assume.  "revision + 1" is the platform's rule and
    # asserting it here would be a second statement of it; opening what was
    # written is also the only thing that proves the write landed, which for an
    # in-place overwrite is the question that matters.
    import iam

    port = iam.open(target)
    try:
        return {
            "ok": True,
            "project": str(project.resolve()),
            "container": container_of(target),
            "out": str(target.resolve()),
            "in_place": target.resolve() == project.resolve(),
            "project_id": port.project_id,
            "revision": port.revision,
        }
    finally:
        port.close()


# --------------------------------------------------------------------------


def main(argv=None):
    pin_utf8()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    verbs = parser.add_subparsers(dest="verb", required=True)

    resolve = verbs.add_parser("resolve", help="which of the named elements a project really has")
    resolve.add_argument("--project", required=True, help="the source .iam or .iamh")
    resolve.add_argument("--element", action="append", default=[],
                         help="a semantic element id; repeatable")
    resolve.add_argument("--workspace", default=None,
                         help="the workspace a relative --project is resolved against")
    resolve.set_defaults(handler=verb_resolve)

    def add_shared(sub):
        sub.add_argument("--project", required=True, help="the project to edit")
        sub.add_argument("--workspace", default=None,
                         help="the workspace relative paths are resolved against")
        # The two caps the host imposes on a verb, passed through rather than
        # re-decided: a plugin that cannot be stopped, or that can grow an edit
        # without bound, is not one a host can run on someone else's behalf.
        sub.add_argument("--timeout-seconds", type=float, default=None, dest="timeout_seconds",
                         help="stop the edit after this long; the host's own default otherwise")
        sub.add_argument("--max-delta-bytes", type=int, default=None, dest="max_delta_bytes",
                         help="refuse the edit past this retained size; the host's default otherwise")

    edit = verbs.add_parser("edit", help="apply a declarative edit; publishes nothing")
    add_shared(edit)
    edit.add_argument("--edit", required=True,
                      help='the edit, as JSON: {"put": .., "attach": .., "erase": ..}')
    edit.add_argument("--document", default=None,
                      help="where the review document goes; defaults to .iax/deltas/<project>.iaxd")
    edit.set_defaults(handler=verb_edit)

    verb = verbs.add_parser("verb", help="run a run(port) verb; publishes nothing")
    add_shared(verb)
    verb.add_argument("--code", required=True, help="the verb's source, defining run(port)")
    verb.add_argument("--code-file", default=None, help="where to stage it; a temporary file by default")
    verb.add_argument("--argument", action="append", default=[],
                      help="an argument for the verb, as key=value; repeatable")
    verb.add_argument("--document", default=None, help="where the review document goes")
    verb.set_defaults(handler=verb_verb)

    document = verbs.add_parser("document", help="read a review document; needs no project")
    document.add_argument("--document", required=True, help="the .iaxd, or its JSON")
    document.add_argument("--workspace", default=None,
                          help="the workspace a relative --document is resolved against")
    document.add_argument("--resources", action="store_true",
                          help="include the document's own JSON, when it fits")
    document.set_defaults(handler=verb_document)

    apply_ = verbs.add_parser("apply", help="apply a document as one revision")
    apply_.add_argument("--project", required=True, help="the project the document is addressed to")
    apply_.add_argument("--document", required=True, help="the .iaxd, or its JSON")
    apply_.add_argument("--out", default=None,
                        help="where the new revision goes; the project itself by default")
    apply_.add_argument("--workspace", default=None)
    apply_.set_defaults(handler=verb_apply)

    options = parser.parse_args(argv)
    if getattr(options, "code_file", None) is None and options.verb == "verb":
        import tempfile
        handle, name = tempfile.mkstemp(prefix="iam-verb-", suffix=".py")
        os.close(handle)
        options.code_file = name
    try:
        return emit(options.handler(options))
    except Refused as refusal:
        # A value, not an error: see the module docstring.  The project is echoed
        # only for the verbs that have one -- reading a document is the one that
        # does not, because a document is addressed to a project rather than read
        # from one.
        answer = {"ok": False, "refused": str(refusal)}
        if getattr(options, "project", None) is not None:
            answer["project"] = options.project
        return emit(answer)
    except Exception as error:  # noqa: BLE001 - the exit code is the contract
        return fail("%s: %s" % (type(error).__name__, error))


if __name__ == "__main__":
    raise SystemExit(main())
