import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { convertP6PpmToPng, type EncodedPngFrame } from './ppm-to-png.js'

/** How much of each stream is kept. The renderer prints two lines at most. */
const RENDERER_LOG_TAIL_LENGTH_LIMIT = 16384

export interface HeadlessFrameRenderOptions {
  /** Absolute path to the renderer executable. */
  executablePath: string
  /** Everything after the program name, before `--out`. */
  commandArguments: readonly string[]
  /** Where the PNG should be written. */
  pngOutputPath: string
  /** Expected frame size, used to validate the PPM. */
  expectedWidth: number
  expectedHeight: number
  timeoutMs: number
  abortSignal?: AbortSignal
}

export interface HeadlessFrameRenderOutcome {
  /** A frame was produced, converted and written. */
  ok: boolean
  pngOutputPath: string
  width: number
  height: number
  pngByteCount: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  /** The caller cancelled the render. */
  cancelled: boolean
  /** The temporary PPM that was rendered, and the command line that produced it. */
  scratchPpmPath: string
  replayCommandLine: string
  /** Something the caller should read: a nonzero exit after a good frame, a short PPM. */
  note?: string
  stdout: string
  stderr: string
}

/** Capture one stream up to a bound, keeping the tail (the diagnosis is last). */
class RendererLogTail {
  private capturedTail = ''
  append(chunk: Buffer): void {
    this.capturedTail = (this.capturedTail + chunk.toString('utf8')).slice(-RENDERER_LOG_TAIL_LENGTH_LIMIT)
  }
  get text(): string {
    return this.capturedTail
  }
}

interface SpawnedRenderer {
  child: ChildProcess
  capturesLogs: boolean
}

/**
 * Start the renderer, with the EPERM fallback.
 *
 * A confinement can forbid piped stdio, and Node reports that as an error on the
 * child rather than as a throw. When that happens the child never started, so
 * the same command line is retried with `stdio: 'ignore'`; the frame file is then
 * the only evidence, and the caller is told the log could not be captured. This
 * layer has to exist: without it the plugin is unusable in exactly the
 * environments that most need a batch renderer.
 */
