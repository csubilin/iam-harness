import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * This package's own directory.
 *
 * The CLI sits beside lib/. Algorithm bindings are generated CMake output in
 * development and a staged native package inside a deployed plugin.
 */
const packageRoot = resolve(here, '..')

/** How much of the bridge's own stderr is kept when it fails. */
const DIAGNOSTIC_LIMIT_BYTES = 32768

export class BridgeUnavailableError extends Error {}

export interface BridgeOptions {
  /** An explicit interpreter, from the bundle row or IAX_PYTHON. */
  python?: string
  /** Extra PYTHONPATH directories; the bridge places checkout or vendor bindings first. */
  pythonPath?: string[]
  /** How long one bridge call may run. */
  timeoutMs?: number
  /** Installed deployments name the root containing IAM/ and Mining/. */
  platformRoot?: string
  /** Optional external program sandbox; receives the Python command as arguments. */
  programRunner?: string[]
  /** Explicit local-development escape hatch. Never use for untrusted workspaces. */
  allowUnsafeExecution?: boolean
  /**
   * Provider libraries to load, absolute paths.
   *
   * Providers add algorithms or supply fallback implementations. A loaded
   * provider replaces a native implementation only when userImplementations
   * explicitly selects it for that algorithm ID.
   */
  providers?: string[]
  /** Algorithm ID -> provider/implementation selected ahead of the native one. */
  userImplementations?: Record<string, string>
  /** Abort the bridge when the Harness cancels a tool call. */
  signal?: AbortSignal
}

/** What one bridge call produced. */
export interface BridgeOutcome {
  ok: boolean
  value: Record<string, unknown> | undefined
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /**
   * The bridge answered with more than this half will carry.
   *
   * Its OWN field and not a sentence stuffed into `stderr`, which is how it was
   * first done: a caller then reported it as "produced output that is not JSON",
   * about output that was perfectly good JSON and merely large.
   */
  oversized: boolean
  /** The Harness cancelled the call.  Distinct from a timeout: nobody waited too long. */
  aborted: boolean
}

/**
 * Where the interpreter is.
 *
 * `IAX_PYTHON` and the bundle row win over the name, for the reason Import's
 * tool paths do: a deployment with a specific interpreter should be able to name
 * it once rather than edit this file.  The Desktop package names its own copy
 * through `IAM_BRIDGE_PYTHON`, so a packaged application never depends on a
 * Python on PATH.
 */
export function pythonExecutable(options: BridgeOptions): string {
  return options.python || process.env.IAM_BRIDGE_PYTHON || process.env.IAX_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3')
}

/**
 * The bridge script, which must exist or nothing in this plugin can work.
 *
 * `IAM_BRIDGE_SCRIPT` names the copy a packaged Desktop carries outside
 * `app.asar`: this script is run by Python, which cannot read an asar archive,
 * so a bridge inside the archive is not a script Python can open.
 */
export function bridgeScript(): string {
  const script = process.env.IAM_BRIDGE_SCRIPT ?? join(packageRoot, 'python', 'bridge.py')
  if (!existsSync(script)) {
    throw new BridgeUnavailableError(
      `the AlgorithmBridge Python half is missing at ${script}; the package is incomplete`,
    )
  }
  return script
}

function platformRoot(configured?: string): string {
  if (configured) return resolve(configured)
  for (const candidate of [resolve(packageRoot, '..', '..', '..'), process.cwd(), resolve(process.cwd(), '..', 'IAX')]) {
    if (existsSync(join(candidate, 'IAM', 'Algorithms')) && existsSync(join(candidate, 'Mining', 'Host'))) return candidate
  }
  return resolve(packageRoot, '..', '..', '..')
}

const MAX_BRIDGE_BYTES = 2 * 1024 * 1024

function stopTree(child: ReturnType<typeof spawn>, cancelFile: string): ReturnType<typeof setTimeout> | undefined {
  if (child.pid === undefined) return undefined
  // The bridge polls this marker and terminates the grandchild it owns.
  try { writeFileSync(cancelFile, 'cancel') } catch { child.kill() }
  if (process.platform === 'win32') {
    const fallback = setTimeout(() => child.kill(), 1500)
    fallback.unref()
    return fallback
  } else {
    const fallback = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Already gone. */ }
    }, 1500)
    fallback.unref()
    return fallback
  }
}

/**
 * Run one verb and hand back what it said.
 *
 * Resolves rather than throws for a call that RAN and failed, and throws only
 * for one that could not be attempted -- the same split `Import`'s tools make,
 * and for the same reason: an algorithm that refused is an answer the model has
 * to read, and turning it into an exception would leave it nothing to read.
 */
