import { callBridge, type BridgeOptions } from './python.js'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** What the plugin's patch row may configure. */
export interface BridgePluginConfig extends BridgeOptions {
  /** A bridge call's default deadline, in seconds. */
  timeoutSeconds?: number
  /**
   * Where the user's workspace is, if the deployment knows.
   *
   * The bridge has no way to find it: a Harness session has a working directory
   * and a plugin does not, so the profile's row is the only place this can be
   * said once.  Every tool that takes a `workspace` argument falls back to it,
   * and with neither the workspace-rooted half of the workflow catalog is simply
   * absent -- which is why it is a setting and not a guess.
   */
  workspace?: string
}

/**
 * What `execute` is handed besides the arguments.
 *
 * `agent` is the Session the call belongs to, and it is the reason this plugin
 * does not need a configured workspace: the Harness has a `workingDirectory`
 * service that answers, per session, which directory that session is working in.
 * The host half passes a probe onto it -- see `host/index.ts`.
 */
export interface ToolExec {
  signal: AbortSignal
  agent?: unknown
}

/** Asks the Harness which directory the calling session is working in. */
export type WorkspaceProbe = (exec: ToolExec) => Promise<string | undefined>

/**
 * The workspace a call is about: the one it named, else the SESSION's, else the
 * one the deployment configured.
 *
 * The session's directory is asked for rather than assumed, and it beats the
 * configured one because a profile is deployment-wide while a session's
 * workspace is the actual one -- a host with several workspaces open would
 * otherwise write a user's workflows into whichever one the profile named.
 *
 * NOT the process's working directory: that is wherever a server happened to be
 * started, and pointing a tool that WRITES at it would put a user's workflows
 * somewhere nobody chose.  A session's directory is a fact the Harness tracks
 * and validates; a server's cwd is an accident.
 */
async function workspaceOf(
  args: unknown,
  config: BridgePluginConfig,
  probe: WorkspaceProbe | undefined,
  exec: ToolExec,
): Promise<string | undefined> {
  const named = optionalString(args, 'workspace')
  if (named !== undefined && named.trim() === '') throw new Error('"workspace" must name a directory')
  const session = await probe?.(exec)
  const anchor = session ?? config.workspace
  if (named === undefined) return anchor
  if (anchor === undefined) {
    if (config.allowUnsafeExecution === true) return named
    throw new Error('A named workspace needs a validated session directory or configured workspace root')
  }
  const root = realpathSync(anchor)
  const target = realpathSync(named)
  const inside = relative(root, target)
  if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
    throw new Error('The named workspace is outside this session or deployment workspace')
  }
  return target
}

function workspaceArgument(arguments_: string[], workspace: string | undefined): void {
  if (workspace) arguments_.push('--workspace', workspace)
}

// --------------------------------------------------------------- the vocabulary
//
// Structural, and only what this plugin emits: a text block and the two cards
// the harness renders.  The `terminal` card is the one `tool-bash` uses, so a
// program's output lands where a reader already knows to look for output.

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

export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  presentCall?: (args: unknown) => RenderIntent | undefined
  presentResult?: (args: unknown, result: { value?: unknown; content?: unknown[] }) => ResultIntent | undefined
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>
}

/**
 * A tool's VALUE, which is what `execute` returns and `render` turns into text.
 *
 * NOT `{ content, isError }`.  That is MCP's result envelope, and returning one
 * from `execute` is what produced `Error: content.some is not a function` in the
 * harness -- the loader saw an object carrying a `content` member, took it for
 * the envelope, and called an array method on what was inside.  The contract
 * here is Import's: `execute` returns whatever the tool computed, `render`
 * describes it, and a failure that the caller has to read is either part of the
 * value or a thrown Error.
 */
type ToolValue = Record<string, unknown>

const objectSchema = { type: 'object', additionalProperties: true } as const

/** The one renderer every tool in this plugin uses: the value, as JSON. */
function renderValue(_args: unknown, value: unknown): TextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

// ------------------------------------------------------------------ validation
//
// What the schema cannot express.  A JSON Schema says `string`; it does not say
// "non-empty", and an empty id would reach the catalog and come back as a
// not-found that blames the catalog.

function requireString(args: unknown, name: string): string {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`"${name}" is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: unknown, name: string): string | undefined {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string`)
  return value
}

function optionalNumber(args: unknown, name: string): number | undefined {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${name}" must be a finite number`)
  }
  return value
}

