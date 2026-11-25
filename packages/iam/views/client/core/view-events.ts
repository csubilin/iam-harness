export const EVENT_CHANNEL = 'iam-view-event'

/** How many events one POST may carry. Must not exceed the host's own limit. */
const FLUSH_MAX = 32

/** How long an event may sit in the queue before it is sent. */
const FLUSH_INTERVAL_MS = 250

/** How many queued events are kept before the oldest is dropped and counted. */
const QUEUE_MAX = 128

/** Attempts made at the fast cadence before the bridge settles into a slow retry. */
const FAST_ATTEMPTS = 6

/** The first backoff, doubled per attempt. */
const RETRY_BASE_MS = 250

/** How long a batch waits between attempts once the fast ones are spent. */
const SLOW_RETRY_MS = 15_000

/** The schema this bridge understands. A payload carrying another is refused. */
const EXPECTED_SCHEMA = 'iax.iam.view-event/1'

export interface ViewEventEnvelope {
  schema?: unknown
  eventId?: unknown
  kind?: unknown
}

/** What the host answers a capability request with. */
interface CapabilityAnswer {
  token: string
  expiresAt: number
  sessionId: string
  document: { name: string }
  instance?: { id: string }
  schema: string
}

/** One event the bridge decided to forward. */
type QueuedEvent = Record<string, unknown>

/** What could not be delivered, in the shape the host records. */
interface DroppedTally {
  droppedFacts: number
  droppedByKind: Record<string, number>
  firstAt: number
  lastAt: number
}

import type { Translate } from './embedded-view'
import { readAppearance } from './appearance'
import { queryWasmDrawingEntities } from './wasm-drawing-entity-query'
import type { DrawingEntityQueryRequest } from '../../host/drawing-entity-query'
// Type-only, like the rest of this file's imports of the host's vocabulary: the
// names a refusal may carry, and nothing to load at run time.  See
// `shared/reasons.ts` for why the host names a reason rather than writing the
// sentence, and `locales.ts` for the table that turns one back into words.
import type { HostRefusal } from '../../shared/reasons'

/**
 * What a POST answers.
 *
 * A failure is one of two things and this carries both, because the caller is
 * the side that knows which to show: `code` is a refusal the pane has words for,
 * `reason` is raw text from a failure nobody wrote a name for -- a blocked
 * route, an errno, a throw. A `reason` is always present, so a pane that does
 * not recognise the code still says something.
 */
type PostAnswer = { ok: boolean; reason?: string } & Partial<HostRefusal>

export interface ViewEventBridgeOptions {
  enableDrawingEntityQueries?: boolean
  /** The route prefix the host half registered. */
  route: string
  /**
   * The `dsh-resource://` address of the open document.
   *
   * Named as the harness names it, because the viewer is handed the same value
   * under this name and the two ends of one constructor call are exactly where a
   * shorter spelling goes wrong.  Measured 2026-10-07: this field was called
   * `address` while every caller passed `resourceAddress`, so it was always
   * undefined, the capability request went out as `{}` and the host answered 400
   * -- which took the event channel and the status line with it for as long as
   * the mismatch existed.
   */
  resourceAddress: string
  /** The container element holding the view's iframe. */
  frame: () => HTMLIFrameElement | null
  /** Report a human-readable status or failure in the pane. */
  report: (message: string, kind?: 'status' | 'failure') => void
  /**
   * The pane's translator.
   *
   * This class reports failures the user reads, and it is not a component, so it
   * cannot be handed the `t` the slot machinery synthesizes -- the pane's own
   * binding is passed down instead. Structural rather than imported for the
   * reason the whole client bundle is: only the seed table resolves.
   */
  t: Translate
}

/** The version and offset of a selection event, defaulting as the schema does. */
function selectionPage(event: QueuedEvent): { version: number; offset: number } {
  const selection = event.selection as { version?: unknown; offset?: unknown } | undefined
  return {
    version: typeof selection?.version === 'number' ? selection.version : 0,
    offset: typeof selection?.offset === 'number' ? selection.offset : 0,
  }
}

