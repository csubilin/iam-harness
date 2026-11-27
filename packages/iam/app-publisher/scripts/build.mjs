#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * Where a Harness checkout could be, given where this file sits. No candidate is
 * an absolute path: this package carries no `node_modules`, so the compiler is
 * borrowed from a checkout named by DSH_HARNESS_ROOT or found beside this
 * repository.
 */
function harnessRoots(from) {
  const roots = process.env.DSH_HARNESS_ROOT ? [process.env.DSH_HARNESS_ROOT] : []
  let dir = from
  for (;;) {
    const parent = dirname(dir)
    if (parent === dir) break
    for (const name of ['iam-harness', 'deepseek-harness']) roots.push(join(parent, name))
    dir = parent
  }
  return roots
}

function loadTypeScript() {
  const candidates = [
    process.env.DSH_TYPESCRIPT,
    ...harnessRoots(here).map((dir) => join(dir, 'node_modules', 'typescript')),
    'typescript',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Try the next root; the last failure is reported by the caller.
    }
  }
  throw new Error(
    'TypeScript not found; set DSH_TYPESCRIPT to a typescript package directory, ' +
      'or DSH_HARNESS_ROOT to the Harness checkout that has one.',
  )
}

/**
 * Every host module, named explicitly: the build emits one output file per
 * entry rather than bundling, so a new host file that is not listed here is not
 * written to lib/ and its import fails at load -- visibly.
 */
const HOST_MODULES = ['host/index.ts', 'host/tools.ts', 'host/publish.ts']

function buildHost() {
  const ts = loadTypeScript()
  const options = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    sourceMap: false,
  }
  for (const relativePath of HOST_MODULES) {
    const entry = resolve(root, relativePath)
    const source = readFileSync(entry, 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: options, fileName: entry })
    write(`lib/${relativePath.slice('host/'.length).replace(/\.ts$/, '.js')}`, output.outputText)
  }
  process.stdout.write(`host: ${HOST_MODULES.length} modules -> lib/\n`)
}

function write(relativePath, contents) {
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

const mode = process.argv[2]
if (mode === 'host') {
  buildHost()
} else if (mode === 'clean') {
  // lib/ is generated output (gitignored), not a source tree. `postpack` removes
  // it so a packed archive carries what the build just produced and a checkout
  // rebuilds on demand.
  rmSync(resolve(root, 'lib'), { recursive: true, force: true })
  process.stdout.write('clean: lib/ removed\n')
} else {
  process.stderr.write('usage: build.mjs host|clean\n')
  process.exit(2)
}