function spawnRendererWithOptionalLogCapture(
  executablePath: string, commandArguments: readonly string[],
): Promise<SpawnedRenderer> {
  return new Promise<SpawnedRenderer>((resolve, reject) => {
    const attemptSpawn = (captureLogs: boolean): void => {
      let child: ChildProcess
      try {
        child = spawn(executablePath, [...commandArguments], { stdio: captureLogs ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
      } catch (error) {
        if (captureLogs && (error as NodeJS.ErrnoException).code === 'EPERM') {
          attemptSpawn(false)
          return
        }
        reject(error)
        return
      }
      const onSpawn = (): void => {
        child.removeListener('error', onError)
        resolve({ child, capturesLogs: captureLogs })
      }
      const onError = (error: NodeJS.ErrnoException): void => {
        child.removeListener('spawn', onSpawn)
        if (captureLogs && error.code === 'EPERM') {
          attemptSpawn(false)
          return
        }
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    }
    attemptSpawn(true)
  })
}

/**
 * The renderer's own list of options, read from `--help`.
 *
 * Capability detection rather than a version number: the tool gains options
 * (`--view`, `--fit-elements`, `--overlay`) that this plugin wants to use the
 * moment they exist and must not pass before they do. `--help` exits non-zero on
 * the current build, so the exit code is ignored and only the text is read.
 */
export async function readSupportedRendererOptions(executablePath: string, timeoutMs: number): Promise<Set<string>> {
  const helpText = await new Promise<string>((resolve) => {
    spawnRendererWithOptionalLogCapture(executablePath, ['--help']).then(({ child }) => {
      const capturedHelp = new RendererLogTail()
      child.stdout?.on('data', (chunk: Buffer) => capturedHelp.append(chunk))
      child.stderr?.on('data', (chunk: Buffer) => capturedHelp.append(chunk))
      const timeoutTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.on('error', () => {
        clearTimeout(timeoutTimer)
        resolve('')
      })
      child.on('close', () => {
        clearTimeout(timeoutTimer)
        resolve(capturedHelp.text)
      })
    }, () => resolve(''))
  })
  const supportedOptions = new Set<string>()
  for (const optionMatch of helpText.matchAll(/--[a-z][a-z0-9-]*/g)) supportedOptions.add(optionMatch[0])
  return supportedOptions
}

/**
 * The PPM path the returned COMMAND names: beside the PNG, with the PNG's
 * extension replaced.
 *
 * The render itself writes into a scratch directory (see renderHeadlessFrameToPng), because a
 * random path cannot be mistaken for a pre-existing file.  The command cannot
 * use that path -- it is gone by the time the caller reads the result -- so it
 * names this stable one, and running it produces the same pixels.
 */
export function replayPpmPath(pngOutputPath: string): string {
  return pngOutputPath.replace(/\.png$/i, '') + '.ppm'
}

function quoteCommandArgument(value: string): string {
  // A command line a reader can paste, not one that is quoted everywhere "just
  // in case".  Flags, drive paths and the numbers stay bare; only a value a
  // shell would split needs quoting.
  const plain = process.platform === 'win32'
    ? /^[A-Za-z0-9_./\\:=@%+,-]+$/
    : /^[A-Za-z0-9_./:=@%+,-]+$/
  if (plain.test(value)) return value
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

/** A command line a shell can run again. */
export function formatRendererCommandLine(executablePath: string, commandArguments: readonly string[]): string {
  return [executablePath, ...commandArguments].map(quoteCommandArgument).join(' ')
}

/**
 * Render one frame: write a PPM in a scratch directory beside the target,
 * convert it, and remove the directory.
 *
 * The scratch path is random, so a failed render can never be mistaken for a
 * pre-existing file, and two renders to different PNGs cannot collide.  The
 * COMMAND the caller gets back names the stable `<out>.ppm` path instead: that
 * is what makes it reproducible, and running it produces the same pixels.
 */
export async function renderHeadlessFrameToPng(options: HeadlessFrameRenderOptions): Promise<HeadlessFrameRenderOutcome> {
  let scratchDirectory: string
  try {
    scratchDirectory = mkdtempSync(join(dirname(options.pngOutputPath), '.iax-render-'))
  } catch (error) {
    throw new Error(
      `cannot create a work directory beside ${options.pngOutputPath}: ${(error as Error).message}`,
    )
  }
  const scratchPpmPath = join(scratchDirectory, 'frame.ppm')
  const captureArguments = [...options.commandArguments, '--out', scratchPpmPath]
  const replayCommandLine = formatRendererCommandLine(
    options.executablePath, [...options.commandArguments, '--out', replayPpmPath(options.pngOutputPath)],
  )

  const stdoutTail = new RendererLogTail()
  const stderrTail = new RendererLogTail()
  let timedOut = false

  let spawnedRenderer: SpawnedRenderer
  try {
    spawnedRenderer = await spawnRendererWithOptionalLogCapture(options.executablePath, captureArguments)
  } catch (error) {
    rmSync(scratchDirectory, { recursive: true, force: true })
    throw error
  }
  const { child, capturesLogs } = spawnedRenderer
  child.stdout?.on('data', (chunk: Buffer) => stdoutTail.append(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderrTail.append(chunk))

  const timeoutTimer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs)
  const onAbort = (): void => {
    child.kill('SIGKILL')
  }
  options.abortSignal?.addEventListener('abort', onAbort, { once: true })

  return new Promise<HeadlessFrameRenderOutcome>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timeoutTimer)
      options.abortSignal?.removeEventListener('abort', onAbort)
      rmSync(scratchDirectory, { recursive: true, force: true })
      reject(error)
    })
    // `close` and not `exit`: it fires after the streams ended, so the last line
    // the renderer printed is in the buffers rather than in flight.
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeoutTimer)
      options.abortSignal?.removeEventListener('abort', onAbort)
      const cancelled = options.abortSignal?.aborted === true
      try {
        const processOutcome: Omit<HeadlessFrameRenderOutcome, 'ok' | 'pngByteCount'> = {
          pngOutputPath: options.pngOutputPath,
          width: 0,
          height: 0,
          exitCode,
          signal,
          timedOut,
          cancelled,
          scratchPpmPath,
          replayCommandLine,
          stdout: stdoutTail.text,
          stderr: stderrTail.text,
        }
        if (cancelled) {
          resolve({ ...processOutcome, ok: false, pngByteCount: 0, note: 'the render was cancelled' })
          return
        }
        if (!existsSync(scratchPpmPath)) {
          resolve({ ...processOutcome, ok: false, pngByteCount: 0, note: 'the renderer wrote no frame' })
          return
        }
        const ppmBytes = readFileSync(scratchPpmPath)
        let encodedFrame: EncodedPngFrame
        try {
          encodedFrame = convertP6PpmToPng(ppmBytes)
        } catch (error) {
          resolve({
            ...processOutcome,
            ok: false,
            pngByteCount: 0,
            note: `the frame could not be read: ${(error as Error).message}`,
          })
          return
        }
        try {
          writeFileSync(options.pngOutputPath, encodedFrame.pngBytes)
        } catch (error) {
          reject(new Error(`cannot write ${options.pngOutputPath}: ${(error as Error).message}`))
          return
        }
        const notes: string[] = []
        if (!capturesLogs) notes.push('the renderer log could not be captured (piped stdio was refused)')
        if (timedOut) notes.push('the renderer timed out after writing the frame')
        if (encodedFrame.width !== options.expectedWidth || encodedFrame.height !== options.expectedHeight) {
          notes.push(
            `frame is ${encodedFrame.width}x${encodedFrame.height}, asked for ${options.expectedWidth}x${options.expectedHeight}`,
          )
        }
        if (exitCode !== 0) {
          // The known teardown crash: the frame is good, the process was not.
          notes.push(
            `the renderer exited ${exitCode === null ? `on signal ${signal}` : `with ${exitCode}`} after writing the frame`,
          )
        }
        resolve({
          ...processOutcome,
          ok: true,
          width: encodedFrame.width,
          height: encodedFrame.height,
          pngByteCount: encodedFrame.pngBytes.length,
          note: notes.length > 0 ? notes.join('; ') : undefined,
        })
      } finally {
        rmSync(scratchDirectory, { recursive: true, force: true })
      }
    })
  })
}

/** Does `path` exist as a file? Used by the tool to refuse a missing document early. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Is `path` an absolute path on this platform? */
export function isAbsolutePath(path: string): boolean {
  return process.platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path)
    : path.startsWith('/')
}
