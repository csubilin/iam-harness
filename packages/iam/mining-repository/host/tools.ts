import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

import { launchNative, nativeAvailability, type NativeOptions } from './native.js'
import { callRepository, type RepositoryOptions } from './python.js'

/** What the plugin's patch row may configure. */
export interface RepositoryPluginConfig extends RepositoryOptions, NativeOptions {
  /** A call's default deadline, in seconds. */
  timeoutSeconds?: number
  /** Where the user's workspace is, if the deployment knows. */
  workspace?: string
}

/**
 * What `execute` is handed besides the arguments.
 *
 * `agent` is the Session the call belongs to, and the reason this plugin does not
 * need a configured workspace: the Harness has a `workingDirectory` service that
 * answers, per session, which directory that session is working in.  The host
 * half passes a probe onto it -- see `host/index.ts`.
 */
export interface ToolExec {
  signal: AbortSignal
  agent?: unknown
}

/** Asks the Harness which directory the calling session is working in. */
export type WorkspaceProbe = (exec: ToolExec) => Promise<string | undefined>

interface TextBlock {
  type: 'text'
  text: string
}

export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
    /**
     * The card's data, projected onto the tool result and persisted with it.
     *
     * MUST BE JSON-SERIALIZABLE: the harness validates it at the source, so a
     * non-serializable value is a rejected call rather than a card that renders
     * once and never again.
     */
    presentationMeta?: (args: unknown, value: unknown) => Record<string, unknown>
  }
  presentCall?: (args: unknown) => { card: 'generic'; title: string; kind?: string }
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>
}

const objectSchema = { type: 'object', additionalProperties: true } as const

// ------------------------------------------------------------------ validation
//
// What the schema cannot express.  A JSON Schema says `array of string`; it does
// not say "at least one", and an empty selection would reach the view and hide
// the whole scene with nothing saying why.

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

/** A list of non-empty ids, refusing the empty one rather than passing it on. */
function idList(args: unknown, name: string, required: boolean): string[] {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) {
    if (required) throw new Error(`"${name}" is required and must name at least one id`)
    return []
  }
  if (!Array.isArray(value)) throw new Error(`"${name}" must be an array of ids`)
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`every entry of "${name}" must be a non-empty id`)
    }
    return entry
  })
  if (required && ids.length === 0) {
    throw new Error(`"${name}" is required and must name at least one id`)
  }
  return ids
}

/** One resource, or an array of them, as the array the payload wants. */
function objectOrList(args: unknown, name: string): Record<string, unknown>[] {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return []
  const entries = Array.isArray(value) ? value : [value]
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`every entry of "${name}" must be an object`)
    }
  }
  return entries as Record<string, unknown>[]
}

/** A list whose entries are objects, refusing the empty one. */
function objectList(args: unknown, name: string, required: boolean): Record<string, unknown>[] {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) {
    if (required) throw new Error(`"${name}" is required`)
    return []
  }
  if (!Array.isArray(value)) throw new Error(`"${name}" must be an array`)
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`every entry of "${name}" must be an object`)
    }
  }
  if (required && value.length === 0) throw new Error(`"${name}" is required and must not be empty`)
  return value as Record<string, unknown>[]
}

/** A positive whole number a cap can be set to.  Absent means "the platform's own". */
function optionalCount(args: unknown, name: string): number | undefined {
  const value = (args as Record<string, unknown> | null)?.[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`"${name}" must be a positive whole number`)
  }
  return value
}

/**
 * Whether a write target is one the session is allowed to change.
 *
 * A READ may name any project on the machine -- `iam_mine_describe` does, and so
 * does `iam_program_run`.  A WRITE may not: the session's workspace is the
 * boundary its other paths are resolved against, and `iam_mining_show` already
 * refuses to hand the pane a document outside it.  A door that changes a mine
 * has less reason to be permissive than one that draws it.
 *
 * Returns the refusal when the path is out of bounds, and null when it is fine.
 */
