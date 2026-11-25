"""The headless host: runs one design verb against one document, with no window.

    python3 -m iam.host --plugin plugins/place_sections.py \\
        --in mine.iam --out mine-edited.iam --arg centreline=pl-1 --arg element=el-1

A plugin is a Python module with a ``run(port)`` function, and optionally
``REQUIRES_ABI`` / ``REQUIRES_SCHEMA`` saying what it was written against.  The
host loads it, gives it a :class:`~iam.port.Port`, and publishes what it
asked for -- but only after the platform has validated it.  The plugin never
touches a file, a revision or a handle.

This process is the whole runtime: ``--dry-run`` validates and prints what would
change without publishing anything, which is what makes a verb reviewable before
anyone commits to it.

The same review gate, as two commands: ``--emit-delta FILE`` runs a verb and
writes its edit out as a document instead of publishing it, and ``--delta FILE``
applies such a document -- no plugin involved.  Between the two, a person or an
agent reads the document, and nothing changes until the second command runs.
"""

import argparse
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import iam
from iam.port import Port

# A plugin is supposed to be a pure function of a snapshot and its declared
# parameters, and these two are what make that true in practice rather than in
# principle.  Neither is a sandbox -- same process, same privileges, and the
# doc says so -- but a plugin that cannot be stopped is a plugin a host cannot
# run on someone else's behalf, and an edit that can grow without bound is one
# no reviewer can be asked to look at.
DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_MAX_DELTA_BYTES = 64 * 1024 * 1024


class VerbTimeout(BaseException):
    """The verb ran past its deadline and was stopped.

    Deliberately NOT an Exception.  A deadline a plugin can swallow is not a
    deadline: a loop wrapped in ``except Exception: continue`` -- which is
    exactly the shape of a plugin that would need stopping -- would otherwise
    absorb it and run forever.  BaseException is what KeyboardInterrupt and
    SystemExit use for the same reason.
    """


def _deadline(seconds):
    """Arms a wall-clock deadline for the current thread, or nothing at zero.

    SIGALRM only reaches the main thread, which is exactly where the verb runs,
    so this needs no thread of its own.  Returning a caller means the context
    manager works on platforms where neither signal is available -- the timeout
    is simply not enforced there, rather than the host refusing to run.
    """
    if not seconds or not hasattr(signal, "setitimer"):
        return _NoDeadline()

    class _Alarm:
        def __enter__(self):
            def fired(signum, frame):
                raise VerbTimeout("the verb ran longer than %g s" % seconds)
            self._previous = signal.signal(signal.SIGALRM, fired)
            signal.setitimer(signal.ITIMER_REAL, seconds)
            return self

        def __exit__(self, *_):
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self._previous)
            return False

    return _Alarm()


class _NoDeadline:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def load_plugin(path):
    """Imports a plugin from a file path, by path rather than by module name.

    A plugin is a file someone points at, not something installed on a path, so
    the loader is explicit and a missing file is one clear error.
    """
    plugin = Path(path)
    if not plugin.is_file():
        raise SystemExit("no such plugin: %s" % plugin)
    spec = importlib.util.spec_from_file_location("iam_plugin_%s" % plugin.stem, plugin)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "run"):
        raise SystemExit("%s defines no run(port); every design verb needs one" % plugin)
    return module


def parseArguments(pairs):
    values = {}
    for pair in pairs:
        if "=" not in pair:
            raise SystemExit("--arg wants key=value, got %r" % pair)
        key, _, value = pair.partition("=")
        values[key] = value
    return values


