#!/usr/bin/env python3
"""The CapabilityForge's Python half: candidates, scaffold, validate, freeze, audit.

A WORKSHOP, NOT A RUNNER.  This program writes, checks and records capability
packages; it never executes one.  Execution stays with `iam_workflow_run` in the
AlgorithmBridge, because a second runner would be a second fact source about
what a capability is and what it did -- the exact defect the capability format
exists to remove.

A CAPABILITY IS ALSO A PARTIAL-RUN CONTRACT.  A frozen workflow's manifest may
declare step ids and their backward-only requirements, plus the reserved
`steps` and `resume` inputs; the workflow then runs only the selected steps and
refuses when a skipped prerequisite's output is neither selected nor carried by
a resume result.  The forge validates that contract; it does not implement it.

Every subcommand prints exactly one JSON object to stdout (ASCII-escaped, so a
Windows console with a non-UTF-8 code page cannot mangle it) and its human
summary to stderr.  Exit codes are the contract the host half reads:

    0   the command answered, and the answer may still say `ok: false`
    1   the request was understood and refused (a contract did not hold)
    2   the command could not be attempted (bad usage, no bridge, no Python)

That split is imported from AlgorithmBridge/README.md, where it is called
"values are values, not envelopes": a refusal is something a model reads and
acts on, and only "could not be attempted" is an error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = PACKAGE_ROOT.parent
PLATFORM_ROOT = PACKAGE_ROOT.parents[2]
SCHEMAS = PACKAGE_ROOT / "schemas"
TEMPLATES = PACKAGE_ROOT / "templates"
BRIDGE = Path(os.environ.get("IAM_CAPABILITY_BRIDGE")
              or (PLUGIN_ROOT / "AlgorithmBridge" / "python" / "bridge.py")).resolve()

# ASCII IS NOT A LANGUAGE REQUIREMENT.  A capability is addressed by a directory
# name, and a Chinese directory name is ordinary on every platform this runs on.
# What the address must not contain is a path separator or a dot (the lock and
# spec files are `<name>.<kind>.json`), so the class is Han, Latin, digits and
# underscore, with hyphens after the first character.  FIELD NAMES stay English:
# they are contract keys, not prose.
HAN = "㐀-䶿一-鿿"
NAME_CHARACTERS = "A-Za-z0-9_" + HAN
CAPABILITY_NAME = re.compile(r"[%s][%s-]{1,63}" % (NAME_CHARACTERS, NAME_CHARACTERS))
STEP_ID = re.compile(r"[%s][%s-]*" % (NAME_CHARACTERS, NAME_CHARACTERS))
SEMVER = re.compile(r"(\d+)\.(\d+)\.(\d+)")
STAGES = ("ingest", "model", "report")
# The controlled input vocabulary.  A free-text kind is what made "resource id"
# and "resource-id" two different declarations of one thing; the validator can
# only enforce a closed set, so the set is closed.
INPUT_KINDS = ("path", "resource-id", "enum", "number", "list", "material-label", "boolean")
RESERVED_MANIFEST_KEYS = ("workflow_version", "name", "entry", "provenance",
                          "source_sha256", "confirmed_from_run")

# A scaffold is a DRAFT with questions in it.  `TODO:` is the machine-visible
# marker a reader can also see; the sentences below are what the first templates
# shipped, kept so an already-generated package is recognized without a
# migration.  Freezing either form would write "not known yet" into a contract.
PLACEHOLDER_PREFIX = "TODO:"
PLACEHOLDER_SENTENCES = frozenset({
    "说明这个能力回答什么问题。一句话，让人能从列表里选中它。",
    "这个能力要读的文件。",
    "打不开，或内容不是这个名字所说的那种数据。",
    "处理口径。两个候选分别对应什么，由实现写清。",
    "不在 choices 里就拒绝，不退回 default。",
    "读输入，并把数据自带的事实（大小、哈希、可读出的计数）写进 facts。",
    "计算。所有数值以原始值与单位写进 result.json，不写格式化后的字符串。",
    "汇总 verdicts/warnings；只跑这一步时，compute 的产物必须由 resume 提供。",
    "结果里的每个数值都能在 result.json 找到出处。",
    "每个产物的 bytes 与 sha256 都记录在 result.json.artifacts 里。",
    "推不出来的参数由人给；缺参数时拒绝并说明，不给默认值。",
    "只跑选中的步骤；跳过的步骤不会被当成已执行，先决输出缺失时拒绝而不是静默补跑。",
})

# A stage is not a suffix on a form: each one asks for different data and answers
# a different question.  The scaffold writes these names/choices and a TODO for
# the prose; the user replaces the prose, not the shape.
STAGE_ANSWERS = {
    "ingest": "把原始上传/图纸规范化为建模可读的数据，并记录源哈希。 / Normalize raw "
              "uploads/drawings into data the modeller can read, and record the source hash.",
    "model": "从规范化数据构建可用实体，并报告未构建的原因。 / Build usable entities "
             "from the normalized data and report what could not be built and why.",
    "report": "从 result.json 生成可追溯的报告与图册。 / Generate a traceable report and "
              "figure set from result.json.",
}
STAGE_INPUTS = {
    "ingest": [
        {"name": "source", "kind": "path",
         "means": "TODO: 原始数据文件放在哪里、接受哪些格式。 / Where the raw data file "
                  "is, and which formats it accepts.",
         "refused_when": "TODO: 打不开或格式无法识别时拒绝。 / Refuse when it cannot be "
                         "opened or the format cannot be recognized.",
         "why_not_inferred": "工作区里可能不止一份原始数据；选哪一份是使用者的决定，不是平台的。 / "
                             "The workspace may hold more than one raw dataset; which one is "
                             "the user's decision, not the platform's."},
        {"name": "format", "kind": "enum", "choices": ["auto", "dimine"],
         "means": "TODO: 输入格式；auto 的判定规则由实现写清。 / Input format; the "
                  "implementation must state how auto is decided.",
         "refused_when": "不在 choices 里就拒绝。 / Refuse when it is not one of the choices.",
         "why_not_inferred": "auto 与 dimine 的选择取决于数据来源；平台不能只凭文件内容可靠判断。 / "
                             "The choice between auto and dimine depends on the data source; "
                             "the platform cannot decide reliably from file content alone."},
    ],
    "model": [
        {"name": "input", "kind": "path",
         "means": "TODO: ingest 产出的规范化数据。 / Normalized data produced by ingest.",
         "refused_when": "TODO: 打不开或不是这个阶段的数据。 / Refuse when it cannot be "
                         "opened or is not this stage's data.",
         "why_not_inferred": "ingest 可能产出多份规范化数据；选哪一份进入模型是使用者的决定。 / "
                             "Ingest may produce several normalized datasets; which one "
                             "enters the model is the user's decision."},
        {"name": "mode", "kind": "enum", "choices": ["default", "strict"],
         "means": "TODO: 处理口径。 / Processing policy.",
         "refused_when": "不在 choices 里就拒绝。 / Refuse when it is not one of the choices.",
         "why_not_inferred": "default 与 strict 是使用者的处理口径；平台不替人选择。 / "
                             "default and strict are the user's processing policy; the "
                             "platform does not choose for them."},
    ],
    "report": [
        {"name": "result", "kind": "path",
         "means": "TODO: model 产出的 result.json。 / The result.json produced by model.",
         "refused_when": "TODO: schema 不匹配或 verdicts 缺失。 / Refuse when the schema "
                         "does not match or verdicts are missing.",
         "why_not_inferred": "一个工作区里可能有多份 result.json；报告针对哪一次结果是使用者的决定。 / "
                             "A workspace may hold several result.json files; which result "
                             "the report describes is the user's decision."},
        {"name": "format", "kind": "enum", "choices": ["docx", "pptx"],
         "means": "TODO: 报告格式。 / Report format.",
         "refused_when": "不在 choices 里就拒绝。 / Refuse when it is not one of the choices.",
         "why_not_inferred": "docx 与 pptx 取决于交付对象；平台不替人选择。 / docx or pptx "
                             "depends on the audience; the platform does not choose for the "
                             "user."},
    ],
}


STAGE_PLACEHOLDER_SENTENCES = frozenset(STAGE_ANSWERS.values()).union(
    item[field][len(PLACEHOLDER_PREFIX):].strip()
    for entries in STAGE_INPUTS.values()
    for item in entries
    for field in ("means", "refused_when")
    if isinstance(item.get(field), str) and item[field].startswith(PLACEHOLDER_PREFIX)
)


def _is_placeholder(value):
    if not isinstance(value, str):
        return False
    text = value.strip()
    # The old sentences are matched by prefix as well: a bilingual stage
    # placeholder is the old sentence with " / English" appended, and removing
    # only the TODO: prefix must not turn it into a real answer.
    return (text.startswith(PLACEHOLDER_PREFIX)
            or text in PLACEHOLDER_SENTENCES
            or text in STAGE_PLACEHOLDER_SENTENCES
            or any(text.startswith(sentence) for sentence in PLACEHOLDER_SENTENCES))


def emit(document, code=0):
    json.dump(document, sys.stdout, ensure_ascii=True, indent=2)
    sys.stdout.write("\n")
    return code


def fail(message, code=2, document=None):
    sys.stderr.write("capability-forge: %s\n" % message)
    if document is None:
        document = {"ok": False, "error": message}
    return emit(document, code)


def _finding(identifier, severity, where, message):
    return {"id": identifier, "severity": severity, "where": where, "message": message}


def _nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""


def _version_key(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def _sha256(path):
    """A file's full sha256, streamed.

    The lock's schema hashes are small, but audit hashes result artifacts, and
    an artifact can be hundreds of MiB. `read_bytes()` would hold the whole file
    in memory just to hash it.
    """
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_16(path):
    return _sha256(path)[:16]


def _source_sha256(path):
    """The hash of a PROGRAM, in the platform's convention.

    `run.json` and a frozen manifest record the hash of the source TEXT, not of
    the file's bytes: on Windows `write_text` stores CRLF while the bridge reads
    with universal newlines and hashes LF.  Hashing bytes here would call every
    frozen workflow on Windows modified -- measured, in the first end-to-end
    run of this forge.
    """
    return hashlib.sha256(Path(path).read_text(encoding="utf-8").encode("utf-8")).hexdigest()


def _inside(root, path):
    """True when `path` resolves inside `root`, symlinks included."""
    try:
        return Path(path).resolve().is_relative_to(Path(root).resolve())
    except OSError:
        return False


def workspace_of(value):
    """The workspace, resolved strictly: a scaffold cannot create it silently.

    A misspelt workspace is a request to write a capability somewhere the user
    did not choose.  Reporting it is the only answer that does not guess.
    """
    path = Path(value or os.getcwd())
    try:
        root = path.resolve(strict=True)
    except OSError as error:
        raise RuntimeError("the workspace %s does not exist: %s" % (path, error)) from error
    if not root.is_dir():
        raise RuntimeError("the workspace %s is not a directory" % root)
    return root


def _check_inside(root, path, what):
    if not _inside(root, path):
        raise RuntimeError("%s escapes the workspace: %s" % (what, path))
    return path


def _read_json(path, what):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("could not read %s at %s: %s" % (what, path, error)) from error


def _write_json(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _schema_file(value):
    """The schema file a manifest's `schema` value names, or None.

    The value is a contract name (`iax.capability.result/1`), not a filename, so
    the file is found by the last dotted segment before the version: result ->
    result.schema.json.  A caller may also write the filename directly, which is
    the spelling a human uses when pointing at this package.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    name = value.strip()
    if name.endswith(".json"):
        candidate = SCHEMAS / name
    else:
        base = name.rsplit("/", 1)[0] if "/" in name else name
        tail = base.rsplit(".", 1)[-1]
        candidate = SCHEMAS / (tail + ".schema.json")
    return candidate if candidate.is_file() else None


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _validate_steps(manifest, add):
    """The step contract: stable ids, backward-only requirements, a selectable set.

    A STEP IS SELECTABLE ONLY IF ITS IDENTITY AND ITS PREREQUISITES ARE DATA.
    `steps[].does` has always been prose for a human; execution needs something
    a caller can name.  The id is that name, and `requires` is what keeps a
    partial run honest: selecting the last step alone is allowed only when the
    earlier outputs are carried by a supplied resume result.  Without this, a
    partial run would either silently do less than asked or silently do more.

    REQUIREMENTS POINT BACKWARD.  The manifest's order is the execution order,
    so a requirement on a later or unknown step is a cycle expressed as a list;
    refusing it here is cheaper than discovering it one call into a run.
    """
    steps = manifest.get("steps")
    if not isinstance(steps, list):
        return
    inputs = manifest.get("inputs")
    declarations = []
    if isinstance(inputs, dict):
        for key in ("required", "optional"):
            if isinstance(inputs.get(key), list):
                declarations.extend((key, item) for item in inputs[key])
    declares_selection = any(isinstance(item, dict) and item.get("name") == "steps"
                             for _, item in declarations)
    # BACKWARD COMPATIBLE BY OPT-IN.  A manifest whose steps are still prose
    # (the example's original prose-step shape) is a full-run capability; it is not
    # forced to invent ids.  Declaring an id on any step, or the reserved
    # `steps` input, opts into the selectable contract, and then every step must
    # carry one -- a half-named list is a selection with no rule.
    if not (declares_selection or any(isinstance(step, dict) and "id" in step
                                       for step in steps)):
        return
    identifiers = []
    for position, step in enumerate(steps, 1):
        where = "manifest.steps[%d]" % position
        if not isinstance(step, dict):
            add(_finding("manifest.steps.id", "error", where,
                         "each step must be an object with an id"))
            continue
        identifier = step.get("id")
        if not _nonempty_string(identifier) or not STEP_ID.fullmatch(identifier):
            add(_finding("manifest.steps.id", "error", "%s.id" % where,
                         "a step id must start with a Han, Latin, digit or underscore "
                         "character and continue with those or '-' so a caller can name it"))
        elif identifier in identifiers:
            add(_finding("manifest.steps.id", "error", "%s.id" % where,
                         "step ids must be unique; a repeated id makes a selection "
                         "ambiguous"))
        else:
            identifiers.append(identifier)
        if "label" in step and not _nonempty_string(step.get("label")):
            add(_finding("manifest.steps.label", "error", "%s.label" % where,
                         "label must be a non-empty string when present; the id is what "
                         "a caller passes, the label is what a Chinese or English reader sees"))
        requires = step.get("requires", [])
        if requires is not None:
            if (not isinstance(requires, list)
                    or any(not _nonempty_string(item) for item in requires)):
                add(_finding("manifest.steps.requires", "error", "%s.requires" % where,
                             "requires must be a list of earlier step ids"))
            else:
                earlier = identifiers[:-1] if identifier in identifiers else identifiers
                for requirement in requires:
                    if requirement not in earlier:
                        add(_finding("manifest.steps.requires", "error",
                                     "%s.requires" % where,
                                     "step %r requires %r, which is not an earlier step; "
                                     "steps run in manifest order, so a forward or unknown "
                                     "requirement is a cycle expressed as a list"
                                     % (identifier, requirement)))
        produces = step.get("produces", [])
        if produces is not None and (not isinstance(produces, list)
                                     or any(not _nonempty_string(item) for item in produces)):
            add(_finding("manifest.steps.produces", "error", "%s.produces" % where,
                         "produces must be a list of result-field or artifact-role names"))

    # A step another step requires must say what it produces: `resume` can only
    # stand in for it when the result carries those fields.  A side-effect-only
    # prerequisite is allowed, but then selecting the dependent step alone must
    # refuse instead of pretending the side effect happened.
    for position, step in enumerate(steps):
        if not isinstance(step, dict) or not _nonempty_string(step.get("id")):
            continue
        identifier = step["id"]
        required_later = False
        for later in steps[position + 1:]:
            if not isinstance(later, dict):
                continue
            requirements = later.get("requires")
            if isinstance(requirements, list) and identifier in requirements:
                required_later = True
                break
        produces = step.get("produces")
        if required_later and not (isinstance(produces, list) and produces):
            add(_finding("manifest.steps.requires", "error",
                         "manifest.steps[%d].produces" % (position + 1),
                         "step %r is required by a later step but produces nothing; "
                         "a resume result cannot stand in for it, so that later step "
                         "can never run alone" % identifier))

    # The two reserved input names.  `steps` is the selection the caller passes;
    # `resume` is the earlier result whose outputs stand in for skipped steps.
    for key, item in declarations:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        where = "manifest.inputs.%s[%s]" % (key, name)
        if name == "steps":
            if item.get("kind") != "list":
                add(_finding("manifest.steps.selection", "error", "%s.kind" % where,
                             "the reserved steps input must be kind list"))
            elif item.get("choices") != identifiers:
                add(_finding("manifest.steps.selection", "error", "%s.choices" % where,
                             "the steps input's choices must be exactly the step ids "
                             "in manifest order: %s" % ", ".join(identifiers)))
        if name == "resume" and item.get("kind") != "path":
            add(_finding("manifest.steps.resume", "error", "%s.kind" % where,
                         "the reserved resume input must be kind path"))