/**
 * The bridge's answer, or a thrown Error when there is none.
 *
 * THROWING IS THE FAILURE PATH, and the split it draws is deliberate.  A
 * non-zero bridge exit means the bridge could not answer at all -- no library,
 * no such algorithm id, no such verb -- and a thrown Error is what the harness
 * shows the model as a tool error, message and all.  A workflow's refusal is the
 * other kind and does NOT come through here: it exits 0 with `{ok: false,
 * refused: "..."}` and is a value the model reads and corrects itself from.
 *
 * Zero exit with unparseable stdout is neither, and it is a defect in the bridge
 * rather than in the call, so it says so instead of reporting a JSON error.
 */
function fromBridge(outcome: Awaited<ReturnType<typeof callBridge>>, what: string): ToolValue {
  if (outcome.timedOut) {
    throw new Error(`${what} did not finish in time and was stopped.`)
  }
  // Named before the value check, because each of these leaves `value` undefined
  // for a reason that is not "the bridge said something unparseable" -- and that
  // was the message a caller used to get for both.
  if (outcome.aborted) {
    throw new Error(`${what} was cancelled.`)
  }
  if (outcome.oversized) {
    throw new Error(
      `${what} answered with more than 2 MiB, which is more than this tool carries back. ` +
        'Narrow it: iam_mine_describe pages features with offset and limit, and a workflow that ' +
        'reports per-object rows has one row per object.',
    )
  }
  if (outcome.value === undefined) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim() || 'no output'
    if (outcome.exitCode === 0) {
      throw new Error(`${what} produced output that is not JSON: ${detail.slice(0, 400)}`)
    }
    throw new Error(`${what} failed (exit ${outcome.exitCode ?? 'none'}): ${detail}`)
  }
  return outcome.value
}

export const ALGORITHM_SEARCH = 'iam_algorithm_search'
export const ALGORITHM_DESCRIBE = 'iam_algorithm_describe'
export const ALGORITHM_RUN = 'iam_algorithm_run'
export const MINE_DESCRIBE = 'iam_mine_describe'
export const PROGRAM_RUN = 'iam_program_run'
export const WORKFLOW_LIST = 'iam_workflow_list'
export const WORKFLOW_RUN = 'iam_workflow_run'
export const WORKFLOW_FREEZE = 'iam_workflow_freeze'

/**
 * What the `workspace` parameter means, in one place.
 *
 * Written once because three tools take it and a fourth will: it is the
 * directory a user owns -- where their `.iam` files and their `.iax/` live --
 * and NOT where the harness happens to have been started.
 */
const WORKSPACE_DESCRIPTION =
  'The user\'s workspace directory: workflows are read from <workspace>/.iax/workflows and a ' +
  'program run is recorded under <workspace>/.iax/runs. Omit it and the session\'s own working ' +
  'directory is used, which is almost always what you want.'

/**
 * Where an algorithm's contract comes from, said where the model already is.
 *
 * WHY THIS IS TOOL TEXT AND NOT JUST A README. The declarations under
 * `IAM/Algorithms/Source/catalog/` are the build-time origin of these very
 * records, one field for one field, and the module's README says so in those
 * words -- "the declaration is the single source of truth".  A session can read
 * the repository, and one did: asked what Boolean operations exist, it listed
 * the source directory, found `BooleanCatalog.cpp` and read it, which returns
 * the same fields this tool had already been asked for, behind a build step.
 *
 * It is also the WRONG place, and not merely a redundant one.  Which declaration
 * files a build compiles IS the availability rule -- the Mining-backed ones are
 * listed separately in `CMakeLists.txt` -- so a reader of the C++ can find an
 * algorithm this session cannot call.  The catalog below is what this session
 * has; the source is what some build has.
 */
const WHERE_ALGORITHMS_LIVE =
  'WHERE ALGORITHMS LIVE. This catalog is the platform\'s whole algorithm surface, and it is where ' +
  'questions about it are answered: what operations exist, what an input is called, which backend ' +
  'runs it. The C++ declarations under `IAM/Algorithms/Source/catalog/` are what the build renders ' +
  'these records FROM, field for field, so reading or grepping them returns what this tool already ' +
  'returns -- and can mislead, because which of those files a build compiles is the availability ' +
  'rule, so the source can name an algorithm this session cannot call. Do not read the repository ' +
  'to find out what the platform can do.'

