# The platform's importers as a DeepSeek Harness plugin

One Harness plugin bundle that puts the two out-of-process importers —
`IamImportTool` and `IaxDrawingImportTool` — in front of an agent, a PTC
script, or a headless run.

| Tool | Reads | Writes |
|---|---|---|
| `import_mine` | `.dmb` block model, `.dmf` and `.dmg` drawing databases | `.iamh` store, or `.iam` / `.iamp` for the selected part |
| `import_drawing` | `.dwg`, `.dxf` | `.iamp`, this platform's own drawing format |
| `describe_drawing` | `.iamp` / `.iaxp`, attached Drawing document or selection | nothing — `scope=structure` returns the existing file projection; `scope=entities` returns common paged entity JSON |

Entity queries accept `source=file|document|selection`. File queries use `path`
(legacy `source=<absolute path>` still works). Document/selection queries need
the Views plugin and a mounted Drawing view; absence returns `no_view`.
See [entity query parameters, provenance and reproduction](../../../Mining/Plot/README.entity-query.md).

## Why a tool plugin and not a preview

`IAM/plugin/DrawingView` and `MiningView` beside this one are **view** plugins:
they register `documentPreviews` and therefore need a browser. This one is a
**tool** plugin and has no client half at all — no `dsh.client` in
`package.json`, no `vendor/`, no `lib/client.js`.

That is the design and not a simplification. An import is a verb, and the runs
most likely to need it are the ones with no page to draw on. The harness mounts
no browser in the `headless`, `sdk` and `acp` profiles (see
`packages/bundle/headless/cordis.patch.yml`, which mounts no Host, no HTTP server
and no browser plugin), and a preview-based plugin cannot load there at all.
The harness puts no package-name allowlist on `ctx.tools`, so a tool registered
from outside the tree is an ordinary tool; the one hardcoded surface,
`ctx.remote.<ns>`, belongs to the browser and this half never touches it.

What a tool gets instead of a panel is its **card** in the conversation, built
from `presentCall` / `presentResult` in `host/import-and-describe-tools.ts` using the same `terminal`
card `tool-bash` uses.

## Build, install, run

```sh
cd IAM/plugin/Import
node scripts/build.mjs host

cd /path/to/deepseek-harness
pnpm dsh plugin --profile <name> add /abs/path/to/IAX/IAM/plugin/Import
pnpm dsh --profile <name> --no-open --port 8899
```

`lib/` is gitignored and produced by the build; `dsh plugin add` symlinks this
directory into the profile, so a rebuild is live on the next boot. Unlike the
view plugins, there is **no hot reload** here: the 500 ms HMR poller watches
`lib/client.js`, which this package does not have, and the host-side module
watcher is off by default in the shipped profiles.

## Where the importers are found

In order, and the first hit wins:

1. `IAM_IMPORT_TOOL` / `IAX_DRAWING_IMPORT_TOOL` — the same two variables
   `IamNativeHost.cpp`'s `importToolPath()` reads, spelled identically so one
   variable moves both callers. **An explicit but wrong path fails immediately**
   rather than falling through to the guess below, because a typo that silently
   works is worse than one that does not.
2. `config.toolsDir` from this bundle's row in a profile patch.
3. The native build's executable directory, derived from this file's own
   location — `<repo>/build/bin/linux-native/` on Linux, and
   `<repo>/build/exe/win-native/` on Windows. The root is chosen by compiler
   family (`build/bin` for GCC and Clang, `build/exe` when `WINDOWS_GCC` is
   defined, which is what build.ps1 sets) and the program's name carries `.exe`
   there. `Import/host/native-tool-paths.ts` holds the table; `tests/wire.test.mjs` follows
   the same one for the C++ dump program.

Only the `native` configuration builds the importers (`build.sh build native`,
or `build.ps1 build native` on Windows); the Qt configuration sets
`IAM_BUILD=0` and has neither, and the WebAssembly configuration is a
narrower platform that links no HDF5 and no Dimine SDK.

That third entry is also the one that has to say "a file this process could
execute" without asking a POSIX question. `fs.statSync().mode` reports `0o666`
for a file on Windows whatever it holds — an `.exe` included — so the `mode &
0o111` test the search originally used rejected every candidate there, and the
paths above could have been perfectly right without it working. The mode bits
are now asked only where they mean something.

## The spawn, and what crosses it