def _validate_placeholders(manifest, add):
    """A TODO is a question, not an answer; freezing it makes it a contract.

    THE CHECK RECOGNIZES TWO SHAPES: the `TODO:` prefix, and the exact sentences
    the first templates shipped -- so a package generated before this rule is
    still caught without being migrated.  Only human-facing fields are checked;
    ids, kinds and choices are structure and have their own rules.
    """
    def check(where, value):
        if _is_placeholder(value):
            add(_finding("manifest.placeholder", "error", where,
                         "this is a template placeholder; fill it before freezing. "
                         "Freezing a placeholder writes 'not known yet' into a contract."))

    check("manifest.title", manifest.get("title"))
    check("manifest.answers", manifest.get("answers"))
    if "name" in manifest:
        name = manifest.get("name")
        if not _nonempty_string(name):
            add(_finding("manifest.placeholder", "error", "manifest.name",
                         "name is empty; a capability that cannot be named cannot be addressed"))
        elif _is_placeholder(name):
            check("manifest.name", name)
    inputs = manifest.get("inputs")
    required = inputs.get("required") if isinstance(inputs, dict) else None
    if isinstance(required, list):
        for position, item in enumerate(required, 1):
            if not isinstance(item, dict):
                continue
            check("manifest.inputs.required[%d].means" % position, item.get("means"))
            check("manifest.inputs.required[%d].refused_when" % position,
                  item.get("refused_when"))
    steps = manifest.get("steps")
    if isinstance(steps, list):
        for position, step in enumerate(steps, 1):
            if isinstance(step, dict):
                check("manifest.steps[%d].does" % position, step.get("does"))
    acceptance = manifest.get("acceptance")
    if isinstance(acceptance, list):
        for position, rule in enumerate(acceptance, 1):
            check("manifest.acceptance[%d]" % position, rule)


