# @deepseek-ai/iam-render

One tool, `iam_render_document`: the platform's own headless renderer
(`IamNativeHeadlessMining`) as something an agent can call.

## Why it exists

Figures for a report, a review of what a build produced, and an agent checking
its own work all need a picture of a document. Doing that from outside the
platform means reimplementing a renderer -- which is what I had been doing, with
a numpy rasterizer whose shading and framing had nothing to do with what the
application shows. This package removes that: it runs the application's own
renderer and hands back a PNG.

It is a **tool** and not a view, so it loads in `headless`, `sdk` and `acp`, which
mount no page.

## What it does

```
iam_render_document(document, out?, width?, height?, view?, fitElements?,
                    fitBbox?, overlay?, imgui?, camera?, timeoutSeconds?)
```

* runs `IamNativeHeadlessMining --width W --height H … document --out <scratch>/frame.ppm`
* converts the `P6` PPM to PNG in-process (a 1600x1000 PPM is 4.8 MB; the PNG is a
  few hundred KB) and deletes the scratch directory
* returns the PNG path, its size, the command line that produced it, and any
  option that had to be skipped

**Capabilities are probed, not assumed.** `--view`, `--fit-elements`,
`--fit-bbox` and `--overlay` do not exist in every build. The tool reads `--help`
once per executable (keyed by path, size and mtime, so a rebuild is re-probed),
uses the options that are listed, and reports the rest as `skipped` in its
result -- so it works before and after those options land, without silently
behaving differently.

**Framing precedence** is the renderer's: an explicit `camera` beats
`fitElements`, which beats `fitBbox`, which beats `view`, which beats a plain
`--fit`. Only one of them is passed; the others that were requested are named in
`skipped` as `superseded by …` rather than disappearing.

**A good frame with a bad exit is still a frame.** The Windows build used to
write a correct frame and then die with `0xC0000005` during teardown. The tool
treats a present, well-formed frame as the result, reports the exit code beside
it, and says so in `note`. That is a workaround for a defect in the tool, not a
licence to ignore failures: a missing or truncated frame is an error, and the
message carries the command line and the renderer's stderr tail.

**The command is reproducible.** The render itself writes into a scratch
directory beside the PNG, so a failed render can never be mistaken for a
pre-existing file. The `command` field names `<out>.ppm` beside the PNG instead
of that scratch path, so it can be pasted into a shell and produces the same
frame. The scratch directory is removed after conversion.

## Where the renderer is found

1. `IAM_NATIVE_HEADLESS_TOOL` if set (resolved; a wrong path is an error, not a
   fall-through)
2. `config.toolsDir`
3. `<repo>/build/exe/win-native/IamNativeHeadlessMining.exe`, then
   `<repo>/build/exe/win/IamNativeHeadlessMining.exe` (Windows);
   `build/bin/<platform>/…` elsewhere

The document is checked -- absolute path, exists -- before any subprocess starts.
A missing element id is reported by the renderer, whose message the tool returns
with the command line.

## Restricted environments

Some sandboxes forbid piped stdio, and Node reports that as `EPERM` on the child
rather than as a throw. The tool:

* treats a failed `--help` probe as "no optional options" (it still renders);
* retries the render with `stdio: 'ignore'`, and says in `note` that the log
  could not be captured.

Without this fallback the plugin is unusable in exactly the environments that
need a batch renderer most.

## Build

```
node scripts/build.mjs host        # host/*.ts -> lib/*.js (transpile only)
```

## Test

```
node --test IAM/plugin/tests/render-document-tool.test.mjs
```

The integration cases skip when no renderer or Mining fixture is in the
checkout; on a built tree they render `mining-test-output/alpha.iamh` twice and
compare the PNGs byte for byte.

## Install into a profile

Add it as a dependency of the profile bundle and give it a row:

```yaml
- insert:
    - id: iam-render
      name: @deepseek-ai/iam-render
```

then reinstall the profile (`pnpm dsh plugin --profile <name> add <this dir>`).
