import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

/** How much of the finder's own stderr is kept when it fails. */
const DIAGNOSTIC_LIMIT_BYTES = 32768
/** The one JSON object a verb may print is small; this bounds a defect. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export class CapabilityUnavailableError extends Error {}

export interface CapabilityOptions {
  /** An explicit interpreter, from the bundle row or IAX_PYTHON. */
  python?: string
  /** How long one forge call may run. */
  timeoutMs?: number
  /** Abort the call when the Harness cancels the tool. */
  signal?: AbortSignal
  /** Text for the child's stdin; `freeze --manifest -` is the one reader. */
  stdin?: string
}

export interface CapabilityOutcome {
  /** The parsed answer, present for exit 0 and for a refusal (exit 1). */
  value: Record<string, unknown>
  stdout: string
  stderr: string
  exitCode: number
}

export function pythonExecutable(options: CapabilityOptions = {}): string {
  return options.python || process.env.IAM_CAPABILITY_PYTHON || process.env.IAX_PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3')
}

/**
 * The forge's Python half, which must exist or nothing here can answer.
 *
 * `IAM_CAPABILITY_SCRIPT` names the copy a packaged Desktop carries outside
 * `app.asar`, where Python can open it.
 */
export function capabilityScript(): string {
  const script = process.env.IAM_CAPABILITY_SCRIPT ?? join(packageRoot, 'python', 'capability.py')
  if (!existsSync(script)) {
    throw new CapabilityUnavailableError(
      `the CapabilityForge Python half is missing at ${script}; the package is incomplete`,
    )
  }
  return script
}

/**
 * Run one verb and hand back what it said.
 *
 * A refusal (exit 1) RESOLVES with its value: "this manifest has three errors"
 * is an answer, and turning it into an exception would leave a model nothing to
 * read. Exit 2, a missing interpreter and unparseable output all throw, because
 * in each of those cases the forge could not answer at all.
 */
export function callCapability(
  verb: string,
  arguments_: string[],
  options: CapabilityOptions = {},
): Promise<CapabilityOutcome> {
  const script = capabilityScript()
  const environment = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  // `freeze` reads the algorithm versions from the packaged bindings; the
  // nanobind extension imports the IAX DLLs beside the native viewers, and the
  // packaged Desktop names that directory instead of putting it on PATH.
  const nativeBin = process.env.IAM_NATIVE_DIR
  if (nativeBin !== undefined && nativeBin !== '') {
    const key = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH'
    environment[key] = [nativeBin, environment[key]].filter(Boolean).join(delimiter)
  }

  return new Promise((resolveCall, reject) => {
    const child = spawn(pythonExecutable(options), ['-X', 'utf8', script, verb, ...arguments_], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let received = 0
    let oversized = false
    let timedOut = false
    let aborted = false
    let stopping = false

    const stop = () => {
      if (stopping) return
      stopping = true
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        child.kill()
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already gone. */ }
      }
    }
    const onAbort = () => { aborted = true; stop() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const timer = options.timeoutMs
      ? setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
      : undefined

    const collect = (target: Buffer[], chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_OUTPUT_BYTES) { oversized = true; stop(); return }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(err, chunk))
    child.on('error', (error: Error) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(new CapabilityUnavailableError(
        `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim(),
      ))
    })
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8').slice(0, DIAGNOSTIC_LIMIT_BYTES)
      if (aborted) {
        reject(new CapabilityUnavailableError('the CapabilityForge call was cancelled'))
        return
      }
      if (timedOut) {
        reject(new CapabilityUnavailableError('the CapabilityForge call did not finish in time'))
        return
      }
      if (oversized) {
        reject(new CapabilityUnavailableError('the CapabilityForge printed more than 2 MiB'))
        return
      }
      let value: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(stdout) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          value = parsed as Record<string, unknown>
        }
      } catch {
        value = undefined
      }
      if ((code === 0 || code === 1) && value !== undefined) {
        resolveCall({ value, stdout, stderr, exitCode: code })
        return
      }
      if (value !== undefined && typeof value.error === 'string') {
        // Exit 2 with a JSON error object is still "could not be attempted";
        // the message is the sentence the caller needs, not a second envelope.
        reject(new CapabilityUnavailableError(value.error))
        return
      }
      reject(new CapabilityUnavailableError(
        `the CapabilityForge could not answer (exit ${code}): ${(stderr || stdout).trim().slice(-4000)}`,
      ))
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}
