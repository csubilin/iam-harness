import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** The layout version every view event carries. Bumped when a field changes meaning. */
export const VIEW_EVENT_SCHEMA = 'iax.iam.view-event/1'

/** The kinds this version understands. An unknown one is refused, never stored. */
const KNOWN_KINDS = new Set([
  'selection.changed',
  'edit.committed',
  'edit.undone',
  'edit.redone',
  'edit.failed',
  'document.saved',
])

/** Where an event came from. Both transports land in the same record. */
export type EventSource = 'wasm' | 'native'

/** Upper bounds. Every one of them protects the Harness process or the model's context. */
export const LIMITS = {
  /** One POST body, before it is refused. */
  bodyBytes: 64 * 1024,
  /** Events admitted from one POST. */
  eventsPerRequest: 64,
  /** Object references in ONE event -- the schema's own cap, restated because this side must not trust it. */
  refsPerEvent: 256,
  /**
   * Object references kept for ONE selection across all of its pages.
   *
   * Larger than `refsPerEvent` because a page is not the whole selection, and
   * bounded at all because a selection of a million objects is a number that can
   * be reported without the list travelling. Beyond this the view says
   * `truncated` and the count is still the true one.
   */
  refsPerSelection: 4096,
  /** Committed edits kept per view, newest first. */
  editsKept: 200,
  /** Event ids remembered for deduplication, per view. */
  seenIds: 1024,
  /** Pages a single selection may be assembled from, so a hostile stream cannot grow it. */
  selectionPages: 64,
  /** Characters of any one string kept from an event. */
  stringChars: 512,
} as const

/** How long a capability lives. */
export const CAPABILITY_TTL_MS = 30 * 60 * 1000
/** How long a native launch token may take to be spent. */
export const NATIVE_TOKEN_TTL_MS = 120 * 1000

/** One stable reference to one object, as the view reported it. */
export interface ViewObjectRef {
  kind: string
  value: string
  label?: string
}

/** The selection half of an event, one page of it. */
export interface EventSelection {
  version: number
  count: number
  truncated: boolean
  /** Index of this page's first reference within the whole selection. */
  offset: number
  /** Whether another page of this same version follows. */
  more: boolean
  refs: ViewObjectRef[]
}

/** A validated event, in the shape the rest of the host uses. */
export interface ViewEvent {
  eventId: string
  sequence: number
  kind: string
  viewId: string
  viewDomain: string
  viewMode: string
  documentName: string
  hasRevision: boolean
  revision?: number
  selection?: EventSelection
  edit?: { operation: string; before?: string; after?: string; message?: string; refs: ViewObjectRef[]; truncated: boolean }
  save?: { path: string; hash?: string }
}

/**
 * The selection as it stands now, assembled from every page of one version.
 *
 * `complete` and `truncated` answer different questions and a reader needs both:
 *
 *   - `complete` -- every page of this version has arrived, so `refs` is exactly
 *     what the view sent. Before it is true the set is still filling in, and a
 *     reader that treated a half-arrived set as the answer would be reading a
 *     selection the user never made.
 *   - `truncated` -- the view itself withheld references, so even a complete
 *     assembly is smaller than `count`. This is the one a reader must not get
 *     wrong: it is the difference between "these are all the selected objects"
 *     and "these are the ones that fit".
 */
export interface SelectionSnapshot {
  version: number
  count: number
  refs: ViewObjectRef[]
  /** References the view has sent for this version so far. */
  reported: number
  truncated: boolean
  complete: boolean
  /** The offset the next in-order page must carry. */
  nextOffset: number
  /** Pages that arrived ahead of the gap before them. */
  pending: Map<number, ViewObjectRef[]>
  /** The last page (the one that said `more: false`) has been seen. */
  sawLastPage: boolean
  /** Pages accepted into the set, for the bound. */
  pages: number
  at: number
  source: EventSource
  instanceId: string
  documentName: string
}

/** One committed edit, in order. */
export interface EditRecord {
  eventId: string
  kind: string
  operation: string
  refs: ViewObjectRef[]
  truncated: boolean
  before?: string
  after?: string
  message?: string
  revision?: number
  documentName: string
  at: number
  source: EventSource
  instanceId: string
}

/** What a save left behind, for the "the file moved on" prompt. */
export interface SaveRecord {
  path: string
  hash?: string
  revision?: number
  at: number
  source: EventSource
}

/**
 * Facts a client had to drop, reported rather than forgotten.
 *
 * A queue that is full has to lose something, and the only thing worse than
 * losing a committed edit is losing it silently -- an agent reading the history
 * would take a gap for "nothing happened". So the client counts what it dropped,
 * names the kinds, and sends the tally with its next batch; this is where that
 * tally is kept, and it is reachable from `status` and from both tools.
 */
