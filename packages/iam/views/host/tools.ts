import type { SelectionSnapshot, ViewState } from './events.js'

/**
 * A registered tool, in the shape `ctx.tools.register()` consumes.
 *
 * Structural rather than imported, for the reason this half imports nothing else
 * from the harness: an installed out-of-tree package cannot resolve a
 * `@deepseek-ai/*` value, so the shape is written down here in the same terms
 * `Import/host/import-and-describe-tools.ts` writes it -- which is also what makes these definitions
 * testable from a twenty-line fake registry.
 */
export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
  }
  presentCall?: (args: unknown) => { card: string; title: string; kind?: string } | undefined
  execute: (args: unknown, exec: { signal: AbortSignal; agent?: { id?: string } }) => Promise<unknown>
}

/**
 * The names a domain's sentence needs, so the sentence can be written once.
 *
 * Both fields are optional because these definitions are also built from a bare
 * prefix -- the tests do it, and a caller that has no domain table should get
 * text that still says something true rather than a name that might be absent.
 */
export interface ViewDomainTools {
  /** The tool that reads this domain's documents. */
  describeTool?: string
  /** The tool that opens one in the pane, where the domain publishes one. */
  openTool?: string
}

/**
 * How a preview comes to exist, which is NOT the same in the two domains.
 *
 * WHY THIS IS WORTH A FUNCTION. The sentence it replaces said a preview happens
 * "when the user opens the file, and no tool call can mount one" -- and a tool
 * call can: `iam_mining_show` opens the project in the panel, which is the
 * WebAssembly view, and that is the ordinary route. A model that believed the
 * old sentence answered "open it yourself" when it had a tool for it, which
 * reads to the user as the agent not being able to do the thing it can do.
 *
 * The NATIVE editor is a different program and a different question: the user
 * starts it from the page ("在原生中浏览 / 在原生中编辑"), and `iam_mining_show`
 * starts one itself only for a columnar `.iamh` on the desktop. Both report into
 * the same session record, so a preview can exist that no tool call made -- which
 * is why the tools still have to answer for a view they did not mount.
 */
function howAPreviewMounts(tools: ViewDomainTools | undefined): string {
  if (tools?.openTool === undefined) {
    return 'the user opens it in the page, and nothing in this deployment mounts one for them.'
  }
  return (
    `\`${tools.openTool}\` opens it in the PANEL beside the conversation -- the WebAssembly view, and the route ` +
    'a tool call takes -- and the user can open it in the page as well. The NATIVE editor is that document opened ' +
    `as a SEPARATE PROGRAM, which the user starts from the page and which \`${tools.openTool}\` starts itself only ` +
    'for a columnar store on the desktop.'
  )
}

/** How this domain's documents are read, when the document is the question. */
function readsDocumentsWith(tools: ViewDomainTools | undefined): string {
  return tools?.describeTool === undefined
    ? 'the tool that reads this deployment\'s documents'
    : `\`${tools.describeTool}\``
}

/** The view a tool call is about, and what else the session has open. */
export interface StateLookupResult {
  state: ViewState
  /** The other documents this session has a record for, newest first. */
  others?: { name: string; address: string }[]
}

/** Resolve the state the calling agent's session is looking at. */
export type StateLookup = (exec: unknown) => StateLookupResult | { error: string }

/** One page of a reference list. */
const DEFAULT_PAGE = 50
const MAX_PAGE = 200

/**
 * An integer that may be zero -- `offset`, which is 0 in every page but the
 * second.  Separate from the validator below because a positive-only check would
 * refuse the first page of every list, which is the one call a caller is most
 * likely to make explicitly.
 */
function optionalNonNegativeInteger(args: Record<string, unknown>, key: string, tool: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${tool}: "${key}" must be a non-negative integer`)
  }
  return value
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string, tool: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${tool}: "${key}" must be a positive integer`)
  }
  return value
}

/** How much of a selection is in hand, in the terms a reader has to decide with. */
function selectionProgress(selection: SelectionSnapshot | null): Record<string, unknown> | null {
  if (selection === null) return null
  return {
    version: selection.version,
    count: selection.count,
    /** References the view has sent for this version so far. */
    reported: selection.reported,
    /** Every page of this version has arrived, so `reported` is the whole of what the view sent. */
    complete: selection.complete,
    /** The VIEW withheld references: even a complete assembly is shorter than `count`. */
    truncated: selection.truncated,
    source: selection.source,
    updatedAt: new Date(selection.at).toISOString(),
  }
}

