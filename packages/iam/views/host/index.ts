import { randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  basenameOf,
  isAddressFailure,
  openWorkspaceFile,
  resourceAddressSession,
  resolveWorkspaceFile,
  verifyWorkspaceFile,
  type AddressOutcome,
  type SessionRootLookup,
} from './address.js'
import {
  CAPABILITY_TTL_MS,
  CapabilityRegistry,
  capabilityFrom,
  describeState,
  ViewEventStore,
  validateViewEvent,
  LIMITS,
  VIEW_EVENT_SCHEMA,
  type ViewState,
} from './events.js'
import { NativeEditorBridge } from './native.js'
import { unsavedCount, viewRecentEditsTool, viewSelectionTool } from './tools.js'
import { selectedDomains, VIEW_DOMAINS } from './domains.js'
import { BrowserDrawingEntityQueryQueue, parseDrawingEntityQueryParameters } from './drawing-entity-query.js'

export const name = 'iam-views'

/** The harness service this half needs before it can serve anything. */
export const inject = ['webServer']

/**
 * The domains this one plugin serves, and the route each is served under.
 *
 * One package and one code path, where there used to be two packages kept in
 * step by copying one over the other -- see `host/domains.ts` for the two bugs
 * that copying cost. `apply` below walks this list, so a third domain is a row
 * here and not a third package.
 *
 * The tools are named under a per-domain prefix because the Harness tool table
 * is one global layer and a duplicate name in it throws, so a Drawing tool and
 * a Mining tool cannot share one.
 */
export { VIEW_DOMAINS } from './domains.js'

/** The vendored view artifacts, beside this package's `lib/`. */
const VIEW_ROOT = resolve(fileURLToPath(new URL('../vendor', import.meta.url)))

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/** What this plugin's patch row may configure. */
export interface ViewPluginConfig {
  /**
   * Which domains to serve.  Absent or empty serves every domain in
   * `host/domains.ts`, which is what the shipped row asks for; naming a subset
   * is how a profile trims one away.
   */
  domains?: readonly string[]
  /** Directory holding the native editor and the modules beside it. */
  nativeBinDir?: string
  /** Directory holding the SHX fonts the native editor resolves through ACAD. */
  fontsDir?: string
}

interface SessionLike {
  get: (id: string) => { header?: { cwd?: string } } | undefined
}

/** The slice of the agent the announcer uses. */
interface AgentLike {
  inject(message: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: Record<string, unknown> }): void
}

/** The slice of `ctx.agents` this half uses. */
interface AgentsLike {
  get(id: string): AgentLike | undefined
}