export function algorithmSearchTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: ALGORITHM_SEARCH,
    description:
      'Search the IAM algorithm catalog and return SHORT entries grouped by operation family, each ' +
      'carrying a one-line `brief` of what it does and a one-line Chinese `route` phrase with its ' +
      'common names (search matches both, so a Chinese question can reach an English entry), plus ' +
      '`select.exact` and `select.fails_silently` -- `unknown` says nobody has established the ' +
      'claim, which is not the same as safe. Use this first to find out what the platform can ' +
      'do about a problem; follow it with iam_algorithm_describe for the one entry you picked, which ' +
      'is where the brief\'s remainder lives -- inputs, preconditions, limits and routes. ' +
      'Each built-in entry has one Python route: call_kind=invoke uses Library.invoke(id, ...); ' +
      'call_kind=direct imports and calls the function named by python_direct. ' +
      'Planar coordinate-ring booleans use geometry.polygon.boolean; geometry.boolean.* takes 3D solid handles. ' +
      'Workspace entries use iam_algorithm_run, which answers a missing required input with ' +
      '`needs_input` and one question per missing name instead of failing the call. ' +
      'A search with no brief ' +
      'for what you want is the catalog answering that it has nothing, and that is an answer. ' +
      'A query is WORDS, not a phrase: every whitespace-separated word must appear somewhere in ' +
      'an entry, and entries whose id, title or summary carry a word rank above ones that only ' +
      'mention it. Two or three keywords beat a sentence. With neither query nor operation the ' +
      'answer is the OPERATION INDEX -- one row per operation family with its entry count and ' +
      'backends -- which is the cheap way to ask what exists; name an operation to list that ' +
      'family, or operation="*" for every entry (large). ' +
      WHERE_ALGORITHMS_LIVE,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords; every whitespace-separated word must appear in the entry. Hits in the ' +
            'id, title or summary rank first. `geometry.boolean` asks for a family; a full id ' +
            'names one entry.',
        },
        operation: {
          type: 'string',
          description:
            'List one exact operation family, e.g. geometry.boolean or mesh.process. "*" asks ' +
            'for every entry, which is large. Omit it and query for the family index.',
        },
        backend: {
          type: 'string',
          description: 'Restrict to one backend (facet, mesh, brep, mining, iam). Leave it off to compare them.',
        },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: (args) => {
      const query = (args as { query?: string } | null)?.query
      return { card: 'generic', title: query ? `Search algorithms: ${query}` : 'List algorithms' }
    },
    async execute(args, exec) {
      const arguments_ = ['--query', optionalString(args, 'query') ?? '']
      const operation = optionalString(args, 'operation')
      if (operation) arguments_.push('--operation', operation)
      const backend = optionalString(args, 'backend')
      if (backend) arguments_.push('--backend', backend)
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      return fromBridge(await callBridge('search', arguments_, { ...config, signal: exec.signal }), 'The algorithm search')
    },
  }
}

export function algorithmDescribeTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: ALGORITHM_DESCRIBE,
    description:
      'The full contract of ONE catalogued algorithm: its inputs, preconditions, limits, ' +
      'known limitations and its result schema. Read this before calling an algorithm -- ' +
      'the preconditions are what it refuses on, and a refusal halfway through a long ' +
      'program is more expensive than reading them first. For built-ins use only the route in the catalog: ' +
      'Library.invoke for call_kind=invoke; import and call python_direct for call_kind=direct. ' +
      'Read entry.doc as well as inputs: it specifies concrete array nesting, frame/unit conversions, ' +
      'output-object access, re-entry units, supported keywords and refusal handling. ' +
      'Do not infer a callable from python_name/c_symbol, or parameters from a similar algorithm. ' +
      'If an invoke entry retains a python_direct compatibility alias, call_kind still selects invoke. ' +
      'Workspace entries use iam_algorithm_run. ' +
      'Inputs carry the wording a question needs: `required`, plus `kind`/`means` on a workspace ' +
      'entry and `type`/`unit`/`description` on a built-in one. Leaving a required input out is not ' +
      'a dead end -- iam_algorithm_run and iam_program_run answer with `needs_input` and one ' +
      'question per missing name, built from these fields. ' +
      'This is the whole of it: ' + WHERE_ALGORITHMS_LIVE,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The stable catalog id, e.g. geometry.boolean.intersection.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: args => ({ card: 'generic', title: `Algorithm: ${(args as { id?: string })?.id ?? ''}` }),
    async execute(args, exec) {
      const arguments_ = ['--id', requireString(args, 'id')]
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      return fromBridge(
        await callBridge('describe', arguments_, { ...config, signal: exec.signal }),
        'The algorithm description',
      )
    },
  }
}