function outsideWorkspace(target: string, workspace: string | undefined, what: string): string | null {
  if (workspace === undefined || workspace.length === 0) {
    // BOTH kinds of path, unlike the read half, and the difference is the point.
    // A read with no workspace and a relative path still has somewhere to look --
    // the process's own directory -- and answers "no such project" when nothing
    // is there.  A WRITE that resolved against wherever the interpreter happened
    // to start would be editing a file the caller never named, so it refuses
    // instead of guessing, and says which setting would fix it.
    return `This session has no working directory, so ${what} cannot be placed: a write is ` +
      'confined to the session workspace and there is none to check against. Set `workspace` on ' +
      'this bundle\'s row, or run in a session that has a working directory.'
  }
  // Lexical containment let a symlink inside the workspace point outside it.
  // Resolve both sides before comparing; a missing leaf resolves through its
  // parent, and anything that cannot be resolved keeps the lexical answer.
  const absoluteTarget = isAbsolute(target) ? target : join(workspace, target)
  const realWorkspace = canonicalPath(workspace)
  const realTarget = canonicalPath(absoluteTarget)
  return workspaceRelative(realTarget, realWorkspace) === null
    ? `${what} is outside the session workspace, and a write is confined to it. ` +
      'Move the project into the workspace, or name a path inside it.'
    : null
}

/** The path with symlinks resolved; a missing leaf is resolved through its parent. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path))
    } catch {
      return path
    }
  }
}

/**
 * The program's answer, or a thrown Error when there is none.
 *
 * THROWING IS THE FAILURE PATH, and the split it draws is deliberate.  A
 * non-zero exit means the program could not answer at all -- no library, no such
 * project -- and a thrown Error is what the harness shows the model as a tool
 * error, message and all.  A REFUSAL is the other kind and does NOT come through
 * here: the program exits 0 with `{ok: false, refused: "..."}` and that is a
 * value the model reads and corrects itself from.
 */
function fromProgram(outcome: Awaited<ReturnType<typeof callRepository>>, what: string) {
  if (outcome.timedOut) throw new Error(`${what} did not finish in time and was stopped.`)
  if (outcome.aborted) throw new Error(`${what} was cancelled.`)
  if (outcome.oversized) throw new Error(`${what} answered with more than 2 MiB, which no selection summary should.`)
  if (outcome.value === undefined) {
    const detail = outcome.stderr.trim()
    throw new Error(detail.length > 0
      ? `${what} could not be attempted: ${detail}`
      : `${what} could not be attempted (exit ${outcome.exitCode ?? 'signal ' + outcome.signal}).`)
  }
  return outcome.value
}

/**
 * The path the PANEL will be asked to open, relative to the session's workspace.
 *
 * The Views host resolves a `dsh-resource://file/session/...` address inside the
 * session's workspace and refuses anything outside it -- by design, and it is the
 * boundary that keeps a preview from reading the machine.  So a project the user
 * names from outside that workspace cannot be shown in the panel at all, and
 * saying that here is the honest answer: the alternative is an address the pane
 * answers with "not found".
 */
function workspaceRelative(project: string, workspace: string | undefined): string | null {
  const absolute = isAbsolute(project)
  if (workspace === undefined || workspace.length === 0) return absolute ? null : project
  const inside = relative(workspace, isAbsolute(project) ? project : `${workspace}${sep}${project}`)
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) return null
  return inside.split(sep).join('/')
}

/** One line a reader can act on, whether the call worked or refused. */
function summarize(value: Record<string, unknown>): string {
  if (value.ok === false) return `拒绝：${String(value.refused ?? '')}`
  const counts = (value.counts ?? {}) as Record<string, number>
  const where = value.opened === 'native'
    ? `已在原生编辑器中打开（pid ${value.pid ?? '?'}）`
    : `已在面板中打开 ${String(value.relative_path ?? '')}`
  return `${where} — ${counts.elements ?? 0} 元素 / ${counts.geometry ?? 0} 几何`
}

/**
 * The card's data, which Views' client half renders and opens from.
 *
 * `autoOpen` is the caller's decision carried into the client: the user who typed
 * 显示 asked to see it, so opening is the default, and a call that says otherwise
 * leaves the card with its button.  The ADDRESS is deliberately not here: its
 * session segment has to be the session that is on screen, which only the client
 * knows, so what travels is the workspace-relative path -- and the selection,
 * which is what the client hands the view once the document is open.
 */