/**
 * The selection, paged.
 *
 * THREE STATE FLAGS, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   - `page.exhausted` -- this page of THIS ANSWER reached the end of what the
 *     host has. It says nothing about whether the host has everything.
 *   - `selection.complete` -- every page the view sent has arrived, so the list
 *     being paged over is the view's whole report for this version. Before it is
 *     true the list is still filling in and a caller should read, note the
 *     version, and ask again.
 *   - `selection.truncated` -- the view itself withheld references, so the set
 *     is smaller than `count` even when complete.
 *
 * A reader that took any one of them for another would act on a selection the
 * user never made: `page.exhausted` for `complete` concludes the objects at the
 * end of a half-arrived list are unselected, and `truncated` ignored concludes
 * the same about everything past the view's own cap. This is why the tool
 * reports all three rather than a single `complete`.
 *
 * VERSION. A pager spans several calls, and a selection can change between them;
 * the pages it collects would then come from two different selections and index
 * into neither. So the version travels in the answer and may be passed back in:
 * a caller that passes the version it started with is TOLD when it no longer
 * holds, rather than being quietly handed a different selection's page.
 */
export function viewSelectionTool(lookup: StateLookup, prefix: string,
  tools?: ViewDomainTools): RawToolDefinition {
  const name = `${prefix}_view_selection`
  return {
    name,
    description:
      'Answers about a document the user has open in this session, and a preview has to be MOUNTED before there is anything to answer about. ' +
      'Opening the document is what mounts one: ' + howAPreviewMounts(tools) + ' ' +
      'Called before that it refuses and says so — deliberately, because an empty selection and a session with no view at ' +
      'all are different answers and reporting the first for the second is how "nothing is selected" gets concluded from "nothing has been shown". ' +
      'Read the IAM view selection in this session: how many objects are selected, their stable references, which editor reported it and when. ' +
      'Use it to act on "the selected" things. ' +
      'IT ANSWERS ABOUT WHAT IS ON SCREEN, NOT ABOUT A FILE. A question that names something in the document — a surface, a roadway, a layer — is a ' +
      'question about that document, and ' + readsDocumentsWith(tools) + ' reads it; calling this instead finds a selection that has nothing to do with the ' +
      'question, or refuses because nothing is mounted. Both are a wasted turn and the second reads to the user as a failure. ' +
      'YOU CAN TELL WHETHER A PREVIEW IS MOUNTED WITHOUT CALLING: a session with one has been given an `IAM 视图状态：…` notice, and this plugin ' +
      'sends another whenever the view changes. If no such notice has appeared in this session, nothing is mounted and this tool will refuse -- ' +
      'answer from the document instead of calling it to find out. ' +
      'The list is paged: `count` is the true number selected, `selection.complete` says whether the whole ' +
      'selection has finished arriving, and `selection.truncated` says whether the view itself withheld references beyond its own bound. ' +
      'Pass `version` to pin the selection you are paging through; if it has changed you are told so instead of being given a page of another selection.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        offset: { type: 'integer', description: 'How many references to skip. Defaults to 0.' },
        limit: { type: 'integer', description: `How many to return. Defaults to ${DEFAULT_PAGE}, at most ${MAX_PAGE}.` },
        version: {
          type: 'integer',
          description:
            'The selection version you are reading. Omit on the first call; pass the version the previous answer gave you to detect that the selection moved.',
        },
      },
    },
    output: {
      schema: { description: 'The current selection and one page of its object references.' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) }],
    },
    presentCall: () => ({
      card: 'generic',
      title: name,
      kind: 'read',
    }),
    async execute(args, exec) {
      const record = (args ?? {}) as Record<string, unknown>
      const resolved = lookup(exec)
      if ('error' in resolved) throw new Error(`${name}: ${resolved.error}`)
      const { state, others } = resolved
      const selection = state.selection
      const offset = optionalNonNegativeInteger(record, 'offset', name) ?? 0
      const limit = Math.min(optionalPositiveInteger(record, 'limit', name) ?? DEFAULT_PAGE, MAX_PAGE)
      const askedVersion = optionalNonNegativeInteger(record, 'version', name)

      const envelope = {
        view: state.viewId || null,
        document: { name: state.documentName || null, revision: state.lastSave?.revision ?? null },
        ...(others !== undefined && others.length > 0 ? { otherDocuments: others } : {}),
      }

      if (selection === null) {
        return {
          ...envelope,
          selection: null,
          // Only stale when a version was ASKED for: a caller that named one is
          // paging a selection that has gone, and it has to be told so.
          ...(askedVersion === undefined ? {} : { stale: { requested: askedVersion, current: null } }),
          note: '这个会话还没有收到任何选择事件：视图未打开文档，或事件通道尚未建立。',
        }
      }

      const stale = askedVersion !== undefined && askedVersion !== selection.version
        ? { requested: askedVersion, current: selection.version }
        : undefined

      const page = selection.refs.slice(offset, offset + limit)
      const progress = selectionProgress(selection)
      return {
        ...envelope,
        ...(stale === undefined ? {} : { stale }),
        selection: { ...progress, refs: page },
        page: {
          offset,
          limit,
          returned: page.length,
          /** How much of the assembled set the host is holding right now. */
          available: selection.refs.length,
          /** This answer reached the end of what the host holds. NOT the same as `selection.complete`. */
          exhausted: offset + page.length >= selection.refs.length,
        },
        ...(selection.complete
          ? {}
          : {
            pending:
                '这个选择集还在分页传输中：`selection.complete` 为 false 时列表尚未收全，请按上面的版本号稍后重读。',
          }),
      }
    },
  }
}