The tools run as **child processes**, and that boundary is the whole point —
argued at length in the tools' own headers and in `Mining/SCHEME.zh-CN.md`
(导入隔离). The Dimine reader is a closed vendor binary this tree cannot
instrument; run in-process, a crash on one file costs the open project. This
plugin calls `spawn` and reads an exit code, and does nothing else with the child.

Three consequences worth stating, because each is a finding rather than a
preference:

1. **stdout is not parsed.** Both importers write `key=value` counts to
   `<out>.report` beside their product. The vendor reader prints to stdout on its
   own schedule and in its own encoding — measured, two GBK lines arrived before
   the tool's first line on the missing-file path. The report is the protocol;
   the log is kept for the human and for nothing else.
2. **A non-zero exit is a successful tool call.** `execute` returns a value whose
   `ok` is false, with `exitCode` or `signal` explaining which. Only an import
   that could not be *attempted* throws — a missing executable, or a malformed
   call.
3. **The report is deleted before the run, not only after it.** Otherwise a run
   that fails before writing one would report the previous run's counts as its
   own — the stale-product failure `IamNativeHost.cpp` defends against with a
   modification-time check, settled here for free.

## The background branch

`run_in_background: true` returns `{ kind: 'background', jobId }` immediately —
measured at 2 ms — while the child keeps running. The output ring pulls the
child's stdout and stderr by **byte offset** rather than being pushed to, which
is why `native-tool-process.ts` splits `startNativeToolProcess` (hands back a running child) from
`runNativeToolProcess` (awaits one). A single await-the-whole-thing function can offer neither
an addressable buffer nor a handle to kill, and a job needs both.

Three details that are load-bearing rather than incidental:

- **The process is spawned inside `run()`**, not before it, so the output sources
  read from a `running` that does not exist yet on the first pull and return
  nothing until it does. Spawning earlier would leave an orphan whenever the
  registry refuses work it cannot own.
- **`done` must not reject.** A child that never spawned is the one case that
  can, and the registry would turn that rejection into a bare `failed`, losing
  the reason — so it is caught and turned into `detail`.
- **The timeout still applies.** Unlike `tool-bash`, whose background branch has
  no deadline, an import keeps its kill-by-deadline: the failure it bounds is a
  hang in a binary nobody in this tree can fix, and unattended is exactly when
  such a hang would otherwise live forever.

Verified against a registry double that follows the documented contract
(`packages/jobs/jobs/src/types.ts`): a fast job settles `completed` with the
one-line summary as its `detail` and 2,442 bytes drained from its ring; a 48 MB
job cancelled mid-run settles `failed` / `killed by signal SIGKILL` after
4,096 bytes. The first run of that test showed **zero** bytes on the fast job,
which turned out to be the double missing the final drain the real registry
documents — worth recording, because it is the one place a job source is easy to
get subtly wrong.

A note on the capture bound: the 64 KiB cap that keeps a vendor reader's chatter
off the heap applies to **logs**. `--describe` writes no log — its stdout *is*
the document — so it gets a 64 MiB bound instead and says so by name when it is
exceeded. Measured: a 5,725-entity drawing projects to 700 KB, and capping that
at the log bound produced a JSON parse error that blamed the wrong program.

## What was added to the C++ side, and why

`IaxDrawingImportTool` used to write its drop report only to stdout, while
`IamImportTool` wrote a `.report` sidecar. That tool's own header says the
two importers are deliberately the same shape — "two importers with two
contracts would be two things to learn" — so a `writeReport` was added to close
the gap, mirroring the mining one.

Closing that gap immediately exposed a worse one. The tool printed
`source=N discarded=M reload=N` and the three numbers **did not add up**: a DWG
holding 9,574 model-space entities converted to a `.iamp` holding 9,572 while
reporting `discarded=0`, which reads as "nothing was lost" over a file that lost
two things. The cause is that the writer reports dropped objects through **two
different channels** — the per-record `kMiningPlotDroppedObject` diagnostics the
tool already counted, and the filer's own dropped references, which reach only
the document's manifest — and neither is complete on its own. The two missing
objects were `AcDbProxyEntity`, reported in neither channel the tool read.

So the report now counts the model space at **both ends** of the round trip and
names the difference, which is the one number that cannot be missing something:

```
kind=drawing
source=9574
discarded=0
reload=9572
dropped.<class>=<count>     # what the writer reported dropping inline
lost.<class>=<count>        # source minus reload, by class — the authoritative one
lost=2
status=0
```

