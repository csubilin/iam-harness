/** Build a complete IAM Harness installer with the built-in mining plugins. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

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
// The committed wasm views and native viewers must match the platform build they came from.
pnpm(['run', 'check:iam-views'], env)
pnpm(['run', 'check:iam-native'], env)
pnpm(['run', 'package:desktop', '--', ...argumentsToPackage], env)

const explicitTarget = forwarded.find(argument => TARGET_NAMES.has(argument))
const target = explicitTarget ?? (process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
const artifacts = installerFiles(target)
console.log(artifacts.length === 0
  ? `package:iam: no installer found under apps/desktop/.desktop-build/targets/${target}`
  : `package:iam: installer(s):\n${artifacts.map(file => `  ${relative(ROOT, file)}`).join('\n')}`)
if (!existsSync(process.env.IAX_PLATFORM_ROOT ?? join(ROOT, '..', 'IAX'))) {
  console.log('package:iam: note: no IAX platform checkout found; iam_* algorithm execution needs IAX_PLATFORM_ROOT at runtime')
}
