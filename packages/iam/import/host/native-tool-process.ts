import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * How much of the child's output is kept, PER STREAM, when it is a LOG.
 *
 * The bound the windowed host uses, for the same reason: on an import the reader
 * is a vendor binary and its output is not this process's to trust with the heap.
 * It is per stream here rather than across both because the two carry different
 * things -- stdout is the reader's progress chatter, stderr is the tool's
 * diagnosis -- and a shared budget would let a verbose reader crowd out the
 * sentence saying why the import failed.
 */
const DEFAULT_STREAM_CAPTURE_LIMIT_BYTES = 65536

/**
 * The bound when stdout is not a log but THE PAYLOAD.
 *
 * `--describe` prints the platform's own projection and nothing else, so
 * truncating it does not shorten a log -- it corrupts a document. Measured: a
 * 5,725-entity drawing projects to 700 KB, eleven times the log bound, and the
 * first version of this file capped it there and then reported that the tool
 * "expected strict JSON and got something else", which was true and blamed the
 * wrong program.
 *
 * Generous rather than absent, because the size is still the child's to choose:
 * a caller that exceeds this is told so by name (see `describe_drawing`) rather
 * than handed a parse error.
 */
export const MAX_DRAWING_JSON_BYTES = 64 * 1024 * 1024

/**
 * The prefixes whose keys are class names and so cannot be enumerated.
 *
 * `dropped.` is what the writer reported dropping inline; `lost.` is the model
 * space counted at both ends of the round trip. They are different numbers and
 * both are kept: the second is the one that reconciles `source` and `reload`,
 * and an object the writer never reported is exactly what it exists to catch.
 */
const CONVERSION_REPORT_CLASS_KEY_PREFIXES = ['dropped.', 'lost.'] as const

export interface NativeToolProcessOptions {
  /** Absolute path to the native executable. */
  executablePath: string
  /** Everything after the program name, in the tool's own words. */
  commandArguments: readonly string[]
  /**
   * The product path, which is also where the `.report` sidecar lands.
   *
   * Omitted by a run that produces nothing -- `--describe` converts no file and
   * writes no note. Passing a made-up path instead would have this module
   * deleting and looking for files beside a drawing that no run was ever going
   * to create.
   */
  conversionOutputPath?: string
  timeoutMs: number
  abortSignal?: AbortSignal
  /** Per-stream capture bound. Defaults to the log bound. */
  streamCaptureLimitBytes?: number
}

export interface NativeToolProcessOutcome {
  /** The tool's exit code was 0. */
  ok: boolean
  exitCode: number | null
  /** A signal name when the child was killed, `null` when it exited on its own. */
  signal: string | null
  timedOut: boolean
  /** The parsed `.report`, or undefined when the run wrote none (a failed run). */
  conversionReport: Record<string, unknown> | undefined
  stdout: string
  stderr: string
  outputTruncated: boolean
}

/** One pull from a captured stream, in the shape a job output source returns. */
export interface CapturedStreamRead {
  text: string
  nextOffset: number
  lossy: boolean
}

/** A child that is running now, and the two things a caller needs to hold it. */
export interface RunningNativeToolProcess {
  /** Settles when the child has exited, the report has been read, and cleanup is done. */
  readonly completion: Promise<NativeToolProcessOutcome>
  /** The captured stdout from a byte offset; the job output ring's read. */
  readStdout(byteOffset: number): CapturedStreamRead
  /** The captured stderr from a byte offset. */
  readStderr(byteOffset: number): CapturedStreamRead
  /** Kill the child. Idempotent, and safe after it has already exited. */
  cancel(): void
}

/**
 * One stream's bytes, addressable by offset.
 *
 * Bytes and not a string, because the ring's contract is a byte offset: a
 * reader that resumed at a character index would re-read or skip a multi-byte
 * character every time the child's output split one across two chunks.
 *
 * The concat is per read rather than maintained, which is quadratic in the
 * number of reads -- acceptable only because the buffer is capped at 64 KB by
 * default. A far larger cap would want a rope or a rolling window.
 */
class CapturedProcessStream {
  private readonly chunks: Buffer[] = []
  private capturedByteCount = 0
  private truncated = false

  constructor(private readonly captureLimitBytes: number) {}

  append(chunk: Buffer): void {
    if (this.capturedByteCount >= this.captureLimitBytes) {
      this.truncated = true
      return
    }
    const remainingCapacity = this.captureLimitBytes - this.capturedByteCount
    const capturedChunk = chunk.length > remainingCapacity ? chunk.subarray(0, remainingCapacity) : chunk
    if (capturedChunk.length < chunk.length) this.truncated = true
    this.chunks.push(capturedChunk)
    this.capturedByteCount += capturedChunk.length
  }

  readFromByteOffset(byteOffset: number): CapturedStreamRead {
    // A truncated stream is lossy from the reader's point of view even at the
    // end, because the bytes that were dropped are gone from the middle of what
    // it is accumulating.
    if (byteOffset >= this.capturedByteCount)
      return { text: '', nextOffset: this.capturedByteCount, lossy: this.truncated }
    const text = Buffer.concat(this.chunks).subarray(byteOffset).toString('utf8')
    return { text, nextOffset: this.capturedByteCount, lossy: false }
  }