`source - lost == reload` holds by construction. `dropped` can be a subset of
`lost`; a class the writer never reported is exactly what `lost` catches. Both
per-class sets are open — their keys are class names — so `report.dropped` and
`report.lost` in the tool result are declared `additionalProperties: true`.

Measured on the four DWGs at `/home/bilin/src/data/dwg`: 492→492 (`lost=0`),
5,726→5,725 (`AcDbRegion ×1`), 9,574→9,572 (`AcDbProxyEntity ×2`).

### The four `kind` values

A report's `kind` names **what was produced**, and each value has exactly one
writer:

| `kind` | Written by | Product |
|---|---|---|
| `drawing` | `IaxDrawingImportTool` | `.iamp` from a DWG/DXF |
| `drawingHalf` | `IamImportTool --part drawing` | `.iamp` — the plan geometry in a `.dmf` |
| `miningHalf` | `IamImportTool --part mining` | `.iam` — the mine in a `.dmf` |
| `blockModel` | `IamImportTool` on a `.dmb` | `.iamh` |

`miningHalf` was `drawing` until this was straightened out, which was wrong
twice: that branch reports `elements` and `fields` — mine data — so the label
sent a reader looking for the wrong thing, and the same value was also being
written by `IaxDrawingImportTool` for a genuinely different conversion, so a
caller dispatching on `kind` could not tell the two apart. The three names now
live in one place in `IamImportTool.cpp` because the string is both the
label and the selector that chooses which counts to write, and two literals that
must agree are a rename waiting to relabel a report silently.

## Deviations, and why

1. **No `defineTool`.** It lives in `@deepseek-ai/dsh-tools`, and this half
   cannot import any `@deepseek-ai/*` value at runtime: `dsh plugin add` symlinks
   the package into a profile whose `node_modules` holds the linked plugins and
   nothing else, so Node resolves `node:` builtins and this package's own files
   and nothing else. (That is also why the two view plugins' host halves import
   nothing.) The definitions are therefore raw JSON-Schema `ToolDefinition`
   objects, which `ctx.tools.register()` accepts — it is how MCP tools arrive.
   The cost is stated in the harness's cookbook: a raw tool owns its own input
   validation, which is what `requireString` in `host/import-and-describe-tools.ts` is.
2. **No `Config` schema.** A Schemastery schema would mean importing
   `@deepseek-ai/schemastery`, for the reason above. Cordis passes a row's
   `config:` through unvalidated when no schema is declared
   (`vendor/cordis/src/fiber.ts`: `if (!runtime.Config) return config`), so the
   two fields are read with fallbacks.
3. **`run_in_background` returns the job id and nothing else.** The model
   collects with `job_output` and stops with `job_kill` — the id is the whole
   contract, because prose describing the outcome would be a second, unparseable
   copy of what those tools already answer. The job's lifetime is the registry's
   once the id is published, so a later cancellation of the *call* stops the wait
   and not the work; only `job_kill` (or owner disposal) kills the child.
4. **`inject = ['tools']` and not `['tools', 'jobs']`.** A static `inject` is a
   load gate; naming an optional service there would stop the plugin loading in
   any profile that lacks it.

## Status

Verified 2026-10-03 against the harness checkout:

- builds and loads; the composed tree gains a `# == @deepseek-ai/iam-import` layer in both
  a `web` profile and a `headless` one, and the package appears in
  `dsh.profile.bundles`;
- the loader really imports it — removing `lib/index.js` makes the harness print
  `iam-import (@deepseek-ai/iam-import): failed to import`, and restoring it silences that;
- `import_drawing` converts real DWG files end to end and writes the new
  `.report`, reconciling `source - lost == reload` for every file tried
  (`{"source":9574,"reload":9572,"lost":{"AcDbProxyEntity":2}}`);
- `import_mine` converts a real `.dmf` end to end, both halves: `part=drawing` →
  `.iamp` in 2.3 s (`kind=drawingHalf`, 82,156 primitives imported,
  `nativeDropped=0`), `part=mining` → `.iam` in 0.44 s (`elements=1`, `fields=6`);
- `describe_drawing` reads a real v12 `.iamp` and returns parsed JSON, including
  `--verbose` on a 5,725-entity drawing whose 700 KB projection overflowed the
  log bound before the payload bound was introduced;
