import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DRAWING_ENTITY_QUERY_WIRE_SCHEMA, type DrawingEntityQueryParameters } from './drawing-entity-query.js'

// Type-only, so neither build resolves it: what the pane can be told, and
// nothing this process needs at run time.  See `shared/reasons.ts` for why the
// host answers with a name instead of the sentence it used to answer with.
import type { HostRefusal } from '../shared/reasons.js'
import {
  NATIVE_TOKEN_TTL_MS,
  VIEW_EVENT_SCHEMA,
  validateViewEvent,
  type CapabilityBinding,
  type CapabilityRegistry,
  type ViewEventStore,
  type ViewInstance,
} from './events.js'

/** One JSON object per line, and no line longer than this. */
const MAX_LINE_BYTES = 64 * 1024

/** How long a connection may take to present its token. */
const GREETING_TIMEOUT_MS = 10_000

/** The executable per domain, as `run.sh` names them. */
const EXECUTABLES = {
  drawing: 'IamDrawing',
  mining: 'IamMining',
} as const

export type NativeDomain = keyof typeof EXECUTABLES

/**
 * What one domain's editor is called on this platform.
 *
 * Windows resolves a program by its full name, extension included, so `.exe` is
 * added here rather than written into the table above: it is the only difference
 * between the two, and a second table would be a second thing to keep in step.
 */
function executableName(domain: NativeDomain): string {
  return process.platform === 'win32' ? `${EXECUTABLES[domain]}.exe` : EXECUTABLES[domain]
}

/** One live claim on a document, held by whichever launcher started its editor. */
interface EditorClaim {
  /** The process holding the document; absent only in the instant before a spawn fails. */
  readonly pid: number | undefined
}

/**
 * The one table both launchers consult: a document has at most ONE native window.
 *
 * WHY IT HANGS OFF `globalThis`. There are two launchers -- this one, for the
 * pane's buttons, and MiningRepository's, for `iam_mining_show` -- and the two
 * packages are installed independently, so neither may import the other. The
 * host loads both into one process, which is exactly the scope the rule needs:
 * the second launch, from either side, is the duplicate the user does not want.
 * The property name is the whole contract; the copies must spell it the same.
 *
 * THE KEY IS THE RESOLVED PATH, case-folded on Windows: the pane is handed a
 * `dsh-resource://` address while the tool resolves a project path, and both end
 * at one file. A claim is dropped when its process exits, and a claim whose pid
 * is no longer alive is treated as gone -- a window the user closed must not
 * make the document un-openable.
 */
interface ClaimHolder {
  __iamNativeEditorClaims?: Map<string, EditorClaim>
}

function claims(): Map<string, EditorClaim> {
  const holder = globalThis as unknown as ClaimHolder
  return holder.__iamNativeEditorClaims ?? (holder.__iamNativeEditorClaims = new Map())
}