export interface EventGap {
  droppedFacts: number
  droppedByKind: Record<string, number>
  firstAt: number
  lastAt: number
  source: EventSource
  /** True until a reader has been shown it, so the status line can carry it once. */
  reported: boolean
}

/**
 * One mounted editor: the instance a capability was issued for.
 *
 * The id is the host's, not the caller's, and that is the point: an event's
 * identity is checked against what the HOST issued, so a client cannot claim to
 * be the view that replaced it.
 */
export interface ViewInstance {
  instanceId: string
  kind: 'page' | 'native'
  sessionId: string
  address: string
  /** The document name the address gives it (its basename). */
  documentName: string
  /**
   * The name the VIEW calls the document, pinned from this instance's first
   * event. See `sameDocument` for why it is pinned rather than compared to the
   * binding's name.
   */
  viewDocumentName: string | null
  createdAt: number
  lastEventAt: number
}

/** Everything one session has reported about one document. */
export interface ViewState {
  sessionId: string
  /** The whole `dsh-resource://` address, which is what identifies the document. */
  address: string
  /** The document name from the address, for a title and a status line. */
  documentName: string
  viewId: string
  /** The instance holding the view right now: the latest capability issued. */
  instanceId: string
  selection: SelectionSnapshot | null
  edits: EditRecord[]
  lastSave: SaveRecord | null
  /** Whether the preview's own WebAssembly view has spoken. */
  wasmSeen: boolean
  /** The native editor's liveness, as this host knows it. */
  native: { connected: boolean; pid?: number; launchedAt?: number; documentName?: string; instanceId?: string }
  /** The last refusal a transport reported, for the status line. */
  lastError: string | null
  /** What a client had to drop, when it had to drop something. */
  gaps: EventGap | null
  seen: Set<string>
  seenOrder: string[]
  /** The watermark the agent's injected context is at, so one change is announced once. */
  announcedSelectionVersion: number
  announcedEditEvent: string | null
  pendingInjection: boolean
  injectionTimer: ReturnType<typeof setTimeout> | null
  /** When this document was last written to, which is what `activeFor` ranks by. */
  lastTouchedAt: number
}

/** A token's binding: what it may do, for whom, and until when. */
export interface CapabilityBinding {
  token: string
  /**
   * Which of the two callers holds this. A page capability is reissued when the
   * preview remounts and the old one is then retired; a native token is spent by
   * the connection that presents it and must not be retired by a page's reload.
   */
  kind: 'page' | 'native'
  sessionId: string
  /** The whole address, which is what names the document. */
  resourceAddress: string
  documentName: string
  /** The view instance this token speaks for. Every event it carries is filed under it. */
  instanceId: string
  /** What the holder may call with it. */
  purposes: readonly CapabilityPurpose[]
  expiresAt: number
  /** Native launch tokens are spent by the connection that presents them. */
  singleUse: boolean
  spent: boolean
}

export type CapabilityPurpose = 'events' | 'status' | 'native-launch'

/** What a route needs from the caller before it will answer. */
export interface CapabilityRequirement {
  purposes: readonly CapabilityPurpose[]
  consume?: boolean
}

/**
 * The tokens, and nothing else.
 *
 * A Map rather than a store keyed by session: one session may hold several live
 * capabilities -- a page that reloaded asks for a new one while the old is still
 * unexpired, and a native editor launched twice has two -- and revoking by
 * session has to reach all of them.
 */
export class CapabilityRegistry {
  private readonly byToken = new Map<string, CapabilityBinding>()

  issue(binding: Omit<CapabilityBinding, 'token' | 'spent'>): CapabilityBinding {
    // Swept here rather than on a timer: issuing is the only thing that grows
    // this map, so it is the only moment at which a bound is worth paying for --
    // and a token nobody ever presents again is exactly the one `verify` never
    // gets to delete.
    this.sweep()
    const token = randomBytes(24).toString('base64url')
    const entry: CapabilityBinding = { ...binding, token, spent: false }
    this.byToken.set(token, entry)
    return entry
  }

  /**
   * The binding a presented token authorises, or why it does not.
   *
   * A refusal says which of the four checks failed and never echoes the token: the
   * reason travels to a status line, and a status line is not a place for a
   * credential.
   */
  verify(token: string | null | undefined, requirement: CapabilityRequirement): CapabilityBinding | null {
    if (typeof token !== 'string' || token.length === 0) return null
    const entry = this.byToken.get(token)
    if (entry === undefined) return null
    if (entry.expiresAt <= Date.now()) {
      this.byToken.delete(token)
      return null
    }
    if (entry.singleUse && entry.spent) return null
    for (const purpose of requirement.purposes) {
      if (entry.purposes.includes(purpose)) {
        if (requirement.consume === true) entry.spent = true
        return entry
      }
    }
    return null
  }

