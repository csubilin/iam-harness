#!/usr/bin/env python3
"""{{title}} ({{capability}}).

THE SKELETON IS RUNNABLE ON PURPOSE.  A capability is a program, and a program
that only exists as prose is a program nobody has run.  This one reads the step
contract from the manifest beside it, runs only the steps the caller selected,
and writes a result.json with every field `schemas/result.schema.json` names.

WHY STEPS ARE DATA.  The same transaction is not always needed in full.  A
caller that already has an accepted `compute` product should be able to run
`summarize` alone; a caller that only needs the input facts should be able to
run `read` and stop.  The manifest's `steps[].id` is the name a caller selects,
`requires` says what must already exist, and `run.steps` in the result says what
actually ran.  A skipped prerequisite is never run silently: if its output is
neither selected nor carried by `resume`, the workflow refuses and names it.

WHAT TO PUT WHERE:
  * a number belongs in `result.json` with its raw value and its unit;
  * a decision or a refusal belongs in `verdicts`/`warnings`, with the
    algorithm's own words when it refused;
  * a file the run wrote belongs in `artifacts`, with its sha256 and the step
    that produced it;
  * a parameter that cannot be inferred belongs in the manifest's `inputs`,
    and the run refuses without it -- never a default.

The platform's Python packages are imported inside the step implementations,
not at module import: `--help` and `py_compile` must work in an environment
where the native build is absent, and a missing build should fail the run
rather than the import.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

CAPABILITY = "{{capability}}"
VERSION = "{{version}}"

# The template's step implementations.  A manifest should name these ids; an id
# with no implementation is refused at the start rather than silently skipped.
IMPLEMENTED = ("read", "compute", "summarize")


class WorkflowError(RuntimeError):
    """The request cannot be answered with the data it supplied."""


def _stamp():
    """A run stamp fine enough that two runs in one second do not collide."""
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest():
    """The manifest beside this program, the source of the step and input contract.

    THE MANIFEST IS THE SOURCE OF TRUTH, not a second copy in this file.  A step
    added to the manifest and not implemented here is caught by `_declared_steps`;
    a required input renamed in one place and not the other is caught before the
    first source is opened, because `run` reads its names from this document.
    """
    manifest_path = Path(__file__).with_name("manifest.json")
    if not manifest_path.is_file():
        raise WorkflowError("the workflow has no manifest.json beside it; the step "
                            "contract cannot be read")
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise WorkflowError("the manifest beside the workflow cannot be read: %s" % error)
    if not isinstance(document, dict):
        raise WorkflowError("the manifest beside the workflow must be a JSON object")
    return document


def _declared_steps(document):
    steps = document.get("steps")
    if not isinstance(steps, list) or not steps:
        raise WorkflowError("the manifest declares no steps; a capability without "
                            "one is not a procedure")
    for position, step in enumerate(steps, 1):
        if not isinstance(step, dict) or not isinstance(step.get("id"), str):
            raise WorkflowError("manifest.steps[%d] has no id" % position)
    unknown = [step["id"] for step in steps if step["id"] not in IMPLEMENTED]
    if unknown:
        raise WorkflowError("the manifest names step(s) this program does not implement: %s"
                            % ", ".join(unknown))
    return steps


def _required_inputs(document):
    """The required inputs, by the names the manifest gives them.

    A SKELETON MUST NOT INVENT A DEFAULT.  The first required `path` and the
    first required `enum` are the two values the template's step bodies use;
    every other required input is still demanded, because the manifest says it
    is required, and recorded in the result.  A missing one is a WorkflowError
    naming it -- the bridge asks for the ones marked `why_not_inferred`, and the
    workflow refuses the rest rather than silently substituting a value.
    """
    inputs = document.get("inputs")
    required = inputs.get("required") if isinstance(inputs, dict) else None
    declared = [item for item in required or []
                if isinstance(item, dict) and isinstance(item.get("name"), str)
                and item["name"]]
    return declared


def _selection(value, identifiers):
    """The requested steps, in manifest order, or a refusal naming the unknown ones."""
    if value is None:
        return list(identifiers)
    if isinstance(value, str):
        requested = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, (list, tuple)):
        requested = [str(item) for item in value if str(item)]
    else:
        raise WorkflowError("steps must be a list of step ids or a comma-separated string")
    unknown = [item for item in requested if item not in identifiers]
    if unknown:
        raise WorkflowError("unknown step(s): %s; this capability has %s"
                            % (", ".join(unknown), ", ".join(identifiers)))
    selected = set(requested)
    ordered = [identifier for identifier in identifiers if identifier in selected]
    if not ordered:
        raise WorkflowError("select at least one step; an empty selection has nothing to do")
    return ordered


def _resume_state(path, declared):
    """The outputs a previous result carries, and the steps that produced them.

    A skipped step counts as satisfied only when the previous result SAYS it ran
    and still carries the fields it produces.  Merely having a `solids` key is
    not enough: a partial result that skipped `compute` has an empty list there,
    and treating that as a computed product would be the silent full-run this
    contract exists to prevent.
    """
    if path is None:
        return {}, set()
    try:
        previous = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise WorkflowError("resume result cannot be read at %s: %s" % (path, error))
    if not isinstance(previous, dict):
        raise WorkflowError("resume result must be a JSON object")
    executed = set()
    run = previous.get("run")
    if isinstance(run, dict):
        steps = run.get("steps")
        if isinstance(steps, dict) and isinstance(steps.get("executed"), list):
            executed = {str(item) for item in steps["executed"]}
    state = {}
    resumed = set()
    for step in declared:
        fields = step.get("produces") or []
        # No declared products, no resumption: a side-effect-only step cannot be
        # carried by a JSON result, so a later step requiring it must select it.
        if fields and step["id"] in executed and all(field in previous for field in fields):
            for field in fields:
                state[field] = previous[field]
            resumed.add(step["id"])
    return state, resumed


def _execute(identifier, state, source, mode):
    """One step's work.  Replace the bodies; keep the ids and the state keys."""
    if identifier == "read":
        # TODO: parse the input.  These two facts are always available.
        state["facts"] = {
            "input_bytes": source.stat().st_size,
            "input_sha256": _sha256(source),
            "mode": mode,
        }
    elif identifier == "compute":
        # TODO: call the platform (`import iam`, `import iam_algorithms`) here.
        # A refusal is a WorkflowError with the algorithm's own message, never a
        # retry with a guessed unit or a widened tolerance.
        state["solids"] = []
        state["metrics"] = {}
    elif identifier == "summarize":
        # TODO: turn the computed values into verdicts.  Every threshold belongs
        # to the manifest's acceptance_checks, not to a sentence in this file.
        state["verdicts"] = []
    else:                                   # _declared_steps() already refused this
        raise WorkflowError("no implementation for step %r" % identifier)