function cardOf(value: Record<string, unknown>): Record<string, unknown> {
  if (value.ok === false) {
    return { refused: String(value.refused ?? ''), selection: value.selection ?? [] }
  }
  const counts = (value.counts ?? {}) as Record<string, unknown>
  return {
    relativePath: String(value.relative_path ?? ''),
    title: String(value.title ?? ''),
    // THE IDS, NOT THE VIEW TEXT, and the two are different types on purpose.
    // The client's reader narrows every field defensively and a string where it
    // expects an array is DROPPED -- so sending the newline-joined text here made
    // the pane ask the view to show the whole document, silently, every time.
    // Measured by the tool's own test, which is why that test asserts the type.
    selection: value.selection ?? [],
    summary: counts,
    opened: value.opened === 'native' ? 'native' : 'panel',
  }
}

/** The tool's name: `iam_<domain>_<verb>`, and `view` is taken by the view-state reads. */
export const MINING_SHOW = 'iam_mining_show'
/**
 * The write door.  Three names rather than one with modes, because a tool's
 * SCHEMA is the only thing the model sees before it decides to call, and "put,
 * or attach, or erase, or none of them if you sent code instead" is a schema
 * that cannot say what it means.  The two edit verbs differ in exactly one
 * thing -- whether a program runs -- and that difference is a sandbox.
 */
export const MINE_EDIT = 'iam_mine_edit'
export const MINE_VERB = 'iam_mine_verb'
export const MINE_DOCUMENT = 'iam_mine_document'
export const MINE_APPLY = 'iam_mine_apply'

/**
 * The erase vocabulary, spelled as the platform's own resource tags name it.
 *
 * Published in the schema as an enum so a caller sees the words rather than
 * discovering them by refusal.  `frame` is deliberately absent: a project has
 * exactly one and validation requires it, so offering it would be offering
 * something that cannot work.
 */
const ERASE_TYPES = [
  'field', 'element', 'point_set', 'line_set', 'polyline_3d', 'grid_surface',
  'block_model', 'surface', 'attribute_column', 'cross_section', 'line_network',
  'composite',
] as const