  release(token: string): void {
    this.byToken.delete(token)
  }

  /**
   * Drop the live capabilities one caller holds for one document.
   *
   * Called when the host issues a page capability: a preview that remounted --
   * a reload, a mode change, a tab switched away and back -- leaves its previous
   * token behind, and retiring it here is what keeps "which document is this
   * view showing" answerable by the token alone.
   *
   * Scoped to the same address on purpose. Two previews of two documents in one
   * session must not be able to revoke each other: each would answer the other's
   * 403 by asking for a fresh capability, which would retire the other's in turn,
   * and the pair would churn tokens for as long as the pane is open. The second
   * half of the same rule is that the two live in separate `ViewState`s, so a
   * token for one cannot reach the other's record either.
   */
  retire(kind: CapabilityBinding['kind'], sessionId: string, resourceAddress: string | undefined): void {
    for (const [token, entry] of this.byToken) {
      if (entry.kind === kind && entry.sessionId === sessionId && entry.resourceAddress === resourceAddress) {
        this.byToken.delete(token)
      }
    }
  }

  /** Every capability for one session, spent or not. */
  releaseSession(sessionId: string): void {
    for (const [token, entry] of this.byToken) {
      if (entry.sessionId === sessionId) this.byToken.delete(token)
    }
  }

  /** Drop what has expired, so a long-lived host does not accumulate dead tokens. */
  sweep(): void {
    const now = Date.now()
    for (const [token, entry] of this.byToken) {
      if (entry.expiresAt <= now) this.byToken.delete(token)
    }
  }
}

function asString(value: unknown, limit = LIMITS.stringChars): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= limit ? value : value.slice(0, limit)
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

function parseRefs(value: unknown): ViewObjectRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const refs: ViewObjectRef[] = []
  for (const entry of value.slice(0, LIMITS.refsPerEvent)) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const kind = asString(record.kind, 32)
    const refValue = asString(record.value)
    if (kind === undefined || refValue === undefined) continue
    const label = asString(record.label, 128)
    refs.push(label === undefined ? { kind, value: refValue } : { kind, value: refValue, label })
  }
  return refs
}

/**
 * Whether two names are the same document.
 *
 * WHY IT IS NOT NAME EQUALITY. `document.name` is a DISPLAY name -- what a view
 * calls the thing on screen -- while the binding's is the file the session
 * opened, and for one of the two domains they are routinely different: a Mining
 * view names its document after the PROJECT, which for an imported mine is the
 * foreign file it came from (`地下矿山整体系统.dmf`) rather than the store it now
 * lives in (`地下矿山整体系统.iam`).
 *
 * Measured 2026-10-07 in the desktop carrier: an equality check HERE rejected
 * EVERY Mining event -- `{"accepted":0,"rejected":1}` on each POST, with the
 * session stuck at the one selection it had ingested before the document was
 * named. The pane showed "已选 0" while the view was selecting.
 *
 * So the comparison is on the STEM: same directory-less name up to the last
 * extension, case-insensitively. That accepts a projection renaming its own
 * document and still refuses the case the check exists for -- a view that opened
 * a DIFFERENT file behind the pane's back (the embedded view has a file picker
 * of its own) reports a different stem, and its events are refused rather than
 * filed against the document the session thinks it is showing.
 *
 * An empty name on either side is not a disagreement: a view that named nothing
 * has made no claim to contradict.
 */