- `describe_drawing` with `scope=entities` delegates to the separate read-only
  `IaxDrawingQuery` executable; it does not ask the importer to convert or
  describe entity content;
- the failure paths behave: a wrong source exits 2 and returns `ok: false`; a
  missing argument throws; a bad `--describe` source throws; an explicitly wrong
  `IAM_IMPORT_TOOL` throws `ImportToolMissingError` naming the path.

- the background branch: `run_in_background` returns in 2 ms with a job id; a
  cancelled job reports `killed by signal SIGKILL` and a completed one reports
  its summary as the job detail;
- the gating paths: with no jobs service mounted the tool says so by name, and a
  deployment that sets `enableRunInBackground: false` neither declares the
  parameter nor accepts one sent anyway.

Changed 2026-10-09 (Windows): **`out` is optional, and its default is the source's
own name beside it.**

- The default keeps the source's directory and stem and takes the extension this
  tool writes — `.iamp` for a drawing, `.iamh` for a `.dmb`, `.iam` or `.iamp` for
  a `.dmf` half by `part` — and a call whose source answers to none of those is
  refused by name rather than given a guess;
- `import_drawing` with only `source` turned `+4120m中段平面图1.dwg` into
  `+4120m中段平面图1.iamp` beside it, **byte-identical** to the same conversion
  asked for with `out` spelled out (`cmp`, 240,774 bytes, `source=4040
  reload=4040 lost=0 status=0`) — so the default changes the name and nothing else;
- why it stopped being optional: in the session that prompted it, a call for
  「打开dwg文件」 came back `out=+4120m_level_plan.iamp` for a source named
  `+4120m中段平面图1.dwg`. The user, looking for the name this flow implies, got
  the preview's `no entry at "…+4120m中段平面图1.iamp"` — the harness's "File not
  found. It may have been moved or deleted." The conversion was never wrong; the
  name was the model's to pick, and a name nobody can predict is a file nobody can
  click. The default is what makes the name something the tool decides.

Changed the same day, same session: **the result hands the model a finished
link** — a `link:` line under the summary, and every path it prints with forward
slashes.

- Why a link and not just a path: the user's click goes through a **markdown link
  destination**, and CommonMark eats a backslash before *punctuation*. The model
  had written `D:/…/workspace\+4120m中段平面图1.iamp`, so `\+` became `+`, the
  separator in front of the name disappeared, and the preview asked the Host for
  a file that has never existed — "File not found. It may have been moved or
  deleted." for a file sitting on disk, byte-for-byte what a fresh conversion
  writes. A POSIX path has no backslash, which is why the Linux run of this flow
  could not show it. `<…>` does not help: `[x](<…\+4120m…>)` loses the backslash
  too, measured through `MarkdownText` and `openFile`.
- Spelled to survive that trip: forward slashes, `<…>` around the whole path, and
  percent-encoding for `%`, `<`, `>`, `#`, `?`, the space, and `+` itself — the
  harness reads the destination back with `decodeURIComponent`, so each decodes to
  the character that was meant. Measured round trip: the link the tool emits
  reaches `openFile` as the exact path on disk, including a name holding
  `#`, `%`, `(` and a space.
- **The link is for the model to copy, not for the card.** A tool's result text is
  rendered inside a `<pre>` (`ui-chat`'s `GenericCommandCard`), so nothing in it
  is clickable. What the description therefore asks for is: answer with the `link`
  line verbatim, never retype the path into a link.
- A failed conversion gets no `link` line at all — there is no product to open,
  and a link to a name that was never written is the defect this exists to
  prevent.

Not built: a client half, deliberately — see the first section.

Why the background branch was not optional: a 48 MB DWG at
`/home/bilin/src/data/dwg/大数据.dwg` ran past the 300 s bound and was SIGKILLed.
That is the timeout working, and also a foreground call no agent should have to
sit through.

## Files

```
Import/
├── package.json          dsh.bundle.patch only; deliberately no dsh.client
├── cordis.patch.yml      the insert row this bundle contributes
├── host/
│   ├── index.ts                      name / inject / apply
│   ├── import-and-describe-tools.ts   tool definitions, schemas and cards
│   ├── native-tool-process.ts        subprocess lifecycle, output and conversion reports
│   └── native-tool-paths.ts          executable lookup and missing-tool errors
└── scripts/build.mjs                host transpilation
```
