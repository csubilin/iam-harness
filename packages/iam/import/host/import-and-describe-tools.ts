import {
  MAX_DRAWING_JSON_BYTES,
  runNativeToolProcess,
  startNativeToolProcess,
  type NativeToolProcessOutcome,
  type RunningNativeToolProcess,
} from './native-tool-process.js'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveDrawingEntityQueryExecutablePath,
  resolveImportExecutablePath,
  type ImportToolKind,
} from './native-tool-paths.js'

/** What the plugin's patch row may configure. */
export interface ImportPluginConfig {
  /** Where the importers are; the environment still wins over this. */
  toolsDir?: string
  /** How long one import may run before the child is killed. */
  timeoutSeconds?: number
  /** Whether the tools offer `run_in_background`. On unless a deployment says otherwise. */
  enableRunInBackground?: boolean
}

// ---------------------------------------------------------------- the job seam
//
// Structural, for the reason the rest of this file is: a host half resolves no
// `@deepseek-ai/*` value, so `@deepseek-ai/dsh-jobs`'s types are not importable
// even though its service is. These mirror `packages/jobs/jobs/src/types.ts` --
// `JobSourceRead`, `JobOutputSource`, `JobHandle`, `JobHooks`, `JobOutcome` --
// and only the members this plugin touches.

interface JobSourceRead {
  text: string
  nextOffset: number
  lossy: boolean
}

interface JobOutputSource {
  channel?: string
  read(fromByte: number): JobSourceRead
}

interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
}

interface JobHandle {
  append(text: string, options?: { channel?: string }): void
  updateProgress(line: string): void
}

interface JobSpec {
  kind: string
  label: string
  owner?: string
  output?: readonly JobOutputSource[]
  run(job: JobHandle): { cancel(reason?: string): void; done: Promise<JobOutcome> }
}

/** The `ctx.jobs` registry, as much of it as this plugin uses. */
export interface JobsRegistry {
  start(spec: JobSpec): string
}

/** The default the windowed host uses, kept the same so both callers agree. */
const DEFAULT_TIMEOUT_SECONDS = 300

// --------------------------------------------------------------- the vocabulary
//
// Structural, and only what this plugin actually emits. A content block is a
// text block; a card is the terminal card or the generic one.

interface TextBlock {
  type: 'text'
  text: string
}

type RenderIntent =
  | { card: 'terminal'; title: string; description?: string; cwd?: string }
  | { card: 'generic'; title: string; kind?: string; rawInput?: unknown; content?: TextBlock[] }

type ResultIntent =
  | { card: 'terminal'; title?: string; output?: string; exitCode?: number; signal?: string }
  | { card: 'generic'; content?: TextBlock[] }

/** A registered tool, in the shape `ctx.tools.register()` consumes. */
export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  presentCall?: (args: unknown) => RenderIntent | undefined
  presentResult?: (args: unknown, result: { value?: unknown; content?: unknown[] }) => ResultIntent | undefined
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
}

/** The outcome of an import that ran to a conclusion. */
export interface ForegroundOutcome {
  kind: 'foreground'
  ok: boolean
  out: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  report?: Record<string, unknown>
  stdout: string
  stderr: string
  logTruncated: boolean
}

// ------------------------------------------------------------------- rendering

/**
 * One line saying what happened, and it goes FIRST.
 *
 * Measured rather than assumed: the DWG reader writes a progress percentage to
 * stdout every few tenths of a percent, so a 90 KB drawing produced a result
 * whose first four hundred characters were `Progress: 1.60%`, `2.40%`, `3.19%`
 * and whose actual outcome -- a path, a count, whether it worked -- was
 * somewhere past the truncation point. The counts are already in the report;
 * they belong at the front, where a reader (and a truncating one especially)
 * meets them before the noise.
 *
 * The log still follows in full and is still not parsed: the markers below are
 * the report's keys, never a pattern matched against the child's output.
 */
function summarize(value: ForegroundOutcome): string {
  const status = value.timedOut
    ? 'timed out'
    : value.signal !== null
      ? `killed by signal ${value.signal}`
      : value.ok
        ? 'ok'
        : `failed (exit ${value.exitCode})`
  // Forward slashes in what a READER sees, never in what the importer was given:
  // this string is copied into an answer, and a backslash in a markdown link
  // destination is eaten before the link is followed -- see {@link productLink}.
  const product = value.out.replace(/\\/g, '/')
  const counts =
    value.report === undefined
      ? ''
      : Object.entries(value.report)
        .filter(([key]) => key !== 'kind' && key !== 'status')
        .map(([key, count]) => ` ${key}=${typeof count === 'object' ? JSON.stringify(count) : String(count)}`)
        .join('')
  return `${status}: ${product}${counts}`
}