export function sameDocument(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return true
  if (a === b) return true
  const stem = (name: string): string => {
    const cut = name.replace(/\\/g, '/')
    const base = cut.slice(cut.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
  }
  return stem(a) === stem(b)
}

/**
 * One raw event, validated, or the reason it was refused.
 *
 * Deliberately strict about the envelope and forgiving about the payload: an
 * event with no `document` or no `view` could not be attributed to a pane, and
 * storing it would put an unattributable fact in front of an agent. An event
 * whose `selection` is missing on a `selection.changed` is refused for the same
 * reason -- a selection change that names no selection says nothing.
 */
export function validateViewEvent(raw: unknown, source: EventSource): { event: ViewEvent } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'the event is not an object' }
  const record = raw as Record<string, unknown>

  const schema = asString(record.schema, 64)
  if (schema !== VIEW_EVENT_SCHEMA) {
    return { error: `unknown schema ${schema === undefined ? '(none)' : JSON.stringify(schema)}` }
  }
  const eventId = asString(record.eventId, 160)
  if (eventId === undefined || eventId.length === 0) return { error: 'the event has no id' }
  const kind = asString(record.kind, 32)
  if (kind === undefined || !KNOWN_KINDS.has(kind)) {
    return { error: `unknown kind ${kind === undefined ? '(none)' : JSON.stringify(kind)}` }
  }

  const view = record.view
  const document = record.document
  if (view === null || typeof view !== 'object') return { error: 'the event names no view' }
  if (document === null || typeof document !== 'object') return { error: 'the event names no document' }
  const viewRecord = view as Record<string, unknown>
  const documentRecord = document as Record<string, unknown>

  const viewId = asString(viewRecord.id, 64)
  if (viewId === undefined || viewId.length === 0) return { error: 'the event names no view id' }

  const event: ViewEvent = {
    eventId,
    sequence: asInteger(record.sequence) ?? 0,
    kind,
    viewId,
    viewDomain: asString(viewRecord.domain, 16) ?? '',
    viewMode: asString(viewRecord.mode, 16) ?? '',
    documentName: asString(documentRecord.name, 200) ?? '',
    hasRevision: documentRecord.hasRevision === true,
  }
  if (event.hasRevision) {
    const revision = asInteger(documentRecord.revision)
    if (revision !== undefined) event.revision = revision
  }

  if (kind === 'selection.changed') {
    const selection = record.selection
    if (selection === null || typeof selection !== 'object') return { error: 'a selection event carries no selection' }
    const selectionRecord = selection as Record<string, unknown>
    const refs = parseRefs(selectionRecord.refs)
    if (refs === undefined) return { error: 'the selection has no reference list' }
    const count = asInteger(selectionRecord.count)
    if (count === undefined || count < 0) return { error: 'the selection has no count' }
    const offset = asInteger(selectionRecord.offset)
    if (offset !== undefined && offset < 0) return { error: 'the selection page has a negative offset' }
    event.selection = {
      version: asInteger(selectionRecord.version) ?? 0,
      count,
      truncated: selectionRecord.truncated === true,
      // Absent means "the whole thing, first page", which is what every producer
      // that predates paging sends and what a one-page selection still is.
      offset: offset ?? 0,
      more: selectionRecord.more === true,
      refs,
    }
  }

  if (kind === 'edit.committed' || kind === 'edit.undone' || kind === 'edit.redone' || kind === 'edit.failed') {
    const edit = record.edit
    if (edit === null || typeof edit !== 'object') return { error: 'an edit event carries no edit' }
    const editRecord = edit as Record<string, unknown>
    const operation = asString(editRecord.operation, 48)
    if (operation === undefined || operation.length === 0) return { error: 'the edit names no operation' }
    const refs = parseRefs(editRecord.refs) ?? []
    event.edit = { operation, refs, truncated: editRecord.truncated === true }
    const before = asString(editRecord.before, 200)
    const after = asString(editRecord.after, 200)
    const message = asString(editRecord.message, 200)
    if (before !== undefined) event.edit.before = before
    if (after !== undefined) event.edit.after = after
    if (message !== undefined) event.edit.message = message
  }

  if (kind === 'document.saved') {
    const save = record.save
    if (save === null || typeof save !== 'object') return { error: 'a save event carries no save' }
    const saveRecord = save as Record<string, unknown>
    const path = asString(saveRecord.path)
    if (path === undefined) return { error: 'the save names no path' }
    event.save = { path }
    const hash = asString(saveRecord.hash, 128)
    if (hash !== undefined && hash.length > 0) event.save.hash = hash
  }

  // The source is stamped here rather than trusted from the wire: a transport
  // says where it is by the route it used, and a field a client could set would
  // be a field a client could lie about.
  void source
  return { event }
}

/** What one `ingest` did, so a route can count the three outcomes apart. */
export interface IngestOutcome {
  status: 'stored' | 'duplicate' | 'superseded' | 'refused'
  reason?: string
}

/** The key a state is filed under: one document of one session. */
function viewKey(sessionId: string, address: string): string {
  return `${sessionId}\u0000${address}`
}

/**
 * The per-view records, and the one place they are written.
 *
 * There is no persistence: a view's selection and its edit history are live
 * state of a live editor, and the durable copy of an edit is the document the
 * user saved. What this keeps is what a session's agent may be told, bounded so
 * that a long session cannot grow it without limit.
 */
export class ViewEventStore {
  private readonly views = new Map<string, ViewState>()
  private readonly instances = new Map<string, ViewInstance>()

  constructor(private readonly notify: (state: ViewState, summary: string) => void) {}

  // ------------------------------------------------------------- instances