  decodeText(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get wasTruncated(): boolean {
    return this.truncated
  }
}

/**
 * The `.report` as one object, with `dropped.<class>` folded into a nested map.
 *
 * Numeric values become numbers so that a caller does not have to know which
 * keys are counts, and the dropped set stays open: the class names are the
 * writer's own dropped-object messages, so there is no fixed list to validate
 * against (see IaxDrawingImportTool.cpp's DropReport).
 */
export function parseConversionReport(reportText: string): Record<string, unknown> {
  const report: Record<string, unknown> = {}
  const countsByCategoryAndClass: Record<string, Record<string, number>> = { dropped: {}, lost: {} }
  for (const reportLine of reportText.split('\n')) {
    const equalsOffset = reportLine.indexOf('=')
    if (equalsOffset <= 0) continue
    const key = reportLine.slice(0, equalsOffset)
    const rawValue = reportLine.slice(equalsOffset + 1)
    const value = /^-?\d+$/.test(rawValue) ? Number(rawValue) : rawValue
    const prefix = CONVERSION_REPORT_CLASS_KEY_PREFIXES.find(candidate => key.startsWith(candidate))
    if (prefix !== undefined) {
      if (typeof value === 'number') countsByCategoryAndClass[prefix.slice(0, -1)][key.slice(prefix.length)] = value
      continue
    }
    report[key] = value
  }
  for (const [group, counts] of Object.entries(countsByCategoryAndClass)) {
    if (Object.keys(counts).length > 0) report[group] = counts
  }
  return report
}

/**
 * The store writer's debris, left behind when a child is killed mid-write.
 *
 * It writes `<out>.tmp-<n>-<m>` and renames it into place, so a killed child
 * leaves one of those beside the source with nothing that will ever read it.
 * The windowed host removes them for the same reason and says it better: "the
 * caller is about to tell the user the import failed; leaving files next to
 * their data that no one can explain is not part of that sentence."
 */
function removeTemporaryConversionFiles(conversionOutputPath: string): void {
  const directory = dirname(conversionOutputPath)
  const prefix = `${basename(conversionOutputPath)}.tmp-`
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // The directory is gone, so there is nothing beside the product to remove.
    return
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) rmSync(join(directory, entry), { force: true })
  }
}

/**
 * The `.report` a run wrote, or undefined when it wrote none.
 *
 * Absence is the normal case for a failed run, not an error: both tools write
 * the note only on the path that reaches their conclusion, so the exit code is
 * what carries a failure and this is what carries the counts.
 */
function readAndRemoveConversionReport(reportPath: string): Record<string, unknown> | undefined {
  let reportText: string
  try {
    reportText = readFileSync(reportPath, 'utf8')
  } catch {
    return undefined
  }
  rmSync(reportPath, { force: true })
  return parseConversionReport(reportText)
}

export function startNativeToolProcess(options: NativeToolProcessOptions): RunningNativeToolProcess {
  const conversionOutputPath = options.conversionOutputPath
  const reportPath = conversionOutputPath === undefined ? undefined : `${conversionOutputPath}.report`

  // Removed BEFORE the run, never after only. Reading it afterwards without
  // this leaves the previous run's counts to be reported as this run's whenever
  // the new run fails early -- the same stale-product failure the windowed host
  // defends against with a modification-time check. A text note settles it for
  // free because, unlike the product, it can simply be deleted first.
  if (reportPath !== undefined) rmSync(reportPath, { force: true })

  const captureLimitBytes = options.streamCaptureLimitBytes ?? DEFAULT_STREAM_CAPTURE_LIMIT_BYTES
  const capturedStdout = new CapturedProcessStream(captureLimitBytes)
  const capturedStderr = new CapturedProcessStream(captureLimitBytes)
  let timedOut = false

  const child: ChildProcess = spawn(options.executablePath, [...options.commandArguments], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => capturedStdout.append(chunk))
  child.stderr?.on('data', (chunk: Buffer) => capturedStderr.append(chunk))

  /** SIGKILL and not SIGTERM, matching the windowed host: the failure this
   * bounds is a hang in a binary nobody in this tree can fix, and a process
   * that ignores SIGTERM is exactly the shape of that failure. */
  const killChild = (): void => {
    child.kill('SIGKILL')
  }

  const timeoutTimer = setTimeout(() => {
    timedOut = true
    killChild()
  }, options.timeoutMs)

  const onAbort = (): void => killChild()
  options.abortSignal?.addEventListener('abort', onAbort, { once: true })

  const completion = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    // `close` and not `exit`: it fires after the stdio streams have ended, so
    // the last thing the child printed is in the buffers above rather than in
    // flight -- which matters twice over in the background case, where the ring
    // drains once more before the job settles.
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
    // A spawn that never happened -- the file was removed between the lookup and
    // here -- is not a failed import. There is no child to have exited, so no
    // exit code can describe it; it is thrown instead.
    child.on('error', reject)
  })
    .then((childExit): NativeToolProcessOutcome => {
      const conversionReport = reportPath === undefined ? undefined : readAndRemoveConversionReport(reportPath)
      if (conversionOutputPath !== undefined) removeTemporaryConversionFiles(conversionOutputPath)
      return {
        ok: childExit.exitCode === 0,
        exitCode: childExit.exitCode,
        signal: childExit.signal,
        timedOut,
        conversionReport,
        stdout: capturedStdout.decodeText(),
        stderr: capturedStderr.decodeText(),
        outputTruncated: capturedStdout.wasTruncated || capturedStderr.wasTruncated,
      }
    })
    .catch((error: unknown): never => {
      if (conversionOutputPath !== undefined) removeTemporaryConversionFiles(conversionOutputPath)
      throw error
    })
    .finally(() => {
      clearTimeout(timeoutTimer)
      options.abortSignal?.removeEventListener('abort', onAbort)
    })

  return {
    completion,
    readStdout: byteOffset => capturedStdout.readFromByteOffset(byteOffset),
    readStderr: byteOffset => capturedStderr.readFromByteOffset(byteOffset),
    cancel: killChild,
  }
}

export async function runNativeToolProcess(options: NativeToolProcessOptions): Promise<NativeToolProcessOutcome> {
  return startNativeToolProcess(options).completion
}