export function miningShowTool(config: RepositoryPluginConfig, probe?: WorkspaceProbe,
  carrier?: () => string | undefined): RawToolDefinition {
  /** Whether the native editor can be started here, which is what a .iamh needs. */
  const isDesktop = () => carrier?.() === 'desktop'

  return {
    name: MINING_SHOW,
    description:
      'Show part of a Mining project: the elements you name, in the panel beside the conversation (or, for a ' +
      'columnar store on the desktop, in the native editor). Use it when the user asks to SEE something -- ' +
      '"显示矿体", "把这几条巷道打开看看" -- after you have resolved what they named to element ids with ' +
      'iam_mine_describe.\n\n' +
      'IT OPENS THE PROJECT ITSELF. The panel loads the document and is then told which items to draw, so ' +
      'nothing is copied and no second file is made; a second call for the same document re-points the SAME ' +
      'panel and only changes what is shown. The camera is framed on the selection, so what you asked for ' +
      'fills the view rather than being hidden inside the whole mine.\n\n' +
      'TWO CONTAINERS, TWO ANSWERS. A portable `.iam` opens in the panel on both carriers. A columnar `.iamh` ' +
      'cannot: the browser view links no HDF5 reader, so on the web it is refused and on the desktop the ' +
      'native editor is started with the same selection. Either way the source project is only ever read. ' +
      'THE NATIVE EDITOR OPENS A DOCUMENT ONCE: a later show call for the same file is refused until that ' +
      'window is closed, so do not retry it -- tell the user the window is already up.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Path to a .iam or .iamh document; relative paths are resolved against the session workspace.' },
        elements: {
          type: 'array', items: { type: 'string' },
          description: 'The semantic element ids to show. Get them from iam_mine_describe; a name is not an id.',
        },
        title: { type: 'string', description: 'What to call the selection on the card.' },
        present: {
          type: 'boolean',
          description: 'Open the panel with it. Default true -- the user asked to see it. False leaves a card with a button.',
        },
      },
      required: ['project', 'elements'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => [{ type: 'text', text: summarize(value as Record<string, unknown>) }],
      presentationMeta: (args, value) => ({
        ...cardOf(value as Record<string, unknown>),
        autoOpen: (args as { present?: unknown } | null)?.present !== false,
      }),
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'mining-show',
      title: `显示 ${(args as { title?: string } | null)?.title ?? '选择集'}`,
    }),
    async execute(args, exec) {
      const project = requireString(args, 'project')
      const elements = idList(args, 'elements', true)
      const title = optionalString(args, 'title')
      const workspace = (await probe?.(exec)) ?? config.workspace

      const arguments_ = ['--project', project]
      for (const id of elements) arguments_.push('--element', id)
      if (workspace !== undefined) arguments_.push('--workspace', workspace)

      const resolved = fromProgram(
        await callRepository('resolve', arguments_, {
          ...config,
          timeoutMs: config.timeoutMs ?? (config.timeoutSeconds ?? 120) * 1000,
          signal: exec.signal,
        }),
        'Reading the project',
      )
      if (resolved.ok === false) return resolved

      // The selection as the VIEW wants it: one element id per line, which means
      // "every geometry this element references".  Built here rather than in the
      // view because the caller is the side that knows what was asked for.
      const selection = (resolved.elements as { id: string }[]).map(element => element.id).join('\n')
      const label = title ?? (resolved.elements as { name?: string }[])[0]?.name ?? ''

      if (resolved.container === 'iamh') {
        // A columnar store, which the browser view cannot read at all.  Web is a
        // refusal BY NAME -- the alternative is a panel that opens and draws
        // nothing, which reads as "your data is empty" rather than "wrong
        // carrier".
        if (!isDesktop()) {
          return {
            ok: false,
            refused: 'This is a columnar store (.iamh), and the Web preview has no HDF5 reader, '
              + 'so it cannot be shown here. Open it on the desktop app, or ask for the portable .iam.',
            container: 'iamh',
            selection: elements,
          }
        }
        const started = launchNative(String(resolved.project), selection, config)
        if (started.ok === false) {
          const refusal = started.refusal
          // One document, one window: a repeat show is refused by name rather
          // than starting a second editor, and the agent can say what to close.
          const refused = refusal.code === 'alreadyOpen'
            ? 'This document is already open in the native editor. Close that window before opening it again.'
            : refusal.code === 'spawnFailed'
              ? `The native editor could not be started: ${refusal.detail}`
              : `The native editor is not configured on this machine (${refusal.code}`
                + `${refusal.detail === undefined ? '' : ': ' + refusal.detail}). Set nativeBinDir, `
                + 'IAM_NATIVE_DIR, and the fonts directory.'
          return {
            ok: false,
            refused,
            container: 'iamh',
            selection: elements,
          }
        }
        return { ok: true, opened: 'native', pid: started.pid, container: 'iamh',
          project: resolved.project, title: label, selection: elements,
          counts: resolved.counts }
      }

      const relativePath = workspaceRelative(String(resolved.project), workspace)
      if (relativePath === null) {
        // The panel resolves addresses inside the session's workspace and refuses
        // anything outside it.  Saying so beats handing the pane an address it
        // answers with "not found".
        return {
          ok: false,
          refused: 'This project is outside the session workspace, so the panel cannot open it. '
            + 'A preview resolves every path inside the workspace it belongs to.',
          selection: elements,
        }
      }

      return {
        ok: true,
        opened: 'panel',
        project: resolved.project,
        relative_path: relativePath,
        container: resolved.container,
        revision: resolved.revision,
        title: label,
        elements: resolved.elements,
        // The ids as ids, and the line format the view is handed, side by side and
        // separately named: the card takes the first and the pane's call takes the
        // second, and a single field serving both was how the card ended up
        // reading a string where it expected an array.
        selection: elements,
        view_selection: selection,
        counts: resolved.counts,
      }
    },
  }
}

/** Whether this carrier has an editor at all, for the tool's own refusal. */
export function nativeProblem(config: RepositoryPluginConfig) {
  return nativeAvailability(config)
}

// --------------------------------------------------------------- the write door
//
// TWO EDIT VERBS AND ONE PUBLISH VERB, and the split is the platform's rather
// than this file's.  A change to a mine is a DELTA: it can be produced, read,
// handed to someone else and applied later -- which is what makes it reviewable,
// and it is why an edit here never publishes.  The two edit verbs differ in
// exactly one thing: whether a program runs.  That is a sandbox difference, so
// it belongs in the choice of tool and not in a flag one of them ignores.
//
// NO `presentationMeta` HERE.  The card mechanism exists for Views' client half,
// which renders `iam_mining_show`'s result; nothing renders these yet, and a
// metadata blob no client reads is a second description of the result that can
// only drift from the first.  `presentCall` stays, because that is the transcript
// row and it is read by the harness itself.

