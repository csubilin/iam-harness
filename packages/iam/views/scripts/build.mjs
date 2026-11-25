#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * Where a Harness checkout could be, given where this file sits.
 *
 * NO CANDIDATE HERE IS AN ABSOLUTE PATH. These packages carry no `node_modules`
 * of their own -- a profile links them by path and resolves nothing else -- so
 * the compiler is borrowed from a Harness checkout, named by DSH_HARNESS_ROOT,
 * or else found as a sibling directory of this repository. The walk goes up
 * until the filesystem stops it rather than counting `..` segments, so it does
 * not care how deep the file that asks happens to sit.
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
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  sourceMap: false,
}

/** Extensions tried, in order, when a relative specifier names no file. */
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']

function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  for (const extension of EXTENSIONS) {
    const candidate = base + extension
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  throw new Error(`cannot resolve "${specifier}" from ${relative(root, fromFile)}`)
}

/**
 * Walk the import graph from `entry`, transpiling every module and recording
 * each relative specifier's mapping to a module id.
 */
function collect(entry) {
  const modules = new Map()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()
    if (modules.has(file)) continue
    const source = readFileSync(file, 'utf8')
    const { importedFiles } = ts.preProcessFile(source, true, true)
    const deps = {}
    for (const imported of importedFiles) {
      if (!imported.fileName.startsWith('.')) continue
      const target = resolveRelative(file, imported.fileName)
      deps[imported.fileName] = relative(root, target).split('\\').join('/')
      pending.push(target)
    }
    const output = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: file })
    modules.set(file, { id: relative(root, file).split('\\').join('/'), code: output.outputText, deps })
  }
  return modules
}

/** Emit the browser half: one self-registering lazy factory. */
function buildClient() {
  const entry = resolve(root, 'client/index.tsx')
  const modules = collect(entry)
  const entryId = relative(root, entry).split('\\').join('/')
  const packageName = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name

  const definitions = [...modules.values()]
    .map(
      (module) => `  ${JSON.stringify(module.id)}: {\n` +
        `    deps: ${JSON.stringify(module.deps)},\n` +
        `    factory: function (module, exports, require) {\n${indent(module.code, 6)}\n    },\n  },`,
    )
    .join('\n')

  const body = `var __definitions = {\n${definitions}\n};
var __cache = {};
function __load(id) {
  var cached = __cache[id];
  if (cached) return cached.exports;
  var definition = __definitions[id];
  if (!definition) throw new Error('module ' + id + ' is not in this bundle');
  var module = { exports: {} };
  __cache[id] = module;
  var localRequire = function (specifier) {
    var target = definition.deps[specifier];
    if (target !== undefined) return __load(target);
    return require(specifier);
  };
  definition.factory(module, module.exports, localRequire);
  return module.exports;
}
module.exports = __load(${JSON.stringify(entryId)});
`

  const output = `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {\n` +
    `var module = { exports: {} }; var exports = module.exports;\n${body}` +
    `return module.exports; } });\n`

  write('lib/client.js', output)
  assertViewsVendored()
  process.stdout.write(`client: ${modules.size} module(s) -> lib/client.js\n`)
}

/**
 * Every domain this package serves must have its view vendored.
 *
 * This replaces `assertOwnView`, which existed because Drawing and Mining were
 * two packages kept in step by copying one over the other, and one copy shipped
 * a client that framed the sibling's page -- a `.iam` document rendered by the
 * Drawing engine, visible only in a screenshot.
 *
 * One package and one table removed that failure mode rather than guarding it:
 * `EmbeddedView` reads the route and the page off the same `domain` object, so
 * they cannot disagree. What can still go wrong is a domain whose view was never
 * vendored, which is the same mistake one step earlier. An absent `vendor/` is
 * not checked, because the vendor step runs after the host build in a fresh
 * checkout.
 */
function assertViewsVendored() {
  const domains = readFileSync(resolve(root, 'host', 'domains.ts'), 'utf8')
  const pages = [...domains.matchAll(/page: '([^']+)'/g)].map((match) => match[1])
  if (pages.length === 0) throw new Error('host/domains.ts declares no page')
  const vendor = resolve(root, 'vendor')
  if (!existsSync(vendor)) return
  for (const page of pages) {
    if (!existsSync(resolve(vendor, page))) {
      throw new Error(`${page} is declared in host/domains.ts but was not vendored`)
    }
  }
}

/**
 * Emit the Node half: plain ESM, one output file per source file.
 *
 * Not bundled, and not a single file either. The host half is ESM run directly
 * by Node, so a relative import needs its extension — `./native.js` — and the
 * module it names has to exist beside it. Transpiling the entry alone left the
 * import pointing at a file nothing had written.
 */
// Every host module, and the list is explicit because the build emits one
// output file per entry rather than bundling: a new host file that is not
// named here is not written to lib/, and the import of it fails at load --
// visibly, as "failed to import" for the whole plugin.
// `host/engine.ts` is gone with the remote-frame path it belonged to; what is
// named here is the routes, the session record they write into, the two tools
// that read it, and the address resolver they all share.
const HOST_MODULES = [
  'host/drawing-entity-query.ts',
  'host/index.ts',
  'host/events.ts',
  'host/native.ts',
  'host/tools.ts',
  'host/address.ts',
  'host/domains.ts',
]

function buildHost() {
  for (const relativePath of HOST_MODULES) {
    const entry = resolve(root, relativePath)
    const source = readFileSync(entry, 'utf8')
    const output = ts.transpileModule(source, {
      compilerOptions: { ...COMPILER_OPTIONS, module: ts.ModuleKind.ESNext },
      fileName: entry,
    })
    write(`lib/${relativePath.slice('host/'.length).replace(/\.ts$/, '.js')}`, output.outputText)
  }
  process.stdout.write(`host: ${HOST_MODULES.length} modules -> lib/\n`)
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n')
}

function write(relativePath, contents) {
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

const mode = process.argv[2]
if (mode === 'client') buildClient()
else if (mode === 'host') buildHost()
else {
  process.stderr.write('usage: build.mjs <client|host>\n')
  process.exit(2)
}