  /**
   * A new view instance, and the capability that will speak for it.
   *
   * Called on every capability issuance. A page that remounted is a new
   * instance even though the document is the same, because its `eventId`
   * sequence starts again at 1 and its selection version starts again at 1 --
   * identity is what keeps those from being read as a repeat of the previous
   * page's.
   */
  openInstance(options: {
    kind: 'page' | 'native'
    sessionId: string
    address: string
    documentName: string
  }): ViewInstance {
    const instance: ViewInstance = {
      instanceId: randomUUID(),
      kind: options.kind,
      sessionId: options.sessionId,
      address: options.address,
      documentName: options.documentName,
      viewDocumentName: null,
      createdAt: Date.now(),
      lastEventAt: 0,
    }
    this.instances.set(instance.instanceId, instance)

    const state = this.stateFor(options.sessionId, options.address)
    if (options.kind === 'page') {
      // A remounted page has not reported anything yet. Leaving the previous
      // page's selection on the record would be showing an agent a selection of
      // a view that no longer exists; the edit history and the last save stay,
      // because those are facts about the DOCUMENT and they still happened.
      state.selection = null
      state.instanceId = instance.instanceId
    } else {
      state.native = {
        connected: false,
        instanceId: instance.instanceId,
        documentName: options.documentName,
      }
    }
    state.lastTouchedAt = Date.now()
    return instance
  }

  instance(instanceId: string): ViewInstance | undefined {
    return this.instances.get(instanceId)
  }

  // ---------------------------------------------------------------- states

  stateFor(sessionId: string, address: string): ViewState {
    const key = viewKey(sessionId, address)
    const existing = this.views.get(key)
    if (existing !== undefined) return existing
    const state: ViewState = {
      sessionId,
      address,
      documentName: '',
      viewId: '',
      instanceId: '',
      selection: null,
      edits: [],
      lastSave: null,
      wasmSeen: false,
      native: { connected: false },
      lastError: null,
      gaps: null,
      seen: new Set(),
      seenOrder: [],
      announcedSelectionVersion: -1,
      announcedEditEvent: null,
      pendingInjection: false,
      injectionTimer: null,
      lastTouchedAt: 0,
    }
    this.views.set(key, state)
    return state
  }

  get(sessionId: string, address: string): ViewState | undefined {
    return this.views.get(viewKey(sessionId, address))
  }

  /**
   * The document in this session a tool call or a status poll is about.
   *
   * The most recently written one, which for the ordinary case -- one preview,
   * one document -- is the only one there is. A session that has had two
   * documents open gets the one it is looking at; the other's record is kept and
   * is named in the tool's answer rather than silently dropped.
   */
  activeFor(sessionId: string): ViewState | undefined {
    let best: ViewState | undefined
    for (const state of this.views.values()) {
      if (state.sessionId !== sessionId) continue
      if (best === undefined || state.lastTouchedAt > best.lastTouchedAt) best = state
    }
    return best
  }

  /** Every document this session has a record for, newest first. */
  documentsOf(sessionId: string): ViewState[] {
    const list: ViewState[] = []
    for (const state of this.views.values()) {
      if (state.sessionId === sessionId) list.push(state)
    }
    return list.sort((left, right) => right.lastTouchedAt - left.lastTouchedAt)
  }

  /** Forget one session, and everything queued for it. */
  drop(sessionId: string): void {
    for (const [key, state] of [...this.views]) {
      if (state.sessionId !== sessionId) continue
      if (state.injectionTimer !== null) clearTimeout(state.injectionTimer)
      this.views.delete(key)
    }
    for (const [id, instance] of [...this.instances]) {
      if (instance.sessionId === sessionId) this.instances.delete(id)
    }
  }

  dropAll(): void {
    const sessions = new Set<string>()
    for (const state of this.views.values()) sessions.add(state.sessionId)
    for (const sessionId of sessions) this.drop(sessionId)
    this.views.clear()
    this.instances.clear()
  }

  // --------------------------------------------------------------- writing