/** The arguments the two edit verbs share. */
function editArguments(args: unknown, workspace: string | undefined): string[] {
  const arguments_: string[] = []
  const document = optionalString(args, 'document')
  if (document !== undefined) arguments_.push('--document', document)
  const timeout = optionalCount(args, 'timeoutSeconds')
  if (timeout !== undefined) arguments_.push('--timeout-seconds', String(timeout))
  const budget = optionalCount(args, 'maxDeltaBytes')
  if (budget !== undefined) arguments_.push('--max-delta-bytes', String(budget))
  if (workspace !== undefined) arguments_.push('--workspace', workspace)
  return arguments_
}

/** How many of each resource kind a document touches, from its own listing. */
function countKinds(entries: unknown): Map<string, number> {
  const counts = new Map<string, number>()
  if (!Array.isArray(entries)) return counts
  for (const entry of entries as { kind?: unknown }[]) {
    const kind = String(entry?.kind ?? '')
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return counts
}

/** What an edit produced, in one line a reader can act on. */
function summarizeEdit(value: Record<string, unknown>): string {
  if (value.ok === false) return `拒绝：${String(value.refused ?? '')}`
  const terms = [...countKinds(value.replaces)].map(([kind, count]) => `${kind} ${count}`)
  const erased = (value.erases as unknown[] | undefined)?.length ?? 0
  if (erased > 0) terms.push(`删除 ${erased}`)
  return `未发布 —— 已写出待评审文档 ${String(value.document ?? '')}` +
    `（${terms.length > 0 ? terms.join('，') : '没有改动'}）；` +
    `项目仍在修订 ${String(value.base_revision ?? '?')}`
}

export function mineEditTool(config: RepositoryPluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: MINE_EDIT,
    description:
      'Change a Mining project by describing the change, and write it out as a reviewable ' +
      'DOCUMENT without publishing it. Use this for the changes a payload can state: add or ' +
      'replace resources (`put`), attach geometry to an element that already exists ' +
      '(`attach`), and remove resources (`erase`). For a change that has to be COMPUTED -- ' +
      '"place a section every 20 m along that centreline" -- use iam_mine_verb instead.\n\n' +
      'IT DOES NOT CHANGE THE PROJECT. The answer is a .iaxd document plus what it says it ' +
      'does; iam_mine_document reads it back in full and iam_mine_apply publishes it as the next ' +
      'revision. That gap is the point: it is where a person -- or you, before the second call -- ' +
      'can read what is about to happen.\n\n' +
      'A PAYLOAD IS SHAPED BY THE SCHEMA, NOT BY AN API. `put` takes the same field names ' +
      'MiningProject.fbs declares, so `{"surfaces": [{"id": "s-1", "vertices": [...], ' +
      '"triangles": [...]}]}`. The project\'s id and frame come from the platform, so a ' +
      'payload must not restate them. An unknown field name is refused, never dropped.\n\n' +
      'A GEOMETRY NOTHING REFERENCES CANNOT BE COMMITTED, so `put` a new surface and `attach` ' +
      'it to an element in the SAME call: they accumulate into one edit. Erasing a geometry ' +
      'cascades -- every element that named it is rewritten -- so you do not list those ' +
      'yourself.\n\n' +
      'The ids come from iam_mine_describe; a name is not an id.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Path to the .iam or .iamh to change; relative paths resolve against the session workspace.' },
        put: {
          description: 'Resources to add or replace, shaped by MiningProject.fbs. One object or an array of them.',
          anyOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: { type: 'object', additionalProperties: true } }],
        },
        attach: {
          type: 'array',
          description: 'Geometry to add to elements that already exist. add_geometry keeps everything the element already carries.',
          items: {
            type: 'object',
            properties: {
              element: { type: 'string', description: 'The element id to attach to.' },
              geometry: {
                description: 'One geometry id, or several.',
                anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
            },
            required: ['element', 'geometry'],
            additionalProperties: false,
          },
        },
        erase: {
          type: 'array',
          description: 'Resources to remove, with everything the project cannot keep without them.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [...ERASE_TYPES],
                description: 'Which kind of resource the id names.',
              },
              id: { type: 'string', description: 'The resource id.' },
            },
            required: ['type', 'id'],
            additionalProperties: false,
          },
        },
        document: { type: 'string', description: 'Where to write the review document; defaults to the project’s own name beside it, with a .iaxd extension.' },
        timeoutSeconds: { type: 'number', description: 'Stop the edit after this long.' },
        maxDeltaBytes: { type: 'integer', description: 'Refuse the edit once it retains more than this.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => [{ type: 'text', text: summarizeEdit(value as Record<string, unknown>) }],
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'mining-edit',
      title: `编辑 ${(args as { project?: string } | null)?.project ?? ''}`,
    }),
    async execute(args, exec) {
      const project = requireString(args, 'project')
      const workspace = (await probe?.(exec)) ?? config.workspace
      const refusal = outsideWorkspace(project, workspace, 'That project')
      if (refusal !== null) return { ok: false, refused: refusal }

      const edit: Record<string, unknown> = {}
      // Passed through as the caller spelled it -- one object or an array -- and
      // `objectOrList` is called only to refuse the wrong shape here, by name,
      // rather than deep inside a JSON parse the model cannot see into.
      const put = (args as Record<string, unknown>).put
      if (put !== undefined && put !== null) {
        objectOrList(args, 'put')
        edit.put = put
      }
      const attach = objectList(args, 'attach', false)
      if (attach.length > 0) edit.attach = attach
      const erase = objectList(args, 'erase', false)
      if (erase.length > 0) {
        // Checked here as well as in the verb, and the duplication is deliberate:
        // this one costs a round trip nobody makes, and the verb's copy is what
        // guards a caller driving apply_edit.py directly.  A JSON Schema enum is
        // a hint to the model, not a constraint on the call.
        for (const entry of erase) {
          const kind = entry.type
          if (typeof kind !== 'string' || !(ERASE_TYPES as readonly string[]).includes(kind)) {
            throw new Error(`"erase" type must be one of ${ERASE_TYPES.join(', ')}; got ${JSON.stringify(kind)}`)
          }
          if (typeof entry.id !== 'string' || entry.id.length === 0) {
            // The schema can say `id: string`; it cannot say "and not the empty
            // one", and an empty id would erase nothing while reporting success.
            throw new Error(`every "erase" needs a non-empty "id" (the ${kind} to remove)`)
          }
        }
        edit.erase = erase
      }
      if (Object.keys(edit).length === 0) {
        // Refused here rather than by the platform, so the message is about what
        // the model left out rather than about a document that came back empty.
        return {
          ok: false,
          refused: 'The edit names nothing to change. Give at least one of "put", "attach" or "erase"; '
            + 'to compute a change instead, use iam_mine_verb.',
        }
      }

      const arguments_ = ['--project', project, '--edit', JSON.stringify(edit),
        ...editArguments(args, workspace)]
      return fromProgram(
        await callRepository('edit', arguments_, {
          ...config,
          timeoutMs: config.timeoutMs ?? (config.timeoutSeconds ?? 120) * 1000,
          signal: exec.signal,
        }),
        'Preparing the edit',
      )
    },
  }
}