export class ViewEventBridge {
  private capability: CapabilityAnswer | null = null
  private readonly queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private drawingQueryPollTimer: ReturnType<typeof setInterval> | null = null
  private drawingQueryInFlight = false
  private readonly onMessage: (event: MessageEvent) => void
  private disposed = false
  private flushing = false
  /** Events admitted from the view, ever. A positive signal for a startup watchdog. */
  private received = 0
  /** Consecutive failed attempts at the batch in hand. */
  private attempts = 0
  /** Before this moment, `flush()` does nothing: the backoff. */
  private nextAttemptAt = 0
  /** What had to be dropped, waiting for a batch that gets through to carry it. */
  private dropped: DroppedTally | null = null
  /** How many events one flush may take, halved when the host refuses a batch. */
  private batchLimit = FLUSH_MAX

  constructor(private readonly options: ViewEventBridgeOptions) {
    this.onMessage = (event: MessageEvent) => this.receive(event)
    // `window`, and not the iframe: the shell posts to its PARENT, which is this
    // window, so this is the listener that hears it.
    window.addEventListener('message', this.onMessage)
  }

  /** Ask for a capability and start flushing. Failure is reported, not thrown. */
  async start(): Promise<void> {
    try {
      this.capability = await this.requestCapability()
    } catch (error) {
      this.options.report(
        this.options.t('channelNotEstablished',
          { reason: error instanceof Error ? error.message : String(error) }),
        'failure',
      )
      return
    }
    this.timer ??= setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    if (this.options.enableDrawingEntityQueries)
      this.drawingQueryPollTimer ??= setInterval(() => void this.pollBrowserDrawingEntityQuery(), 500)
  }

  /**
   * A NEW capability, and so a new view instance -- for a view that was replaced.
   *
   * Called when the pane remounts the embedded view: the page that comes back
   * numbers its events and its selections from 1 again, and without a new
   * instance id the host would read every one of them as a duplicate of the page
   * that has just gone. What is queued is kept: those events happened, and the
   * host files them under the instance that replaces the one they came from.
   */
  async rehandshake(): Promise<void> {
    if (this.disposed) return
    try {
      this.capability = await this.requestCapability()
    } catch (error) {
      // The old capability, if it is still live, is better than nothing: the
      // flush below will find out whether it is.
      this.options.report(
        this.options.t('channelNotRestored',
          { reason: error instanceof Error ? error.message : String(error) }),
        'failure',
      )
      return
    }
    this.attempts = 0
    this.nextAttemptAt = 0
  }

  dispose(): void {
    this.disposed = true
    if (this.options.enableDrawingEntityQueries && this.capability)
      void fetch(`${this.options.route}/drawing/query`, {
        method: 'DELETE', headers: { 'x-iam-capability': this.capability.token }, keepalive: true,
      }).catch(() => undefined)
    window.removeEventListener('message', this.onMessage)
    if (this.timer !== null) clearInterval(this.timer)
    if (this.drawingQueryPollTimer !== null) clearInterval(this.drawingQueryPollTimer)
    this.drawingQueryPollTimer = null
    this.timer = null
    this.queue.length = 0
  }

  /**
   * Send everything queued, now, and answer when the attempt is over.
   *
   * For the two moments the pane is about to throw the view away -- a refresh,
   * a mode switch that has to remount -- because the queue belongs to this side
   * and outlives the page. Events sent after the remount would be attributed to
   * the instance that replaced the one that produced them.
   */
  async flushNow(): Promise<void> {
    this.nextAttemptAt = 0
    await this.flush()
  }

  /** The session's state as the host last answered, for the pane's status line. */
  async status(): Promise<Record<string, unknown> | null> {
    return this.withCapability(async (capability) => {
      const response = await fetch(`${this.options.route}/status`, {
        headers: { 'x-iam-capability': capability.token, accept: 'application/json' },
      })
      if (!response.ok) return null
      return (await response.json()) as Record<string, unknown>
    }, null)
  }

  /**
   * Ask the agent about this view, because the user pressed a button.
   *
   * This is the ONE path here that wakes an agent, and it is a route the user has
   * to press: a selection change never does. The distinction is the whole reason
   * the analyse actions are buttons rather than automatic.
   */
  async wake(request: 'selection' | 'edits'): Promise<{ ok: boolean; reason?: string }> {
    return this.post('/agent/analyze', { request }, this.options.t('channelCannotWakeAgent'))
  }