/**
 * The recent edits, newest first.
 *
 * ONLY COMMITTED ONES, and a refused edit is reported separately rather than
 * listed here. A drag in progress and a refused undo are both "something the user
 * did", and neither is a change to the document -- a list that mixed them would
 * have an agent reasoning about a document state that does not exist.
 *
 * IT ALSO CARRIES THE EVENT GAPS. A client whose queue filled up had to drop
 * something, and the one thing that must not happen is a reader taking the
 * resulting hole for "nothing happened" -- so what was dropped is reported with
 * the history it is missing from.
 */
export function viewRecentEditsTool(lookup: StateLookup, prefix: string,
  tools?: ViewDomainTools): RawToolDefinition {
  const name = `${prefix}_view_recent_edits`
  return {
    name,
    description:
      'Answers about a document the user has open in this session, and a preview has to be MOUNTED before there is anything to answer about. ' +
      'Opening the document is what mounts one: ' + howAPreviewMounts(tools) + ' ' +
      'Called before that it refuses and says so. ' +
      'Read the recent committed edits in this session’s IAM view: what was changed, which objects, the document revision, and whether it was an edit, ' +
      'an undo or a redo. Newest first. Undo and redo appear as their own kinds, so "the model gained a surface" and "the user took one back" are not confused. ' +
      'A `gaps` field, when present, says how many events a client had to drop because its queue filled up.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: `How many records to return. Defaults to ${DEFAULT_PAGE}, at most ${MAX_PAGE}.` },
      },
    },
    output: {
      schema: { description: 'The committed edits, newest first, with the save state that follows them.' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) }],
    },
    presentCall: () => ({ card: 'generic', title: name, kind: 'read' }),
    async execute(args, exec) {
      const record = (args ?? {}) as Record<string, unknown>
      const resolved = lookup(exec)
      if ('error' in resolved) throw new Error(`${name}: ${resolved.error}`)
      const { state, others } = resolved
      const limit = Math.min(optionalPositiveInteger(record, 'limit', name) ?? DEFAULT_PAGE, MAX_PAGE)
      const edits = state.edits.slice(0, limit).map(edit => ({
        eventId: edit.eventId,
        kind: edit.kind,
        operation: edit.operation,
        refs: edit.refs,
        truncated: edit.truncated,
        ...(edit.before === undefined ? {} : { before: edit.before }),
        ...(edit.after === undefined ? {} : { after: edit.after }),
        revision: edit.revision ?? null,
        document: edit.documentName || null,
        source: edit.source,
        at: new Date(edit.at).toISOString(),
      }))
      return {
        view: state.viewId || null,
        document: { name: state.documentName || null },
        ...(others !== undefined && others.length > 0 ? { otherDocuments: others } : {}),
        edits,
        total: state.edits.length,
        // The count of edits made since the document was last written anywhere.
        // An agent about to propose "save it" needs to know whether there is
        // anything to save, and this is the only place that fact exists.
        unsaved: unsavedCount(state),
        lastSave: state.lastSave === null
          ? null
          : {
            path: state.lastSave.path,
            at: new Date(state.lastSave.at).toISOString(),
            source: state.lastSave.source,
            revision: state.lastSave.revision ?? null,
          },
        // What never reached the record, if anything did not. Present only when
        // there is something to say, so its absence is not read as a zero.
        ...(state.gaps === null
          ? {}
          : {
            gaps: {
              droppedFacts: state.gaps.droppedFacts,
              droppedByKind: state.gaps.droppedByKind,
              firstAt: new Date(state.gaps.firstAt).toISOString(),
              lastAt: new Date(state.gaps.lastAt).toISOString(),
              source: state.gaps.source,
            },
          }),
        lastError: state.lastError,
      }
    },
  }
}

/**
 * How many committed edits have not been written out.
 *
 * Counted from the newest save rather than tracked as a flag: a save from the
 * native editor writes the same file, and a flag kept by one transport would be
 * wrong about the other's writes.
 */
export function unsavedCount(state: ViewState): number {
  const since = state.lastSave?.at ?? 0
  let count = 0
  for (const edit of state.edits) {
    if (edit.at <= since) break
    if (edit.kind === 'edit.committed') count += 1
  }
  return count
}