export function mineVerbTool(config: RepositoryPluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: MINE_VERB,
    description:
      'Change a Mining project by running a Python verb, and write its edit out as a reviewable ' +
      'DOCUMENT without publishing it. Use this when the change has to be COMPUTED -- repeating ' +
      'something along a centreline, deriving geometry from other geometry, editing an attribute ' +
      'column in bulk. For a change a payload can state ("attach this to that", "remove these"), ' +
      'iam_mine_edit is shorter and runs no code.\n\n' +
      'THE PROGRAM GETS A WRITE PORT, which is what separates this from iam_program_run: that ' +
      'one hands a program a read-only snapshot, this one hands it `port` with put/attach/erase ' +
      'and the station-frame primitive. It defines `run(port)` and may call those as many times ' +
      'as it likes -- they accumulate into ONE edit.\n\n' +
      'IT DOES NOT CHANGE THE PROJECT, for the same reason iam_mine_edit does not: the answer is ' +
      'a .iaxd document, which iam_mine_document reads back and iam_mine_apply publishes. Nothing ' +
      'is written to the mine even if the verb runs to completion.\n\n' +
      'IT NEEDS A SANDBOX. The program is code this session wrote, so it runs only where the ' +
      'deployment has configured a program runner. Without one this call is refused, and the ' +
      'refusal says so -- that is a deployment fact, not something to work around.\n\n' +
      'Read what you are about to edit with iam_mine_describe first, and read a project\'s ' +
      'geometry with iam_program_run: the verb gets a port, but exploring with it is the slow way ' +
      'to find out what is there.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Path to the .iam or .iamh to change; relative paths resolve against the session workspace.' },
        code: { type: 'string', description: 'The verb: a Python program defining run(port).' },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'Keyword arguments for the verb, read with port.arg(name) inside it.',
        },
        document: { type: 'string', description: 'Where to write the review document; defaults to the project’s own name beside it, with a .iaxd extension.' },
        timeoutSeconds: { type: 'number', description: 'Stop the verb after this long.' },
        maxDeltaBytes: { type: 'integer', description: 'Refuse the edit once it retains more than this.' },
      },
      required: ['project', 'code'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => [{ type: 'text', text: summarizeEdit(value as Record<string, unknown>) }],
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'mining-edit',
      title: `动笔编辑 ${(args as { project?: string } | null)?.project ?? ''}`,
    }),
    async execute(args, exec) {
      const project = requireString(args, 'project')
      const code = requireString(args, 'code')
      const workspace = (await probe?.(exec)) ?? config.workspace
      const refusal = outsideWorkspace(project, workspace, 'That project')
      if (refusal !== null) return { ok: false, refused: refusal }

      const arguments_ = ['--project', project, '--code', code, ...editArguments(args, workspace)]
      const supplied = (args as { arguments?: unknown } | null)?.arguments
      if (supplied !== undefined && supplied !== null) {
        if (typeof supplied !== 'object' || Array.isArray(supplied)) {
          throw new Error('"arguments" must be an object of key/value pairs')
        }
        for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
          if (value === undefined || value === null) continue
          arguments_.push('--argument', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
        }
      }
      return fromProgram(
        await callRepository('verb', arguments_, {
          ...config,
          timeoutMs: config.timeoutMs ?? (config.timeoutSeconds ?? 120) * 1000,
          signal: exec.signal,
        }),
        'Running the verb',
      )
    },
  }
}

