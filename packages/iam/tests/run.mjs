#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOOL_PACKAGES, VIEW_PACKAGES, buildHost, pluginRoot } from './helpers.mjs'

// A sibling IAX checkout supplies the native platform and Python algorithms;
// without it the platform-dependent cases fail to import rather than skip.
const adjacentPlatform = resolve(pluginRoot, '..', '..', '..', 'IAX')
if (process.env.IAX_PLATFORM_ROOT === undefined && existsSync(join(adjacentPlatform, 'IAM', 'Host', 'Python'))) {
  process.env.IAX_PLATFORM_ROOT = adjacentPlatform
}

for (const packageName of [...VIEW_PACKAGES, ...TOOL_PACKAGES]) {
  process.stdout.write(`building ${packageName} (host)\n`)
  buildHost(packageName)
}

// The files are named rather than given to the runner as a directory or a glob:
// what `node --test` accepts as an argument has changed between Node versions,
// and a list of paths is the one spelling that means the same thing in all of
// them.
const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((entry) => entry.endsWith('.test.mjs'))
  .sort()
  .map((entry) => join(here, entry))

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: pluginRoot,
})
process.exit(result.status ?? 1)