  /**
   * Admit one validated event.
   *
   * The four refusals are separate because they mean different things:
   *
   *   - `duplicate` is the protocol working. A batch resent after an expired
   *     capability, a reconnect, a retried POST -- the same fact arriving twice
   *     is not a second fact.
   *   - `superseded` is a view that has been replaced: the token is still
   *     unexpired, but the instance it names is no longer the one holding this
   *     document. Writing it would put the previous editor's facts into the view
   *     that replaced it.
   *   - `refused` is a disagreement about WHICH DOCUMENT, and it exists because
   *     the embedded view has a file picker of its own: a user who opens another
   *     file inside the frame would otherwise have their events filed against
   *     the document the pane is showing.
   *
   * A duplicate is answered before anything else, because it is the only one of
   * the four that is not a problem.
   */
  ingest(binding: CapabilityBinding, event: ViewEvent, source: EventSource): IngestOutcome {
    const state = this.stateFor(binding.sessionId, binding.resourceAddress)
    const instance = this.instances.get(binding.instanceId)

    if (instance === undefined) {
      return { status: 'superseded', reason: '这个视图实例已经不存在了。' }
    }
    if (instance.kind === 'page' && state.instanceId !== instance.instanceId) {
      return { status: 'superseded', reason: `视图实例 ${instance.instanceId} 已被替换。` }
    }
    if (!sameDocument(instance.viewDocumentName ?? '', event.documentName)) {
      return {
        status: 'refused',
        reason: `事件说的文档是 ${JSON.stringify(event.documentName)}，这个视图打开的是 ${JSON.stringify(instance.viewDocumentName)}。`,
      }
    }

    const dedupKey = `${source}|${instance.instanceId}|${event.eventId}`
    if (state.seen.has(dedupKey)) return { status: 'duplicate' }

    if (instance.viewDocumentName === null && event.documentName.length > 0) {
      instance.viewDocumentName = event.documentName
    }
    instance.lastEventAt = Date.now()
    state.lastTouchedAt = Date.now()

    state.seen.add(dedupKey)
    state.seenOrder.push(dedupKey)
    while (state.seenOrder.length > LIMITS.seenIds) {
      const oldest = state.seenOrder.shift()
      if (oldest !== undefined) state.seen.delete(oldest)
    }
    if (event.viewId.length > 0) state.viewId = event.viewId
    if (source === 'wasm') state.wasmSeen = true

    const at = Date.now()
    switch (event.kind) {
      case 'selection.changed': {
        const selection = event.selection
        if (selection === undefined) return { status: 'refused', reason: '选择事件没有携带选择集。' }
        this.applySelectionPage(state, selection, source, instance.instanceId, event.documentName, at)
        break
      }
      case 'edit.committed':
      case 'edit.undone':
      case 'edit.redone': {
        const edit = event.edit
        if (edit === undefined) return { status: 'refused', reason: '编辑事件没有携带编辑内容。' }
        state.edits.unshift({
          eventId: event.eventId,
          kind: event.kind,
          operation: edit.operation,
          refs: edit.refs,
          truncated: edit.truncated,
          ...(edit.before === undefined ? {} : { before: edit.before }),
          ...(edit.after === undefined ? {} : { after: edit.after }),
          ...(event.revision === undefined ? {} : { revision: event.revision }),
          documentName: event.documentName,
          at,
          source,
          instanceId: instance.instanceId,
        })
        if (state.edits.length > LIMITS.editsKept) state.edits.length = LIMITS.editsKept
        break
      }
      case 'edit.failed': {
        const edit = event.edit
        // A failure is not an edit and is not kept as one: it is recorded so the
        // status line can say it, and so an agent that asks "did my last request
        // work" gets an answer. Keeping it in the edit list would let a refused
        // undo read as an edit for the rest of the session.
        state.lastError = edit === undefined ? 'an edit failed' : `${edit.operation}: ${edit.message ?? 'refused'}`
        break
      }
      case 'document.saved': {
        const save = event.save
        if (save === undefined) return { status: 'refused', reason: '保存事件没有携带路径。' }
        state.lastSave = {
          path: save.path,
          ...(save.hash === undefined ? {} : { hash: save.hash }),
          ...(event.revision === undefined ? {} : { revision: event.revision }),
          at,
          source,
        }
        state.lastError = null
        break
      }
      default:
        break
    }

    this.announce(state, event, source)
    return { status: 'stored' }
  }

