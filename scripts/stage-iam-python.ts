/**
 * Stage the Python runtime the IAM algorithm bindings need.
 *
 * The bindings are MSYS2 cp314 builds that import `libpython3.14.dll`, so no
 * python.org or embeddable distribution can load them; the matching interpreter
 * is copied out of the UCRT64 Python the IAX native target was built with
 * (`IAM_MSYS2_ROOT`, default `D:\msys64`). Test programs, the tkinter GUI,
 * pip and its bootstrap, and bytecode caches stay behind: the bridge only
 * imports the standard library and `iam_algorithms`.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = resolve(import.meta.dirname, '..')

/** Lean-runtime root used by `package:iam` when the environment names no other. */
export const STAGED_RUNTIME = join(ROOT, 'apps', 'desktop', '.desktop-build', 'iam-python-runtime')

/** The interpreter files copied beside the stdlib. */
const BIN_FILES = ['python.exe', 'python3.14.exe', 'libpython3.14.dll', 'libgcc_s_seh-1.dll', 'libffi-8.dll']

/** Stdlib directories the bridge never imports. */
const SKIP_DIRECTORIES = new Set([
  'test', 'site-packages', 'tkinter', 'idlelib', 'ensurepip', 'Tools', 'lib2to3', 'turtledemo', 'pydoc_data',
])

/** The MSYS2 UCRT64 installation that built the bindings. */
export function pythonSource(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.IAM_PYTHON_SOURCE ?? join(env.IAM_MSYS2_ROOT ?? 'D:\\msys64', 'ucrt64'))
}

/**
 * Copy a lean Python 3.14 runtime out of `source`.
 * @param source - MSYS2 UCRT64 prefix holding bin/ and lib/python3.14.
 * @param out - Destination directory; replaced.
 * @returns The number of files copied.
 */
export function stageIamPython(source: string, out: string): number {
  const required = [
    ...BIN_FILES.map(file => join(source, 'bin', file)),
    join(source, 'lib', 'python3.14'),
  ]
  const missing = required.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`stage-iam-python: ${source} is not a UCRT64 Python 3.14 with the bindings' runtime; `
      + `missing ${missing.join(', ')} (set IAM_MSYS2_ROOT or IAM_PYTHON_SOURCE to one)`)
  }
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'bin'), { recursive: true })
  for (const file of BIN_FILES) cpSync(join(source, 'bin', file), join(out, 'bin', file))
  const library = join(out, 'lib', 'python3.14')
  cpSync(join(source, 'lib', 'python3.14'), library, {
    recursive: true,
    filter: (path) => {
      const name = path.slice(path.replaceAll('\\', '/').lastIndexOf('/') + 1)
      if (name === '__pycache__') return false
      return !(path.replaceAll('\\', '/').startsWith(join(source, 'lib', 'python3.14').replaceAll('\\', '/') + '/')
        && SKIP_DIRECTORIES.has(name))
    },
  })
  return BIN_FILES.length + countFiles(library)
}

function countFiles(directory: string): number {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(directory, entry.name))
    else count += 1
  }
  return count
}

/** Stage the runtime unless one already sits at `out` and is not older than the source. */
export function stageIfStale(source: string, out: string): boolean {
  const staged = join(out, 'bin', 'python3.14.exe')
  const origin = join(source, 'bin', 'python3.14.exe')
  if (existsSync(staged) && existsSync(origin)) {
    const stagedAt = statTime(staged)
    if (stagedAt >= statTime(origin)) return false
  }
  stageIamPython(source, out)
  return true
}

function statTime(path: string): number {
  return statSync(path).mtimeMs
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, source: { type: 'string' } } })
  const source = resolve(values.source ?? pythonSource())
  const out = resolve(values.out ?? STAGED_RUNTIME)
  const staged = stageIfStale(source, out)
  console.log(`stage-iam-python: ${staged ? 'staged' : 'up to date'} ${out} (from ${source})`)
}