export function algorithmRunTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: ALGORITHM_RUN,
    description:
      'Run a user supplied algorithm from <workspace>/.iax/algorithms by catalog id in the configured ' +
      'sandbox. A missing required argument is not a failed run: the result comes back with ' +
      '`needs_input: true` and `questions[]`, one per missing input, holding the parameter name and ' +
      'whatever the manifest says about it (`kind`, `means`, `reason`, `examples`, `choices`). Put ' +
      'those questions to the user with ask_user_question and call again with the answers: one ' +
      'item per question, `id` = `parameter`, `question` = `means` (fold `reason` and `examples` ' +
      'into it when they help), `header` = `kind`, and `options` from `choices` -- put `suggested` ' +
      'first and append "(Recommended)" to that label. `suggested` is the only value the platform ' +
      'recommends; do not substitute one of your own. Built-in algorithms invoked from a ' +
      'generated program answer the same way when their declared required inputs are missing.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    async execute(args, exec) {
      const arguments_ = ['--id', requireString(args, 'id')]
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      const supplied = (args as { arguments?: unknown } | null)?.arguments
      if (supplied !== undefined) {
        if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
          throw new Error('"arguments" must be an object')
        }
        arguments_.push('--arguments', JSON.stringify(supplied))
      }
      return fromBridge(await callBridge('algorithm-run', arguments_, { ...config, signal: exec.signal }), 'The algorithm')
    },
  }
}

export function mineDescribeTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: MINE_DESCRIBE,
    description:
      'What a Mining project (.iam or .iamh) holds: its coordinate frame, a page of semantic elements ' +
      'with names, metadata and geometry references, and each block model with its attribute columns ' +
      '-- every column carrying the NAME, unit and value type of the field it holds, and whether that ' +
      'type is numeric. This is how you find the things a question names -- a roadway, an orebody, the ' +
      'column holding a grade -- without guessing an id. Read-only.\n\n' +
      'WHEN A CHOICE AMONG THOSE COLUMNS CANNOT BE DERIVED, ASK THE USER. Which column is the grade, ' +
      'and whether its numbers are a fraction or a percent, are not in the project: a field records ' +
      'its name and its type and nothing about what its numbers mean. Use ask_user_question with ' +
      'these field names as the options, and carry the answer into the call that needs it. Do not ' +
      'pick one, and do not invent a scale -- a percent read as a fraction overstates the metal a ' +
      'hundredfold and produces a table that looks entirely reasonable. A `needs_input` result from ' +
      'a workflow or algorithm names the parameters to ask about; this is where the options to ' +
      'offer as answers come from.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Path to a .iam or .iamh document.' },
        offset: { type: 'integer', minimum: 0, description: 'Feature offset for paging.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Features per page; default 100.' },
        surfaceDetails: { type: 'boolean', description: 'Read per-feature vertex and triangle counts.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: args => ({ card: 'generic', title: `Describe ${(args as { project?: string })?.project ?? ''}` }),
    async execute(args, exec) {
      const arguments_ = ['--project', requireString(args, 'project')]
      for (const name of ['offset', 'limit']) {
        const value = optionalNumber(args, name)
        if (value !== undefined) {
          if (!Number.isInteger(value)) throw new Error(`"${name}" must be an integer`)
          arguments_.push(`--${name}`, String(value))
        }
      }
      if ((args as { surfaceDetails?: unknown } | null)?.surfaceDetails === true) arguments_.push('--surface-details')
      return fromBridge(
        await callBridge('mine-describe', arguments_, { ...config, signal: exec.signal }),
        'Reading the project',
      )
    },
  }
}

