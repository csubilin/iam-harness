# Agent Note: IAM mining plugins live in one repository

Status: implemented

English | [中文](2026-11-25-iam-plugins-single-source.zh.md)

## Problem

The IAM mining plugins were developed in the separate IAX checkout under
`IAM/plugin` and copied into this repository as `packages/iam` so the product
could ship and enable them as built-in profile bundles. The two copies drifted:
this repository had scoped names, `prepack` scripts and a package-local
workflows source, while IAX still built the old layout. A manual copy could
overwrite either side.

## Decision

`packages/iam` in this repository is the single source of truth. IAX keeps only
the platform (wasm view sources, native libraries, Python algorithms,
`Host`/`ViewCore`) and a pointer README at `IAM/plugin/README.md`. Its
`build.sh`/`build.ps1` delegate the plugin build to this checkout
(`IAM_HARNESS_ROOT`, default `../iam-harness`), and the node:test suite moved to
`packages/iam/tests` (`pnpm run test:iam`).

The one generated artifact that still crosses the boundary is the wasm view
output. `pnpm run sync:iam-views` copies `IamDrawingView.*` and
`IamMiningView.*` from the IAX build (`IAX_WASM_VIEWS`, default sibling
`IAX/build/bin/wasm/views`) into `packages/iam/views/vendor`;
`pnpm run check:iam-views` compares the committed copy and is part of the `iam`
artifact gate. Both skip when no IAX build tree is present. The IAX
`build.sh build web` already runs the same copy as part of its build.

## Consequences

A plugin change is made and tested in this repository; an IAX platform rebuild
refreshes the vendored views automatically or reports drift. No plugin source is
duplicated across repositories. Building the IAX `web` target now requires this
checkout (or `IAM_HARNESS_ROOT`); platform-dependent tests skip when neither a
sibling IAX checkout nor `IAX_PLATFORM_ROOT` is available. `pnpm run package:iam`
builds the complete installer with the plugins included — unsigned by default,
or signed with `--signed` when the release signing environment is configured.

The native viewers are part of that installer, read from the IAX checkout while
packing. electron-builder copies the two viewers, every engine DLL beside them,
the icon resource tree and the SHX fonts out of `IAX/build/exe/win-native` (its
test programs filtered out), `IAX/resource` (its 60 MiB CJK chrome fonts
dropped) and `IAX/Fonts` into `resources/iam-native`; `package:iam` stops with a
clear error when those paths are missing, and `IAX_ROOT`, `IAX_NATIVE_DIR`,
`IAX_FONTS` or `IAX_RESOURCE` point a build at another tree. The packaged
application then points the Host at the copies with `IAM_NATIVE_DIR` /
`IAM_FONTS_DIR` (an explicit setting still wins), so the views plugin's native
browse/edit actions launch without configuration. None of it is committed: an
IAX rebuild is picked up by the next packaging run rather than by a sync commit.

The algorithm bridge travels the same way. Python cannot read an asar archive,
so the packaged application keeps `resources/iam-algorithms` outside it:
`python/bridge.py`, `python/vendor/iam_algorithms` and `iam` from the IAX build,
the built workflows, and a Python runtime matched to the bindings
(`IAM_PYTHON_RUNTIME_DIR`, required at packaging time — the bindings are MSYS2
cp314 builds and import `libpython3.14.dll`). `main.ts` names the script and
interpreter to the Host with `IAM_BRIDGE_SCRIPT` / `IAM_BRIDGE_PYTHON`, and the
bridge host prepends `IAM_NATIVE_DIR` to PATH so the nanobind extension finds
the IAX DLLs beside the native viewers.
