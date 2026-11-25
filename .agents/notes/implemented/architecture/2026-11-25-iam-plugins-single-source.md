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
sibling IAX checkout nor `IAX_PLATFORM_ROOT` is available.