def _destination(out):
    if out:
        return Path(out)
    # D13: products live under out/<capability>/<run-id>/.  A standalone run has
    # no run id yet, so it uses one directory per invocation; a frozen workflow
    # should pass the id it records in result.run.id.
    root = Path(os.environ.get("IAX_EXECUTION_WORKSPACE", "."))
    return root / "out" / CAPABILITY / _stamp() / "result.json"


def run(input=None, mode=None, steps=None, resume=None, out=None, log=None, **extra):
    """Run the selected steps and write result.json.

    `input` is a path, `mode` is one of the manifest's enum choices, `steps`
    selects a subset of the manifest's step ids, and `resume` is an earlier
    result whose executed-step products may stand in for skipped prerequisites.
    The first two are required by the manifest; `steps` and `resume` are the
    partial-execution seam and are optional.

    A STAGE NAMES ITS OWN INPUTS: ingest uses `source`/`format`, model uses
    `input`/`mode`, report uses `result`/`format`.  The manifest names them; the
    bridge calls `run` with those names, so they arrive in `**extra`.  `input`
    and `mode` are only the standalone CLI's names for the first required path
    and the first required enum.  A required input that was not supplied is
    refused; it is never replaced by a default.
    """
    started_clock = time.monotonic()
    started = datetime.now().astimezone().isoformat(timespec="seconds")
    document = _manifest()
    declared = _declared_steps(document)
    required = _required_inputs(document)
    provided = dict(extra)
    path_inputs = [item for item in required if item.get("kind") == "path"]
    enum_inputs = [item for item in required if item.get("kind") == "enum"]
    if input is not None and path_inputs:
        provided.setdefault(path_inputs[0]["name"], input)
    if mode is not None and enum_inputs:
        provided.setdefault(enum_inputs[0]["name"], mode)

    # A REQUIRED INPUT THAT WAS NOT SUPPLIED IS A REFUSAL.  The manifest is the
    # contract; substituting "default" here would be exactly the invented value
    # the platform forbids, and for an ingest workflow "default" is not even one
    # of the declared choices.
    for item in required:
        name = item["name"]
        value = provided.get(name)
        if value is None or value == "":
            raise WorkflowError("the manifest requires %r; refusing to invent a value"
                                % name)

    if not path_inputs:
        raise WorkflowError("this skeleton needs a required input of kind path; the "
                            "manifest declares none")
    for item in path_inputs:
        value = provided[item["name"]]
        if not isinstance(value, str) or not value.strip():
            raise WorkflowError("%r must be a file path; got %r" % (item["name"], value))
    for item in enum_inputs:
        choices = item.get("choices")
        value = provided[item["name"]]
        if isinstance(choices, list) and value not in choices:
            raise WorkflowError("%r is not one of the choices for %r: %s"
                                % (value, item["name"], ", ".join(map(str, choices))))
    if resume is not None and not isinstance(resume, str):
        raise WorkflowError("resume must be a path to an earlier result.json")

    source_name = path_inputs[0]["name"]
    source = Path(provided[source_name])
    if not source.is_file():
        raise WorkflowError("input %s does not exist; refusing rather than guessing "
                            "another file" % source)
    mode_name = enum_inputs[0]["name"] if enum_inputs else None
    mode_value = provided.get(mode_name) if mode_name else None

    result_inputs = {}
    for item in path_inputs:
        path = Path(provided[item["name"]])
        if not path.is_file():
            raise WorkflowError("input %s does not exist; refusing rather than guessing "
                                "another file" % path)
        result_inputs[item["name"]] = {"path": str(path), "sha256": _sha256(path)}
    parameters = {item["name"]: provided[item["name"]]
                  for item in required if item.get("kind") != "path"}

    identifiers = [step["id"] for step in declared]
    requested = _selection(steps, identifiers)
    state, resumed = _resume_state(resume, declared)
    executed, skipped = [], []
    for step in declared:
        identifier = step["id"]
        if identifier not in requested:
            skipped.append(identifier)
            continue
        missing = [requirement for requirement in (step.get("requires") or [])
                   if requirement not in executed and requirement not in resumed]
        if missing:
            raise WorkflowError(
                "step %r requires %s, which was neither selected nor carried by the "
                "resume result; select it too or pass --resume with a result that "
                "ran it" % (identifier, ", ".join(missing)))
        _execute(identifier, state, source, mode_value)
        executed.append(identifier)

    result = {
        "schema": "iax.capability.result/1",
        "capability": CAPABILITY,
        "version": VERSION,
        "run": {
            "id": "run-" + _stamp(),
            "started": started,
            "duration_s": None,
            "steps": {"requested": requested, "executed": executed, "skipped": skipped},
        },
        "inputs": result_inputs,
        "parameters": {
            **parameters,
            "steps": requested,
            "resume": str(resume) if resume else None,
        },
        "units": {"length": "m", "volume": "m3", "mass": "t", "unit_to_meters": 1.0},
        "frame": {"label": "unset", "origin": [0, 0, 0], "rotation_deg": [0, 0, 0]},
        "versions": {
            "platform": "",
            "catalog": None,
            "algorithm": None,
            "abi": None,
            "python": sys.version.split()[0],
        },
        "facts": state.get("facts", {}),
        "solids": state.get("solids", []),
        "metrics": state.get("metrics", {}),
        "verdicts": state.get("verdicts", []),
        "artifacts": [],
        "warnings": ["skeleton: replace the computation and these placeholders"],
    }
    if resume:
        result["inputs"]["resume"] = {"path": str(resume), "sha256": _sha256(resume)}
    if skipped:
        result["warnings"].append(
            "partial run: skipped %s; the result is not a full run" % ", ".join(skipped))
    result["run"]["duration_s"] = round(time.monotonic() - started_clock, 3)

    destination = _destination(out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # THE PATH IS IN THE RESULT, NOT PRINTED HERE.  When this program runs as a
    # frozen workflow, the bridge's driver calls `run()` and expects stdout to
    # carry exactly one JSON object; a stray print is a JSON decode error on a
    # document that is otherwise valid.  The CLI prints the path after `run()`.
    result["run"]["result_path"] = str(destination)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    if log is not None:
        log("wrote %s (steps: %s)" % (destination, ", ".join(executed)))
    return result


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description="%s: run the selected steps and write a result.json." % CAPABILITY)
    parser.add_argument("--input", required=True,
                        help="the first required path input named by the manifest")
    parser.add_argument("--mode", default=None,
                        help="the first required enum input named by the manifest; "
                             "required when the manifest declares one, and checked "
                             "against its choices")
    parser.add_argument("--steps", default=None,
                        help="comma-separated step ids; omit to run them all")
    parser.add_argument("--resume", default=None,
                        help="a previous result.json whose executed steps may satisfy "
                             "the selected steps' requirements")
    parser.add_argument("--out", default=None,
                        help="where result.json goes; default out/<capability>/<stamp>/")
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)
    try:
        result = run(arguments.input, arguments.mode, arguments.steps, arguments.resume,
                     arguments.out, log=lambda message: print(message, file=sys.stderr))
    except WorkflowError as refusal:
        print("workflow refused: %s" % refusal, file=sys.stderr)
        return 1
    print(result["run"]["result_path"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