  /** Start the standalone native editor; the host owns everything about it. */
  async launchNative(mode: 'browse' | 'edit'): Promise<PostAnswer> {
    // The appearance travels WITH the request, because the launched editor cannot
    // ask for it: it is a separate process with no access to this page, and the
    // harness's settings are not on its disk.  The host turns the two fields into
    // the editor's own `IAM_THEME` / `IAM_LANGUAGE`, which is how every
    // other thing that starts that program configures it.
    //
    // Read at the moment of the click rather than captured at construction: a
    // user who switched to Light and then opened the native editor should get a
    // light editor.
    return this.post('/native/launch',
      { address: this.options.resourceAddress, mode, ...readAppearance() },
      this.options.t('channelCannotLaunch'))
  }

  /** Whether this carrier has a native editor to offer, and why not when it does not. */
  async nativeCapability(): Promise<{ available: boolean } & Partial<HostRefusal>> {
    try {
      const response = await fetch(`${this.options.route}/native/capabilities`, { headers: { accept: 'application/json' } })
      if (!response.ok) return { available: false, reason: `answered ${response.status}` }
      return (await response.json()) as { available: boolean } & Partial<HostRefusal>
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'host route unreachable' }
    }
  }

  /** A POST that needs a capability, with one renewal and one retry on a 403. */
  private async post(path: string, body: unknown, missing: string): Promise<PostAnswer> {
    const send = async (capability: CapabilityAnswer): Promise<PostAnswer & { expired?: boolean }> => {
      const response = await fetch(`${this.options.route}${path}`, {
        method: 'POST',
        headers: { 'x-iam-capability': capability.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.ok) return { ok: true }
      const answer = (await response.json().catch(() => ({}))) as { error?: string } & Partial<HostRefusal>
      if (response.status === 403) return { ok: false, expired: true }
      return {
        ok: false,
        reason: answer.error ?? `answered ${response.status}`,
        code: answer.code,
        detail: answer.detail,
      }
    }

    const capability = this.capability ?? (await this.requestCapability().catch(() => null))
    if (capability === null) return { ok: false, reason: missing }
    try {
      const first = await send(capability)
      if (first.ok || first.expired !== true) {
        // The refusal travels whole: dropping `code` here would turn every
        // translated failure into the host's raw English fallback.
        return first.ok ? { ok: true } : { ok: false, reason: first.reason, code: first.code, detail: first.detail }
      }
      // Thirty minutes is a long time for a tab to sit open, and the token
      // expiring is the ordinary way that ends. One renewal, one retry.
      this.capability = await this.requestCapability()
      const second = await send(this.capability)
      return second.ok
        ? { ok: true }
        : { ok: false, reason: second.reason ?? missing, code: second.code, detail: second.detail }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Run something that needs a capability, answering the fallback on any failure. */
  private async withCapability<T>(fn: (capability: CapabilityAnswer) => Promise<T>, fallback: T): Promise<T> {
    const capability = this.capability ?? (await this.requestCapability().catch(() => null))
    if (capability === null) return fallback
    try {
      return await fn(capability)
    } catch {
      return fallback
    }
  }

  private async pollBrowserDrawingEntityQuery(): Promise<void> {
    if (this.disposed || this.drawingQueryInFlight || !this.capability) return
    this.drawingQueryInFlight = true
    const capability = this.capability
    try {
      const response = await fetch(`${this.options.route}/drawing/query`, {
        headers: { 'x-iam-capability': capability.token },
      })
      if (response.status === 403) { this.capability = await this.requestCapability(); return }
      if (!response.ok) return
      const { request: queryRequest } = await response.json() as { request?: DrawingEntityQueryRequest | null }
      if (!queryRequest || this.disposed) return
      let queryResult: unknown
      try { queryResult = await queryWasmDrawingEntities(this.options.frame(), queryRequest.args) }
      catch (error) { queryResult = { error: { code: 'query_failed', message: error instanceof Error ? error.message : String(error) } } }
      await fetch(`${this.options.route}/drawing/query`, {
        method: 'POST', headers: { 'x-iam-capability': capability.token, 'content-type': 'application/json' },
        body: JSON.stringify({ id: queryRequest.id, result: queryResult }),
      })
    } catch { /* The host timeout reports a disconnected view to the tool caller. */ }
    finally { this.drawingQueryInFlight = false }
  }

  private async requestCapability(): Promise<CapabilityAnswer> {
    const response = await fetch(`${this.options.route}/session/capability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: this.options.resourceAddress }),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new Error(`answered ${response.status}${detail.length > 0 ? `: ${detail}` : ''}`)
    }
    const answer = (await response.json()) as CapabilityAnswer
    if (typeof answer.token !== 'string' || answer.token.length === 0) throw new Error('the host issued no token')
    return answer
  }

  /**
   * One message from the page, admitted or dropped.
   *
   * The four checks are separate on purpose: each one closes a different hole, and
   * a single combined predicate would make the next reader guess which.
   */
  private receive(event: MessageEvent): void {
    if (this.disposed) return
    // 1. Same origin. The view is served by the same host that serves this page,
    //    and the shell posts with `window.location.origin` as its target, so
    //    anything from elsewhere is not this view.
    if (event.origin !== window.location.origin) return
    // 2. This viewer's iframe and nothing else on the page. A second preview, or a
    //    frame a document managed to create, must not be able to report into this
    //    session.
    const frame = this.options.frame()
    if (frame === null || event.source !== frame.contentWindow) return
    // 3. The envelope. `postMessage` is a public bus and the payload has to say
    //    which conversation it belongs to.
    const data = event.data as { channel?: unknown; payload?: unknown } | null
    if (data === null || typeof data !== 'object' || data.channel !== EVENT_CHANNEL) return
    // 4. The schema. A page running ahead of its host is a real case -- the client
    //    bundle hot-reloads while the host half waits for a restart -- and an
    //    event in a vocabulary this build does not know is one it cannot validate.
    const payload = data.payload
    if (payload === null || typeof payload !== 'object') return
    const envelope = payload as ViewEventEnvelope
    if (envelope.schema !== EXPECTED_SCHEMA) return
    if (typeof envelope.eventId !== 'string' || typeof envelope.kind !== 'string') return

    this.received += 1
    this.enqueue(payload as QueuedEvent)
  }

  /**
   * How many events the view has produced, ever.
   *
   * The one thing out here that proves the view is alive: a view with no GPU
   * adapter draws nothing, reports no error on this channel, and looks exactly
   * like one that is still starting. See the watchdog in the viewer.
   */
  receivedCount(): number {
    return this.received
  }

  /**
   * Queue one event, superseding what it replaces and counting what it cannot.
   *
   * THE PAGES OF ONE SELECTION ARE NOT SUPERSEDED BY EACH OTHER. A large
   * selection arrives as several events sharing a version and differing in
   * offset; keeping only the newest of them would throw away every page but the
   * last and the host would assemble a selection out of the middle. So the rule
   * is by version: an event supersedes the queued ones of an EARLIER version and
   * a queued one of the SAME version and offset, and nothing else.
   */
  private enqueue(event: QueuedEvent): void {
    if (event.kind === 'selection.changed') {
      const { version, offset } = selectionPage(event)
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const queued = this.queue[index]
        if (queued.kind !== 'selection.changed') continue
        const other = selectionPage(queued)
        if (other.version < version || (other.version === version && other.offset === offset)) {
          this.queue.splice(index, 1)
        }
      }
    }
    if (this.queue.length >= QUEUE_MAX) this.makeRoom()
    this.queue.push(event)
  }

  /**
   * Free one slot, preferring the event that says the least.
   *
   * A selection snapshot is the one event whose successor is already in the
   * queue, so it goes first. When there is none -- a burst of edits with the host
   * unreachable -- the oldest fact goes, and it is COUNTED. That count is the
   * whole point: it is what turns a silent hole in the history into something an
   * agent can be told about and can go and look up.
   */
  private makeRoom(): void {
    const selection = this.queue.findIndex(queued => queued.kind === 'selection.changed')
    if (selection >= 0) {
      this.queue.splice(selection, 1)
      return
    }
    const dropped = this.queue.shift()
    if (dropped === undefined) return
    const kind = typeof dropped.kind === 'string' ? dropped.kind : 'unknown'
    const now = Date.now()
    const tally = this.dropped ?? { droppedFacts: 0, droppedByKind: {}, firstAt: now, lastAt: now }
    tally.droppedFacts += 1
    tally.droppedByKind[kind] = (tally.droppedByKind[kind] ?? 0) + 1
    tally.lastAt = now
    this.dropped = tally
    this.options.report(
      this.options.t('queueFull', { count: tally.droppedFacts }),
      'status',
    )
  }

  /** Put a batch that did not get through back where it came from. */
  private requeue(batch: QueuedEvent[], reason: string): void {
    this.queue.unshift(...batch)
    this.attempts += 1
    if (this.attempts <= FAST_ATTEMPTS) {
      this.nextAttemptAt = Date.now() + RETRY_BASE_MS * 2 ** (this.attempts - 1)
    } else {
      // Out of fast attempts. The facts are KEPT -- they are not the network's to
      // throw away -- and the cadence drops to something that will not hammer a
      // host that is restarting.
      this.nextAttemptAt = Date.now() + SLOW_RETRY_MS
      if (this.attempts === FAST_ATTEMPTS + 1) {
        this.options.report(
          this.options.t('deliveryFailed', { reason, count: this.queue.length }),
          'failure',
        )
      }
    }
  }

  /** Send what is queued, once at a time. */
  private async flush(): Promise<void> {
    if (this.disposed || this.flushing || this.queue.length === 0) return
    if (Date.now() < this.nextAttemptAt) return
    const capability = this.capability
    if (capability === null) return

    this.flushing = true
    const batch = this.queue.splice(0, this.batchLimit)
    // The tally is snapshotted so that it is cleared only when the POST that
    // CARRIED it succeeds -- a gap reported into a request that failed is a gap
    // reported to nobody.
    const carried = this.dropped
    const body: Record<string, unknown> = { events: batch }
    if (carried !== null) body.gaps = carried

    try {
      const response = await fetch(`${this.options.route}/events`, {
        method: 'POST',
        headers: { 'x-iam-capability': capability.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (response.status === 403) {
        // The capability expired -- a long-lived tab. The batch goes back to the
        // front of the queue in order, and it goes back WHATEVER the renewal
        // does: a renewal that fails is a reason to keep trying, not a reason to
        // lose a committed edit.
        this.requeue(batch, 'the capability expired')
        try {
          this.capability = await this.requestCapability()
          this.nextAttemptAt = 0
        } catch (error) {
          if (this.attempts <= FAST_ATTEMPTS) {
            this.options.report(
              this.options.t('reauthorisationFailed',
                { reason: error instanceof Error ? error.message : String(error) }),
              'failure',
            )
          }
        }
        return
      }
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          // The host is there and unhappy. That is temporary until it is not, and
          // the batch is worth exactly as much next time.
          this.requeue(batch, `answered ${response.status}`)
          return
        }
        // A 4xx that is not 403 says the batch itself is the problem -- too
        // large, or an event this host will not validate. Sending the same thing
        // again would earn the same answer, so the batch is halved and retried
        // once: the events are kept, and only the request shape changes.
        if (batch.length > 1) {
          this.batchLimit = Math.max(1, Math.floor(batch.length / 2))
          this.queue.unshift(...batch)
          this.nextAttemptAt = Date.now() + RETRY_BASE_MS
          this.options.report(this.options.t('batchRejected', { status: response.status }), 'status')
          return
        }
        this.options.report(
          this.options.t('eventRejected', { status: response.status,
            detail: (await response.text().catch(() => '')).slice(0, 200) }),
          'failure',
        )
        // The one event is not retried and it is COUNTED, because a fact that
        // reached the host and was refused is a fact the record does not have.
        this.countDirectDrop(batch[0])
        return
      }
      // Through. The backoff is over, the batch limit recovers, and the tally
      // this request carried has now been delivered.
      this.attempts = 0
      this.nextAttemptAt = 0
      this.batchLimit = FLUSH_MAX
      if (carried !== null && this.dropped === carried) this.dropped = null
      const answer = (await response.json().catch(() => null)) as { rejected?: number } | null
      if (answer !== null && typeof answer.rejected === 'number' && answer.rejected > 0) {
        this.options.report(this.options.t('sessionRejected', { count: answer.rejected }), 'failure')
      }
    } catch (error) {
      // The host is unreachable. Reported once per burst, then retried quietly.
      if (this.attempts === 0) {
        this.options.report(
          this.options.t('undeliverable', { reason: error instanceof Error ? error.message : String(error) }),
          'status',
        )
      }
      this.requeue(batch, 'the host is unreachable')
    } finally {
      this.flushing = false
    }
  }

  /** Record one fact the host refused, so the record's hole is visible. */
  private countDirectDrop(event: QueuedEvent | undefined): void {
    if (event === undefined) return
    const kind = typeof event.kind === 'string' ? event.kind : 'unknown'
    const now = Date.now()
    const tally = this.dropped ?? { droppedFacts: 0, droppedByKind: {}, firstAt: now, lastAt: now }
    tally.droppedFacts += 1
    tally.droppedByKind[kind] = (tally.droppedByKind[kind] ?? 0) + 1
    tally.lastAt = now
    this.dropped = tally
  }
}