export function programRunTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: PROGRAM_RUN,
    description:
      'Run a Python program and return its stdout, stderr and exit code. The program runs in a ' +
      'child process with `iam_algorithms` and `iam` importable, so it can open a project, ' +
      'search the algorithm catalog and measure:\n' +
      '    port = iam.open("<project .iam or .iamh>")\n' +
      '    port.ids(iam._abi.ELEMENT_SURFACE) -> surface ids; port.element_name(id) -> its name\n' +
      '    port.read_points(iam._abi.ELEMENT_SURFACE, id, project_coordinates=False)\n' +
      '    port.surface_triangles(id)   # pairs with the False read: the indices address\n' +
      '                                 # the STORED vertices, so mixing in the project-\n' +
      '                                 # coordinate ones builds a shell in the wrong place\n' +
      '    from iam_algorithms import geometry  # when python_direct names a geometry function\n' +
      '    geometry.point_distance(a, b, coordinate_frame="mine", length_unit="m", unit_to_meters=1.0)\n' +
      '    from iam_algorithms.direct import geometry__mesh__inspect  # if python_direct names it\n' +
      '    geometry__mesh__inspect(mesh=mesh)\n' +
      '    library = iam_algorithms.Library()\n' +
      '    library.invoke("<call_kind=invoke catalog id>", **arguments)\n' +
      'Before generating arguments, read iam_algorithm_describe including entry.doc. ' +
      'Frame/unit labels do not transform coordinates; returned geometry may already be in metres. ' +
      'For section modeling: geometry.section.interpolate_contours is direct through ' +
      'iam_algorithms.modeling.interpolate_contours and keeps the INPUT length unit; ' +
      'geometry.surface.reconstruct_contours is an invoke entry called ONCE with every material; ' +
      'it defaults to shared interfaces with atomic refusal; explicit independent mode reports ' +
      'per-material refusals in solids.failures. It takes one int32 material label per ring (nested same-material rings are voids; ' +
      'nested different materials use inner override). ' +
      'geometry.surface.reconstruct_contours_variational is a separate invoke entry for a joint ' +
      '3D variational field solve; pass every material together, resolution, and optionally ' +
      'axial_resolution, smooth_length, bending_weight, prior_weight, solver_tolerance and max_iterations. ' +
      'It always uses shared interfaces, accepts neither interface_mode nor field_smooth_sigma nor ' +
      'require_section_continuity, and refuses atomically on nonconvergence or budget limits. ' +
      'Read solids.diagnostics and solids.smoothing_topology_changes; smoothing can change connectivity. ' +
      'For the complete inspected contour modeling process, prefer the invoke entry ' +
      'geometry.surface.build_contour_model: native preparation, method ordinary/variational, ' +
      'quality_profile balanced/strict, joint contour-preserving simplification, and optional ' +
      'verified single-IAM output_path. Read its doc for sections or input_path/section_groups, ' +
      'versioned defaults and explicit overrides. plan_only=true reports resolved parameters. ' +
      'For variational continuity, variational_trust_length controls distance-score fidelity to the ' +
      'ordinary transported reference: default resolution/32, up to resolution/4. ' +
      'Print model.diagnostics; full replay diagnostics go to output_path+.report.json. ' +
      'For full mine models set this tool timeoutSeconds=3600. Existing meshes can use ' +
      'geometry.surface.simplify_contour_models then geometry.surface.save_contour_model; ' +
      'pass all materials together. Do not recreate these algorithms in Python or load experimental binaries. ' +
      'Preserve ring connectivity, explicit holes and material roles. Do not flatten region sets or ' +
      'retry a geometry refusal with guessed units, increased tolerances or discarded holes. ' +
      'A LARGE RESULT DOES NOT CROSS AS JSON. A section field is one float per node and the ' +
      'call keeps only 256 KiB of stdout (1 MiB total before the child is stopped), so returning ' +
      'the values is not a big payload -- it is a dead call. `ImplicitField.save(path)` writes a ' +
      'compact binary field under $IAX_EXECUTION_WORKSPACE and returns a small ' +
      '`implicit.field_ref` descriptor; `ImplicitField.load(path)` restores it, with size, origin, ' +
      'spacing, metadata and level travelling inside the file. Print the descriptor, not the field. ' +
      'A mesh takes the same route: `Mesh.save(path)` writes float64 vertices and int32 indices and ' +
      'returns a `mesh.triangles_ref`; `library.load_mesh(path)` restores it in the library that ' +
      'will use it. ' +
      'WHEN THE PROGRAM CHANGES A PROJECT, BOTH WRITES ARE ITS OWN: port.commit() publishes the ' +
      'edit as the next revision IN THE OPEN PROJECT only -- it does not write the file -- and ' +
      'port.save(path) is what writes that revision to disk. A program that commits, exits and is ' +
      'followed by a read of the same path sees the revision it opened; that is a missing save, ' +
      'not a failed commit. To leave the edit for review instead, port.delta().save("<name>.iaxd") ' +
      'writes a document and publishes nothing; iam_mine_apply publishes such a document. ' +
      'Those two packages reach the child through PYTHONPATH -- there is nothing to read or ' +
      'point at inside the plugin, so do not go looking for the module on disk. The Mining ' +
      'package was named `iaxmine` before 2026-10-14; a program or attachment that still says ' +
      '`import iaxmine` fails with ModuleNotFoundError and needs that one word changed. ' +
      'A BUILT-IN ALGORITHM REFUSED FOR A MISSING INPUT IS A QUESTION, NOT A CRASH: when a program ' +
      'calls an algorithm without its declared required arguments, the result carries ' +
      '`needs_input: true`, the `algorithm`, and `questions[]` built from the catalog entry. Put ' +
      'them to the user with ask_user_question and re-run with the values. The traceback stays in ' +
      '`stderr`. ' +
      'Print what you want to read -- the result is ' +
      'the program\'s own output, not a parsed value. A program that fails is a successful ' +
      'call whose exit code and traceback are in the result.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The program source.' },
        timeoutSeconds: { type: 'number', description: 'Deadline; the child is killed past it.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: () => ({ card: 'terminal', title: 'iam_program_run' }),
    presentResult: (_args, result) => {
      const value = result?.value as { stdout?: string; exitCode?: number } | undefined
      return { card: 'terminal', title: 'iam_program_run', output: value?.stdout ?? '', exitCode: value?.exitCode }
    },
    async execute(args, exec) {
      const arguments_ = ['--code', requireString(args, 'code')]
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      const timeout = optionalNumber(args, 'timeoutSeconds') ?? config.timeoutSeconds
      if (timeout !== undefined && (timeout <= 0 || timeout > 3600)) throw new Error('timeoutSeconds must be between 0 and 3600')
      if (timeout !== undefined) arguments_.push('--timeout-seconds', String(timeout))
      const outcome = await callBridge('program-run', arguments_, {
        ...config,
        signal: exec.signal,
        // The child gets the same deadline plus a margin, so the bridge can
        // report a timeout as a result instead of being killed itself.
        timeoutMs: timeout ? (timeout + 30) * 1000 : undefined,
      })
      return fromBridge(outcome, 'The program')
    },
  }
}