def validate_manifest(manifest, workflow, base_dir, strict=False, spec_root=None):
    """One rule, one finding.

    THE ORDER IS THE TABLE IN THE REQUIREMENTS, because a caller correcting a
    manifest reads the findings from the top.  The function returns findings and
    never raises for a contract that does not hold: a manifest with six mistakes
    should produce six findings, not the first one.

    `base_dir` is where the PROGRAM lives.  `spec_root` is where a
    `specs.*.default` path is relative to; freeze passes the manifest's own
    directory, because its program comes from the run record while the specs
    come from the workflow package.
    """
    findings = []
    add = findings.append

    if not isinstance(manifest, dict):
        add(_finding("manifest.object", "error", "manifest",
                     "a manifest must be a JSON object"))
        return _upgrade(findings, strict)

    if not _nonempty_string(manifest.get("title")):
        add(_finding("manifest.title", "error", "manifest.title",
                     "title must be a non-empty string: a workflow with no title "
                     "cannot be chosen from a list"))
    if not _nonempty_string(manifest.get("answers")):
        add(_finding("manifest.answers", "error", "manifest.answers",
                     "answers must be a non-empty string: say what question this "
                     "capability answers"))
    for key in ("steps", "acceptance"):
        value = manifest.get(key)
        if not isinstance(value, list) or not value:
            add(_finding("manifest.%s" % key, "error", "manifest.%s" % key,
                         "%s must be a non-empty list" % key))

    inputs = manifest.get("inputs")
    required = inputs.get("required") if isinstance(inputs, dict) else None
    if not isinstance(required, list):
        add(_finding("inputs.required", "error", "manifest.inputs.required",
                     "inputs.required must be a list; a capability that cannot list "
                     "what it needs is a one-off program"))
        required = []
    for position, item in enumerate(required, 1):
        where = "manifest.inputs.required[%d]" % position
        if not isinstance(item, dict):
            add(_finding("inputs.required", "error", where,
                         "each required input must be an object with name, kind, "
                         "means and refused_when"))
            continue
        for field in ("name", "kind", "means", "refused_when"):
            if not _nonempty_string(item.get(field)):
                add(_finding("inputs.required", "error", "%s.%s" % (where, field),
                             "a required input needs a non-empty %s" % field))
        kind = item.get("kind")
        if _nonempty_string(kind) and kind not in INPUT_KINDS:
            add(_finding("inputs.kind", "error", "%s.kind" % where,
                         "kind %r is not one of %s; a free-text kind is what lets "
                         "two callers describe one input two ways"
                         % (kind, ", ".join(INPUT_KINDS))))
        if kind == "enum":
            choices = item.get("choices")
            if not isinstance(choices, list) or not choices:
                add(_finding("inputs.enum", "error", "%s.choices" % where,
                             "an enum input needs a non-empty choices list; without "
                             "it the caller has nothing to choose between"))
        if "why_not_inferred" in item:
            if not _nonempty_string(item.get("why_not_inferred")):
                add(_finding("inputs.inferred", "error", "%s.why_not_inferred" % where,
                             "why_not_inferred must be a non-empty string when present"))
            elif item.get("suggested") is not None:
                add(_finding("inputs.inferred", "warning", "%s.suggested" % where,
                             "this P1 input carries both suggested and why_not_inferred: "
                             "a value that can be suggested is one the platform may infer, "
                             "so it is not a question"))

    _validate_steps(manifest, add)
    _validate_placeholders(manifest, add)

    acceptance = manifest.get("acceptance")
    checks = manifest.get("acceptance_checks")
    if checks is not None:
        if not isinstance(checks, list):
            add(_finding("acceptance.aligned", "error", "manifest.acceptance_checks",
                         "acceptance_checks must be a list"))
        else:
            rules = acceptance if isinstance(acceptance, list) else []
            for position, check in enumerate(checks, 1):
                where = "manifest.acceptance_checks[%d]" % position
                if not isinstance(check, dict) or not check:
                    add(_finding("acceptance.aligned", "error", where,
                                 "each check must be an object with id and assert"))
                    continue
                for field in ("id", "assert"):
                    if not _nonempty_string(check.get(field)):
                        add(_finding("acceptance.aligned", "error", "%s.%s" % (where, field),
                                     "a check needs a non-empty %s" % field))
            if len(checks) != len(rules):
                add(_finding("acceptance.aligned", "error", "manifest.acceptance_checks",
                             "acceptance lists %d rule(s) but acceptance_checks lists %d; "
                             "a rule with no assertion can never fail"
                             % (len(rules), len(checks))))
            identifiers = [check.get("id") for check in checks if isinstance(check, dict)]
            if len(identifiers) != len(set(map(str, identifiers))):
                add(_finding("acceptance.aligned", "error", "manifest.acceptance_checks",
                             "acceptance_checks repeats an id; ids are what a report "
                             "uses to match a verdict to its rule"))
            for position, pair in enumerate(zip(rules, checks), 1):
                rule, check = pair
                if (isinstance(rule, dict) and _nonempty_string(rule.get("id"))
                        and isinstance(check, dict) and rule["id"] != check.get("id")):
                    add(_finding("acceptance.aligned", "error",
                                 "manifest.acceptance[%d].id" % position,
                                 'acceptance names id "%s" but acceptance_checks[%d] is "%s"; '
                                 "the check order must follow the rule order"
                                 % (rule["id"], position, check.get("id"))))

    version = manifest.get("version")
    if version is not None and _version_key(version) is None:
        add(_finding("manifest.version", "error", "manifest.version",
                     "version must be a semantic version such as 1.2.0; got %r" % (version,)))

    if "status" in manifest:
        status = manifest.get("status")
        if status not in ("draft", "active"):
            add(_finding("manifest.status", "error", "manifest.status",
                         'status must be "draft" or "active"; got %r' % (status,)))

    catalog = manifest.get("requires_catalog")
    if catalog is not None:
        if isinstance(catalog, bool) or not isinstance(catalog, int) or catalog < 1:
            add(_finding("manifest.requires_catalog", "error", "manifest.requires_catalog",
                         "requires_catalog must be a positive integer"))

    for key in ("consumes", "produces"):
        declaration = manifest.get(key)
        if declaration is None:
            continue
        if not isinstance(declaration, dict):
            add(_finding("consumes/produces.schema", "error", "manifest.%s" % key,
                         "%s must be an object" % key))
            continue
        schema = declaration.get("schema")
        if schema is not None and _schema_file(schema) is None:
            add(_finding("consumes/produces.schema", "error", "manifest.%s.schema" % key,
                         'schema "%s" has no file in %s; the contract it names cannot '
                         "be read by anyone" % (schema, SCHEMAS)))

    specs = manifest.get("specs")
    spec_base = Path(spec_root) if spec_root is not None else Path(base_dir)
    if specs is not None:
        if not isinstance(specs, dict):
            add(_finding("specs.*.default", "error", "manifest.specs",
                         "specs must be an object"))
        else:
            for name, declaration in specs.items():
                if not isinstance(declaration, dict):
                    add(_finding("specs.*.default", "error",
                                 "manifest.specs.%s" % name,
                                 "each spec declaration must be an object"))
                    continue
                default = declaration.get("default")
                if default is None:
                    continue
                where = "manifest.specs.%s.default" % name
                if not isinstance(default, str) or not default:
                    add(_finding("specs.*.default", "error", where,
                                 "default must be a non-empty relative path"))
                elif Path(default).is_absolute():
                    add(_finding("specs.*.default", "error", where,
                                 "default must be relative to the workflow directory"))
                elif not _inside(spec_base, spec_base / default):
                    add(_finding("specs.*.default", "error", where,
                                 "default escapes the workflow directory"))
                elif not (spec_base / default).is_file():
                    add(_finding("specs.*.default", "error", where,
                                 "default names a file that does not exist: %s"
                                 % (spec_base / default)))

    workflow_file = Path(workflow) if workflow is not None else None
    if manifest.get("source_sha256") is not None:
        expected = manifest.get("source_sha256")
        if not _nonempty_string(expected):
            add(_finding("workflow.sha", "error", "manifest.source_sha256",
                         "source_sha256 must be a non-empty string when present"))
        elif workflow_file is None or not workflow_file.is_file():
            add(_finding("workflow.sha", "error", "manifest.source_sha256",
                         "the manifest records a source hash but there is no workflow.py "
                         "to compare it with"))
        else:
            actual = _source_sha256(workflow_file)
            if actual != expected:
                add(_finding("workflow.sha", "error", "manifest.source_sha256",
                             "workflow.py has changed since the manifest was frozen; "
                             "the hash in the manifest is not the program that ran"))

    if workflow_file is None or not workflow_file.is_file():
        add(_finding("workflow.run", "error", "workflow.py",
                     "workflow.py is missing; there is no program to run"))
    elif not _inside(base_dir, workflow_file):
        add(_finding("workflow.run", "error", "workflow.py",
                     "workflow.py escapes the workflow directory"))
    else:
        try:
            compile(workflow_file.read_text(encoding="utf-8"), str(workflow_file), "exec")
        except (OSError, SyntaxError, UnicodeDecodeError) as error:
            add(_finding("workflow.run", "error", "workflow.py",
                         "workflow.py does not compile: %s" % error))

    deliverable = manifest.get("deliverable")
    if deliverable is not None:
        if not isinstance(deliverable, dict) or not _nonempty_string(deliverable.get("primary")):
            add(_finding("deliverable", "error", "manifest.deliverable",
                         "deliverable needs a non-empty primary; a capability with "
                         "no named deliverable cannot say what it produced"))

    return _upgrade(findings, strict)


