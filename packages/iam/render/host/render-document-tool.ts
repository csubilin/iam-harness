import { statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { resolveHeadlessRendererExecutablePath } from './headless-renderer-path.js'
import { isFile, readSupportedRendererOptions, renderHeadlessFrameToPng } from './headless-render-process.js'

type TextBlock = { type: 'text'; text: string }

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
  presentCall?: (args: unknown) => ResultIntent | undefined
  presentResult?: (args: unknown, result: { value?: unknown; content?: unknown[] }) => ResultIntent | undefined
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
}

export interface RenderPluginConfig {
  /** Directory holding the renderer executable, when it is not in the build tree. */
  toolsDir?: string
  /** Default frame width, in pixels. */
  width?: number
  /** Default frame height, in pixels. */
  height?: number
  /** How long one frame may take. */
  timeoutSeconds?: number
}

export interface RenderPayload {
  /** The PNG that was written, with forward slashes so it can be linked. */
  png: string
  width: number
  height: number
  bytes: number
  document: string
  /** The command line that produced it, ready to paste into a shell. */
  command: string
  /** Options the renderer does not know about, or that a higher-priority one superseded. */
  skipped: string[]
  /** A non-fatal finding: a nonzero exit after a good frame, an unexpected size. */
  note?: string
  exitCode: number | null
  /** The renderer's own last words; empty on a clean run. */
  stderrTail?: string
}

export interface HeadlessRenderArgumentOptions {
  width: number
  height: number
  cameraSpec?: string
  viewPreset?: string
  fitElementIds: string[]
  fitWorldBounds?: number[]
  overlays: string[]
  includeImGui: boolean
}

export interface HeadlessRenderArgumentPlan {
  commandArguments: string[]
  skippedOptions: string[]
}

const VIEW_PRESETS = ['iso', 'top', 'front', 'side', 'section', 'current'] as const
const AVAILABLE_OVERLAYS = ['axis', 'legend', 'scale'] as const

function readNonemptyStringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function readFiniteNumberField(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function requireString(args: Record<string, unknown>, key: string, tool: string): string {
  const value = readNonemptyStringField(args, key)
  if (value === undefined) throw new Error(`${tool}: \`${key}\` is required and must be a non-empty string`)
  return value
}

function readStringArrayField(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[] | undefined,
): string[] {
  const value = args[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`iam_render_document: \`${key}\` must be an array of strings`)
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`iam_render_document: \`${key}\` must contain only non-empty strings`)
    }
    if (allowed !== undefined && !allowed.includes(entry)) {
      throw new Error(
        `iam_render_document: \`${key}\` contains ${JSON.stringify(entry)}; expected one of ${allowed.join(', ')}`,
      )
    }
    result.push(entry)
  }
  return result
}

function readFitWorldBounds(args: Record<string, unknown>): number[] | undefined {
  const value = args.fitBbox
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 6 ||
      !value.every(entry => typeof entry === 'number' && Number.isFinite(entry))) {
    throw new Error('iam_render_document: `fitBbox` must be six finite numbers [x0,y0,z0,x1,y1,z1]')
  }
  return value as number[]
}

/** One line saying what happened; it goes first, before any log. */
function summarizeRenderedDocument(payload: RenderPayload): string {
  const size = payload.width > 0 ? `${payload.width}x${payload.height}, ${(payload.bytes / 1024).toFixed(0)} KB` : 'no frame'
  const status = payload.exitCode === 0 ? 'ok' : `ok (renderer exited ${payload.exitCode})`
  const skipped = payload.skipped.length > 0 ? ` skipped: ${payload.skipped.join(',')}` : ''
  const note = payload.note !== undefined ? ` -- ${payload.note}` : ''
  return `${status}: ${payload.png} (${size})${note}${skipped}`
}

/**
 * The default output path: beside the document, named after it and the view.
 *
 * Beside the document rather than in a temp directory because the picture is a
 * deliverable a person opens, and a temp path is one they lose.
 */
function defaultPngOutputPath(documentPath: string, viewPreset: string | undefined): string {
  const documentStem = basename(documentPath, extname(documentPath))
  const presetSuffix = viewPreset !== undefined ? `.${viewPreset}` : ''
  return join(dirname(documentPath), `${documentStem}.render${presetSuffix}.png`)
}

