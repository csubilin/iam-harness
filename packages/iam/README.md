> The plugin packages described below now live in this directory as `@deepseek-ai/iam-*`.
> Paths such as `IAM/plugin/Views` refer to the historical IAX checkout layout.

# The platform as IAM Harness plugins

Six Harness plugin bundles. Two put the platform's own Drawing 2D and Mining 3D
views inside the Harness document preview, in both Browse and Edit mode, and
report what the user does there to the session's agent; one puts the two
out-of-process importers in front of an agent; one puts the algorithm library's
retrieval and execution surface in front of it; one renders a document to a PNG
with the platform's own off-screen renderer; the last puts the platform's own
mark in the sidebar.

Each is a **bundle package**: a `package.json` declaring `dsh.bundle.patch` and a
`cordis.patch.yml` layer. The two with a browser half also declare `dsh.client`
and add it as `lib/client.js`.

| Plugin | Kind | Answers for |
|---|---|---|
| `Views` | view | `.iamp` `.iaxp` `.iam` `.iaxm` `.iamh` `.iaxh5`, two wasm views |
| `Import` | **tool** | `import_mine`, `import_drawing`, `describe_drawing` |
| `Render` | **tool** | `iam_render_document` |
| `AlgorithmBridge` | **tool** | `iam_algorithm_search`, `iam_algorithm_describe`, `iam_mine_describe`, `iam_workflow_list`, `iam_workflow_run`, `iam_program_run` |
| `MiningRepository` | **tool** | `iam_mining_show`, and the write door: `iam_mine_edit`, `iam_mine_verb`, `iam_mine_document`, `iam_mine_apply` |
| `Brand` | **chrome** | nothing it is asked for — it occupies the sidebar's brand slots |

**`manifest.json` is the machine-readable version of that table**, and it carries more than
the rows above: every package's `kind`, `provenance` (builtin, workspace or third-party),
`status` (active or planned), and which profiles it belongs in. It is the single place to
change when a package is added, and it is what the composition bundle under `profile/` is
assembled from. The package it still lists as `planned` — `ArtifactStore` — exists as a
directory and a README only: a reserved place is a documented one, and it is not in a build
or a profile yet. `MiningRepository` is the one that has stopped being a
reserved place entirely: the directory was reserved for the Mining write door, and it now
ships the whole of it — the read-only `iam_mining_show`, the two edit verbs that produce a
delta document and publish nothing, and the `iam_mine_apply` that commits one. It is a tool
rather than the service the reservation named because the model is who has to be able to ask
for an edit; the service face is what to add when a second package needs to call it.

`Workflows/Examples/ByProductOre` is **not a shipped capability and not a row here**. It is
the reference implementation and regression fixture of the workflow format: a Python program
plus a `manifest.json` declaring its inputs, its steps and its acceptance rules. It lives one
level below the built-in discovery root (`Workflows/Examples/`), so `iam_workflow_list` never
offers it — a fresh workspace has no platform capability at all, and the first one arrives
only when the user freezes a run into `.iax/workflows/`. The example is still read by the
tests and documented in `Workflows/README.md`; remove that fixture and the workflow format
loses its worked example, not a product feature.

`AlgorithmBridge` is host-only like `Import`, and for a further reason: what it executes
is generated code, so it runs as a child process — a crash in a generated program should
cost a tool call, not the session. Its substance is `python/bridge.py`; the TypeScript half
is a process launcher. See `AlgorithmBridge/README.md`.

`Import` is host-only — no `dsh.client`, no `vendor/`, no browser half. That is
what lets it load in the `headless`, `sdk` and `acp` profiles, which mount no
page at all; an import is a verb, and the runs most likely to need one are the
ones with nothing to draw on. See `Import/README.md`.