def _upgrade(findings, strict):
    if strict:
        for finding in findings:
            if finding["severity"] == "warning":
                finding["severity"] = "error"
    return findings


def _errors(findings):
    return [finding for finding in findings if finding["severity"] == "error"]


def _workflow_of(path):
    """The manifest and program a validate --path names, and their directory."""
    target = Path(path)
    if not target.exists():
        raise RuntimeError("there is nothing at %s" % target)
    if target.is_dir():
        directory = target.resolve()
        manifest_path = directory / "manifest.json"
        manifest = _read_json(manifest_path, "manifest.json")
        entry = manifest.get("entry", "workflow.py") if isinstance(manifest, dict) else "workflow.py"
        if not isinstance(entry, str) or not re.fullmatch(r"[\w.-]+\.py", entry):
            raise RuntimeError("manifest.entry must be one .py filename")
        workflow = directory / entry
    else:
        manifest_path = target.resolve()
        directory = manifest_path.parent
        manifest = _read_json(manifest_path, "the manifest")
        entry = manifest.get("entry", "workflow.py") if isinstance(manifest, dict) else "workflow.py"
        if not isinstance(entry, str) or not re.fullmatch(r"[\w.-]+\.py", entry):
            raise RuntimeError("manifest.entry must be one .py filename")
        workflow = directory / entry
    return manifest, workflow, directory


# --------------------------------------------------------------------------
# scaffold
# --------------------------------------------------------------------------

def _template(name):
    return (TEMPLATES / name).read_text(encoding="utf-8")


def _render(text, values):
    for key, value in values.items():
        text = text.replace("{{%s}}" % key, value)
    return text


def _archive_directory(parent, stamp):
    """A versions/<stamp> directory that does not already hold history.

    Two scaffolds inside one second are two operations, not one; reusing the
    directory would make the second overwrite the first operation's archive --
    which is the one thing a history directory must never do.
    """
    candidate = parent / "versions" / stamp
    if not candidate.exists():
        return candidate
    counter = 1
    while True:
        candidate = parent / "versions" / ("%s-%d" % (stamp, counter))
        if not candidate.exists():
            return candidate
        counter += 1


def command_scaffold(options):
    name = options.name
    if not CAPABILITY_NAME.fullmatch(name):
        raise RuntimeError("name must match %s" % CAPABILITY_NAME.pattern)
    stages = []
    for stage in (options.stages or "model,report").split(","):
        stage = stage.strip()
        if not stage:
            continue
        if stage not in STAGES:
            raise RuntimeError("stage %r is not one of %s" % (stage, ", ".join(STAGES)))
        if stage not in stages:
            stages.append(stage)
    if not stages:
        raise RuntimeError("at least one stage is required")

    workspace = workspace_of(options.workspace)
    domain = options.domain or name
    targets = []
    for stage in stages:
        directory = workspace / ".iax" / "workflows" / ("%s-%s" % (name, stage))
        targets.append((directory / "manifest.json", "manifest", stage))
        targets.append((directory / "workflow.py", "workflow", stage))
    targets.append((workspace / ".agents" / "skills" / name / "SKILL.md", "skill", stages[0]))
    targets.append((workspace / ".iax" / "specs" / ("%s.report.json" % name), "report", stages[0]))
    targets.append((workspace / ".iax" / "specs" / ("%s.figure.json" % name), "figure", stages[0]))

    # CHECK BEFORE READING OR ARCHIVING.  A target whose parent is a symlink out
    # of the workspace must be refused before --force copies a file through it.
    for path, _, _ in targets:
        _check_inside(workspace, path, "the scaffold target")
    existing = [path for path, _, _ in targets if path.exists()]
    if existing and not options.force:
        return {"ok": False,
                "refused": "these files already exist; scaffold does not overwrite a "
                           "capability: %s. Pass --force to archive and replace them."
                           % ", ".join(str(path) for path in existing)}, 1

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archives = {}
    for path in existing:
        if path.parent not in archives:
            archives[path.parent] = _archive_directory(path.parent, timestamp)
        archive = archives[path.parent]
        archive.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, archive / path.name)

    created = []
    for path, kind, stage in targets:
        _check_inside(workspace, path, "the scaffold target")
        if kind == "manifest":
            # BUILT AS DATA, NOT RENDERED AS ONE STRING.  Three stages used to
            # come out byte-identical because the template had no stage variables
            # in the fields that mattered; the name, the question and the
            # required inputs are stage facts, so they are written from the
            # stage tables rather than interpolated into prose.
            document = _read_json(TEMPLATES / "manifest.json", "manifest.json")
            document["name"] = "%s-%s" % (name, stage)
            document["status"] = "draft"
            document["title"] = "TODO: " + domain
            document["answers"] = "TODO: " + STAGE_ANSWERS[stage]
            document["inputs"]["required"] = [dict(item) for item in STAGE_INPUTS[stage]]
            text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        elif kind == "workflow":
            text = _render(_template("workflow.py"), {
                "name": name, "capability": "%s-%s" % (name, stage),
                "stage": stage, "domain": domain, "version": "0.1.0",
                "title": domain,
            })
        elif kind == "skill":
            text = _render(_template("SKILL.md"), {
                "name": name, "skill_name": _skill_name(name), "capability": name,
                "stage": stage, "domain": domain, "version": "0.1.0", "title": name,
            })
        elif kind == "report":
            text = json.dumps(_read_json(TEMPLATES / "report-spec.default.json",
                                         "report-spec.default.json"),
                              ensure_ascii=False, indent=2) + "\n"
        else:
            text = json.dumps(_read_json(TEMPLATES / "figure-spec.default.json",
                                         "figure-spec.default.json"),
                              ensure_ascii=False, indent=2) + "\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        created.append(path.relative_to(workspace).as_posix())

    return {"created": created,
            "next": "跑一次并确认，然后 capability_freeze"}, 0


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------

def resolve_validate_path(path, workspace=None):
    """An absolute path, and an honest refusal when there is none.

    A RELATIVE PATH BELONGS TO A WORKSPACE, NOT TO THE SERVER'S CWD.  The first
    version handed `.iax/workflows/x` to `Path.exists()` in whatever directory
    the bridge happened to be started in and then said "there is nothing at
    `.iax/workflows/x`" -- about a directory that was there.  A wrong message is
    worse than a missing feature: it sends the reader to fix something that is
    not broken.  So the path is resolved against the workspace, the result must
    stay inside it, and every refusal names the absolute path that was checked.

    An absolute path with no workspace is allowed: the caller named it exactly,
    and there is no boundary it could have escaped.
    """
    raw = Path(path)
    target = raw if raw.is_absolute() else (Path(workspace) / raw if workspace else raw)
    resolved = target.resolve()
    if raw.is_absolute() and workspace is None:
        return resolved
    if workspace is None:
        raise RuntimeError("validate needs --workspace to resolve a relative path; "
                           "the path as given would be %s" % resolved)
    root = Path(workspace).resolve()
    if not resolved.is_relative_to(root):
        raise RuntimeError("validate path escapes the workspace: %s is outside %s"
                           % (resolved, root))
    return resolved


def command_validate(options):
    target = resolve_validate_path(options.path, options.workspace)
    manifest, workflow, directory = _workflow_of(target)
    findings = validate_manifest(manifest, workflow, directory, options.strict)
    errors = _errors(findings)
    sys.stderr.write("capability-forge: %d error(s), %d warning(s)\n"
                     % (len(errors), len(findings) - len(errors)))
    for finding in findings:
        sys.stderr.write("  %s %s: %s\n"
                         % (finding["severity"], finding["where"], finding["message"]))
    return {"ok": not errors, "findings": findings}, (1 if errors else 0)


# --------------------------------------------------------------------------
# freeze
# --------------------------------------------------------------------------

def _algorithm_versions():
    """The catalog / algorithm / ABI versions, or Nones with the reason.

    READ, NEVER GUESSED.  A lock that says catalog 54 when the platform is at 57
    would make a stale result look reproducible.  When the package is not
    importable the lock carries nulls and the reason travels with the answer.
    """
    directory = os.environ.get("IAM_PYTHON_PACKAGE_DIR")
    if directory:
        path = Path(directory)
    else:
        platform = {"win32": "win-native", "linux": "linux-native",
                    "darwin": "macos-native"}.get(sys.platform)
        path = PLATFORM_ROOT / "build" / "CMakePlatforms" / (platform or "unsupported") / "IAM" / "Host" / "Python"
    try:
        sys.path.insert(0, str(path))
        import iam_algorithms
        library = iam_algorithms.Library()
        return ({"catalog": library.catalog_version,
                 "algorithm": library.algorithm_version,
                 "abi": library.abi_version}, None)
    except Exception as error:                     # noqa: BLE001 - a lock records what it knows
        return ({"catalog": None, "algorithm": None, "abi": None}, str(error))


def _spec_names(name):
    """The names a capability's specs may use: its own and its stage-less base.

    A capability is `<domain>-<stage>` (D11) while its specs and skill are named
    for the domain alone, because one report describes all of its stages.  A
    freeze of `orebody-model` must therefore find `orebody.report.json`; a
    capability that happens to carry no stage still finds its own name.
    """
    names = [name]
    for stage in STAGES:
        suffix = "-" + stage
        if name.endswith(suffix) and len(name) > len(suffix):
            names.append(name[:-len(suffix)])
    return names