/**
 * Turn the caller's selection into the renderer's command line.
 *
 * The precedence is the tool contract's: an explicit camera, then element
 * framing, then a world box, then a view preset, then a plain fit. Only ONE of
 * those is passed, because they compete; every other requested selector is named
 * in `skipped` as superseded, and a selector the installed renderer does not
 * list is named as unsupported. Nothing requested disappears without a line
 * saying so.
 *
 * Exported separately from `execute` so the rule can be tested against a
 * capability set written in a test rather than by building an old renderer.
 */
export function planHeadlessRenderArguments(
  renderOptions: HeadlessRenderArgumentOptions,
  supportedOptions: ReadonlySet<string>,
): HeadlessRenderArgumentPlan {
  const commandArguments: string[] = ['--width', String(renderOptions.width), '--height', String(renderOptions.height)]
  const skippedOptions: string[] = []

  interface FramingCandidate {
    parameterName: string
    rendererFlag: string
    displayLabel: string
    appendArguments: (argumentsToBuild: string[]) => void
  }
  const framingCandidates: FramingCandidate[] = []
  if (renderOptions.fitElementIds.length > 0) {
    framingCandidates.push({
      parameterName: 'fitElements',
      rendererFlag: '--fit-elements',
      displayLabel: `fitElements=${renderOptions.fitElementIds.join(',')}`,
      appendArguments: argumentsToBuild => argumentsToBuild.push('--fit-elements', renderOptions.fitElementIds.join(',')),
    })
  }
  if (renderOptions.fitWorldBounds !== undefined) {
    framingCandidates.push({
      parameterName: 'fitBbox',
      rendererFlag: '--fit-bbox',
      displayLabel: `fitBbox=${renderOptions.fitWorldBounds.join(',')}`,
      appendArguments: argumentsToBuild => argumentsToBuild.push('--fit-bbox', renderOptions.fitWorldBounds!.join(',')),
    })
  }
  if (renderOptions.viewPreset !== undefined) {
    framingCandidates.push({
      parameterName: 'view',
      rendererFlag: '--view',
      displayLabel: `view=${renderOptions.viewPreset}`,
      appendArguments: argumentsToBuild =>
        argumentsToBuild.push('--view', renderOptions.viewPreset === 'section' ? 'section:0' : renderOptions.viewPreset!),
    })
  }

  if (renderOptions.cameraSpec !== undefined) {
    commandArguments.push('--camera', renderOptions.cameraSpec)
    for (const candidate of framingCandidates)
      skippedOptions.push(`${candidate.displayLabel} (superseded by camera)`)
  } else {
    let selectedFraming: FramingCandidate | undefined
    for (const candidate of framingCandidates) {
      if (supportedOptions.has(candidate.rendererFlag)) {
        selectedFraming = candidate
        candidate.appendArguments(commandArguments)
        break
      }
      skippedOptions.push(`${candidate.displayLabel} (${candidate.rendererFlag} unsupported)`)
    }
    for (const candidate of framingCandidates) {
      if (candidate === selectedFraming) continue
      if (skippedOptions.some(description => description.startsWith(candidate.displayLabel))) continue
      skippedOptions.push(`${candidate.displayLabel} (superseded by ${selectedFraming?.parameterName ?? 'fit'})`)
    }
    if (selectedFraming === undefined && supportedOptions.has('--fit')) commandArguments.push('--fit')
  }

  if (renderOptions.overlays.length > 0) {
    if (supportedOptions.has('--overlay'))
      commandArguments.push('--overlay', renderOptions.overlays.join(','))
    else
      skippedOptions.push(`overlay=${renderOptions.overlays.join('+')} (--overlay unsupported)`)
  }
  if (renderOptions.includeImGui) {
    if (supportedOptions.has('--imgui')) commandArguments.push('--imgui')
    else skippedOptions.push('imgui (--imgui unsupported)')
  }

  return { commandArguments, skippedOptions }
}