export function callBridge(
  verb: string,
  arguments_: string[],
  options: BridgeOptions = {},
): Promise<BridgeOutcome> {
  const script = bridgeScript()
  const extra = options.pythonPath ?? []
  const environment = { ...process.env }
  // The nanobind extension imports the IAX engine DLLs; the Desktop package
  // keeps them beside its native viewers and names that directory here. The
  // key is looked up case-insensitively because a copied env object is a plain
  // object, where `environment.PATH` would miss PowerShell's `Path`.
  const nativeBin = process.env.IAM_NATIVE_DIR
  if (nativeBin !== undefined && nativeBin !== '') {
    const key = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH'
    environment[key] = [nativeBin, environment[key]].filter(Boolean).join(delimiter)
  }
  const cancelDirectory = mkdtempSync(join(tmpdir(), 'iam-bridge-'))
  const cancelFile = join(cancelDirectory, 'cancel')
  environment.IAX_CANCEL_FILE = cancelFile
  const repository = platformRoot(options.platformRoot || process.env.IAX_PLATFORM_ROOT)
  environment.IAX_PLATFORM_ROOT = repository
  if (options.programRunner !== undefined) environment.IAX_PROGRAM_RUNNER_JSON = JSON.stringify(options.programRunner)
  // An inherited `IAX_ALLOW_UNSAFE_PROGRAMS` is the packaged Desktop's explicit
  // opt-in (main.ts sets it); a row that says `false` still wins, and the same
  // variable is already what the MiningRepository Python half reads directly.
  if (options.allowUnsafeExecution === true) environment.IAX_ALLOW_UNSAFE_PROGRAMS = '1'
  else if (options.allowUnsafeExecution === false) delete environment.IAX_ALLOW_UNSAFE_PROGRAMS
  // Set rather than appended: the library reads it once per process, and the
  // deployment's list is the whole list.  `;` on Windows, `:` elsewhere, which
  // is the same rule the library splits on.
  if (options.providers?.length) {
    environment.IAM_ALGORITHM_PROVIDERS = options.providers.join(process.platform === 'win32' ? ';' : ':')
  } else delete environment.IAM_ALGORITHM_PROVIDERS
  if (options.userImplementations && Object.keys(options.userImplementations).length) {
    environment.IAM_ALGORITHM_USER_IMPLEMENTATIONS = JSON.stringify(options.userImplementations)
  } else delete environment.IAM_ALGORITHM_USER_IMPLEMENTATIONS
  // bridge.py chooses generated build packages before its packaged fallback for both
  // itself and the programs it runs. Only caller-supplied paths belong here.
  if (extra.length) {
    environment.PYTHONPATH = [...extra, environment.PYTHONPATH ?? ''].filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ':')
  }
  // The bridge decodes its own output as UTF-8 and so must its reader; a
  // Windows console defaults to a code page that mangles both the JSON and the
  // Chinese element names inside it.
  environment.PYTHONIOENCODING = 'utf-8'

  return new Promise((resolveCall) => {
    const cleanCancel = () => {
      try { unlinkSync(cancelFile) } catch { /* No cancellation marker. */ }
      try { rmdirSync(cancelDirectory) } catch { /* A late child may still observe the marker. */ }
    }
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
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let received = 0
    const stop = () => {
      if (stopping) return
      stopping = true
      stopTimer = stopTree(child, cancelFile)
    }
    const onAbort = () => { aborted = true; stop() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true
        stop()
      }, options.timeoutMs)
      : undefined

    const collect = (target: Buffer[], chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BRIDGE_BYTES) { oversized = true; stop(); return }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk))
    child.on('error', (error: Error) => {
      if (timer) clearTimeout(timer)
      if (stopTimer) clearTimeout(stopTimer)
      options.signal?.removeEventListener('abort', onAbort)
      cleanCancel()
      resolveCall({
        ok: false,
        value: undefined,
        stdout: '',
        stderr: `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim(),
        exitCode: null,
        signal: null,
        timedOut: false,
        oversized: false,
        aborted: false,
      })
    })
    child.on('close', (code: number | null, signal: string | null) => {
      if (timer) clearTimeout(timer)
      if (stopTimer) clearTimeout(stopTimer)
      options.signal?.removeEventListener('abort', onAbort)
      cleanCancel()
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      let value: Record<string, unknown> | undefined
      if (code === 0 && !oversized && !aborted && !timedOut) {
        try {
          value = JSON.parse(stdout) as Record<string, unknown>
        } catch {
          // A zero exit with unparseable stdout is a bridge defect, not a
          // refusal, and saying so is more useful than a JSON error.
          value = undefined
        }
      }
      resolveCall({
        ok: code === 0 && value !== undefined && !oversized && !aborted && !timedOut,
        value,
        stdout,
        stderr: stderr.slice(0, DIAGNOSTIC_LIMIT_BYTES),
        exitCode: code,
        signal,
        timedOut,
        oversized,
        aborted,
      })
    })
  })
}