def _spec_path(workspace, name, kind):
    """Where `<name>.<kind>.json` lives, or the first candidate that would."""
    candidates = [workspace / ".iax" / "specs" / ("%s.%s.json" % (candidate, kind))
                  for candidate in _spec_names(name)]
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def _spec_versions(workspace, name):
    """The version of each spec, for the lock.

    The lock records what the capability was frozen WITH.  A spec edited
    afterwards is then visible in `audit` as a version that moved, rather than
    as a number that quietly changed meaning.  A spec that exists but cannot be
    read, or carries no version, is returned separately: dropping it from the
    lock without a word would make the missing record look deliberate.
    """
    found, unreadable = {}, []
    for base in _spec_names(name):
        directory = workspace / ".iax" / "specs"
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("%s.*.json" % base)):
            kind = path.name[len(base) + 1:-len(".json")]
            if kind not in ("report", "figure", "legend"):
                continue
            try:
                document = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                unreadable.append(str(path))
                continue
            if not isinstance(document, dict) or "version" not in document:
                unreadable.append("%s (no version field)" % path)
                continue
            found.setdefault(kind, document["version"])
    return found, unreadable


def _spec_defaults(manifest, spec_root, workspace):
    """The bytes of every `specs.*.default` file, keyed by its relative path.

    READ BEFORE THE TARGET MOVES.  Freezing a scaffold moves the whole directory
    aside; a spec that lives beside the manifest would be unreadable afterwards.
    The bridge copies workflow.py and manifest.json from the RUN, so the forge is
    the only half that can carry these files into the frozen directory.
    """
    specs = manifest.get("specs")
    if not isinstance(specs, dict):
        return {}
    entry = manifest.get("entry", "workflow.py")
    protected = {(Path(spec_root) / "manifest.json").resolve(),
                 (Path(spec_root) / "workflow.py").resolve()}
    if isinstance(entry, str) and entry:
        protected.add((Path(spec_root) / entry).resolve())
    files = {}
    for key, declaration in specs.items():
        if not isinstance(declaration, dict):
            continue
        relative = declaration.get("default")
        if not isinstance(relative, str) or not relative:
            continue
        parts = Path(relative).parts
        if parts and parts[0].lower() == "versions":
            raise RuntimeError(
                "the spec default %r writes into versions/, which is reserved for "
                "frozen history" % relative)
        source = (Path(spec_root) / relative).resolve()
        if source in protected:
            raise RuntimeError(
                "the spec default %r names the manifest or program; copying it after "
                "the bridge would overwrite the frozen contract" % relative)
        _check_inside(workspace, source, "the spec default %r" % key)
        try:
            files[relative] = source.read_bytes()
        except OSError as error:
            raise RuntimeError("could not read the spec default %r at %s: %s"
                               % (key, source, error)) from error
    return files


def _skill_relative(name):
    return Path(".agents") / "skills" / name / "SKILL.md"


HARNESS_SKILL_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _skill_name(name):
    """A Harness-valid skill address for a capability name.

    THE HARNESS ACCEPTS ONLY `[a-z0-9]+(-[a-z0-9]+)*` as a skill name. A Chinese
    name, an uppercase letter or an underscore is a valid capability address but
    an invalid skill name, and the skill file is then ignored with a warning.
    The capability keeps its own name (the workflow directory and the skill's
    description use it); only the frontmatter name becomes a stable ASCII
    address. A name that is already valid is unchanged; one that needed
    normalisation gets a short hash so two names cannot collapse into one.
    """
    if not isinstance(name, str) or not name:
        return "capability"
    if any(ord(character) > 127 for character in name):
        return "capability-" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
    candidate = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not candidate:
        candidate = "capability"
    if candidate == name and HARNESS_SKILL_NAME.fullmatch(candidate):
        return candidate
    return "%s-%s" % (candidate, hashlib.sha256(name.encode("utf-8")).hexdigest()[:8])


def _capability_skill(manifest, lock):
    """The usage skill a frozen capability carries (skill, not a second runner).

    The scaffold's skill teaches WHEN to freeze; this one tells a model HOW to
    call the capability that is now frozen. It is generated from the frozen
    manifest and lock, not copied from prose: the input names, step ids and
    choices are the contract. Acceptance thresholds stay in the manifest, where
    the assertions live; the skill points at them instead of duplicating them.
    """
    name = manifest.get("name") if isinstance(manifest.get("name"), str) else ""
    title = manifest.get("title") if _nonempty_string(manifest.get("title")) else name
    version = lock.get("version")
    version_text = (version if isinstance(version, str) and version
                    else "（manifest 未声明版本） / (no version declared)")
    inputs = manifest.get("inputs")
    inputs = inputs if isinstance(inputs, dict) else {}
    required = [item for item in inputs.get("required") or [] if isinstance(item, dict)]
    optional = [item for item in inputs.get("optional") or [] if isinstance(item, dict)]
    steps = [step for step in manifest.get("steps") or [] if isinstance(step, dict)]

    def input_line(item):
        def clause(value):
            return str(value).strip().rstrip("。.；;")
        label = "- `%s`" % item.get("name", "")
        if item.get("kind"):
            label += "（`%s`）" % item["kind"]
        if _nonempty_string(item.get("means")):
            label += ": " + clause(item["means"])
        choices = item.get("choices")
        if isinstance(choices, list) and choices:
            label += "; choices: " + ", ".join(str(choice) for choice in choices)
        if _nonempty_string(item.get("why_not_inferred")):
            label += "; why_not_inferred: " + clause(item["why_not_inferred"])
        if _nonempty_string(item.get("refused_when")):
            label += "; refused_when: " + clause(item["refused_when"])
        return label

    lines = [
        "---",
        "name: %s" % json.dumps(_skill_name(name), ensure_ascii=False),
        "description: %s" % json.dumps(
            "%s — 已冻结能力的调用说明 / how to call a frozen capability." % title,
            ensure_ascii=False),
        'generated_by: "iam-capability-forge"',
        "capability_version: %s" % json.dumps(version),
        "source_sha256: %s" % json.dumps(lock.get("source_sha256")),
        "---",
        "",
        "# %s" % title,
        "",
        "这是已冻结能力 `%s`，版本 `%s`。不要重新实现它；用 `iam_workflow_run` 调用它。"
        % (name, version_text),
        "This is frozen capability `%s`, version `%s`. Do not implement it again; call it "
        "with `iam_workflow_run`." % (name, version_text),
    ]
    if _nonempty_string(manifest.get("answers")):
        lines.extend(["", "回答 / Answers: %s" % str(manifest["answers"]).replace("\n", " ")])
    lines.extend([
        "",
        "完整契约：`.iax/workflows/%s/manifest.json`；本文件在冻结时生成，重新冻结会重写。"
        % name,
        "Full contract: `.iax/workflows/%s/manifest.json`; generated at freeze, a re-freeze "
        "rewrites it." % name,
        "",
        "## 调用 / How to run",
        "",
        "`iam_workflow_run`，`name` 用 `%s`，`arguments` 是下面的输入。执行由 bridge 的"
        "隔离运行器负责；本 skill 不是运行器。" % name,
        "`iam_workflow_run` with `name` = `%s`; `arguments` are the inputs below. Execution "
        "is the bridge's isolated runner; this skill is not a runner." % name,
        "",
        "## 输入 / Inputs",
        "",
    ])
    if required:
        lines.extend(["必填 / Required:", *[input_line(item) for item in required], ""])
    else:
        lines.extend(["必填 / Required: none / 无。", ""])
    if optional:
        lines.extend(["可选 / Optional:", *[input_line(item) for item in optional], ""])
    lines.extend(["## 步骤 / Steps", ""])
    for step in steps:
        if _nonempty_string(step.get("id")):
            line = "- `%s`" % step["id"]
            if _nonempty_string(step.get("label")):
                line += "（%s）" % step["label"]
            if isinstance(step.get("requires"), list) and step["requires"]:
                line += "; requires: " + ", ".join(str(item) for item in step["requires"])
            if isinstance(step.get("produces"), list) and step["produces"]:
                line += "; produces: " + ", ".join(str(item) for item in step["produces"])
            lines.append(line)
        else:
            lines.append("- %s. %s" % (step.get("n", "?"),
                                       str(step.get("does", "")).replace("\n", " ")))
    lines.extend([
        "",
        "只跑一部分时，`arguments.steps` 选择步骤；被跳过的先决步骤的产物要由 "
        "`arguments.resume` 提供，否则运行会拒绝并点名缺哪一步。",
        "For a partial run, `arguments.steps` selects steps; a skipped prerequisite's "
        "products must come from `arguments.resume`, or the run refuses and names the "
        "missing step.",
        "",
        "## 结果 / Result",
        "",
        "`result.json` 在 `out/<capability>/<run-id>/`，包含 `facts` / `solids` / "
        "`metrics` / `verdicts` / `artifacts`；`run.steps` 记录 requested / executed / "
        "skipped。读它，不要用重跑代替解释。",
        "`result.json` is written to `out/<capability>/<run-id>/`; it contains `facts` / "
        "`solids` / `metrics` / `verdicts` / `artifacts`, and `run.steps` records "
        "requested / executed / skipped. Read it; do not re-run to explain.",
        "",
        "## 归因 / Provenance",
        "",
        "- capability: `%s`" % name,
        "- version: `%s`" % version_text,
        "- catalog: `%s`" % lock.get("catalog"),
        "- source_sha256: `%s`" % lock.get("source_sha256"),
        "",
        "验收规则与断言在 manifest 的 `acceptance` / `acceptance_checks`；本文件不复制阈值。",
        "Acceptance rules and checks are in the manifest; this file does not copy thresholds.",
        "",
    ])
    return "\n".join(lines)