export function mineDocumentTool(config: RepositoryPluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: MINE_DOCUMENT,
    description:
      'Read a review document (.iaxd) and report exactly what it would do: which project it is ' +
      'addressed to, which revision it was written against, every resource it replaces and every ' +
      'one it removes. This is the read side of the review gate -- iam_mine_edit and ' +
      'iam_mine_verb produce a document, this is how you look at one before iam_mine_apply makes ' +
      'it real.\n\n' +
      'IT NEEDS NO PROJECT, because a document names the one it is for. That is the point: the ' +
      'first question about an edit someone hands you is whether it is for the mine you have, and ' +
      'the header answers it without opening either.\n\n' +
      'IDS, NOT COUNTS. "2 surfaces" is not something anyone can approve; "replaces surfaces ' +
      's-1 and s-2" is. Set `resources: true` to also get the document\'s own JSON, which is what ' +
      'shows the new VALUES -- the coordinates, the attribute rows, the name -- rather than only ' +
      'which resources move. A document too large to carry back says so and names its file ' +
      'instead of handing you half a JSON object.',
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Path to the .iaxd, or the document\'s own JSON text.' },
        resources: {
          type: 'boolean',
          description: 'Also return the document\'s JSON, so the new values are visible. Off by default.',
        },
      },
      required: ['document'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const result = value as Record<string, unknown>
        if (result.ok === false) return [{ type: 'text', text: `拒绝：${String(result.refused ?? '')}` }]
        const terms = [...countKinds(result.replaces)].map(([kind, count]) => `${kind} ${count}`)
        const erased = (result.erases as unknown[] | undefined)?.length ?? 0
        if (erased > 0) terms.push(`删除 ${erased}`)
        return [{
          type: 'text',
          text: `修订 ${String(result.base_revision ?? '?')} 上的改动（${terms.join('，') || '没有改动'}）` +
            `${result.resources_omitted === undefined ? '' : ' —— 文档过大，未附 JSON'}`,
        }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'mining-document',
      title: `评审 ${(args as { document?: string } | null)?.document ?? ''}`,
    }),
    async execute(args, exec) {
      const document = requireString(args, 'document')
      // A read, so no workspace boundary -- the same rule iam_mine_describe
      // follows. The workspace is still passed, because a relative path has to be
      // resolved against the session's directory rather than the interpreter's.
      const workspace = (await probe?.(exec)) ?? config.workspace
      const arguments_ = ['--document', document]
      if (workspace !== undefined) arguments_.push('--workspace', workspace)
      if ((args as { resources?: unknown } | null)?.resources === true) arguments_.push('--resources')
      return fromProgram(
        await callRepository('document', arguments_, {
          ...config,
          timeoutMs: config.timeoutMs ?? (config.timeoutSeconds ?? 120) * 1000,
          signal: exec.signal,
        }),
        'Reading the document',
      )
    },
  }
}

