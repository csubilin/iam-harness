#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const vendorRoot = resolve(root, 'python', 'vendor')
const require = createRequire(import.meta.url)

/**
 * Where a Harness checkout could be, given where this file sits.
 *
 * NO CANDIDATE HERE IS AN ABSOLUTE PATH. This package carries no `node_modules`
 * of its own -- a profile links it by path and resolves nothing else -- so the
 * compiler is borrowed from a Harness checkout, named by DSH_HARNESS_ROOT, or
 * else found as a sibling directory of this repository. The walk goes up until
 * the filesystem stops it rather than counting `..` segments, so it does not
 * care how deep the file that asks happens to sit.
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

/**
 * Every host module, and the list is explicit because the build emits one output
 * file per entry rather than bundling: a new host file that is not named here is
 * not written to lib/, and the import of it fails at load -- visibly, as "failed
 * to import" for the whole plugin.
 */
const HOST_MODULES = ['host/index.ts', 'host/tools.ts', 'host/python.ts']

function buildHost() {
  const ts = loadTypeScript()
  const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    sourceMap: false,
  }
  for (const relativePath of HOST_MODULES) {
    const entry = resolve(root, relativePath)
    const source = readFileSync(entry, 'utf8')
    const output = ts.transpileModule(source, { compilerOptions, fileName: entry })
    write(`lib/${relativePath.slice('host/'.length).replace(/\.ts$/, '.js')}`, output.outputText)
  }
  // MIRROR, NOT ACCUMULATE: a workflow removed from the source tree must not
  // survive in the packaged copy. The example moved under Examples/; without
  // this, an old top-level copy would remain discoverable in a deployed package.
  rmSync(resolve(root, 'workflows'), { recursive: true, force: true })
  cpSync(resolve(root, 'workflows-source'), resolve(root, 'workflows'), { recursive: true, force: true,
    filter: (source) => !source.includes(`${process.platform === 'win32' ? '\\' : '/'}__pycache__`) && !source.endsWith('.pyc') })
  process.stdout.write(`host: ${HOST_MODULES.length} modules -> lib/\n`)
}

function cleanVendor() {
  rmSync(vendorRoot, { recursive: true, force: true })
}

function stageVendor() {
  // A plugin archive must include the matching compiled extension and runtime,
  // not source files that silently rely on an unrelated checkout's build.
  const platform = { win32: 'win-native', linux: 'linux-native', darwin: 'macos-native' }[process.platform]
  const staged = process.env.IAM_PYTHON_PACKAGE_DIR ||
    resolve(root, '..', '..', '..', 'build', 'CMakePlatforms', platform || '', 'python-package')
  const algorithms = resolve(staged, 'iam_algorithms')
  const manifest = resolve(algorithms, 'data', 'runtime.json')
  if (!existsSync(manifest) || !readdirSync(algorithms).some((name) => /^_native.*\.(pyd|so)$/.test(name))) {
    throw new Error('Build CMake target stage_iam_python and set IAM_PYTHON_PACKAGE_DIR to its python-package directory')
  }
  cleanVendor()
  for (const [source, target] of [
    [algorithms, 'iam_algorithms'],
    ['../../../Mining/Host/python/iam', 'iam'],
  ]) {
    const from = resolve(root, source)
    const to = resolve(vendorRoot, target)
    if (!existsSync(from)) throw new Error(`Python binding package is missing: ${from}`)
    cpSync(from, to, {
      recursive: true, force: true, filter: (path) => !path.endsWith('.pyc') && !path.includes('__pycache__'),
    })
  }
  for (const name of ['algorithm-results.schema.json', 'geometry-payload.schema.json']) {
    write(`python/vendor/iam_algorithms/data/${name}`,
      readFileSync(resolve(root, '..', '..', 'Algorithms', name), 'utf8'))
  }
}

function write(relativePath, contents) {
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

const mode = process.argv[2]
if (mode === 'host') {
  buildHost()
  cleanVendor()
} else if (mode === 'package') {
  buildHost()
  stageVendor()
} else if (mode === 'clean') cleanVendor()
else {
  process.stderr.write('usage: build.mjs host|package|clean\n')
  process.exit(2)
}