def _write_capability_skill(workspace, manifest, lock):
    """Write the usage skill, unless a person already owns that path.

    A skill is model-facing prose, so silently overwriting one a person wrote
    would be the same mistake as overwriting their workflow. The forge only
    refreshes a file carrying its own `generated_by` marker; anything else is
    left untouched and reported in the freeze result.
    """
    name = manifest.get("name")
    if not _nonempty_string(name):
        return {"written": False, "reason": "the frozen manifest has no name"}
    relative = _skill_relative(name)
    path = workspace / relative
    _check_inside(workspace, path, "the capability skill")
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8")
        except OSError as error:
            return {"path": relative.as_posix(), "written": False,
                    "reason": "an existing skill could not be read: %s" % error}
        if 'generated_by: "iam-capability-forge"' not in existing:
            return {"path": relative.as_posix(), "written": False,
                    "reason": "an existing skill was not generated by the forge; "
                              "left untouched"}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_capability_skill(manifest, lock), encoding="utf-8", newline="\n")
    except OSError as error:
        raise RuntimeError(
            "the capability is frozen but remains a draft: its skill could not be "
            "written at %s (%s)." % (path, error)) from error
    return {"path": relative.as_posix(), "written": True}


def command_freeze(options):
    name = options.name
    if not CAPABILITY_NAME.fullmatch(name):
        raise RuntimeError("name must match %s" % CAPABILITY_NAME.pattern)
    if not options.confirmed:
        return {"ok": False, "refused": "freezing requires --confirmed after the run "
                                        "and its acceptance rules were reviewed"}, 1
    if not re.fullmatch(r"run-[0-9]{8}-[0-9]{6}-[\w-]+", options.run or ""):
        raise RuntimeError("run must be a recorded run id, not a path")
    workspace = workspace_of(options.workspace)
    run_directory = workspace / ".iax" / "runs" / options.run
    _check_inside(workspace, run_directory, "the run directory")
    if not run_directory.is_dir():
        raise RuntimeError("no recorded run %r under %s" % (options.run, workspace / ".iax" / "runs"))
    program = run_directory / "program.py"
    if not program.is_file():
        raise RuntimeError("the recorded run has no program.py")

    if options.manifest == "-":
        try:
            manifest = json.loads(sys.stdin.read())
        except ValueError as error:
            raise RuntimeError("--manifest - is not JSON: %s" % error) from error
    else:
        manifest_path = Path(options.manifest)
        # A RELATIVE MANIFEST BELONGS TO THE WORKSPACE, as a relative validate
        # path does. Resolving it against the server's cwd would either reject a
        # file that is inside the workspace or, worse, read a different file
        # that happens to sit under the cwd.
        if not manifest_path.is_absolute():
            manifest_path = workspace / manifest_path
        _check_inside(workspace, manifest_path, "the manifest")
        manifest = _read_json(manifest_path, "the manifest")
    if not isinstance(manifest, dict):
        raise RuntimeError("the manifest must be a JSON object")

    target = workspace / ".iax" / "workflows" / name
    _check_inside(workspace, target, "the workflow directory")
    if target.exists() and not target.is_dir():
        raise RuntimeError("%s exists and is not a workflow directory; refusing to "
                           "replace a file" % target)
    # SPECS LIVE WITH THE MANIFEST, NOT WITH THE RUN RECORD.  The program comes
    # from .iax/runs; a specs.*.default path is relative to the workflow
    # package, which is the manifest's directory (or the scaffold the caller is
    # freezing over, for a manifest passed on stdin).
    spec_root = target if options.manifest == "-" else manifest_path.parent
    findings = validate_manifest(manifest, program, run_directory, spec_root=spec_root)
    errors = _errors(findings)
    if errors:
        sys.stderr.write("capability-forge: refusing to freeze a contract that does not "
                         "hold (%d error(s))\n" % len(errors))
        return {"ok": False, "findings": findings,
                "refused": "freezing a contract that does not hold would freeze the "
                           "mistake into the contract"}, 1

    spec_files = _spec_defaults(manifest, spec_root, workspace)

    ignored = [key for key in RESERVED_MANIFEST_KEYS if key in manifest]
    # THE FREEZE IS NOT PUBLICATION YET.  The bridge is told `draft` so the
    # target is not addressable while the lock is being built; `active` is
    # written only after the lock exists.  Passing no status would let the
    # catalog's missing-status-is-active rule publish a half-finished freeze if
    # this process died between the bridge and the lock.
    declared = {key: value for key, value in manifest.items()
                if key not in RESERVED_MANIFEST_KEYS}
    declared["status"] = "draft"
    if not BRIDGE.is_file():
        raise RuntimeError("the AlgorithmBridge CLI is missing at %s; the forge does "
                           "not freeze by itself" % BRIDGE)

    # A SCAFFOLD IS A DRAFT, NOT HISTORY.  `scaffold` writes the workflow
    # directory so the program can be run and edited; the bridge's same-name
    # protection is about a FROZEN capability being replaced by an equal or
    # lower version.  A directory with no `source_sha256` has never been frozen,
    # so it is moved aside (and restored on failure) rather than being mistaken
    # for a release.  A directory that HAS been frozen keeps the bridge's rule:
    # only a strictly higher version may replace it.
    moved_draft = None
    if target.exists():
        try:
            old_manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old_manifest = {}
        if not (isinstance(old_manifest, dict) and old_manifest.get("source_sha256")):
            stamp = time.strftime("%Y%m%d-%H%M%S")
            moved_draft = target.parent / (".draft-%s-%s" % (name, stamp))
            counter = 1
            while moved_draft.exists():
                moved_draft = target.parent / (".draft-%s-%s-%d" % (name, stamp, counter))
                counter += 1
            target.rename(moved_draft)

    command = [sys.executable, "-X", "utf8", str(BRIDGE), "workflow-freeze",
               "--name", name, "--run", options.run, "--workspace", str(workspace),
               "--manifest", json.dumps(declared, ensure_ascii=False), "--confirmed"]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    except BaseException:
        if moved_draft is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            moved_draft.rename(target)
        raise
    if completed.returncode != 0:
        if moved_draft is not None:
            target.parent.mkdir(parents=True, exist_ok=True)
            moved_draft.rename(target)
        raise RuntimeError("the bridge could not freeze %s: %s"
                           % (name, (completed.stderr or completed.stdout).strip()[-4000:]))
    if moved_draft is not None:
        # Keep the scaffold under the frozen directory, beside the versions the
        # bridge itself archives.  A draft the user edited is still their work.
        archive = target / "versions" / time.strftime("%Y%m%d-%H%M%S")
        counter = 1
        while archive.exists():
            archive = target / "versions" / ("%s-%d" % (time.strftime("%Y%m%d-%H%M%S"), counter))
            counter += 1
        archive.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(moved_draft), str(archive))
    try:
        frozen = json.loads(completed.stdout)
    except ValueError as error:
        raise RuntimeError("the bridge printed no JSON: %s" % error) from error

    # THE RUN RECORD CARRIES THE PROGRAM, NOT THE PACKAGE.  Put the manifest's
    # spec defaults into the frozen directory before the lock (and the active
    # marker) makes it addressable.
    for relative, contents in spec_files.items():
        destination = (target / relative).resolve()
        if not _inside(target, destination):
            raise RuntimeError("the spec default %r escapes the workflow directory"
                               % relative)
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(contents)
        except OSError as error:
            raise RuntimeError(
                "the workflow is frozen but remains a draft: the spec default %r "
                "could not be written at %s (%s). iam_workflow_run refuses it until "
                "the package is complete." % (relative, destination, error)) from error

    manifest_path = workspace / ".iax" / "workflows" / name / "manifest.json"
    frozen_manifest = _read_json(manifest_path, "the frozen manifest")
    versions, versions_error = _algorithm_versions()
    specs, unreadable_specs = _spec_versions(workspace, name)
    lock = {
        "schema": "iax.capability.lock/1",
        "name": name,
        "version": frozen_manifest.get("version"),
        "catalog": versions["catalog"],
        "algorithm": versions["algorithm"],
        "abi": versions["abi"],
        "frozen_from_run": options.run,
        "source_sha256": frozen_manifest.get("source_sha256"),
        "schemas": {path.name.split(".")[0]: _sha256_16(path)
                    for path in sorted(SCHEMAS.glob("*.schema.json"))},
        "specs": specs,
        "frozen_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    if ignored:
        lock["ignored_reserved_keys"] = ignored
    if versions_error:
        lock["versions_error"] = versions_error
    if unreadable_specs:
        lock["specs_error"] = unreadable_specs
    lock_path = workspace / ".iax" / "specs" / ("%s.lock.json" % name)
    _check_inside(workspace, lock_path, "the lock file")
    try:
        _write_json(lock_path, lock)
    except OSError as error:
        raise RuntimeError(
            "the workflow is frozen but remains a draft: its lock could not be written "
            "at %s (%s). iam_workflow_run refuses it until the lock exists; fix the path "
            "and re-freeze with a higher version." % (lock_path, error)) from error
    skill = _write_capability_skill(workspace, frozen_manifest, lock)
    # THE DRAFT BECOMES ADDRESSABLE ONLY HERE.  `iam_workflow_run` refuses a
    # draft; the lock above is the record that makes the freeze complete, and
    # the usage skill is part of the package, so the status changes only after
    # both exist.
    try:
        frozen_manifest["status"] = "active"
        _write_json(manifest_path, frozen_manifest)
    except OSError as error:
        raise RuntimeError(
            "the lock is written but the capability is still a draft: the manifest at "
            "%s could not be updated (%s). Set status to active after fixing the file."
            % (manifest_path, error)) from error
    result = {"frozen": True, "directory": str(manifest_path.parent),
              "lock": lock, "replaced": frozen.get("replaced"), "skill": skill}
    if moved_draft is not None:
        result["replaced_scaffold"] = True
    notes = []
    if versions_error:
        notes.append("catalog/algorithm/abi are null: %s. The lock records what "
                     "the platform could not answer rather than inventing a "
                     "version." % versions_error)
    if unreadable_specs:
        notes.append("the lock does not record these spec files because they could not "
                     "be read or carry no version: %s" % ", ".join(unreadable_specs))
    if notes:
        result["note"] = " ".join(notes)
    return result, 0


# --------------------------------------------------------------------------
# audit
# --------------------------------------------------------------------------

def _artifact_path(workspace, owner, value):
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute():
        return path
    for candidate in (owner / path, workspace / path):
        if candidate.exists():
            return candidate
    return owner / path


def _audit_results(workspace, name, findings):
    """Check each result.json this capability produced against its files."""
    roots = [workspace / "out" / name]
    for root in roots:
        if not root.is_dir():
            continue
        for result_path in sorted(root.rglob("result.json")):
            try:
                result = json.loads(result_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                findings.append(_finding("audit.result", "error", str(result_path),
                                         "result.json cannot be read"))
                continue
            if not isinstance(result, dict):
                continue
            capability = result.get("capability")
            if capability not in (None, name) and not str(capability).startswith(name + "-"):
                continue
            for artifact in result.get("artifacts") or []:
                if not isinstance(artifact, dict):
                    continue
                path = _artifact_path(workspace, result_path.parent, artifact.get("path"))
                where = str(artifact.get("path"))
                if path is None or not path.is_file():
                    findings.append(_finding("audit.artifact", "error", where,
                                             "the artifact %s named by %s does not exist"
                                             % (where, result_path)))
                    continue
                expected = artifact.get("sha256")
                if _nonempty_string(expected):
                    actual = _sha256(path)
                    if actual != expected:
                        findings.append(_finding("audit.artifact", "error", where,
                                                 "the artifact does not match the sha256 "
                                                 "recorded for it; the result and the file "
                                                 "are no longer the same pair"))
        # A figure list is a document in its own right: it can outlive or precede
        # the result it describes, and an unregistered manual figure is exactly
        # the case that has no result.json to be found beside.
        for figures_path in sorted(root.rglob("figures.json")):
            _audit_figures(workspace, figures_path, findings)


def _artifact_for_role(directory, role, workspace):
    """The artifact a figure names by role, as the figure spec defines it.

    §7.4 says `source.artifact` points INTO result.json.artifacts, not at a bare
    filename: the role is stable while the run directory changes. Older figure
    lists wrote a path there; `_audit_figures` still accepts one that resolves,
    and falls back to this lookup when it does not. result.json and figures.json
    are written into the same run directory, so only that directory and its
    parent are searched -- a workspace-wide search would let a figure borrow an
    artifact from an unrelated run.
    """
    if not isinstance(role, str) or not role:
        return None
    for base in (Path(directory), Path(directory).parent):
        result_path = base / "result.json"
        if not result_path.is_file():
            continue
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(result, dict):
            continue
        for artifact in result.get("artifacts") or []:
            if not isinstance(artifact, dict) or artifact.get("role") != role:
                continue
            path = _artifact_path(workspace, result_path.parent, artifact.get("path"))
            if path is not None and path.is_file():
                return path
    return None


def _audit_figures(workspace, path, findings):
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        findings.append(_finding("audit.figure", "error", str(path),
                                 "figures.json cannot be read"))
        return
    figures = document.get("figures") if isinstance(document, dict) else document
    if not isinstance(figures, list):
        return
    for figure in figures:
        if not isinstance(figure, dict):
            continue
        source = figure.get("source")
        if isinstance(source, dict):
            reference = source.get("artifact")
            artifact = _artifact_path(workspace, path.parent, reference)
            if artifact is None or not artifact.is_file():
                by_role = _artifact_for_role(path.parent, reference, workspace)
                if by_role is not None:
                    artifact = by_role
            expected = source.get("sha256")
            if artifact is None or not artifact.is_file():
                findings.append(_finding("audit.figure", "error",
                                         str(figure.get("id", "figure")),
                                         "the figure names a source that does not exist"))
            elif _nonempty_string(expected):
                actual = _sha256(artifact)
                if actual != expected:
                    findings.append(_finding("audit.figure", "error",
                                             str(figure.get("id", "figure")),
                                             "the figure's source hash does not match the "
                                             "model; it is an old picture of a new model"))
        if figure.get("kind") == "manual" and not (_nonempty_string(figure.get("by"))
                                                   and _nonempty_string(figure.get("date"))):
            findings.append(_finding("audit.manual", "warning",
                                     str(figure.get("id", "figure")),
                                     "a manual figure is allowed, but it must be registered "
                                     "with by and date"))


def command_audit(options):
    workspace = workspace_of(options.workspace)
    current, catalog_error = _algorithm_versions()
    findings = []
    capabilities = []
    root = workspace / ".iax" / "workflows"
    names = []
    if root.is_dir():
        for directory in sorted(root.iterdir()):
            if (not directory.is_dir() or directory.name == "versions"
                    or directory.name.startswith(".")):
                continue
            if not (directory / "manifest.json").is_file():
                continue
            if options.name and directory.name != options.name:
                continue
            names.append(directory)
    if options.name and not names:
        return {"capabilities": [], "findings": [],
                "note": "no workflow named %r in %s" % (options.name, root)}, 0

    for directory in names:
        name = directory.name
        entry = {"name": name, "directory": str(directory), "version": None,
                 "lock": None, "findings": 0}
        try:
            manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            findings.append(_finding("audit.manifest", "error", str(directory),
                                     "manifest.json cannot be read"))
            entry["findings"] += 1
            capabilities.append(entry)
            continue
        if not isinstance(manifest, dict):
            manifest = {}
        entry["version"] = manifest.get("version")
        declared_specs = manifest.get("specs")
        if isinstance(declared_specs, dict):
            for key, declaration in declared_specs.items():
                if not isinstance(declaration, dict):
                    continue
                default = declaration.get("default")
                if not isinstance(default, str) or not default:
                    continue
                candidate = (directory / default).resolve()
                if not _inside(directory, candidate) or not candidate.is_file():
                    findings.append(_finding(
                        "audit.specs", "error", name,
                        "the manifest's spec default %r is missing from the workflow "
                        "package" % default))
                    entry["findings"] += 1
        entry_name = manifest.get("entry", "workflow.py")
        program = None
        if not isinstance(entry_name, str) or not re.fullmatch(r"[\w.-]+\.py", entry_name):
            findings.append(_finding("audit.manifest", "error", str(directory),
                                     "manifest.entry must be one .py filename; the "
                                     "program cannot be located"))
            entry["findings"] += 1
        else:
            program = directory / entry_name
        if _nonempty_string(manifest.get("source_sha256")):
            if program is None or not program.is_file():
                findings.append(_finding("audit.source", "error", str(directory),
                                         "the manifest records a frozen source hash but "
                                         "the program it names is missing"))
                entry["findings"] += 1
            elif _source_sha256(program) != manifest["source_sha256"]:
                findings.append(_finding("audit.source", "error", str(directory),
                                         "workflow.py has been changed since it was "
                                         "frozen; the frozen program is no longer the "
                                         "program on disk"))
                entry["findings"] += 1

        if _nonempty_string(manifest.get("source_sha256")):
            skill_path = workspace / _skill_relative(name)
            if not skill_path.is_file():
                findings.append(_finding("audit.skill", "warning", name,
                                         "the frozen capability has no usage skill at %s"
                                         % skill_path))
                entry["findings"] += 1
            else:
                try:
                    skill_text = skill_path.read_text(encoding="utf-8")
                except OSError:
                    skill_text = None
                if skill_text is not None and \
                        'generated_by: "iam-capability-forge"' in skill_text:
                    match = re.search(r'^capability_version: "(.*)"$', skill_text, re.M)
                    version = manifest.get("version")
                    if match and isinstance(version, str) and match.group(1) != version:
                        findings.append(_finding(
                            "audit.skill", "warning", name,
                            "the usage skill names version %s but the manifest is %s; "
                            "the skill is stale" % (match.group(1), version)))
                        entry["findings"] += 1
        lock_path = workspace / ".iax" / "specs" / ("%s.lock.json" % name)
        lock = None
        if lock_path.is_file():
            try:
                parsed = json.loads(lock_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                parsed = None
            if isinstance(parsed, dict):
                lock = parsed
                entry["lock"] = lock
            else:
                # A corrupt lock is not "no lock": it is the record of what the
                # capability was frozen with, and the reader must know it cannot
                # be trusted rather than silently skipping the checks below.
                findings.append(_finding("audit.lock", "error", name,
                                         "the lock cannot be read as a JSON object; "
                                         "the freeze record is corrupt"))
                entry["findings"] += 1
        elif _nonempty_string(manifest.get("source_sha256")):
            findings.append(_finding("audit.lock", "warning", name,
                                     "the manifest records a frozen source hash but the "
                                     "lock is missing; the catalog, algorithm and schema "
                                     "versions it was frozen with are unrecorded"))
            entry["findings"] += 1
        if isinstance(lock, dict):
            if lock.get("version") != manifest.get("version"):
                findings.append(_finding("audit.version", "warning", name,
                                         "the lock was frozen at version %r but the "
                                         "manifest is now %r; it has changed since "
                                         "it was frozen" % (lock.get("version"),
                                                            manifest.get("version"))))
                entry["findings"] += 1
            if (isinstance(lock.get("catalog"), int)
                    and isinstance(current.get("catalog"), int)
                    and lock["catalog"] < current["catalog"]):
                findings.append(_finding("audit.catalog", "warning", name,
                                         "the platform catalog moved from %d to %d "
                                         "after this freeze; the same input may now "
                                         "produce different numbers"
                                         % (lock["catalog"], current["catalog"])))
                entry["findings"] += 1
            spec_errors = lock.get("specs_error")
            if isinstance(spec_errors, list):
                for error in spec_errors:
                    findings.append(_finding("audit.specs", "warning", name,
                                             "the freeze could not record this spec: %s"
                                             % error))
                    entry["findings"] += 1
            specs = lock.get("specs")
            if specs is not None and not isinstance(specs, dict):
                findings.append(_finding("audit.lock", "error", name,
                                         "lock.specs must be an object; the freeze "
                                         "record is malformed"))
                entry["findings"] += 1
            else:
                for kind, version in (specs or {}).items():
                    spec_path = _spec_path(workspace, name, kind)
                    if not spec_path.is_file():
                        findings.append(_finding("audit.specs", "warning",
                                                 "%s.%s" % (name, kind),
                                                 "the lock names a spec that is missing"))
                        entry["findings"] += 1
                        continue
                    try:
                        spec = json.loads(spec_path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        spec = None
                    if isinstance(spec, dict) and spec.get("version") != version:
                        findings.append(_finding("audit.specs", "warning",
                                                 "%s.%s" % (name, kind),
                                                 "the spec version is %r but the lock "
                                                 "recorded %r"
                                                 % (spec.get("version"), version)))
                        entry["findings"] += 1

        before = len(findings)
        _audit_results(workspace, name, findings)
        entry["findings"] += len(findings) - before
        capabilities.append(entry)

    if current.get("catalog") is None and names:
        findings.append(_finding("audit.catalog", "warning", "platform",
                                 "the current catalog version is unavailable, so the "
                                 "catalog-lag check was skipped: %s" % (catalog_error or "no library")))
    return {"capabilities": capabilities, "findings": findings,
            "catalog": current.get("catalog")}, 0


# --------------------------------------------------------------------------
# candidates
# --------------------------------------------------------------------------

def command_candidates(options):
    """Recent successful transactions that look like capabilities to freeze.

    A CANDIDATE IS EVIDENCE, NOT A DECISION.  The workspace records what ran and
    what it produced; it does not record whether the user accepted the result,
    and it does not know whether the same words will be asked again.  So this
    command proposes -- program identity, how many successes, the latest run,
    its products, and whether a frozen workflow already carries the same source
    -- and leaves the decision where it belongs: with the user, in the
    conversation, before `capability_freeze --confirmed`.

    THE SUMMARY IS DELIBERATELY SMALL.  The whole point of freezing is to spend
    fewer tokens next time; returning the program text here would spend them at
    discovery instead.  It returns a path and a line count, and the caller reads
    the program only if it needs to.

    A SINGLE SUCCESS IS STILL RETURNED.  "Succeeded twice" is the usual bar, not
    a rule the platform can see: a one-off whose result the user accepted may be
    exactly what should be frozen.  `recommended` says what the evidence
    supports; it does not hide the rest.
    """
    workspace = workspace_of(options.workspace)
    if options.limit < 1:
        raise RuntimeError("--limit must be a positive integer")
    runs_root = workspace / ".iax" / "runs"
    groups = {}
    scanned = 0
    if runs_root.is_dir():
        for directory in sorted(runs_root.glob("run-*")):
            record_path = directory / "run.json"
            try:
                record = json.loads(record_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            scanned += 1
            if not isinstance(record, dict) or not record.get("ok") or record.get("timeout"):
                continue
            source_sha256 = record.get("source_sha256")
            if not _nonempty_string(source_sha256):
                continue
            groups.setdefault(source_sha256, []).append((directory.name, record))

    frozen = {}
    workflows = workspace / ".iax" / "workflows"
    if workflows.is_dir():
        for manifest_path in sorted(workflows.glob("*/manifest.json")):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            source_sha256 = manifest.get("source_sha256") if isinstance(manifest, dict) else None
            status = manifest.get("status") if isinstance(manifest, dict) else None
            # A DRAFT IS NOT A PUBLISHED CAPABILITY.  A freeze that stopped
            # before its lock can leave a draft carrying the source hash; it
            # must not make the run disappear from the candidates as if the
            # capability were already addressed.
            if _nonempty_string(source_sha256) and status != "draft":
                frozen.setdefault(source_sha256, []).append(manifest_path.parent.name)

    candidates = []
    for source_sha256, entries in groups.items():
        entries.sort(key=lambda item: item[1].get("started") or "", reverse=True)
        latest_run, latest = entries[0]
        names = frozen.get(source_sha256, [])
        if names and not options.include_frozen:
            continue
        artifacts = [artifact for artifact in (latest.get("artifacts") or [])
                     if isinstance(artifact, dict)]
        program = runs_root / latest_run / "program.py"
        try:
            source_lines = len(program.read_text(encoding="utf-8").splitlines())
        except OSError:
            source_lines = None
        successes = len(entries)
        reasons = ["the same program succeeded %d time(s)" % successes]
        if artifacts:
            reasons.append("the latest run produced %d artifact(s)" % len(artifacts))
        if names:
            reasons.append("already frozen as %s" % ", ".join(names))
        elif successes == 1:
            reasons.append("only one successful run so far; freeze it only if the "
                           "result was accepted and the work will be needed again")
        else:
            reasons.append("no frozen workflow carries this source yet")
        candidates.append({
            "source_sha256": source_sha256,
            "successes": successes,
            "runs": [entry[0] for entry in entries[:5]],
            "latest_run": latest_run,
            "latest_started": latest.get("started"),
            "program_path": (program.relative_to(workspace).as_posix()
                             if program.is_file() else None),
            "source_lines": source_lines,
            "artifacts": [{"path": artifact.get("path"),
                           "bytes": artifact.get("bytes"),
                           "sha256_16": artifact.get("sha256_16")}
                          for artifact in artifacts[:10]],
            "frozen_as": names,
            "recommended": successes >= 2 and not names,
            "needs_user_confirmation": True,
            "reasons": reasons,
        })

    candidates.sort(key=lambda candidate: (candidate["latest_started"] or "",
                                           candidate["successes"]), reverse=True)
    candidates = candidates[:options.limit]
    return {"candidates": candidates, "scanned": scanned,
            "note": "Proposals only: this command does not freeze and does not run. "
                    "Ask the user whether the latest result was accepted, then call "
                    "capability_freeze with confirmed: true. Execution stays "
                    "iam_workflow_run."}, 0


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    verbs = parser.add_subparsers(dest="verb", required=True)

    scaffold = verbs.add_parser("scaffold")
    scaffold.add_argument("--name", required=True)
    scaffold.add_argument("--domain", default=None)
    scaffold.add_argument("--stages", default=None,
                          help="comma-separated ingest, model and/or report"
                               " (default: model,report)")
    scaffold.add_argument("--workspace", default=None)
    scaffold.add_argument("--force", action="store_true")
    scaffold.set_defaults(handler=command_scaffold)

    validate = verbs.add_parser("validate")
    validate.add_argument("--path", required=True,
                          help="a workflow directory or manifest.json; a relative path is "
                               "resolved against --workspace and must stay inside it")
    validate.add_argument("--workspace", default=None,
                          help="the boundary a relative --path is resolved against")
    validate.add_argument("--strict", action="store_true")
    validate.set_defaults(handler=command_validate)

    freeze = verbs.add_parser("freeze")
    freeze.add_argument("--name", required=True)
    freeze.add_argument("--run", required=True)
    freeze.add_argument("--manifest", required=True,
                        help="a JSON file inside the workspace (a relative path resolves "
                             "against --workspace), or - for stdin")
    freeze.add_argument("--workspace", required=True)
    freeze.add_argument("--confirmed", action="store_true")
    freeze.set_defaults(handler=command_freeze)

    audit = verbs.add_parser("audit")
    audit.add_argument("--workspace", required=True)
    audit.add_argument("--name", default=None)
    audit.set_defaults(handler=command_audit)

    candidates = verbs.add_parser("candidates")
    candidates.add_argument("--workspace", required=True)
    candidates.add_argument("--limit", type=int, default=10,
                            help="how many proposals to return (default 10)")
    candidates.add_argument("--include-frozen", action="store_true",
                            help="also list programs a workflow already froze")
    candidates.set_defaults(handler=command_candidates)

    options = parser.parse_args(argv)
    try:
        document, code = options.handler(options)
    except RuntimeError as error:
        return fail(str(error))
    except OSError as error:
        return fail("%s: %s" % (type(error).__name__, error))
    return emit(document, code)


if __name__ == "__main__":
    raise SystemExit(main())