/**
 * The product as one markdown link, spelled so that following it lands on the file.
 *
 * WHY THE RESULT CARRIES A LINK AND NOT ONLY A PATH. Measured 2026-10-09: a model
 * writing the path into its own link wrote `D:/…/workspace\+4120m…iamp`, and
 * CommonMark eats a backslash before PUNCTUATION -- so `\+` became `+`, the
 * separator in front of the name vanished, and the click asked the Host for a file
 * that has never existed. The user saw "File not found. It may have been moved or
 * deleted." for a file sitting on disk. A POSIX path has no backslash, which is
 * why the same flow on Linux could not show this. Handing over the finished link
 * deletes the step that was lossy.
 *
 * Forward slashes, because they are the one separator that survives both the
 * importer and a markdown destination. The rest is percent-encoded: the four
 * characters that would end the destination early, the space that `<…>` would
 * otherwise have to carry, the `+` that a form decoder reads as a space, and `%`
 * itself, which the harness reads back with `decodeURIComponent`.
 * @param path - the product path as the importer spelled it.
 * @returns the link, ready to be answered with verbatim.
 */
function productLink(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  const name = slashes.slice(slashes.lastIndexOf('/') + 1)
  // The label is link TEXT, and it is what the user reads: only the three
  // characters that would end it are escaped, and nothing is percent-encoded.
  const label = name.replace(/[\\[\]]/g, character => `\\${character}`)
  const destination = slashes.replace(/[%<>#?+ ]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return `[${label}](<${destination}>)`
}

/**
 * The child's output as one block of text, in the shape `tool-bash`'s renderer
 * uses, and for the same reason: a model reading a result must be able to see
 * that it failed without parsing prose.
 *
 * `[stderr]` is marked rather than merged because both importers put their
 * diagnosis there while their report goes to stdout, and a reader that could
 * not tell them apart could not tell a refusal from a skip.
 */
function renderOutcome(value: ForegroundOutcome): string {
  let body = value.stdout.replace(/\n+$/, '')
  const err = value.stderr.replace(/\n+$/, '')
  if (err.length > 0) {
    if (body.length > 0) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  if (value.logTruncated) body += '\n[output truncated]'
  const markers: string[] = []
  if (value.timedOut) markers.push('[timed out; the importer was killed]')
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length > 0) body += `\n${markers.join('\n')}`
  // The link only when there is a product: a failed conversion has nothing to
  // open, and a link to a name that was never written is the defect this line
  // exists to prevent.
  const link = value.ok ? `link: ${productLink(value.out)}\n` : ''
  return `${summarize(value)}\n${link}${body}`
}

// -------------------------------------------------------------------- schemas

/** Argument validation for a raw tool, which the registry does not do for us. */
function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${tool}: "${key}" is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalInteger(args: Record<string, unknown>, key: string, tool: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${tool}: "${key}" must be a positive integer`)
  }
  return value
}

/**
 * The path one call writes: `out` when it was given, otherwise the source's own
 * name beside it.
 *
 * `out` USED TO BE REQUIRED, WHICH MADE THE MODEL THE NAMER. Measured 2026-10-09:
 * a user typed 打开dwg文件 for `+4120m中段平面图1.dwg`, the call came back with
 * `out=+4120m_level_plan.iamp`, and the user -- looking for the same name the
 * platform's own flow implies -- got `no entry at "…+4120m中段平面图1.iamp"` from
 * the preview, which the harness renders as "File not found. It may have been
 * moved or deleted." The conversion was never wrong; the name was somebody's
 * choice, and a name nobody can predict is a file nobody can click.
 *
 * The default keeps the source's directory and stem and takes the extension from
 * what this tool writes -- never from the source's own, which is the one thing
 * about the name the conversion does change.
 * @param kind - which importer is asking; the product's format is that tool's gift.
 * @param args - the call's arguments.
 * @returns the path to write, or undefined when neither `out` nor a source to name it after exists.
 */
function productPath(kind: ImportToolKind, args: Record<string, unknown>): string | undefined {
  const given = optionalString(args, 'out')
  if (given !== undefined) return given
  const source = optionalString(args, 'source')
  if (source === undefined) return undefined
  const extension = productExtension(kind, source, optionalString(args, 'part'))
  if (extension === undefined) return undefined
  // Both separators, because the source may be spelled either way on a Host that
  // accepts both -- and a stem that ends in a dot is no stem at all.
  const cut = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'))
  const file = source.slice(cut + 1)
  const stem = file.replace(/\.[^./\\]*$/, '')
  // A .dmg and a .dmf often share a stem. Keep .dmg in the product name
  // so its default destination cannot replace the corresponding .dmf import.
  const productStem = kind === 'mine' && /\.dmg$/i.test(file) ? file : stem
  return stem.length === 0 ? undefined : `${source.slice(0, cut + 1)}${productStem}${extension}`
}

/**
 * The extension this platform writes for one source.
 * @param kind - the importer; a drawing is always `.iamp`, whatever it read.
 * @param source - the source path, whose suffix decides the rest.
 * @param part - the part of a `.dmf` or `.dmg` being written, if specified.
 * @returns the extension, or undefined for a source whose product the name alone does not decide.
 */
function productExtension(kind: ImportToolKind, source: string, part: string | undefined): string | undefined {
  if (kind === 'drawing') return '.iamp'
  const cut = source.lastIndexOf('.')
  const extension = cut < 0 ? '' : source.slice(cut).toLowerCase()
  if (extension === '.dmb') return '.iamh'
  if (extension === '.dmf' || extension === '.dmg') return part === 'drawing' ? '.iamp' : '.iam'
  return undefined
}

/** {@link productPath} for the callers that cannot proceed without an answer. */
function requireProduct(kind: ImportToolKind, args: Record<string, unknown>, tool: string): string {
  const path = productPath(kind, args)
  if (path === undefined) {
    throw new Error(
      `${tool}: "out" is required here -- it defaults to the source's own directory and stem with the `
      + 'extension this tool writes, and this call names no source that answers to that',
    )
  }
  return path
}

