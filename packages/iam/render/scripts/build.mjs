#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const ts = loadTypeScript()

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  sourceMap: false,
}

/**
 * Every host module, and the list is explicit because the build emits one output
 * file per entry rather than bundling: a new host file that is not named here is
 * not written to lib/, and the import of it fails at load -- visibly.
 */
const HOST_MODULES = [
  'host/index.ts',
  'host/render-document-tool.ts',
  'host/headless-render-process.ts',
  'host/headless-renderer-path.ts',
  'host/ppm-to-png.ts',
]

function buildHost() {
  for (const relativePath of HOST_MODULES) {
    const entry = resolve(root, relativePath)
    const source = readFileSync(entry, 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: entry })
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
if (mode === 'host') buildHost()
else {
  process.stderr.write('usage: build.mjs host\n')
  process.exit(2)
}