function documentKey(filePath: string): string {
  let absolute = resolve(filePath)
  try {
    // The two launchers are handed differently spelled paths for the same file
    // (a verified real path here, a resolved project path from the tool). The
    // canonical path is what makes the claim mean the document, not the spelling.
    absolute = realpathSync.native(absolute)
  } catch {
    // A path that cannot be resolved cannot be opened either; the spawn reports it.
  }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function alive(pid: number): boolean {
  try {
    // Signal 0 delivers nothing; it only asks the OS whether the process exists.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The claim on a document, or null when there is none that is still alive. */
function heldBy(key: string): EditorClaim | null {
  const table = claims()
  const held = table.get(key)
  if (held === undefined) return null
  if (held.pid !== undefined && alive(held.pid)) return held
  // A stale claim is cleared rather than left to refuse a document nobody has open.
  table.delete(key)
  return null
}

/** Drop a claim only if it is still the one this editor took. */
function releaseClaim(key: string, claim: EditorClaim): void {
  const table = claims()
  if (table.get(key) === claim) table.delete(key)
}

/**
 * The variables that put the editor's own directory in front of its loader.
 *
 * Three names, because there are three desktops and only two of them are a
 * variable holding a list. `LD_LIBRARY_PATH` and `DYLD_LIBRARY_PATH` are the
 * POSIX pair and take a ':'-joined one; Windows has no loader variable at all --
 * it finds a DLL by walking `PATH` -- so there the directory is prepended to
 * that, with a ';'. Which is why the join cannot be shared either.
 */
function moduleSearchPath(binDir: string): Record<string, string> {
  if (process.platform === 'win32') {
    return { PATH: [binDir, process.env.PATH].filter(Boolean).join(';') }
  }
  return {
    LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    DYLD_LIBRARY_PATH: [binDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
  }
}

/** Where the native editor and its runtime are, as this deployment has them. */
export interface NativeEditorPaths {
  /** Directory holding the executable and the shared modules beside it. */
  binDir: string
  /** Directory holding the SHX fonts the view resolves through `ACAD`. */
  fontsDir: string
}

/**
 * The paths, from configuration and then from the environment.
 *
 * THERE IS NO BUILT-IN DEFAULT, and its absence is the point: a default would be
 * one developer's `build/bin/linux-native`, which is exactly the hardcoded
 * absolute path this must not have. A deployment that does not say where its
 * native editor is gets an explanation instead of a launch that fails in a way
 * nobody can read.
 */
export function nativeEditorPaths(config: { nativeBinDir?: string; fontsDir?: string }): NativeEditorPaths | HostRefusal {
  // WINDOWS USED TO BE REFUSED HERE, and the reason was the editor's half of the
  // event transport: it was compiled out there, so the program would have drawn
  // and reported nothing -- a record that looks empty rather than one that says
  // it is unavailable. The bridge has a Winsock implementation now
  // (IamEventBridge.cpp) and the same two verification programs build and run
  // on Windows, so there is no longer anything to refuse.
  const binDir = config.nativeBinDir ?? process.env.IAM_NATIVE_DIR
  if (typeof binDir !== 'string' || binDir.length === 0) {
    return { code: 'noBinDir' }
  }
  const fontsDir = config.fontsDir ?? process.env.IAM_FONTS_DIR ?? process.env.ACAD
  if (typeof fontsDir !== 'string' || fontsDir.length === 0) {
    return { code: 'noFontsDir' }
  }
  return { binDir, fontsDir }
}

/**
 * What a launch answers, whether it succeeded or not.
 *
 * A failure says WHY in one of two ways, and the difference is who can phrase
 * it. `code` and `detail` are a refusal the pane translates; `reason` is raw
 * text for the failures nobody anticipated -- a `spawn()` errno, a throw from
 * Node -- which the pane shows as it stands, because a diagnostic the user
 * cannot read is still worth more than one nobody wrote down.
 */
export interface LaunchOutcome extends Partial<HostRefusal> {
  ok: boolean
  pid?: number
  instanceId?: string
  reason?: string
}

/** One live native editor this host started, and the socket it reports over. */
interface NativeChild {
  domain: NativeDomain
  sessionId: string
  address: string
  instanceId: string
  documentName: string
  pid: number
  process: ChildProcess
  launchedAt: number
  socket: Socket | null
  /** The document this editor holds, and the claim that says so. */
  claimKey: string
  claim: EditorClaim
  /**
   * The launch token, held so that the process's exit can retire it. A token
   * whose process is gone authorises nothing, and leaving it live for the rest
   * of its two minutes would be leaving a credential in a process listing that
   * still works.
   */
  token: string
}

interface PendingNativeDrawingEntityQuery {
  socket: Socket
  viewInstanceId: string
  maximumResultBytes: number
  finishQuery: (result: unknown) => void
}

/**
 * The native side: the launcher, the listener and the per-connection state.
 *
 * One instance per plugin. The listener is created on the first launch and lives
 * until the plugin is disposed, so a user who closes an editor and opens another
 * pays nothing for the first one.
 */
export class NativeEditorBridge {
  private server: Server | null = null
  private port = 0
  private readonly children = new Map<number, NativeChild>()
  private readonly sockets = new Set<Socket>()
  private readonly drawingQuerySocketsByViewId = new Map<string, Socket>()
  private readonly pendingDrawingQueriesByRequestId = new Map<string, PendingNativeDrawingEntityQuery>()

  constructor(
    private readonly domain: NativeDomain,
    private readonly capabilities: CapabilityRegistry,
    private readonly store: ViewEventStore,
    private readonly config: { nativeBinDir?: string; fontsDir?: string },
    private readonly report: (message: string) => void,
  ) {}

  queryDrawingEntities(
    viewInstanceId: string, parameters: DrawingEntityQueryParameters, signal?: AbortSignal,
  ): Promise<unknown> {
    const socket = this.drawingQuerySocketsByViewId.get(viewInstanceId)
    if (!socket || socket.destroyed)
      return Promise.resolve({ error: { code: 'no_view', message: '原生图纸视图没有连接；请重新打开视图。' } })
    if (this.pendingDrawingQueriesByRequestId.size >= 32) throw new Error('drawing query queue is full')
    return new Promise((resolve) => {
      const requestId = randomUUID()
      const finishQuery = (result: unknown): void => {
        clearTimeout(responseTimeout)
        signal?.removeEventListener('abort', cancelQuery)
        this.pendingDrawingQueriesByRequestId.delete(requestId)
        resolve(result)
      }
      const cancelQuery = (): void => finishQuery({ error: { code: 'cancelled', message: '图元查询已取消。' } })
      const responseTimeout = setTimeout(() => finishQuery({ error: { code: 'view_unresponsive', message: '原生视图在 30 秒内没有回答；请确认视图仍打开。' } }), 30_000)
      this.pendingDrawingQueriesByRequestId.set(requestId, {
        socket, viewInstanceId, maximumResultBytes: parameters.max_bytes, finishQuery,
      })
      signal?.addEventListener('abort', cancelQuery, { once: true })
      if (signal?.aborted) { cancelQuery(); return }
      socket.write(JSON.stringify({
        schema: DRAWING_ENTITY_QUERY_WIRE_SCHEMA, kind: 'drawing.query', id: requestId, args: parameters,
      }) + '\n')
    })
  }

  /** Whether this deployment can start a native editor at all, and which refusal when it cannot. */
  availability(): { available: boolean } & Partial<HostRefusal> {
    const paths = nativeEditorPaths(this.config)
    if ('code' in paths) return { available: false, code: paths.code, detail: paths.detail }
    const executable = join(paths.binDir, executableName(this.domain))
    if (!existsSync(executable)) {
      return { available: false, code: 'noExecutable', detail: executable }
    }
    return { available: true }
  }

  /**
   * Start one editor on one file.
   *
   * The token is minted BEFORE the process is spawned and is bound to the session,
   * the document and a fresh view instance, so the connection that presents it
   * cannot be about anything else. It is `singleUse`, which is what makes a leaked
   * command line worth nothing after the first connect.
   */
  async launch(options: {
    sessionId: string
    resourceAddress: string
    filePath: string
    documentName: string
    mode: 'browse' | 'edit'
    /** The resolved appearance the pane is showing, or undefined to let the editor decide. */
    theme?: 'light' | 'dark'
    /** The active language, or undefined to let the editor fall back to the system locale. */
    language?: string
  }): Promise<LaunchOutcome> {
    const paths = nativeEditorPaths(this.config)
    if ('code' in paths) return { ok: false, code: paths.code, detail: paths.detail }

    const executable = join(paths.binDir, executableName(this.domain))
    if (!existsSync(executable)) {
      return { ok: false, code: 'noExecutable', detail: executable }
    }

    // Checked before the listener is created and before a capability is minted:
    // a second click on a document that is already up costs a refusal and
    // nothing else.
    const claimKey = documentKey(options.filePath)
    if (heldBy(claimKey) !== null) {
      return { ok: false, code: 'alreadyOpen', reason: 'this document is already open in the native editor' }
    }

    const server = await this.ensureServer()
    if (server === null) return { ok: false, code: 'noEventPort' }

    const instance = this.store.openInstance({
      kind: 'native',
      sessionId: options.sessionId,
      address: options.resourceAddress,
      documentName: options.documentName,
    })

    const binding = this.capabilities.issue({
      kind: 'native',
      sessionId: options.sessionId,
      resourceAddress: options.resourceAddress,
      documentName: options.documentName,
      instanceId: instance.instanceId,
      purposes: ['events'],
      expiresAt: Date.now() + NATIVE_TOKEN_TTL_MS,
      singleUse: true,
    })

    // An argument array and never a command line: the file name is the user's and
    // a shell would read a space as an argument boundary and a semicolon as a
    // command separator.
    const argv = [
      options.mode === 'edit' ? '--editable' : '--browse',
      options.filePath,
      '--iam-ipc',
      String(this.port),
      '--iam-token',
      binding.token,
    ]

    let child: ChildProcess
    try {
      child = spawn(executable, argv, {
        // `shell: false` is the default and is written out because it is the
        // property the argument array exists for.
        shell: false,
        detached: false,
        stdio: 'ignore',
        // A console window is not something a preview pane should flash on the
        // way to opening an editor; `stdio: 'ignore'` above has already given up
        // anything it would have shown.
        windowsHide: true,
        env: {
          ...process.env,
          // The editor finds its modules beside itself, exactly as `run.sh` sets
          // it up; and its SHX fonts through `ACAD`, which is the variable
          // IamNativeStart reads.
          ...moduleSearchPath(paths.binDir),
          ACAD: paths.fontsDir,
          // The appearance the pane is in, in the two variables the editor reads
          // before anything else (IamTheme.cpp / IamText.cpp).  Set only
          // when the pane named one: an editor started with neither falls back to
          // the desktop and the system locale, and writing the pane's guess into
          // the environment would turn a live preference into a fixed one.
          //
          // These duplicate the parent's environment when the harness itself was
          // launched with them set, which is harmless -- a value equal to the one
          // it overrides.
          ...(options.theme === undefined ? {} : { IAM_THEME: options.theme }),
          ...(options.language === undefined ? {} : { IAM_LANGUAGE: options.language }),
        },
      })
    } catch (error) {
      this.capabilities.release(binding.token)
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }

    const pid = child.pid
    if (pid === undefined) {
      this.capabilities.release(binding.token)
      return { ok: false, code: 'notStarted' }
    }

    // The claim is taken only once there is a pid to hold it: a spawn that
    // reported none has no window to protect.
    const claim: EditorClaim = { pid }
    claims().set(claimKey, claim)

    const entry: NativeChild = {
      domain: this.domain,
      sessionId: options.sessionId,
      address: options.resourceAddress,
      instanceId: instance.instanceId,
      documentName: options.documentName,
      pid,
      process: child,
      launchedAt: Date.now(),
      socket: null,
      token: binding.token,
      claimKey,
      claim,
    }
    this.children.set(pid, entry)
    child.on('exit', () => this.forget(entry))
    child.on('error', (error: Error) => {
      this.report(`原生编辑器进程出错：${error.message}`)
      this.forget(entry)
    })

    return { ok: true, pid, instanceId: instance.instanceId }
  }

  /** Stop the editor this session started, if any. */
  stop(sessionId: string): boolean {
    let stopped = false
    for (const [pid, entry] of this.children) {
      if (entry.sessionId !== sessionId) continue
      try {
        // No signal named, and that is the portable choice rather than an
        // omission: POSIX defaults to SIGTERM and Windows has no signals at all,
        // ending the process outright. Naming SIGTERM would suggest a courtesy
        // the Windows editor cannot be offered -- and neither desktop's editor
        // installs a handler for one anyway.
        entry.process.kill()
      } catch {
        // The process is going away either way; a failed kill must not stop the
        // bookkeeping below.
      }
      this.children.delete(pid)
      // Released here as well as from the exit listener: the kill is synchronous
      // on Windows, and a user who closes the editor and reopens the document
      // should not meet a claim that is still on its way out.
      releaseClaim(entry.claimKey, entry.claim)
      stopped = true
    }
    const state = this.store.activeFor(sessionId)
    if (state !== undefined) state.native = { connected: false }
    return stopped
  }

  /** Release everything this bridge owns. Called when the plugin is disposed. */
  shutdown(): void {
    for (const [, entry] of this.children) {
      try {
        entry.process.kill()
      } catch {
        // Disposal is best-effort by definition.
      }
      releaseClaim(entry.claimKey, entry.claim)
    }
    this.children.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    this.port = 0
  }

  /**
   * One process is gone: forget it, and say so on the record if it was the one
   * that record was describing.
   *
   * `socket` is dropped with it, and that is not tidiness: an event that arrives
   * on a connection whose process has exited would be filed against a document
   * with no editor, and the record would then claim a native editor was live.
   */
  private forget(entry: NativeChild): void {
    this.children.delete(entry.pid)
    // The document is openable again the moment its editor is gone, which is
    // what makes "one window per document" a rule about openings, not a lock.
    releaseClaim(entry.claimKey, entry.claim)
    // The token is retired with the process it was minted for, so a command line
    // still visible in a process listing is worth nothing.
    this.capabilities.release(entry.token)
    if (entry.socket !== null) {
      this.sockets.delete(entry.socket)
      entry.socket = null
    }
    const state = this.store.get(entry.sessionId, entry.address)
    if (state !== undefined && state.native.pid === entry.pid) {
      state.native = { connected: false }
    }
  }

  /** The listener, created once and kept. */
  private ensureServer(): Promise<Server | null> {
    if (this.server !== null) return Promise.resolve(this.server)
    return new Promise<Server | null>((resolve) => {
      const server = createServer(socket => this.accept(socket))
      server.on('error', (error: Error) => {
        this.report(`事件端口不可用：${error.message}`)
        resolve(null)
      })
      // Loopback only. The editor is on this machine by construction -- this host
      // started it -- and a listener on every interface would be one the user did
      // not ask for.
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          resolve(null)
          return
        }
        this.server = server
        this.port = address.port
        resolve(server)
      })
    })
  }

  /**
   * One connection: its greeting first, then one event per line.
   *
   * Nothing is read as an event until the token in the greeting has been verified
   * against this host's own registry, so an unauthenticated socket can say
   * anything it likes and reach nothing.
   */
  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    let bound: { binding: CapabilityBinding; instance: ViewInstance; child?: NativeChild } | null = null

    const greetingTimer = setTimeout(() => {
      if (bound === null) socket.destroy()
    }, GREETING_TIMEOUT_MS)
    greetingTimer.unref?.()

    const fail = (reason: string): void => {
      this.report(`原生编辑器的事件连接被拒绝：${reason}`)
      socket.destroy()
    }

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      // A cancelled request may still be sending its bounded result. Keep the
      // authenticated framing bound independent of the pending-request table.
      const queryBound = bound === null ? MAX_LINE_BYTES : 64 * 1024 * 1024 + 8192
      if (buffer.length > queryBound * 2) {
        // A peer that never sends a newline is not speaking this protocol.
        fail('收到的数据没有按行分隔。')
        return
      }
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length === 0) continue

        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          fail('事件不是合法的 JSON。')
          return
        }

        if (bound === null) {
          const hello = parsed as { schema?: unknown; kind?: unknown; token?: unknown }
          if (hello.kind !== 'hello' || hello.schema !== VIEW_EVENT_SCHEMA) {
            fail('连接的第一行不是本协议的握手。')
            return
          }
          const binding = this.capabilities.verify(
            typeof hello.token === 'string' ? hello.token : null,
            { purposes: ['events'], consume: true },
          )
          const instance = binding === null ? undefined : this.store.instance(binding.instanceId)
          if (binding === null || instance === undefined) {
            // Covers every way a token can be wrong at once -- forged, expired,
            // spent, or for a session this host never issued one to -- and says
            // only that, because the reason a token failed is not something a
            // caller is entitled to narrow down.
            fail('令牌无效、已过期或已被使用。')
            return
          }
          clearTimeout(greetingTimer)
          const child = this.childForInstance(instance.instanceId)
          bound = { binding, instance, ...(child === undefined ? {} : { child }) }
          this.drawingQuerySocketsByViewId.set(instance.instanceId, socket)
          const state = this.store.stateFor(binding.sessionId, binding.resourceAddress)
          state.documentName = binding.documentName
          state.native = {
            connected: true,
            ...(child === undefined ? {} : { pid: child.pid }),
            launchedAt: Date.now(),
            documentName: binding.documentName,
            instanceId: instance.instanceId,
          }
          state.lastTouchedAt = Date.now()
          if (child !== undefined) child.socket = socket
          continue
        }

        const queryReply = parsed as { schema?: unknown; kind?: unknown; id?: unknown; result?: unknown }
        if (queryReply.kind === 'drawing.result' && queryReply.schema === DRAWING_ENTITY_QUERY_WIRE_SCHEMA) {
          const pendingQuery = typeof queryReply.id === 'string'
            ? this.pendingDrawingQueriesByRequestId.get(queryReply.id) : undefined
          if (pendingQuery && pendingQuery.socket === socket && pendingQuery.viewInstanceId === bound.instance.instanceId) {
            if (Buffer.byteLength(JSON.stringify(queryReply.result) ?? '') > pendingQuery.maximumResultBytes)
              pendingQuery.finishQuery({ error: { code: 'result_too_large', message: '原生图元查询回答超过 max_bytes。' } })
            else pendingQuery.finishQuery(queryReply.result)
          }
          continue
        }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail('事件超过单行大小上限。'); return }

        const validation = validateViewEvent(parsed, 'native')
        if ('error' in validation) {
          // One malformed event does not end the connection: the editor is running
          // and reporting, and the next line may be perfectly good. It IS recorded,
          // because a stream of them is the only symptom a version mismatch has.
          this.store.noteError(
            this.store.stateFor(bound.binding.sessionId, bound.binding.resourceAddress),
            `原生事件被拒绝：${validation.error}`,
          )
          continue
        }
        const outcome = this.store.ingest(bound.binding, validation.event, 'native')
        if (outcome.status === 'refused' || outcome.status === 'superseded') {
          this.store.noteError(
            this.store.stateFor(bound.binding.sessionId, bound.binding.resourceAddress),
            `原生事件未被接纳：${outcome.reason ?? validation.event.eventId}`,
          )
        }
      }
    })

    const release = (): void => {
      clearTimeout(greetingTimer)
      this.sockets.delete(socket)
      for (const [viewInstanceId, viewSocket] of this.drawingQuerySocketsByViewId)
        if (viewSocket === socket) this.drawingQuerySocketsByViewId.delete(viewInstanceId)
      for (const pendingQuery of [...this.pendingDrawingQueriesByRequestId.values()])
        if (pendingQuery.socket === socket)
          pendingQuery.finishQuery({ error: { code: 'no_view', message: '原生视图已断开连接。' } })
      if (bound !== null) {
        const state = this.store.get(bound.binding.sessionId, bound.binding.resourceAddress)
        // Only if this connection is still the live one for that instance: a
        // second connection presenting a spent token cannot mark a running
        // editor down.
        if (state !== undefined && state.native.instanceId === bound.instance.instanceId) {
          state.native = { connected: false }
        }
      }
    }
    socket.on('close', release)
    socket.on('error', release)
  }

  private childForInstance(instanceId: string): NativeChild | undefined {
    for (const [, entry] of this.children) {
      if (entry.instanceId === instanceId) return entry
    }
    return undefined
  }
}