/** An import that reached a conclusion, whether or not it succeeded. */
const FOREGROUND_ARM: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ok', 'out', 'exitCode', 'signal', 'timedOut', 'stdout', 'stderr', 'logTruncated'],
  properties: {
    kind: { type: 'string', const: 'foreground' },
    ok: { type: 'boolean', description: 'The importer exited 0, which its contract says means the product was written AND read back.' },
    out: { type: 'string', description: 'The product path: `out` as given, or the source-named default. This is the file to open.' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Set when the importer crashed; a crash is not a failed conversion.' },
    timedOut: { type: 'boolean' },
    report: {
      type: 'object',
      additionalProperties: true,
      description:
        "The importer's own counts, read from <out>.report. Absent when the run failed early enough to write none. " +
        '`lost` is the one to read: it is the model space counted at both ends of the round trip, keyed by class, and ' +
        '`source - lost == reload` holds by construction. `dropped` is the writer\'s own inline account and can be a ' +
        'subset of it. Both maps are open: their keys are class names.',
    },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    logTruncated: { type: 'boolean' },
  },
}

/**
 * The canonical value of an import, in the two shapes it has.
 *
 * There is no "it did not run at all" arm: that case throws, because an import
 * that could not be attempted has no exit code to describe it. A non-zero exit
 * IS the foreground arm -- the harness's own rule is that a non-ideal process
 * outcome is a successful tool call whose value says so, and it matters here
 * because a crashed vendor reader is exactly the outcome this whole arrangement
 * exists to survive.
 *
 * The background arm carries the id and nothing else, which is the contract
 * `tool-bash` uses: the model collects the output with `job_output` and stops
 * the work with `job_kill`, and the registry owns the lifetime once the id is
 * published. Prose describing the outcome would be a second, unparseable copy
 * of what those tools already answer.
 */
const IMPORT_OUTPUT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'jobId'],
      properties: {
        kind: { type: 'string', const: 'background' },
        jobId: { type: 'string', description: 'Collect with job_output; stop with job_kill.' },
      },
    },
    FOREGROUND_ARM,
  ],
}

function importParameters(kind: ImportToolKind, extras: Record<string, unknown>): Record<string, unknown> {
  const sourceDescription =
    kind === 'mine'
      ? 'Absolute path to the source: a .dmb block model or a .dmf or .dmg Dimine drawing database.'
      : 'Absolute path to the source: a .dwg or .dxf drawing.'
  const outDescription =
    kind === 'mine'
      ? 'Where to write, absolute. Omit it and the product keeps the source\'s own directory and stem: '
        + '.dmb becomes .iamh. A .dmf or .dmg becomes .iam (Mining) or .iamp (Drawing) according to part. '
        + 'The default .dmg product keeps .dmg in its name.'
      : "Where to write the .iamp, absolute. Omit it and the product keeps the source's own directory and stem, "
        + 'so a drawing the user named is a file the user can find again.'
  return {
    type: 'object',
    additionalProperties: false,
    required: ['source'],
    properties: {
      source: { type: 'string', description: sourceDescription },
      out: { type: 'string', description: outDescription },
      ...extras,
    },
  }
}

// ----------------------------------------------------------------- the plumbing