export function createRenderDocumentTool(config: RenderPluginConfig = {}): RawToolDefinition {
  const defaultWidth = config.width ?? 1600
  const defaultHeight = config.height ?? 900
  const configuredTimeoutSeconds = config.timeoutSeconds ?? 300
  const defaultTimeoutMs = (configuredTimeoutSeconds > 0 ? configuredTimeoutSeconds : 300) * 1000

  // The probe is per executable and cached for the life of the plugin: re-reading
  // `--help` for every frame would put a second process spawn in a batch loop for
  // no new information. Keyed by the file's size and modification time as well as
  // its path, so rebuilding the renderer in place is noticed rather than answered
  // from a stale cache.
  const supportedOptionsByExecutable = new Map<string, Set<string>>()
  const rendererVersionCacheKey = (executablePath: string): string => {
    try {
      const executableStats = statSync(executablePath)
      return `${executablePath}:${executableStats.size}:${executableStats.mtimeMs}`
    } catch {
      return executablePath
    }
  }
  const supportedOptionsForRenderer = async (executablePath: string): Promise<Set<string>> => {
    const cacheKey = rendererVersionCacheKey(executablePath)
    const cachedOptions = supportedOptionsByExecutable.get(cacheKey)
    if (cachedOptions !== undefined) return cachedOptions
    const supportedOptions = await readSupportedRendererOptions(executablePath, Math.min(defaultTimeoutMs, 20000))
    supportedOptionsByExecutable.set(cacheKey, supportedOptions)
    return supportedOptions
  }

  return {
    name: 'iam_render_document',
    description:
      "Render a Mining or drawing document to a PNG with the platform's own headless renderer " +
      '(IamNativeHeadlessMining). Use it when a picture of a project is needed for a report, a review, ' +
      'or to check what a build produced. Options the installed renderer does not support are reported ' +
      'as skipped rather than failing the render.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['document'],
      properties: {
        document: {
          type: 'string',
          description: 'Absolute path to the document (.iam, .iamh, .iamp, .iaxp).',
        },
        out: {
          type: 'string',
          description: 'Where to write the PNG. Defaults to beside the document, named <stem>.render[.<view>].png.',
        },
        width: { type: 'integer', description: `Frame width in pixels (default ${defaultWidth}, minimum 64).` },
        height: { type: 'integer', description: `Frame height in pixels (default ${defaultHeight}, minimum 64).` },
        view: {
          type: 'string',
          enum: VIEW_PRESETS as unknown as string[],
          description:
            'Camera preset. section means the first section plane. Used only when the installed ' +
            'renderer supports --view.',
        },
        fitElements: {
          type: 'array',
          items: { type: 'string' },
          description: 'Element ids to frame, e.g. ["orebody-RE1"]. Used only when --fit-elements is supported.',
        },
        fitBbox: {
          type: 'array',
          items: { type: 'number' },
          description: 'World box [x0,y0,z0,x1,y1,z1] to frame. Used only when --fit-bbox is supported.',
        },
        overlay: {
          type: 'array',
          items: { type: 'string', enum: AVAILABLE_OVERLAYS as unknown as string[] },
          description: 'Axis/legend/scale overlays. Used only when --overlay is supported.',
        },
        imgui: { type: 'boolean', description: 'Draw the view’s own ImGui layer (toolbar, axis).' },
        camera: {
          type: 'string',
          description: 'Raw camera "panX,panY,rotX,rotY,zoom", passed through unchanged.',
        },
        timeoutSeconds: { type: 'integer', description: 'How long the frame may take.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        description: 'What was written: the PNG path and its size, the command line, and what was skipped.',
        properties: {
          png: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          document: { type: 'string' },
          command: { type: 'string' },
          skipped: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          // The harness's JSON Schema subset has no type arrays: a nullable
          // scalar is `oneOf`, the same spelling Import uses for its exit code.
          exitCode: {
            oneOf: [{ type: 'integer' }, { type: 'null' }],
            description: 'The renderer\'s exit code; null when it was killed by a signal.',
          },
          stderrTail: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const payload = value as RenderPayload
        const lines = [summarizeRenderedDocument(payload), '', `command: ${payload.command}`]
        if (payload.stderrTail !== undefined && payload.stderrTail.trim() !== '') {
          lines.push('', 'renderer stderr (tail):', payload.stderrTail.trim())
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({ png: (value as RenderPayload).png }),
    },
    presentCall: (args) => {
      const record = (args ?? {}) as Record<string, unknown>
      return {
        card: 'terminal',
        title: `IamNativeHeadlessMining --out ${String(record.document ?? '?')}.png`,
        description: 'Rendering one frame with the platform’s own viewer.',
      }
    },
    presentResult: (_args, result) => {
      const payload = result.value as RenderPayload | undefined
      if (payload === undefined) return undefined
      return { card: 'generic', content: [{ type: 'text', text: summarizeRenderedDocument(payload) }] }
    },
    async execute(rawArguments, executionContext) {
      const toolArguments = (rawArguments ?? {}) as Record<string, unknown>
      const documentPath = requireString(toolArguments, 'document', 'iam_render_document')

      // EVERY document check precedes the subprocess. A missing file or a
      // relative path is a caller's mistake, and starting a renderer to find out
      // costs seconds and produces a diagnosis about a different thing.
      if (!isAbsolute(documentPath)) {
        throw new Error(`iam_render_document: \`document\` must be an absolute path, got ${JSON.stringify(documentPath)}`)
      }
      if (!isFile(documentPath)) {
        throw new Error(`iam_render_document: no such file: ${documentPath}`)
      }

      const frameWidth = Math.max(64, Math.round(readFiniteNumberField(toolArguments, 'width') ?? defaultWidth))
      const frameHeight = Math.max(64, Math.round(readFiniteNumberField(toolArguments, 'height') ?? defaultHeight))
      const viewPreset = readNonemptyStringField(toolArguments, 'view')
      if (viewPreset !== undefined && !VIEW_PRESETS.includes(viewPreset as (typeof VIEW_PRESETS)[number])) {
        throw new Error(
          `iam_render_document: unknown view ${JSON.stringify(viewPreset)}; expected one of ${VIEW_PRESETS.join(', ')}`,
        )
      }
      const fitElementIds = readStringArrayField(toolArguments, 'fitElements', undefined)
      const fitWorldBounds = readFitWorldBounds(toolArguments)
      const overlays = readStringArrayField(toolArguments, 'overlay', AVAILABLE_OVERLAYS)
      const cameraSpec = readNonemptyStringField(toolArguments, 'camera')
      const requestedTimeoutSeconds = readFiniteNumberField(toolArguments, 'timeoutSeconds')
      const timeoutMs = requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds > 0
        ? requestedTimeoutSeconds * 1000 : defaultTimeoutMs

      const executablePath = resolveHeadlessRendererExecutablePath(config.toolsDir)
      const supportedOptions = await supportedOptionsForRenderer(executablePath)
      const renderPlan = planHeadlessRenderArguments(
        {
          width: frameWidth,
          height: frameHeight,
          cameraSpec,
          viewPreset,
          fitElementIds,
          fitWorldBounds,
          overlays,
          includeImGui: toolArguments.imgui === true,
        },
        supportedOptions,
      )

      const pngOutputPath = readNonemptyStringField(toolArguments, 'out') ?? defaultPngOutputPath(documentPath, viewPreset)
      const outcome = await renderHeadlessFrameToPng({
        executablePath,
        commandArguments: [...renderPlan.commandArguments, documentPath],
        pngOutputPath,
        expectedWidth: frameWidth,
        expectedHeight: frameHeight,
        timeoutMs,
        abortSignal: executionContext.signal,
      })

      const payload: RenderPayload = {
        png: outcome.pngOutputPath.replace(/\\/g, '/'),
        width: outcome.width,
        height: outcome.height,
        bytes: outcome.pngByteCount,
        document: documentPath,
        command: outcome.replayCommandLine,
        skipped: renderPlan.skippedOptions,
        exitCode: outcome.exitCode,
      }
      // Absent fields must be ABSENT, not `undefined`: a tool result crosses to
      // the harness as JSON, and `undefined` is not a JSON value -- the first
      // version of this returned `note: undefined` and the caller was told the
      // result was "not lossless JSON".
      if (outcome.note !== undefined) payload.note = outcome.note
      if (outcome.stderr.trim() !== '') {
        payload.stderrTail = outcome.stderr.trim().split('\n').slice(-6).join('\n')
      }
      if (!outcome.ok) {
        throw new Error(
          `iam_render_document: ${outcome.note ?? 'the renderer produced no frame'} ` +
            `(exit ${outcome.exitCode ?? `signal ${outcome.signal}`}` +
            `${outcome.timedOut ? ', timed out' : ''}${outcome.cancelled ? ', cancelled' : ''})\n` +
            `command: ${payload.command}\n` +
            (payload.stderrTail !== undefined ? `stderr:\n${payload.stderrTail}\n` : ''),
        )
      }
      return payload
    },
  }
}
