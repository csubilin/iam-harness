/** Build a complete IAM Harness installer with the built-in mining plugins. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pythonSource, stageIfStale, STAGED_RUNTIME } from './stage-iam-python.ts'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET_NAMES = new Set(['win-x64', 'mac-arm64', 'mac-x64'])

function pnpm(args: readonly string[], env: NodeJS.ProcessEnv): void {
  const entry = process.env.npm_execpath
  if (entry === undefined || entry === '') throw new Error('package:iam must be invoked through a pnpm package command')
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: ROOT, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/** The package scripts require the Node floor the engine field declares. */
function requireNodeFloor(): void {
  const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node as string | undefined
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number)
  // shortcut: only the ^24.22.3 || >=26.13.1 range the repository declares.
  const supported = major >= 26 && (major > 26 || minor > 13 || (minor === 13 && patch >= 1))
    || major === 24 && (minor > 22 || (minor === 22 && patch >= 3))
  if (!supported) {
    throw new Error(`package:iam needs Node ${String(engines)} (current ${process.versions.node}); `
      + 'install a matching Node before running it')
  }
}

/** Installer files produced under one target, printed after the build. */
function installerFiles(target: string): string[] {
  const base = join(ROOT, 'apps', 'desktop', '.desktop-build', 'targets', target)
  const found: string[] = []
  for (const directory of ['unsigned-artifacts', 'artifacts', 'unnotarized-artifacts']) {
    const path = join(base, directory)
    if (!existsSync(path)) continue
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:exe|dmg|zip)$/u.test(entry.name)) found.push(join(path, entry.name))
    }
  }
  return found.sort()
}

/** A Windows installer embeds the viewers it reads from the IAX native build at pack time. */
function requireNativeViewers(): void {
  const iax = process.env.IAX_ROOT ?? join(ROOT, '..', 'IAX')
  const native = process.env.IAX_NATIVE_DIR ?? join(iax, 'build', 'exe', 'win-native')
  const required = [
    join(native, 'IamDrawing.exe'),
    join(native, 'IamMining.exe'),
    // iam_render_document resolves this one from the same directory.
    join(native, 'IamNativeHeadlessMining.exe'),
    // import_mine and describe_drawing resolve these three from it too.
    join(native, 'IamImportTool.exe'),
    join(native, 'IaxDrawingImportTool.exe'),
    join(native, 'IaxDrawingQuery.exe'),
    process.env.IAX_FONTS ?? join(iax, 'Fonts'),
    process.env.IAX_RESOURCE ?? join(iax, 'resource'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`package:iam: the Windows installer ships the IAX native viewers, renderer and importers, but ${missing.join(', ')} is missing; `
      + 'build the IAX native target or set IAX_NATIVE_DIR / IAX_FONTS / IAX_RESOURCE')
  }
}

/**
 * A Windows installer also carries the algorithm bridge's Python half: the IAX
 * bindings and a Python 3.14 runtime matched to them, staged out of the UCRT64
 * Python the bindings were built with unless the environment names another.
 */
function requireIamAlgorithms(environment: NodeJS.ProcessEnv): void {
  const iax = environment.IAX_ROOT ?? join(ROOT, '..', 'IAX')
  const algorithms = environment.IAM_PYTHON_PACKAGE_DIR
    ?? join(iax, 'build', 'CMakePlatforms', 'win-native', 'IAM', 'Host', 'Python')
  const mining = environment.IAM_MINING_PYTHON_DIR ?? join(iax, 'Mining', 'Host', 'python')
  const runtime = environment.IAM_PYTHON_RUNTIME_DIR
  const python = runtime === undefined ? [] : [
    join(runtime, 'python.exe'), join(runtime, 'bin', 'python.exe'), join(runtime, 'bin', 'python3'),
  ].filter(candidate => existsSync(candidate))
  const problems = [
    ...runtime === undefined
      ? ['IAM_PYTHON_RUNTIME_DIR is not set and staging one failed']
      : python.length === 0 ? [`${runtime} has no python executable`] : [],
    ...existsSync(join(algorithms, 'iam_algorithms')) ? [] : [`${join(algorithms, 'iam_algorithms')} is missing`],
    ...existsSync(join(mining, 'iam')) ? [] : [`${join(mining, 'iam')} is missing`],
  ]
  if (problems.length > 0) {
    throw new Error(`package:iam: the Windows installer ships the IAM algorithm bridge, but ${problems.join('; ')}; `
      + 'build the IAX native target or set IAM_PYTHON_RUNTIME_DIR / IAM_PYTHON_PACKAGE_DIR / IAM_MINING_PYTHON_DIR')
  }
  // The staged interpreter must carry its MSYS2 runtime DLLs, not borrow them
  // from the build machine's PATH: the installed application has no MSYS2.
  const interpreter = python[0]
  if (interpreter === undefined) {
    throw new Error('package:iam: the staged Python runtime has no interpreter')
  }
  // PowerShell stores the variable as `Path`; a copied env object reads keys
  // case-sensitively, and this file already normalizes it for the pack step.
  const pathKey = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  const probe = spawnSync(interpreter, ['-I', '-c', 'import binascii, hashlib, zipfile, xml.etree.ElementTree'], {
    env: {
      ...environment,
      [pathKey]: [dirname(interpreter), join(environment.SystemRoot ?? 'C:\\Windows', 'System32')].join(';'),
    },
    encoding: 'utf8',
  })
  if (probe.status !== 0) {
    throw new Error(`package:iam: ${interpreter} cannot run its own standard library `
      + `(${probe.error?.message ?? probe.stderr.trim()}); re-stage the runtime with pnpm run stage:iam-python`)
  }
}