interface ImportToolSpecification {
  name: string
  importKind: ImportToolKind
  description: string
  parameters: Record<string, unknown>
  /** The child's argv, in the importer's own words. */
  buildImportCommandArguments: (args: Record<string, unknown>) => string[]
  /** The command line as a user would read it, for the pending card. */
  formatImportCommandPreview: (args: Record<string, unknown>) => string
  /** The product path, for the `.report` sidecar. */
  resolveConversionOutputPath: (args: Record<string, unknown>) => string
}

/** The handle a background import returns, in the shape the schema declares. */
interface BackgroundOutcome {
  kind: 'background'
  jobId: string
}

/** What a job source reads before its producer has started. */
const NOTHING_YET = (fromByte: number): JobSourceRead => ({
  text: '',
  nextOffset: fromByte,
  lossy: false,
})

function isBackground(value: unknown): value is BackgroundOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'background'
  )
}

function createImportToolDefinition(
  importSpec: ImportToolSpecification,
  config: ImportPluginConfig,
  jobsOf: () => JobsRegistry | undefined,
): RawToolDefinition {
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  // Offered unless a deployment turns it off, and NOT gated on whether the jobs
  // service has arrived yet: `jobOf` is a lookup because the service can be
  // mounted after this tool is registered, and a parameter set decided at
  // registration would freeze the wrong answer. Whether it can actually run is
  // settled per call, below.
  const backgroundOffered = config.enableRunInBackground ?? true

  /**
   * Put one import on the job registry.
   *
   * The process is started INSIDE `run()`, not before it, and the output sources
   * are therefore lazy: the registry rejects work it cannot own before `run()`
   * runs, and a child spawned outside would then be an orphan nobody holds. The
   * sources read from `importerProcess` when they are pumped, which is after.
   */
  const startBackgroundImport = (
    registry: JobsRegistry,
    executablePath: string,
    commandArguments: readonly string[],
    conversionOutputPath: string,
    record: Record<string, unknown>,
    owner: string | undefined,
  ): BackgroundOutcome => {
    let importerProcess: RunningNativeToolProcess | undefined
    const label = importSpec.formatImportCommandPreview(record)
    const jobId = registry.start({
      kind: 'iam-import',
      label,
      ...(owner !== undefined ? { owner } : {}),
      output: [
        { channel: 'stdout', read: fromByte => (importerProcess ?? { readStdout: NOTHING_YET }).readStdout(fromByte) },
        { channel: 'stderr', read: fromByte => (importerProcess ?? { readStderr: NOTHING_YET }).readStderr(fromByte) },
      ],
      run: (job: JobHandle) => {
        job.updateProgress('converting')
        importerProcess = startNativeToolProcess({ executablePath, commandArguments, conversionOutputPath, timeoutMs })
        return {
          cancel: () => importerProcess?.cancel(),
          // `done` must not reject, and the registry converts a rejection into
          // `failed` -- which would lose the reason. A child that never spawned
          // is exactly that case, so it is caught and described here.
          done: importerProcess.completion.then(
            (outcome): JobOutcome => ({
              status: outcome.ok ? 'completed' : 'failed',
              detail: summarize({
                kind: 'foreground',
                ok: outcome.ok,
                out: conversionOutputPath,
                exitCode: outcome.exitCode,
                signal: outcome.signal,
                timedOut: outcome.timedOut,
                ...(outcome.conversionReport !== undefined ? { report: outcome.conversionReport } : {}),
                stdout: outcome.stdout,
                stderr: outcome.stderr,
                logTruncated: outcome.outputTruncated,
              }),
            }),
            (error: unknown): JobOutcome => ({
              status: 'failed',
              detail: error instanceof Error ? error.message : String(error),
            }),
          ),
        }
      },
    })
    return { kind: 'background', jobId }
  }

  return {
    name: importSpec.name,
    description: importSpec.description,
    parameters: backgroundOffered
      ? {
        ...importSpec.parameters,
        properties: {
          ...(importSpec.parameters.properties as Record<string, unknown>),
          run_in_background: {
            type: 'boolean',
            description:
                'Return a job id immediately instead of waiting. Collect with job_output, stop with job_kill. ' +
                'The importer still runs as a separate process and the same timeout still kills it if it hangs.',
          },
        },
      }
      : importSpec.parameters,
    output: {
      schema: IMPORT_OUTPUT_SCHEMA,
      render: (_args, value) =>
        isBackground(value)
          ? [
            {
              type: 'text',
              text:
                  `started background job ${value.jobId}. Collect its output with job_output ` +
                  'and stop it with job_kill.',
            },
          ]
          : [{ type: 'text', text: renderOutcome(value as ForegroundOutcome) }],
    },
    // The call IS a command line, so it gets the terminal card -- the same card
    // `tool-bash` uses, so a reader who has seen one of these has seen both.
    // A background call is not a terminal yet, and bash gives that one the
    // generic card for the same reason.
    presentCall: (args) => {
      const record = args as Record<string, unknown>
      if (record.run_in_background === true) {
        return { card: 'generic', title: importSpec.formatImportCommandPreview(record), kind: 'execute' }
      }
      return {
        card: 'terminal',
        title: importSpec.formatImportCommandPreview(record),
        description:
          'Converting in a separate process: the foreign-format readers can crash on some files, and this keeps that away from everything else.',
      }
    },
    presentResult: (_args, result) => {
      const value = result.value
      if (isBackground(value)) {
        return { card: 'generic', content: [{ type: 'text', text: `background job ${value.jobId}` }] }
      }
      if (typeof value !== 'object' || value === null) return undefined
      const outcome = value as ForegroundOutcome
      if (outcome.kind !== 'foreground') return undefined
      const rendered = renderOutcome(outcome)
      // exitCode and signal are mutually exclusive on this card, so a crash
      // reports the signal and not a code the child never produced.
      return outcome.signal !== null
        ? { card: 'terminal', output: rendered, signal: outcome.signal }
        : { card: 'terminal', output: rendered, exitCode: outcome.exitCode ?? 0 }
    },
    async execute(args, exec) {
      const record = (args ?? {}) as Record<string, unknown>
      // Resolved per call and not once at load: a tool that is installed later,
      // or a build that finishes while the harness is up, should be found
      // without a restart -- and the failure names every path it tried.
      const executablePath = resolveImportExecutablePath(importSpec.importKind, config.toolsDir)
      // The arguments first: `buildImportCommandArguments` validates `source`, and a call carrying
      // neither argument must be told about the source rather than about the
      // product name it could not derive without one.
      const commandArguments = importSpec.buildImportCommandArguments(record)
      const conversionOutputPath = importSpec.resolveConversionOutputPath(record)

      if (record.run_in_background === true) {
        // Checked at runtime as well as left out of the schema, because an
        // undeclared key still reaches execute: a model can send one that was
        // never offered, and silently ignoring it would run the import in the
        // foreground while the caller waits for a job id.
        const registry = jobsOf()
        if (!backgroundOffered || registry === undefined) {
          throw new Error(
            `${importSpec.name}: run_in_background is not available. ` +
              (registry === undefined
                ? 'The jobs service is not mounted in this profile.'
                : 'It is disabled by this deployment (enableRunInBackground: false).'),
          )
        }
        // The registry owns the work once the id is published, so a cancel that
        // arrives before that point is the only one this call can honour.
        if (exec.signal.aborted) throw new Error(`${importSpec.name}: cancelled before it started`)
        const owner = (exec as { agent?: { id?: string } }).agent?.id
        return startBackgroundImport(registry, executablePath, commandArguments, conversionOutputPath, record, owner)
      }

      const outcome: NativeToolProcessOutcome = await runNativeToolProcess({
        executablePath,
        commandArguments,
        conversionOutputPath,
        timeoutMs,
        abortSignal: exec.signal,
      })
      const value: ForegroundOutcome = {
        kind: 'foreground',
        ok: outcome.ok,
        out: conversionOutputPath,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        ...(outcome.conversionReport !== undefined ? { report: outcome.conversionReport } : {}),
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        logTruncated: outcome.outputTruncated,
      }
      return value
    },
  }
}