export function workflowListTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: WORKFLOW_LIST,
    description:
      'The workflows available to this session, by name, with what each one answers and which ' +
      'inputs it requires. A workflow is a procedure that was written and confirmed once and is ' +
      'now addressed by name; prefer one over writing the same program again. A fresh workspace ' +
      'lists none: capabilities arrive by freezing a confirmed run under ' +
      '<workspace>/.iax/workflows. Each entry lists `required_inputs` and a `status` ' +
      '(`active` or `draft`); drafts are scaffolds and are listed after active workflows. An ' +
      'input its manifest marks non-inferable is asked for by iam_workflow_run (`needs_input`) ' +
      'before the workflow is started.',
    parameters: {
      type: 'object',
      properties: { workspace: { type: 'string', description: WORKSPACE_DESCRIPTION } },
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: () => ({ card: 'generic', title: 'List workflows' }),
    async execute(args, exec) {
      const arguments_: string[] = []
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      return fromBridge(await callBridge('workflow-list', arguments_, { ...config, signal: exec.signal }), 'Listing workflows')
    },
  }
}

export function workflowRunTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: WORKFLOW_RUN,
    description:
      'Run one named workflow and return its report: the per-row results, the refusals with ' +
      'their reasons, and the totals. Call iam_workflow_list first for the name, the status and ' +
      'the inputs it requires. A workflow refuses rather than guesses -- a refusal comes back as ' +
      'a normal result naming what was wrong with the request. A `draft` workflow is refused: ' +
      'it is a scaffold; fill it in and freeze it before it is addressable.\n\n' +
      'A REFUSAL NAMING A MISSING INPUT IS A QUESTION, NOT A DEAD END. Workflows refuse what the ' +
      'project cannot answer -- which metal to report, whether a grade column holds a fraction or ' +
      'a percent -- because guessing there produces a wrong number that looks right. Take the ' +
      'missing input to the user with ask_user_question, and re-run with the answer. Use ' +
      'iam_mine_describe to get the real options first: it names each column\'s field.\n\n' +
      'AN INPUT THE MANIFEST CALLS NON-INFERABLE IS ASKED FOR BEFORE THE WORKFLOW RUNS: the result ' +
      'carries `needs_input: true` and `questions[]` in the manifest\'s own order, each question ' +
      'naming the `parameter` with its `kind`, `means`, `reason`, `suggested` and `choices`. Put ' +
      'them to the user with ask_user_question: one item per question, `id` = `parameter`, ' +
      '`question` = `means` (fold `reason` and `examples` into it when they help), `header` = ' +
      '`kind`, `options` from `choices` with `suggested` first, labelled "(Recommended)". Pass ' +
      'the answers back under those parameter names. `suggested` is the only recommendation the ' +
      'platform has, and the rest is the user\'s to answer -- do not invent either.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The workflow name, e.g. orebody-model.' },
        arguments: {
          type: 'object',
          description: 'The run() keywords the workflow\'s manifest declares as inputs.',
          additionalProperties: true,
        },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: args => ({ card: 'generic', title: `Workflow: ${(args as { name?: string })?.name ?? ''}` }),
    async execute(args, exec) {
      const arguments_ = ['--name', requireString(args, 'name')]
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      const supplied = (args as { arguments?: unknown } | null)?.arguments
      if (supplied !== undefined) {
        if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
          throw new Error('"arguments" must be an object of run() keywords')
        }
        arguments_.push('--arguments', JSON.stringify(supplied))
      }
      return fromBridge(await callBridge('workflow-run', arguments_, { ...config, signal: exec.signal }), 'The workflow')
    },
  }
}