`Render` is host-only for the same reason, and it is the one tool that makes a
*picture*: `iam_render_document` runs `IamNativeHeadlessMining` (or the Drawing
twin, by the executable's own name) off-screen, converts the PPM to PNG in the
plugin process, and returns the command line with the file. The renderer's
optional flags (`--view`, `--fit-elements`, `--fit-bbox`, `--overlay`) are probed
from `--help` per executable, so an older build renders and reports what it does
not support in `skipped[]`. See `Render/README.md`.

`Brand` is the platform's own icon and name in the sidebar's brand position,
which the harness otherwise fills with its own mark and the words "DSH Local
Build". It is a separate package rather than something the two view plugins each
contribute because those slots are `kind: 'single'` — two registrations into one
is a collision, not a merge.

## One view package, two domains

`Views` serves Drawing 2D and Mining 3D from one package, where there used to be
`DrawingView` and `MiningView`. The table is `Views/host/domains.ts` and both
halves walk it, so a third domain is a row there and not a third package. A
bundle row may set `config.domains: [drawing]` to serve a subset; the shipped
row serves both.

The two packages were maintained by copying one over the other, and the copying
cost two real bugs before the merge, both recorded where they were fixed: a
method missing from the second copy turned a reported failure into
`view.clearLoading is not a function`, and an extension missing from the second
copy's list made a plot fall through to "no preview for this file type". One
table and one code path cannot drift from themselves.

The sections below were written when the two packages were separate, and
`DrawingView`/`MiningView` in them mean the two domains rather than two
directories. `assertOwnView` is gone: it existed to catch a copy that framed the
sibling's page, which one table makes unexpressible. What it is replaced by is a
build-time check that every declared domain's view is vendored.

## Appearance and language come from the harness

Neither the panes nor the embedded views carry a switcher of their own. The
harness already has an Appearance row (light / dark / follow the system) and a
Language row (中文 / English) in its settings, and a second control would be a
second answer to a question the user has already answered once.

What each layer does with that answer:

- **The panes** (`client/components/*Viewer.tsx`) are painted in the harness's
  own design tokens, `var(--dsw-alias-*)`, which the harness rebinds on `body`
  when the appearance changes. Nothing subscribes to anything; the colours
  follow by inheritance. Their copy is registered into the harness's locale
  registry (`client/locales.ts`) and reaches the components through the slot
  machinery's `t` prop. The strip above the view is **icons only** — the six
  actions were word buttons, and in a sidebar the words were wider than the
  drawing — so each button is named by its tooltip and by `aria-label`, both fed
  from the same translated string the button face used to carry.
- **The embedded wasm view** is a separate document and can see none of that, so
  `client/index.tsx` reads the resolved appearance from `ctx.theme` and the
  active locale from `ctx.locale`, and passes both down as query parameters on
  the frame's URL — the same channel `?editable=` already uses. A later change
  reaches a running frame through `Module._iamSetAppearance`, so switching to
  Light does not re-read a 30 MB document.
- **The native editors** have no harness around them at all and decide for
  themselves: `IAM_THEME` / `IAM_LANGUAGE`, or `theme` / `language` in
  `<config>/iax/iam.ini`, or the desktop for the first and the system locale for
  the second. Both have a switch at the right-hand end of the tool strip, and
  both print what they settled on at start-up.

The harness rebrand — the product's name and icon — is *not* here; it is a patch
against the harness checkout, and it is recorded in `harness/README.md` beside
the WebGPU patch.

## What the two view plugins do

1. **Show the view.** The preview pane embeds the platform's WebAssembly view
   for every document the browser build can read, on Desktop and Web alike.
   There is one preview path, so the two carriers cannot disagree about what a
   document looks like. A columnar `.iamh`/`.iaxh5` store is the one exception,
   and the harness is told about it: that preview is registered as `renderer`,
   so opening one reads no bytes and mounts no frame — the pane offers the
   native editor immediately instead of waiting for a read it cannot use.
2. **Report what the user does.** Selection changes, committed edits, undos,
   redos, refusals and saves travel from the view to the session's record over a
   validated channel. Both the embedded view and the standalone native editor
   write into the same record.
3. **Answer the agent.** Two tools per plugin, named for the domain —
   `iam_drawing_view_selection` / `iam_mining_view_selection` and
   `iam_drawing_view_recent_edits` / `iam_mining_view_recent_edits` — read that
   record, and a short summary is injected into the session's next request after
   anything changes. The names carry the domain because the Harness tool table
   is ONE global layer and a duplicate name in it throws: two plugins registering
   `iam_view_selection` is not a merge, it is the second plugin failing to load.
   The prefix is built in `host/index.ts` and passed into `host/tools.ts`, so the
   two copies of that file stay identical.
4. **Offer the native editor.** On the desktop carrier the user can start the
   standalone IAX program for a document, in Browse or Edit mode, for a full
   local renderer and for `.iamh` (HDF5, which the WebAssembly build cannot read).
   A document has at most ONE native window: the pane's launch route and
   `iam_mining_show` consult the same process-wide claim, so a second open is
   refused until that window closes.

## Build, install, run

`./build.sh build web` (Windows: `.\build.ps1 build web`) also syncs the built
pages, JavaScript, WASM and data files into `Views/vendor/`. This applies to
`rebuild web` and the `web` shorthand too. `web64` keeps its separate outputs
and does not replace the plugin's wasm32 files. The standalone vendor command
below remains available for an existing build; pass a source directory as its
first argument or set `IAX_WASM_VIEWS` to use another build tree.

```sh
cd IAM/plugin/Views && node scripts/vendor-view.mjs && node scripts/build.mjs host && node scripts/build.mjs client
cd ../Import && node scripts/build.mjs host          # host-only: no vendor step, no client mode
cd ../Brand && node scripts/build.mjs host && node scripts/build.mjs client
cd ../AlgorithmBridge && node scripts/build.mjs host # builds host and copies built-in workflows; Python bindings are staged only for npm pack

cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /abs/path/to/IAX/IAM/plugin/profile/mining-workspace
pnpm dsh web --no-open
```

The repository's default `./build.sh build` now performs the six active plugin
bundle builds after the Web/WASM views finish, including vendoring those views
into `Views/vendor/`. Build the individual packages manually only when iterating
on plugin code without rebuilding the platform views.

On Windows the `add` line takes the same absolute path with forward slashes:

```powershell
cd D:\path\to\iam-harness
pnpm dsh plugin --profile web add D:/path/to/IAX/IAM/plugin/profile/mining-workspace
pnpm dsh web --no-open
```

Forward slashes and not backslashes: the path is handed to `pnpm add` as one
argument, and a backslash is the one character pnpm's specifier parser has a
reading for that is not a directory separator. Measured 2026-10-09 — `dsh plugin
--profile web add <path>/Views` records `link:<path>/Views` in
the profile's `package.json` and reconciles it into `dsh.profile.bundles`.

**Windows needs Developer Mode on**, the same prerequisite the Harness's own CI
sets up (`AllowDevelopmentWithoutDevLicense = 1`; `.github/workflows/ci.yml`
enables it before installing). A profile links these packages by directory, and
the test suite's `address.test.mjs` creates symlinks outright — without the
privilege those cases fail rather than skip. Check it with
`Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock`.

The composition bundle installs the local packages. Native libraries still
need a matching IAX build; set `IAX_PLATFORM_ROOT` or the bridge row's
`platformRoot`. Running generated programs and workspace algorithms additionally
requires a configured `programRunner` sandbox.

`vendor-views.mjs` copies the built views out of
`build/bin/wasm/views/` (override with `IAX_WASM_VIEWS`). The build needs no
`node_modules` of its own: `build.mjs` uses `typescript`'s `transpileModule` and
locates the compiler through `DSH_TYPESCRIPT` or the harness checkout.

**`vendor/` is a copy, and an old copy is a preview that silently ignores the
view's new features.** `lib/` and `vendor/` are both gitignored — neither is
authored — so a checkout that has just pulled needs the whole sequence, and a
session that has changed anything under `Host/Web/` or `ViewCore/` needs the
`./build.sh build web` *and* the `vendor-views.mjs` halves of it. Measured
2026-10-07: a vendored page three hours older than the build made `?theme=`,
`?lang=` and `Module._iamSetAppearance` no-ops, so the preview inside the
harness did not follow the harness's appearance — while everything upstream of
it, the pane's own colours included, did. Nothing reports this; the page is
simply an older program.

`lib/client.js` is picked up from the installed package at boot and re-read
every 500 ms by the harness HMR poller, so rebuilding it live-reloads the page —
no shell rebuild and no restart.

### Two patches against the harness checkout

Everything this platform adds to the harness is a plugin, with two exceptions —
both of them things a plugin cannot reach, kept in `harness/` and applied by hand
after an upgrade. `harness/README.md` is the full record: what each changes, why
it cannot be a plugin, how to tell whether a future harness still needs it, and
which of the harness's own tests assert the old brand.

```sh
cd /path/to/deepseek-harness
git apply /path/to/IAX/IAM/plugin/harness/desktop-webgpu.patch    # Vulkan for WebGPU in Electron
git apply /path/to/IAX/IAM/plugin/harness/iam-harness-rebrand.patch  # the product's name and icon

pnpm build:lib:client && pnpm build:web
pnpm --filter @deepseek-ai/dsh-desktop run build   # tsc -b then tsdown; either alone is not enough
```

The first is needed for the desktop carrier to draw at all. The second is the
platform's own name and mark in the harness's user-visible strings and assets —
the window title, the PWA manifest, the favicons, the installer's product name,
the sidebar's fallback text.

### Configuring the native editor

The desktop carrier starts a real program, so it has to be told where that
program is. Nothing is hardcoded: a path baked in here would be one developer's
build tree.

```yaml
# cordis.patch.yml
- insert:
    - id: iam-drawingview
      name: dsh-iam-drawingview
      config:
        nativeBinDir: /path/to/build/bin/linux-native
        fontsDir: /path/to/IAX/Fonts
```

or, in the environment: `IAM_NATIVE_DIR` and `IAM_FONTS_DIR` (the
latter falling back to `ACAD`). Without them the native actions report that they
are unavailable and everything else works unchanged.

**The directory differs by platform, and it is not the same `build/` subpath.**
The tree chooses its output ROOT by compiler family: GCC and Clang write
`build/bin/<platform>`, and a Windows build — `WINDOWS_GCC`, which build.ps1
sets — writes `build/exe/<platform>`. The native target's platform token is
`linux-native` on one and `win-native` on the other, and Windows names the
programs `IamDrawing.exe` / `IamMining.exe`. So the same setting is:

| | `nativeBinDir` |
|---|---|
| Linux | `<IAX>/build/bin/linux-native` |
| Windows | `<IAX>/build/exe/win-native` |

That table is also what `Import/host/native-tool-paths.ts` and `tests/wire.test.mjs` follow
when they look for a built program without being told where it is.

## The unified event protocol

One schema, defined once, in C++:
`IAM/ViewCore/Include/IamViewEvents.h` with its serialiser in
`IamViewEvents.cpp`. Both the browser build and the native build publish it;
the plugin host half validates it in `host/events.ts`. The wire form is one JSON
object per event:

```json
{
  "schema": "iax.iam.view-event/1",
  "eventId": "drawing.edit#12",
  "sequence": 12,
  "kind": "edit.committed",
  "view":     { "id": "drawing.edit", "domain": "drawing", "mode": "edit", "is3d": false },
  "document": { "name": "sheet.iamp", "hasRevision": false },
  "edit":     { "operation": "erase", "before": "1 object(s) affected",
                "after": "erase of 1 object", "refs": [...], "truncated": false }
}
```

| `kind` | carries | means |
|---|---|---|
| `selection.changed` | `selection` | one PAGE of the view's whole current selection — `version`, `count`, `offset`, `more` — with a version that moves only when the selection does |
| `edit.committed` | `edit` | one user action reached the document: the undo stack for a drawing, a published revision for a mine |
| `edit.undone` / `edit.redone` | `edit` | the same action, taken back or re-applied |
| `edit.failed` | `edit.message` | the document refused the change |
| `document.saved` | `save` | the document was written: path, and a hash when one is cheap |

- **A selection is PAGED; an edit is not.** One event carries at most 256
  references, and a rubber-band selection over a whole sheet is bigger than that
  — measured at 531, and a real drawing can be far worse. So a selection travels
  as several events sharing a `version` and differing in `offset`, the last of
  them saying `more: false`, and the host stitches them back together. Before
  this, the 531-entity case arrived as 256 references and a count with no way to
  ask for the rest: a reader could never learn what the user had selected.
  Edits are not paged — an edit's refs are the objects it touched, they are
  capped, and `truncated` says so.
- **A selection is superseded; an edit is not.** A newer selection replaces the
  queued events of an OLDER VERSION, in the view's queue and in the browser's
  alike. Pages of the same version are kept, which is the part a naive "replace
  the last selection" rule gets wrong — it drops page 0 the moment page 1 is
  queued, and what arrives is a selection that starts at offset 256.
- **Nothing is reported before it is a fact.** A drag in progress is not a
  committed edit, and the commit point is where the event is raised — the release
  for a Minecraft-surface drag, the moment a unit entered the undo stack for a
  drawing.
- **Every list is bounded.** At most 256 references per event and 4096 across all
  the pages of one selection, 200 characters per summary, 256 events queued, 64
  pages. Past those the selection says `truncated: true` and carries the TRUE
  count. A reader that took a truncated list for the whole selection would
  conclude the objects it did not see are not selected.

Two more properties belong to the STATE rather than to the schema:

- **A record is one DOCUMENT of one session, and every write names a view
  INSTANCE.** The host mints an instance id whenever it issues a capability, so
  a preview that reloaded, a preview that remounted onto another file and the
  native editor are three instances and never one. An event carrying a
  superseded instance is refused rather than filed against the view that
  replaced it.
- **Deduplication is per source and per instance.** `eventId` is
  `${viewId}#${sequence}` and the sequence starts at 1 in whatever process
  produced it, so the browser view and the native editor both mint
  `drawing.browse#1` — and so does a page that was just reloaded. Keyed on the
  id alone, the second of any of those pairs was silently swallowed as a
  duplicate.

## The two event paths

```
                     ┌──────────── plugin host (Node) ──────────────┐
browser preview      │                                              │
  ── postMessage ──▶ │  POST /iam-<view>/events   (capability)      │
  (origin-checked)   │            │                                 │
                     │            ▼                                 │
standalone native    │   session record (per session + document)    │
  ── loopback TCP ─▶ │   selection · edits · save · native status   │
  (greeting token)   │            │                                 │
                     │            ├──▶ agent.inject()  (next request)
                     │            └──▶ iam_<domain>_view_selection / …_recent_edits
                     └──────────────────────────────────────────────┘
```

**WASM → Harness.** The view's page posts each event to its parent with
`window.location.origin` as the target origin; the browser half admits a message
only when the origin is its own, the source is its own iframe, the envelope names
the channel, and the payload carries the schema version this build knows. What it
then forwards carries the capability the host issued for this session and this
document.

**Native → Harness.** The desktop carrier spawns the editor with a real path, a
mode, `--iam-ipc <port>` and `--iam-token <token>`, as an argument array and never
as a shell string. The editor connects to `127.0.0.1:<port>`, greets with the
token, and then writes one JSON object per line. The token is minted by the host,
names one session and one document, expires in two minutes and is spent on first
use — so a command line read out of a process listing is worth nothing.

The two options are the host's and are consumed by `IamNativeStart.cpp` before
the view sees the command line; the editor's own arguments are still "the file to
open" and "the second output", exactly as `run.sh` passes them. Started by hand,
with no `--iam-ipc`, the editor reports nothing and behaves as it always did.

## Session verification

A capability is the only thing that authorises a write, and it is never derived
from anything the caller says about itself:

- **Issued by the host**, from a `dsh-resource://file/session/<id>/<path>` address
  whose session id is checked against the session store. An address for a session
  this process does not have gets no token.
- **Bound to one session, one document, one view INSTANCE, one purpose.** The
  purposes are `events`, `status` and `native-launch`; a token that has one
  cannot be used for another. The instance is minted on every issuance, which is
  what makes "a preview that reloaded" a different view from the one it replaced
  — and what lets this host REFUSE an event from the predecessor.
- **Time-limited.** Thirty minutes for the page (a reload asks for a new one), two
  minutes for a native launch.
- **Spent once** on the native path, by the connection that presents it.
- **Checked against the document the view is showing.** An instance pins the
  document name its first event claims, and a later event naming a DIFFERENT
  document — same directory-less name up to the extension, case-insensitively —
  is refused. The comparison is on the stem and not the whole name, and that is a
  measurement rather than a preference: an equality check rejected EVERY Mining
  event on 2026-10-07, because a Mining view names its document after the project
  it was imported from (`….dmf`) while the session opened the store (`….iam`). The
  stem rule still catches what the check exists for — the embedded view has a file
  picker of its own, and a user who opens another drawing inside the frame reports
  a different stem.
- **Deduplicated by source, instance and `eventId`**, so a resend — a reconnect, a
  retried POST — is not counted twice, and the same id from two editors is not
  mistaken for one fact.
- **Rate- and size-limited.** 64 KiB per body, 64 events per request, 64 KiB per
  IPC line, and the browser half coalesces and caps its own queue before it ever
  sends.

What a refusal does NOT do is crash anything. A malformed event is refused with a
reason and the connection stays up; an unknown event id (a `kind` a newer view
knows and this host does not) is refused and recorded; a native disconnect marks
the transport down, tells the user on the editor's own status line, and leaves the
record intact; unloading the plugin drops the sessions it was holding and closes
the listener.

### What is never dropped quietly

A queue that is full has to lose something, and the only thing worse than losing a
committed edit is losing it silently — a reader would take the hole for "nothing
happened". So:

- a batch that fails to send is PUT BACK, not discarded: an unreachable host, a
  5xx, and a 403 whose capability renewal also failed all retry with the events
  intact, fast at first and then slowly, and a refusal that is really about the
  request's shape halves the batch rather than dropping it;
- a selection snapshot may still be superseded, because a newer one says
  everything the older did;
- when the queue is full and there is nothing supersedable left, the oldest FACT
  goes and the drop is COUNTED, sent to the host with the next batch, and
  reachable from `/status` and from `…_view_recent_edits` as `gaps`.

## What the agent sees, and when

- **Nothing wakes an idle agent.** A click, a drag and a committed edit all call
  `agent.inject()`, which queues model-facing context for the session's NEXT
  request. An agent that is idle stays idle.
- **The injected text is a summary**: the view, the document, how many objects are
  selected, the newest few references, how many edits are committed and what the
  last one was. It says so when the list is short, when a selection is still
  arriving page by page, and when events had to be dropped. The full lists are
  read with the tools.
- **A selection arrives in three flags, and they are not interchangeable.**
  `page.exhausted` says this answer reached the end of what the host holds;
  `selection.complete` says every page the VIEW sent has arrived; `selection.
  truncated` says the view withheld references, so even a complete set is smaller
  than `count`. A pager passes the `version` it started with and is TOLD when the
  selection has moved on rather than being handed a page of another one.
- **Two buttons are the exception.** 「让智能体分析选择」 and 「让智能体检查修改」
  call `agent.followup()` — which does start a turn — and only because the user
  pressed them. That is the whole reason they are buttons.

## Deviations from the original brief, and why

These are not preferences; each was forced by the harness or by the engine, and
each is checkable in the sources named.

1. **`@deepseek-ai/dsh-plugin` does not exist.** Plugin types come from
   `@deepseek-ai/cordis`; the preview registry is `ctx.documentPreviews`
   (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`).
2. **A bundle declares `dsh.bundle.patch`, not `dsh.bundle: true`.** Without the
   patch layer the package installs as a plain dependency and is never loaded.
3. **`ctx.registerRemoteMethod` / `ctx.remote.drawingview.*` do not exist for an
   out-of-tree package.** The client Remote surface is a hardcoded in-tree mount
   list and Typert codegen only scans `packages/*`. Both event paths and the
   native launch therefore go over the host's `webServer` route table, which both
   carriers dispatch. The browser half is the same artifact on Web and Desktop.
4. **The client bundle cannot import other Harness packages at runtime, with one
   exception worth knowing.** Its `require` resolves a fixed seed table — the
   nine platform words (`react`, `react/jsx-runtime`, `react-dom`,
   `react-dom/client`, cordis, the client store, ui-slots, **ui-primitives**,
   ui-dockkit) — and anything else throws. This is why the panes have no
   dependency on `@deepseek-ai/dsh-client-ui-*`: services are reached by `inject`
   key and the preview props are typed structurally. `ui-primitives` is the
   exception and the only one taken: the strip's tooltips are its `Tooltip`
   (`client/components/icons.tsx`), which is why they are placed, timed and
   drawn exactly like the harness's own. Its *icon set* is not reachable by the
   same route — the package publishes those from a subpath
   (`./src/icons/index.tsx`) and the table holds the bare package name — so the
   glyphs that half needs are drawn in that file rather than imported.
5. **The tools are raw definitions.** A host half resolves `node:` builtins and
   its own files and no `@deepseek-ai/*` value at all, so `defineTool` is not
   available and the definitions are plain JSON Schema — the same arrangement
   `Import/host/import-and-describe-tools.ts` uses. The cost is that these files own their argument
   validation.
6. **Formats are the platform's own, not DWG/OBJ.** `.iamp` for Drawing;
   `.iam`/`.iaxm`/`.iamh` for Mining. `.iamh` is refused on the WebAssembly path
   with an explicit message, because that build links no HDF5.
7. **The host half NAMES its refusals; it does not write them.** Anything the
   pane shows as a refusal travels as `{ code, detail? }` from
   `shared/reasons.ts`, and the pane's dictionary turns the code into a sentence
   — because the host is a Node process and has no idea which language the page
   is in. This was not always so: the capabilities route answered with a Chinese
   sentence, which an English pane then displayed verbatim, and five sibling
   refusals did the same. What the host still writes sentences for is the record
   it keeps for the agent and its own console; neither is the user.

## Files

```
<Plugin>/
├── package.json          dsh.bundle.patch + dsh.client + exports["."|"./client"]
├── cordis.patch.yml      the insert row this bundle contributes
├── shared/reasons.ts     the refusal names both halves agree on; erased from
│                         both builds, so it costs no code either side
├── host/index.ts         the route table: capability, events, status, document,
│                         agent actions, native launch; TOOL_PREFIX is built here
├── host/events.ts        the schema validator, the bounds, the per-document
│                         record, the view instances, the page assembly, the
│                         capability registry, the injection policy
├── host/native.ts        spawning the standalone editor, the loopback listener,
│                         the greeting-token check
├── host/tools.ts         view selection (paged, by version and cursor) and
│                         recent edits; named `iam_<domain>_view_*` from the
│                         prefix its caller passes
├── host/address.ts       dsh-resource:// address → a path in the session
│                         workspace, canonicalised and confined
├── client/
│   ├── index.tsx         documentPreviews + slot body registration
│   ├── core/embedded-view.ts   the iframe, its lifetime, the open entry point
│   ├── core/view-events.ts     the postMessage bridge, the capability, batching
│   ├── components/icons.tsx    the strip's seven glyphs and the icon button
│   │                           that draws one under a tooltip
│   └── components/*Viewer.tsx  container, mode switch, status line, native
│                               actions, the refresh prompt
└── scripts/              vendor-views.mjs, build.mjs
```

## Tests

```sh
node IAM/plugin/tests/run.mjs
```

`tests/` is a sibling of the packages and the runner is the one Node ships
(`node --test`); there is no test dependency to install, because a profile links
these packages by path and resolves nothing else. `run.mjs` builds each package's
host half first and then runs every `*.test.mjs` beside it. The same precedent as
`IAM/Host/Python/tests`, which uses `unittest` for the same reason.

The renderer's C++ half has its own target, which builds the executable and then
drives it: `cmake --build <tree> --target check_iam_headless`. It runs the option
and overlay unit tests and an end-to-end case (exit code, atomic PPM, byte-for-byte
determinism, view presets) against `mining-test-output/alpha.iamh`.

| File | What it holds |
|---|---|
| `address.test.mjs` | the workspace boundary: `..`, absolute paths, NUL bytes, a symlink out of the workspace, a symlinked ROOT, and a file swapped or rewritten between the check and the open |
| `events.test.mjs` | two documents in one session, a superseded capability, a remounted page, cross-source deduplication, per-instance selection versions, the document-identity rule, and the tool-name collision |
| `selection.test.mjs` | three-page assembly, out-of-order pages, a resent page, and the three flags a reader has to tell apart, read through the tool |
| `bridge.test.mjs` | the browser half's queue: retained batches, a failed capability renewal, 5xx and 4xx retries, and what a full queue drops and counts |
| `recovery.test.mjs` | the BUILT page's shell, driven against a stub DOM and IndexedDB: an autosave made after a Browse→Edit switch, found again by a reload in Edit |
| `wire.test.mjs` | the C++ serializer's actual bytes, fed through the TypeScript validator and the store |
| `bridge-tools.test.mjs` | AlgorithmBridge's definitions: the tool table, every schema, and live calls against the real project where one is present |
| `mining-repository.test.mjs` | MiningRepository's read half: the selection it hands the view, the refusals (an id that is not there, a project outside the session workspace, a columnar store on the web), and that a relative project path resolves against the SESSION's workspace rather than the spawning process's |
| `mining-write.test.mjs` | the write door: that an edit leaves the project byte-identical and writes only a document, that apply publishes exactly one revision in place, that a stale or misapplied document is refused, that an erase cascades, and that a `.iamh` is written back as a `.iamh` |
| `mining-show.test.mjs` | the handshake between the two packages: the tool name the card is keyed by, the card's metadata as it arrives from a session log, the address the panel opens, and the selection table the pane watches |
| `render-document-tool.test.mjs` | Render's definitions and its capability rule (a `--help` without `--view` skips rather than fails), PPM header/truncation handling, the pre-spawn document check and the env-tool refusal, and — when a build and fixture are present — two real renders whose PNGs are compared byte for byte |

**What the suite does NOT cover is any React component.** A client half is
transpiled for Node here, which works for a module that imports nothing at runtime
and cannot work for one that imports React or the slot runtime — so the rule for
a card in this tree is that everything which can be wrong lives in a
React-free module beside it and is driven directly, and the component is left as a
reader of it. `mining-show.test.mjs` is that shape: it drives
`Views/client/core/mining-show.ts` — the metadata narrowing, the address grammar,
which calls may open a panel by themselves, and the table the pane reads a
selection from — while `MiningShowRow.tsx` and the pane's own apply effect, which
only do what those return, are verified in a harness and not here.

### What only a browser can answer

The Mining view's `setVisibleSelection` — "draw only these, and look at them" —
is the one thing in this package that neither `node --test` nor a C++ test can
reach, because the answer is PIXELS. `Views/scripts/verify-selection.mjs` drives
the built page in Chrome over CDP, loads a project through the page's own file
input, calls the entry point and reads the canvas:

```sh
node IAM/plugin/Views/scripts/verify-selection.mjs [project.iam] [elementId]
```

It prints the empty share of the viewport in four states — with everything
shown, after isolating one element, after a selection that matches nothing, and
after `""` again — and checks the orderings those states must have. Measured on
the reference mine: **40.41% / 47.66% / 57.88% / 40.41%**.

It also answers the question that decides whether any of this is cheap: it sets
the selection BEFORE opening the document (which is the order the pane uses) and
records every frame from inside the page, because a flash of the whole mine lasts
one frame and no round trip can catch it. The last frame before the document
appears is the busy overlay (**0% empty** — covered edge to edge), and the first
frame that shows the document is already the isolated one (**48.4% empty**, the
same number the steady state reads). Applying the selection at the attach is what
makes that true, and it is also what keeps `warmBlockModelSurfaces()` from
building a hidden block model's boundary mesh — the octree sweep the code calls
the expensive half — only to hide it again.

**Every discriminating check fails when the call does not reach the view** —
measured by neutering the call in this script, which leaves all four states
reading the same number. That is what makes them worth running.

Two things about the measurement are worth keeping, because both obvious metrics
are wrong. The isolate MOVES THE CAMERA (it frames what it shows), so "how much
of the screen the geometry covers" says nothing. And the ImGui chrome is a
constant ~21% of the canvas, so a colour threshold reads the view's own axis
gizmo: counting "blue" pixels gave 3.45% for the isolated element and 3.46% for a
selection that matched nothing. What separates the states is **how much of the
viewport is EMPTY**, which no camera move and no chrome can fake.

It needs Chrome (name it with `IAX_CHROME` if it is not where Chrome installs),
a built wasm under `build/bin/wasm`, and a project. `IAX_HEADLESS=1` asks for
`--headless=new`; a real window is the default because headless Chrome on this
machine reports "WebGPU adapter is unavailable" and draws nothing.

Two C++ programs verify what only C++ can, and are built with the native
configuration (`IAM_TESTS`, ON by default):

```sh
cmake --build build/CMakePlatforms/linux-native --target IamBridgeShutdownTest IamSelectionPagingTest --parallel 4
./build/bin/linux-native/IamSelectionPagingTest
./build/bin/linux-native/IamBridgeShutdownTest
```

Both build and run on Windows too, out of `build\exe\win-native` — the same
`build.ps1 build native` that produces the editors produces them, because the
native target builds its whole directory:

```powershell
.\build.ps1 build native
.\build\exe\win-native\IamSelectionPagingTest.exe
.\build\exe\win-native\IamBridgeShutdownTest.exe
```

- `IamSelectionPagingTest` publishes a 531-reference selection into the real
  channel and asserts the wire shape. `--dump <path>` writes those exact events
  out, which is what `wire.test.mjs` reads — the two languages' halves of the
  schema checked against each other rather than by eye.
- `IamBridgeShutdownTest` starts the real bridge against a listener that
  accepts and never reads, fills the socket, and asserts that `Stop()` returns.
  **It hangs with the old ordering**, which is how the ordering was found.

  It earned that reputation a second time on Windows. The port first carried the
  POSIX shape over verbatim — `shutdown()`, then `join()`, then close — and hung
  exactly as it had on Linux, because **`shutdown(SD_BOTH)` does not wake a
  thread parked in `send()` on Windows; `closesocket` does.** Measured
  2026-10-09 against a listener that accepts and never reads: still parked five
  seconds after `shutdown`, and back at once with `WSAECONNABORTED` (10053) after
  `closesocket`. The Windows half of `iamNativeEventBridgeStop()` therefore
  closes first and joins second, which is the order the POSIX half deliberately
  avoids. `IamEventBridge.cpp` carries the measurement.

## Status

Working and verified

- both bundles install into a `web` profile and appear in its `dsh.profile.bundles`;
- both appear in `window.__DSH_BOOT__` and in the application combo script, and
  materialize with no console errors;
- the host route serves the view (`.html` `text/html`, `.wasm` `application/wasm`)
  with a path-traversal guard;
- the engine boots through that route on a real WebGPU device and opens a real
  document — `Opened the selected Mining snapshot` for a 31 MB `.iam`;
- the capability handshake, the event intake, deduplication, the tools, the
  agent-injection policy and the native launch were driven end to end against a
  fake Cordis context and a stand-in native program (an event stream from a
  process that connected with a valid token lands in the record; a forged one
  reaches nothing, and neither does a spent one);
- **the real native editor reports through the real wire.** Measured 2026-10-07
  under Xvfb + lavapipe, listening exactly as `host/native.ts` listens and
  spawning `IamDrawing --editable <a 5,725-entity .iamp>` with
  `--iam-ipc`/`--iam-token`: the process connected and greeted, and then, driven
  with synthesized input, sent

  ```
  selection.changed  count 1    refs [{kind:"handle", value:"CE0"}]
  selection.changed  count 531  truncated true   refs 256
  edit.committed     operation "erase"  before "1 object(s) affected"
                     after "erase of 1 object"  refs [{kind:"handle",value:"CE5"}]
  edit.undone        operation "erase"  refs 1
  ```

  The 531-entity case is the one that found a defect: the flag was computed from
  the already-capped reference list, so a truncated selection reported
  `truncated: false`. Fixed in `IamViewEvents.cpp`, and the case above is the
  re-measurement. **The `refs 256` in that transcript is now three pages** — see
  the Tests section: the same 531-reference selection is asserted to leave the
  channel as offsets 0, 256 and 512 with `more` true, true, false, and the exact
  bytes are fed back through the host half's validator by `wire.test.mjs`.

Verified 2026-10-09 (Windows)

The platform was brought up on Windows 11 against the fork at
`D:\dev\MiningFlatform\iam-harness`. What was checked, and how:

- **64 plugin tests pass, 0 skipped** — including `wire.test.mjs`, which now
  drives the real `IamSelectionPagingTest.exe` out of `build\exe\win-native`
  and feeds its bytes through the TypeScript validator. Three of them were
  **failing before this change** and were fixed here, all of them test scaffolding
  that had fallen behind the source: the bridge's `t` (the host half names its
  refusals now and the pane's dictionary writes them), `loadViewEvents` (the
  module has a value import and Node resolves no extensionless specifier), and
  the recovery page stub (missing `documentElement`, and reading only the first
  inline `<script>` — the theme bootstrap now precedes the shell, so the shell
  was never defined).
- **both C++ programs build and run.** `IamSelectionPagingTest.exe` passes;
  `IamBridgeShutdownTest.exe` passes in 0 ms. The second one **hung on the
  first Windows port** and said nothing on stderr — which is how the Windows
  ordering defect recorded above was found rather than assumed.
- **the `web` carrier serves the views.** The four bundles install into a
  profile, all three with a browser half appear in the boot payload and the combo
  script, each `client.js` downloads, and `/iam-<view>/Iam<View>.wasm`
  answers `200 application/wasm` at 10.6 MB.
- **the `Import` tools resolve and run.** `resolveImportExecutablePath` finds both `.exe`s
  in `build\exe\win-native`, and through the plugin — not merely by hand —
  `describe_drawing` projected a real 2,645-polyline `.iamp`, and `import_mine`
  converted a real 87 MB `.dmb` into an 8.1 MB `.iamh`, reporting
  `cells=1890967 fields=5 maxLevel=9` and `self-check: reload=0 storeBacked=1`.
- **the importer names its product after the source.** `out` became optional and
  defaults to the source's own directory and stem with the extension that tool
  writes, so 「打开dwg文件」 produces the file the user is looking for rather than
  a name the model chose. Measured on a real DWG: the default product is
  byte-identical to the same conversion asked for with `out` spelled out. It is
  recorded here because the Windows session that found it did so through this
  symptom — a call came back `+4120m_level_plan.iamp` for
  `+4120m中段平面图1.dwg`, and the preview's "File not found. It may have been
  moved or deleted." was that name, not a path: the same four documents resolve
  through `workspaceFiles.stat` and `readBytes` unchanged.
- **a Windows path must not carry a backslash into a markdown link destination.**
  The same session then produced a second, subtler miss of the same kind: the
  model linked `D:/…/workspace\+4120m中段平面图1.iamp`, and CommonMark eats a
  backslash before punctuation, so the `/` before the `+4120m` name vanished and
  the click asked for a path that has never existed. `<…>` does not protect it.
  The import tool now answers with a finished `link:` line (forward slashes, whole
  path in `<…>`, the percent-encoding that survives `decodeURIComponent`) for the
  model to copy verbatim — and every path either half reports uses forward
  slashes, which is the spelling this platform's own Windows notes already ask
  for. This is a Windows-only hazard: no POSIX path contains a backslash, so the
  Linux run of the same flow could not have shown it.
- **the view tools say what they need before they are called.** `iam_*_view_selection`
  and `iam_*_view_recent_edits` answer about a document that is open, and the
  record they read is created when a pane asks for its capability — at mount. An
  agent that called them first got the refusal (`请先在 Harness 中打开图纸预览`)
  as a tool error, which reads as a defect rather than as an ordering rule. Both
  descriptions now open with the precondition and say how a preview is mounted:
  `iam_mining_show` opens the project in the panel — the WebAssembly view, and the
  route a tool call ordinarily takes — while the native editor is a separate
  program the user starts from the page ("在原生中浏览 / 在原生中编辑"). The
  first version of that text said "no tool call can mount one", which was wrong in
  the direction that costs a turn: it sent the model to ask the user for something
  it had a tool for. The names come from `host/domains.ts` rather than the shared
  text, because Drawing publishes no such tool and must not be offered one — the
  same drift that file exists to stop. The refusal itself stays a refusal, because
  an empty selection and a session with no view at all are different answers.
- **the desktop carrier boots.** `pnpm run start:desktop` reaches
  `DevTools listening` and serves its UI. It needed one harness-side fix: the dev
  launcher passed `ELECTRON_RUN_AS_NODE` through from the parent shell, and with
  it set `electron.exe` runs as plain Node, rejects `--remote-debugging-port` and
  `--user-data-dir` as unknown Node options, and exits before any window exists.
  `apps/desktop/scripts/dev.ts` now removes it, as `test-signed-updates.mjs`
  already did for the same reason.

Still open on Windows, and why: **the four plugins are not installed into the
desktop carrier**, because they cannot be from the CLI. `dsh plugin --profile
desktop` is refused outright — `profile "desktop" is managed exclusively by the
Electron application` (`apps/cli/src/args.ts:80-85`) — so the desktop profile is
added to from the application's own plugin manager, which no one has driven here.
The same is true of `nativeBinDir`/`fontsDir`: they are set in the `web`
profile's patch layer, so a desktop run needs them in that profile's layer too,
or in `IAM_NATIVE_DIR`/`IAM_FONTS_DIR`, which both halves read and which
no profile owns.

Verified 2026-10-07 (this change)

- 64 plugin tests pass (`node IAM/plugin/tests/run.mjs`), covering the workspace
  boundary, multi-document and multi-instance isolation, cross-source
  deduplication, selection paging and version change, the browser queue's retry
  and gap accounting, the C++ wire format read by the TypeScript validator, and
  the built page's Browse→Edit recovery;
- two of them were checked AGAINST THE OLD CODE and fail there: the recovery test
  files its autosave under `…:browse` when `setEditable` does not re-derive the
  key, and `IamBridgeShutdownTest` hangs outright when `Stop()` joins before
  it shuts the socket down;
- `IamBridgeShutdownTest` passes in 0 ms with the fix, measured both ways on
  this machine;
- the affected targets build: `IamDrawingView`, `IamMiningView` (wasm),
  `IamDrawing`, `IamMining`, and both test programs.

Not yet verified by hand

- **The preview pane has not been photographed inside the Harness UI.** The
  integration is verified at every layer below that; opening a document in the
  sidebar needs a session, which the check did not set up.
- **A native editor has not been started from inside the Harness**, only the
  launcher and the wire it uses (against a stand-in) and the binary itself
  (against a listener). What is untested is the one path that joins them: the
  desktop shell's `profileContext.name`, the configured directories and
  `spawn()`.