// ------------------------------------------------------------------- the tools

export function createMiningImportTool(
  config: ImportPluginConfig,
  jobsOf: () => JobsRegistry | undefined,
): RawToolDefinition {
  return createImportToolDefinition(
    {
      name: 'import_mine',
      importKind: 'mine',
      description:
        'Convert a Dimine source into a platform store, in a separate process. ' +
        'A .dmb block model becomes an .iamh columnar store. A .dmf or .dmg can carry Mining and Drawing content, ' +
        'so `part` chooses which one to write (.iam for the mine, .iamp for the drawing) and the other half ' +
        'is reported as dropped. The product is named after the source unless `out` says otherwise, so the ' +
        'name the user already knows is the name of the file to open. ' +
        "Answer with the result's `link` line copied verbatim, and never retype the path into a link: a backslash " +
        'in a markdown destination is eaten before the link is followed, and the file it names stops existing. ' +
        "The result's `report` carries what the conversion counted and what it could " +
        'not carry; read it rather than the log, because the vendor reader writes to the log on its own schedule ' +
        'and in its own encoding. A non-zero exit is still a completed call -- inspect `signal` to tell a crash ' +
        'from a refusal.',
      parameters: importParameters('mine', {
        part: {
          type: 'string',
          enum: ['mining', 'drawing'],
          description:
            'Which part of a .dmf or .dmg to write. Ignored for .dmb. Defaults to mining.',
        },
        maxCells: {
          type: 'integer',
          description: 'Refuse a block model with more cells than this, rather than importing a model too large to be useful.',
        },
        batchRows: {
          type: 'integer',
          description: 'How many rows to write per batch when producing the store. A tuning knob; the default is rarely wrong.',
        },
      }),
      buildImportCommandArguments: (args) => {
        const argv = ['--import', requireString(args, 'source', 'import_mine'), '--out', requireProduct('mine', args, 'import_mine')]
        const part = optionalString(args, 'part')
        if (part !== undefined) argv.push('--part', part)
        const maxCells = optionalInteger(args, 'maxCells', 'import_mine')
        if (maxCells !== undefined) argv.push('--max-cells', String(maxCells))
        const batchRows = optionalInteger(args, 'batchRows', 'import_mine')
        if (batchRows !== undefined) argv.push('--batch-rows', String(batchRows))
        return argv
      },
      formatImportCommandPreview: args =>
        `IamImportTool --import ${String(args.source ?? '?')} --out ${productPath('mine', args) ?? '?'}`,
      resolveConversionOutputPath: args => requireProduct('mine', args, 'import_mine'),
    },
    config,
    jobsOf,
  )
}