export function mineApplyTool(config: RepositoryPluginConfig, probe?: WorkspaceProbe): RawToolDefinition {
  return {
    name: MINE_APPLY,
    description:
      'Publish a review document as ONE new revision of the project it is addressed to. This is ' +
      'the only call in this plugin that changes a mine, and it is the second half of the edit ' +
      'verbs: iam_mine_edit and iam_mine_verb produce a .iaxd, this one applies it.\n\n' +
      'IT IS CHECKED BEFORE IT IS APPLIED. The document names the project and the revision it ' +
      'was written against; one written for another project, or against a revision the project ' +
      'has left, is refused with both revisions named rather than applied to a state nobody ' +
      'looked at. That refusal is an answer, not an error: re-read the project, redo the edit ' +
      'against what is there now, and apply the new document.\n\n' +
      'IT WRITES IN PLACE by default -- the mine the document names is the mine that changes, ' +
      'atomically, and no second copy appears. Pass `out` only to try a document somewhere else.\n\n' +
      'READ IT FIRST, WITH iam_mine_document. It names every resource the change touches, so you ' +
      'can say what is about to happen -- to yourself and to the user -- before it does; and for ' +
      'a change to someone else\'s mine that is the difference between a tool call and a ' +
      'decision. Only apply a document you have read, or one you produced in this session.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project the document is addressed to.' },
        document: { type: 'string', description: 'Path to the .iaxd, or the document\'s own JSON text.' },
        out: { type: 'string', description: 'Where to write the new revision. Omit to change the project itself.' },
      },
      required: ['project', 'document'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema,
      render: (_args, value) => {
        const result = value as Record<string, unknown>
        if (result.ok === false) return [{ type: 'text', text: `拒绝：${String(result.refused ?? '')}` }]
        const where = result.in_place === true ? '原地' : String(result.out ?? '')
        return [{
          type: 'text',
          text: `已提交为修订 ${String(result.revision ?? '?')}（${where}） —— ${String(result.project ?? '')}`,
        }]
      },
    },
    presentCall: args => ({
      card: 'generic',
      kind: 'mining-apply',
      title: `提交 ${(args as { project?: string } | null)?.project ?? ''}`,
    }),
    async execute(args, exec) {
      const project = requireString(args, 'project')
      const document = requireString(args, 'document')
      const out = optionalString(args, 'out')
      const workspace = (await probe?.(exec)) ?? config.workspace
      // The project is the write target even when `out` is given, so it is the one
      // that must be inside the workspace; `out` is checked too, since a write is
      // a write wherever it lands.
      for (const [target, what] of [[project, 'That project'], [out, 'That output path']] as const) {
        if (target === undefined) continue
        const refusal = outsideWorkspace(target, workspace, what)
        if (refusal !== null) return { ok: false, refused: refusal }
      }

      const arguments_ = ['--project', project, '--document', document]
      if (out !== undefined) arguments_.push('--out', out)
      if (workspace !== undefined) arguments_.push('--workspace', workspace)
      return fromProgram(
        await callRepository('apply', arguments_, {
          ...config,
          timeoutMs: config.timeoutMs ?? (config.timeoutSeconds ?? 300) * 1000,
          signal: exec.signal,
        }),
        'Applying the document',
      )
    },
  }
}