def main(argv=None):
    parser = argparse.ArgumentParser(prog="iam.host", description=__doc__.splitlines()[0])
    # A verb and a document are alternatives, not a sequence: running a verb can
    # produce a document for review instead of publishing (--emit-delta), and
    # applying one needs no verb at all (--delta).
    parser.add_argument("--plugin", help="a Python file defining run(port)")
    parser.add_argument("--delta", help="apply a delta document (.iaxd, or its JSON) instead of running a verb")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--in", dest="input", help="a .iam or .iamh document to open")
    source.add_argument("--new", dest="create", help="a JSON payload to build a project from")
    parser.add_argument("--emit-delta", dest="emit", metavar="FILE",
                        help="write the verb's edit as a delta document instead of committing it")
    parser.add_argument("--out", help="where to write the committed revision")
    parser.add_argument("--dry-run", action="store_true",
                        help="validate and report, publishing nothing")
    parser.add_argument("--arg", action="append", default=[], metavar="KEY=VALUE",
                        help="an argument for the verb; repeatable")
    parser.add_argument("--library", help="an explicit libIamC to load")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, metavar="SECONDS",
                        help="stop the verb after this long; 0 disables (default %g)"
                             % DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-delta-bytes", type=int, default=DEFAULT_MAX_DELTA_BYTES, metavar="BYTES",
                        help="refuse the edit once it retains more than this; 0 disables (default %d)"
                             % DEFAULT_MAX_DELTA_BYTES)
    args = parser.parse_args(argv)
    if bool(args.plugin) == bool(args.delta):
        raise SystemExit("pass either --plugin (run a verb) or --delta (apply a document), not both")
    if args.emit and not args.plugin:
        raise SystemExit("--emit-delta writes what a verb produced, so it needs --plugin")

    # Windows has no SIGALRM. Run the host in a child and bound the whole run:
    # a plugin that blocks in its own import never reaches the verb, and waiting
    # for the entry marker without a deadline hung exactly there.
    if os.name == "nt" and args.plugin and args.timeout > 0 and not os.environ.get("IAM_HOST_DEADLINE_CHILD"):
        with tempfile.TemporaryDirectory(prefix="iam-host-deadline-") as folder:
            started = Path(folder) / "started"
            finished = Path(folder) / "finished"
            child_env = os.environ.copy()
            child_env["IAM_HOST_DEADLINE_CHILD"] = "1"
            child_env["IAM_HOST_DEADLINE_STARTED"] = str(started)
            child_env["IAM_HOST_DEADLINE_FINISHED"] = str(finished)
            with open(Path(folder) / "stdout", "w+b") as out, open(Path(folder) / "stderr", "w+b") as err:
                child = subprocess.Popen([sys.executable, "-m", "iam.host"] +
                                         (list(argv) if argv is not None else sys.argv[1:]),
                                         env=child_env, stdout=out, stderr=err)
                deadline = time.monotonic() + args.timeout
                expired = False
                while child.poll() is None and not started.exists():
                    if time.monotonic() >= deadline:
                        expired = True
                        child.kill()
                        break
                    time.sleep(0.01)
                while child.poll() is None and not expired and not finished.exists():
                    if time.monotonic() >= deadline:
                        expired = True
                        child.kill()
                        break
                    time.sleep(0.01)
                child.wait()
                out.seek(0)
                err.seek(0)
                sys.stdout.write(out.read().decode("utf-8", errors="replace"))
                sys.stderr.write(err.read().decode("utf-8", errors="replace"))
            if expired:
                print("failed: the verb ran longer than %g s. Nothing has been published." %
                      args.timeout, file=sys.stderr)
                return 1
            return child.returncode

    library = iam.load(args.library)
    module = load_plugin(args.plugin) if args.plugin else None

    # What the PLUGIN was written against, which may be newer than what this
    # binding needs.  Checked before any work: a host that does not know a field
    # a plugin sends drops it silently and produces geometry nobody asked for.
    if module is not None:
        iam.require(library,
                        getattr(module, "REQUIRES_ABI", iam.ABI_VERSION),
                        getattr(module, "REQUIRES_SCHEMA", iam.SCHEMA_VERSION))

    port = Port(library)
    port.arguments = parseArguments(args.arg)
    port.max_delta_bytes = args.max_delta_bytes
    try:
        if args.input:
            port.open(args.input)
        else:
            with open(args.create, "r", encoding="utf-8") as handle:
                port.create(json.load(handle))
        print("opened %s revision %d" % (port.project_id, port.revision))

        if args.delta:
            # The review gate's second half: a document written earlier -- by this
            # host, by another one, or by hand -- applied to the revision it names.
            # Nothing is published until the commit below.
            document = port.load_delta(args.delta)
            info = document.info
            print("document for %s revision %d (delta %d, contract %d)" % (
                document.project_id, info.base_revision, info.delta_version, info.contract_schema_version))
            port.apply_delta(document)
            document.close()
        else:
            # The deadline wraps the verb and nothing else: reading the document
            # and writing the result are the host's own work, and a slow disk
            # is not a slow plugin.
            if os.environ.get("IAM_HOST_DEADLINE_STARTED"):
                Path(os.environ["IAM_HOST_DEADLINE_STARTED"]).touch()
            with _deadline(args.timeout):
                module.run(port)
            if os.environ.get("IAM_HOST_DEADLINE_FINISHED"):
                Path(os.environ["IAM_HOST_DEADLINE_FINISHED"]).touch()

        if args.emit:
            document = port.delta()
            document.save(args.emit)
            info = document.info
            document.close()
            print("wrote %s for %s revision %d: nothing published, still revision %d, carrying %d bytes" % (
                args.emit, port.project_id, info.base_revision, port.revision, port.retained_bytes))
            return 0

        if args.dry_run:
            # Validated exactly as the commit would validate it, and published
            # nowhere: this is the reviewable half of "the delta is a document".
            port.dry_run()
            print(json.dumps(port.summary(), indent=2, ensure_ascii=False))
            for status, path, message in port.diagnostics():
                print("  note: %s: %s" % (path, message))
            # What the edit would cost is part of reviewing it: a change nobody
            # can afford to keep is one a reviewer should see the size of.
            print("dry run: nothing published, still revision %d, would carry %d bytes"
                  % (port.revision, port.retained_bytes))
            return 0

        revision = port.commit()
        print("committed as revision %d" % revision)
        if args.out:
            port.save(args.out)
            print("wrote %s" % args.out)
        return 0
    except VerbTimeout as error:
        # Nothing has been committed -- an edit is published by one call at the
        # very end -- so stopping here publishes nothing and leaves the project
        # exactly as it was.  That is what makes a deadline safe to impose.
        print("failed: %s. Nothing has been published." % error, file=sys.stderr)
        return 1
    except iam.IamError as error:
        # The path is the actionable half of a diagnostic, so it is printed
        # rather than folded into the message.
        print("failed: %s" % error, file=sys.stderr)
        for status, path, message in port.diagnostics():
            print("  %s: %s" % (path, message), file=sys.stderr)
        return 1
    finally:
        port.close()


if __name__ == "__main__":
    sys.exit(main())