  /**
   * Fold one page of a selection into the set it belongs to.
   *
   * The version comparison happens ONLY within one instance. That is the whole
   * of the fix for a class of silent losses: `version` is the view's own counter
   * and every process and every page starts it at 1, so comparing a native
   * editor's version 1 against the browser view's version 5 would throw the
   * native selection away as stale -- and the two are not describing the same
   * view at all. Between instances the newer event simply wins; within one, a
   * lower version really is a stale delivery and really should lose.
   */
  private applySelectionPage(
    state: ViewState,
    page: { version: number; count: number; truncated: boolean; offset: number; more: boolean; refs: ViewObjectRef[] },
    source: EventSource,
    instanceId: string,
    documentName: string,
    at: number,
  ): void {
    let snapshot = state.selection
    const sameInstance = snapshot !== null && snapshot.instanceId === instanceId && snapshot.source === source

    if (!sameInstance) {
      // A different editor, or a remounted page: a version space of its own, so
      // its first page is the whole answer so far rather than a comparison.
      snapshot = {
        version: page.version,
        count: page.count,
        refs: [],
        reported: 0,
        truncated: page.truncated,
        complete: false,
        nextOffset: 0,
        pending: new Map(),
        sawLastPage: false,
        pages: 0,
        at,
        source,
        instanceId,
        documentName,
      }
      state.selection = snapshot
    } else if (page.version < snapshot.version) {
      // Same instance, older version: a delivery that overtook the one after it.
      return
    } else if (page.version > snapshot.version) {
      state.selection = snapshot = {
        version: page.version,
        count: page.count,
        refs: [],
        reported: 0,
        truncated: page.truncated,
        complete: false,
        nextOffset: 0,
        pending: new Map(),
        sawLastPage: false,
        pages: 0,
        at,
        source,
        instanceId,
        documentName,
      }
    }

    snapshot.count = page.count
    snapshot.truncated = page.truncated
    snapshot.at = at
    snapshot.documentName = documentName

    if (snapshot.pages >= LIMITS.selectionPages) {
      // A stream that keeps claiming more pages is not a selection anyone made.
      // What has been assembled stays, marked incomplete and truncated, so a
      // reader is told the set is short rather than shown a growing one.
      snapshot.truncated = true
      return
    }

    if (page.offset === snapshot.nextOffset) {
      snapshot.refs.push(...page.refs)
      snapshot.nextOffset += page.refs.length
      snapshot.pages += 1
      if (!page.more) snapshot.sawLastPage = true
      // Drain whatever had arrived ahead of the gap this page just closed.
      for (;;) {
        const next = snapshot.pending.get(snapshot.nextOffset)
        if (next === undefined) break
        snapshot.pending.delete(snapshot.nextOffset)
        snapshot.refs.push(...next)
        snapshot.nextOffset += next.length
        snapshot.pages += 1
      }
    } else if (page.offset > snapshot.nextOffset) {
      // A gap before it. Kept aside rather than appended: appending out of order
      // would put references at the wrong indices, and an index is what a cursor
      // into this list means.
      snapshot.pending.set(page.offset, page.refs)
      if (!page.more) snapshot.sawLastPage = true
    }
    // page.offset < nextOffset is a page already folded in -- a resend after a
    // reconnect -- and is dropped rather than appended twice.

    // Bounded: the pages that have arrived, and the ones waiting for a gap.
    let total = snapshot.refs.length
    for (const waiting of snapshot.pending.values()) total += waiting.length
    if (total > LIMITS.refsPerSelection) {
      snapshot.truncated = true
    }

    snapshot.reported = snapshot.refs.length
    snapshot.complete = snapshot.sawLastPage && snapshot.pending.size === 0
  }

  /** Record what a client had to drop, merging with anything already recorded. */
  recordGaps(state: ViewState, gaps: { droppedFacts?: unknown; droppedByKind?: unknown }, source: EventSource): void {
    const dropped = asInteger(gaps.droppedFacts)
    if (dropped === undefined || dropped <= 0) return
    const byKind: Record<string, number> = state.gaps?.droppedByKind ?? {}
    if (gaps.droppedByKind !== null && typeof gaps.droppedByKind === 'object') {
      for (const [kind, count] of Object.entries(gaps.droppedByKind as Record<string, unknown>)) {
        const value = asInteger(count)
        if (value === undefined || value <= 0) continue
        byKind[kind] = (byKind[kind] ?? 0) + value
      }
    }
    const now = Date.now()
    state.gaps = {
      droppedFacts: (state.gaps?.droppedFacts ?? 0) + dropped,
      droppedByKind: byKind,
      firstAt: state.gaps?.firstAt ?? now,
      lastAt: now,
      source,
      reported: false,
    }
    state.lastTouchedAt = now
  }

  /** Note a transport's own report about itself, for the status line. */
  noteError(state: ViewState, message: string): void {
    state.lastError = message
    state.lastTouchedAt = Date.now()
  }

