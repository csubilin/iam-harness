#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * Where a Harness checkout could be, given where this file sits.
 *
 * NO CANDIDATE HERE IS AN ABSOLUTE PATH.  This package carries no `node_modules`
 * of its own -- a profile links it by path and resolves nothing else -- so the
 * compiler is borrowed from a Harness checkout, named by DSH_HARNESS_ROOT, or
 * else found as a sibling directory of this repository.  The walk goes up until
 * the filesystem stops it rather than counting `..` segments.
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

/** Locate the TypeScript compiler, preferring an explicit override. */
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
 * not written to lib/, and the import of it fails at load -- visibly, as "failed
 * to import" for the whole plugin.
 */
const HOST_MODULES = ['host/index.ts', 'host/tools.ts', 'host/python.ts', 'host/native.ts']

function excludesPyc(path) {
  return !path.endsWith('.pyc') && !path.includes('__pycache__')
}

function buildHost() {
  for (const relativePath of HOST_MODULES) {
    const entry = resolve(root, relativePath)
    const source = readFileSync(entry, 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: entry })
    write(`lib/${relativePath.slice('host/'.length).replace(/\.ts$/, '.js')}`, output.outputText)
  }
  // ONE vendored package, and only the one this plugin's Python imports: the
  // binding that opens a project.  AlgorithmBridge vendors `iam_algorithms` too
  // because it runs the algorithm catalog; this half measures nothing.
  // The vendored copy is committed so the package builds without the IAX source tree;
  // refresh it from the platform checkout when the Python binding changes.
  const pythonSource = resolve(root, '../../../Mining/Host/python/iam')
  if (existsSync(pythonSource)) {
    cpSync(pythonSource, resolve(root, 'python', 'vendor', 'iam'),
      { recursive: true, force: true, filter: excludesPyc })
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