/**
 * The CapabilityForge Python half reads its schemas and templates from the
 * package root, so the three travel together outside `app.asar`.
 */
function requireCapabilityForge(): void {
  const forge = join(ROOT, 'packages', 'iam', 'capability-forge')
  const required = [
    join(forge, 'python', 'capability.py'),
    join(forge, 'templates'),
    join(forge, 'schemas'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`package:iam: the Windows installer ships the CapabilityForge Python half, but ${missing.join(', ')} is missing`)
  }
}

/**
 * The packaged Desktop's default programRunner is the harness Windows ACL
 * runner, reached through the IAM adapter; both must be present to ship it.
 */
function requireIamSandbox(): void {
  const required = [
    join(ROOT, 'apps', 'desktop', 'resources', 'iam-sandbox', 'runner-wrapper.cjs'),
    join(ROOT, 'packages', 'sandbox', 'sandbox-windows-acl', 'src', 'runner.ts'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`package:iam: the Windows installer ships the IAM programRunner, but ${missing.join(', ')} is missing`)
  }
}

const forwarded = process.argv.slice(2).filter(argument => argument !== '--')
const signed = forwarded.includes('--signed')
const argumentsToPackage = forwarded.filter(argument => argument !== '--signed')
if (!signed) argumentsToPackage.push('--unsigned')

requireNodeFloor()
// GitHub is unreachable here; Electron's download needs the mirror unless set.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
}
// Git Bash's GNU tar reads D:\... as a remote host; the pack steps need Windows bsdtar.
if (process.platform === 'win32') {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  // PowerShell and cmd spell it `Path`; a copied env object reads keys
  // case-sensitively, so `env.PATH` would leave the child with only System32.
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  env[key] = `${system32};${env[key] ?? ''}`
}
// The committed wasm views must match the platform build they came from.
pnpm(['run', 'check:iam-views'], env)
const explicitTarget = forwarded.find(argument => TARGET_NAMES.has(argument))
const target = explicitTarget ?? (process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
if (target === 'win-x64') {
  // The bindings are MSYS2 cp314 builds; stage the matching interpreter once
  // unless the environment already names one.
  if (env.IAM_PYTHON_RUNTIME_DIR === undefined) {
    stageIfStale(pythonSource(process.env), STAGED_RUNTIME)
    env.IAM_PYTHON_RUNTIME_DIR = STAGED_RUNTIME
  }
  requireNativeViewers()
  requireIamAlgorithms(env)
  requireCapabilityForge()
  requireIamSandbox()
}
pnpm(['run', 'package:desktop', '--', ...argumentsToPackage], env)

const artifacts = installerFiles(target)
console.log(artifacts.length === 0
  ? `package:iam: no installer found under apps/desktop/.desktop-build/targets/${target}`
  : `package:iam: installer(s):\n${artifacts.map(file => `  ${relative(ROOT, file)}`).join('\n')}`)
if (!existsSync(process.env.IAX_PLATFORM_ROOT ?? join(ROOT, '..', 'IAX'))) {
  console.log('package:iam: note: no IAX platform checkout found; iam_* algorithm execution needs IAX_PLATFORM_ROOT at runtime')
}