export function apply(ctx: {
  effect: (fn: () => () => void) => unknown
  webServer: { register: (route: unknown) => () => void }
  inject?: (
    deps: readonly string[],
    fn: (scope: {
      sessions?: SessionLike
      agents?: AgentsLike
      profileContext?: { name?: string }
      tools?: { register: (definition: unknown) => unknown }
    }) => unknown,
  ) => unknown
}, config: ViewPluginConfig = {}): void {

  // One pass per domain. Every constant below was a module-level
  // singleton when this was one plugin per domain; inside the loop it is
  // the domain currently being served, which is what let the two halves
  // become one.
  for (const domain of selectedDomains(config.domains)) {
    const DOMAIN = domain.id
    const ROUTE = domain.route
    const TOOL_PREFIX = domain.toolPrefix
    // The names this domain's text may use. Passed rather than imported into
    // `tools.ts`, because that file is the same text for both domains and the
    // two do not publish the same tools -- see `ViewDomainTools`.
    const DOMAIN_TOOLS = { describeTool: domain.describeTool, openTool: domain.openTool }

    // Four services, each injected rather than declared in `inject`, because this
    // plugin must load on a carrier that has none of them -- it simply cannot do
    // the one thing each enables. `inject` itself is optional in the type above for
    // the same reason: the route table is worth being able to drive from a
    // twenty-line fake context, which is how this half is tested outside the
    // harness.
    let sessions: SessionLike | undefined
    ctx.inject?.(['sessions'], (scope) => {
      sessions = scope.sessions
      return () => {
        sessions = undefined
      }
    })

    let agents: AgentsLike | undefined
    ctx.inject?.(['agents'], (scope) => {
      agents = scope.agents
      return () => {
        agents = undefined
      }
    })

    // The carrier. The Web profile has no native editor to start on the user's
    // machine -- a server process cannot launch a program on somebody's laptop --
    // and the desktop shell can. The harness already distinguishes them (its own
    // base bundle reads `profileContext.name` for what it calls `desktopPlatform`)
    // and the page cannot see it, so the decision is made here, where the knowledge
    // is.
    let profileName: string | undefined
    ctx.inject?.(['profileContext'], (scope) => {
      profileName = scope.profileContext?.name
      return () => {
        profileName = undefined
      }
    })
    const nativeEnabled = (): boolean => profileName === 'desktop'

    const capabilities = new CapabilityRegistry()
    const browserDrawingQueries = new BrowserDrawingEntityQueryQueue()

    /**
     * The store, and what it does when something changes.
     *
     * The announcement is the only thing here that reaches outside the host half:
     * `agent.inject()` queues model-facing context for the session's NEXT request
     * and does not wake an idle agent. That is the whole reason a click on a
     * drawing cannot start a conversation, and the reason the injected text is a
     * summary rather than a dump.
     */
    const store = new ViewEventStore((state, summary) => {
      const agent = agents?.get(state.sessionId)
      if (agent === undefined) return
      try {
        agent.inject({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: summary }],
          // Merge-extensible in the harness's own vocabulary, and this is this
          // plugin's kind: a consumer that does not know it falls through, which is
          // what a plugin-declared source is for. `form: notice` is what makes the
          // row render as a one-line account rather than as something the user
          // appears to have typed.
          source: { kind: 'iam-view', form: 'notice', summary: `IAM 视图状态：${state.documentName || '未命名文档'}` },
        })
      } catch (error) {
        state.lastError = `无法把视图状态注入会话：${error instanceof Error ? error.message : String(error)}`
      }
    })

    const sessionRootOf: SessionRootLookup = sessionId => sessions?.get(sessionId)?.header?.cwd

    /**
     * The one place an address becomes a file, with the session lookup bound.
     *
     * Two routes call it -- the document read and the native launch -- and they
     * get the same four checks because they get the same function. A second
     * resolution written beside one of them would be a second answer to "is this
     * file inside the workspace", and the two would agree until the day they did
     * not.
     */
    const resolveForAddress = (address: string): AddressOutcome => resolveWorkspaceFile(sessionRootOf, address)

    const bridge = new NativeEditorBridge(DOMAIN, capabilities, store, config, (message) => {
      // A bridge failure has no session to attach itself to -- it happens between
      // sessions or before one -- so it goes to the process's own log rather than
      // into a record that would attribute it to the wrong conversation.
      process.stderr.write(`[${name}] ${message}\n`)
    })

    // The tools are registered from the same state the injected text comes from, so
    // an agent asking for "the selection" and an agent reading the injected summary
    // cannot see two different answers.
    ctx.inject?.(['tools'], (scope) => {
      const registry = scope.tools
      if (registry === undefined) return () => undefined
      const lookup = (exec: unknown) => stateForCall(exec)
      // The disposers are held and run on unload so that this plugin unregisters
      // exactly the two it registered. The registry's own effect would usually do
      // it, but "usually" is not what a shared global table can be built on: the
      // registrations are the one thing in this plugin that touch a table every
      // other plugin also writes to.
      const disposers = [
        registry.register(viewSelectionTool(lookup, TOOL_PREFIX, DOMAIN_TOOLS)),
        registry.register(viewRecentEditsTool(lookup, TOOL_PREFIX, DOMAIN_TOOLS)),
      ]
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') dispose()
        }
      }
    })

    ctx.effect(() => {
      const holder = globalThis as unknown as {
        __iamDrawingEntityQuery?: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
      }
      const queryActiveDrawingEntities = async (input: Record<string, unknown>, exec: unknown): Promise<unknown> => {
        const sessionId = (exec as { agent?: { id?: string } })?.agent?.id
        const state = sessionId ? store.activeFor(sessionId) : undefined
        if (!state) return { error: { code: 'no_view', message: '这个会话没有挂载图纸视图；请先打开预览，或使用 source=file。' } }
        const parameters = parseDrawingEntityQueryParameters(input)
        const signal = (exec as { signal?: AbortSignal })?.signal
        if (state.native.connected && (state.selection?.source === 'native' || !state.instanceId))
          return bridge.queryDrawingEntities(state.native.instanceId ?? '', parameters, signal)
        return browserDrawingQueries.enqueueForView(state.instanceId, parameters, signal)
      }
      if (DOMAIN === 'drawing') holder.__iamDrawingEntityQuery = queryActiveDrawingEntities
      const unregister = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          // A rejection here used to terminate the harness process; the route
          // answers or resets instead.
          void serve(req, res).catch(() => res.destroy())
        },
      })
      return () => {
        if (holder.__iamDrawingEntityQuery === queryActiveDrawingEntities) delete holder.__iamDrawingEntityQuery
        browserDrawingQueries.close()
        bridge.shutdown()
        store.dropAll()
        unregister()
      }
    })

    // Which session's state a tool call is about.
    //
    // The session, and not an argument: a tool runs inside one session and the view
    // state that session is looking at is the only one it could mean. The harness
    // hands the calling agent to `execute`, and an agent's id IS its session id.
    //
    // WHICH DOCUMENT is the most recently written record of that session, and the
    // others are NAMED in the answer rather than hidden: a session that has had two
    // documents open must be able to tell that the selection it is being shown is
    // not the one it asked about.
    function stateForCall(exec: unknown) {
      const agent = (exec as { agent?: { id?: string } } | undefined)?.agent
      if (agent?.id === undefined) {
        return { error: '这次调用不属于任何会话，因此没有可读的视图状态。' }
      }
      const state = store.activeFor(agent.id)
      if (state === undefined) {
        // The refusal is deliberate -- an empty selection and a session with no
        // view are different answers -- but it is also where a model that
        // reached for the wrong tool has to be able to turn around, so it names
        // the route that does read a document rather than only the one the user
        // would have to take.
        return {
          error: '这个会话还没有视图事件：视图类工具读的是屏幕上打开着的东西，没有挂载预览就无从回答。' +
            '要按文件内容工作（找工程里的对象、量距离）用 iam_mine_describe 读那个 .iam/.iamh；' +
            '要按用户当前的选择工作，请先在 Harness 中打开图纸预览。',
        }
      }
      const others = store
        .documentsOf(agent.id)
        .filter(other => other !== state)
        .map(other => ({ name: other.documentName || other.address, address: other.address }))
      return { state, others }
    }

    // ------------------------------------------------------------------ routes

    async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.slice(ROUTE.length)

      if (action.startsWith('/session/') || action === '/events' || action === '/status' ||
          action === '/document' || action.startsWith('/agent/') || action.startsWith('/native/') || action.startsWith('/drawing/')) {
        await route(req, res, url, action)
        return
      }
      await serveFile(res, url)
    }

    async function route(req: IncomingMessage, res: ServerResponse, url: URL, action: string): Promise<void> {
      try {
        switch (action) {
          case '/session/capability':
            return await handleCapability(req, res)
          case '/events':
            return await handleEvents(req, res)
          case '/status':
            return await handleStatus(req, res)
          case '/document':
            return await handleDocument(req, res, url)
          case '/drawing/query':
            return await handleBrowserDrawingEntityQuery(req, res)
          case '/agent/analyze':
            return await handleAnalyze(req, res)
          case '/native/capabilities':
            return sendJson(res, 200, nativeCapabilities())
          case '/native/launch':
            return await handleLaunch(req, res)
          case '/native/stop':
            return await handleNativeStop(req, res)
          default:
            return sendJson(res, 404, { error: `no such route: ${action}` })
        }
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    async function handleBrowserDrawingEntityQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (DOMAIN !== 'drawing') return sendJson(res, 400, { error: '这是 Mining 工程，不是图纸。' })
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['events'] })
      if (!binding || binding.kind !== 'page') return sendJson(res, 403, { error: 'a live page capability is required' })
      if (req.method === 'GET') return sendJson(res, 200, { request: browserDrawingQueries.takeNextForView(binding.instanceId) })
      if (req.method === 'DELETE') { browserDrawingQueries.disconnectView(binding.instanceId); return sendJson(res, 200, { ok: true }) }
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' })
      const body = await readJson(req, 64 * 1024 * 1024 + 8192)
      if (!body || typeof body.id !== 'string') return sendJson(res, 400, { error: 'invalid drawing query answer' })
      const accepted = browserDrawingQueries.completeForView(binding.instanceId, body.id, body.result)
      return sendJson(res, accepted ? 200 : 409, { ok: accepted })
    }

    /**
     * Whether this carrier has a native editor, and if not, WHICH refusal.
     *
     * A name and not a sentence: the page is the side that knows what language the
     * user is reading, and a host that answered here with Chinese prose put a
     * Chinese notice in an English pane.  See `shared/reasons.ts`.
     */
    function nativeCapabilities(): Record<string, unknown> {
      if (!nativeEnabled()) {
        return { available: false, code: 'desktopOnly' }
      }
      const availability = bridge.availability()
      return availability.available
        ? { available: true, domain: DOMAIN }
        : { available: false, code: availability.code, detail: availability.detail }
    }

    /**
     * The handshake the browser half performs before it may report anything.
     *
     * The address is the `dsh-resource://file/session/<id>/<path>` the preview was
     * handed, and the session it names is checked against the session store -- so a
     * token is only ever issued for a session this process actually has. What the
     * caller gets back is not a session id it could reuse: it is a token that says
     * "this document, in this session, for this purpose, until this time", and the
     * view INSTANCE it speaks for.
     *
     * A NEW INSTANCE EVERY TIME, and that is what makes a reloaded page's events
     * readable. The view numbers its events and its selections from 1 in whatever
     * process produced them, so a page that reloaded would otherwise mint the
     * `eventId`s the previous page already used -- and every one of them would be
     * dropped as a duplicate. The instance is also what lets this host REFUSE an
     * event from a view that has been replaced.
     */
    async function handleCapability(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const body = await readJson(req, 16 * 1024)
      if (body === null) return sendJson(res, 413, { error: 'the request body is too large or not JSON' })
      const address = typeof body.address === 'string' ? body.address : ''
      const sessionId = resourceAddressSession(address)
      if (sessionId === null) {
        return sendJson(res, 400, { error: 'the address does not name a session of this harness' })
      }
      if (sessions?.get(sessionId) === undefined) {
        return sendJson(res, 404, { error: 'no such session' })
      }
      // Resolved before a token is issued, so a preview of something outside the
      // workspace is refused at the handshake rather than at the first read.
      const resolved = resolveForAddress(address)
      if (isAddressFailure(resolved)) {
        return sendJson(res, 400, { error: resolved.error })
      }

      const documentName = basenameOf(address)
      // The token this one replaces, if the preview remounted on the same file.
      // Retired rather than left to expire: "which view is this session showing"
      // is answerable by the live token only while there is one, and an event
      // carrying the retired instance is refused from here on.
      capabilities.retire('page', sessionId, address)
      const previous = store.get(sessionId, address)?.instanceId
      if (previous) browserDrawingQueries.disconnectView(previous)
      const instance = store.openInstance({ kind: 'page', sessionId, address, documentName })
      const state = store.stateFor(sessionId, address)
      state.documentName = documentName
      const binding = capabilities.issue({
        kind: 'page',
        sessionId,
        resourceAddress: address,
        documentName,
        instanceId: instance.instanceId,
        purposes: ['events', 'status', 'native-launch'],
        expiresAt: Date.now() + CAPABILITY_TTL_MS,
        singleUse: false,
      })
      sendJson(res, 200, {
        token: binding.token,
        expiresAt: binding.expiresAt,
        sessionId,
        document: { name: documentName },
        instance: { id: instance.instanceId },
        schema: VIEW_EVENT_SCHEMA,
        limits: LIMITS,
      })
    }

    /**
     * The event intake.
     *
     * The capability decides everything: which session, which document, which view
     * INSTANCE, and whether the caller may write at all. Nothing in the body is
     * trusted for attribution -- a client that sent a session id would be a client
     * that could send somebody else's.
     *
     * THE THREE OUTCOMES ARE COUNTED APART. A duplicate is the protocol working
     * (a batch resent after an expired capability, a reconnect) and must NOT be
     * reported as a failure, or the status line cries wolf on every retry. A
     * refusal is the store declining an event, and that one has to be visible:
     * measured 2026-10-07, every event was being dropped by a check of the store's
     * and the only symptom was a count on screen that never moved.
     */
    async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['events'] })
      if (binding === null) {
        return sendJson(res, 403, { error: 'a valid capability is required' })
      }
      const body = await readJson(req, LIMITS.bodyBytes)
      if (body === null) return sendJson(res, 413, { error: 'the event body is too large or not JSON' })
      const events = Array.isArray(body.events) ? body.events.slice(0, LIMITS.eventsPerRequest) : null
      if (events === null) return sendJson(res, 400, { error: '"events" must be an array' })

      const state = store.stateFor(binding.sessionId, binding.resourceAddress)
      // What the client had to drop before it ever got here. Recorded rather than
      // ignored: a hole in the history that nobody mentions reads as "nothing
      // happened", and that is the one thing an agent must not be told.
      if (body.gaps !== null && typeof body.gaps === 'object') {
        store.recordGaps(state, body.gaps as Record<string, unknown>, 'wasm')
      }

      let accepted = 0
      let duplicates = 0
      let rejected = 0
      for (const raw of events) {
        const validation = validateViewEvent(raw, 'wasm')
        if ('error' in validation) {
          rejected += 1
          store.noteError(state, `预览事件被拒绝：${validation.error}`)
          continue
        }
        const outcome = store.ingest(binding, validation.event, 'wasm')
        if (outcome.status === 'stored') accepted += 1
        else if (outcome.status === 'duplicate') duplicates += 1
        else {
          rejected += 1
          store.noteError(state, `预览事件未被接纳：${outcome.reason ?? validation.event.eventId}`)
        }
      }
      sendJson(res, 200, { accepted, duplicates, rejected, status: statusOf(state) })
    }

    async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['status', 'events'] })
      if (binding === null) return sendJson(res, 403, { error: 'a valid capability is required' })
      const state = store.get(binding.sessionId, binding.resourceAddress)
      if (state === undefined) return sendJson(res, 200, { view: null, document: null, native: { connected: false } })
      sendJson(res, 200, statusOf(state))
    }

    /**
     * Start the standalone editor.
     *
     * The address is resolved through the same workspace-confined resolver the
     * document preview uses, and re-resolved at the last moment before the
     * `spawn()`: the file the editor is pointed at is a file in THIS session's
     * workspace, and the shortest available window is left between proving that
     * and using it. See `verifyWorkspaceFile` for why a launch cannot hold the
     * handle the way the read route does.
     */
    async function handleLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['native-launch', 'events'] })
      if (binding === null) return sendJson(res, 403, { error: 'a valid capability is required' })
      if (!nativeEnabled()) {
        // Named, not written: the pane is the side that knows the language, and
        // this is the refusal it wraps in "the native editor could not be
        // started".  See `shared/reasons.ts`.
        return sendJson(res, 403, { error: 'this carrier has no native editor', code: 'desktopOnlyLaunch' })
      }

      const body = await readJson(req, 16 * 1024)
      const mode = body?.mode === 'browse' ? 'browse' : 'edit'
      const address = typeof body?.address === 'string' && body.address.length > 0
        ? body.address
        : binding.resourceAddress
      if (typeof address !== 'string' || address.length === 0) {
        return sendJson(res, 400, { error: 'the launch names no document' })
      }
      // The address used for the capability binding and the one that was launched
      // have to be the same document, or the events the editor reports would be
      // filed against a file the session is not showing.
      if (resourceAddressSession(address) !== binding.sessionId) {
        return sendJson(res, 403, { error: 'the address names a different session' })
      }
      // Resolved again HERE, immediately before the spawn: `spawn()` takes a path
      // and cannot hold the handle a read can, so the window between proving the
      // file and using it is made as short as it can be.  See verifyWorkspaceFile.
      const filePath = verifyWorkspaceFile(sessionRootOf, address)
      if (isAddressFailure(filePath)) {
        return sendJson(res, 400, { error: filePath.error })
      }

      // The appearance the pane asked for, and only the two values the editor
      // understands: this arrives over HTTP from a page, and an editor started with
      // an arbitrary string in IAM_THEME would be an editor whose appearance
      // silently fell back.  Anything else is treated as "not stated", which is the
      // same as the pane having said nothing at all.
      const theme = body?.theme === 'light' || body?.theme === 'dark' ? body.theme : undefined
      const language = body?.language === 'zh' || body?.language === 'en' ? body.language : undefined

      const outcome = await bridge.launch({
        sessionId: binding.sessionId,
        resourceAddress: address,
        filePath: filePath.realPath,
        documentName: basenameOf(address),
        mode,
        theme,
        language,
      })
      // All three fields, because they are two different kinds of answer: `code`
      // is a refusal the pane will say in the user's language, `error` is the raw
      // text of one nobody anticipated.  A body with `code` set also carries a
      // fallback `error`, so a pane too old to know the name still says something.
      if (!outcome.ok) {
        // A document that is already open is not a failure of the carrier: 409
        // says "conflict with the current state".  It must NOT be 403, which the
        // pane reads as an expired capability, renews, and retries -- a second
        // attempt at the same duplicate.
        const status = outcome.code === 'alreadyOpen' ? 409 : 502
        return sendJson(res, status, {
          error: outcome.reason ?? 'the native editor did not start',
          code: outcome.code,
          detail: outcome.detail,
        })
      }
      sendJson(res, 200, {
        ok: true,
        pid: outcome.pid,
        instance: outcome.instanceId === undefined ? null : { id: outcome.instanceId },
        mode,
        document: { name: basenameOf(address), path: filePath.realPath },
      })
    }

    /**
     * The document's current bytes, for a refresh.
     *
     * The preview pane is handed the bytes once, at open, and keeps them; a file
     * the native editor has since written is not what the pane is showing, and this
     * is the only way back to it -- a page cannot read the harness's own resource
     * addresses.
     *
     * It goes through the workspace-confined resolver, and it HOLDS THE HANDLE it
     * proved: the bytes come from the file descriptor that was checked, so a
     * symlink or a rename between the check and the read cannot redirect them.
     */
    async function handleDocument(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['status', 'events'] })
      if (binding === null) return sendJson(res, 403, { error: 'a valid capability is required' })
      const address = url.searchParams.get('address') ?? binding.resourceAddress ?? ''
      if (resourceAddressSession(address) !== binding.sessionId) {
        return sendJson(res, 403, { error: 'the address names a different session' })
      }
      const opened = await openWorkspaceFile(sessionRootOf, address)
      if (isAddressFailure(opened)) return sendJson(res, 400, { error: opened.error })
      try {
        const bytes = await opened.handle.readFile()
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'cache-control': 'no-store',
        })
        res.end(bytes)
      } catch (error) {
        sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
      } finally {
        await opened.handle.close().catch(() => undefined)
      }
    }

    /**
     * The two actions that WAKE the agent, and the only things here that do.
     *
     * A selection change and an edit never call this: they inject context for the
     * session's next request and leave an idle agent alone. A user pressing
     * "让智能体分析当前选择" is asking for a turn, and `followup()` is the harness's
     * term for exactly that. The prompt is written here rather than by the page,
     * because the state it refers to is the host's.
     */
    async function handleAnalyze(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['events', 'status'] })
      if (binding === null) return sendJson(res, 403, { error: 'a valid capability is required' })
      const body = await readJson(req, 8 * 1024)
      const request = body?.request === 'edits' ? 'edits' : 'selection'
      // Both refusals are named for the same reason the launch's is: the pane puts
      // them into its own sentence, and it is the side that knows the language.
      const state = store.get(binding.sessionId, binding.resourceAddress)
      if (state === undefined) {
        return sendJson(res, 404, { error: 'this session has no view state', code: 'noViewState' })
      }
      const agent = agents?.get(binding.sessionId) as (AgentLike & { followup?: (message: unknown) => void }) | undefined
      const followup = (agent as { followup?: (message: unknown) => void } | undefined)?.followup
      if (agent === undefined || typeof followup !== 'function') {
        return sendJson(res, 409, { error: 'this session has no agent to wake', code: 'noAgent' })
      }
      const prompt = request === 'selection'
        ? `请分析 IAM 视图中当前选择的对象。先用 ${TOOL_PREFIX}_view_selection 读取完整选择集（必要时按版本和 offset 分页），再结合 ${TOOL_PREFIX}_view_recent_edits 判断这些对象最近是否被修改过，然后给出你的判断。`
        : `请检查 IAM 视图最近的修改。先用 ${TOOL_PREFIX}_view_recent_edits 读取已提交的编辑记录，必要时用 ${TOOL_PREFIX}_view_selection 查看当前选择，并指出其中值得注意或可能出错的地方。`
      followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${prompt}\n\n${describeState(state)}` }],
        source: { kind: 'iam-view', form: 'notice', summary: request === 'selection' ? '分析当前选择' : '检查最近修改' },
      })
      sendJson(res, 200, { ok: true, request })
    }

    async function handleNativeStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const binding = capabilities.verify(capabilityFrom(req), { purposes: ['native-launch', 'events'] })
      if (binding === null) return sendJson(res, 403, { error: 'a valid capability is required' })
      const stopped = bridge.stop(binding.sessionId)
      sendJson(res, 200, { ok: true, stopped })
    }

    /** What the viewer polls: the state, as the pane can show it. */
    function statusOf(state: ViewState): Record<string, unknown> {
      return {
        view: state.viewId || null,
        document: { name: state.documentName || null, address: state.address },
        instance: state.instanceId || null,
        selection: state.selection === null
          ? null
          : {
            version: state.selection.version,
            count: state.selection.count,
            /** Everything the view sent for this version has arrived. */
            complete: state.selection.complete,
            /** The view itself withheld references. */
            truncated: state.selection.truncated,
            /** How much of the set the host is holding right now. */
            reported: state.selection.reported,
            source: state.selection.source,
            at: state.selection.at,
          },
        edits: { total: state.edits.length, unsaved: unsavedCount(state) },
        lastSave: state.lastSave === null
          ? null
          : {
            path: state.lastSave.path, at: state.lastSave.at,
            source: state.lastSave.source, revision: state.lastSave.revision ?? null,
          },
        native: {
          connected: state.native.connected, pid: state.native.pid ?? null,
          available: nativeEnabled() && bridge.availability().available,
        },
        sources: { wasm: state.wasmSeen, native: state.native.connected },
        gaps: state.gaps === null
          ? null
          : {
            droppedFacts: state.gaps.droppedFacts,
            droppedByKind: state.gaps.droppedByKind,
            at: state.gaps.lastAt,
            source: state.gaps.source,
          },
        lastError: state.lastError,
        limits: LIMITS,
      }
    }

    /**
     * Serve one file from the vendored view directory.
     *
     * The resolved path is re-checked against the root rather than trusting the
     * `..` filter alone: `normalize` can still leave a path that escapes through a
     * symlink, and this route is reachable from the page.
     */
    async function serveFile(res: ServerResponse, url: URL): Promise<void> {
      let relative: string
      try {
        relative = decodeURIComponent(url.pathname.slice(ROUTE.length)) || '/'
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad request')
        return
      }
      const target = resolve(join(VIEW_ROOT, normalize(relative)))

      if (target !== VIEW_ROOT && !target.startsWith(VIEW_ROOT + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }

      try {
        const stat = await fs.stat(target)
        if (!stat.isFile()) throw new Error('not a file')
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(stat.size),
          // The browser half is rebuilt far more often than the view is; a stale
          // cached wasm is the one failure that looks like a broken engine.
          'cache-control': 'no-cache',
        })
        const stream = createReadStream(target)
        // The file can vanish or be replaced between stat() and open(); an
        // unhandled 'error' event would take the process down.
        stream.on('error', () => res.destroy())
        stream.pipe(res)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
      }
    }
  }
}

/** The whole body of a request, parsed, or null when it is too large or not JSON. */
async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    // Defensive rather than decorative: node:http hands over Buffers, but a
    // request stream that has been through anything else can yield strings, and
    // Buffer.concat() rejects a mixed list with a message about list[0] that says
    // nothing about the real cause.
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) return null
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) })
  res.end(text)
}