export function createDrawingImportTool(
  config: ImportPluginConfig,
  jobsOf: () => JobsRegistry | undefined,
): RawToolDefinition {
  return createImportToolDefinition(
    {
      name: 'import_drawing',
      importKind: 'drawing',
      description:
        "Convert a DWG or DXF drawing into this platform's own .iamp format, in a separate process. " +
        'The product is named after the source unless `out` says otherwise, so the drawing the user asked for by ' +
        'name is the file that appears beside it and can be opened from the sidebar. ' +
        "Answer with the result's `link` line copied verbatim, and never retype the path into a link: a backslash " +
        'in a markdown destination is eaten before the link is followed, and the file it names stops existing. ' +
        'Import is conversion plus a report of what was lost, not a round trip: the model space is counted at both ' +
        'ends of the conversion and the classes that lost objects come back in `report.lost`, by class name and ' +
        'count, with `source - lost == reload` holding by construction. Read `report.lost` rather than the console ' +
        'log: a class the writer never reported -- a proxy entity, a region -- appears there and nowhere else. ' +
        'A non-zero exit is still a completed call -- inspect `signal` to tell a crash from a refusal.',
      parameters: importParameters('drawing', {
        project: { type: 'string', description: 'Project id to record on the converted sheet. Defaults to "import".' },
        sheetId: { type: 'string', description: 'Sheet id to record, so the result is identified by design rather than by filename.' },
        revision: { type: 'integer', description: 'Revision number to record on the converted sheet.' },
        viewSpec: { type: 'string', description: 'View specification text to record on the converted sheet.' },
      }),
      buildImportCommandArguments: (args) => {
        const argv = ['--import', requireString(args, 'source', 'import_drawing'), '--out', requireProduct('drawing', args, 'import_drawing')]
        const project = optionalString(args, 'project')
        if (project !== undefined) argv.push('--project', project)
        const sheetId = optionalString(args, 'sheetId')
        if (sheetId !== undefined) argv.push('--sheet-id', sheetId)
        const revision = optionalInteger(args, 'revision', 'import_drawing')
        if (revision !== undefined) argv.push('--revision', String(revision))
        const viewSpec = optionalString(args, 'viewSpec')
        if (viewSpec !== undefined) argv.push('--view-importSpec', viewSpec)
        return argv
      },
      formatImportCommandPreview: args =>
        `IaxDrawingImportTool --import ${String(args.source ?? '?')} --out ${productPath('drawing', args) ?? '?'}`,
      resolveConversionOutputPath: args => requireProduct('drawing', args, 'import_drawing'),
    },
    config,
    jobsOf,
  )
}

/**
 * Describe a drawing's file structure or query its entities. A live document
 * or selection uses the provider attached by Views. A file query uses the
 * native entity query executable and reads its temporary JSON response.
 */