  /**
   * Tell the session's agent, coalesced.
   *
   * `agent.inject()` queues model-facing context for the next pre-step and does
   * NOT wake an idle agent -- which is exactly the semantic wanted here: a user
   * clicking around a drawing must not start a conversation, and the next message
   * they do send should carry what they were looking at.
   *
   * The throttle is what keeps that from becoming a paragraph per click. A
   * selection that moves ten times in a second is one statement about where it
   * ended up.
   */
  private announce(state: ViewState, event: ViewEvent, source: EventSource): void {
    // A selection is announced by version; an edit or a save by the event itself.
    // Both are watermarks rather than flags, so a second delivery of something
    // already announced cannot produce a second injection.
    if (event.kind === 'selection.changed') {
      // Only when the set is whole: a page of a selection is not a selection,
      // and announcing one would tell the agent about a fraction of what the
      // user has selected.
      if (state.selection === null || !state.selection.complete) return
      const version = event.selection?.version ?? 0
      if (version <= state.announcedSelectionVersion) return
    } else if (event.kind === 'edit.committed' || event.kind === 'edit.undone' || event.kind === 'edit.redone' || event.kind === 'document.saved') {
      if (state.announcedEditEvent === event.eventId) return
    } else {
      // edit.failed is reported on the status line and by the tools; it does not
      // push context into a conversation the user is not having.
      return
    }
    void source

    state.pendingInjection = true
    if (state.injectionTimer !== null) return
    // Long enough to coalesce a burst, short enough that the next message the user
    // sends carries the state they just created.
    state.injectionTimer = setTimeout(() => {
      state.injectionTimer = null
      if (!state.pendingInjection) return
      state.pendingInjection = false
      // The watermark is read off the STATE at flush time, not off the event that
      // armed the timer. A burst of selections arms this once with the first of
      // them, so recording that event's version would leave every later version
      // of the same burst looking unannounced -- and the next one would be
      // announced a second time.
      const latest = state.selection
      if (latest !== null) state.announcedSelectionVersion = Math.max(state.announcedSelectionVersion, latest.version)
      if (event.kind !== 'selection.changed') state.announcedEditEvent = event.eventId
      this.notify(state, describeState(state))
    }, 1200)
    // A pending timer must not hold the process open: a Harness with nothing else
    // to do should be able to exit.
    state.injectionTimer.unref?.()
  }
}

/**
 * The state as one short paragraph, for `agent.inject()`.
 *
 * DELIBERATELY SHORT, and the full lists are reachable through the tools. A
 * selection of four thousand entities cannot go into a prompt, and the number is
 * the part that matters anyway -- an agent that wants the objects asks the
 * selection tool, which pages.
 */
export function describeState(state: ViewState): string {
  // Which transport spoke LAST, derived from the records rather than from a
  // caller's argument: the state outlives any one event, and the summary is read
  // at flush time.
  const source = state.native.connected ? 'native'
    : state.lastSave !== null && state.edits.length === 0 ? state.lastSave.source
      : state.selection?.source ?? (state.lastSave?.source ?? 'wasm')
  const lines: string[] = []
  const document = state.documentName.length > 0 ? state.documentName : '(未命名)'
  lines.push(`[IAM 视图] 视图 ${state.viewId || '未知'}，文档 ${document}，事件来源 ${source === 'native' ? '原生编辑器' : '预览视图'}。`)

  if (state.selection === null) {
    lines.push('当前选择：无。')
  } else {
    const shown = state.selection.refs.slice(0, 8).map(ref => `${ref.kind}:${ref.value}`).join(', ')
    const partial = !state.selection.complete
      ? '（选择集还在分页传输中，完整列表请稍后用选择工具按版本读取）'
      : state.selection.truncated || state.selection.count > state.selection.refs.length
        ? '（列表已截断，完整列表用选择工具分页读取）'
        : ''
    lines.push(`当前选择：${state.selection.count} 个对象（选择版本 ${state.selection.version}）${shown.length > 0 ? `：${shown}` : ''}${partial}`)
  }

  const committed = state.edits.filter(edit => edit.kind === 'edit.committed')
  if (committed.length === 0) {
    lines.push('已提交编辑：无。')
  } else {
    const latest = committed[0]
    const revision = latest.revision === undefined ? '' : `，文档修订 ${latest.revision}`
    lines.push(`已提交编辑：${committed.length} 条（最新：${latest.operation}${latest.after === undefined ? '' : `，${latest.after}`}${revision}）。完整记录用编辑记录工具读取。`)
  }

  if (state.lastSave !== null) {
    lines.push(`最近保存：${state.lastSave.path}（${state.lastSave.source === 'native' ? '原生编辑器' : '预览视图'}）。`)
  }
  if (state.gaps !== null) {
    lines.push(`注意：事件队列曾满，有 ${state.gaps.droppedFacts} 条事件未能送出。`)
  }
  return lines.join('\n')
}

/** The header a capability travels in. One spelling, read by every route. */
export const CAPABILITY_HEADER = 'x-iam-capability'

/** The presented capability token, or null. */
export function capabilityFrom(req: IncomingMessage): string | null {
  const value = req.headers[CAPABILITY_HEADER]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A fresh event id, for a record this host creates rather than receives. */
export function newEventId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}