export function workflowFreezeTool(config: BridgePluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: WORKFLOW_FREEZE,
    description:
      'Turn a program that ran and was confirmed into a named workflow, by writing ' +
      '<workspace>/.iax/workflows/<name>/. USE THIS WHEN THE SAME COMPUTATION IS ABOUT TO BE ' +
      'NEEDED A SECOND TIME: it is what makes "do that again" one call instead of regenerating ' +
      'the program. The source is taken from a RECORDED RUN (its id is in the result of ' +
      'iam_program_run) so that what is frozen is the program that actually ran. ' +
      'The manifest is required and is not filled in for you: a workflow has to state what it ' +
      'requires, what it does and what would count as it having gone wrong.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name the catalog will answer to.' },
        run: { type: 'string', description: 'The id of a recorded run, from iam_program_run.' },
        manifest: {
          type: 'object',
          description:
            'title, answers, inputs.required[], steps[] and acceptance[]. Every required input ' +
            'states name, kind, means and refused_when, and may add why_not_inferred (the platform ' +
            'then asks for it before running instead of letting the run fail), choices, suggested, ' +
            'impact, reason and examples -- the last two are what the ask_user_question item is ' +
            'written from. See IAM/plugin/Workflows/Examples/ByProductOre/manifest.json for a filled-in example.',
          additionalProperties: true,
        },
        version: {
          type: 'string',
          description:
            'Semantic version to freeze as (e.g. 1.1.0). Defaults to manifest.version. A version ' +
            'strictly higher than the one already frozen under this name is allowed to replace it; ' +
            'the previous workflow.py and manifest.json are kept under versions/<old>/.',
        },
        confirmed: { type: 'boolean', description: 'True only after the run output and acceptance rules were reviewed and accepted.' },
        workspace: { type: 'string', description: WORKSPACE_DESCRIPTION },
      },
      required: ['name', 'run', 'manifest', 'confirmed'],
      additionalProperties: false,
    },
    output: { schema: objectSchema, render: renderValue },
    presentCall: args => ({ card: 'generic', title: `Freeze workflow: ${(args as { name?: string })?.name ?? ''}` }),
    async execute(args, exec) {
      const manifest = (args as { manifest?: unknown } | null)?.manifest
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        throw new Error('"manifest" must be an object')
      }
      const confirmed = (args as { confirmed?: unknown } | null)?.confirmed
      if (confirmed !== true) throw new Error('A workflow can be frozen only after explicit confirmation')
      const arguments_ = [
        '--name', requireString(args, 'name'),
        '--run', requireString(args, 'run'),
        '--manifest', JSON.stringify(manifest),
        '--confirmed',
      ]
      const version = optionalString(args, 'version')
      if (version !== undefined) arguments_.push('--version', version)
      workspaceArgument(arguments_, await workspaceOf(args, config, probe, exec))
      return fromBridge(await callBridge('workflow-freeze', arguments_, { ...config, signal: exec.signal }), 'Freezing the workflow')
    },
  }
}
