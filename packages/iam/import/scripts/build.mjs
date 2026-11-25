#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const buildScriptDirectory = dirname(fileURLToPath(import.meta.url))
const pluginPackageDirectory = resolve(buildScriptDirectory, '..')
const requirePackage = createRequire(import.meta.url)

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
function findHarnessCheckoutCandidates(startDirectory) {
  const checkoutCandidates = process.env.DSH_HARNESS_ROOT ? [process.env.DSH_HARNESS_ROOT] : []
  let currentDirectory = startDirectory
  for (;;) {
    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) break
    for (const checkoutName of ['iam-harness', 'deepseek-harness'])
      checkoutCandidates.push(join(parentDirectory, checkoutName))
    currentDirectory = parentDirectory
  }
  return checkoutCandidates
}

/** Locate the TypeScript compiler, preferring an explicit override. */
function loadTypeScript() {
  const candidates = [
    process.env.DSH_TYPESCRIPT,
    ...findHarnessCheckoutCandidates(buildScriptDirectory).map((checkoutDirectory) => join(checkoutDirectory, 'node_modules', 'typescript')),
    'typescript',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return requirePackage(candidate)
    } catch {
      // Try the next root; the last failure is reported by the caller.
    }
  }
  throw new Error(
    'TypeScript not found; set DSH_TYPESCRIPT to a typescript package directory, ' +
      'or DSH_HARNESS_ROOT to the Harness checkout that has one.',
  )
}

const typescriptCompiler = loadTypeScript()

const COMPILER_OPTIONS = {
  target: typescriptCompiler.ScriptTarget.ES2020,
  module: typescriptCompiler.ModuleKind.ESNext,
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
const HOST_MODULE_SOURCE_PATHS = [
  'host/index.ts',
  'host/import-and-describe-tools.ts',
  'host/native-tool-process.ts',
  'host/native-tool-paths.ts',
]

function buildHostModules() {
  for (const relativeSourcePath of HOST_MODULE_SOURCE_PATHS) {
    const sourcePath = resolve(pluginPackageDirectory, relativeSourcePath)
    const sourceText = readFileSync(sourcePath, 'utf8')
    const compiledModule = typescriptCompiler.transpileModule(sourceText, {
      compilerOptions: COMPILER_OPTIONS, fileName: sourcePath,
    })
    const relativeOutputPath = `lib/${relativeSourcePath.slice('host/'.length).replace(/\.ts$/, '.js')}`
    writeCompiledHostModule(relativeOutputPath, compiledModule.outputText)
  }
  process.stdout.write(`host: ${HOST_MODULE_SOURCE_PATHS.length} modules -> lib/\n`)
}

function writeCompiledHostModule(relativeOutputPath, javascriptSource) {
  const outputPath = resolve(pluginPackageDirectory, relativeOutputPath)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, javascriptSource)
}

const buildMode = process.argv[2]
if (buildMode === 'host') buildHostModules()
else {
  process.stderr.write('usage: build.mjs host\n')
  process.exit(2)
}