export function createDrawingDescriptionTool(config: ImportPluginConfig): RawToolDefinition {
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  return {
    name: 'describe_drawing',
    description:
      'Read drawing structure or entities from a .iamp/.iaxp file, the current drawing document, or the live view selection. ' +
      'Entity JSON includes text, coordinates, geometry, loaded database handles, original file record indices, and document digest. Import DWG/DXF explicitly first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { type: 'string', description: 'file, document, or selection. A legacy absolute .iamp path is also accepted as file.' },
        path: { type: 'string', description: 'Absolute .iamp/.iaxp path when source=file.' },
        scope: {
          type: 'string', enum: ['structure', 'entities'],
          description: 'Files default to structure; document/selection default to entities. Structure uses the existing file projection.',
        },
        class: { type: 'string', description: 'Optional serialized entity class filter, such as AcDbText.' },
        layer: { type: 'string', description: 'Optional exact layer name filter.' },
        bbox: {
          type: 'array', minItems: 6, maxItems: 6, items: { type: 'number' },
          description: 'Optional [minX,minY,minZ,maxX,maxY,maxZ] model-space bounds.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Entity page size; defaults to 1000.' },
        after_handle: { type: 'string', description: 'Continue after page.next_after_handle, including its block instance path.' },
        document_digest: { type: 'string', description: 'Required with after_handle: copy the same source previous page token verbatim. Scoped to source and font environment; use origin_digest for loaded-file provenance.' },
        selection_version: { type: 'integer', minimum: 0, description: 'Required for selection pagination: previous page selection_version; reject if the user changed the selection.' },
        expand_blocks: { type: 'boolean', default: true, description: 'Recursively expand block references with instance transforms.' },
        max_bytes: { type: 'integer', minimum: 4096, maximum: MAX_DRAWING_JSON_BYTES, description: 'Maximum JSON bytes, defaults to 4 MiB; pages also stop at this bound.' },
        verbose: { type: 'boolean', description: 'Include the fuller projection, not only the summary.' },
      },
    },
    output: {
      // Annotation-only, which the schema subset accepts as unconstrained JSON:
      // the projection is the platform's own and its shape is not this plugin's
      // to declare. Declaring it field by field would be a second copy of a
      // format that already has one owner.
      schema: { description: "The platform's text projection of the drawing, parsed." },
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) },
      ],
    },
    presentCall: (args) => {
      const record = args as Record<string, unknown>
      return {
        card: 'terminal',
        title: record.scope === 'entities' || record.source === 'document' || record.source === 'selection' ? `Drawing entities: ${String(record.path ?? record.source ?? '?')}`
          : `IaxDrawingImportTool --describe ${String(record.path ?? record.source ?? '?')}`,
        description: 'Reading the drawing, not converting it.',
      }
    },
    async execute(rawArguments, executionContext) {
      const toolArguments = (rawArguments ?? {}) as Record<string, unknown>
      const requestedSource = requireString(toolArguments, 'source', 'describe_drawing')
      const isLiveViewSource = requestedSource === 'document' || requestedSource === 'selection'
      const drawingPath = requestedSource === 'file' ? requireString(toolArguments, 'path', 'describe_drawing') : requestedSource
      const scope = toolArguments.scope ?? (isLiveViewSource ? 'entities' : 'structure')
      if (scope !== 'structure' && scope !== 'entities')
        throw new Error('describe_drawing: scope must be structure or entities')
      const includeFullStructure = toolArguments.verbose === true
      if (isLiveViewSource) {
        if (scope !== 'entities') throw new Error('describe_drawing: document/selection sources require scope=entities; use source=file for the existing structure projection.')
        const queryLiveDrawingEntities = (globalThis as unknown as {
          __iamDrawingEntityQuery?: (queryArguments: Record<string, unknown>, executionContext: unknown) => Promise<unknown>
        }).__iamDrawingEntityQuery
        if (queryLiveDrawingEntities === undefined)
          return { error: { code: 'no_view', message: '没有挂载视图；请先打开图纸视图，或用 source="file" 和 path 查询 .iamp。' } }
        return queryLiveDrawingEntities(toolArguments, executionContext)
      }
      const executablePath = scope === 'entities'
        ? resolveDrawingEntityQueryExecutablePath(config.toolsDir)
        : resolveImportExecutablePath('drawing', config.toolsDir)
      if (scope === 'entities') {
        const temporaryQueryDirectory = mkdtempSync(join(tmpdir(), 'iax-drawing-query-'))
        const entityPagePath = join(temporaryQueryDirectory, 'entities.json')
        try {
          const maximumEntitiesPerPage = optionalInteger(toolArguments, 'limit', 'describe_drawing') ?? 1000
          if (maximumEntitiesPerPage > 5000) throw new Error('describe_drawing: limit must not exceed 5000')
          const commandArguments = [drawingPath, '--out', entityPagePath, '--limit', String(maximumEntitiesPerPage)]
          const entityClassName = optionalString(toolArguments, 'class')
          const layerName = optionalString(toolArguments, 'layer')
          const afterEntityCursor = optionalString(toolArguments, 'after_handle')
          const expectedPaginationDigest = optionalString(toolArguments, 'document_digest')
          if (expectedPaginationDigest) commandArguments.push('--document-digest', expectedPaginationDigest)
          if (toolArguments.expand_blocks !== undefined && typeof toolArguments.expand_blocks !== 'boolean')
            throw new Error('describe_drawing: expand_blocks must be boolean')
          if (toolArguments.expand_blocks === false) commandArguments.push('--no-expand-blocks')
          const maximumResponseBytes = optionalInteger(toolArguments, 'max_bytes', 'describe_drawing') ?? 4 * 1024 * 1024
          if (maximumResponseBytes < 4096 || maximumResponseBytes > MAX_DRAWING_JSON_BYTES)
            throw new Error('describe_drawing: max_bytes must be between 4096 and 67108864')
          commandArguments.push('--max-bytes', String(maximumResponseBytes))
          if (entityClassName) commandArguments.push('--class', entityClassName)
          if (layerName) commandArguments.push('--layer', layerName)
          if (afterEntityCursor) commandArguments.push('--after', afterEntityCursor)
          if (toolArguments.bbox !== undefined) {
            const worldBounds = toolArguments.bbox
            if (!Array.isArray(worldBounds) || worldBounds.length !== 6 ||
                worldBounds.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))
              throw new Error('describe_drawing: bbox must contain six finite numbers')
            commandArguments.push('--bbox', ...worldBounds.map(String))
          }
          const queryOutcome = await runNativeToolProcess({
            executablePath, commandArguments, timeoutMs,
            abortSignal: executionContext.signal, streamCaptureLimitBytes: MAX_DRAWING_JSON_BYTES,
          })
          if (!queryOutcome.ok)
            throw new Error(`describe_drawing: entity query failed (exit ${queryOutcome.exitCode ?? 'signal ' + queryOutcome.signal})\n` +
              renderOutcome({ kind: 'foreground', ok: false, out: drawingPath,
                exitCode: queryOutcome.exitCode, signal: queryOutcome.signal, timedOut: queryOutcome.timedOut,
                stdout: queryOutcome.stdout, stderr: queryOutcome.stderr, logTruncated: queryOutcome.outputTruncated }))
          const entityPageByteCount = statSync(entityPagePath).size
          if (entityPageByteCount > MAX_DRAWING_JSON_BYTES)
            throw new Error(`describe_drawing: entity result is ${entityPageByteCount} bytes, above the ${MAX_DRAWING_JSON_BYTES} byte limit; narrow the query with filters.`)
          try { return JSON.parse(readFileSync(entityPagePath, 'utf8')) as unknown }
          catch { throw new Error('describe_drawing: IaxDrawingQuery wrote invalid JSON') }
        } finally {
          rmSync(temporaryQueryDirectory, { recursive: true, force: true })
        }
      }
      // No conversion output path: a describe run names no product, so there is no `.report`
      // sidecar to read and nothing beside the drawing to clean up. Passing a
      // made-up path would have the converter looking for a note about a run
      // that never writes one.
      const outcome = await runNativeToolProcess({
        executablePath,
        commandArguments: includeFullStructure ? ['--describe', drawingPath, '--verbose'] : ['--describe', drawingPath],
        timeoutMs,
        abortSignal: executionContext.signal,
        // Here stdout IS the answer, so the log bound would corrupt it rather
        // than shorten it -- measured, a 5,725-entity drawing projects to 700 KB
        // and the first version of this file truncated it and then reported a
        // JSON parse error, blaming the tool for this plugin's cap.
        streamCaptureLimitBytes: MAX_DRAWING_JSON_BYTES,
      })
      if (outcome.outputTruncated) {
        // Named rather than left to surface as a parse error: the caller can act
        // on "the projection is larger than N bytes", and cannot on "invalid
        // JSON, first line: {".
        throw new Error(
          `describe_drawing: the projection of ${drawingPath} exceeds ${MAX_DRAWING_JSON_BYTES} bytes and ` +
            'was not returned whole. Retry without `verbose`.',
        )
      }
      if (!outcome.ok) {
        throw new Error(
          `describe_drawing: the drawing could not be read (exit ${outcome.exitCode ?? 'signal ' + outcome.signal})\n` +
            renderOutcome({
              kind: 'foreground',
              ok: false,
              out: drawingPath,
              exitCode: outcome.exitCode,
              signal: outcome.signal,
              timedOut: outcome.timedOut,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              logTruncated: outcome.outputTruncated,
            }),
        )
      }
      try {
        return JSON.parse(outcome.stdout) as unknown
      } catch {
        // Loud, not silent: a projection that is not JSON is a finding about the
        // tool, and returning the text as if it were the document would hide it.
        throw new Error(
          'describe_drawing: expected strict JSON from --describe and got something else. First line: ' +
            JSON.stringify(outcome.stdout.split('\n', 1)[0] ?? ''),
        )
      }
    },
  }
}
