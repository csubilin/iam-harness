import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * This package's own directory.
 *
 * `lib/` is where the build puts this file, so the package root is one level up
 * from here whichever of the two the module was loaded from.  The Python half
 * sits BESIDE `lib/` rather than inside it, because it is not built: it is
 * shipped as source and run by an interpreter.
 */
const packageRoot = resolve(here, '..')

/** How much of the program's own stderr is kept when it fails. */
const DIAGNOSTIC_LIMIT_BYTES = 32768

/** The most this half will carry back; a selection's answer is a few hundred bytes. */
const MAX_BRIDGE_BYTES = 2 * 1024 * 1024

export class RepositoryUnavailableError extends Error {}

export interface RepositoryOptions {
  /** An explicit interpreter, from the bundle row or IAX_PYTHON. */
  python?: string
  /** Directories the program is given on PYTHONPATH, ahead of its own. */
  pythonPath?: string[]
  /** How long one call may run. */
  timeoutMs?: number
  /** Installed deployments name the root containing IAM/ and Mining/. */
  platformRoot?: string
  /** Abort the call when the Harness cancels it. */
  signal?: AbortSignal
}

/** What one call produced. */
export interface RepositoryOutcome {
  ok: boolean
  value: Record<string, unknown> | undefined
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** The program answered with more than this half will carry. */
  oversized: boolean
  /** The Harness cancelled the call.  Distinct from a timeout: nobody waited too long. */
  aborted: boolean
}

/**
 * Where the interpreter is.
 *
 * `IAX_PYTHON` and the bundle row win over the name, for the reason Import's and
 * AlgorithmBridge's paths do: a deployment with a specific interpreter should be
 * able to name it once rather than edit this file.
 */
export function pythonExecutable(options: RepositoryOptions): string {
  return options.python || process.env.IAX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
}

/** The program, which must exist or nothing in this plugin can work. */
export function repositoryScript(): string {
  const script = join(packageRoot, 'python', 'repository.py')
  if (!existsSync(script)) {
    throw new RepositoryUnavailableError(
      `the MiningRepository Python half is missing at ${script}; the package is incomplete`,
    )
  }
  return script
}

/** The library directory a caller does not have to know about. */
function defaultPythonPath(repository: string): string[] {
  // SOURCE FIRST, VENDORED COPY LAST -- the same order AlgorithmBridge gives its
  // own `sys.path`, and load-bearing for the same reason: with the vendored copy
  // first, an edit to `iam` would reach an installed copy of this plugin and
  // not the checkout it is being developed in.
  return [join(repository, 'Mining', 'Host', 'python'), join(packageRoot, 'python', 'vendor')]
}

function platformRoot(configured?: string): string {
  if (configured) return resolve(configured)
  for (const candidate of [resolve(packageRoot, '..', '..', '..'), process.cwd(), resolve(process.cwd(), '..', 'IAX')]) {
    if (existsSync(join(candidate, 'IAM', 'Algorithms')) && existsSync(join(candidate, 'Mining', 'Host'))) return candidate
  }
  return resolve(packageRoot, '..', '..', '..')
}

/**
 * Run one verb and hand back what it said.
 *
 * Resolves rather than throws for a call that RAN and failed, and throws only
 * for one that could not be attempted -- the split AlgorithmBridge makes, and
 * for the same reason: a refusal is an answer the model has to read, and turning
 * it into an exception would leave it nothing to read.
 */
export function callRepository(
  verb: string,
  arguments_: string[],
  options: RepositoryOptions = {},
): Promise<RepositoryOutcome> {
  const script = repositoryScript()
  const environment = { ...process.env }
  const repository = platformRoot(options.platformRoot || process.env.IAX_PLATFORM_ROOT)
  environment.IAX_PLATFORM_ROOT = repository
  const joined = [...(options.pythonPath ?? []), ...defaultPythonPath(repository), environment.PYTHONPATH ?? '']
    .filter(Boolean)
  environment.PYTHONPATH = joined.join(process.platform === 'win32' ? ';' : ':')
  // The program decodes its own output as UTF-8 and so must its reader; a
  // Windows console defaults to a code page that mangles both the JSON and the
  // Chinese element names inside it.
  environment.PYTHONIOENCODING = 'utf-8'

  return new Promise((resolveCall) => {
    // Its own process group, so a timeout takes the interpreter and anything it
    // started with it.  Detached on POSIX is what makes the group signalable.
    const child = spawn(pythonExecutable(options), ['-X', 'utf8', script, verb, ...arguments_], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let aborted = false
    let oversized = false
    let stopping = false
    let received = 0
    const stop = () => {
      if (stopping) return
      stopping = true
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        // `taskkill /T` walks the parent chain, which is the only way to reach
        // the host that `repository.py` started -- and it has to be asked for
        // BEFORE the child is killed, or the chain it walks is already gone.
        // Measured need, not a precaution: `iam.host` has a deadline of its
        // own, so an orphaned one is not silent, it is just a process nobody
        // asked for running for a minute after the tool call said it stopped.
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch { /* No taskkill, or it is already gone; kill() below is the fallback. */ }
        child.kill()
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone. */ }
      }
    }
    const finish = (result: Omit<RepositoryOutcome, 'ok'>) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolveCall({ ok: result.exitCode === 0 && result.value !== undefined, ...result })
    }
    const onAbort = () => { aborted = true; stop() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
      : undefined

    const collect = (target: Buffer[], chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BRIDGE_BYTES) { oversized = true; stop(); return }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk))
    child.on('error', (error: Error) => {
      finish({
        value: undefined, stdout: '',
        stderr: `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim(),
        exitCode: null, signal: null, timedOut: false, oversized: false, aborted: false,
      })
    })
    child.on('close', (code: number | null, signal: string | null) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      let value: Record<string, unknown> | undefined
      if (code === 0 && !oversized && !aborted && !timedOut) {
        try {
          value = JSON.parse(stdout) as Record<string, unknown>
        } catch {
          // A zero exit with unparseable stdout is a defect in this package's
          // own Python, not a refusal, and saying so is better than a JSON error.
          value = undefined
        }
      }
      finish({
        value, stdout, stderr: stderr.slice(0, DIAGNOSTIC_LIMIT_BYTES),
        exitCode: code, signal, timedOut, oversized, aborted,
      })
    })
  })
}
